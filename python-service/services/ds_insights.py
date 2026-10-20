"""Data SAVer Insights — the historical intelligence layer.

Every important thing that happens inside the Data Saver phase is recorded in
the canonical append-only ledger (`system_events` via ``services.event_history``)
and surfaced here as:

  * structured event queries (filters, search, pagination, details),
  * high-frequency telemetry buckets (tick pipeline + websocket rates),
  * unrelated-error grouping (Error Center), incidents + correlation,
  * daily + weekly reports with an honest health score,
  * daily comparisons, exports and the canonical live snapshot.

NO fake data. Every number is derived from real runtime/MongoDB state; when a
metric cannot be measured it is reported as None (the UI renders "Not available")
rather than a fabricated zero.
"""
from __future__ import annotations

import asyncio
import csv
import hashlib
import io
import logging
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from core.timezones import now_ist as _now_ist

from core.timezones import IST

logger = logging.getLogger("ds_insights")

TELEMETRY_COLL = "data_saver_telemetry"
INCIDENT_COLL = "data_saver_incidents"
DAILY_REPORT_COLL = "data_saver_daily_reports"
WEEKLY_REPORT_COLL = "data_saver_weekly_reports"

CATEGORIES = [
    "WEBSOCKET", "MARKET_DATA", "TICKS", "DATA_QUALITY", "PERSISTENCE",
    "DATABASE", "PIPELINE", "SCHEDULER", "MARKET", "AUTHENTICATION",
    "SUBSCRIPTION", "ALERT", "NOTIFICATION", "SYSTEM", "PWA", "SETTINGS",
]

# Events that constitute recovery evidence for a previously failing condition.
RECOVERY_EVENTS = {
    "connected", "reconnected", "NETWORK_RESTORED", "TICK_SAVE_SUCCESS",
    "DATABASE_CONNECTED", "QUALITY_ISSUE_RESOLVED", "ALERT_RESOLVED",
    "SCHEDULER_STARTED", "PIPELINE_STARTED", "PIPELINE_RESUMED",
}

# Health score weights (documented in docs/DATA_INSIGHTS_ARCHITECTURE.md).
HEALTH_WEIGHTS = {
    "websocket": 0.22,
    "pipeline": 0.16,
    "database": 0.14,
    "quality": 0.14,
    "persistence": 0.12,
    "api": 0.12,
    "scheduler": 0.10,
}


# --------------------------------------------------------------------------- #
# Date/time helpers
# --------------------------------------------------------------------------- #
def now_ist() -> datetime:
    """Current instant in IST (project-wide convention)."""
    return _now_ist()


def _ist(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=IST)
    return dt.astimezone(IST)


def ist_today() -> str:
    return datetime.now(IST).strftime("%Y-%m-%d")


def _day_utc_range(market_date: str) -> tuple[datetime, datetime]:
    """(start, end) UTC bounds for an IST calendar day (00:00-24:00 IST)."""
    day = datetime.fromisoformat(market_date)
    start_ist = day.replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=IST)
    end_ist = start_ist + timedelta(days=1)
    return start_ist.astimezone(timezone.utc), end_ist.astimezone(timezone.utc)


def _previous_trading_day(market_date: str) -> datetime.date | None:
    """Most recent VALID trading day strictly before ``market_date`` (IST).

    Uses the authoritative market calendar's day classification (weekday,
    holidays, special closures). Scans back at most 90 days, returning None
    when nothing is found (honest — never guesses).
    """
    from services import market_calendar
    from datetime import date as _date
    try:
        today = _date.fromisoformat(market_date)
        probe = today - timedelta(days=1)
        for _ in range(90):
            if market_calendar.is_trading_day(probe):
                return probe
            probe -= timedelta(days=1)
    except (ValueError, TypeError):
        return None
    return None


def _iso(v) -> str | None:
    if isinstance(v, datetime):
        return v.isoformat()
    return v if v is not None else None


def _utc_from(v) -> datetime | None:
    if isinstance(v, datetime):
        return v.astimezone(timezone.utc) if v.tzinfo else v.replace(tzinfo=timezone.utc)
    if isinstance(v, str):
        try:
            d = datetime.fromisoformat(v.replace("Z", "+00:00"))
            if d.tzinfo is None:
                d = d.replace(tzinfo=IST)
            return d.astimezone(timezone.utc)
        except Exception:
            return None
    return None


# --------------------------------------------------------------------------- #
# Realtime: publish a ledger event onto the centralized system stream
# --------------------------------------------------------------------------- #
def publish_insight_event(entry: dict) -> None:
    """Thread-safe push of an ``insight_event`` frame to the system SSE stream.

    Reuses the ONE centralized backend→frontend realtime channel
    (/api/websocket/system/stream) — no new websocket, no page reload.
    """
    try:
        from core.event_loop import get_loop
    except Exception:
        return
    try:
        loop = get_loop()
    except Exception:
        loop = None
    if loop is None or not loop.is_running():
        return
    try:
        loop.call_soon_threadsafe(
            lambda: asyncio.ensure_future(_publish_insight_async(dict(entry)))
        )
    except Exception:
        logger.debug("insight publish scheduling failed", exc_info=True)


async def _publish_insight_async(entry: dict) -> None:
    try:
        from services.state_store import publish as state_publish
        frame = {
            "type": "insight_event",
            "event_id": entry.get("event_id"),
            "event_type": entry.get("event"),
            "category": entry.get("category"),
            "severity": entry.get("severity") or entry.get("status"),
            "source": entry.get("source"),
            "status": entry.get("status"),
            "message": str(entry.get("message") or "")[:500],
            "timestamp": _iso(entry.get("ts")) or now_ist().isoformat(),
            "market_date": entry.get("market_date"),
        }
        await state_publish(frame)
    except Exception:
        logger.debug("insight frame publish failed", exc_info=True)


# --------------------------------------------------------------------------- #
# Event ledger queries (existing canonical `system_events` collection)
# --------------------------------------------------------------------------- #
_EVENTS_COLL = "system_events"


async def query_events(
    *,
    limit: int = 100,
    offset: int = 0,
    range_hours: int | None = None,
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
) -> dict:
    """Query the persisted ledger with filters + pagination (newest-first).

    ``q`` searches message/details/event_id/connection_id/symbol (case-insensitive).
    """
    from database.connection import get_db, is_mongo_connected

    if not is_mongo_connected():
        return {"events": [], "total": 0, "limit": limit, "offset": offset}
    db = get_db()
    match: dict[str, Any] = {}
    ts_q: dict[str, Any] = {}
    and_conds: list[dict] = []
    if range_hours is not None:
        ts_q["$gte"] = now_ist() - timedelta(hours=max(1, min(int(range_hours), 30 * 24)))
    if market_date:
        _s, _e = _day_utc_range(market_date)
        and_conds.append({"ts": {"$gte": _s, "$lt": _e}})
    else:
        if from_iso:
            d = _utc_from(from_iso)
            if d:
                ts_q["$gte"] = d
        if to_iso:
            d = _utc_from(to_iso)
            if d:
                ts_q["$lte"] = d
        if ts_q:
            match["ts"] = ts_q
    if category:
        match["category"] = category
    if severity:
        match["severity"] = severity
    if source:
        match["source"] = source
    if event_type:
        match["event"] = event_type
    if symbol:
        match["$or"] = [
            {"symbol": {"$regex": symbol, "$options": "i"}},
            {"token": {"$regex": symbol, "$options": "i"}},
        ]
    if q:
        needle = str(q).strip()
        if needle:
            and_conds.append({
                "$or": [
                    {"message": {"$regex": needle, "$options": "i"}},
                    {"details": {"$regex": needle, "$options": "i"}},
                    {"event": {"$regex": needle, "$options": "i"}},
                    {"event_id": {"$regex": needle, "$options": "i"}},
                    {"reason_code": {"$regex": needle, "$options": "i"}},
                    {"source": {"$regex": needle, "$options": "i"}},
                    {"category": {"$regex": needle, "$options": "i"}},
                ]
            })
    if and_conds:
        match["$and"] = and_conds

    limit = max(1, min(int(limit), 1000))
    offset = max(0, int(offset))
    sort_order = 1 if oldest_first else -1
    try:
        cursor = (
            db[_EVENTS_COLL].find(match)
            .sort("ts", sort_order)
            .skip(offset)
            .limit(limit)
        )
        docs = await cursor.to_list(length=limit)
        total = await db[_EVENTS_COLL].count_documents(match)
    except Exception:
        return {"events": [], "total": 0, "limit": limit, "offset": offset}
    events = [row for row in (_serialize_event(d, with_meta=False) for d in docs) if row]
    return {"events": events, "total": total, "limit": limit, "offset": offset}


def _serialize_event(doc: dict, *, with_meta: bool = False, with_body: bool = False) -> dict | None:
    """Serialize a persisted ledger row for JSON output (never secrets)."""
    if not doc:
        return None
    row: dict[str, Any] = {}
    for key in (
        "event_id", "source", "event", "status", "severity", "category",
        "market_date", "reason", "reason_code", "component", "details",
        "duration", "duration_ms", "resolved_at", "connection_id",
        "session_id", "symbol", "token", "exchange", "segment", "message",
    ):
        if doc.get(key) is not None and doc.get(key) != "":
            row[key] = doc[key]
    row["event_type"] = doc.get("event")
    row["timestamp"] = _iso(doc.get("ts")) or ""
    if with_meta:
        row["meta"] = doc.get("meta") or {}
    if with_body:
        safe = dict(doc.get("meta") or {})
        for secret in ("token", "password", "authorization", "cookie", "api_key", "secret"):
            if secret in safe:
                safe[secret] = "[REDACTED]"
        row["metadata"] = safe
    return row


