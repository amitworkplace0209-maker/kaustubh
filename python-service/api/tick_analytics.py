"""Tick Analytics center router — thin coordinator between the real engine
(module ``services.tick_analytics``) and the HTTP layer.

Every response is driven by the live broker state and persisted ticks; nothing
is fabricated. When a window cannot be served (no symbol, no ticks, etc.) the
endpoint returns ``available: false`` with a reason — the frontend renders an
informative placeholder, not fake charts.
"""

from __future__ import annotations

import math
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/data-saver/tick-analytics", tags=["tick-analytics"])


class TsRequest(BaseModel):
    symbol: str = Field(..., min_length=1)
    rangeSec: int = Field(300, ge=30, le=30*60)


class SymbolRequest(BaseModel):
    symbol: str = Field(..., min_length=1)
    rsiPeriod: int = Field(14, ge=3, le=50)
    atrPeriod: int = Field(14, ge=3, le=50)


class HistoryRequest(BaseModel):
    symbol: str = Field(..., min_length=1)
    intervalSec: int = Field(300, ge=1, le=3600)
    fromMs: Optional[int] = Field(None, ge=0)
    toMs: Optional[int] = Field(None, ge=0)


class AnomalyRequest(BaseModel):
    symbol: str = Field(..., min_length=1)
    rangeSec: int = Field(300, ge=30, le=3600)


# ── Lazy engine import (avoids import-time circular dependency) ────────────
_engine = None


def _get_engine():
    global _engine
    if _engine is None:
        from services import tick_analytics as mod
        _engine = mod
    return _engine


def _safe(result: dict) -> dict:
    """Strip NaN / Infinity before they reach the JSON serializer — a last-resort
    safety net; callers should already produce clean floats.
    """
    def _clean(v):
        if isinstance(v, float):
            return None if not math.isfinite(v) else v
        if isinstance(v, dict):
            return {k: _clean(x) for k, x in v.items()}
        if isinstance(v, list):
            return [_clean(x) for x in v]
        return v
    return _clean(result)


# ────────────────────────────────────────────────────────────────────────────
# GET /state — real-time broker/live health
# ────────────────────────────────────────────────────────────────────────────

@router.get("/state")
async def state():
    eng = _get_engine()
    return _safe(eng.live_state())


# ────────────────────────────────────────────────────────────────────────────
# GET /metrics — lifetime + current throughput
# ────────────────────────────────────────────────────────────────────────────

@router.get("/metrics")
async def metrics():
    eng = _get_engine()
    return _safe(eng.metrics())


# ────────────────────────────────────────────────────────────────────────────
# POST /timeseries — per-second bucketed stats
# ────────────────────────────────────────────────────────────────────────────

@router.post("/timeseries")
async def timeseries(req: TsRequest):
    eng = _get_engine()
    return _safe(await eng.timeseries(req.symbol, req.rangeSec))


# ────────────────────────────────────────────────────────────────────────────
# POST /symbol/{symbol} — deep per-symbol analytics
# ────────────────────────────────────────────────────────────────────────────

@router.get("/symbol/{symbol}")
async def symbol(
    symbol: str,
    rsiPeriod: int = Query(14, ge=3, le=50),
    atrPeriod: int = Query(14, ge=3, le=50),
):
    eng = _get_engine()
    return _safe(await eng.symbol_analytics(symbol, rsiPeriod, atrPeriod))


# ────────────────────────────────────────────────────────────────────────────
# GET /depth/{symbol} — live order depth
# ────────────────────────────────────────────────────────────────────────────

@router.get("/depth/{symbol}")
async def depth(symbol: str):
    eng = _get_engine()
    result = await eng.symbol_analytics(symbol)
    return _safe(result.get("depth", {"available": False, "reason": "DEPTH_UNAVAILABLE"}))


# ────────────────────────────────────────────────────────────────────────────
# GET /market-wide — memory-state market overview
# ────────────────────────────────────────────────────────────────────────────

@router.get("/market-wide")
async def market_wide():
    eng = _get_engine()
    return _safe(eng.market_wide())


# ────────────────────────────────────────────────────────────────────────────
# POST /history — persisted OHLC candles
# ────────────────────────────────────────────────────────────────────────────

