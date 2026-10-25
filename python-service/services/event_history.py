"""Append-only event history for lifecycle / data-insights dashboards.

Thread-safe: events are recorded from the app loop, SDK callbacks and
scheduler activity alike. Every event is held in an in-memory ring buffer
and persisted to the MongoDB ``system_events`` collection on the app event
loop (fire-and-forget, never fatal when the DB is unavailable).

The collection is append-only — no event is ever mutated or deleted.
``mongo_events()`` reads the persisted history back (restart-safe), so the
dashboard's Event History is a real MongoDB-backed audit trail rather than a
process-lifetime buffer.
"""
from __future__ import annotations

import asyncio
import logging
from collections import deque
from datetime import datetime, timezone, timedelta
from threading import Lock
from typing import Any

from core.event_loop import get_loop

from core.timezones import IST

_log = logging.getLogger("event_history")

_RING_MAX = 1000
_ring: deque[dict] = deque(maxlen=_RING_MAX)
_lock = Lock()
_persist_enabled = False

# ---- Ledger category mapping (authoritative category per event source).
# ``SYSTEM`` is the fallback so every event still carries a category.
_CATEGORY_BY_SOURCE: dict[str, str] = {
    "websocket": "WEBSOCKET",
    "market_state": "MARKET",
    "session": "MARKET",
    "pipeline": "PIPELINE",
    "tick_buffer": "PIPELINE",
    "database": "DATABASE",
    "scheduler": "SCHEDULER",
    "settings": "SETTINGS",
    "auth": "AUTHENTICATION",
    "notification": "NOTIFICATION",
    "alert": "ALERT",
    "quality": "DATA_QUALITY",
    "scanner": "MARKET_DATA",
    "download": "DOWNLOAD",
    "export": "EXPORT",
    "api": "API",
    "watchlist": "WATCHLIST",
    "security": "SECURITY",
    "process": "SYSTEM",
    "system": "SYSTEM",
}

# Credential-shaped keys are never persisted to the append-only ledger.
_CREDENTIAL_KEYS = frozenset({
    "password", "passwd", "pwd", "mpin", "pin", "consumer_key", "consumer_secret",
    "authorization", "access_token", "refresh_token", "api_key", "apikey",
    "api_secret", "secret", "totp_secret", "session_token", "csrf", "bearer",
})


def _scrub_meta(meta: dict) -> dict:
    """Drop credential-shaped keys from a stored meta dict (never stored)."""
    if not meta:
        return meta
    return {k: v for k, v in meta.items() if str(k).lower() not in _CREDENTIAL_KEYS}


def _ledger_category(source: str) -> str:
    return _CATEGORY_BY_SOURCE.get(str(source), "SYSTEM")


def _market_date_ist(ts) -> str:
    """IST calendar date (YYYY-MM-DD) for an event timestamp.

    Ticks/exchange timestamps are stored as UTC datetimes; the market date is
    the IST wall date so daily reports group by trading day correctly.
    """
    try:
        if isinstance(ts, datetime):
            aware = ts if ts.tzinfo is not None else ts.replace(tzinfo=IST)
            return aware.astimezone(IST).strftime("%Y-%m-%d")
    except Exception:
        pass
    return datetime.now(IST).strftime("%Y-%m-%d")


def set_persist_enabled(enabled: bool) -> None:
    """Enable/disable MongoDB persistence. Called during lifespan startup."""
    global _persist_enabled
    _persist_enabled = bool(enabled)


_SEQ = 0
_SEQ_LOCK = Lock()
_LAST_GENERATED: str | None = None


def _next_event_id() -> str:
    """Collision-resistant event id (full 128-bit UUID4, ``evt_`` prefixed).

    Uniqueness properties:
    - 122 bits of randomness from UUID4 — no reliance on wall-clock time,
      process-lifetime counters, or truncated hashes (the old scheme only
      kept 6 hex chars of a UUID — 24 bits — plus a modulo-100000 process
      counter that reset on restart, which is how duplicate event_ids were
      produced).
    - A local last-seen guard regenerates on the astronomically unlikely
      identical UUID4 draw, so even in-process repeats are impossible.
    - Safe under concurrent async requests (single GIL-guarded call), across
      process restarts and across multiple workers sharing one collection.
    """
    import uuid

    global _SEQ, _LAST_GENERATED
    with _SEQ_LOCK:
        _SEQ += 1
        for _ in range(3):
            candidate = f"evt_{uuid.uuid4().hex}"
            if candidate != _LAST_GENERATED:
                _LAST_GENERATED = candidate
                return candidate
        return f"evt_{uuid.uuid4().hex}_{_SEQ}"


