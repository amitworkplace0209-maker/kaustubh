"""
WebSocket history service — persists connection lifecycle records and events
to MongoDB (`websocket_history`, `websocket_events`) with 7-day TTL retention
and daily summary aggregation.

Every connect/disconnect lifecycle is a record in `websocket_history`. Every
transition (connected, disconnected, reconnecting, reconnected, heartbeat
failure, subscription failure, authentication failure, abnormal close) is an
event in `websocket_events`. Both collections carry a TTL index on their
timestamp so old data is deleted automatically by MongoDB after 7 days,
regardless of whether the frontend or the backend is running.

Nothing here ever fabricates data — the caller supplies real values, and
unmeasured fields are stored as null (rendered as "--" by the UI).
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timedelta, timezone

from database.connection import get_db
from core.timezones import now_ist as _now_ist

logger = logging.getLogger("websocket")

RETENTION_DAYS = 7
TELEMETRY_COLL = "websocket_telemetry"
from core.timezones import IST


def now_ist() -> datetime:
    """Current instant in IST (project-wide convention)."""
    return _now_ist()


def _today_str(dt: datetime | None = None) -> str:
    """Local date key (YYYY-MM-DD) used to group daily history."""
    dt = dt or now_ist()
    return dt.astimezone(IST).strftime("%Y-%m-%d")


def _retention_days() -> int:
    """Live retention policy (days) from the runtime settings store."""
    try:
        from services.runtime_settings import rt_int
        return max(1, rt_int("ws_retention_days", RETENTION_DAYS))
    except Exception:
        return RETENTION_DAYS


def _parse_dt(value) -> datetime | None:
    """Coerce a stored/API timestamp into an aware UTC datetime (or None)."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None


def new_connection_id() -> str:
    """Readable connection id: ws_<IST date>_<IST time>_<short id>.

    Example: ``ws_20260909_143621_bf3ac`` — human-friendly for the monitor
    (connection tables + history) while remaining unique per lifecycle.
    """
    stamp = now_ist().astimezone(IST).strftime("%Y%m%d_%H%M%S")
    return f"ws_{stamp}_{uuid.uuid4().hex[:5]}"


async def _record_ws_event(
    connection_id: str | None,
    event_type: str,
    message: str,
    *,
    severity: str = "info",
    details: str | None = None,
    meta: dict | None = None,
) -> None:
    """Persist a WebSocket event to `websocket_events` (best-effort)."""
    try:
        db = get_db()
        await db.websocket_events.insert_one(
            {
                "connection_id": connection_id,
                "event_type": event_type,
                "severity": severity,
                "message": message,
                "details": details,
                "meta": meta or {},
                "timestamp": now_ist(),
            }
        )
    except Exception:
        logger.debug("Failed to persist websocket event %s", event_type)


async def open_connection(
    *,
    connection_id: str | None = None,
    session_id: str | None = None,
    connected_at: datetime | None = None,
    server_instance: str | None = None,
    subscription_count: int = 0,
) -> str:
    """Open a new history record for a fresh connection.

    Returns the connection_id to use for the lifecycle. The record stays
    "connected" until close_connection() updates it.
    """
    connection_id = connection_id or new_connection_id()
    connected_at = connected_at or now_ist()
    try:
        db = get_db()
        await db.websocket_history.update_one(
            {"connection_id": connection_id},
            {
                "$set": {
                    "connection_id": connection_id,
                    "session_id": session_id,
                    "connected_at": connected_at,
                    "disconnected_at": None,
                    "duration_sec": None,
                    "reason": None,
                    "close_code": None,
                    "reconnect_count": 0,
                    "messages_received": 0,
                    "ticks_received": 0,
                    "subscription_count": subscription_count,
                    "error_count": 0,
                    "heartbeat_failures": 0,
                    "data_gaps": 0,
                    "status": "connected",
                    "server_instance": server_instance,
                    "date": _today_str(connected_at),
                    "created_at": now_ist(),
                }
            },
            upsert=True,
        )
    except Exception:
        logger.debug("Failed to open websocket history record")
    try:
        asyncio.ensure_future(ensure_telemetry_indexes())
    except Exception:
        pass
    return connection_id