@router.post("/history")
async def history(req: HistoryRequest):
    eng = _get_engine()
    return _safe(await eng.history(req.symbol, req.intervalSec, req.fromMs, req.toMs))


# ────────────────────────────────────────────────────────────────────────────
# POST /anomalies — detected anomalies
# ────────────────────────────────────────────────────────────────────────────

@router.post("/anomalies")
async def anomalies(req: AnomalyRequest):
    eng = _get_engine()
    return _safe(await eng.anomalies(req.symbol, req.rangeSec))


# =========================================================================== #
# TICK ANALYTICS (redesign) -- daily / symbol / persistence / report surface
# =========================================================================== #
# These routes are the authoritative analytics surface for the rebuilt
# Tick Analytics page. They are read-only observability endpoints: Tick
# Analytics never writes ticks, never owns the broker feed and never
# re-derives persistence from raw document counts.


def _daily_mod():
    from services import tick_analytics_daily as mod
    return mod


@router.get("/summary")
async def summary():
    """ONE lightweight snapshot for the whole page (cached, bounded)."""
    eng = _get_engine()
    return _safe(await eng.summary())


@router.get("/daily")
async def daily(days: int = Query(30, ge=1, le=366)):
    """Pre-aggregated daily tick analytics rows (stored docs only)."""
    result = await _daily_mod().list_days(days)
    return _safe(result)


@router.get("/daily/{date}")
async def daily_detail(date: str):
    """Full daily document: periods, minute buckets, symbol stats."""
    doc = await _daily_mod().get_day(date)
    return _safe(doc)


@router.get("/top-symbols")
async def top_symbols(
    date: str = "",
    limit: int = Query(10, ge=1, le=50),
    offset: int = Query(0, ge=0),
):
    from core.timezones import business_date_str
    target = date or business_date_str()
    return _safe(await _daily_mod().top_symbols(target, limit=limit, offset=offset))


@router.get("/symbol-stats/{symbol}")
async def symbol_stats(symbol: str, date: str = ""):
    """Selected-symbol tick analytics: day facts + live windows + latest quote."""
    eng = _get_engine()
    return _safe(await eng.symbol_tick_stats(symbol, date or None))


@router.get("/rate")
async def rate():
    eng = _get_engine()
    return _safe(await eng.rate_analytics())


@router.get("/persistence")
async def persistence():
    eng = _get_engine()
    return _safe(await eng.persistence_analytics())


@router.get("/sources")
async def sources():
    eng = _get_engine()
    return _safe(await eng.source_analytics())


@router.get("/storage")
async def storage():
    eng = _get_engine()
    return _safe(await eng.storage_analytics())


@router.get("/quality")
async def quality(date: str = ""):
    eng = _get_engine()
    return _safe(await eng.quality_analytics(date or None))


@router.get("/latency")
async def latency():
    eng = _get_engine()
    return _safe(await eng.latency_block())


@router.get("/report")
async def report(date: str = ""):
    """Authoritative Tick Analytics Report for one IST business day."""
    from core.timezones import business_date_str
    target = date or business_date_str()
    doc = await _daily_mod().get_day(target)
    return _safe(_daily_mod().build_report(target, doc))


@router.get("/reports")
async def reports(days: int = Query(60, ge=1, le=366)):
    """Report history from the stored daily documents (no regeneration)."""
    from core.timezones import business_date_str
    listing = await _daily_mod().list_days(days, build_missing=True)
    rows = []
    for row in listing.get("rows") or []:
        date_str = row.get("date")
        rep = _daily_mod().build_report(date_str, row)
        rows.append({
            "date": date_str,
            "tradingDay": row.get("tradingDay"),
            "status": rep.get("status"),
            "complete": rep.get("complete"),
            "ticks": (row.get("ticks") or {}).get("count"),
            "symbols": (row.get("counts") or {}).get("symbols"),
            "persistence": (row.get("persistence") or {}).get("successPct"),
            "storage": (row.get("storage") or {}).get("bytes"),
            "qualityScore": (row.get("quality") or {}).get("score"),
            "missing": rep.get("missing"),
            "generatedAt": rep.get("generatedAt"),
        })
    return _safe({
        "days": days,
        "count": len(rows),
        "today": business_date_str(),
        "rows": rows,
        "missingDates": listing.get("missingDates"),
        "pendingBackfill": listing.get("pendingBackfill"),
    })