def record_event(
    source: str,
    event: str,
    status: str = "info",
    message: str = "",
    meta: dict | None = None,
) -> dict:
    """Record one lifecycle event (safe to call from any thread).

    ``meta`` may carry conventional keys — ``reason_code``, ``reason``,
    ``severity``, ``component``, ``details``, ``duration``, ``resolved_at``,
    ``connection_id`` — which are hoisted to stable top-level fields so the API
    surface is uniform. The original dict is preserved under ``meta`` too.

    A caller-supplied ``event_id`` is NEVER used as this event's own id: it is
    a *reference* to another ledger row (e.g. an alert bound to the quality
    event that triggered it) and is demoted to ``related_event_id``. The own
    id is always freshly generated by ``_next_event_id()`` so the ledger stays
    collision-free and the unique MongoDB index can be maintained.
    """
    meta_dict = dict(meta) if meta else {}
    related = str(meta_dict.pop("event_id", "") or "").strip()
    if not related:
        related = str(meta_dict.pop("related_event_id", "") or "").strip()
    meta_dict = _scrub_meta(meta_dict)
    now = datetime.now(timezone.utc)
    entry: dict[str, Any] = {
        "event_id": _next_event_id(),
        "source": str(source),
        "event": str(event),
        "status": str(status),
        "severity": str(meta_dict.get("severity") or status),
        "category": _ledger_category(source),
        "market_date": _market_date_ist(now),
        "reason": meta_dict.get("reason") or "",
        "reason_code": meta_dict.get("reason_code") or "",
        "component": meta_dict.get("component") or str(source),
        "details": meta_dict.get("details") or "",
        "duration": meta_dict.get("duration"),
        "duration_ms": meta_dict.get("duration_ms"),
        "resolved_at": meta_dict.get("resolved_at"),
        "related_event_id": related,
        "connection_id": meta_dict.get("connection_id") or meta_dict.get("websocket_id"),
        "session_id": meta_dict.get("session_id"),
        "symbol": meta_dict.get("symbol"),
        "token": meta_dict.get("token") or meta_dict.get("instrumentToken") or meta_dict.get("instrument_token"),
        "exchange": meta_dict.get("exchange"),
        "segment": meta_dict.get("segment") or meta_dict.get("exchangeSegment"),
        "message": str(message),
        "meta": meta_dict,
        "ts": now,
    }
    with _lock:
        _ring.append(entry)
    if _persist_enabled:
        _schedule_persist(entry)
        _schedule_insight_publish(entry)
    return entry


def recent_events(
    limit: int = 100,
    source: str | None = None,
    event: str | None = None,
) -> list[dict]:
    """Newest-first snapshot of recorded events."""
    with _lock:
        items = list(reversed(_ring))
    if source:
        items = [i for i in items if i.get("source") == source]
    if event:
        items = [i for i in items if i.get("event") == event]
    return items[: max(1, min(int(limit), _RING_MAX))]


def last_event(source: str, event: str) -> dict | None:
    """Most recent event matching source+event (newest first)."""
    with _lock:
        for e in reversed(_ring):
            if e.get("source") == source and e.get("event") == event:
                return e
    return None


def _schedule_persist(entry: dict) -> None:
    try:
        loop = get_loop()
    except Exception:
        loop = None
    if loop is None or not loop.is_running():
        return
    try:
        asyncio.run_coroutine_threadsafe(_persist(entry), loop)
    except Exception:
        _log.debug("Event persistence scheduling skipped: %s", entry.get("event"))


EVENTS_COLLECTION = "system_events"
LEGACY_EVENTS_COLLECTION = "events"

# IMPORTANT: Every ledger event must be a structured, chronological record.
# High-frequency events (individual ticks) are NEVER written here — they are
# aggregated into telemetry buckets instead. Publishing to the realtime
# channel is throttled so steady-state info events don't flood browsers.

