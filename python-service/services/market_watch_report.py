"""Market Watch EOD report.

docs/engines/MARKET_WATCH.md §26 and Phase 6.

Runs at ~15:20 (after Market Watch monitoring stopped at ~15:15) and must be ready
by ~15:25. It is a pure function of REAL state that already exists in the engine —
it never recomputes prices and never invents a value:

    top movers / highest volume / most active / circuit-near
    blocked stocks + block reasons
    eligible count / subscribed count
    tick and data-quality statistics

Explicit rule from §26: nothing is labelled "high loss" — that label requires a
trading-strategy/position definition, which Market Watch does not own. Losses are
reported as *price decline* with the measured percentage only.

The document is persisted through the DB Writer into ``market_watch_daily_report``
with a deterministic ``_id`` (``date``) so a retry can never create a second
report.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any, Optional, Sequence

from services.market_watch_config import (
    DATA_QUALITY_COMPLETE,
    DATA_QUALITY_IN_PROGRESS,
    DATA_QUALITY_INCOMPLETE,
    DATA_QUALITY_LIVE,
    DATA_QUALITY_STALE,
    DATA_QUALITY_UNAVAILABLE,
    MarketWatchConfig,
    load as load_config,
)
from services.market_watch_eligibility import circuit_near
from services.market_watch_ledger import COLLECTION as DECISIONS_COLLECTION

logger = logging.getLogger("app.market_watch_report")

COLLECTION = "market_watch_daily_report"


def _round(value: Optional[float], digits: int = 4) -> Optional[float]:
    return None if value is None else round(float(value), digits)


def _row(state, rank: Optional[int] = None, blocked: bool = False) -> dict[str, Any]:
    """A compact, report-safe row built only from real recorded state.

    ``blocked`` marks a symbol that was blocked during the day. It is still
    ranked (its price movement really happened) but the reader can never mistake
    a blocked symbol for a tradable one.
    """
    return {
        "rank": rank,
        "symbol": state.symbol,
        "instrumentToken": state.instrument_token,
        "blocked": blocked,
        "ltp": _round(state.ltp, 2),
        "change": _round(state.change, 2),
        "changePct": _round(state.change_pct, 2),
        "volume": state.volume,
        "vwap": _round(state.vwap, 2),
        "turnover": _round((state.vwap * state.volume) if (state.vwap and state.volume) else None, 2),
        "tickCount": state.tick_count,
        "dataQuality": state.data_quality,
        "lastTickTime": state.last_tick_time,
        "circuitDistanceUpperPct": _round(state.circuit_distance_upper_pct, 4),
        "circuitDistanceLowerPct": _round(state.circuit_distance_lower_pct, 4),
        "timeframes": {
            tf: {
                "open": _round(state.timeframe(tf).open, 2),
                "high": _round(state.timeframe(tf).high, 2),
                "low": _round(state.timeframe(tf).low, 2),
                "close": _round(state.timeframe(tf).close, 2),
                "change": _round(state.timeframe(tf).price_move, 4),
                "changePct": _round(state.timeframe(tf).change_pct, 4),
                "volume": state.timeframe(tf).volume,
                "vwap": _round(state.timeframe(tf).vwap, 4),
                "tickCount": state.timeframe(tf).tick_count,
                "dataQuality": state.timeframe(tf).data_quality,
            }
            for tf in ("1m", "5m", "10m", "30m")
        },
    }


def build_report(
    *,
    trading_date: str,
    states: dict[str, Any],
    eligible_tokens: Sequence[str],
    subscribed_tokens: Sequence[str],
    ledger,
    lifecycle_snapshot: dict[str, Any],
    stats: Optional[dict[str, Any]] = None,
    cfg: Optional[MarketWatchConfig] = None,
    started_at: float = 0.0,
) -> dict[str, Any]:
    """Build the full EOD report document (doc §26)."""
    cfg = cfg or load_config()
    top_n = cfg.report_top_n
    eligible = {str(t) for t in eligible_tokens}
    subscribed = {str(t) for t in subscribed_tokens}
    live = [s for s in states.values() if s.ltp is not None]
    blocked = {t for t in ledger.blocked_tokens()}

    def rows(ordered: list, limit: Optional[int] = None) -> list[dict[str, Any]]:
        picked = ordered if limit is None else ordered[:limit]
        return [_row(s, i + 1, s.instrument_token in blocked) for i, s in enumerate(picked)]

    gainers = sorted(
        [s for s in live if (s.change_pct or 0) > 0], key=lambda s: s.change_pct, reverse=True
    )[:top_n]
    decliners = sorted(
        [s for s in live if (s.change_pct or 0) < 0], key=lambda s: s.change_pct
    )[:top_n]
    volume_ranked = sorted(
        [s for s in live if s.volume], key=lambda s: s.volume, reverse=True
    )[:top_n]
    most_active = sorted(
        [s for s in live if s.tick_count], key=lambda s: s.tick_count, reverse=True
    )[:top_n]
    near = sorted(
        [s for s in live if circuit_near(s, cfg)], key=lambda s: s.tick_count, reverse=True
    )[:top_n]

    blocked_rows = []
    for entry in ledger.entries():
        if getattr(entry, "status", "") != "BLOCKED":
            continue
        blocked_rows.append({
            "symbol": entry.symbol,
            "instrumentToken": entry.instrument_token,
            "reason": entry.reason,
            "threshold": _round(entry.threshold, 4),
            "observedValue": _round(entry.observed_value, 4),
            "circuitBlockPct": _round(entry.circuit_block_pct, 4),
            "blockedAt": entry.blocked_at,
            "reenteredAt": entry.reentered_at,
            "detail": entry.detail,
        })
    blocked_rows.sort(key=lambda r: (str(r.get("reason") or ""), str(r.get("symbol") or "")))

    quality_counts: dict[str, int] = {}
    total_ticks = 0
    for state in states.values():
        quality_counts[state.data_quality] = quality_counts.get(state.data_quality, 0) + 1
        total_ticks += int(state.tick_count or 0)

    return {
        "_id": trading_date,
        "date": trading_date,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "generationDurationMs": round((time.time() - started_at) * 1000.0, 2) if started_at else None,
        "lifecycle": lifecycle_snapshot,
        "counts": {
            "universeTracked": len(states),
            "eligible": len(eligible),
            "eligibleTarget": cfg.universe.eligible_target,
            "subscribed": len(subscribed),
            "blocked": len(blocked_rows),
            "withLivePrice": len(live),
            "totalValidatedTicks": total_ticks,
        },
        "movers": {
            # §26: "high loss" needs a strategy/position definition Market Watch
            # does not own, so the report states a measured price decline only.
            "topGainers": rows(gainers),
            "topDeclinersByPriceChange": rows(decliners),
        },
        "highestVolume": rows(volume_ranked),
        "mostActive": rows(most_active),
        "circuitNear": rows(near),
        "blocked": blocked_rows,
        "blockReasons": ledger.reason_counts(),
        "dataQuality": {
            "bySymbol": quality_counts,
            "vocabulary": [
                DATA_QUALITY_LIVE, DATA_QUALITY_IN_PROGRESS, DATA_QUALITY_COMPLETE,
                DATA_QUALITY_INCOMPLETE, DATA_QUALITY_STALE, DATA_QUALITY_UNAVAILABLE,
            ],
        },
        "runtime": dict(stats or {}),
        "notes": [
            "Report built from recorded live state only; no values are synthesised.",
            "Decliners are price declines, not strategy/position losses.",
            "Timeframe data quality INCOMPLETE means the bucket could not be fully reconstructed after a restart.",
        ],
    }


def persist(report: dict[str, Any]) -> bool:
    """Persist the report through the DB Writer (never a direct Mongo write)."""
    try:
        from services.db_writer_engine import db_writer_engine

        accepted = db_writer_engine.buffer_documents(COLLECTION, [report])
        if accepted <= 0:
            logger.warning("[MARKET_WATCH_REPORT] DB Writer rejected the EOD report document")
            return False
        logger.info(
            "[MARKET_WATCH_REPORT] report for %s queued (eligible=%s blocked=%s)",
            report.get("date"), report.get("counts", {}).get("eligible"),
            report.get("counts", {}).get("blocked"),
        )
        return True
    except Exception as exc:
        logger.error("[MARKET_WATCH_REPORT] persist failed: %s", exc)
        return False


async def load_report(trading_date: str) -> Optional[dict[str, Any]]:
    """Read a stored report (REST history / audit). Read-only.

    ``persist`` writes ``_id == date``, so ``_id`` is the primary key. A document
    written by an earlier build that carried only the ``date`` field is still
    found through the fallback rather than being reported as ``NO_REPORT``.
    """
    try:
        from database.connection import get_db

        db = get_db()
        if db is None:
            return None
        doc = await db[COLLECTION].find_one({"_id": trading_date})
        if doc is None:
            doc = await db[COLLECTION].find_one({"date": trading_date})
        return doc
    except Exception as exc:
        logger.warning("[MARKET_WATCH_REPORT] load %s failed: %s", trading_date, exc)
        return None


async def recent(limit: int = 10) -> list[dict[str, Any]]:
    try:
        from database.connection import get_db

        db = get_db()
        if db is None:
            return []
        cursor = db[COLLECTION].find({}, {"_id": 0, "date": 1, "generatedAt": 1, "counts": 1})
        return await cursor.sort("date", -1).limit(max(1, min(limit, 100))).to_list(length=None)
    except Exception as exc:
        logger.warning("[MARKET_WATCH_REPORT] recent failed: %s", exc)
        return []


async def ensure_indexes() -> None:
    try:
        from database.connection import get_db

        db = get_db()
        if db is None:
            return
        await db[COLLECTION].create_index([("date", 1)], unique=True)
        await db[DECISIONS_COLLECTION].create_index([("date", 1), ("instrumentToken", 1)], unique=True)
    except Exception as exc:
        logger.debug("[MARKET_WATCH_REPORT] index creation skipped: %s", exc)


__all__ = [
    "COLLECTION",
    "build_report",
    "ensure_indexes",
    "load_report",
    "persist",
    "recent",
]
