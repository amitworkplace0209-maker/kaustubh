"""
Market Watch — the weekly intraday universe scan.

THE JOB
-------
On the review weekend (Saturday or Sunday) this builds NEXT week's Market Watch
stock list from the instrument master:

    1. candidates — every active NSE/BSE equity instrument in the master
    2. price      — a real LTP per candidate, via the canonical LastPrice chain
    3. margin     — broker-computed leverage, via the margin resolver
    4. screen     — keep only LTP < cap AND margin >= threshold AND intraday
    5. seed       — the survivors become next week's DRAFT membership

Step 5 is deliberately a DRAFT, not a LOCK. The operator reviews the screen
output — including the crossing history that says which stocks kept breaching
the cap during the week — and decides the final add/remove before the week is
locked. Automating the suggestion without automating the decision is the whole
point: the screen is evidence, the human is the decision.

WHY CANDIDATE PRICES COME FROM THE LAST-PRICE CHAIN
----------------------------------------------------
A candidate is, by definition, a stock that is NOT yet subscribed, so it has no
WebSocket tick. Reading its price from the subscription would be circular — it
would only ever screen the stocks already on the list, which can never surface a
new one. ``services.last_price.resolve_prices`` already resolves prices for
unsubscribed instruments (tick buffer -> broker batch -> stored candle close) and
labels each value LIVE or STALE, which is exactly the provenance a weekly
decision needs.

BATCHING
--------
The instrument master has thousands of rows; the broker will not be asked for
all of them in one call. Candidates are processed in bounded batches, and the
scan reports what it could not resolve instead of quietly shrinking the list.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping, Optional

logger = logging.getLogger("app.market_watch_weekly_scan")

#: Candidates resolved per price/margin batch.
#:
#: Sized from measurement, not guesswork: the last-price chain costs roughly
#: 100ms per unsubscribed symbol (one stored-candle lookup each), so a 250-row
#: batch needs ~25s. The previous 250/25s pairing sat exactly on the timeout,
#: which silently dropped whole batches and made the scan look like "no stock
#: has a price at all". 150 rows keeps a batch near 15s and leaves real headroom
#: on a loaded database. With an active broker session the batched quote path is
#: far quicker, so this is the pessimistic sizing.
PRICE_BATCH = 150
MARGIN_BATCH = 120
PRICE_BATCH_TIMEOUT = 45.0

COLLECTION = "market_watch_weekly_screen"


@dataclass
class ScanResult:
    """One weekly scan: what was screened, what survived, and why."""

    week_id: str = ""
    target_week_id: str = ""
    started_at: float = 0.0
    finished_at: float = 0.0
    candidates: int = 0
    priced: int = 0
    margin_resolved: int = 0
    margin_unavailable: int = 0
    selected: list[dict[str, Any]] = field(default_factory=list)
    rejected: list[dict[str, Any]] = field(default_factory=list)
    reason_counts: dict[str, int] = field(default_factory=dict)
    price_source_counts: dict[str, int] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)
    seeded: bool = False
    dry_run: bool = False

    @property
    def selected_symbols(self) -> list[str]:
        return [s["symbol"] for s in self.selected if s.get("symbol")]

    def to_dict(self) -> dict[str, Any]:
        return {
            "weekId": self.week_id,
            "targetWeekId": self.target_week_id,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "durationSeconds": round(max(0.0, self.finished_at - self.started_at), 2),
            "candidates": self.candidates,
            "priced": self.priced,
            "marginResolved": self.margin_resolved,
            "marginUnavailable": self.margin_unavailable,
            "selectedCount": len(self.selected),
            "rejectedCount": len(self.rejected),
            "selected": self.selected,
            "rejected": self.rejected,
            "reasonCounts": dict(self.reason_counts),
            "priceSourceCounts": dict(self.price_source_counts),
            "errors": list(self.errors),
            "seeded": self.seeded,
            "dryRun": self.dry_run,
        }

    def summary(self) -> str:
        return (
            f"{len(self.selected)} of {self.candidates} candidates passed for "
            f"{self.target_week_id} "
            f"(price {self.priced}, margin {self.margin_resolved} answered, "
            f"{self.margin_unavailable} unanswered)"
        )


# --------------------------------------------------------------------------- #
# Candidates
# --------------------------------------------------------------------------- #

def _is_inactive(inst: Mapping[str, Any]) -> bool:
    status = str(inst.get("status") or inst.get("instrumentStatus") or "").upper()
    if status in ("INACTIVE", "EXPIRED", "SUSPENDED"):
        return True
    if inst.get("expired") is True:
        return True
    return bool(inst.get("isInactive") or inst.get("inactive"))


async def _candidates(limit: Optional[int] = None) -> list[dict[str, Any]]:
    """Every active equity instrument in the validated master.

    Sourced from ``instrument_cache`` — the app's single validated instrument
    master, which is the same source the search dropdown and the Market Watch
    universe both read. There is no instruments collection in Mongo: the master
    is broker-downloaded and cached in-process/on disk, so querying Mongo for it
    would find nothing and the screen would silently produce an empty list.

    This is deliberately NOT restricted to the currently locked membership: a
    new candidate cannot already be a member, and narrowing the pool to the
    current list would make adding anything impossible.
    """
    from services.instrument_cache import instrument_cache

    if not instrument_cache.loaded and not instrument_cache.load():
        raise RuntimeError(
            "instrument master is not loaded "
            f"({instrument_cache.load_error() or 'no error reported'})"
        )

    rows: list[dict[str, Any]] = []
    for inst in instrument_cache.get_instruments():
        if not isinstance(inst, Mapping):
            continue
        # NSE cash equity only. This is the SAME predicate the engine uses to
        # resolve the locked universe, so the scan cannot select an index,
        # derivative or BSE symbol that the engine would later drop as
        # unresolved. ``is_nse_eq`` also excludes the index rows whose
        # instrumentType/series fields are empty.
        if not instrument_cache.is_nse_eq(inst):
            continue
        if _is_inactive(inst):
            continue
        token = str(inst.get("token") or inst.get("instrumentToken") or "").strip()
        if not token.isdigit():
            continue
        symbol = str(inst.get("symbol") or inst.get("tradingSymbol") or "").strip()
        if not symbol:
            continue
        rows.append({
            "instrumentToken": token,
            "symbol": symbol.upper(),
            "segment": "nse_cm",
        })

    rows.sort(key=lambda r: r["symbol"])
    if limit:
        rows = rows[:limit]
    return rows


# --------------------------------------------------------------------------- #
# Prices
# --------------------------------------------------------------------------- #

async def _price_batch(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Resolve a real LTP per candidate through the canonical price chain."""
    out: dict[str, dict[str, Any]] = {}
    if not rows:
        return out
    try:
        from services.last_price import resolve_prices

        resolved = await asyncio.wait_for(
            resolve_prices([
                {"token": r["instrumentToken"], "symbol": r["symbol"],
                 "segment": r["segment"]}
                for r in rows
            ]),
            timeout=PRICE_BATCH_TIMEOUT,
        )
    except Exception as exc:
        logger.warning("[MW-SCAN] price batch failed (%d rows): %s", len(rows), exc)
        return out
    for row, price in zip(rows, resolved):
        price = price or {}
        out[row["instrumentToken"]] = {
            "ltp": price.get("ltp"),
            "source": price.get("source") or "unavailable",
            "status": price.get("status") or "UNKNOWN",
        }
    return out