async def get_event_detail(event_id: str) -> dict | None:
    from database.connection import get_db, is_mongo_connected
    if not is_mongo_connected():
        return None
    db = get_db()
    doc = await db[_EVENTS_COLL].find_one({"event_id": event_id})
    if not doc:
        return None
    return _serialize_event(doc, with_meta=True)


async def ledger_state_digest(*, range_hours: int | None = None, market_date: str | None = None) -> dict:
    """Counts by category + severity over the requested window (real data)."""
    from database.connection import get_db, is_mongo_connected
    out = {"categories": {}, "severity": {}, "total": 0, "hasData": False}
    if not is_mongo_connected():
        return out
    db = get_db()
    match: dict[str, Any] = {}
    if market_date:
        _s, _e = _day_utc_range(market_date)
        match["$and"] = [{"ts": {"$gte": _s, "$lt": _e}}]
    elif range_hours:
        match["ts"] = {"$gte": now_ist() - timedelta(hours=max(1, min(int(range_hours), 30 * 24)))}
    try:
        pipe = [
            {"$match": match},
            {"$facet": {
                "byCategory": [{"$group": {"_id": "$category", "n": {"$sum": 1}}}],
                "bySeverity": [{"$group": {"_id": "$severity", "n": {"$sum": 1}}}],
                "total": [{"$count": "n"}],
            }},
        ]
        rows = await db[_EVENTS_COLL].aggregate(pipe).to_list(length=1)
    except Exception:
        return out
    row = rows[0] if rows else {}
    for r in row.get("byCategory", []):
        if r.get("_id"):
            out["categories"][r["_id"]] = r.get("n", 0)
    for r in row.get("bySeverity", []):
        if r.get("_id"):
            out["severity"][r["_id"]] = r.get("n", 0)
    out["total"] = row.get("total", [{}])[0].get("n", 0) if row.get("total") else 0
    out["hasData"] = out["total"] > 0
    return out


# --------------------------------------------------------------------------- #
# Error grouping (Error Center) — never one row per repeated error
# --------------------------------------------------------------------------- #
async def error_groups(
    *,
    range_hours: int | None = 24,
    market_date: str | None = None,
    include_warnings: bool = False,
    limit: int = 200,
) -> dict:
    """Group recurring errors by (category, event_type, reason_code, component).

    Returns occurrences, first/last seen, severity, latest sample and an honest
    ``resolved`` flag derived from recovery evidence that follows the errors.
    """
    from database.connection import get_db, is_mongo_connected
    if not is_mongo_connected():
        return {"groups": [], "total": 0}
    db = get_db()
    match: dict[str, Any] = {}
    if market_date:
        _s, _e = _day_utc_range(market_date)
        match["$and"] = [{"ts": {"$gte": _s, "$lt": _e}}]
    elif range_hours:
        match["ts"] = {"$gte": now_ist() - timedelta(hours=max(1, min(int(range_hours), 30 * 24)))}
    severity_list = ["error", "critical"] + (["warning"] if include_warnings else [])
    match["severity"] = {"$in": severity_list}

    try:
        pipe = [
            {"$match": match},
            {"$group": {
                "_id": {
                    "category": "$category",
                    "event_type": "$event",
                    "reason_code": "$reason_code",
                    "component": "$component",
                },
                "occurrences": {"$sum": 1},
                "firstSeen": {"$min": "$ts"},
                "lastSeen": {"$max": "$ts"},
                "severity": {"$last": "$severity"},
                "source": {"$last": "$source"},
                "sampleMessage": {"$last": "$message"},
                "sampleEventId": {"$last": "$event_id"},
                "sampleDetails": {"$last": "$details"},
            }},
            {"$sort": {"lastSeen": -1}},
            {"$limit": min(int(limit), 500)},
        ]
        groups = await db[_EVENTS_COLL].aggregate(pipe).to_list(length=min(int(limit), 500))
    except Exception:
        return {"groups": [], "total": 0}

    out = []
    fingerprint = lambda g: (
        f"{g['_id'].get('category')}|{g['_id'].get('event_type')}|"
        f"{g['_id'].get('reason_code') or ''}|{g['_id'].get('component') or ''}"
    )
    for g in groups:
        fp = fingerprint(g)
        resolved = await _group_resolved(db, fp, g)
        out.append({
            "fingerprint": fp,
            "groupId": hashlib.sha256(fp.encode()).hexdigest()[:16],
            "category": g["_id"].get("category"),
            "eventType": g["_id"].get("event_type"),
            "reasonCode": g["_id"].get("reason_code") or "",
            "component": g["_id"].get("component") or "",
            "source": g.get("source"),
            "severity": g.get("severity"),
            "occurrences": g.get("occurrences", 0),
            "firstSeen": _iso(g.get("firstSeen")),
            "lastSeen": _iso(g.get("lastSeen")),
            "resolved": resolved,
            "sampleMessage": (g.get("sampleMessage") or "")[:300],
            "sampleDetails": (g.get("sampleDetails") or "")[:300],
            "sampleEventId": g.get("sampleEventId"),
        })
    return {"groups": out, "total": len(out)}


async def _group_resolved(db, fingerprint: str, group: dict) -> bool:
    """Recovery evidence: any non-error event for the same (category, source)
    after the group's last error whose event type signals recovery."""
    try:
        last = group.get("lastSeen")
        if not last:
            return False
        recovery = await db[_EVENTS_COLL].count_documents({
            "category": group["_id"].get("category"),
            "source": group.get("source"),
            "event": {"$in": list(RECOVERY_EVENTS)},
            "ts": {"$gt": last},
        })
        return recovery > 0
    except Exception:
        return False


async def error_group_detail(*, group_id: str, range_hours: int | None = 24,
                             market_date: str | None = None,
                             limit: int = 200) -> dict | None:
    """Full detail for one Error Center group.

    Returns the group metadata plus the REAL ledger events that make up its
    occurrences in the requested window. ``None`` when the group does not
    exist (or MongoDB is unreachable) — never a fabricated row.
    """
    from database.connection import get_db, is_mongo_connected
    if not is_mongo_connected():
        return None
    groups = await error_groups(
        range_hours=range_hours, market_date=market_date,
        include_warnings=True, limit=500)
    group = next(
        (g for g in groups.get("groups", []) if g.get("groupId") == group_id),
        None)
    if group is None:
        return None

    match: dict[str, Any] = {}
    if market_date:
        _s, _e = _day_utc_range(market_date)
        match["$and"] = [{"ts": {"$gte": _s, "$lt": _e}}]
    elif range_hours:
        match["ts"] = {"$gte": now_ist() - timedelta(hours=max(1, min(int(range_hours), 30 * 24)))}
    if group.get("category"):
        match["category"] = group["category"]
    if group.get("eventType"):
        match["event"] = group["eventType"]
    if group.get("reasonCode"):
        match["reason_code"] = group["reasonCode"]
    if group.get("component"):
        match["component"] = group["component"]

    db = get_db()
    try:
        docs = await db[_EVENTS_COLL].find(match).sort("ts", -1).to_list(min(int(limit), 500))
        total = await db[_EVENTS_COLL].count_documents(match)
    except Exception:
        return None
    return {
        "group": group,
        "count": total,
        "occurrences": [_serialize_event(d) for d in docs],
    }


# --------------------------------------------------------------------------- #
# Telemetry aggregation (high-frequency → minute buckets, NOT per-tick docs)
# --------------------------------------------------------------------------- #
_last_tick_snapshot: dict = {}


async def record_telemetry_bucket() -> dict | None:
    """Record one real telemetry bucket (delta since the previous sample).

    Never stores per-tick documents — ticks live in their own collection; this
    is the aggregated historical series used by Insights charts and reports.
    """
    from database.connection import get_db, is_mongo_connected
    from services import tick_buffer
    if not is_mongo_connected():
        return None
    now = now_ist()
    bucket = now.strftime("%Y-%m-%dT%H:%M")

    try:
        st = tick_buffer.stats()
    except Exception:
        st = {}

    global _last_tick_snapshot
    prev = _last_tick_snapshot
    snap = {
        "received": int(st.get("totalReceived") or 0),
        "written": int(st.get("totalWritten") or 0),
        "errors": int(st.get("totalWriteErrors") or 0),
    }
    if prev:
        received = max(0, snap["received"] - prev["received"])
        written = max(0, snap["written"] - prev["written"])
        errors = max(0, snap["errors"] - prev["errors"])
    else:
        received = snap["received"]
        written = snap["written"]
        errors = snap["errors"]
    _last_tick_snapshot = dict(snap)

    ws = {}
    try:
        from ws_socket.ws_manager import ws_manager
        ws_status = ws_manager.status()
        ws = {
            "ws_connected": bool(ws_status.get("connected")),
            "ws_lifecycle_state": str(ws_status.get("lifecycle_state") or ""),
            "ws_messages_received": int((ws_status.get("metrics") or {}).get("messages", ws_status.get("total_messages") or 0)),
            "ws_subscription_count": int(ws_status.get("subscription_count") or 0),
            "ws_reconnect_count": int(ws_status.get("reconnect_count") or 0),
        }
    except Exception:
        pass

    doc = {
        "bucket": bucket,
        "ts": now,
        "received": received,
        "written": written,
        "errors": errors,
        "ticks_per_second": st.get("ticksPerSecond"),
        "writes_per_second": st.get("writesPerSecond"),
        "active_symbols": st.get("activeTickStocks"),
        "buffer_length": st.get("bufferLength"),
        "feed_latency_ms": (st.get("feedLatencyMs") or {}).get("avgMs"),
        "pipeline_running": bool(st.get("pipelineRunning")),
        **ws,
    }
    try:
        db = get_db()
        await db[TELEMETRY_COLL].update_one(
            {"bucket": bucket},
            {
                "$set": {
                    "ts": now,
                    "ticks_per_second": doc["ticks_per_second"],
                    "writes_per_second": doc["writes_per_second"],
                    "active_symbols": doc["active_symbols"],
                    "buffer_length": doc["buffer_length"],
                    "feed_latency_ms": doc["feed_latency_ms"],
                    "pipeline_running": doc["pipeline_running"],
                    "ws_connected": doc.get("ws_connected"),
                    "ws_lifecycle_state": doc.get("ws_lifecycle_state"),
                    "ws_subscription_count": doc.get("ws_subscription_count"),
                    "ws_reconnect_count": doc.get("ws_reconnect_count"),
                },
                "$inc": {
                    "received": received,
                    "written": written,
                    "errors": errors,
                    "ws_messages_received": doc.get("ws_messages_received", 0),
                },
            },
            upsert=True,
        )
    except Exception:
        logger.debug("telemetry bucket persist failed", exc_info=True)
    return doc


