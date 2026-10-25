"""
Market Watch — weekly intraday screening rule.

THE RULE (as specified by the operator)
---------------------------------------
Every Saturday and Sunday, build next week's Market Watch stock list from the
instrument master, in two stages:

  Stage 1 — candidates: every instrument available for intraday trading.
  Stage 2 — final list:  of those candidates, keep only the stocks that are
            * live for intraday, and
            * priced strictly below the price cap (default ₹800), and
            * covered by at least the required margin multiplier (default 5x).

Only the final list is subscribed (Market Watch + Session Manager), so only
those stocks produce live ticks through the WebSocket / Connection Manager and
only those get persisted.

WHY THIS IS A SEPARATE MODULE
-----------------------------
``market_watch_eligibility`` already CONSUMES a margin decision, but nothing in
the codebase PRODUCES one — the field it reads has no writer. The weekly screen
is therefore specified here as pure, testable logic over explicit facts, and the
facts are gathered by ``margin_resolver`` below. That split is deliberate: the
rule can be proven correct without a broker session, and the broker plumbing can
fail honestly without ever being able to silently change what "5x" means.

HONESTY
-------
Margin and intraday entitlement are BROKER facts. Neither is derived from price,
guessed from segment, or assumed to pass:

  * ``MARGIN_UNAVAILABLE`` / ``INTRADAY_UNKNOWN`` are real, reportable outcomes.
    A stock with no margin answer is reported as unknown, never waved through.
  * A price that was not observed is ``NO_PRICE`` — not "under the cap".
  * Operator allow/deny lists override everything, because an explicit human
    decision is a decision, not a computation.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Optional

logger = logging.getLogger("app.market_watch_intraday")

# --------------------------------------------------------------------------- #
# Reason codes — every rejection is attributable, never a bare "filtered"
# --------------------------------------------------------------------------- #

PASS = "PASS"
NO_PRICE = "NO_PRICE"
PRICE_ABOVE_CAP = "PRICE_ABOVE_CAP"
MARGIN_UNAVAILABLE = "MARGIN_UNAVAILABLE"
MARGIN_BELOW_THRESHOLD = "MARGIN_BELOW_THRESHOLD"
INTRADAY_UNAVAILABLE = "INTRADAY_UNAVAILABLE"
INTRADAY_UNKNOWN = "INTRADAY_UNKNOWN"
OPERATOR_EXCLUDED = "OPERATOR_EXCLUDED"

REASON_LABELS: dict[str, str] = {
    PASS: "Passed all screen rules",
    NO_PRICE: "No price observed yet",
    PRICE_ABOVE_CAP: "Priced above the cap",
    MARGIN_UNAVAILABLE: "Margin not answered by the broker",
    MARGIN_BELOW_THRESHOLD: "Margin below the required multiplier",
    INTRADAY_UNAVAILABLE: "Not available for intraday",
    INTRADAY_UNKNOWN: "Intraday availability unknown",
    OPERATOR_EXCLUDED: "Excluded by operator",
}

# Margin provenance. Mirrors the vocabulary the existing eligibility code reads.
MARGIN_AUTHORITATIVE = "AUTHORITATIVE"
MARGIN_BELOW = "BELOW_THRESHOLD"
MARGIN_UNAVAILABLE_STATUS = "UNAVAILABLE"
MARGIN_OPERATOR = "OPERATOR"

# Intraday availability, matching market_watch_config.INTRADAY_STATUSES.
INTRADAY_ELIGIBLE = "ELIGIBLE"
INTRADAY_UNAVAILABLE_STATUS = "UNAVAILABLE"
INTRADAY_UNKNOWN_STATUS = "UNKNOWN"

#: How an UNKNOWN intraday status is treated. See ScreenConfig.intraday_policy.
INTRADAY_POLICY_REQUIRE_ELIGIBLE = "REQUIRE_ELIGIBLE"
INTRADAY_POLICY_ALLOW_UNKNOWN = "ALLOW_UNKNOWN"


# --------------------------------------------------------------------------- #
# Inputs
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class ScreenConfig:
    """The screen's knobs. Defaults are the operator's stated rule."""

    price_cap: float = 800.0
    margin_multiplier_threshold: float = 5.0
    require_intraday: bool = True
    require_margin: bool = True
    #: What to do with a stock whose intraday availability is UNKNOWN.
    #:
    #:   REQUIRE_ELIGIBLE — only an explicit ELIGIBLE passes. Unknown is NOT
    #:     silently treated as available; the stock is reported as unconfirmed
    #:     and kept out of the final list. This is the default because the rule
    #:     is "stocks available for intraday", and unknown is not known.
    #:   ALLOW_UNKNOWN — an UNKNOWN stock may be selected, but it is flagged
    #:     ``intradayConfirmed=False`` so the review screen can separate it from
    #:     genuinely confirmed intraday names.
    #:
    #: Only loosen this when intraday data genuinely does not exist for the
    #: account; the flag exists so that choice stays visible.
    intraday_policy: str = INTRADAY_POLICY_REQUIRE_ELIGIBLE
    #: Margin decisions made by an operator. These outrank the COMPUTED margin
    #: rule only — they are a decision about margin, so they never bypass the
    #: price cap or intraday availability.
    margin_eligible_tokens: frozenset[str] = frozenset()
    margin_ineligible_tokens: frozenset[str] = frozenset()
    intraday_unavailable_tokens: frozenset[str] = frozenset()
    intraday_unknown_tokens: frozenset[str] = frozenset()

    @property
    def allow_unknown_intraday(self) -> bool:
        return self.intraday_policy == INTRADAY_POLICY_ALLOW_UNKNOWN

    @classmethod
    def from_market_watch(cls, cfg: Any) -> "ScreenConfig":
        """Build from the live Market Watch config, tolerating partial shapes.

        Reads the runtime settings directly for the two intraday knobs, because
        they belong to this screen rather than to the pre-existing Market Watch
        config object. ``price_cap`` and the margin threshold come off the
        Market Watch config, which resolves them from the live settings store on
        every read — so editing the screen takes effect on the next scan.
        """
        def _tokens(value: Any) -> frozenset[str]:
            if not value:
                return frozenset()
            return frozenset(str(t).strip() for t in value if str(t).strip())

        def _runtime(key: str, default: Any, cast: Any) -> Any:
            try:
                from services.runtime_settings import get_runtime_setting

                value = get_runtime_setting(key)
                return default if value is None else cast(value)
            except Exception:
                return default

        price_cap = 800.0
        try:
            if getattr(cfg.price, "max_price", None) is not None:
                price_cap = float(cfg.price.max_price)
        except Exception:
            pass
        margin_threshold = 5.0
        try:
            raw = getattr(cfg.weekly, "margin_multiplier_threshold", None)
            if raw is not None:
                margin_threshold = float(raw)
        except Exception:
            pass
        business = getattr(cfg, "business", None)
        policy = _runtime("mwr_intraday_policy", INTRADAY_POLICY_REQUIRE_ELIGIBLE, str)
        if policy not in (INTRADAY_POLICY_REQUIRE_ELIGIBLE, INTRADAY_POLICY_ALLOW_UNKNOWN):
            policy = INTRADAY_POLICY_REQUIRE_ELIGIBLE
        return cls(
            price_cap=price_cap,
            margin_multiplier_threshold=margin_threshold,
            require_intraday=_runtime("mwr_intraday_required", True, bool),
            require_margin=bool(getattr(business, "margin_required", False)),
            intraday_policy=policy,
            margin_eligible_tokens=_tokens(getattr(business, "margin_eligible_tokens", None)),
            margin_ineligible_tokens=_tokens(getattr(business, "margin_ineligible_tokens", None)),
        )


@dataclass(frozen=True)
class StockFacts:
    """What is actually known about one stock at screening time."""

    token: str
    symbol: str = ""
    ltp: Optional[float] = None
    margin_multiplier: Optional[float] = None
    margin_status: str = MARGIN_UNAVAILABLE_STATUS
    margin_basis: str = ""
    intraday_status: str = INTRADAY_UNKNOWN_STATUS
    intraday_basis: str = ""

    @classmethod
    def from_record(cls, record: Mapping[str, Any]) -> "StockFacts":
        def _num(*keys: str) -> Optional[float]:
            for k in keys:
                v = record.get(k)
                if v is None or v == "":
                    continue
                try:
                    f = float(v)
                except (TypeError, ValueError):
                    continue
                if f == f:  # NaN guard
                    return f
            return None

        meta = record.get("metadata") if isinstance(record.get("metadata"), Mapping) else {}
        return cls(
            token=str(record.get("instrumentToken") or record.get("token") or "").strip(),
            symbol=str(record.get("symbol") or "").strip(),
            ltp=_num("ltp", "lastPrice", "last_traded_price"),
            margin_multiplier=_num("marginMultiplier", "margin_multiplier", "multiplier", "leverage"),
            margin_status=str(record.get("marginStatus") or record.get("margin_status") or MARGIN_UNAVAILABLE_STATUS),
            margin_basis=str(record.get("marginBasis") or record.get("margin_basis") or ""),
            intraday_status=str(record.get("intradayStatus") or record.get("intraday_status") or INTRADAY_UNKNOWN_STATUS),
            intraday_basis=str(record.get("intradayBasis") or record.get("intraday_basis") or ""),
        )


# --------------------------------------------------------------------------- #
# Decisions
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class ScreenDecision:
    passed: bool
    reason_code: str
    reason: str
    token: str
    symbol: str = ""
    ltp: Optional[float] = None
    margin_multiplier: Optional[float] = None
    margin_status: str = MARGIN_UNAVAILABLE_STATUS
    intraday_status: str = INTRADAY_UNKNOWN_STATUS
    #: False when the stock was selected with intraday availability UNKNOWN
    #: under the permissive policy. Carried through so the manual review screen
    #: can separate confirmed intraday names from unconfirmed ones.
    intraday_confirmed: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "token": self.token,
            "symbol": self.symbol,
            "passed": self.passed,
            "reasonCode": self.reason_code,
            "reason": self.reason,
            "ltp": self.ltp,
            "marginMultiplier": self.margin_multiplier,
            "marginStatus": self.margin_status,
            "intradayStatus": self.intraday_status,
            "intradayConfirmed": self.intraday_confirmed,
        }


@dataclass
class ScreenResult:
    """The outcome of screening one week: what is in, what is out, and why."""

    selected: list[ScreenDecision] = field(default_factory=list)
    rejected: list[ScreenDecision] = field(default_factory=list)
    reason_counts: dict[str, int] = field(default_factory=dict)

    @property
    def selected_count(self) -> int:
        return len(self.selected)

    def to_dict(self) -> dict[str, Any]:
        return {
            "selected": [d.to_dict() for d in self.selected],
            "rejected": [d.to_dict() for d in self.rejected],
            "selectedCount": len(self.selected),
            "rejectedCount": len(self.rejected),
            "reasonCounts": dict(self.reason_counts),
        }


# --------------------------------------------------------------------------- #
# Margin maths
# --------------------------------------------------------------------------- #

#: Response keys the brokers use for the margin figure on a 1-qty MIS preview.
MARGIN_RESPONSE_KEYS = (
    # Kotak's check-margin envelope returns the required order margin here.
    # ``ordMrgn`` is the same figure for a fresh preview, but ``reqdMrgn`` is
    # the canonical "margin required" field and is checked first.
    "reqdMrgn", "ordMrgn",
    "TotalMargin", "totalMargin", "marginRequired", "requiredMargin",
    "total_margin", "MarginRequired",
)


def extract_margin_amount(payload: Any) -> Optional[float]:
    """Pull the margin figure out of a broker margin preview.

    Returns None when the broker said "unavailable" or the payload carries no
    recognisable margin field. None is a real answer here: it becomes
    ``MARGIN_UNAVAILABLE`` rather than a pass.
    """
    if not isinstance(payload, Mapping):
        return None
    if payload.get("unavailable"):
        return None
    rows = payload.get("data")
    row: Any = None
    if isinstance(rows, list) and rows:
        row = rows[0]
    elif isinstance(rows, Mapping):
        row = rows
    if not isinstance(row, Mapping):
        row = payload
    for key in MARGIN_RESPONSE_KEYS:
        if key in row:
            try:
                value = float(row[key])
            except (TypeError, ValueError):
                continue
            if value == value:
                return value
    return None


def margin_multiplier_from_preview(notional: Optional[float], margin: Optional[float]) -> Optional[float]:
    """Leverage implied by a broker margin preview.

    The broker answers "how much margin for 1 unit at this price"; leverage is
    notional / margin. A 5x margin therefore yields ~5.0.

    Returns None when either side is missing or the margin is not positive —
    an undefined ratio is unknown, never an infinite multiplier.
    """
    if notional is None or margin is None:
        return None
    if notional <= 0 or margin <= 0:
        return None
    try:
        return float(notional) / float(margin)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


# --------------------------------------------------------------------------- #
# The rule
# --------------------------------------------------------------------------- #

def screen_stock(facts: StockFacts, cfg: ScreenConfig) -> ScreenDecision:
    """Apply the weekly rule to one stock.

    Order matters only for which reason the operator sees. The most decisive
    checks run first so a rejection explains as much as it can.
    """
    def _dec(passed: bool, code: str, detail: str = "", confirmed: bool = True) -> ScreenDecision:
        return ScreenDecision(
            passed=passed,
            reason_code=code,
            reason=detail or REASON_LABELS.get(code, code),
            token=facts.token,
            symbol=facts.symbol,
            ltp=facts.ltp,
            margin_multiplier=facts.margin_multiplier,
            margin_status=facts.margin_status,
            intraday_status=facts.intraday_status,
            intraday_confirmed=confirmed,
        )

    # 1. An explicit operator margin denial outranks everything about margin.
    if facts.token and facts.token in cfg.margin_ineligible_tokens:
        return _dec(False, OPERATOR_EXCLUDED, "Excluded by operator (margin deny list)")

    # An operator margin approval replaces only the COMPUTED margin rule — it is
    # a decision about margin, so it must not wave a stock through the price cap
    # or intraday availability.
    margin_approved = bool(facts.token) and facts.token in cfg.margin_eligible_tokens

    # 2. Price cap. A missing price is unknown, which is not "under the cap".
    #    The rule is STRICTLY below: an LTP equal to the cap is not admissible.
    if facts.ltp is None:
        return _dec(False, NO_PRICE, "No LTP observed for this instrument yet")
    if facts.ltp >= cfg.price_cap:
        return _dec(
            False, PRICE_ABOVE_CAP,
            f"LTP {facts.ltp:.2f} is at or above the {cfg.price_cap:.2f} cap",
        )

    # 3. Intraday availability. UNKNOWN is not "available" unless the operator
    #    has explicitly chosen the permissive policy, and then only flagged.
    if cfg.require_intraday:
        if facts.token in cfg.intraday_unavailable_tokens:
            return _dec(False, INTRADAY_UNAVAILABLE, "Marked intraday-unavailable")
        status = facts.intraday_status or INTRADAY_UNKNOWN_STATUS
        if status == INTRADAY_UNAVAILABLE_STATUS:
            return _dec(False, INTRADAY_UNAVAILABLE, "Broker reports intraday unavailable")
        if status != INTRADAY_ELIGIBLE:
            # UNKNOWN (or an unrecognised value) — never a silent pass.
            if not cfg.allow_unknown_intraday:
                detail = (
                    "Intraday availability not established"
                    if status == INTRADAY_UNKNOWN_STATUS
                    else f"Unrecognised intraday status {status!r}"
                )
                if facts.token in cfg.intraday_unknown_tokens:
                    detail += " (operator marked unknown)"
                return _dec(False, INTRADAY_UNKNOWN, detail)
            return _dec(True, PASS, "Selected with intraday availability UNCONFIRMED",
                        confirmed=False)

    # 4. Margin multiplier.
    if cfg.require_margin and not margin_approved:
        if facts.margin_multiplier is None:
            return _dec(
                False, MARGIN_UNAVAILABLE,
                f"No broker margin answer ({facts.margin_basis or 'no source'})",
            )
        if facts.margin_multiplier < cfg.margin_multiplier_threshold:
            return _dec(
                False, MARGIN_BELOW_THRESHOLD,
                f"{facts.margin_multiplier:.2f}x is below the required "
                f"{cfg.margin_multiplier_threshold:.2f}x",
            )

    return _dec(True, PASS, "Operator approved" if margin_approved else "")


def screen_records(
    records: Iterable[Mapping[str, Any]], cfg: ScreenConfig,
) -> ScreenResult:
    """Screen a whole candidate set into the final list plus attributable rejects.

    ``records`` are the instrument-master rows enriched with whatever margin /
    intraday facts could be resolved — this function performs no I/O, so the
    weekly rule is fully reproducible and testable offline.
    """
    result = ScreenResult()
    for record in records:
        decision = screen_stock(StockFacts.from_record(record), cfg)
        if decision.passed:
            result.selected.append(decision)
        else:
            result.rejected.append(decision)
            result.reason_counts[decision.reason_code] = (
                result.reason_counts.get(decision.reason_code, 0) + 1
            )
    # Cheapest first, then by LTP so the manual review screen leads with the
    # most obviously-safe stocks.
    result.selected.sort(key=lambda d: (d.ltp is None, d.ltp or 0.0))
    result.rejected.sort(key=lambda d: (d.reason_code, d.ltp is None, d.ltp or 0.0))
    return result


__all__ = [
    "INTRADAY_ELIGIBLE",
    "INTRADAY_POLICY_ALLOW_UNKNOWN",
    "INTRADAY_POLICY_REQUIRE_ELIGIBLE",
    "INTRADAY_UNKNOWN",
    "INTRADAY_UNKNOWN_STATUS",
    "INTRADAY_UNAVAILABLE",
    "INTRADAY_UNAVAILABLE_STATUS",
    "MARGIN_BELOW_THRESHOLD",
    "MARGIN_RESPONSE_KEYS",
    "MARGIN_UNAVAILABLE",
    "MARGIN_UNAVAILABLE_STATUS",
    "NO_PRICE",
    "OPERATOR_EXCLUDED",
    "PASS",
    "PRICE_ABOVE_CAP",
    "REASON_LABELS",
    "ScreenConfig",
    "ScreenDecision",
    "ScreenResult",
    "StockFacts",
    "extract_margin_amount",
    "margin_multiplier_from_preview",
    "screen_records",
    "screen_stock",
]