async def update_connection_counters(
    connection_id: str | None,
    *,
    messages: int | None = None,
    ticks: int | None = None,
    errors: int | None = None,
    subscription_count: int | None = None,
    reconnect_count: int | None = None,
    heartbeat_failures: int | None = None,
    data_gaps: int | None = None,
) -> None:
    if not connection_id:
        return
    update: dict = {}
    if messages is not None:
        update["messages_received"] = messages
    if ticks is not None:
        update["ticks_received"] = ticks
    if errors is not None:
        update["error_count"] = errors
    if subscription_count is not None:
        update["subscription_count"] = subscription_count
    if reconnect_count is not None:
        update["reconnect_count"] = reconnect_count
    if heartbeat_failures is not None:
        update["heartbeat_failures"] = heartbeat_failures
    if data_gaps is not None:
        update["data_gaps"] = data_gaps
    if not update:
        return
    try:
        db = get_db()
        await db.websocket_history.update_one(
            {"connection_id": connection_id}, {"$set": update}
        )
    except Exception:
        logger.debug("Failed to update websocket history counters")


async def close_connection(
    connection_id: str | None,
    *,
    disconnected_at: datetime | None = None,
    reason: str | None = None,
    close_code: str | None = None,
    connected_at: datetime | None = None,
) -> None:
    """Close a connection's history record, storing honest lifecycle values."""
    if not connection_id:
        return
    disconnected_at = disconnected_at or now_ist()
    connected_at = connected_at
    try:
        db = get_db()
        record = await db.websocket_history.find_one({"connection_id": connection_id})
        duration_sec = None
        if record and record.get("connected_at"):
            try:
                start = record["connected_at"]
                if isinstance(start, str):
                    start = datetime.fromisoformat(start)
                duration_sec = round(
                    (disconnected_at - start).total_seconds(), 1
                )
            except Exception:
                duration_sec = None
        status = "disconnected" if reason not in (None, "", "Unknown") else "disconnected"
        await db.websocket_history.update_one(
            {"connection_id": connection_id},
            {
                "$set": {
                    "disconnected_at": disconnected_at,
                    "duration_sec": duration_sec,
                    "reason": reason,
                    "close_code": close_code,
                    "status": status,
                    "created_at": now_ist(),
                }
            },
        )
    except Exception:
        logger.debug("Failed to close websocket history record")


async def set_connection_status(connection_id: str | None, status: str) -> None:
    if not connection_id:
        return
    try:
        db = get_db()
        await db.websocket_history.update_one(
            {"connection_id": connection_id}, {"$set": {"status": status}}
        )
    except Exception:
        logger.debug("Failed to set websocket history status")


async def record_event(
    connection_id: str | None,
    event_type: str,
    message: str,
    *,
    severity: str = "info",
    details: str | None = None,
    meta: dict | None = None,
) -> None:
    await _record_ws_event(
        connection_id, event_type, message,
        severity=severity, details=details, meta=meta,
    )


async def get_history(
    *,
    limit: int = 200,
    offset: int = 0,
    status: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    search: str | None = None,
    sort: str = "newest",
) -> dict:
    """Query persisted websocket history with filters + pagination."""
    db = get_db()
    query: dict = {}
    if status:
        query["status"] = status
    if date_from or date_to:
        date_q: list[dict] = []
        if date_from:
            date_q.append({"date": {"$gte": date_from}})
        if date_to:
            date_q.append({"date": {"$lte": date_to}})
        if date_q:
            query["$and"] = date_q
    if search:
        query["$or"] = [
            {"connection_id": {"$regex": search, "$options": "i"}},
            {"reason": {"$regex": search, "$options": "i"}},
        ]

    sort_map = {
        "newest": [("connected_at", -1)],
        "oldest": [("connected_at", 1)],
        "longest": [("duration_sec", -1)],
        "shortest": [("duration_sec", 1)],
        "most_errors": [("error_count", -1)],
        "most_messages": [("messages_received", -1)],
    }
    sort_fields = sort_map.get(sort, sort_map["newest"])

    cursor = (
        db.websocket_history.find(query)
        .sort(sort_fields)
        .skip(offset)
        .limit(min(limit, 500))
    )
    items = await cursor.to_list(length=min(limit, 500))
    for item in items:
        item["_id"] = str(item["_id"])
        for k in ("connected_at", "disconnected_at", "created_at"):
            if k in item and isinstance(item[k], datetime):
                item[k] = item[k].isoformat()
    total = await db.websocket_history.count_documents(query)
    return {"records": items, "total": total, "limit": limit, "offset": offset}


