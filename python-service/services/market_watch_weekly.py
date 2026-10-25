"""Saturday weekly review report (docs/engines/MARKET_WATCH.md §4, §5, §16, §17).

Built from **Monday-Friday saved data** only — never from a live tick and never
from an invented value. For every reviewed symbol the report carries the doc §5
field list; anything the saved data cannot supply stays ``None`` and is counted
in ``dataCompleteness`` so the operator can see the gap instead of trusting a
fabricated number (doc §35.11).

Outputs are written through DB Writer (``buffer_documents``), same hand-off the
daily EOD report uses (doc §13/§35.9).

The report is ADVISORY (doc §5: "The user remains the final authority"). It
produces a ``recommendation`` per symbol; it never adds or removes anything.
That is the operator's LOCK call — see ``services.market_watch_universe``.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Optional

from services.market_watch_config import (
    RECOMMENDATION_ADD,
    RECOMMENDATION_KEEP,
    RECOMMENDATION_REMOVE,
    RECOMMENDATION_REVIEW,
    TIMEFRAMES,
    load as load_config,
)
from services.market_watch_state import fnum
from services.market_watch_universe import (
    COLLECTION_WEEKLY_REPORTS,
    week_id_for,
    week_start,
)

CANDLE_COLLECTIONS: dict[str, str] = {
    "1m": "market_candles_1m",
    "5m": "market_candles_5m",
    "10m": "market_candles_10m",
    "30m": "market_candles_30m",
}


def _db():
    from database.connection import get_db

    return get_db()


def _buffer(docs: list[dict[str, Any]]) -> bool:
    try:
        # The DB Writer INSTANCE, not the module (doc §13/§35.9).
        from services.db_writer_engine import db_writer_engine as writer

        writer.buffer_documents(COLLECTION_WEEKLY_REPORTS, docs)
        return True
    except Exception:
        return False


def trading_days_for(week_start_date: Optional[datetime] = None) -> list[str]:
    """Monday..Friday ISO dates of the week, filtered by the market calendar."""
    start = week_start_date or week_start()
    days: list[str] = []
    for offset in range(5):
        day = start + timedelta(days=offset)
        try:
            from utils.market_calendar import is_trading_day

            if not is_trading_day(day.date()):
                continue
        except Exception:
            # Calendar unavailable — do NOT silently drop a trading day, but do
            # not invent one either: keep weekdays and let completeness report it.
            if day.weekday() >= 5:
                continue
        days.append(day.date().isoformat())
    return days


async def _week_candles(days: list[str], symbols: list[str]) -> dict[str, dict[str, dict[str, Any]]]:
    """Aggregate the saved 1m candles of the week per symbol per day.

    Only ``high``/``low``/``close``/``volume`` are needed for the doc §5 fields
    and all of them are real stored values. 1m is the finest stored timeframe, so
    it is the most faithful "observation" source available.
    """
    collection = _db()[CANDLE_COLLECTIONS["1m"]]
    out: dict[str, dict[str, dict[str, Any]]] = {}
    if not days or not symbols:
        return out
    try:
        cursor = collection.find(
            {"date": {"$in": days}, "symbol": {"$in": symbols}},
            projection={
                "_id": 0, "symbol": 1, "date": 1, "open": 1, "high": 1,
                "low": 1, "close": 1, "volume": 1, "bucketStartEpoch": 1,
            },
        ).sort([("date", 1), ("bucketStartEpoch", 1)])
        async for doc in cursor:
            try:
                symbol = str(doc.get("symbol") or "")
                date = str(doc.get("date") or "")
                if not symbol or not date:
                    continue
                bucket = out.setdefault(symbol, {}).setdefault(
                    date,
                    {"high": None, "low": None, "lastClose": None, "firstOpen": None, "volume": 0.0, "bars": 0},
                )
                high = fnum(doc.get("high"))
                low = fnum(doc.get("low"))
                close = fnum(doc.get("close"))
                volume = fnum(doc.get("volume")) or 0.0
                if high is not None and (bucket["high"] is None or high > bucket["high"]):
                    bucket["high"] = high
                if low is not None and (bucket["low"] is None or low < bucket["low"]):
                    bucket["low"] = low
                if close is not None:
                    bucket["lastClose"] = close
                if bucket["firstOpen"] is None:
                    bucket["firstOpen"] = fnum(doc.get("open"))
                bucket["volume"] += volume
                bucket["bars"] += 1
            except Exception:
                continue
    except Exception:
        return out
    return out


def _observe_threshold(bars: dict[str, Any], threshold: float) -> int:
    """Count observation-days whose high reached at/above the threshold.

    Counting at DAY granularity from saved candles keeps the report honest: it
    reports what was actually persisted rather than an in-memory tick tally that
    no longer exists on Saturday.
    """
    count = 0
    for bucket in bars.values():
        high = bucket.get("high")
        if high is not None and high >= threshold:
            count += 1
    return count


def _instrument_meta(symbols: list[str]) -> dict[str, dict[str, Any]]:
    """Authoritative instrument metadata (doc §9) — token, name, exchange, …."""
    out: dict[str, dict[str, Any]] = {}
    if not symbols:
        return out
    try:
        from services.instrument_cache import instrument_cache as _cache

        instruments = _cache.get_instruments() or []
    except Exception:
        return out
    wanted = set(symbols)
    for inst in instruments:
        sym = str(inst.get("symbol") or inst.get("tradingSymbol") or "")
        if sym not in wanted:
            continue
        out[sym] = {
            "tradingSymbol": inst.get("tradingSymbol") or inst.get("trading_symbol") or sym,
            "companyName": inst.get("companyName") or inst.get("name") or inst.get("company"),
            "exchange": inst.get("exchange") or inst.get("exchangeSegment"),
            "exchangeSegment": inst.get("exchangeSegment") or inst.get("exchange_segment"),
            "segment": inst.get("segment"),
            "token": str(inst.get("instrumentToken") or inst.get("token") or ""),
            "instrumentType": inst.get("instrumentType") or inst.get("instrument_type"),
            "series": inst.get("series"),
            "lotSize": inst.get("lotSize") or inst.get("lot_size"),
            "tickSize": inst.get("tickSize") or inst.get("tick_size"),
            "precision": inst.get("precision"),
            "multiplier": inst.get("multiplier"),
            "isin": inst.get("isin") or inst.get("ISIN"),
            "expiry": inst.get("expiry"),
            "strike": inst.get("strike"),
            "optionType": inst.get("optionType") or inst.get("option_type"),
            "intradayEligible": inst.get("intradayEligible"),
        }
    return out


async def build_weekly_report(
    week_id: Optional[str] = None,
    *,
    symbols: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Build the advisory weekly report for ``week_id`` (doc §5)."""
    cfg = load_config()
    week_id = week_id or week_id_for()
    start = week_start()
    days = trading_days_for(start)

    from services.market_watch_universe import load_locked_universe

    locked = await load_locked_universe()
    if symbols is None:
        symbols = list(locked.symbols) if locked else []

    candles = await _week_candles(days, symbols)
    meta = _instrument_meta(symbols)
    circuits_by_symbol = await _daily_circuits(days)
    threshold = cfg.weekly.rupee_threshold

    rows: list[dict[str, Any]] = []
    for symbol in symbols:
        meta_row = meta.get(symbol, {})
        by_day = candles.get(symbol, {})

        highs = [b["high"] for b in by_day.values() if b.get("high") is not None]
        lows = [b["low"] for b in by_day.values() if b.get("low") is not None]
        closes = [b["lastClose"] for b in by_day.values() if b.get("lastClose") is not None]
        opens = [b["firstOpen"] for b in by_day.values() if b.get("firstOpen") is not None]

        first_price = opens[0] if opens else None
        last_price = closes[-1] if closes else None
        weekly_change = (
            last_price - first_price
            if first_price is not None and last_price is not None
            else None
        )
        weekly_change_pct = (
            (weekly_change / first_price) * 100.0
            if weekly_change is not None and first_price
            else None
        )

        days_observed = len(by_day)
        days_above = _observe_threshold(by_day, threshold)
        days_at_or_below = days_observed - days_above

        # doc §14 — circuit/margin come from the daily reports, never invented.
        circuits = circuits_by_symbol.get(symbol) or {
            "upper": None, "lower": None, "minDistancePct": None, "dangerDays": 0
        }
        margin = _last_margin(symbol, days)

        available = [
            first_price is not None,
            last_price is not None,
            bool(highs),
            bool(lows),
            days_observed > 0,
            circuits.get("upper") is not None,
            circuits.get("lower") is not None,
            margin.get("value") is not None,
        ]

        rows.append(
            {
                "symbol": symbol,
                "tradingSymbol": meta_row.get("tradingSymbol"),
                "companyName": meta_row.get("companyName"),
                "exchange": meta_row.get("exchange"),
                "segment": meta_row.get("segment"),
                "token": meta_row.get("token"),
                "instrumentType": meta_row.get("instrumentType"),
                "series": meta_row.get("series"),
                "lotSize": meta_row.get("lotSize"),
                "tickSize": meta_row.get("tickSize"),
                "precision": meta_row.get("precision"),
                "multiplier": meta_row.get("multiplier"),
                "isin": meta_row.get("isin"),
                "latestLtp": last_price,
                "weeklyMinLtp": min(lows) if lows else None,
                "weeklyMaxLtp": max(highs) if highs else None,
                "observationsAboveThreshold": days_above,
                "observationsAtOrBelowThreshold": days_at_or_below,
                "threshold": threshold,
                "firstObservedPrice": first_price,
                "lastObservedPrice": last_price,
                "weeklyChange": round(weekly_change, 4) if weekly_change is not None else None,
                "weeklyChangePercent": round(weekly_change_pct, 4) if weekly_change_pct is not None else None,
                "tradingDaysObserved": days_observed,
                "intradayEligible": meta_row.get("intradayEligible"),
                "upperCircuit": circuits.get("upper"),
                "lowerCircuit": circuits.get("lower"),
                "minCircuitDistancePct": circuits.get("minDistancePct"),
                "circuitDangerObservations": circuits.get("dangerDays"),
                "marginValue": margin.get("value"),
                "marginMultiplier": margin.get("multiplier"),
                "marginStatus": margin.get("status"),
                "marginMeetsThreshold": margin.get("meetsThreshold"),
                "marginThresholdMultiplier": cfg.weekly.margin_multiplier_threshold,
                "volume": round(sum(b.get("volume") or 0.0 for b in by_day.values()), 2) if by_day else None,
                "dataCompleteness": round(sum(1 for a in available if a) / len(available), 4),
                "timeframes": list(TIMEFRAMES),
                "recommendation": _recommend(
                    days_above=days_above,
                    days_observed=days_observed,
                    last_price=last_price,
                    threshold=threshold,
                    circuits=circuits,
                    margin=margin,
                    margin_threshold=cfg.weekly.margin_multiplier_threshold,
                    completeness=sum(1 for a in available if a) / len(available),
                ),
            }
        )

    report = {
        "weekId": week_id,
        "weekStart": start.date().isoformat(),
        "weekEnd": (start + timedelta(days=4)).date().isoformat(),
        "tradingDays": days,
        "generatedAt": datetime.now().astimezone().isoformat(),
        "sourceWeekId": locked.week_id if locked else None,
        "universeSize": len(symbols),
        "threshold": threshold,
        "dangerCircuitPct": cfg.weekly.danger_circuit_pct,
        "marginThresholdMultiplier": cfg.weekly.margin_multiplier_threshold,
        "counts": {
            "reviewed": len(rows),
            "withData": sum(1 for r in rows if r["tradingDaysObserved"] > 0),
            "withoutData": sum(1 for r in rows if r["tradingDaysObserved"] == 0),
            "recommendAdd": sum(1 for r in rows if r["recommendation"] == RECOMMENDATION_ADD),
            "recommendRemove": sum(1 for r in rows if r["recommendation"] == RECOMMENDATION_REMOVE),
            "recommendKeep": sum(1 for r in rows if r["recommendation"] == RECOMMENDATION_KEEP),
            "recommendReview": sum(1 for r in rows if r["recommendation"] == RECOMMENDATION_REVIEW),
        },
        "rows": rows,
        "notes": [
            "Advisory only — the operator remains the final authority (doc §5).",
            "Values are built from persisted Monday-Friday candles; missing data stays null (doc §35.11).",
            "Crossing the threshold during the week never changes membership (doc §33).",
        ],
    }
    return report


