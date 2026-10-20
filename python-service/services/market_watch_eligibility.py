"""Market Watch eligibility engine — price, circuit distance, liquidity, data,
instrument, business and margin/leverage eligibility.

docs/engines/MARKET_WATCH.md §6, §7, §12 and Phase 5/6.

Ownership boundary (Phase 2): this module CONSUMES authoritative facts. It never
authenticates, never computes broker margin, and never invents a circuit price,
an LTP or a leverage decision. Anything it cannot verify is reported as
``DATA_INVALID``/``MARGIN_INELIGIBLE`` with an explicit reason rather than
silently treated as eligible.

Circuit distance uses the ACTUAL circuit prices (doc §7):

    upper_circuit = 500, current_price = 485
    distance      = (500 - 485) / 500 * 100 = 3.0%

The block threshold is selected from the *derived* circuit band width, so a 5%
band blocks at 3%, a 10% band at 8%, a 15% band at 13% and a 20% band at 18% —
all configurable, none of them hard-coded business rules.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Optional

from services.market_watch_config import (
    ELIGIBILITY_BLOCKED,
    ELIGIBILITY_ELIGIBLE,
    REASON_BUSINESS_RULE,
    REASON_CIRCUIT_TOO_CLOSE,
    REASON_DATA_INVALID,
    REASON_FILTER_FAIL,
    REASON_INSTRUMENT_INELIGIBLE,
    REASON_LIQUIDITY_FAIL,
    REASON_MARGIN_INELIGIBLE,
    REASON_PRICE_LIMIT,
    CircuitConfig,
    MarketWatchConfig,
    band_pct_from_circuits,
    block_pct_for_band,
    near_pct_for_band,
)
from services.market_watch_state import fnum

logger = logging.getLogger("app.market_watch_eligibility")

INACTIVE_STATUSES = {"SUSPENDED", "EXPIRED", "NOT_TRADING", "HALTED", "INACTIVE"}


@dataclass(frozen=True)
class EligibilityDecision:
    """Outcome of one eligibility evaluation for one symbol."""

    eligible: bool
    reason: Optional[str] = None
    threshold: Optional[float] = None
    observed: Optional[float] = None
    detail: Optional[str] = None
    circuit_block_pct: Optional[float] = None
    circuit_near_pct: Optional[float] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "eligible": self.eligible,
            "reason": self.reason,
            "threshold": self.threshold,
            "observed": self.observed,
            "detail": self.detail,
            "circuitBlockPct": self.circuit_block_pct,
            "circuitNearPct": self.circuit_near_pct,
        }


ELIGIBLE = EligibilityDecision(eligible=True)


def circuit_distance_upper(ltp: Optional[float], upper_circuit: Optional[float]) -> Optional[float]:
    """``(upper - ltp) / upper * 100`` — the real distance to the circuit band."""
    if ltp is None or upper_circuit is None or upper_circuit <= 0:
        return None
    return (float(upper_circuit) - float(ltp)) / float(upper_circuit) * 100.0


def circuit_distance_lower(ltp: Optional[float], lower_circuit: Optional[float]) -> Optional[float]:
    """``(ltp - lower) / lower * 100`` — the real distance to the lower band."""
    if ltp is None or lower_circuit is None or lower_circuit <= 0:
        return None
    return (float(ltp) - float(lower_circuit)) / float(lower_circuit) * 100.0


def is_inactive(instrument: dict[str, Any]) -> bool:
    status = str(instrument.get("tradingStatus") or instrument.get("instrumentStatus") or "").strip().upper()
    if not status:
        return False
    return "INACTIVE" in status or status in INACTIVE_STATUSES


def circuit_thresholds(circuit_cfg: CircuitConfig, state) -> tuple[Optional[float], Optional[float]]:
    band = state.circuit_band_pct or band_pct_from_circuits(
        state.upper_circuit, state.lower_circuit, state.previous_close
    )
    if band is None:
        return None, None
    return block_pct_for_band(circuit_cfg, band), near_pct_for_band(circuit_cfg, band)


def evaluate_state(state, cfg: MarketWatchConfig, *, hidden: bool = False) -> EligibilityDecision:
    """Evaluate one :class:`SymbolState` against the configured filters.

    The order is deliberate and matches doc §6:

        data validity -> instrument -> business -> price -> circuit -> liquidity -> margin

    so the recorded ``reason`` is the FIRST rule that failed, which is what the
    daily block ledger persists.
    """
    # ---- 1. Data validity (never fabricated) ------------------------- #
    if state.ltp is None or state.ltp <= 0:
        return EligibilityDecision(
            eligible=False, reason=REASON_DATA_INVALID, observed=state.ltp,
            detail="no valid ltp from the live feed",
        )
    if state.tick_count == 0:
        return EligibilityDecision(
            eligible=False, reason=REASON_DATA_INVALID, observed=0,
            detail="no validated tick recorded",
        )

    # ---- 2. Instrument eligibility ------------------------------------ #
    if state.status == "INACTIVE" or is_inactive({"tradingStatus": state.status}):
        return EligibilityDecision(
            eligible=False, reason=REASON_INSTRUMENT_INELIGIBLE, observed=None,
            detail=f"instrument status {state.status}",
        )

    # ---- 3. Business rules -------------------------------------------- #
    if cfg.business.exclude_hidden and hidden:
        return EligibilityDecision(
            eligible=False, reason=REASON_BUSINESS_RULE, observed=None,
            detail="hidden for the trading day",
        )
    max_change = cfg.business.max_daily_change_pct
    if max_change > 0 and state.change_pct is not None and abs(state.change_pct) > max_change:
        return EligibilityDecision(
            eligible=False, reason=REASON_BUSINESS_RULE, threshold=max_change,
            observed=abs(state.change_pct), detail="daily change outside business band",
        )

    # ---- 4. Price filter (doc §12) ------------------------------------ #
    if state.ltp < cfg.price.min_price:
        return EligibilityDecision(
            eligible=False, reason=REASON_PRICE_LIMIT, threshold=cfg.price.min_price,
            observed=state.ltp, detail="ltp below configured minimum",
        )
    if state.ltp > cfg.price.max_price:
        return EligibilityDecision(
            eligible=False, reason=REASON_PRICE_LIMIT, threshold=cfg.price.max_price,
            observed=state.ltp, detail="ltp above configured maximum",
        )

    # ---- 5. Circuit distance (doc §7 — real circuit prices) ----------- #
    block_pct, near_pct = circuit_thresholds(cfg.circuit, state)
    dist_up = state.circuit_distance_upper_pct
    if dist_up is None:
        dist_up = circuit_distance_upper(state.ltp, state.upper_circuit)
    dist_low = state.circuit_distance_lower_pct
    if dist_low is None:
        dist_low = circuit_distance_lower(state.ltp, state.lower_circuit)
    if state.upper_circuit is None or state.lower_circuit is None:
        if cfg.circuit.require_data:
            return EligibilityDecision(
                eligible=False, reason=REASON_DATA_INVALID, observed=None,
                detail="circuit prices unavailable from the feed",
                circuit_block_pct=block_pct, circuit_near_pct=near_pct,
            )
    else:
        if dist_up is not None and dist_up <= (block_pct if block_pct is not None else 0.0):
            return EligibilityDecision(
                eligible=False, reason=REASON_CIRCUIT_TOO_CLOSE, threshold=block_pct,
                observed=round(dist_up, 4), detail="upper circuit within block distance",
                circuit_block_pct=block_pct, circuit_near_pct=near_pct,
            )
        if dist_low is not None and dist_low <= (block_pct if block_pct is not None else 0.0):
            return EligibilityDecision(
                eligible=False, reason=REASON_CIRCUIT_TOO_CLOSE, threshold=block_pct,
                observed=round(dist_low, 4), detail="lower circuit within block distance",
                circuit_block_pct=block_pct, circuit_near_pct=near_pct,
            )

    # ---- 6. Liquidity / data eligibility ------------------------------ #
    liq = cfg.liquidity
    if cfg.liquidity.require_volume_data and state.volume is None:
        return EligibilityDecision(
            eligible=False, reason=REASON_LIQUIDITY_FAIL, observed=None,
            detail="volume data unavailable",
        )
    if liq.min_volume > 0:
        if state.volume is None:
            return EligibilityDecision(
                eligible=False, reason=REASON_LIQUIDITY_FAIL, threshold=liq.min_volume,
                observed=None, detail="volume unavailable",
            )
        if state.volume < liq.min_volume:
            return EligibilityDecision(
                eligible=False, reason=REASON_LIQUIDITY_FAIL, threshold=liq.min_volume,
                observed=state.volume, detail="volume below configured minimum",
            )
    if liq.min_value > 0:
        traded = (state.vwap * state.volume) if (state.vwap is not None and state.volume is not None) else None
        if traded is None:
            return EligibilityDecision(
                eligible=False, reason=REASON_LIQUIDITY_FAIL, threshold=liq.min_value,
                observed=None, detail="turnover unavailable (no vwap/volume)",
            )
        if traded < liq.min_value:
            return EligibilityDecision(
                eligible=False, reason=REASON_LIQUIDITY_FAIL, threshold=liq.min_value,
                observed=round(traded, 2), detail="turnover below configured minimum",
            )
    if liq.min_tick_count > 0 and state.tick_count < liq.min_tick_count:
        return EligibilityDecision(
            eligible=False, reason=REASON_LIQUIDITY_FAIL, threshold=float(liq.min_tick_count),
            observed=float(state.tick_count), detail="not enough validated ticks yet",
        )

    # ---- 6b. Timeframe movement filters (doc §12) ---------------------- #
    # AND semantics across the configured timeframes: a symbol failing ANY
    # configured window fails the symbol. A window with no value is a failure
    # (it is not given a synthetic pass).
    if cfg.filters is not None and cfg.filters.enabled:
        from services.market_watch_filters import evaluate_movement

        movement_ok, failures = evaluate_movement(state, cfg.filters)
        if not movement_ok:
            return EligibilityDecision(
                eligible=False, reason=REASON_FILTER_FAIL, observed=None,
                detail="; ".join(failures[:4]) or "timeframe movement filter failed",
            )

    # ---- 7. Margin / leverage eligibility (CONSUMED, never computed) --- #
    if cfg.business.margin_required:
        margin_ok, margin_reason = margin_decision(state, cfg)
        if not margin_ok:
            return EligibilityDecision(
                eligible=False, reason=REASON_MARGIN_INELIGIBLE, observed=None,
                detail=margin_reason,
            )

    return EligibilityDecision(
        eligible=True,
        circuit_block_pct=block_pct,
        circuit_near_pct=near_pct,
    )


def margin_decision(state, cfg: MarketWatchConfig) -> tuple[bool, str]:
    """Consume the authoritative margin/leverage decision for a symbol.

    Sources, in order:

    1. an explicit operator-configured ineligible-token set (a decision, not a
       computation);
    2. an explicit operator-configured eligible allow-list;
    3. the Session Manager / Margin Engine published decision, read through its
       status snapshot. When ``margin_required`` is on and NO authoritative
       source answers, the symbol is reported ``MARGIN_INELIGIBLE`` — Market
       Watch never derives broker margin itself.
    """
    token = state.instrument_token
    if cfg.business.margin_ineligible_tokens:
        if token in cfg.business.margin_ineligible_tokens:
            return False, "operator decision: token not margin eligible"
        # A non-empty explicit deny set is itself the decision: everything not
        # on that deny set is not denied by the operator.
    if cfg.business.margin_eligible_tokens:
        if token in cfg.business.margin_eligible_tokens:
            return True, "operator decision: token margin eligible"
        return False, "operator decision: not in the margin eligible set"
    try:
        from services.session.session_manager import session_manager

        snap = session_manager.snapshot() or {}
        decisions = snap.get("marginDecisions") or snap.get("margin_eligibility") or {}
        if isinstance(decisions, dict):
            entry = decisions.get(token)
            if isinstance(entry, dict):
                ok = bool(entry.get("eligible"))
                return ok, str(entry.get("reason") or ("authoritative decision" if ok else "authoritative decision: ineligible"))
            if isinstance(entry, bool):
                return entry, "authoritative session decision"
    except Exception as exc:
        logger.debug("[MARKET_WATCH] margin decision source unavailable: %s", exc)
    return False, f"no authoritative margin decision from {cfg.business.margin_source}"


def circuit_near(state, cfg: MarketWatchConfig) -> bool:
    """True when the symbol is inside the configured *near* circuit distance.

    Ranking uses this for the "Circuit Near" board (doc §14). It is a ranking
    signal, not a block: near-circuit symbols stay ranked.
    """
    block_pct, near_pct = circuit_thresholds(cfg.circuit, state)
    threshold = near_pct if near_pct is not None else block_pct
    if threshold is None:
        return False
    dist_up = state.circuit_distance_upper_pct
    dist_low = state.circuit_distance_lower_pct
    return (dist_up is not None and dist_up <= threshold) or (dist_low is not None and dist_low <= threshold)


def circuit_distance_from_record(record: dict[str, Any]) -> tuple[Optional[float], Optional[float]]:
    """Circuit distance for a plain dict row (used by filters/REST paths)."""
    ltp = fnum(record.get("ltp"))
    upper = fnum(record.get("upperCircuit") or record.get("upper_circuit"))
    lower = fnum(record.get("lowerCircuit") or record.get("lower_circuit"))
    return circuit_distance_upper(ltp, upper), circuit_distance_lower(ltp, lower)


__all__ = [
    "ELIGIBLE",
    "ELIGIBILITY_BLOCKED",
    "ELIGIBILITY_ELIGIBLE",
    "EligibilityDecision",
    "circuit_distance_from_record",
    "circuit_distance_lower",
    "circuit_distance_upper",
    "circuit_near",
    "circuit_thresholds",
    "evaluate_state",
    "is_inactive",
    "margin_decision",
]