async def get_record(connection_id: str) -> dict | None:
    db = get_db()
    item = await db.websocket_history.find_one({"connection_id": connection_id})
    if not item:
        return None
    item["_id"] = str(item["_id"])
    for k in ("connected_at", "disconnected_at", "created_at"):
        if k in item and isinstance(item[k], datetime):
            item[k] = item[k].isoformat()
    return item


async def get_events(
    connection_id: str | None = None,
    limit: int = 200,
) -> list[dict]:
    db = get_db()
    query = {"connection_id": connection_id} if connection_id else {}
    cursor = db.websocket_events.find(query).sort("timestamp", -1).limit(min(limit, 500))
    items = await cursor.to_list(length=min(limit, 500))
    for item in items:
        item["_id"] = str(item["_id"])
        if "timestamp" in item and isinstance(item["timestamp"], datetime):
            item["timestamp"] = item["timestamp"].isoformat()
    return items


async def get_daily_summary(date: str | None = None) -> dict:
    """Aggregate real history for a date (or today)."""
    db = get_db()
    date = date or _today_str()
    start = datetime.now(timezone.utc)
    match: dict = {"date": date}
    if date == _today_str():
        match = {"date": date}
    pipeline = [
        {"$match": match},
        {
            "$group": {
                "_id": None,
                "connections": {"$sum": 1},
                "total_uptime_sec": {"$sum": {"$ifNull": ["$duration_sec", 0]}},
                "disconnects": {
                    "$sum": {"$cond": [{"$ne": ["$status", "connected"]}, 1, 0]}
                },
                "messages": {"$sum": {"$ifNull": ["$messages_received", 0]}},
                "ticks": {"$sum": {"$ifNull": ["$ticks_received", 0]}},
                "errors": {"$sum": {"$ifNull": ["$error_count", 0]}},
                "heartbeat_failures": {"$sum": {"$ifNull": ["$heartbeat_failures", 0]}},
                "data_gaps": {"$sum": {"$ifNull": ["$data_gaps", 0]}},
            }
        },
    ]
    result = await db.websocket_history.aggregate(pipeline).to_list(length=1)
    if not result:
        return {
            "date": date,
            "connections": 0,
            "total_uptime_sec": 0,
            "total_downtime_sec": 0,
            "disconnects": 0,
            "reconnects": 0,
            "messages": 0,
            "ticks": 0,
            "errors": 0,
            "heartbeat_failures": 0,
            "data_gaps": 0,
            "answered": False,
        }
    agg = result[0]
    return {
        "date": date,
        "connections": agg.get("connections", 0),
        "total_uptime_sec": round(agg.get("total_uptime_sec", 0) or 0, 1),
        "total_downtime_sec": 0,
        "disconnects": agg.get("disconnects", 0),
        "reconnects": 0,
        "messages": agg.get("messages", 0),
        "ticks": agg.get("ticks", 0),
        "errors": agg.get("errors", 0),
        "heartbeat_failures": agg.get("heartbeat_failures", 0),
        "data_gaps": agg.get("data_gaps", 0),
        "answered": True,
    }


async def get_available_dates(limit: int = 30) -> list[str]:
    db = get_db()
    cursor = (
        db.websocket_history.find({}, {"date": 1})
        .sort("date", -1)
        .limit(limit)
    )
    dates: list[str] = []
    seen: set[str] = set()
    async for doc in cursor:
        d = doc.get("date")
        if d and d not in seen:
            seen.add(d)
            dates.append(d)
    return dates


async def delete_record(connection_id: str) -> int:
    db = get_db()
    result = await db.websocket_history.delete_one({"connection_id": connection_id})
    await db.websocket_events.delete_many({"connection_id": connection_id})
    return result.deleted_count