async def _daily_circuits(days: list[str]) -> dict[str, dict[str, Any]]:
    """Newest real circuit values per symbol from the daily EOD reports (doc §14).

    One pass over the week's reports, so the per-symbol loop never re-queries.
    """
    cfg = load_config()
    out: dict[str, dict[str, Any]] = {}
    if not days:
        return out
    try:
        cursor = _db().market_watch_daily_report.find(
            {"date": {"$in": days}}, projection={"_id": 0, "date": 1, "movers": 1, "circuitNear": 1}
        )
        reports = sorted((dict(d) async for d in cursor), key=lambda d: str(d.get("date")))
    except Exception:
        return out
    for report in reports:
        for bucket in ("topGainers", "topDeclinersByPriceChange"):
            for row in (report.get("movers") or {}).get(bucket) or []:
                symbol = str(row.get("symbol") or "")
                if not symbol:
                    continue
                entry = out.setdefault(
                    symbol, {"upper": None, "lower": None, "minDistancePct": None, "dangerDays": 0}
                )
                up = fnum(row.get("upperCircuit"))
                lo = fnum(row.get("lowerCircuit"))
                if up is not None:
                    entry["upper"] = up
                if lo is not None:
                    entry["lower"] = lo
                du = fnum(row.get("circuitDistanceUpperPct"))
                dl = fnum(row.get("circuitDistanceLowerPct"))
                valid = [d for d in (du, dl) if d is not None and d >= 0]
                if valid:
                    minimum = min(valid)
                    entry["minDistancePct"] = minimum
                    if minimum < cfg.weekly.danger_circuit_pct:
                        entry["dangerDays"] += 1
    return out