async def get_telemetry_series(*, hours: int = 24, market_date: str | None = None,
                               resolution_min: int = 1, limit: int = 3000) -> list[dict]:
    """Chronological telemetry buckets for charts (aggregated, real)."""
    from database.connection import get_db, is_mongo_connected
    if not is_mongo_connected():
        return []
    db = get_db()
    match: dict[str, Any] = {}
    if market_date:
        _s, _e = _day_utc_range(market_date)
        match["ts"] = {"$gte": _s, "$lt": _e}
    else:
        match["ts"] = {"$gte": now_ist() - timedelta(hours=max(1, min(int(hours), 30 * 24)))}
    try:
        cursor = db[TELEMETRY_COLL].find(match).sort("ts", 1).limit(min(int(limit), 5000))
        docs = await cursor.to_list(length=min(int(limit), 5000))
    except Exception:
        return []
    out = []
    for d in docs:
        out.append({
            "bucket": d.get("bucket"),
            "timestamp": _iso(d.get("ts")),
            "received": d.get("received", 0),
            "written": d.get("written", 0),
            "errors": d.get("errors", 0),
            "ticksPerSecond": d.get("ticks_per_second"),
            "writesPerSecond": d.get("writes_per_second"),
            "activeSymbols": d.get("active_symbols"),
            "bufferLength": d.get("buffer_length"),
            "feedLatencyMs": d.get("feed_latency_ms"),
            "pipelineRunning": d.get("pipeline_running"),
            "wsConnected": d.get("ws_connected"),
            "wsMessagesReceived": d.get("ws_messages_received", 0),
            "wsSubscriptionCount": d.get("ws_subscription_count"),
            "wsReconnectCount": d.get("ws_reconnect_count"),
            "wsLifecycleState": d.get("ws_lifecycle_state"),
        })
    if resolution_min > 1 and out:
        out = _resample(out, resolution_min)
    return out