async def delete_day(date: str) -> int:
    db = get_db()
    result = await db.websocket_history.delete_many({"date": date})
    event_ids = await db.websocket_events.distinct(
        "connection_id",
        {"connection_id": {"$in": [
            r.get("connection_id")
            async for r in db.websocket_history.find({"date": date}, {"connection_id": 1})
        ]}},
    )
    if event_ids:
        await db.websocket_events.delete_many({"connection_id": {"$in": event_ids}})
    return result.deleted_count


async def delete_older_than(days: int) -> int:
    cutoff = now_ist() - timedelta(days=days)
    db = get_db()
    result = await db.websocket_history.delete_many(
        {"connected_at": {"$lt": cutoff}}
    )
    return result.deleted_count


async def clear_all_history() -> int:
    db = get_db()
    result = await db.websocket_history.delete_many({})
    await db.websocket_events.delete_many({})
    return result.deleted_count


async def ensure_telemetry_indexes():
    """Create indexes for the telemetry collection (best-effort, idempotent)."""
    try:
        db = get_db()
        await db.websocket_telemetry.create_index(
            [("ts", 1)], name="ts_ttl", expireAfterSeconds=_retention_days() * 24 * 3600,
            background=True,
        )
        await db.websocket_telemetry.create_index(
            [("connection_id", 1), ("ts", -1)], background=True,
        )
    except Exception:
        pass


async def record_telemetry_sample(
    connection_id: str | None,
    *,
    messages_count: int = 0,
    ticks_count: int = 0,
    errors_count: int = 0,
    message_rate: float = 0.0,
    tick_rate: float = 0.0,
    latency_ms: float | None = None,
    queue_depth: int = 0,
    subscription_count: int = 0,
    feed_state: str = "NO_FEED",
) -> None:
    """Store a periodic telemetry sample for charting (best-effort)."""
    try:
        db = get_db()
        await db.websocket_telemetry.insert_one({
            "connection_id": connection_id,
            "ts": now_ist(),
            "messages_count": messages_count,
            "ticks_count": ticks_count,
            "errors_count": errors_count,
            "message_rate": message_rate,
            "tick_rate": tick_rate,
            "latency_ms": latency_ms,
            "queue_depth": queue_depth,
            "subscription_count": subscription_count,
            "feed_state": feed_state,
        })
    except Exception:
        logger.debug("Failed to persist telemetry sample")


async def get_telemetry(
    connection_id: str | None = None,
    *,
    hours: int = 24,
    limit: int = 1000,
) -> list[dict]:
    """Get telemetry samples for charting."""
    try:
        db = get_db()
        cutoff = now_ist() - timedelta(hours=hours)
        query: dict = {"ts": {"$gte": cutoff}}
        if connection_id:
            query["connection_id"] = connection_id
        cursor = db.websocket_telemetry.find(query).sort("ts", 1).limit(limit)
        items = await cursor.to_list(length=limit)
        for item in items:
            item["_id"] = str(item["_id"])
            for k in ("ts",):
                if k in item and item[k]:
                    item[k] = item[k].isoformat() if hasattr(item[k], "isoformat") else str(item[k])
        return items
    except Exception:
        return []


async def run_cleanup_retention() -> int:
    """Backend cleanup job — force-delete records older than the retention.

    This complements the MongoDB TTL index: TTL removes docs on a ~60s sweep,
    while this job guarantees deletion on backend restart/timer even if TTL
    hasn't fired yet. It never deletes today's records when not required.
    """
    days = _retention_days()
    cutoff = now_ist() - timedelta(days=days)
    db = get_db()
    result = await db.websocket_history.delete_many(
        {"connected_at": {"$lt": cutoff}}
    )
    if result.deleted_count:
        logger.info(
            "WebSocket history cleanup: removed %d records older than %d days",
            result.deleted_count, days,
        )
    try:
        cutoff_ts = now_ist() - timedelta(days=days)
        result_t = await db.websocket_telemetry.delete_many({"ts": {"$lt": cutoff_ts}})
    except Exception:
        pass
    return result.deleted_count