async def _last_daily_circuit(symbol: str, days: list[str]) -> dict[str, Any]:
    """Newest real circuit values for ``symbol`` from the daily EOD reports."""
    out: dict[str, Any] = {"upper": None, "lower": None, "minDistancePct": None, "dangerDays": 0}
    circuits = await _daily_circuits(days)
    return circuits.get(symbol, out)


def _last_margin(symbol: str, days: list[str]) -> dict[str, Any]:
    """Newest authoritative margin decision for ``symbol`` (doc §17).

    Read from the Session Manager's published ``marginDecisions`` snapshot only.
    If nothing authoritative is published the status is ``UNAVAILABLE`` — Market
    Watch never invents leverage.
    """
    cfg = load_config()
    out: dict[str, Any] = {"value": None, "multiplier": None, "status": "UNAVAILABLE", "meetsThreshold": None}
    try:
        from services.session.session_manager import get_session_manager

        snapshot = get_session_manager().snapshot() or {}
    except Exception:
        return out
    decisions = snapshot.get("marginDecisions") or {}
    entry = decisions.get(symbol)
    if not isinstance(entry, dict):
        return out
    value = fnum(entry.get("marginValue") or entry.get("value") or entry.get("requiredMargin"))
    multiplier = fnum(entry.get("multiplier") or entry.get("leverage") or entry.get("marginMultiplier"))
    out["value"] = value
    out["multiplier"] = multiplier
    if multiplier is None or value is None:
        out["status"] = "UNAVAILABLE"
        return out
    out["meetsThreshold"] = multiplier >= cfg.weekly.margin_multiplier_threshold
    out["status"] = "AUTHORITATIVE" if out["meetsThreshold"] else "BELOW_THRESHOLD"
    return out