async def _resolve_prices(
    rows: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    prices: dict[str, dict[str, Any]] = {}
    for start in range(0, len(rows), PRICE_BATCH):
        chunk = rows[start:start + PRICE_BATCH]
        prices.update(await _price_batch(chunk))
    return prices


# --------------------------------------------------------------------------- #
# The scan
# --------------------------------------------------------------------------- #

def _screen_config(require_margin: Optional[bool] = None):
    import dataclasses

    from services.market_watch_config import load
    from services.market_watch_intraday import ScreenConfig

    cfg = ScreenConfig.from_market_watch(load())
    if require_margin is None:
        return cfg
    # The Friday scan must enforce the 5x rule even when the older, global
    # ``mwr_margin_required`` switch is off. That switch also feeds live
    # per-tick eligibility, where the margin facts are not resolved for every
    # symbol, so turning it on globally would blank the live universe.
    return dataclasses.replace(cfg, require_margin=bool(require_margin))


async def run_scan(
    week_id: Optional[str] = None,
    *,
    target_week_id: Optional[str] = None,
    limit: Optional[int] = None,
    dry_run: bool = False,
    seed_draft: bool = True,
    require_margin: Optional[bool] = None,
) -> ScanResult:
    """Run one weekly screen and (optionally) seed next week's draft.

    ``week_id`` is the week being REVIEWED (the evidence week).
    ``target_week_id`` is the week the survivors are meant for.
    ``require_margin=True`` forces the broker-margin rule on for this run; the
    Friday scan sets it so the 5x requirement is never silently disabled.
    """
    from services.market_watch_crossings import week_id_for
    from services.market_watch_intraday import screen_records
    from services.margin_resolver import margin_resolver
    from services.market_watch_universe import next_week_id_for

    week_id = week_id or week_id_for()
    target_week_id = target_week_id or next_week_id_for()

    result = ScanResult(
        week_id=week_id,
        target_week_id=target_week_id,
        started_at=time.time(),
        dry_run=dry_run,
    )
    cfg = _screen_config(require_margin)

    try:
        candidates = await _candidates(limit)
    except Exception as exc:
        result.errors.append(f"candidate load failed: {exc}")
        result.finished_at = time.time()
        return result
    result.candidates = len(candidates)
    if not candidates:
        result.finished_at = time.time()
        return result

    # ---- 2. real prices ------------------------------------------------- #
    prices = await _resolve_prices(candidates)
    priced_rows: list[dict[str, Any]] = []
    for row in candidates:
        price = prices.get(row["instrumentToken"]) or {}
        ltp = price.get("ltp")
        try:
            ltp = float(ltp) if ltp is not None else None
        except (TypeError, ValueError):
            ltp = None
        source = str(price.get("source") or "unavailable")
        result.price_source_counts[source] = result.price_source_counts.get(source, 0) + 1
        if ltp is not None and ltp > 0:
            result.priced += 1
            priced_rows.append({**row, "ltp": ltp, "priceSource": source,
                                "priceStatus": price.get("status")})
        else:
            # Keep the row so the screen can report NO_PRICE with attribution
            # rather than silently dropping the stock from the review.
            priced_rows.append({**row, "ltp": None, "priceSource": source,
                                "priceStatus": "UNAVAILABLE"})

    # ---- 3. broker margin + intraday facts ------------------------------ #
    margin_rows = [
        {"instrumentToken": r["instrumentToken"], "ltp": r["ltp"]}
        for r in priced_rows if r.get("ltp")
    ]
    answers: dict[str, Any] = {}
    if margin_rows:
        for start in range(0, len(margin_rows), MARGIN_BATCH):
            chunk = margin_rows[start:start + MARGIN_BATCH]
            try:
                answers.update(await margin_resolver.resolve(
                    chunk, threshold=cfg.margin_multiplier_threshold))
            except Exception as exc:
                result.errors.append(f"margin batch failed: {exc}")
    result.margin_resolved = sum(
        1 for a in answers.values() if a.status == "AUTHORITATIVE")
    result.margin_unavailable = sum(
        1 for a in answers.values() if a.status != "AUTHORITATIVE")

    # Publish the answered decisions so every existing consumer that already
    # reads marginDecisions from the session snapshot sees them too.
    try:
        margin_resolver.publish(answers)
    except Exception as exc:
        result.errors.append(f"margin publish failed: {exc}")

    # ---- 4. screen ------------------------------------------------------- #
    facts: list[dict[str, Any]] = []
    for row in priced_rows:
        answer = answers.get(row["instrumentToken"])
        if answer is not None:
            facts.append(answer.to_screen_facts(
                ltp=row["ltp"], symbol=row["symbol"]))
        else:
            facts.append({
                "instrumentToken": row["instrumentToken"],
                "symbol": row["symbol"],
                "ltp": row["ltp"],
                "marginStatus": "UNAVAILABLE",
                "marginBasis": "none",
                "intradayStatus": "UNKNOWN",
            })

    screened = screen_records(facts, cfg)
    lookup = {r["instrumentToken"]: r for r in priced_rows}
    price_by_token = {r["instrumentToken"]: r for r in priced_rows}

    def _decorate(decision: dict[str, Any]) -> dict[str, Any]:
        row = price_by_token.get(decision["token"], {})
        return {
            **decision,
            "priceSource": row.get("priceSource"),
            "priceStatus": row.get("priceStatus"),
        }

    result.selected = [_decorate(d.to_dict()) for d in screened.selected]
    result.rejected = [_decorate(d.to_dict()) for d in screened.rejected]
    result.reason_counts = dict(screened.reason_counts)

    # ---- 5. seed next week's draft --------------------------------------- #
    if seed_draft and not dry_run:
        try:
            result.seeded = await _seed_draft(target_week_id, result.selected_symbols, week_id)
        except Exception as exc:
            result.errors.append(f"draft seeding failed: {exc}")

    result.finished_at = time.time()
    _persist(result)
    logger.info("[MW-SCAN] %s", result.summary())
    return result


async def _seed_draft(
    target_week_id: str, symbols: list[str], source_week_id: str,
) -> bool:
    """Write the screened survivors into next week's DRAFT membership.

    Never touches a LOCKED week, and never writes the crossing evidence into
    membership — the operator still adds and removes.
    """
    from services.market_watch_universe import (
        WEEK_STATUS_DRAFT,
        WeeklyUniverse,
        _stage_draft,
        persist_universe,
        is_locked,
    )
    from services.market_watch_universe import _utc_now_iso

    if await is_locked(target_week_id):
        logger.warning(
            "[MW-SCAN] target week %s is already LOCKED — not seeding",
            target_week_id,
        )
        return False
    draft = WeeklyUniverse(
        week_id=target_week_id,
        version=0,
        status=WEEK_STATUS_DRAFT,
        symbols=list(symbols),
        kept=list(symbols),
        source_week_id=source_week_id,
        created_at=_utc_now_iso(),
        notes="Seeded by the weekly intraday screen; review before locking.",
    )
    if not persist_universe(draft):
        return False
    _stage_draft(draft)
    return True


def _persist(result: ScanResult) -> None:
    """Store the scan so the review screen can show a past run's evidence."""
    doc = result.to_dict()
    doc["_id"] = f"{result.week_id}:{result.target_week_id}"
    doc["scannedAt"] = datetime.now(timezone.utc).isoformat()
    try:
        from services.market_watch_doc_buffer import add

        add(COLLECTION, [doc])
    except Exception:
        logger.debug("[MW-SCAN] scan persistence skipped", exc_info=True)


async def load_scan(week_id: str, target_week_id: Optional[str] = None) -> Optional[dict[str, Any]]:
    """Read a stored scan back for the review screen."""
    from services.market_watch_universe import next_week_id_for

    target_week_id = target_week_id or next_week_id_for()
    doc_id = f"{week_id}:{target_week_id}"
    try:
        from services.market_watch_universe import _db

        return await _db()[COLLECTION].find_one({"_id": doc_id})
    except Exception as exc:
        logger.debug("[MW-SCAN] scan load failed: %s", exc)
        return None


__all__ = [
    "COLLECTION",
    "MARGIN_BATCH",
    "PRICE_BATCH",
    "ScanResult",
    "load_scan",
    "run_scan",
]