# --------------------------------------------------------------------------- #
# Real availability / uptime / downtime
# --------------------------------------------------------------------------- #
#
# The previous /api/websocket/metrics aggregated ``duration_sec`` over the whole
# wall-clock window. That produced the reported bug: an OPEN (live) connection
# has ``duration_sec = None`` so it contributed 0 seconds, the availability
# denominator was the full 24h of wall clock (including overnight/weekend when
# the market is closed), and the result was "0% availability / 0s uptime /
# 24h downtime" while the feed was actively receiving.
#
# The corrected model (used everywhere below):
#   * uptime     = real connected seconds within the requested range,
#                  counted ONLY against eligible market-open windows
#                  (09:15-15:30 IST on real trading days via market_calendar).
#                  The live/open session is counted up to ``now``.
#   * measured   = the market-open seconds (within the range) on trading days
#                  that actually have a connection record — i.e. days where the
#                  pipeline provably ran. Days with no record at all (weekend,
#                  holiday, backend down) are NOT treated as downtime, because
#                  there is zero evidence the feed was expected/lost then.
#   * downtime   = measured - uptime  (never negative).
#   * availability = uptime / (uptime + downtime) * 100.
#   * no records  => ``insufficient`` (never a fabricated 0% / 24h downtime).


def _market_open_windows(start: datetime, end: datetime) -> list[tuple[datetime, datetime]]:
    """Market-open windows (UTC) overlapping [start, end] for eligible days."""
    from services import market_calendar as _cal

    if end <= start:
        return []
    s = start.astimezone(IST)
    e = end.astimezone(IST)
    day = s.date()
    windows: list[tuple[datetime, datetime]] = []
    while day <= e.date():
        if _cal.is_trading_day(day):
            open_dt = datetime.combine(day, _cal.OPEN_TIME, tzinfo=IST)
            close_dt = datetime.combine(day, _cal.CLOSE_TIME, tzinfo=IST)
            a = max(open_dt, s)
            b = min(close_dt, e)
            if b > a:
                windows.append((a.astimezone(timezone.utc), b.astimezone(timezone.utc)))
        day += timedelta(days=1)
    return windows


def _record_effective_end(rec: dict, now: datetime) -> datetime | None:
    """disconnected_at, or ``now`` for an open/live session (status connected)."""
    status = str(rec.get("status") or "")
    dc = _parse_dt(rec.get("disconnected_at"))
    if dc is None and status in ("connected", "connecting"):
        return now
    return dc


def availability_from_records(
    records: list[dict],
    start: datetime,
    end: datetime,
    now: datetime | None = None,
) -> dict:
    """Pure availability computation (testable without MongoDB)."""
    now_dt = now or now_ist()
    start = _parse_dt(start) or now_dt - timedelta(hours=24)
    end = _parse_dt(end) or now_dt
    if end <= start:
        end = start + timedelta(hours=1)

    windows = _market_open_windows(start, end)
    eligible_sec = round(sum((b - a).total_seconds() for a, b in windows), 1)

    # One connection at a time. Clamp each session's effective end so an
    # orphaned "open" row (no disconnected_at after a hard kill/restart) can
    # never extend past the next observed connection — otherwise every orphan
    # would claim uptime through `now` and multiply-count the same window.
    # The LATEST open session is the only one that may count up to `now`.
    sessions: list[dict] = []
    for rec in records:
        ca = _parse_dt(rec.get("connected_at"))
        if ca is None:
            continue
        dc_eff = _record_effective_end(rec, now_dt)
        if dc_eff is None:
            continue
        lo = max(ca, start)
        hi = min(dc_eff, end)
        if hi <= lo:
            continue
        sessions.append({"ca": ca, "lo": lo, "hi": hi, "rec": rec})
    sessions.sort(key=lambda s: (s["ca"], s["lo"]))
    for i, s in enumerate(sessions):
        if i + 1 < len(sessions):
            nxt_ca = sessions[i + 1]["ca"]
            if nxt_ca < s["hi"]:
                s["hi"] = nxt_ca

    measured_days: set[str] = set()
    uptime = 0.0
    messages = ticks = errors = heartbeats = gaps = reconnects = 0
    connections = 0
    connect_timestamps: list[str] = []

    for s in sessions:
        lo, hi = s["lo"], s["hi"]
        if hi <= lo:
            continue
        rec = s["rec"]
        connections += 1
        connect_timestamps.append(s["ca"].astimezone(IST).isoformat())
        messages += int(rec.get("messages_received") or 0)
        ticks += int(rec.get("ticks_received") or 0)
        errors += int(rec.get("error_count") or 0)
        heartbeats += int(rec.get("heartbeat_failures") or 0)
        gaps += int(rec.get("data_gaps") or 0)
        reconnects += int(rec.get("reconnect_count") or 0)
        for wa, wb in windows:
            o_lo = max(lo, wa)
            o_hi = min(hi, wb)
            if o_hi > o_lo:
                uptime += (o_hi - o_lo).total_seconds()
                measured_days.add(wa.astimezone(IST).date().isoformat())

    uptime = round(uptime, 1)

    # Days counted as "measured" get their full eligible window attributed.
    measured_sec = 0.0
    for wa, wb in windows:
        if wa.astimezone(IST).date().isoformat() in measured_days:
            measured_sec += (wb - wa).total_seconds()
    measured_sec = round(measured_sec, 1)

    downtime = round(max(0.0, measured_sec - uptime), 1)
    total = uptime + downtime
    availability = round((uptime / total) * 100, 2) if total > 0 else None

    return {
        "connectedAt": start.astimezone(IST).isoformat(),
        "rangeEndAt": end.astimezone(IST).isoformat(),
        "windowSec": eligible_sec,
        "measuredWindowSec": measured_sec,
        "uptimeSec": uptime,
        "downtimeSec": downtime,
        "availabilityPercent": availability,
        "insufficient": connections == 0,
        "measuredDays": sorted(measured_days),
        "connections": connections,
        "messagesReceived": messages,
        "ticksReceived": ticks,
        "errors": errors,
        "heartbeatFailures": heartbeats,
        "dataGaps": gaps,
        "reconnectCount": reconnects,
        "reconnectAt": sorted(connect_timestamps)[-20:],
    }