def _recommend(
    *,
    days_above: int,
    days_observed: int,
    last_price: Optional[float],
    threshold: float,
    circuits: dict[str, Any],
    margin: dict[str, Any],
    margin_threshold: float,
    completeness: float,
) -> str:
    """Advisory recommendation (doc §5). Never acts on it."""
    if days_observed == 0 or last_price is None:
        return RECOMMENDATION_REVIEW
    if margin.get("multiplier") is not None and margin["multiplier"] < margin_threshold:
        return RECOMMENDATION_REMOVE
    if last_price < threshold:
        return RECOMMENDATION_REMOVE
    if days_above == days_observed and completeness >= 0.6:
        return RECOMMENDATION_ADD
    return RECOMMENDATION_KEEP


def persist(report: dict[str, Any]) -> bool:
    """Persist the weekly report through DB Writer (doc §13/§35.9)."""
    doc = dict(report)
    doc["_id"] = report.get("weekId")
    return _buffer([doc])


async def load_report(week_id: str) -> Optional[dict[str, Any]]:
    try:
        doc = await _db().market_watch_weekly_reports.find_one({"weekId": week_id})
    except Exception:
        return None
    if not doc:
        return None
    doc.pop("_id", None)
    return dict(doc)


async def recent_reports(limit: int = 12) -> list[dict[str, Any]]:
    try:
        cursor = (
            _db()
            .market_watch_weekly_reports.find({}, projection={"rows": 0})
            .sort([("weekId", -1)])
            .limit(max(1, min(52, limit)))
        )
        return [dict(d) async for d in cursor]
    except Exception:
        return []


async def ensure_indexes() -> bool:
    try:
        await _db().market_watch_weekly_reports.create_index([("weekId", 1)], unique=True, name="mw_weekly_report_id")
        return True
    except Exception:
        return False


__all__ = [
    "CANDLE_COLLECTIONS",
    "build_weekly_report",
    "ensure_indexes",
    "load_report",
    "persist",
    "recent_reports",
    "trading_days_for",
]