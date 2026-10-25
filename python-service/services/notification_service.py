"""
Notification service — the SINGLE source for creating Data Saver notifications.

Every subsystem (WebSocket, database, scheduler, login, downloads, scanner,
data quality, security) calls `notify(...)` to record an important event. This
service:
  1. Checks whether the event category is enabled in settings (no spam).
  2. **Deduplicates** — the same problem must not produce a new row (and a new
     bell/push) every time it is observed. A repeat inside the grouping window
     bumps the existing row's ``occurrence_count`` instead of inserting again.
  3. Persists the notification to MongoDB (`notifications` / legacy shape).
  4. Publishes it on the in-memory event bus so the frontend can stream it to
     the top bar & notifications page in real time (no page reload).

Notifications survive page refresh, browser/PWA restart and backend restart
because they are stored in MongoDB. The frontend unread badge is derived from
the REAL unread count via `GET /api/notifications`.

WHY DEDUPE LIVES HERE (and not only in the rule engine)
-------------------------------------------------------
``notification_center._create_notification`` already collapses repeats for
rule-driven events. This module is the OTHER half of the surface — the direct
``notify()`` entry point used by the WebSocket manager, Session Manager, order
engine, data-quality scanner, baskets and trading APIs. It used to compute a
``deduplication_key`` and then insert unconditionally, so a subsystem that
reported the same condition on every tick produced one row per tick: the same
notification re-appearing over and over. Keying the insert on that same field
makes both paths behave identically.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from database.connection import get_db

from services.notification_center import (
    _max_severity,
    _notification_category_enabled,
    _notification_globals,
    _within_cooldown,
    importance_for,
    notification_category,
)

logger = logging.getLogger("app")

# Map a notification category to the settings key that gates it. If the
# feature is disabled, the notification is not created (and no spam is sent).
_CATEGORY_GATE: dict[str, str] = {
    "websocket": "notif_websocket_alerts",
    "database": "notif_database_alerts",
    "database:write": "notif_database_alerts",
    "scheduler": "notif_scheduler_alerts",
    "login": "notif_system_events",
    "security": "notif_system_events",
    "download": "notif_download_alerts",
    "quality": "notif_quality_alerts",
    "scanner": "notif_scanner_alerts",
    "system": "notif_system_events",
}


async def _category_enabled(category: str) -> bool:
    try:
        from services.settings_service import get_setting
        key = _CATEGORY_GATE.get(category)
        if not key:
            return True
        enabled = await get_setting(key)
        return bool(enabled) if enabled is not None else True
    except Exception:
        return True


def category_gate_keys(categories: list[str] | set[str] | tuple[str, ...]) -> list[str]:
    """The distinct settings keys that gate these rule categories."""
    return sorted({_CATEGORY_GATE[c] for c in categories if _CATEGORY_GATE.get(c)})


async def category_enabled_many(
    categories: list[str] | set[str] | tuple[str, ...],
    values: dict | None = None,
) -> dict[str, bool]:
    """Resolve many rule categories to gates with ONE settings read.

    Several rule categories share a settings key (``database`` and
    ``database:write`` both use ``notif_database_alerts``), so calling
    ``_category_enabled`` per category repeats the same network round trip.
    ``values`` lets a caller that already batched these keys reuse that read.
    """
    requested = list(categories)
    by_key: dict[str, list[str]] = {}
    for category in requested:
        key = _CATEGORY_GATE.get(category)
        by_key.setdefault(key or "", []).append(category)
    wanted = [key for key in by_key if key]
    if values is None:
        if not wanted:
            return {category: True for category in requested}
        try:
            from services.settings_service import get_settings_many
            values = await get_settings_many(wanted)
        except Exception:
            values = {}
    out: dict[str, bool] = {}
    for key, cats in by_key.items():
        if not key:
            for category in cats:
                out[category] = True
            continue
        value = values.get(key)
        for category in cats:
            out[category] = bool(value) if value is not None else True
    return out


async def _notify_globals_passes(severity: str) -> dict:
    """Notification engine toggles + severity threshold check."""
    engine = await _notification_globals()
    from services.notification_center import _severity_passes
    ok = (
        engine["enabled"]
        and _severity_passes(str(severity), engine["threshold"])
    )
    return {"ok": ok, "realtime": engine["realtime"]}


# --------------------------------------------------------------------------- #
# Deduplication
# --------------------------------------------------------------------------- #

# Fallback when the settings store has no value yet. Mirrors the default in
# NOTIFICATION_SETTING_KEYS ("notif_dedup_window_seconds" = 300).
_FALLBACK_DEDUPE_WINDOW_SECONDS = 300

# In-memory fast path: dedupe key -> {"id", "expires", "doc"}.
#
# Mongo stays the source of truth. The cache exists for ONE reason: to skip the
# `find_one` on a repeat, so a subsystem reporting in a loop costs one indexed
# update instead of a read + a write. It is explicitly NOT allowed to decide
# that a repeat is new — see `_cache_get`.
_dedupe_cache: dict[str, dict[str, Any]] = {}
_DEDUPE_CACHE_MAX = 512


def _cache_get(key: str) -> dict[str, Any] | None:
    """Cached row for this key, but only while it is genuinely still in cooldown.

    The entry's expiry is set to the cooldown it was cached under, so the cache
    goes stale at exactly the moment Mongo would stop calling it a repeat. That
    alignment is the whole correctness argument: the cache and the database can
    never disagree about whether something is a new incident.

    An entry without a persisted ``_id`` is treated as a MISS, never as a hit.
    A cached row we cannot write back to is not an optimisation, it is a way to
    silently swallow an event — so the cache is only ever allowed to skip work,
    never to decide.
    """
    hit = _dedupe_cache.get(key)
    if hit is None:
        return None
    if time.monotonic() >= float(hit.get("expires", 0.0)):
        _dedupe_cache.pop(key, None)
        return None
    if not hit.get("doc", {}).get("_id"):
        _dedupe_cache.pop(key, None)
        return None
    return hit


def _cache_put(key: str, doc: dict[str, Any], window_seconds: int) -> None:
    if len(_dedupe_cache) >= _DEDUPE_CACHE_MAX:
        # Cheap bound. Clearing wholesale is fine — the next repeat simply
        # re-reads Mongo, which is the same code path a cold cache takes.
        _dedupe_cache.clear()
    _dedupe_cache[key] = {
        "id": str(doc.get("_id") or ""),
        "expires": time.monotonic() + max(0, int(window_seconds)),
        "doc": doc,
    }


def dedupe_cache_clear() -> None:
    """Drop the fast-path cache (used by tests and after a bulk delete)."""
    _dedupe_cache.clear()


async def _dedupe_window_seconds() -> int:
    """Grouping window, from settings, clamped to something sane."""
    try:
        from services.settings_service import get_setting
        raw = await get_setting("notif_dedup_window_seconds")
    except Exception:
        return _FALLBACK_DEDUPE_WINDOW_SECONDS
    if raw is None:
        return _FALLBACK_DEDUPE_WINDOW_SECONDS
    try:
        return max(0, min(86_400, int(raw)))
    except (TypeError, ValueError):
        return _FALLBACK_DEDUPE_WINDOW_SECONDS


def _dedupe_key(category: str, event_type: str, meta: dict) -> str:
    """Stable identity of the *problem*, not of the observation.

    Deliberately excludes the human-readable message and every timestamp: two
    ticks of the same broken thing must collapse, while a different component,
    subject or reason must stay separate. Engine-scoped callers pass their own
    ``dedupe_key`` so e.g. "engine X went DEGRADED" and "engine Y went ERROR"
    are distinct rows.
    """
    return ":".join([
        str(category or ""),
        str(event_type or "notification"),
        str(meta.get("component") or ""),
        str(meta.get("source") or ""),
        str(meta.get("symbol", "")),
        str(meta.get("reason_code", "")),
    ])


async def _find_recent(db, key: str) -> dict[str, Any] | None:
    """Latest row carrying this dedupe key, if any."""
    try:
        return await db.notifications.find_one(
            {"deduplication_key": key}, sort=[("last_seen_at", -1), ("ts", -1)],
        )
    except Exception:
        return None


def _bump_existing(existing: dict[str, Any], now_utc: datetime, severity: str,
                   message: str, category: str) -> dict[str, Any]:
    """Merge a repeat occurrence into an existing row. Returns the new state.

    Severity only ever moves UP within an incident (a later error must not be
    softened by an earlier warning) and the row keeps its original
    ``first_seen_at`` so the duration stays truthful.
    """
    severity = _max_severity(str(existing.get("severity") or severity), severity)
    first_seen = existing.get("first_seen_at") or existing.get("ts") or now_utc
    merged = dict(existing)
    merged["severity"] = severity
    merged["level"] = severity
    merged["importance"] = importance_for(severity)
    merged["message"] = message or str(existing.get("message") or "")
    merged["category"] = category
    merged["occurrence_count"] = int(existing.get("occurrence_count") or 1) + 1
    merged["first_seen_at"] = first_seen
    merged["last_seen_at"] = now_utc
    merged["updated_at"] = now_utc
    return merged


# Fields a dedupe bump writes back. Kept explicit so the cached doc and the
# stored doc can never drift apart on anything the UI reads.
_BUMP_FIELDS = (
    "occurrence_count", "last_seen_at", "updated_at",
    "severity", "level", "importance", "message", "category", "first_seen_at",
)


async def _persist_bump(db, existing: dict[str, Any], merged: dict[str, Any]) -> None:
    """Write the folded-in occurrence back so the count is durable.

    A repeat that only lived in memory would leave the page showing "×1" for an
    incident that has actually been observed twenty times, so this update is not
    optional. It is a single indexed ``$set`` — cheap precisely because the
    cache already spared us the ``find_one``.

    The ``_id`` needs care: documents we insert stringify ``_id`` for the API
    envelope, but Mongo still stores an ``ObjectId``. Querying with the string
    form matches nothing and silently drops the update, which would leave the
    occurrence count permanently stuck at 1. Convert back before filtering.
    """
    try:
        oid = existing.get("_id")
        if isinstance(oid, str):
            try:
                from bson import ObjectId
                oid = ObjectId(oid)
            except Exception:
                pass  # not an ObjectId (test doubles, custom ids) — use as-is
        await db.notifications.update_one(
            {"_id": oid},
            {"$set": {k: merged[k] for k in _BUMP_FIELDS if k in merged}},
        )
    except Exception:
        logger.warning("Could not persist dedupe bump", exc_info=True)


async def notify(
    category: str,
    severity: str,
    title: str,
    message: str,
    *,
    source: str = "data-saver",
    event_type: str = "",
    metadata: dict | None = None,
    bypass_enabled: bool = False,
    dedupe: bool = True,
    cooldown_seconds: int | None = None,
    dedupe_key: str | None = None,
) -> dict | None:
    """Create (or fold into an existing) notification. The single entry point.

    Returns the stored document (with string ``_id``), or ``None`` when the
    category is disabled and ``bypass_enabled`` is False, or MongoDB is
    unavailable.

    ``dedupe=False`` is for genuinely discrete events — a manual notification an
    operator typed, a test ping — where collapsing two rows would lose
    information. Everything a *subsystem* reports about a *condition* should
    leave it at the default so the same problem is stated once.

    Every notification is chained to a real ledger event (``related_event_id``)
    so the full traceability requirement holds for direct callers too, and is
    pushed to the centralized system SSE stream (no polling, no page reload).
    """
    if severity not in {"info", "success", "warning", "error", "critical"}:
        severity = "info"
    gates = await _notify_globals_passes(severity)
    if not bypass_enabled:
        if not gates["ok"]:
            return None
        if not await _category_enabled(category):
            return None
        if not await _notification_category_enabled(notification_category(category)):
            return None

    meta = metadata or {}
    display_category = notification_category(category)
    key = dedupe_key or _dedupe_key(category, event_type, meta)
    now_utc = datetime.now(timezone.utc)
    window = (
        _FALLBACK_DEDUPE_WINDOW_SECONDS
        if cooldown_seconds is None
        else max(0, cooldown_seconds)
    )
    if cooldown_seconds is None and not bypass_enabled:
        window = await _dedupe_window_seconds()

    # A manual/test notification is not a machine observation, so it neither
    # dedupes against nor gets folded into live rows.
    dedupable = bool(dedupe) and not bypass_enabled

    try:
        db = get_db()
    except Exception:
        logger.debug("Mongo unavailable — notification dropped: %s", title)
        return None

    # ---- Repeat: fold into the open row instead of inserting again. -------
    if dedupable and window > 0:
        cached = _cache_get(key)
        existing: dict[str, Any] | None = None

        if cached is not None:
            # Still inside the cooldown it was cached under (guaranteed by
            # `_cache_get`), so this is a repeat without needing the read.
            existing = cached["doc"]
        else:
            # No usable cache entry: ask Mongo, which is authoritative about
            # whether the previous incident is still inside its window.
            existing = await _find_recent(db, key)
            if existing is None or not _within_cooldown(
                existing.get("last_seen_at") or existing.get("ts"), window, now_utc,
            ):
                existing = None

        if existing is not None:
            merged = _bump_existing(existing, now_utc, severity, message, display_category)
            if existing.get("_id") is not None:
                await _persist_bump(db, existing, merged)
                merged["_id"] = str(existing["_id"])
            _cache_put(key, merged, window)
            changes = {
                k: merged[k]
                for k in ("occurrence_count", "last_seen_at", "severity", "importance")
            }
            # A `notification_updated` frame lets an open list refresh its
            # counter without the row looking brand new to the user. Announcing
            # a bump as a fresh event is what made one problem look like it
            # kept happening again and again.
            await _publish_realtime_update(merged, changes)
            return merged

    # First record the canonical ledger row so the notification can reference
    # a real event_id (WHAT/WHEN/WHY chain), never a fabricated one.
    related_event_id = ""
    try:
        from services.event_history import record_event
        entry = record_event(
            "notification", "NOTIFICATION_CREATED", severity, title,
            {"severity": severity, "category": category,
             "event_type": event_type, "source": source,
             "component": "notification_service",
             "details": message, "reason_code": "notification"},
        )
        related_event_id = entry.get("event_id", "")
    except Exception:
        logger.debug("Notification ledger event not recorded")

    doc = {
        "category": display_category,
        "severity": severity,
        "level": severity,
        "importance": importance_for(severity),
        "title": title,
        "message": message,
        "source": source,
        "event_type": event_type,
        "status": "unread",
        "read": False,
        "read_at": None,
        "resolved_at": None,
        "related_event_id": related_event_id,
        # Callers that already opened an alert for this incident (the engine
        # self-reporter does) pass it through so the two views are linked
        # instead of being two unrelated rows.
        "related_alert_id": str(meta.get("related_alert_id") or "") or None,
        "deduplication_key": key,
        "occurrence_count": 1,
        "occurred_at": now_utc,
        "first_seen_at": now_utc,
        "last_seen_at": now_utc,
        "updated_at": now_utc,
        "reason": str(meta.get("reason") or "")[:500],
        "reason_code": str(meta.get("reason_code") or ""),
        "component": str(meta.get("component") or ""),
        "symbol": str(meta.get("symbol") or ""),
        "token": str(meta.get("token") or ""),
        "metadata": meta,
        # legacy fields for backward compatibility
        "meta": meta,
        "ts": now_utc,
        "created_at": now_utc,
    }
    try:
        result = await db.notifications.insert_one(doc)
        doc["_id"] = str(result.inserted_id)
    except Exception:
        logger.debug("Failed to persist notification: %s", title)
        return None

    if dedupable:
        _cache_put(key, doc, window)

    # Push real-time frames so open clients update without polling.
    if gates["realtime"]:
        await _publish_realtime(doc)
    # PWA Web Push fan-out to subscribed devices (best-effort; skipped unless
    # VAPID is configured and at least one device subscribed).
    await _publish_push(doc)
    return doc


def _push_kind(event_type: str) -> str:
    et = str(event_type or "").upper()
    if "TARGET" in et:
        return "target"
    if "STOP" in et or "STOPLOSS" in et or "STOP_LOSS" in et:
        return "stop_loss"
    if "PRICE_ALERT" in et or "ALERT" in et:
        return "price_alert"
    return "order_executed"


async def _publish_push(doc: dict) -> None:
    """Fan a stored notification out to PWA devices. Never raises."""
    try:
        from services import push_delivery as push

        if not push.push_enabled():
            return
        meta = doc.get("metadata") or doc.get("meta") or {}
        if not isinstance(meta, dict):
            meta = {}
        try:
            price = float(meta.get("price")) if meta.get("price") not in (None, "") else None
        except (TypeError, ValueError):
            price = None
        await push.fanout_push(push.build_push_payload(
            title=str(doc.get("title") or "Notification"),
            body=str(doc.get("message") or ""),
            kind=_push_kind(str(doc.get("event_type") or "")),
            symbol=str(doc.get("symbol") or meta.get("symbol") or ""),
            side=str(meta.get("side") or meta.get("transactionType") or ""),
            price=price,
            order_id=str(meta.get("order_id") or meta.get("orderId") or ""),
        ))
    except Exception as exc:
        logger.debug("Push fan-out skipped: %s", exc)


async def _publish_realtime_update(doc: dict, changes: dict) -> None:
    """Announce a folded-in repeat occurrence.

    Deliberately a different frame type from ``notification_created``: an open
    list should quietly increment a counter, NOT splice in a brand-new row and
    announce it as a fresh event. Notifying on the bump is what made the same
    problem look like it kept happening again and again.
    """
    try:
        from services.json_safe import sanitize_for_json
        from services.state_store import get_state_store

        await get_state_store().publish({
            "type": "notification_updated",
            "notification_id": doc.get("_id"),
            "notification": sanitize_for_json(dict(doc)),
            "changes": sanitize_for_json(dict(changes)),
            "category": doc.get("category"),
            "deduplicated": True,
        })
    except Exception:
        logger.debug("Failed to publish notification update frame")


async def _publish_realtime(doc: dict) -> None:
    """Centralized realtime: notification_created + count_changed frames.

    Uses the one backend→browser SSE channel (/api/websocket/system/stream via
    the StateStore) — the same channel the topbar and pages subscribe to.
    """
    try:
        from services.json_safe import sanitize_for_json
        from services.state_store import get_state_store, set_entity_state

        store = get_state_store()
        frame = {
            "type": "notification_created",
            "notification_id": doc.get("_id"),
            "notification": sanitize_for_json(dict(doc)),
            "category": doc.get("category"),
        }
        await store.publish(frame)
    except Exception:
        logger.debug("Failed to publish notification frame")

    try:
        from services.state_store import set_entity_state
        db = get_db()
        unread = await db.notifications.count_documents({"read": False})
        await set_entity_state(
            "notifications",
            {"unreadCount": unread, "checkedAt": datetime.now(timezone.utc).isoformat()},
            reason="notification:created",
        )
        from services.state_store import get_state_store
        await get_state_store().publish(
            {"type": "notification_count_changed", "unreadCount": unread}
        )
    except Exception:
        logger.debug("Failed to publish notification count")