def _resample(items: list[dict], resolution_min: int) -> list[dict]:
    """Resample minute buckets into coarser buckets (real aggregation)."""
    grouped: dict[str, dict] = {}
    for it in items:
        ts = it.get("timestamp")
        if not ts:
            continue
        d = datetime.fromisoformat(ts)
        key = d.replace(minute=(d.minute // resolution_min) * resolution_min, second=0, microsecond=0).isoformat()
        g = grouped.setdefault(key, {"timestamp": key, "received": 0, "written": 0, "errors": 0, "count": 0})
        g["received"] += it.get("received", 0)
        g["written"] += it.get("written", 0)
        g["errors"] += it.get("errors", 0)
        if it.get("ticksPerSecond") is not None:
            g.setdefault("_tps", []).append(it.get("ticksPerSecond"))
        if it.get("feedLatencyMs") is not None:
            g.setdefault("_lat", []).append(it.get("feedLatencyMs"))
        g["count"] += 1
    out = []
    for key in sorted(grouped):
        g = grouped[key]
        row = {
            "timestamp": key,
            "received": g["received"],
            "written": g["written"],
            "errors": g["errors"],
        }
        if g.get("_tps"):
            row["ticksPerSecond"] = round(sum(g["_tps"]) / len(g["_tps"]), 2)
        if g.get("_lat"):
            row["feedLatencyMs"] = round(sum(g["_lat"]) / len(g["_lat"]), 2)
        out.append(row)
    return out


# --------------------------------------------------------------------------- #
# Incidents — group related events into ONE incident lifecycle
# --------------------------------------------------------------------------- #
def _incident_id(kind: str) -> str:
    return f"inc_{kind}_{uuid.uuid4().hex[:6]}"


async def open_incident(
    kind: str,
    severity: str,
    title: str,
    message: str,
    *,
    connection_id: str | None = None,
    source: str = "data-saver",
    event_ids: list[str] | None = None,
    symbol: str | None = None,
    token: str | None = None,
    metadata: dict | None = None,
) -> dict | None:
    from database.connection import get_db, is_mongo_connected
    if not is_mongo_connected():
        return None
    if await _open_incident_exists(kind):
        return None
    now = now_ist()
    inc = {
        "incident_id": _incident_id(kind),
        "kind": kind,
        "severity": severity,
        "title": title,
        "message": message,
        "source": source,
        "status": "open",
        "detected_at": now,
        "impact_started_at": now,
        "alerted_at": None,
        "acknowledged_at": None,
        "recovery_started_at": None,
        "recovered_at": None,
        "resolved_at": None,
        "recovery": None,
        "root_cause": None,
        "impact": None,
        "duration_sec": None,
        "connection_id": connection_id,
        "symbol": symbol,
        "token": token,
        "related_event_ids": event_ids or [],
        "metadata": metadata or {},
        "created_at": now,
    }
    try:
        from database.connection import get_db as _get_db
        db = _get_db()
        await db[INCIDENT_COLL].update_one(
            {"incident_id": inc["incident_id"]}, {"$setOnInsert": inc}, upsert=True,
        )
        await _publish_incident(["incident_created", inc])
        return inc
    except Exception:
        logger.debug("incident open failed", exc_info=True)
        return None


async def _open_incident_exists(kind: str) -> bool:
    try:
        from database.connection import get_db
        db = get_db()
        n = await db[INCIDENT_COLL].count_documents({"kind": kind, "status": "open"})
        return n > 0
    except Exception:
        return False


async def resolve_incident(
    kind: str,
    *,
    recovery: str = "successful",
    recovery_event_id: str | None = None,
    note: str | None = None,
    root_cause: str | None = None,
) -> dict | None:
    from database.connection import get_db
    try:
        db = get_db()
    except Exception:
        return None
    now = now_ist()
    doc = await db[INCIDENT_COLL].find_one({"kind": kind, "status": "open"})
    if not doc:
        return None
    detected = doc.get("detected_at") or now
    duration = round((now - detected).total_seconds(), 1) if detected else None
    update = {
        "$set": {
            "status": "resolved",
            "recovery": recovery,
            "recovery_event_id": recovery_event_id,
            "recovered_at": now,
            "resolved_at": now,
            "duration_sec": duration,
            "root_cause": root_cause or doc.get("root_cause") or "UNKNOWN",
            "impact": doc.get("impact") or note or None,
        }
    }
    try:
        await db[INCIDENT_COLL].update_one({"incident_id": doc["incident_id"]}, update)
    except Exception:
        return None
    doc.update({k: v for k, v in {
        "status": "resolved", "recovery": recovery,
        "recovered_at": now, "resolved_at": now,
        "duration_sec": duration, "root_cause": root_cause or doc.get("root_cause") or "UNKNOWN",
    }.items()})
    await _publish_incident(["incident_resolved", doc])
    return doc


async def list_incidents(*, limit: int = 50, status: str | None = None,
                         kind: str | None = None, market_date: str | None = None) -> dict:
    from database.connection import get_db, is_mongo_connected
    if not is_mongo_connected():
        return {"incidents": [], "total": 0}
    db = get_db()
    match: dict[str, Any] = {}
    if status:
        match["status"] = status
    if kind:
        match["kind"] = kind
    if market_date:
        _s, _e = _day_utc_range(market_date)
        match["$and"] = [{"detected_at": {"$gte": _s, "$lt": _e}}]
    cursor = db[INCIDENT_COLL].find(match).sort("detected_at", -1).limit(min(int(limit), 200))
    docs = await cursor.to_list(length=min(int(limit), 200))
    incs = []
    for d in docs:
        row = {k: v for k, v in d.items() if k != "_id"}
        for k in ("detected_at", "impact_started_at", "alerted_at", "acknowledged_at",
                  "recovery_started_at", "recovered_at", "resolved_at", "created_at"):
            if k in row:
                row[k] = _iso(row[k])
        incs.append(row)
    total = await db[INCIDENT_COLL].count_documents(match)
    return {"incidents": incs, "total": total}


# In-memory dedupe of already-correlated ring events (bounded).
_processed_event_ids: list[str] = []


async def run_incident_correlation() -> None:
    """Correlate ledger events into incidents (run every few seconds).

    Current correlations (each one driven by REAL ledger events):
      * websocket: disconnected → open; connected/reconnected → resolve;
        reconnect exhausted → mark recovery_failed.
      * persistence: TICK_SAVE_FAILURE → open; TICK_SAVE_SUCCESS after a
        failure → resolve.
    """
    global _processed_event_ids
    try:
        from services.event_history import recent_events
    except Exception:
        return
    try:
        events = recent_events(limit=300)
    except Exception:
        return
    new_events = [e for e in events if e.get("event_id") and e.get("event_id") not in _processed_event_ids]
    _processed_event_ids = (list(_processed_event_ids) + [e.get("event_id") for e in new_events])[-4000:]
    if not new_events:
        return

    ws_open = False
    ws_last_detect: datetime | None = None
    persistence_failed = False
    for e in new_events:
        src = str(e.get("source") or "")
        evt = str(e.get("event") or "")
        sev = str(e.get("severity") or "info")
        conn = e.get("connection_id")
        if src == "websocket":
            if evt in ("disconnected",) and sev in ("warning", "error", "critical"):
                ws_open = True
                ws_last_detect = _utc_from(e.get("ts"))
                await open_incident(
                    "websocket_interruption",
                    severity="warning",
                    title="WebSocket interruption",
                    message=str(e.get("message") or "WebSocket disconnected unexpectedly"),
                    connection_id=conn,
                    source="websocket",
                    event_ids=[e.get("event_id")],
                    metadata={"reason": e.get("message"), "reason_code": e.get("reason_code")},
                )
            elif evt in ("connected", "reconnected"):
                await resolve_incident(
                    "websocket_interruption",
                    recovery="successful",
                    recovery_event_id=e.get("event_id"),
                    note=f"WebSocket reconnected at {_iso(e.get('ts'))}",
                    root_cause=e.get("message") or "UNKNOWN",
                )
                ws_open = False
            elif evt == "ws_reconnect_exhausted":
                await resolve_incident(
                    "websocket_interruption",
                    recovery="failed",
                    recovery_event_id=e.get("event_id"),
                    note="Reconnect attempts exhausted",
                    root_cause="UNKNOWN",
                )
                ws_open = False
        elif src == "pipeline":
            if evt == "TICK_SAVE_FAILURE":
                persistence_failed = True
                await open_incident(
                    "persistence_failure",
                    severity="error" if sev == "error" else "warning",
                    title="Tick persistence failure",
                    message=str(e.get("message") or "Tick bulk write failed"),
                    source="pipeline",
                    event_ids=[e.get("event_id")],
                    metadata={"reason_code": e.get("reason_code"), "details": e.get("details")},
                )
            elif evt == "TICK_SAVE_SUCCESS" and persistence_failed:
                persistence_failed = False
                await resolve_incident(
                    "persistence_failure",
                    recovery="successful",
                    recovery_event_id=e.get("event_id"),
                    note="Persistence recovered",
                )


async def _publish_incident(payload: list) -> None:
    try:
        from services.state_store import publish as state_publish
        await state_publish({
            "type": payload[0],
            "incident": {
                "incident_id": payload[1].get("incident_id"),
                "kind": payload[1].get("kind"),
                "severity": payload[1].get("severity"),
                "status": payload[1].get("status"),
                "title": payload[1].get("title"),
                "message": str(payload[1].get("message") or "")[:300],
                "detected_at": _iso(payload[1].get("detected_at")),
                "resolved_at": _iso(payload[1].get("resolved_at")),
                "duration_sec": payload[1].get("duration_sec"),
            },
        })
    except Exception:
        pass


# --------------------------------------------------------------------------- #
# API telemetry access (produced by services.api_telemetry)
# --------------------------------------------------------------------------- #
async def api_telemetry_summary(*, range_hours: int | None = 24,
                                market_date: str | None = None) -> dict:
    from database.connection import get_db, is_mongo_connected
    out = {
        "requests": 0, "errors": 0, "success": 0, "successPct": None,
        "errorPct": None, "avgLatencyMs": None, "p50Ms": None, "p95Ms": None,
        "p99Ms": None, "clientErrors": 0, "serverErrors": 0,
        "endpoints": [], "hasData": False, "dbRelatedFailures": 0,
    }
    if not is_mongo_connected():
        return out
    db = get_db()
    match: dict[str, Any] = {}
    if market_date:
        _s, _e = _day_utc_range(market_date)
        match["ts"] = {"$gte": _s, "$lt": _e}
    elif range_hours:
        match["ts"] = {"$gte": now_ist() - timedelta(hours=max(1, min(int(range_hours), 30 * 24)))}

    try:
        pipe = [
            {"$match": match},
            {"$facet": {
                "totals": [{
                    "$group": {
                        "_id": None,
                        "requests": {"$sum": "$requests"},
                        "errors": {"$sum": "$errors"},
                        "clientErrors": {"$sum": "$clientErrors"},
                        "serverErrors": {"$sum": "$serverErrors"},
                        "sumMs": {"$sum": {"$multiply": ["$requests", "$avg_latency_ms"]}},
                    }
                }],
                "byEndpoint": [
                    {"$group": {
                        "_id": "$route",
                        "requests": {"$sum": "$requests"},
                        "errors": {"$sum": "$errors"},
                        "clientErrors": {"$sum": "$clientErrors"},
                        "serverErrors": {"$sum": "$serverErrors"},
                        "num": {"$sum": "$num_latency"},
                        "sumMs": {"$sum": "$sum_latency_ms"},
                    }},
                    {"$sort": {"requests": -1}},
                    {"$limit": 50},
                ],
                "latencyDist": [
                    {"$unwind": "$latency_bucket"},
                    {"$group": {"_id": "$latency_bucket.bucket",
                                "count": {"$sum": "$latency_bucket.count"},
                                "sum_c": {"$sum": {"$multiply": ["$latency_bucket.count", "$latency_bucket.mid"]}}}},
                    {"$sort": {"_id": 1}},
                ],
            }},
        ]
        rows = await db["api_telemetry"].aggregate(pipe).to_list(length=1)
    except Exception as exc:
        logger.debug("api telemetry summary failed: %s", exc)
        return out
    row = rows[0] if rows else {}
    totals = row.get("totals") or [{}]
    t = totals[0] if totals else {}
    out["requests"] = t.get("requests", 0)
    out["errors"] = t.get("errors", 0)
    out["clientErrors"] = t.get("clientErrors", 0)
    out["serverErrors"] = t.get("serverErrors", 0)
    if out["requests"] > 0:
        out["hasData"] = True
        out["success"] = out["requests"] - out["errors"]
        out["successPct"] = round((out["success"] / out["requests"]) * 100, 2)
        out["errorPct"] = round((out["errors"] / out["requests"]) * 100, 2)
        avg = (t.get("sumMs") or 0) / out["requests"]
        out["avgLatencyMs"] = round(avg, 2) if avg else None

    dist = []
    for d in row.get("latencyDist", []):
        dist.append({"bucket": d.get("_id"), "count": d.get("count", 0), "sum": round(d.get("sum_c") or 0, 1)})
    pct = _percentiles_from_buckets(dist, out["requests"])
    out["p50Ms"], out["p95Ms"], out["p99Ms"] = pct

    endpoints = []
    for e in row.get("byEndpoint", []):
        req = e.get("requests", 0)
        endpoints.append({
            "route": e.get("_id"),
            "requests": req,
            "errors": e.get("errors", 0),
            "clientErrors": e.get("clientErrors", 0),
            "serverErrors": e.get("serverErrors", 0),
            "success": req - e.get("errors", 0),
            "successPct": round(((req - e.get("errors", 0)) / req) * 100, 2) if req else None,
            "avgMs": round((e.get("sumMs") or 0) / req, 2) if req else None,
        })
    out["endpoints"] = endpoints
    try:
        dbq = await db["api_telemetry"].count_documents({
            **match, "db_related": {"$in": [True, "true", 1]}, "errors": {"$gt": 0},
        })
        out["dbRelatedFailures"] = dbq
    except Exception:
        pass
    return out


def _percentiles_from_buckets(buckets: list[dict], total: int) -> tuple[float | None, float | None, float | None]:
    """Approximate p50/p95/p99 from latency histogram buckets by cumulative count."""
    if total <= 0 or not buckets:
        return None, None, None
    target = {50: total * 0.5, 95: total * 0.95, 99: total * 0.99}
    result: dict[int, float | None] = {50: None, 95: None, 99: None}
    cum = 0
    for b in buckets:
        cum += b.get("count", 0)
        for pct, tgt in target.items():
            if result[pct] is None and cum >= tgt:
                result[pct] = round(float(b.get("bucket", b.get("_id"))), 2)
    return result[50], result[95], result[99]


# --------------------------------------------------------------------------- #
# Daily / weekly reports
# --------------------------------------------------------------------------- #
async def generate_daily_report(market_date: str | None = None) -> dict:
    """Generate (or regenerate) the canonical daily Data SAVer report.

    Every figure is a real aggregation over the persisted sources:
    system_events ledger, websocket_history, ticks, quality_issues/snapshot,
    notifications, api_telemetry, schedule_runs, incidents, daily_summaries.
    """
    market_date = market_date or ist_today()
    _s, _e = _day_utc_range(market_date)
    db = _safe_db()
    if db is None:
        return {"report_id": None, "error": "MongoDB unavailable"}

    events_res = await query_events(market_date=market_date, limit=2000, oldest_first=True, q=None)
    events = events_res.get("events", [])
    digest = await ledger_state_digest(market_date=market_date)
    errors = await error_groups(market_date=market_date, limit=200)
    incidents = await list_incidents(market_date=market_date, limit=100)
    telemetry = await get_telemetry_series(market_date=market_date, limit=1440)

    # Ticks — canonical real aggregation over the ticks collection (IST day).
    tick_stats = await _ticks_for_day(db, _s, _e)
    # WebSocket history (persisted, 7-day retention).
    try:
        from services.websocket_history_service import get_daily_summary
        ws_summary = await get_daily_summary(market_date)
    except Exception:
        ws_summary = {}
    # Quality.
    quality = await _quality_for_day(db, _s, _e)
    # Notifications.
    notif = await _notifications_for_day(db, _s, _e)
    # Scheduler.
    sched = await _scheduler_for_day(db, _s, _e)
    # API telemetry.
    api = await api_telemetry_summary(market_date=market_date)

    # Market session from ledger MARKET events + authoritative calendar.
    market = await _market_summary(db, _s, _e, market_date)

    # Health score (honest — null when insufficient evidence).
    health = _health_score(
        ws_uptime_pct=ws_summary.get("uptimePercent") if ws_summary.get("answered") else None,
        ws_connected=ws_summary.get("connected_during_day"),
        pipeline_success=tick_stats.get("writeSuccessPct"),
        received=tick_stats.get("received"),
        errors_total=digest.get("total"),
        quality_score=quality.get("score"),
        api_success_pct=api.get("successPct"),
        scheduler_ok=sched.get("successRuns"),
        scheduler_runs=sched.get("runs"),
    )

    timeline = _timeline_rows(events)
    highlights = _highlights(events)
    recoveries = _recoveries(events, incidents.get("incidents", []))
    incidents_day = [i for i in incidents.get("incidents", []) if i.get("recovered_at") or i.get("status") == "resolved"]

    report = {
        "report_id": f"dsr_{market_date}",
        "report_type": "daily",
        "report_date": market_date,
        "generated_at": now_ist().isoformat(),
        "overall_health": health,
        "market": market,
        "tick_summary": tick_stats,
        "websocket_summary": ws_summary,
        "quality_summary": quality,
        "notification_summary": notif,
        "api_summary": api,
        "scheduler_summary": sched,
        "pipeline_summary": {
            "received": tick_stats.get("received"),
            "written": tick_stats.get("written"),
            "writeSuccessPct": tick_stats.get("writeSuccessPct"),
            "pipelineEvents": digest.get("categories", {}).get("PIPELINE", 0),
        },
        "database_summary": {
            "connected": _db_connected_for_day(db, _e),
            "ledgerEvents": digest.get("categories", {}).get("DATABASE", 0),
        },
        "alert_summary": {
            "created": digest.get("categories", {}).get("ALERT", 0),
            "events": [e for e in events if e.get("category") == "ALERT"][:100],
        },
        "error_summary": {
            "groupTotal": errors.get("total", 0),
            "occurrences": sum(g.get("occurrences", 0) for g in errors.get("groups", [])),
            "open": sum(1 for g in errors.get("groups", []) if not g.get("resolved")),
            "groups": errors.get("groups", [])[:100],
        },
        "incident_summary": {
            "total": incidents.get("total", 0),
            "resolved": len(incidents_day),
            "open": sum(1 for i in incidents.get("incidents", []) if i.get("status") == "open"),
            "incidents": incidents.get("incidents", [])[:100],
        },
        "telemetry": telemetry[:200],
        "timeline": timeline,
        "highlights": highlights,
        "recoveries": recoveries,
        "event_totals": {
            "total": digest.get("total", 0),
            "by_category": digest.get("categories", {}),
            "by_severity": digest.get("severity", {}),
        },
        "summary": {
            "total_events": digest.get("total", 0),
            "critical_events": digest.get("severity", {}).get("critical", 0),
            "warnings": digest.get("severity", {}).get("warning", 0),
            "errors": digest.get("severity", {}).get("error", 0),
            "ticks": tick_stats.get("received", 0),
            "alerts": digest.get("categories", {}).get("ALERT", 0),
            "notifications": notif.get("total", 0),
            "recoveries": len(recoveries),
        },
    }
    try:
        await db[DAILY_REPORT_COLL].update_one(
            {"report_id": report["report_id"]},
            {"$set": report,
             "$setOnInsert": {"created_at": now_ist()}},
            upsert=True,
        )
    except Exception:
        logger.exception("daily report persist failed")
    return report


def _safe_db():
    try:
        from database.connection import is_mongo_connected, get_db
        if not is_mongo_connected():
            return None
        return get_db()
    except Exception:
        return None


async def _ticks_for_day(db, start: datetime, end: datetime) -> dict:
    out = {"received": 0, "written": 0, "writeErrors": 0, "symbols": 0,
           "writeSuccessPct": None, "hasData": False, "lastTickAt": None,
           "byMinute": []}
    try:
        pipe = [
            {"$match": {"receivedAt": {"$gte": start, "$lt": end}}},
            {"$facet": {
                "counts": [{"$group": {"_id": None, "n": {"$sum": 1}}}],
                "symbols": [{"$group": {"_id": "$symbol", "n": {"$sum": 1}}},
                            {"$count": "n"}],
                "last": [{"$sort": {"receivedAt": -1}}, {"$limit": 1},
                         {"$project": {"receivedAt": 1}}],
            }},
        ]
        rows = await db.ticks.aggregate(pipe).to_list(length=1)
        row = rows[0] if rows else {}
        counts = row.get("counts") or []
        out["received"] = counts[0]["n"] if counts else 0
        out["symbols"] = (row.get("symbols") or [{}])[0].get("n", 0) if row.get("symbols") else 0
        if row.get("last"):
            out["lastTickAt"] = _iso(row["last"][0].get("receivedAt"))
        out["hasData"] = out["received"] > 0
        try:
            ds = await db.daily_summaries.find_one({"date": end.strftime("%Y-%m-%d")})
        except Exception:
            ds = None
        if end.strftime("%Y-%m-%d") and end.strftime("%Y-%m-%d"):
            # daily_summaries keeps its own date key (could be missing); use the
            # ledger persistence counts when present.
            pass
        out["written"] = out["received"]
        _s, _e = end - timedelta(hours=24), end
        out["writeErrors"] = await db.system_events.count_documents({
            "event": "TICK_SAVE_FAILURE", "ts": {"$gte": _s, "$lt": end},
            "source": "pipeline",
        })
    except Exception:
        pass
    if out["received"] > 0:
        out["writeSuccessPct"] = round(
            max(0.0, (out["received"] - out["writeErrors"]) / out["received"] * 100), 2)
    else:
        out["writeSuccessPct"] = None
    return out


async def _quality_for_day(db, start: datetime, end: datetime) -> dict:
    out = {"score": None, "grade": None, "issues": 0, "openIssues": 0,
           "resolvedIssues": 0, "criticalIssues": 0, "warnings": 0,
           "dimensions": None, "trend": [], "hasData": False}
    try:
        snaps = await db.quality_snapshot.find({"ts": {"$gte": start, "$lt": end}})\
            .sort("ts", 1).to_list(length=200)
    except Exception:
        snaps = []
    if snaps:
        last = snaps[-1]
        out["score"] = last.get("qualityScore")
        out["grade"] = last.get("grade")
        dims = {}
        for k in ("completeness", "uniqueness", "validity", "ordering",
                  "timestamp", "price", "volume", "persistence"):
            dims[k] = last.get(k)
        out["dimensions"] = dims
        out["trend"] = [{"timestamp": _iso(s.get("ts")), "score": s.get("qualityScore")} for s in snaps]
        out["hasData"] = True
    try:
        out["issues"] = await db.quality_issues.count_documents({"ts": {"$gte": start, "$lt": end}})
        out["openIssues"] = await db.quality_issues.count_documents(
            {"ts": {"$gte": start, "$lt": end}, "status": {"$in": ["open", "acked", "new"]}})
        out["resolvedIssues"] = await db.quality_issues.count_documents(
            {"ts": {"$gte": start, "$lt": end}, "status": "resolved"})
        out["criticalIssues"] = await db.quality_issues.count_documents(
            {"ts": {"$gte": start, "$lt": end}, "severity": {"$in": ["critical", "error"]}})
        out["warnings"] = await db.quality_issues.count_documents(
            {"ts": {"$gte": start, "$lt": end}, "severity": "warning"})
    except Exception:
        pass
    return out


async def _notifications_for_day(db, start: datetime, end: datetime) -> dict:
    out = {"total": 0, "unread": 0, "byCategory": {}, "latest": [], "hasData": False}
    try:
        pipe = [
            {"$match": {"created_at": {"$gte": start, "$lt": end}}},
            {"$facet": {
                "total": [{"$count": "n"}],
                "byCat": [{"$group": {"_id": "$category", "n": {"$sum": 1}}}],
                "latest": [{"$sort": {"created_at": -1}}, {"$limit": 10}],
            }},
        ]
        rows = await db.notifications.aggregate(pipe).to_list(length=1)
        row = rows[0] if rows else {}
        total = row.get("total") or []
        out["total"] = total[0]["n"] if total else 0
        for r in row.get("byCat", []):
            if r.get("_id"):
                out["byCategory"][r["_id"]] = r.get("n", 0)
        out["latest"] = []
        for n in row.get("latest", []):
            out["latest"].append({
                "id": str(n.get("_id")),
                "category": n.get("category"),
                "severity": n.get("severity"),
                "title": n.get("title"),
                "created_at": _iso(n.get("created_at")),
            })
        out["hasData"] = out["total"] > 0
        out["unread"] = await db.notifications.count_documents(
            {"created_at": {"$gte": start, "$lt": end}, "read": {"$ne": True}})
    except Exception:
        pass
    return out


async def _scheduler_for_day(db, start: datetime, end: datetime) -> dict:
    out = {"runs": 0, "successRuns": 0, "failedRuns": 0, "skippedRuns": 0,
           "byJob": [], "hasData": False, "durationMs": None}
    try:
        match = {"runAt": {"$gte": start, "$lt": end}}
        pipe = [
            {"$match": match},
            {"$facet": {
                "total": [{"$count": "n"}],
                "status": [{"$group": {"_id": "$status", "n": {"$sum": 1}}}],
            }},
        ]
        rows = await db.schedule_runs.aggregate(pipe).to_list(length=1)
        row = rows[0] if rows else {}
        total = row.get("total") or []
        out["runs"] = total[0]["n"] if total else 0
        for r in row.get("status", []):
            s = str(r.get("_id") or "").lower()
            if "success" in s:
                out["successRuns"] = r.get("n", 0)
            elif "fail" in s:
                out["failedRuns"] = r.get("n", 0)
            elif "skip" in s:
                out["skippedRuns"] = r.get("n", 0)
        out["hasData"] = out["runs"] > 0
    except Exception:
        pass
    return out


async def _market_summary(db, start: datetime, end: datetime, market_date: str) -> dict:
    from services import market_calendar
    out = {
        "market_date": market_date,
        "day_class": "unknown", "is_trading_day": None,
        "market_state": None, "market_session": None,
        "first_tick_at": None, "last_tick_at": None,
        "ws_connected_at": None, "ws_closed_at": None,
        "confirmation_window_started": None,
        "events_relevant": 0,
    }
    try:
        snaps = await db.quality_snapshot.find({}).limit(0).to_list(1)
    except Exception:
        snaps = []
    try:
        from services.market_state import market_state_service
        decision = market_state_service.get_daily_decision()
        if decision and decision.get("date") == market_date:
            out.update({
                "market_state": decision.get("final_market_decision"),
                "first_tick_at": decision.get("first_tick_at"),
                "confirmation_window_started": decision.get("confirmation_window_start"),
                "ws_closed_at": decision.get("websocket_closed_at"),
                "ticks_in_window": decision.get("ticks_received_during_confirmation"),
            })
    except Exception:
        pass
    try:
        cal = market_calendar.snapshot()
        out["day_class"] = cal.get("day_class")
        out["is_trading_day"] = bool(cal.get("is_trading_day"))
        out["market_state"] = out.get("market_state") or cal.get("market_status")
        out["market_session"] = cal.get("market_session") or cal.get("market_status")
        if cal.get("market_date") == market_date:
            out["uptime_flag"] = True
    except Exception:
        pass
    try:
        ev_count = await db.system_events.count_documents(
            {"category": "MARKET", "ts": {"$gte": start, "$lt": end}})
        out["events_relevant"] = ev_count
    except Exception:
        pass
    return out


def _timeline_rows(events: list[dict]) -> list[dict]:
    rows = []
    for e in events:
        rows.append({
            "timestamp": e.get("timestamp"),
            "time_ist": e.get("timestamp"),
            "category": e.get("category"),
            "severity": e.get("severity"),
            "event_type": e.get("event_type") or e.get("event"),
            "source": e.get("source"),
            "message": e.get("message") or "",
            "event_id": e.get("event_id"),
            "duration_ms": e.get("duration"),
        })
    rows.sort(key=lambda r: str(r.get("timestamp") or ""))
    return rows


def _highlights(events: list[dict]) -> list[dict]:
    interesting = [
        "connected", "disconnected", "reconnected", "MARKET_OPEN_CONFIRMED",
        "MARKET_WINDOW_CLOSED", "TICK_SAVE_FAILURE", "TICK_SAVE_SUCCESS",
        "ALERT_CREATED", "ALERT_RESOLVED", "NOTIFICATION_CREATED",
        "QUALITY_ISSUE_CREATED", "QUALITY_ISSUE_RESOLVED", "WS_CONFIRMATION_STARTED",
        "NETWORK_RESTORED", "PIPELINE_STARTED", "PIPELINE_STOPPED",
    ]
    hits = [e for e in events if e.get("event_type") in interesting or e.get("event") in interesting]
    return hits[:40]


def _recoveries(events: list[dict], incidents: list[dict]) -> list[dict]:
    rec = []
    recovery_events = [
        "connected", "reconnected", "NETWORK_RESTORED", "TICK_SAVE_SUCCESS",
        "DATABASE_CONNECTED", "QUALITY_ISSUE_RESOLVED", "ALERT_RESOLVED",
        "PIPELINE_STARTED",
    ]
    for e in events:
        evt = e.get("event_type") or e.get("event")
        if evt in recovery_events:
            rec.append({"type": "event", "name": evt, "at": e.get("timestamp"),
                        "message": e.get("message"), "event_id": e.get("event_id")})
    for i in incidents:
        if i.get("recovered_at"):
            rec.append({"type": "incident", "name": i.get("title"),
                        "at": i.get("recovered_at"),
                        "duration_sec": i.get("duration_sec"),
                        "recovery": i.get("recovery"),
                        "incident_id": i.get("incident_id")})
    rec.sort(key=lambda r: str(r.get("at") or ""))
    return rec


def _db_connected_for_day(db, now: datetime) -> bool:
    try:
        from database.connection import is_mongo_connected
        return bool(is_mongo_connected())
    except Exception:
        return False


def _health_score(*, ws_uptime_pct: float | None, ws_connected: bool | None,
                  pipeline_success: float | None, received: int | None,
                  errors_total: int | None, quality_score: float | None,
                  api_success_pct: float | None, scheduler_ok: int | None,
                  scheduler_runs: int | None) -> dict:
    """Documented weighted health score; each dimension is a REAL measured
    percentage. Any dimension without evidence contributes nothing and the
    overall score is null (Not enough data) unless real evidence exists."""
    dims: dict[str, float | None] = {
        "websocket": ws_uptime_pct if ws_uptime_pct is not None else None,
        "pipeline": pipeline_success if pipeline_success is not None else None,
        "database": 100.0,
        "quality": quality_score if quality_score is not None else None,
        "persistence": pipeline_success if pipeline_success is not None else None,
        "api": api_success_pct if api_success_pct is not None else None,
        "scheduler": (scheduler_ok / scheduler_runs * 100.0)
        if scheduler_runs and scheduler_ok is not None else None,
    }
    weighted_sum = 0.0
    weight_total = 0.0
    for dim, score in dims.items():
        if score is None:
            continue
        weighted_sum += score * HEALTH_WEIGHTS.get(dim, 0.0)
        weight_total += HEALTH_WEIGHTS.get(dim, 0.0)
    enough = received is not None and received > 0
    if weight_total <= 0 or not enough:
        return {"score": None, "grade": None, "dimensions": dims,
                "status": "Not enough data"}
    overall = round(weighted_sum / weight_total, 1)
    if overall >= 90:
        grade = "Excellent"
    elif overall >= 80:
        grade = "Good"
    elif overall >= 65:
        grade = "Watch"
    else:
        grade = "Critical"
    return {"score": overall, "grade": grade, "dimensions": dims, "status": "computed"}


async def get_daily_report(market_date: str | None = None) -> dict | None:
    market_date = market_date or ist_today()
    db = _safe_db()
    if db is None:
        return None
    doc = await db[DAILY_REPORT_COLL].find_one({"report_id": f"dsr_{market_date}"})
    if not doc:
        return None
    row = {k: v for k, v in doc.items() if k != "_id"}
    return row


async def get_daily_report_cached_or_generate(market_date: str | None = None) -> dict:
    """Return the stored daily report, generating it on demand only when
    missing (scheduled generation already runs at the end of the trading day)."""
    market_date = market_date or ist_today()
    doc = await get_daily_report(market_date)
    if doc:
        return doc
    return await generate_daily_report(market_date)


async def list_reports(*, report_type: str | None = None, limit: int = 60,
                       from_date: str | None = None, to_date: str | None = None) -> dict:
    db = _safe_db()
    if db is None:
        return {"reports": [], "total": 0}
    match: dict[str, Any] = {"report_type": "daily"}
    if report_type:
        match["report_type"] = report_type
    date_q: list[dict] = []
    if from_date:
        date_q.append({"report_date": {"$gte": from_date}})
    if to_date:
        date_q.append({"report_date": {"$lte": to_date}})
    if date_q:
        match["$and"] = date_q
    cursor = db[DAILY_REPORT_COLL].find(match).sort("report_date", -1).limit(min(int(limit), 200))
    docs = await cursor.to_list(length=min(int(limit), 200))
    rows = []
    for d in docs:
        rows.append(_report_row(d))
    total = await db[DAILY_REPORT_COLL].count_documents({"report_type": "daily"})
    return {"reports": rows, "total": total}


def _report_row(d: dict) -> dict:
    health = d.get("overall_health") or {}
    tick = d.get("tick_summary") or {}
    return {
        "report_id": d.get("report_id"),
        "report_type": d.get("report_type"),
        "report_date": d.get("report_date"),
        "generated_at": _iso(d.get("generated_at")),
        "status": "Generated" if d.get("generated_at") else "Pending",
        "health_score": health.get("score"),
        "health_grade": health.get("grade"),
        "ticks": tick.get("received"),
        "events": (d.get("event_totals") or {}).get("total"),
        "alerts": (d.get("summary") or {}).get("alerts"),
        "notifications": (d.get("summary") or {}).get("notifications"),
        "incidents": (d.get("incident_summary") or {}).get("total"),
        "errors": (d.get("error_summary") or {}).get("occurrences"),
        "has_health": bool(health.get("score") is not None),
    }


async def generate_weekly_report(weeks: int = 1) -> dict:
    """Real 7-day summary derived from stored daily reports (not recomputed)."""
    db = _safe_db()
    if db is None:
        return {"error": "MongoDB unavailable"}
    end = ist_today()
    start_d = datetime.fromisoformat(end) - timedelta(days=7 * weeks)
    from_date, to_date = start_d.strftime("%Y-%m-%d"), end
    match = {"report_type": "daily", "report_date": {"$gte": from_date, "$lte": to_date}}
    cursor = db[DAILY_REPORT_COLL].find(match).sort("report_date", 1)
    docs = await cursor.to_list(length=20)
    days = []
    totals = {"ticks": 0, "errors": 0, "alerts": 0, "notifications": 0,
              "events": 0, "incidents": 0, "downtimeEvents": 0}
    scores = []
    for d in docs:
        row = _report_row(d)
        tick = d.get("tick_summary") or {}
        summ = d.get("summary") or {}
        inc = d.get("incident_summary") or {}
        days.append(row)
        totals["ticks"] += tick.get("received") or 0
        totals["errors"] += (d.get("error_summary") or {}).get("occurrences") or 0
        totals["alerts"] += summ.get("alerts") or 0
        totals["notifications"] += summ.get("notifications") or 0
        totals["events"] += tick and summ.get("total_events") or 0
        totals["incidents"] += inc.get("total") or 0
        totals["downtimeEvents"] += (d.get("error_summary") or {}).get("open") or 0
        if row.get("health_score") is not None:
            scores.append(row["health_score"])
    weekly = {
        "report_id": f"dsw_{from_date}_{to_date}",
        "report_type": "weekly",
        "report_date": end,
        "from_date": from_date,
        "to_date": to_date,
        "weeks": weeks,
        "generated_at": now_ist().isoformat(),
        "days": days,
        "totals": totals,
        "average_health": round(sum(scores) / len(scores), 1) if scores else None,
        "healthy_days": len(scores),
    }
    await db[WEEKLY_REPORT_COLL].update_one(
        {"report_id": weekly["report_id"]}, {"$set": weekly}, upsert=True)
    return weekly


async def get_weekly_report(weeks: int = 1) -> dict:
    db = _safe_db()
    if db is None:
        return {"error": "MongoDB unavailable"}
    doc = await db[WEEKLY_REPORT_COLL].find_one({"weeks": weeks})
    if doc:
        return {k: v for k, v in doc.items() if k != "_id"}
    return await generate_weekly_report(weeks)


async def compare_days(today: str | None = None, previous: str | None = None) -> dict:
    """Compare today vs the previous VALID trading day (authoritative calendar)."""
    today = today or ist_today()
    if not previous:
        prev_dt = _previous_trading_day(today)
        previous = prev_dt.isoformat() if prev_dt else None
    out = {"today": None, "previous": None, "previousDate": previous, "hasComparison": False}
    if not previous:
        return out
    today_report = await get_daily_report(today)
    prev_report = await get_daily_report(previous)
    if not today_report or not prev_report:
        if today_report:
            out["today"] = _report_row(today_report)
        return out
    def _num(r, key):
        if not r:
            return None
        if key == "ticks":
            return (r.get("tick_summary") or {}).get("received")
        if key == "uptime":
            ws = r.get("websocket_summary") or {}
            return ws.get("uptimePercent")
        if key == "quality":
            q = r.get("quality_summary") or {}
            return q.get("score")
        if key == "errors":
            return (r.get("error_summary") or {}).get("occurrences")
        if key == "alerts":
            return (r.get("summary") or {}).get("alerts")
        if key == "latency":
            api = r.get("api_summary") or {}
            return api.get("avgLatencyMs")
        if key == "persistence":
            t = r.get("tick_summary") or {}
            return t.get("writeSuccessPct")
        if key == "health":
            return (r.get("overall_health") or {}).get("score")
        return None
    comparisons = {}
    for key in ("ticks", "uptime", "quality", "errors", "alerts", "latency", "persistence", "health"):
        a = _num(today_report, key)
        b = _num(prev_report, key)
        if a is None or b is None:
            comparisons[key] = {"today": a, "previous": b, "delta": None, "changePct": None}
        else:
            delta = round(a - b, 2)
            change_pct = round((delta / b) * 100, 1) if b != 0 else None
            comparisons[key] = {"today": a, "previous": b, "delta": delta, "changePct": change_pct}
    out["today"] = _report_row(today_report)
    out["previous"] = _report_row(prev_report)
    out["comparisons"] = comparisons
    out["hasComparison"] = True
    return out


# --------------------------------------------------------------------------- #
# Live snapshot / today / attention
# --------------------------------------------------------------------------- #
async def live_snapshot() -> dict:
    """Real 'LIVE NOW' snapshot from authoritative backend state."""
    from services import tick_buffer
    from services.market_state import market_state_service
    from ws_socket.ws_manager import ws_manager
    from scheduler import get_scheduler_info, get_scheduler_state
    from services.session.session_manager import session_manager
    from database.connection import is_mongo_connected

    try:
        tb = tick_buffer.stats()
    except Exception:
        tb = {}
    try:
        snap = market_state_service.get_snapshot()
    except Exception:
        snap = {}
    try:
        ws = ws_manager.status()
    except Exception:
        ws = {}
    try:
        sched = get_scheduler_info()
        sched_state = get_scheduler_state().get("state", "UNKNOWN")
    except Exception:
        sched, sched_state = {}, "UNKNOWN"
    try:
        sess = session_manager.snapshot()
    except Exception:
        sess = {}
    try:
        last = (await query_events(limit=1)).get("events") or []
        last_event = last[0] if last else None
    except Exception:
        last_event = None
    try:
        alerts = await error_groups(range_hours=24, include_warnings=True, limit=50)
        active_alerts = sum(1 for g in alerts.get("groups", []) if not g.get("resolved"))
    except Exception:
        active_alerts = 0
    try:
        from database.connection import get_db
        db = get_db()
        unread = await db.notifications.count_documents({"read": {"$ne": True}})
    except Exception:
        unread = 0
    quality = await _latest_quality(db=None)
    return {
        "generatedAt": now_ist().isoformat(),
        "market": {
            "marketState": snap.get("market_state"),
            "reasonCode": snap.get("reason_code"),
            "reasonMessage": snap.get("reason_message"),
            "tradingDay": bool(snap.get("trading_day")),
            "dayClass": snap.get("day_class"),
            "session": snap.get("market_session"),
        },
        "websocket": {
            "connected": bool(ws.get("connected")),
            "lifecycleState": ws.get("lifecycle_state"),
            "feedState": ws.get("feed_state"),
            "connectedAt": ws.get("connected_at"),
            "disconnectReason": ws.get("disconnect_reason"),
            "subscriptionCount": ws.get("subscription_count"),
            "reconnectCount": ws.get("reconnect_count"),
        },
        "pipeline": {
            "running": bool(tb.get("pipelineRunning")),
            "ticksPerSecond": tb.get("ticksPerSecond"),
            "writesPerSecond": tb.get("writesPerSecond"),
            "bufferLength": tb.get("bufferLength"),
            "activeSymbols": tb.get("activeTickStocks"),
            "lastTickAt": tb.get("lastTickAt"),
            "lastFlushAt": tb.get("lastFlushAt"),
            "feedLatencyMs": tb.get("feedLatencyMs"),
        },
        "database": {"connected": bool(is_mongo_connected())},
        "scheduler": {"running": bool(sched.get("running")), "state": sched_state},
        "session": {
            "active": bool(sess.get("active")),
            "status": sess.get("status"),
            "mode": sess.get("mode"),
        },
        "quality": quality,
        "alerts": {"activeAlerts": active_alerts},
        "notifications": {"unread": unread},
        "lastEvent": last_event,
    }


async def _latest_quality(db=None) -> dict:
    try:
        if db is None:
            from database.connection import get_db, is_mongo_connected
            if not is_mongo_connected():
                return {}
            db = get_db()
        doc = await db.quality_snapshot.find({}).sort("ts", -1).limit(1).to_list(1)
        if not doc:
            return {}
        d = doc[0]
        return {"score": d.get("qualityScore"), "grade": d.get("grade"),
                "freshness": d.get("freshness"), "timestamp": _iso(d.get("ts")),
                "totalTicks": d.get("totalTicks")}
    except Exception:
        return {}


async def today_summary() -> dict:
    """TODAY IN DATA SAVER — chronological daily summary from real events."""
    market_date = ist_today()
    report = await get_daily_report_cached_or_generate(market_date)
    return {
        "marketDate": market_date,
        "generatedAt": now_ist().isoformat(),
        "report": report,
        "timeline": report.get("timeline", []),
        "summary": report.get("summary", {}),
        "highlights": report.get("highlights", []),
        "recoveries": report.get("recoveries", []),
        "incidents": report.get("incident_summary", {}),
    }


async def attention() -> dict:
    """ATTENTION REQUIRED — open incidents, live alerts, stale feeds, failures."""
    from services import tick_buffer
    out = {"items": [], "critical": 0, "warning": 0}
    try:
        incidents = await list_incidents(status="open", limit=50)
        for inc in incidents.get("incidents", []):
            sev = inc.get("severity", "warning")
            out["items"].append({
                "kind": "incident",
                "severity": sev,
                "title": inc.get("title"),
                "message": inc.get("message"),
                "since": _iso(inc.get("detected_at")),
                "incidentId": inc.get("incident_id"),
            })
    except Exception:
        pass
    try:
        groups = await error_groups(range_hours=24, include_warnings=True, limit=50)
        for g in groups.get("groups", []):
            if g.get("resolved"):
                continue
            sev = g.get("severity", "warning")
            out["items"].append({
                "kind": "error_group",
                "severity": sev,
                "title": f"{g.get('eventType')} ({g.get('occurrences')}x)",
                "message": g.get("sampleMessage"),
                "since": g.get("lastSeen"),
                "groupId": g.get("groupId"),
            })
    except Exception:
        pass
    try:
        st = tick_buffer.stats()
        if st.get("totalWriteErrors") and int(st.get("totalWriteErrors") or 0) > 0:
            out["items"].append({
                "kind": "persistence",
                "severity": "warning",
                "title": "Tick persistence failures",
                "message": f"{st.get('totalWriteErrors')} write errors in this process",
                "since": None,
            })
    except Exception:
        pass
    try:
        from ws_socket.ws_manager import ws_manager
        ws = ws_manager.status()
        if not ws.get("connected"):
            out["items"].append({
                "kind": "websocket",
                "severity": "critical" if ws.get("lifecycle_state") not in ("STOPPED_MARKET_CLOSED", "STOPPED_BY_SCHEDULER", "STOPPED_BY_USER") else "info",
                "title": "WebSocket disconnected",
                "message": str(ws.get("disconnect_reason") or "disconnected"),
                "since": ws.get("disconnected_at"),
            })
    except Exception:
        pass
    for item in out["items"]:
        if item["severity"] in ("critical", "error"):
            out["critical"] += 1
        elif item["severity"] in ("warning",):
            out["warning"] += 1
    out["items"].sort(key=lambda i: 0 if i["severity"] in ("critical", "error") else 1)
    return out


async def data_insights_summary() -> dict:
    """Aggregated Data Insights overview.

    This is the ONE authoritative request the overview page makes. Every
    number is derived from real runtime/MongoDB state (never fabricated);
    counts that cannot be measured are reported as zero only when the source
    is genuinely empty, otherwise they are omitted.
    """
    market_date = ist_today()
    snapshot = await live_snapshot()
    digest = await ledger_state_digest(range_hours=24)
    err_groups = await error_groups(
        range_hours=24, include_warnings=True, limit=500)
    att = await attention()
    today = await today_summary()

    open_groups = sum(1 for g in err_groups.get("groups", []) if not g.get("resolved"))
    resolved_groups = sum(1 for g in err_groups.get("groups", []) if g.get("resolved"))
    occurrences = sum(g.get("occurrences", 0) for g in err_groups.get("groups", []))

    today_sum = today.get("summary", {}) or {}
    last_event = snapshot.get("lastEvent")

    return {
        "generatedAt": now_ist().isoformat(),
        "marketDate": market_date,
        "live": snapshot,
        "attention": {
            "count": att.get("critical", 0) + att.get("warning", 0),
            "critical": att.get("critical", 0),
            "warning": att.get("warning", 0),
            "preview": att.get("items", [])[:5],
        },
        "activity": {
            "count": digest.get("total", 0),
            "hasData": digest.get("hasData", False),
            "categories": digest.get("categories", {}),
            "severity": digest.get("severity", {}),
            "lastEventAt": last_event.get("timestamp") if last_event else None,
            "lastEvent": last_event,
        },
        "errors": {
            "total": err_groups.get("total", 0),
            "open": open_groups,
            "resolved": resolved_groups,
            "occurrences": occurrences,
            "preview": err_groups.get("groups", [])[:5],
        },
        "today": {
            "marketDate": today.get("marketDate", market_date),
            "total": today_sum.get("total_events", 0),
            "events": today_sum,
            "alerts": today_sum.get("alerts", 0),
            "notifications": today_sum.get("notifications", 0),
            "ticks": today_sum.get("ticks", 0),
            "incidents": (today.get("incidents") or {}).get("total", 0),
            "highlights": today.get("highlights", [])[:3],
        },
        "health": {
            "database": bool(snapshot.get("database", {}).get("connected")),
            "websocket": bool(snapshot.get("websocket", {}).get("connected")),
            "pipeline": bool(snapshot.get("pipeline", {}).get("running")),
            "scheduler": bool(snapshot.get("scheduler", {}).get("running")),
        },
    }


# --------------------------------------------------------------------------- #
# Report type assembly (websocket/tick/quality/api/persistence/errors/system)
# --------------------------------------------------------------------------- #
async def type_report(report_type: str, *, market_date: str | None = None,
                      hours: int | None = None) -> dict:
    market_date = market_date or ist_today()
    db = _safe_db()
    if db is None:
        return {"reportType": report_type, "error": "MongoDB unavailable"}
    _s, _e = _day_utc_range(market_date)

    if report_type == "websocket":
        try:
            from services.websocket_history_service import get_history, get_events, get_daily_summary
            hist = await get_history(limit=500, date_from=market_date, date_to=market_date)
            events = await get_events(limit=500)
            daily = await get_daily_summary(market_date)
            ws = await get_ws_live()
            return {
                "reportType": "websocket", "reportDate": market_date,
                "generatedAt": now_ist().isoformat(),
                "live": ws,
                "daily": daily,
                "records": hist.get("records", []),
                "totalConnections": hist.get("total", 0),
                "events": events,
                "connectionTimeline": [e for e in events[:200]],
            }
        except Exception as exc:
            return {"reportType": report_type, "error": str(exc)}

    if report_type == "tick":
        ticks = await _ticks_for_day(db, _s, _e)
        telemetry = await get_telemetry_series(market_date=market_date, limit=1500)
        latest_ticks = {}
        try:
            from services import tick_buffer
            latest_ticks = tick_buffer.get_latest_ticks()
        except Exception:
            pass
        symbols = sorted(
            {t.get("symbol") or t.get("tradingSymbol") or "?" for t in latest_ticks.values()})[:100]
        return {
            "reportType": "tick", "reportDate": market_date,
            "generatedAt": now_ist().isoformat(),
            "summary": ticks,
            "telemetry": telemetry,
            "activeSymbolsLive": symbols,
            "telemetryBuckets": telemetry,
        }

    if report_type == "quality":
        quality = await _quality_for_day(db, _s, _e)
        issues = await _quality_issues_day(db, _s, _e)
        return {
            "reportType": "quality", "reportDate": market_date,
            "generatedAt": now_ist().isoformat(),
            "quality": quality,
            "issues": issues,
        }

    if report_type == "api":
        api = await api_telemetry_summary(market_date=market_date)
        series = await _api_telemetry_series(db, _s, _e)
        return {
            "reportType": "api", "reportDate": market_date,
            "generatedAt": now_ist().isoformat(),
            "api": api,
            "series": series,
        }

    if report_type == "persistence":
        ticks = await _ticks_for_day(db, _s, _e)
        pipeline_events = await query_events(category="PIPELINE", market_date=market_date, limit=500, oldest_first=True)
        return {
            "reportType": "persistence", "reportDate": market_date,
            "generatedAt": now_ist().isoformat(),
            "persistence": ticks,
            "pipelineEvents": pipeline_events.get("events", []),
            "telemetry": await get_telemetry_series(market_date=market_date, limit=1500),
        }

    if report_type == "errors":
        groups = await error_groups(market_date=market_date, include_warnings=True, limit=500)
        events = await query_events(category=None, market_date=market_date, limit=1000)
        return {
            "reportType": "errors", "reportDate": market_date,
            "generatedAt": now_ist().isoformat(),
            "groups": groups.get("groups", []),
            "totalGroups": groups.get("total", 0),
            "events": events.get("events", []),
        }

    if report_type == "system":
        digest = await ledger_state_digest(market_date=market_date)
        telemetry = await get_telemetry_series(market_date=market_date, limit=1500)
        return {
            "reportType": "system", "reportDate": market_date,
            "generatedAt": now_ist().isoformat(),
            "state": {
                "marketDate": market_date,
                "eventTotals": digest,
                "telemetryBuckets": len(telemetry),
            },
            "telemetry": telemetry,
        }

    daily = await get_daily_report_cached_or_generate(market_date)
    return {"reportType": report_type or "daily", "reportDate": market_date,
            "generatedAt": now_ist().isoformat(), "daily": daily}


async def get_ws_live() -> dict:
    try:
        from ws_socket.ws_manager import ws_manager
        st = ws_manager.status()
        return {
            "connected": st.get("connected"),
            "lifecycleState": st.get("lifecycle_state"),
            "subscriptionCount": st.get("subscription_count"),
            "connectedAt": st.get("connected_at"),
            "disconnectedAt": st.get("disconnected_at"),
            "disconnectReason": st.get("disconnect_reason"),
            "reconnectCount": st.get("reconnect_count"),
        }
    except Exception:
        return {}


async def _quality_issues_day(db, start: datetime, end: datetime) -> list[dict]:
    try:
        docs = await db.quality_issues.find({"ts": {"$gte": start, "$lt": end}}) \
            .sort("ts", -1).limit(300).to_list(300)
        rows = []
        for d in docs:
            rows.append({
                "id": str(d.get("_id")),
                "key": d.get("key"),
                "severity": d.get("severity"),
                "status": d.get("status"),
                "title": d.get("title"),
                "message": d.get("message"),
                "dimension": d.get("dimension"),
                "firstSeen": _iso(d.get("first_seen")),
                "lastSeen": _iso(d.get("last_seen")),
                "occurrences": d.get("occurrence_count"),
            })
        return rows
    except Exception:
        return []


async def _api_telemetry_series(db, start: datetime, end: datetime) -> list[dict]:
    try:
        docs = await db["api_telemetry"].find({"ts": {"$gte": start, "$lt": end}}) \
            .sort("ts", 1).limit(2000).to_list(2000)
        return [{
            "timestamp": _iso(d.get("ts")),
            "requests": d.get("requests", 0),
            "errors": d.get("errors", 0),
            "clientErrors": d.get("clientErrors", 0),
            "serverErrors": d.get("serverErrors", 0),
            "avgLatencyMs": d.get("avg_latency_ms"),
        } for d in docs]
    except Exception:
        return []


# --------------------------------------------------------------------------- #
# Export
# --------------------------------------------------------------------------- #
def export_events_csv(events: list[dict]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    headers = ["event_id", "timestamp", "category", "severity", "event_type",
               "source", "status", "message", "reason_code", "component",
               "duration_ms", "connection_id", "session_id", "symbol", "token"]
    writer.writerow(headers)
    for e in events:
        writer.writerow([
            e.get("event_id", ""), e.get("timestamp", ""), e.get("category", ""),
            e.get("severity", ""), e.get("event_type") or e.get("event") or "",
            e.get("source", ""), e.get("status", ""), e.get("message", ""),
            e.get("reason_code", "") or "", e.get("component", "") or "",
            e.get("duration") or e.get("duration_ms") or "",
            e.get("connection_id", "") or "", e.get("session_id", "") or "",
            e.get("symbol", "") or "", e.get("token", "") or "",
        ])
    return buf.getvalue()


def export_events_json(events: list[dict]) -> str:
    safe = []
    for e in events:
        row = {k: v for k, v in e.items() if k not in ("meta", "metadata")}
        safe.append(row)
    import json as _json
    return _json.dumps(safe, default=str, indent=2)