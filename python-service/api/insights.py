"""Data SAVer Insights — canonical REST surface for the Intelligence,
Event, Audit and Reporting Center.

Every endpoint returns REAL runtime/MongoDB state. Nothing is fabricated:
metrics that cannot be measured respond with nulls ("Not available") rather
than invented zeros. No credentials, tokens or private headers ever leave the
backend.

Route convention is version-free and stable under ``/api/data-saver/insights``.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query

from services import ds_insights
from services import api_telemetry

router = APIRouter(prefix="/api/data-saver/insights", tags=["data-saver-insights"])
logger = logging.getLogger("ds_insights_api")


@router.get("/live")
async def insights_live():
    """LIVE NOW — canonical real-time snapshot of every subsystem."""
    return await ds_insights.live_snapshot()


@router.get("/summary")
async def insights_summary():
    """Aggregated overview — the one authoritative request the Data Insights
    overview page makes (attention + activity + error + today counts)."""
    return await ds_insights.data_insights_summary()


@router.get("/cards")
async def insights_cards(range_hours: int = 24, market_date: str | None = None):
    """Core summary cards: ledger digest + error groups + telemetry totals."""
    if market_date:
        digest = await ds_insights.ledger_state_digest(market_date=market_date)
    else:
        digest = await ds_insights.ledger_state_digest(range_hours=range_hours)
    errors = await ds_insights.error_groups(
        range_hours=range_hours, market_date=market_date, include_warnings=True)
    telemetry = await ds_insights.get_telemetry_series(
        market_date=market_date, hours=range_hours)
    api = await ds_insights.api_telemetry_summary(
        market_date=market_date, range_hours=range_hours)
    total_received = sum(t.get("received", 0) for t in telemetry)
    total_written = sum(t.get("written", 0) for t in telemetry)
    total_errors = sum(t.get("errors", 0) for t in telemetry)
    incidents = await ds_insights.list_incidents(
        market_date=market_date, limit=50
    ) if market_date else {"incidents": [], "total": 0}
    groups = errors.get("groups", [])
    open_errors = sum(1 for g in groups if not g.get("resolved"))
    return {
        "window": {"range_hours": range_hours, "market_date": market_date},
        "events": digest,
        "errors": {
            "groupTotal": errors.get("total", 0),
            "occurrences": sum(g.get("occurrences", 0) for g in groups),
            "open": open_errors,
            "resolved": sum(1 for g in groups if g.get("resolved")),
        },
        "telemetry": {
            "buckets": len(telemetry),
            "ticksReceived": total_received,
            "ticksWritten": total_written,
            "tickErrors": total_errors,
            "writeSuccessPct": round(
                (total_received - total_errors) / total_received * 100, 2
            ) if total_received else None,
            "series": telemetry[-500:],
        },
        "api": api,
        "incidents": incidents.get("total", 0),
    }


@router.get("/events")
async def insights_events(
    limit: int = 100,
    offset: int = 0,
    range_hours: int | None = Query(default=None, ge=1, le=720),
    market_date: str | None = None,
    from_iso: str | None = None,
    to_iso: str | None = None,
    category: str | None = None,
    severity: str | None = None,
    source: str | None = None,
    event_type: str | None = None,
    q: str | None = None,
    symbol: str | None = None,
    oldest_first: bool = False,
):
    """Structured event ledger query with filters + pagination."""
    return await ds_insights.query_events(
        limit=limit, offset=offset, range_hours=range_hours,
        market_date=market_date, from_iso=from_iso, to_iso=to_iso,
        category=category, severity=severity, source=source,
        event_type=event_type, q=q, symbol=symbol, oldest_first=oldest_first,
    )


@router.get("/events/{event_id}")
async def insights_event_detail(event_id: str):
    """Full detail for one ledger event (includes sanitized metadata)."""
    detail = await ds_insights.get_event_detail(event_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="Event not found")
    return detail


@router.get("/errors")
async def insights_errors(
    range_hours: int = 24,
    market_date: str | None = None,
    include_warnings: bool = True,
    limit: int = 200,
):
    """Error Center — recurring errors grouped and correlated with recovery."""
    return await ds_insights.error_groups(
        range_hours=range_hours, market_date=market_date,
        include_warnings=include_warnings, limit=limit)


@router.get("/errors/{group_id}")
async def insights_error_detail(group_id: str, range_hours: int = 24):
    """One Error Center group with the real ledger events behind it."""
    detail = await ds_insights.error_group_detail(
        group_id=group_id, range_hours=range_hours)
    if detail is None:
        raise HTTPException(status_code=404, detail="Error group not found")
    return detail


@router.get("/incidents")
async def insights_incidents(
    limit: int = 50, status: str | None = None,
    kind: str | None = None, market_date: str | None = None,
):
    """Incidents with their full open→resolve lifecycle."""
    return await ds_insights.list_incidents(
        limit=limit, status=status, kind=kind, market_date=market_date)


@router.get("/today")
async def insights_today():
    """TODAY IN DATA SAVER — chronological daily summary from real events."""
    return await ds_insights.today_summary()


@router.get("/attention")
async def insights_attention():
    """ATTENTION REQUIRED — open incidents, live alerts, stale feeds, failures."""
    return await ds_insights.attention()


@router.get("/telemetry")
async def insights_telemetry(
    hours: int = 24,
    market_date: str | None = None,
    resolution_min: int = 1,
    limit: int = 3000,
):
    """Aggregated telemetry series for charts (minute buckets, resampled)."""
    return {"series": await ds_insights.get_telemetry_series(
        hours=hours, market_date=market_date,
        resolution_min=resolution_min, limit=limit)}


@router.get("/api-telemetry")
async def insights_api_telemetry(range_hours: int = 24, market_date: str | None = None):
    """FastAPI request telemetry summary (percentiles, endpoints, success)."""
    return await ds_insights.api_telemetry_summary(
        market_date=market_date, range_hours=range_hours)


@router.get("/search")
async def insights_search(
    q: str = Query(..., min_length=1),
    limit: int = 50,
    market_date: str | None = None,
):
    """Free-text search across the event ledger (message/details/id/symbol)."""
    return await ds_insights.query_events(
        q=q, limit=limit, market_date=market_date)


@router.get("/reports")
async def insights_reports(
    report_type: str | None = None, limit: int = 60,
    from_date: str | None = None, to_date: str | None = None,
):
    """Daily/weekly report archive (newest first)."""
    return await ds_insights.list_reports(
        report_type=report_type, limit=limit, from_date=from_date, to_date=to_date)


@router.get("/reports/daily/{date}")
async def insights_daily_report(date: str):
    """One daily report (cached; generated on demand only when missing)."""
    try:
        report = await ds_insights.get_daily_report_cached_or_generate(date)
    except Exception as exc:
        logger.exception("daily report failed")
        report = {"error": str(exc)}
    if not report:
        raise HTTPException(status_code=404, detail="Report unavailable")
    return report


@router.post("/reports/generate")
async def insights_generate_report(market_date: str | None = None):
    """Regenerate the canonical daily report for a market date."""
    report = await ds_insights.generate_daily_report(market_date)
    if report.get("error"):
        raise HTTPException(status_code=503, detail=report["error"])
    return report


@router.get("/reports/weekly")
async def insights_weekly_report(weeks: int = 1):
    """Weekly report (derived from stored daily reports)."""
    return await ds_insights.get_weekly_report(weeks)


@router.get("/reports/{report_type}")
async def insights_type_report(
    report_type: str,
    market_date: str | None = None,
    hours: int | None = None,
):
    """Typed report — websocket/tick/quality/api/persistence/errors/system."""
    if report_type not in (
        "websocket", "tick", "quality", "api", "persistence", "errors", "system",
    ):
        raise HTTPException(status_code=404, detail=f"Unknown report type: {report_type}")
    return await ds_insights.type_report(
        report_type, market_date=market_date, hours=hours)


@router.post("/events/export")
async def insights_export_events(
    format: str = "csv",
    limit: int = 2000,
    range_hours: int = 24,
    market_date: str | None = None,
    category: str | None = None,
    severity: str | None = None,
):
    """Export ledger events as CSV or JSON (sanitized; never credentials)."""
    res = await ds_insights.query_events(
        limit=limit, range_hours=range_hours, market_date=market_date,
        category=category, severity=severity, oldest_first=True)
    events = res.get("events", [])
    if format == "json":
        body = ds_insights.export_events_json(events)
    else:
        body = ds_insights.export_events_csv(events)
    return {
        "format": format,
        "count": len(events),
        "contentType": "application/json" if format == "json" else "text/csv",
        "content": body,
    }


@router.get("/compare")
async def insights_compare(today: str | None = None, previous: str | None = None):
    """Today vs previous trading day comparison (real reports only)."""
    return await ds_insights.compare_days(today=today, previous=previous)


@router.post("/telemetry/flush")
async def insights_telemetry_flush():
    """Force-persist the in-memory API telemetry buckets (admin/debug)."""
    written = await api_telemetry.flush_and_reset()
    return {"written": written}