@router.get("/export")
async def export(
    date: str = "",
    days: int = Query(30, ge=1, le=366),
    format: str = Query("csv", pattern="^(csv|json)$"),
):
    """Backend-authoritative export of the daily analytics table / one report."""
    from fastapi.responses import PlainTextResponse
    from core.timezones import business_date_str

    if date:
        doc = await _daily_mod().get_day(date)
        payload = _daily_mod().build_report(date, doc)
        if format == "json":
            return _safe(payload)
        return PlainTextResponse(_report_csv([payload]), media_type="text/csv")

    listing = await _daily_mod().list_days(days)
    rows = listing.get("rows") or []
    if format == "json":
        return _safe({"days": days, "count": len(rows), "rows": rows,
                      "generatedAt": business_date_str()})
    return PlainTextResponse(_daily_csv(rows), media_type="text/csv")


_DAILY_CSV_COLUMNS = [
    ("date", "Date"), ("tradingDay", "Trading Day"), ("status", "Status"),
    ("received", "Ticks Received"), ("persisted", "Ticks Persisted"),
    ("failed", "Failed"), ("skipped", "Skipped"), ("symbols", "Symbols"),
    ("avgRate", "Avg Tick Rate"), ("peakRate", "Peak Tick Rate"),
    ("firstTick", "First Tick"), ("lastTick", "Last Tick"),
    ("activeDurationSec", "Active Duration (s)"), ("storageBytes", "Storage Added"),
    ("persistencePct", "Persistence Success %"),
]


def _cell(row: dict, key: str):
    counts = row.get("counts") or {}
    ticks = row.get("ticks") or {}
    storage = row.get("storage") or {}
    persistence = row.get("persistence") or {}
    mapping = {
        "date": row.get("date"),
        "tradingDay": row.get("tradingDay"),
        "status": row.get("status"),
        "received": counts.get("received"),
        "persisted": counts.get("persisted"),
        "failed": counts.get("failed"),
        "skipped": persistence.get("skipped"),
        "symbols": counts.get("symbols"),
        "avgRate": ticks.get("avgTickRate"),
        "peakRate": ticks.get("peakTickRate"),
        "firstTick": ticks.get("firstTickAt"),
        "lastTick": ticks.get("lastTickAt"),
        "activeDurationSec": ticks.get("activeDurationSec"),
        "storageBytes": storage.get("bytes"),
        "persistencePct": persistence.get("successPct"),
    }
    return mapping.get(key)


def _csv(header: list[tuple[str, str]], rows: list[list]) -> str:
    import csv
    import io

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([label for _, label in header])
    for row in rows:
        writer.writerow(["" if v is None else v for v in row])
    return buf.getvalue()


def _daily_csv(rows: list[dict]) -> str:
    return _csv(
        _DAILY_CSV_COLUMNS,
        [[_cell(r, key) for key, _ in _DAILY_CSV_COLUMNS] for r in rows],
    )


def _report_csv(reports: list[dict]) -> str:
    header = [
        ("date", "Report Date"), ("status", "Status"), ("complete", "Complete"),
        ("ticksReceived", "Ticks Received"), ("ticksPersisted", "Ticks Persisted"),
        ("failed", "Failed"), ("symbols", "Active Symbols"),
        ("firstTick", "First Tick"), ("lastTick", "Last Tick"),
        ("avgTickRate", "Avg Tick Rate"), ("peakTickRate", "Peak Tick Rate"),
        ("persistencePct", "Persistence Success %"),
        ("storageBytes", "Storage Added"), ("generatedAt", "Generated At"),
    ]
    out = []
    for rep in reports:
        sections = rep.get("sections") or {}
        counts = sections.get("counts") or {}
        ticks = sections.get("ticks") or {}
        persistence = sections.get("persistence") or {}
        storage = sections.get("storage") or {}
        out.append([
            rep.get("date"), rep.get("status"), rep.get("complete"),
            counts.get("received"), counts.get("persisted"), counts.get("failed"),
            counts.get("symbols"), ticks.get("firstTickAt"), ticks.get("lastTickAt"),
            ticks.get("avgTickRate"), ticks.get("peakTickRate"),
            persistence.get("successPct"), storage.get("bytes"), rep.get("generatedAt"),
        ])
    return _csv(header, out)