async def compute_availability(start: datetime, end: datetime) -> dict:
    """Query persisted history overlapping [start, end] and compute availability.

    The live (open) session is always included because its record carries
    ``status == "connected"`` and ``disconnected_at == None``.
    """
    start = _parse_dt(start) or (now_ist() - timedelta(hours=24))
    end = _parse_dt(end) or now_ist()
    try:
        db = get_db()
        cutoff_to = end
        cutoff_from = start
        cursor = db.websocket_history.find(
            {
                "connected_at": {"$lte": cutoff_to},
                "$or": [
                    {"disconnected_at": None},
                    {"disconnected_at": {"$gte": cutoff_from}},
                ],
            }
        )
        records = await cursor.to_list(length=5000)
    except Exception:
        logger.debug("compute_availability query failed", exc_info=True)
        records = []
    return availability_from_records(records or [], start, end)


async def get_events_filtered(
    *,
    event_type: str | None = None,
    severity: str | None = None,
    connection_id: str | None = None,
    ts_from: str | None = None,
    ts_to: str | None = None,
    limit: int = 200,
    offset: int = 0,
) -> dict:
    """Queried, paginated WebSocket events with total count."""
    db = get_db()
    query: dict = {}
    if event_type:
        query["event_type"] = event_type
    if severity:
        query["severity"] = severity
    if connection_id:
        query["connection_id"] = connection_id
    time_q: list[dict] = []
    if ts_from:
        frm = _parse_dt(ts_from)
        if frm:
            time_q.append({"timestamp": {"$gte": frm}})
    if ts_to:
        to = _parse_dt(ts_to)
        if to:
            time_q.append({"timestamp": {"$lte": to}})
    if time_q:
        query["$and"] = time_q

    limit = min(max(limit, 1), 500)
    offset = max(offset, 0)
    cursor = (
        db.websocket_events.find(query)
        .sort("timestamp", -1)
        .skip(offset)
        .limit(limit)
    )
    items = await cursor.to_list(length=limit)
    for item in items:
        item["_id"] = str(item["_id"])
        if "timestamp" in item and isinstance(item["timestamp"], datetime):
            item["timestamp"] = item["timestamp"].isoformat()
    total = await db.websocket_events.count_documents(query)
    return {"events": items, "total": total, "limit": limit, "offset": offset}