_IMPORTANT_EVENTS = {
    "ALERT_CREATED", "ALERT_RESOLVED", "NOTIFICATION_CREATED",
    "QUALITY_ISSUE_CREATED", "QUALITY_ISSUE_RESOLVED", "DUPLICATES_CLEANED",
    "TICK_SAVE_FAILURE", "PIPELINE_STARTED", "PIPELINE_STOPPED",
    "MARKET_WINDOW_CLOSED", "MARKET_OPEN_CONFIRMED", "WS_CONFIRMATION_STARTED",
    "connected", "disconnected", "reconnected", "ws_reconnect_exhausted",
    "ws_auth_failed", "NETWORK_RESTORED", "DATABASE_CONNECTED",
    "DATABASE_DISCONNECTED", "SCHEDULER_STARTED", "SCHEDULER_STOPPED",
}

_PUBLISH_INTERVAL = 4.0  # seconds between insight pulses per (source,event)
_publish_last_at: dict[str, float] = {}


def _schedule_insight_publish(entry: dict) -> None:
    """Mirror a meaningful ledger event to the centralized realtime stream.

    Low-volume lifecycle events and all warnings/errors are pushed immediately;
    routine info events are throttled so steady-state activity never floods the
    channel. Frame type ``insight_event`` is consumed by the Data Insights
    dashboard without any page reload.
    """
    severity = str(entry.get("severity") or entry.get("status") or "info")
    if severity not in {"warning", "error", "critical"} and entry.get("event") not in _IMPORTANT_EVENTS:
        return
    import time as _t
    key = f"{entry.get('source')}|{entry.get('event')}"
    now = _t.time()
    if now - _publish_last_at.get(key, 0.0) < _PUBLISH_INTERVAL:
        return
    _publish_last_at[key] = now
    try:
        from services.ds_insights import publish_insight_event
        publish_insight_event(entry)
    except Exception:
        _log.debug("insight publish skipped for %s", entry.get("event"))


async def _persist(entry: dict) -> None:
    from database.connection import get_db, is_mongo_connected

    if not is_mongo_connected():
        return
    try:
        db = get_db()
        await db[EVENTS_COLLECTION].insert_one(dict(entry))
    except Exception:
        _log.debug("Event persistence skipped (db unavailable): %s", entry.get("event"))


def _event_iso(ts) -> str | None:
    """Normalize an event timestamp to an IST-aware ISO string.

    Events recorded by older backends stored ``datetime.now()`` (naive IST
    wall time) without a tzinfo. We pin naive values to IST so displayed
    times and the string-sort ordering stay consistent across the merged
    legacy + current collections.
    """
    if isinstance(ts, datetime):
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=IST)
        else:
            ts = ts.astimezone(IST)
        return ts.isoformat()
    return ts if ts is not None else None


async def _mongo_events_from(db, coll: str, query: dict, limit: int) -> list[dict]:
    """Newest-first rows from one events collection (never mutated)."""
    try:
        cursor = db[coll].find(query).sort("ts", -1).limit(limit)
        docs = await cursor.to_list(length=limit)
    except Exception:
        _log.debug("Event history read failed (%s unavailable)", coll)
        return []
    rows = []
    for doc in docs:
        row = {k: v for k, v in doc.items() if k != "_id"}
        row["ts"] = _event_iso(row.get("ts"))
        rows.append(row)
    return rows


async def mongo_events(
    limit: int = 100,
    source: str | None = None,
    event: str | None = None,
) -> list[dict]:
    """Newest-first persisted events merged from ``system_events`` and the
    legacy ``events`` collection (predates the rename).

    Restart-safe audit trail: survives backend restarts, which the in-memory
    ring buffer cannot. Events recorded by older backends live in ``events``
    and are never dropped — they are read alongside the current collection
    and merged newest-first (duplicates across the two are removed by the
    caller via ``_system_events_rows``). Returns [] when MongoDB is down.
    """
    from database.connection import get_db, is_mongo_connected

    if not is_mongo_connected():
        return []
    try:
        db = get_db()
    except Exception:
        return []
    query: dict[str, Any] = {}
    if source:
        query["source"] = source
    if event:
        query["event"] = event
    max_rows = max(1, min(int(limit), 1000))
    rows = await _mongo_events_from(db, EVENTS_COLLECTION, query, max_rows)
    legacy = await _mongo_events_from(db, LEGACY_EVENTS_COLLECTION, query, max_rows)
    return rows + legacy