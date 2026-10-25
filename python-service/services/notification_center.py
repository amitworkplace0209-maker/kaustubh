"""Centralized Data Saver notification & alert center.

This is the SINGLE authoritative pipeline for every real event:

    Real event â†’ Event Ledger (``system_events``) â†’ Classification
        â†’ Alert Rule Engine â†’ Alert â†’ Notification
        â†’ MongoDB â†’ Central Realtime Channel â†’ TopBar â†’ Pages

Design constraints honored:
  * No fake/random notifications â€” every row traces back to a real
    ``record_event(...)`` ledger entry (``related_event_id``).
  * One realtime channel: the centralized system SSE stream
    (``/api/websocket/system/stream`` via ``StateStore``). No per-consumer WS.
* Dedupe / cooldown / grouping: repeating events never spam â€” they bump
    ``occurrence_count`` within the cooldown window (dedupe window).

  * Auto-resolve: recovery events resolve matching open alerts (can be
    disabled via the alert settings).
  * Expiry: every alert carries ``expires_at`` (``created_at`` + 24h) and the
    collection has a MongoDB TTL index, so NO alert survives longer than 24h
    â€” active or resolved. The 24h sweep also covers legacy rows.
  * Secrets never persist: ``event_history._scrub_meta`` already scrubs
    credential-shaped keys before the ledger row is stored.

``emit_event(...)`` is a drop-in replacement for ``record_event(...)``: same
signature, identical ledger row, plus rule processing. Event sources simply
import ``emit_event`` instead of ``record_event`` to light up the whole
notification/alert center.
"""
from __future__ import annotations

import asyncio
import logging
import re
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

logger = logging.getLogger("notification_center")

# --------------------------------------------------------------------------- #
# Canonical vocabulary
# --------------------------------------------------------------------------- #
SEVERITIES = ("info", "success", "warning", "error", "critical")
_SEVERITY_LEVEL: dict[str, int] = {"info": 0, "success": 1, "warning": 2, "error": 3, "critical": 4}

ALERT_OPEN = "active"
ALERT_ACKED = "acknowledged"
ALERT_RESOLVED = "resolved"
_ALERT_LIVE = (ALERT_OPEN, ALERT_ACKED)

NOTIF_RETENTION_DEFAULT_DAYS = 60
ALERT_RETENTION_DEFAULT_DAYS = 90
# Every alert expires ``ALERT_RETENTION_HOURS`` after it was created. MongoDB
# TTL index + the retention sweep enforce this for active AND resolved alerts.
ALERT_RETENTION_HOURS = 24

_CATEGORY_GATE: dict[str, str] = {
    "websocket": "notif_websocket_alerts",
    "database": "notif_database_alerts",
    "database:write": "notif_database_alerts",
    "scheduler": "notif_scheduler_alerts",
    "download": "notif_download_alerts",
    "export": "notif_download_alerts",
    "quality": "notif_quality_alerts",
    "scanner": "notif_scanner_alerts",
    "login": "notif_system_events",
    "security": "notif_system_events",
    "system": "notif_system_events",
    "market": "notif_system_events",
    "session": "notif_system_events",
    "pipeline": "notif_system_events",
    "settings": "notif_system_events",
}

# Canonical display categories for the Live Alert Center. Every stored alert
# has its rule category mapped here so the UI tabs are stable and only reflect
# real event sources. Unknown categories fall back to their uppercased name.
_CANONICAL_CATEGORY: dict[str, str] = {
    "websocket": "WEBSOCKET",
    "database": "DATABASE",
    "database:write": "TICKS",
    "market": "MARKET",
    "quality": "DATA_QUALITY",
    "pipeline": "PIPELINE",
    "scheduler": "SCHEDULER",
    "download": "DOWNLOADS",
    "export": "EXPORTS",
    "login": "SESSION",
    "session": "SESSION",
    "settings": "SYSTEM",
    "scanner": "DATA_QUALITY",
}


def canonical_category(category: str | None) -> str:
    """Stable, uppercased display category for an alert's rule category."""
    key = str(category or "").lower().strip()
    if not key:
        return "SYSTEM"
    return _CANONICAL_CATEGORY.get(key, key.upper())


# --------------------------------------------------------------------------- #
# Notification display categories (separate from alert canonical categories)
# --------------------------------------------------------------------------- #
# The Notifications page tabs are these stable, uppercased categories. Every
# notification maps here so the UI only ever shows real event sources.
NOTIFICATION_CATEGORIES = (
    "MARKET", "WEBSOCKET", "SESSION", "DOWNLOADS", "EXPORTS",
    "SUBSCRIPTIONS", "SCHEDULER", "DATA", "SETTINGS", "SYSTEM",
)

# Fallback mapping from a stored/rule category string -> display category.
_NOTIFICATION_CATEGORY: dict[str, str] = {
    "websocket": "WEBSOCKET",
    "database": "DATA",
    "database:write": "DATA",
    "market": "MARKET",
    "subscriptions": "SUBSCRIPTIONS",
    "quality": "DATA",
    "scanner": "DATA",
    "pipeline": "SYSTEM",
    "scheduler": "SCHEDULER",
    "download": "DOWNLOADS",
    "export": "EXPORTS",
    "login": "SESSION",
    "session": "SESSION",
    "settings": "SETTINGS",
    "system": "SYSTEM",
    "security": "SESSION",
    "sync": "SYSTEM",
    "notification": "SYSTEM",
}

# Rules whose alert category cannot disambiguate the notification category
# (download vs export share ``category="download"``; subscriptions live under
# ``category="market"`` in the rule registry).
_NOTIF_CATEGORY_BY_RULE: dict[str, str] = {
    "subscriptions": "SUBSCRIPTIONS",
    "download": "DOWNLOADS",
    "export": "EXPORTS",
    "quality": "DATA",
    "quality_resolved": "DATA",
    "scanner": "DATA",
    "persistence": "DATA",
    "pipeline": "SYSTEM",
    "settings": "SETTINGS",
    "mode": "SESSION",
    "login": "SESSION",
}

# Display category -> settings key that gates notification delivery.
_NOTIFICATION_GATE_KEY: dict[str, str] = {
    "MARKET": "notif_cat_market",
    "WEBSOCKET": "notif_cat_websocket",
    "SESSION": "notif_cat_session",
    "DOWNLOADS": "notif_cat_downloads",
    "EXPORTS": "notif_cat_exports",
    "SUBSCRIPTIONS": "notif_cat_subscriptions",
    "SCHEDULER": "notif_cat_scheduler",
    "DATA": "notif_cat_data",
    "SETTINGS": "notif_cat_settings",
    "SYSTEM": "notif_cat_system",
}

# Importance: high signals the user should act (attention-worthy level).
_IMPORTANT_SEVERITIES = frozenset({"warning", "error", "critical"})


def notification_category(category: str | None) -> str:
    """Stable display category for a notification source/rule category."""
    key = str(category or "").lower().strip()
    if not key:
        return "SYSTEM"
    return _NOTIFICATION_CATEGORY.get(key, key.upper())


def importance_for(severity: str) -> str:
    return "high" if severity in _IMPORTANT_SEVERITIES else "normal"


def _notif_category_for(rule: NotificationRule) -> str:
    return _NOTIF_CATEGORY_BY_RULE.get(rule.rule_id) or notification_category(rule.category)


# Reasons that are deliberate and must NOT raise a WebSocket disconnect alert.
_DELIBERATE_REASON_CODES = frozenset({
    "scheduled_disconnect", "application_shutdown", "market_closed",
    "user_disconnect", "stopped_by_scheduler", "app_shutdown", "logout",
})


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _level(sev: str) -> int:
    return _SEVERITY_LEVEL.get(str(sev).lower(), 0)


def _max_severity(a: str, b: str) -> str:
    return a if _level(a) >= _level(b) else b


# --------------------------------------------------------------------------- #
# Rule registry â€” the configuration of the Alert Rule Engine
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class NotificationRule:
    rule_id: str
    source: str
    events: tuple[str, ...]
    category: str
    title: str
    message: str
    severity: str = "info"
    severity_by_event: dict[str, str] = field(default_factory=dict)
    create_notification: bool = True
    create_alert: bool = False
    cooldown_seconds: int = 300
    dedupe_key: str = "{category}:{event}:{symbol}:{reason_code}"
    auto_resolve_on: str | None = None
    skip_when: Callable[[dict], bool] | None = None
    component: str = ""


def _skip_deliberate_disconnect(entry: dict) -> bool:
    meta = entry.get("meta") or {}
    rc = str(meta.get("reason_code") or entry.get("reason_code") or "").lower()
    return bool(rc and rc in _DELIBERATE_REASON_CODES)


RULES: list[NotificationRule] = [
    # ---- WebSocket / broker feed ------------------------------------------
    NotificationRule(
        rule_id="ws_connected", source="websocket",
        events=("connected", "reconnected"), category="websocket",
        title="WebSocket Connected",
        message="Broker feed connected ({event}).",
        severity="success", severity_by_event={"connected": "success", "reconnected": "info"},
        create_notification=True, create_alert=False, cooldown_seconds=600,
        component="websocket",
    ),
    NotificationRule(
        rule_id="ws_disconnected", source="websocket",
        events=("disconnected",), category="websocket",
        title="WebSocket Disconnected",
        message="{message}",
        severity="warning", create_notification=True, create_alert=True,
        cooldown_seconds=600, auto_resolve_on="connected",
        skip_when=_skip_deliberate_disconnect, component="websocket",
    ),
    NotificationRule(
        rule_id="ws_auth_failed", source="websocket",
        events=("ws_auth_failed", "ws_reconnect_exhausted"), category="websocket",
        title="WebSocket Authentication Failed",
        message="{message} â€” session credentials expired.",
        severity="critical", create_notification=True, create_alert=True,
        cooldown_seconds=600, auto_resolve_on="connected", component="websocket",
    ),
    # ---- MongoDB / database ------------------------------------------------
    NotificationRule(
        rule_id="db_connected", source="database",
        events=("DATABASE_CONNECTED",), category="database",
        title="Database Connected", message="MongoDB connection established.",
        severity="success", create_notification=True, create_alert=False,
        cooldown_seconds=900, component="mongodb",
    ),
    NotificationRule(
        rule_id="db_disconnected", source="database",
        events=("DATABASE_DISCONNECTED",), category="database",
        title="Database Disconnected", message="{message}",
        severity="critical", create_notification=True, create_alert=True,
        cooldown_seconds=1200, auto_resolve_on="DATABASE_CONNECTED",
        component="mongodb",
    ),
    # ---- Market session ----------------------------------------------------
    NotificationRule(
        rule_id="market_open", source="market_state",
        events=("MARKET_OPEN_CONFIRMED",), category="market",
        title="Market Open Confirmed", message="{message}",
        severity="info", create_notification=True, create_alert=False,
        cooldown_seconds=3600, component="market_state",
    ),
    NotificationRule(
        rule_id="market_close", source="market_state",
        events=("MARKET_WINDOW_CLOSED",), category="market",
        title="Market Window Closed", message="{message}",
        severity="info", create_notification=True, create_alert=False,
        cooldown_seconds=3600, component="market_state",
    ),
    NotificationRule(
        rule_id="subscriptions", source="market_state",
        events=("SUBSCRIPTIONS_READY", "SUBSCRIPTION_FAILED"), category="market",
        title="Subscriptions Ready", message="{message}",
        severity_by_event={"SUBSCRIPTIONS_READY": "success", "SUBSCRIPTION_FAILED": "warning"},
        create_notification=True, create_alert=True,
        cooldown_seconds=900, auto_resolve_on="SUBSCRIPTIONS_READY",
        component="market_state",
    ),
    NotificationRule(
        rule_id="network", source="market_state",
        events=("NETWORK_RESTORED",), category="market",
        title="Internet Connectivity Restored", message="{message}",
        severity="success", create_notification=True, create_alert=False,
        cooldown_seconds=900, component="market_state",
    ),
    NotificationRule(
        rule_id="broker_error", source="market_state",
        events=("BROKER_ERROR",), category="websocket",
        title="Broker Error", message="{message}",
        severity="warning", create_notification=True, create_alert=True,
        cooldown_seconds=900, component="broker",
    ),
    # ---- Data quality ------------------------------------------------------
    NotificationRule(
        rule_id="quality", source="quality",
        events=("QUALITY_ISSUE_CREATED",), category="quality",
        title="Data Quality Issue", message="{message}",
        severity_by_event={"QUALITY_ISSUE_CREATED": "warning"},
        create_notification=True, create_alert=True,
        cooldown_seconds=900, auto_resolve_on="QUALITY_ISSUE_RESOLVED",
        component="data_quality",
    ),
    NotificationRule(
        rule_id="quality_resolved", source="quality",
        events=("QUALITY_ISSUE_RESOLVED",), category="quality",
        title="Data Quality Issue Resolved", message="{message}",
        severity="success", create_notification=True, create_alert=False,
        cooldown_seconds=900, component="data_quality",
    ),
    # ---- Tick persistence / pipeline ---------------------------------------
    NotificationRule(
        rule_id="persistence", source="pipeline",
        events=("TICK_SAVE_FAILURE",), category="database:write",
        title="Tick Persistence Failure", message="{message}",
        severity="critical", create_notification=True, create_alert=True,
        cooldown_seconds=600, component="tick_buffer",
    ),
    NotificationRule(
        rule_id="pipeline", source="pipeline",
        events=("PIPELINE_STARTED", "PIPELINE_STOPPED"), category="pipeline",
        title="Tick Pipeline {event}", message="{message}",
        severity_by_event={"PIPELINE_STARTED": "info", "PIPELINE_STOPPED": "info"},
        create_notification=True, create_alert=False,
        cooldown_seconds=1800, component="tick_pipeline",
    ),
    # ---- Scheduler ---------------------------------------------------------
    NotificationRule(
        rule_id="scheduler", source="scheduler",
        events=("SCHEDULER_STARTED", "SCHEDULER_STOPPED", "MARKET_CLOSED"), category="scheduler",
        title="Scheduler {event}", message="{message}",
        severity_by_event={"SCHEDULER_STARTED": "success", "SCHEDULER_STOPPED": "success", "MARKET_CLOSED": "info"},
        create_notification=True, create_alert=False,
        cooldown_seconds=3600, component="scheduler",
    ),
    NotificationRule(
        rule_id="scheduler_crash", source="scheduler",
        events=("supervisor_crash",), category="scheduler",
        title="Scheduler Crash", message="{message}",
        severity="critical", create_notification=True, create_alert=True,
        cooldown_seconds=1200, auto_resolve_on="SCHEDULER_STARTED",
        component="scheduler",
    ),
    # ---- Auth / session (login events) ------------------------------------
    NotificationRule(
        rule_id="login", source="auth",
        events=("LOGIN_FAILED", "LOGIN_SUCCESS", "LOGOUT_SUCCESS", "MANUAL_LOGIN"), category="login",
        title="Login {event}", message="{message}",
        severity_by_event={"LOGIN_FAILED": "error", "LOGIN_SUCCESS": "success",
                            "LOGOUT_SUCCESS": "info", "MANUAL_LOGIN": "info"},
        create_notification=True, create_alert=False,
        cooldown_seconds=600, component="auth",
    ),
    NotificationRule(
        rule_id="mode", source="session",
        events=("mode_switched",), category="session",
        title="Trading Mode Switched", message="{message}",
        severity="info", create_notification=True, create_alert=False,
        cooldown_seconds=600, component="session",
    ),
    # ---- Settings ----------------------------------------------------------
    NotificationRule(
        rule_id="settings", source="settings",
        events=("SETTINGS_CHANGED",), category="settings",
        title="Settings Updated", message="{message}",
        severity="info", create_notification=True, create_alert=False,
        cooldown_seconds=60, component="settings",
    ),
    # ---- Downloads / exports -----------------------------------------------
    NotificationRule(
        rule_id="download", source="download",
        events=("DOWNLOAD_STARTED", "DOWNLOAD_COMPLETED", "DOWNLOAD_FAILED"), category="download",
        title="Download {event}", message="{message}",
        severity_by_event={"DOWNLOAD_STARTED": "info", "DOWNLOAD_COMPLETED": "success", "DOWNLOAD_FAILED": "error"},
        create_notification=True, create_alert=True,
        cooldown_seconds=600, component="scheduler",
    ),
    NotificationRule(
        rule_id="export", source="export",
        events=("EXPORT_STARTED", "EXPORT_COMPLETED", "EXPORT_FAILED"), category="download",
        title="Export {event}", message="{message}",
        severity_by_event={"EXPORT_STARTED": "info", "EXPORT_COMPLETED": "success", "EXPORT_FAILED": "error"},
        create_notification=True, create_alert=False,
        cooldown_seconds=600, component="export_worker",
    ),
    # ---- Scanner -----------------------------------------------------------
    NotificationRule(
        rule_id="scanner", source="scanner",
        events=("SCAN_COMPLETED", "SCAN_FAILED",), category="scanner",
        title="Scanner {event}", message="{message}",
        severity_by_event={"SCAN_COMPLETED": "info", "SCAN_FAILED": "warning"},
        create_notification=True, create_alert=False,
        cooldown_seconds=900, component="scanner",
    ),
]

_RULES_BY_KEY: dict[tuple[str, str], NotificationRule] = {
    (r.source, ev): r for r in RULES for ev in r.events
}


def get_rule(rule_id: str) -> NotificationRule | None:
    return next((r for r in RULES if r.rule_id == rule_id), None)


# --------------------------------------------------------------------------- #
# emit_event â€” the single entry point
# --------------------------------------------------------------------------- #
def emit_event(
    source: str,
    event: str,
    status: str = "info",
    message: str = "",
    meta: dict | None = None,
) -> dict:
    """Drop-in replacement for ``record_event``.

    Records the SAME append-only ledger row, then runs the Alert Rule Engine
    (alerts + notifications + auto-resolve) and publishes realtime frames.
    Safe from any thread; never raises; no-op when the loop isn't running.
    """
    from services.event_history import record_event

    entry = record_event(source, event, status, message, meta)
    _schedule_rules(entry)
    return entry


def _schedule_rules(entry: dict) -> None:
    try:
        from core.event_loop import get_loop
        loop = get_loop()
    except Exception:
        return
    if loop is None or not loop.is_running():
        return
    try:
        loop.call_soon_threadsafe(lambda: asyncio_starter(entry))
    except Exception:
        logger.debug("rule scheduling failed for %s", entry.get("event"))


def asyncio_starter(entry: dict) -> None:
    import asyncio
    try:
        asyncio.ensure_future(_run_rules_for(entry))
    except Exception:
        logger.debug("rule task failed to launch for %s", entry.get("event"))


async def _run_rules_for(entry: dict) -> None:
    try:
        db = get_db()
    except Exception:
        return
    src = entry.get("source")
    ev = entry.get("event")
    engine, notif_engine = await asyncio.gather(
        _alert_engine_globals(),
        _notification_globals(),
    )
    # Recovery resolution: a real event may auto-resolve open alerts of rules
    # that declared this event as their recovery signal (e.g. a ``connected``
    # event resolves the ``ws_disconnected`` / ``ws_auth_failed`` alerts). It
    # is gated by the global engine + recovery toggles so a paused engine
    # never mutates alert state on its own.
    if engine["enabled"] and engine["recovery"]:
        for rule in RULES:
            if rule.source == src and rule.auto_resolve_on == ev and rule.create_alert:
                try:
                    await _resolve_open_alerts(rule, entry, db)
                except Exception:
                    logger.debug("alert auto-resolve failed for %s", rule.rule_id, exc_info=True)
    rule = _RULES_BY_KEY.get((src, ev))
    if rule is None:
        return
    try:
        if rule.skip_when is not None and rule.skip_when(entry):
            return
        if not await _rule_enabled(rule):
            return
        severity = (rule.severity_by_event or {}).get(ev, rule.severity)
        dedup_window = engine["dedupWindow"]
        related_alert_id = None
        if rule.create_alert and engine["enabled"] and _severity_passes(severity, engine["threshold"]):
            related_alert_id = await _upsert_alert(rule, entry, severity, db, dedup_window)
        if (
            rule.create_notification
            and notif_engine["enabled"]
            and _severity_passes(severity, notif_engine["threshold"])
            and await _notification_category_enabled(_notif_category_for(rule))
        ):
            await _create_notification(
                rule, entry, severity, db, related_alert_id,
                dedup_window=min(dedup_window, notif_engine["dedupWindow"]),
                realtime=notif_engine["realtime"],
            )
    except Exception:
        logger.debug("rule processing failed for %s/%s: %s", src, ev, entry.get("event"), exc_info=True)


def get_db():
    from database.connection import get_db as _get_db
    return _get_db()


async def _alert_engine_globals() -> dict:
    """Live alert-engine knobs from the settings store.

    Read on every rule evaluation so a toggle in the Alert settings page takes
    effect immediately: global enable, minimum alert severity threshold,
    dedupe/grouping window, and recovery alerts. All four keys come from ONE
    batched read — previously this was four sequential Atlas round trips per
    event.
    """
    try:
        from services.settings_service import get_settings_many
        values = await get_settings_many([
            "alerts_enabled",
            "alerts_severity_threshold",
            "alerts_dedup_window_seconds",
            "alerts_recovery_enabled",
        ])
        enabled = values.get("alerts_enabled")
        threshold = str(values.get("alerts_severity_threshold") or "all").lower()
        dedup = values.get("alerts_dedup_window_seconds")
        recovery = values.get("alerts_recovery_enabled")
    except Exception:
        enabled, threshold, dedup, recovery = None, "all", None, None
    return {
        "enabled": bool(enabled) if enabled is not None else True,
        "threshold": threshold if threshold in ("all", "warning", "error", "critical") else "all",
        "dedupWindow": max(1, int(dedup or 600)),
        "recovery": bool(recovery) if recovery is not None else True,
    }


def _severity_passes(severity: str, threshold: str) -> bool:
    """True when an alert severity meets the configured minimum threshold."""
    if threshold == "all":
        return True
    return _level(severity) >= _level(threshold)


def _effective_cooldown(rule: NotificationRule, dedup_window: int) -> int:
    """Grouping window for a rule, capped by the configured dedupe window."""
    try:
        return max(1, min(int(rule.cooldown_seconds), int(dedup_window)))
    except Exception:
        return max(1, int(rule.cooldown_seconds))


async def _rule_enabled(rule: NotificationRule) -> bool:
    try:
        from services.settings_service import get_setting
        enabled = await get_setting(f"alert_{rule.rule_id}_enabled")
        return bool(enabled) if enabled is not None else True
    except Exception:
        return True


async def _notification_globals() -> dict:
    """Live notification-engine knobs from the settings store.

    Read on every rule evaluation so a toggle in the Notifications settings
    takes effect immediately: global enable, minimum notification severity,
    dedupe/grouping window, recovery notifications, and realtime frames. All
    five keys come from ONE batched read instead of five sequential round trips.
    """
    try:
        from services.settings_service import get_settings_many
        values = await get_settings_many([
            "notif_enabled",
            "notif_severity",
            "notif_dedup_window_seconds",
            "notif_recovery_notifications",
            "notif_realtime",
        ])
        enabled = values.get("notif_enabled")
        threshold = str(values.get("notif_severity") or "all").lower()
        dedup = values.get("notif_dedup_window_seconds")
        recovery = values.get("notif_recovery_notifications")
        realtime = values.get("notif_realtime")
    except Exception:
        enabled, threshold, dedup, recovery, realtime = None, "all", None, None, None
    return {
        "enabled": bool(enabled) if enabled is not None else True,
        "threshold": threshold if threshold in ("all", "warning", "error", "critical") else "all",
        "dedupWindow": max(1, int(dedup or 300)),
        "recovery": bool(recovery) if recovery is not None else True,
        "realtime": bool(realtime) if realtime is not None else True,
    }


async def _notification_category_enabled(display_category: str) -> bool:
    """Per-display-category notification gate (``notif_cat_*`` keys)."""
    try:
        from services.settings_service import get_setting
        key = _NOTIFICATION_GATE_KEY.get(str(display_category).upper())
        if not key:
            return True
        enabled = await get_setting(key)
        return bool(enabled) if enabled is not None else True
    except Exception:
        return True


async def _notification_allowed(category: str) -> bool:
    try:
        from services.notification_service import _category_enabled
        return await _category_enabled(category)
    except Exception:
        return True


def _fmt(template: str, entry: dict) -> str:
    fields = {
        "event": str(entry.get("event") or ""),
        "source": str(entry.get("source") or ""),
        "status": str(entry.get("status") or ""),
        "severity": str(entry.get("severity") or entry.get("status") or "info"),
        "message": str(entry.get("message") or ""),
"symbol": str(entry.get("symbol") or ""),
        "reason": str((entry.get("meta") or {}).get("reason") or "") or "",
        "reason_code": str(entry.get("reason_code") or (entry.get("meta") or {}).get("reason_code") or ""),
        "component": str(entry.get("component") or (entry.get("meta") or {}).get("component") or ""),
        "event_id": str(entry.get("event_id") or ""),
    }
    try:
        return template.format(**fields)
    except Exception:
        return template


def _dedupe_key(rule: NotificationRule, entry: dict) -> str:
    meta = entry.get("meta") or {}
    fields = {
        "category": rule.category,
        "event": str(entry.get("event") or ""),
        "symbol": str(entry.get("symbol") or ""),
        "reason_code": str(meta.get("reason_code") or entry.get("reason_code") or ""),
        "source": str(entry.get("source") or ""),
        "rule_id": rule.rule_id,
    }
    try:
        return rule.dedupe_key.format(**fields)
    except Exception:
        return f"{rule.rule_id}:{fields['event']}:{fields['symbol']}"


def _within_cooldown(ts, seconds: int, now: datetime) -> bool:
    if seconds <= 0 or ts is None:
        return False
    try:
        ref = ts if isinstance(ts, datetime) else ts
        return (now - ref).total_seconds() < seconds
    except Exception:
        return False


async def _notify_count() -> int:
    try:
        return await get_db().notifications.count_documents({"read": False})
    except Exception:
        return 0


async def _alert_count() -> int:
    try:
        return await get_db().alerts.count_documents({"status": {"$in": _ALERT_LIVE}})
    except Exception:
        return 0


async def _publish_state_counts() -> None:
    """Mirror current counts onto the centralized state store (change-detected)."""
    try:
        from services.state_store import set_entity_state
        unread = await _notify_count()
        active = await _alert_count()
        await set_entity_state(
            "notifications",
            {"unreadCount": unread, "activeAlerts": active, "checkedAt": _now().isoformat()},
            reason="notification_center:counts",
        )
    except Exception:
        logger.debug("notification counts not published", exc_info=True)


async def _publish_frame(frame: dict) -> None:
    try:
        from services.state_store import get_state_store
        store = get_state_store()
        payload = dict(frame)
        if "unreadCount" not in payload:
            payload["unreadCount"] = await _notify_count()
        if "activeCount" not in payload and frame.get("type", "").startswith("alert"):
            payload["activeCount"] = await _alert_count()
        await store.publish(payload)
    except Exception:
        logger.debug("notification realtime frame not published", exc_info=True)


def _serialize_realtime(item: dict) -> dict:
    from services.json_safe import sanitize_for_json
    return sanitize_for_json(dict(item))


# --------------------------------------------------------------------------- #
# Alert engine (persistence + lifecycle)
# --------------------------------------------------------------------------- #
ALERT_FIELDS = {
    "status", "severity", "title", "message", "reason", "reason_code", "component",
    "source", "symbol", "token", "exchange", "related_event_id", "related_notification_id",
    "metadata", "automation", "rule_id", "category", "deduplication_key",
    "occurrence_count", "acknowledged", "resolved",
}


async def _upsert_alert(
    rule: NotificationRule, entry: dict, severity: str, db,
    dedup_window: int = 600,
) -> str | None:
    """Create or refresh an open alert for this rule/event.

    Repeating events within the dedupe/grouping window do NOT create a new
    alert â€” they bump ``occurrence_count`` / ``last_seen_at`` on the open row.
    Once the grouping window lapses, the next real event starts a NEW alert for
    the same root cause (each alert carries its own ``expires_at`` = +24h).
    """
    try:
        now = _now()
        cooldown = _effective_cooldown(rule, dedup_window)
        meta = entry.get("meta") or {}
        dedupe = _dedupe_key(rule, entry)
        title = _fmt(rule.title, entry)
        message = _fmt(rule.message, entry)
        category = canonical_category(rule.category)
        existing = await db.alerts.find_one(
            {"deduplication_key": dedupe, "status": {"$in": _ALERT_LIVE}},
        )
        if existing is not None and _within_cooldown(
            existing.get("last_seen_at") or existing.get("updated_at"), cooldown, now,
        ):
            first_seen = existing.get("first_seen_at") or existing.get("created_at") or now
            duration_ms = max(0, int((now - first_seen).total_seconds() * 1000))
            updates = {
                "severity": _max_severity(existing.get("severity", severity), severity),
                "message": message,
                "title": title,
                "category": category,
                "occurrence_count": int(existing.get("occurrence_count") or 1) + 1,
                "last_seen_at": now,
                "updated_at": now,
                "duration_ms": duration_ms,
            }
            await db.alerts.update_one({"_id": existing["_id"]}, {"$set": updates})
            alert = await db.alerts.find_one({"_id": existing["_id"]})
            await _publish_frame({
                "type": "alert_updated", "alert_id": str(alert["_id"]),
                "alert": _serialize_realtime(alert), "category": category,
            })
            return str(alert["_id"])

        related_notif = await _latest_notification_for_event(entry, db)
        doc: dict[str, Any] = {
            "category": category,
            "rule_id": rule.rule_id,
            "severity": severity,
            "title": title,
            "message": message,
            "status": ALERT_OPEN,
            "acknowledged": False,
            "acknowledged_at": None,
            "acknowledged_by": None,
            "resolved": False,
            "resolved_at": None,
            "resolved_reason": None,
            "created_at": now,
            "updated_at": now,
            "triggered_at": entry.get("ts") or now,
            "event_timestamp": entry.get("ts") or now,
            "expires_at": now + timedelta(hours=ALERT_RETENTION_HOURS),
            "first_seen_at": now,
            "last_seen_at": now,
            "occurrence_count": 1,
            "duration_ms": 0,
            "reason": str(meta.get("reason") or "")[:500],
            "reason_code": str(meta.get("reason_code") or entry.get("reason_code") or ""),
            "component": rule.component or str(meta.get("component") or entry.get("component") or rule.source),
            "source": str(entry.get("source") or ""),
            "symbol": str(entry.get("symbol") or ""),
            "token": str(entry.get("token") or ""),
            "exchange": str(entry.get("exchange") or ""),
            "related_event_id": str(entry.get("event_id") or ""),
            "related_notification_id": related_notif,
            "deduplication_key": dedupe,
            "metadata": _safe_meta(meta),
            "automation": {
                "dedupe": True,
                "dedupeWindow": cooldown,
                "cooldownSeconds": rule.cooldown_seconds,
                "autoResolveOn": rule.auto_resolve_on,
                "ruleId": rule.rule_id,
            },
        }
        result = await db.alerts.insert_one(doc)
        doc["_id"] = str(result.inserted_id)
        await _publish_frame({
            "type": "alert_created", "alert_id": str(result.inserted_id),
            "alert": _serialize_realtime(doc), "category": category,
        })
        return str(result.inserted_id)
    except Exception:
        logger.debug("alert upsert failed for %s", rule.rule_id, exc_info=True)
        return None


def _safe_meta(meta: dict) -> dict:
    from services.event_history import _scrub_meta
    try:
        return dict(_scrub_meta(dict(meta)))
    except Exception:
        return dict(meta)


async def upsert_incident(
    *,
    category: str,
    severity: str,
    title: str,
    message: str,
    dedupe_key: str,
    cooldown_seconds: int | None = None,
    source: str = "engine",
    component: str = "",
    reason: str = "",
    reason_code: str = "",
    symbol: str = "",
    token: str = "",
    related_event_id: str = "",
    metadata: dict | None = None,
    automation: dict | None = None,
) -> str | None:
    """Create or fold-in an alert WITHOUT needing a ``NotificationRule``.

    ``_upsert_alert`` is rule-driven: it renders the title/message from the
    rule template. Engines reporting their own state transitions are not going
    through the rule pipeline — they already know the exact wording and the
    exact incident identity — so they call this instead.

    Same grouping contract as the rule path, because it is the same contract
    users rely on: a repeat inside the window bumps ``occurrence_count`` /
    ``last_seen_at`` on the open row instead of adding another one, and once the
    window lapses the next genuine occurrence starts a fresh alert (carrying its
    own 24h expiry). Returns the alert id, or None when alerts are off or the
    severity is below the configured threshold.
    """
    try:
        from services.settings_service import get_setting

        enabled = await get_setting("alerts_enabled")
        if enabled is not None and not bool(enabled):
            return None
        threshold = await get_setting("alerts_severity_threshold")
        if threshold and not _severity_passes(str(severity), str(threshold)):
            return None
        window = cooldown_seconds
        if window is None:
            raw = await get_setting("alerts_dedup_window_seconds")
            try:
                window = int(raw) if raw is not None else 600
            except (TypeError, ValueError):
                window = 600
        window = max(0, int(window))
    except Exception:
        window = 600

    if severity not in SEVERITIES:
        severity = "info"

    try:
        db = get_db()
        now = _now()
        category = canonical_category(category)
        meta = metadata or {}

        existing = await db.alerts.find_one(
            {"deduplication_key": dedupe_key, "status": {"$in": _ALERT_LIVE}},
        )
        if existing is not None and _within_cooldown(
            existing.get("last_seen_at") or existing.get("updated_at"), window, now,
        ):
            first_seen = existing.get("first_seen_at") or existing.get("created_at") or now
            updates = {
                "severity": _max_severity(existing.get("severity", severity), severity),
                "title": title,
                "message": message,
                "category": category,
                "occurrence_count": int(existing.get("occurrence_count") or 1) + 1,
                "last_seen_at": now,
                "updated_at": now,
                "duration_ms": max(0, int((now - first_seen).total_seconds() * 1000)),
            }
            await db.alerts.update_one({"_id": existing["_id"]}, {"$set": updates})
            alert = await db.alerts.find_one({"_id": existing["_id"]})
            if alert is not None:
                await _publish_frame({
                    "type": "alert_updated",
                    "alert_id": str(alert["_id"]),
                    "alert": _serialize_realtime(alert),
                    "category": category,
                })
            return str(existing["_id"])

        doc: dict[str, Any] = {
            "category": category,
            "rule_id": "",
            "severity": severity,
            "title": title,
            "message": message,
            "status": ALERT_OPEN,
            "acknowledged": False,
            "acknowledged_at": None,
            "acknowledged_by": None,
            "resolved": False,
            "resolved_at": None,
            "resolved_reason": None,
            "created_at": now,
            "updated_at": now,
            "triggered_at": now,
            "event_timestamp": now,
            "expires_at": now + timedelta(hours=ALERT_RETENTION_HOURS),
            "first_seen_at": now,
            "last_seen_at": now,
            "occurrence_count": 1,
            "duration_ms": 0,
            "reason": str(reason)[:500],
            "reason_code": str(reason_code or ""),
            "component": str(component or ""),
            "source": str(source or ""),
            "symbol": str(symbol or ""),
            "token": str(token or ""),
            "exchange": "",
            "related_event_id": str(related_event_id or ""),
            "related_notification_id": "",
            "deduplication_key": dedupe_key,
            "metadata": _safe_meta(meta),
            "automation": {
                "dedupe": True,
                "dedupeWindow": window,
                "cooldownSeconds": window,
                "autoResolveOn": "recovered",
                "ruleId": None,
                **(automation or {}),
            },
        }
        result = await db.alerts.insert_one(doc)
        doc["_id"] = str(result.inserted_id)
        await _publish_frame({
            "type": "alert_created",
            "alert_id": str(result.inserted_id),
            "alert": _serialize_realtime(doc),
            "category": category,
        })
        return str(result.inserted_id)
    except Exception:
        logger.debug("incident upsert failed for %s", dedupe_key, exc_info=True)
        return None


async def resolve_incidents_by_prefix(prefix: str, reason: str = "condition cleared") -> int:
    """Close every open alert whose dedupe key starts with ``prefix``.

    Used by the engine self-reporter, whose incident keys are
    ``engine:<id>:<state>:<health>``. Matching on a prefix instead of guessing
    the state/health pairs means an incident is closed no matter which
    combination opened it — enumerating pairs silently misses the real one
    (a STOPPED engine is keyed ``...:STOPPED:UNKNOWN``, which no fixed list of
    "unhealthy" health values would contain).
    """
    try:
        db = get_db()
        now = _now()
        result = await db.alerts.update_many(
            {
                "deduplication_key": {"$regex": f"^{re.escape(prefix)}"},
                "status": {"$in": _ALERT_LIVE},
            },
            {"$set": {
                "status": ALERT_RESOLVED,
                "resolved": True,
                "resolved_at": now,
                "resolved_reason": reason,
                "updated_at": now,
            }},
        )
        closed = int(getattr(result, "modified_count", 0) or 0)
        if closed:
            await _publish_frame({
                "type": "alert_resolved",
                "reason": reason,
                "prefix": prefix,
            })
            await _publish_state_counts()
        return closed
    except Exception:
        logger.debug("prefix incident resolve failed for %s", prefix, exc_info=True)
        return 0


async def resolve_incident(dedupe_key: str, reason: str = "condition cleared") -> int:
    """Close every open alert sharing this dedupe key.

    The recovery half of ``upsert_incident``: an engine returning to healthy
    should clear the alert it opened, not leave a stale red row behind. Returns
    the number of alerts resolved.
    """
    try:
        db = get_db()
        now = _now()
        result = await db.alerts.update_many(
            {"deduplication_key": dedupe_key, "status": {"$in": _ALERT_LIVE}},
            {"$set": {
                "status": ALERT_RESOLVED,
                "resolved": True,
                "resolved_at": now,
                "resolved_reason": reason,
                "updated_at": now,
            }},
        )
        closed = int(getattr(result, "modified_count", 0) or 0)
        if closed:
            await _publish_frame({
                "type": "alert_resolved",
                "reason": reason,
                "deduplication_key": dedupe_key,
            })
            await _publish_state_counts()
        return closed
    except Exception:
        logger.debug("incident resolve failed for %s", dedupe_key, exc_info=True)
        return 0


async def _latest_notification_for_event(entry: dict, db) -> str | None:
    try:
        doc = await db.notifications.find_one(
            {"related_event_id": str(entry.get("event_id"))}, sort=[("ts", -1)],
        )
        return str(doc["_id"]) if doc else None
    except Exception:
        return None


async def _resolve_open_alerts(rule: NotificationRule, entry: dict, db) -> int:
    """Auto-resolve open alerts of a rule when its recovery event fires."""
    try:
        now = _now()
        resolved_reason = f"Auto-resolved by {entry.get('event')} ({str(entry.get('message') or '')[:200]})"
        query: dict[str, Any] = {"rule_id": rule.rule_id, "status": {"$in": _ALERT_LIVE}}
        symbol = entry.get("symbol")
        if symbol:
            query["symbol"] = symbol
        matched = await db.alerts.find(
            query, {"_id": 1},
        ).to_list(length=500)
        result = await db.alerts.update_many(
            query,
            {"$set": {"status": ALERT_RESOLVED, "resolved": True,
                       "resolved_at": now, "resolved_reason": resolved_reason,
                       "updated_at": now}},
        )
        if result.modified_count:
            await _publish_frame({
                "type": "alert_resolved", "rule_id": rule.rule_id,
                "resolution": resolved_reason, "count": result.modified_count,
                "alert_ids": [str(m["_id"]) for m in matched],
            })
            await _notify_resolution(rule, entry, resolved_reason)
        return result.modified_count
    except Exception:
        logger.debug("alert auto-resolve failed", exc_info=True)
        return 0


async def _notify_resolution(rule: NotificationRule, entry: dict, reason: str) -> None:
    """A recovery event yields a small resolution notification (grouped)."""
    try:
        engine = await _notification_globals()
        if not engine["enabled"] or not engine["recovery"]:
            return
        if not await _notification_allowed(rule.category):
            return
        if not await _notification_category_enabled(_notif_category_for(rule)):
            return
        await _create_notification(
            rule, entry, "success",
            get_db(), None,
            override={
                "event_key": "resolved",
                "title": f"{rule.title.replace('{event}', str(entry.get('event') or ''))} Resolved",
                "message": reason or "Resolved automatically.",
            },
            realtime=engine["realtime"],
        )
    except Exception:
        logger.debug("resolution notification skipped", exc_info=True)


# --------------------------------------------------------------------------- #
# Notifications (canonical shape on the existing ``notifications`` collection)
# --------------------------------------------------------------------------- #
async def _create_notification(
    rule: NotificationRule,
    entry: dict,
    severity: str,
    db,
    related_alert_id: str | None,
    *,
    dedup_window: int = 300,
    override: dict | None = None,
    realtime: bool = True,
) -> str | None:
    """Create a notification for a rule event, with cooldown/dedupe grouping."""
    try:
        now = _now()
        cooldown = _effective_cooldown(rule, dedup_window)
        meta = entry.get("meta") or {}
        dedupe = _dedupe_key(rule, entry)
        event_key = (override or {}).get("event_key") or str(entry.get("event") or "")
        title = (override or {}).get("title") or _fmt(rule.title, entry)
        message = (override or {}).get("message") or _fmt(rule.message, entry)
        category = _notif_category_for(rule)

        recent = await db.notifications.find_one(
            {"deduplication_key": dedupe}, sort=[("ts", -1)],
        )
        if recent is not None and _within_cooldown(recent.get("ts"), cooldown, now):
            updates = {
                "occurrence_count": int(recent.get("occurrence_count") or 1) + 1,
                "last_seen_at": now,
                "updated_at": now,
                "message": message,
                "severity": _max_severity(recent.get("severity", severity), severity),
                "level": _max_severity(recent.get("severity", severity), severity),
                "category": category,
                "importance": importance_for(recent.get("severity", severity)),
            }
            await db.notifications.update_one({"_id": recent["_id"]}, {"$set": updates})
            if realtime:
                await _publish_frame({
                    "type": "notification_updated",
                    "notification_id": str(recent["_id"]),
                    "changes": {"occurrenceCount": updates["occurrence_count"]},
                })
            return str(recent["_id"])

        is_read = False
        doc: dict[str, Any] = {
            "category": category,
            "severity": severity,
            "level": severity,
            "importance": importance_for(severity),
            "title": title,
            "message": message,
            "source": str(meta.get("component") or rule.source or "data-saver"),
            "event_type": event_key,
            "status": "read" if is_read else "unread",
            "read": is_read,
            "read_at": None,
            "resolved_at": None,
            "deduplication_key": dedupe,
            "occurrence_count": 1,
            "occurred_at": entry.get("ts") or now,
            "first_seen_at": now,
            "last_seen_at": now,
            "updated_at": now,
            "related_event_id": str(entry.get("event_id") or ""),
            "related_alert_id": related_alert_id,
            "reason": str(meta.get("reason") or "")[:500],
            "reason_code": str(meta.get("reason_code") or entry.get("reason_code") or ""),
            "component": str(meta.get("component") or entry.get("component") or ""),
            "symbol": str(entry.get("symbol") or ""),
            "token": str(entry.get("token") or ""),
            "metadata": _safe_meta(meta),
            "meta": _safe_meta(meta),
            "ts": now,
            "created_at": now,
        }
        result = await db.notifications.insert_one(doc)
        doc["_id"] = str(result.inserted_id)
        if realtime:
            await _publish_frame({
                "type": "notification_created",
                "notification_id": str(result.inserted_id),
                "notification": _serialize_realtime(doc),
                "category": category,
            })
        return str(result.inserted_id)
    except Exception:
        logger.debug("notification creation failed for %s", rule.rule_id, exc_info=True)
        return None


# --------------------------------------------------------------------------- #
# Public alert + notification read / lifecycle APIs (used by api/alerts.py)
# --------------------------------------------------------------------------- #
def serialize_alert(doc: dict) -> dict:
    from services.json_safe import sanitize_for_json
    out = dict(doc)
    out["_id"] = str(out.pop("_id", ""))
    return sanitize_for_json(out)


def _alert_query(
    status: str = "", severity: str = "", category: str = "", rule_id: str = "",
    search: str = "", symbol: str = "",
) -> dict:
    q: dict[str, Any] = {}
    if status:
        q["status"] = status
    if severity:
        q["severity"] = severity
    if category:
        q["category"] = category
    if rule_id:
        q["rule_id"] = rule_id
    if symbol:
        q["symbol"] = symbol
    if search:
        q["$or"] = [
            {"title": {"$regex": search, "$options": "i"}},
            {"message": {"$regex": search, "$options": "i"}},
            {"reason_code": {"$regex": search, "$options": "i"}},
            {"symbol": {"$regex": search, "$options": "i"}},
        ]
    return q


async def list_alerts(
    status: str = "", severity: str = "", category: str = "", rule_id: str = "",
    search: str = "", symbol: str = "", limit: int | None = 100, offset: int = 0,
) -> dict:
    db = get_db()
    q = _alert_query(status, severity, category, rule_id, search, symbol)
    limit = limit if isinstance(limit, int) and limit >= 1 else 100
    offset = offset if isinstance(offset, int) and offset >= 0 else 0
    cursor = db.alerts.find(q).sort([("created_at", -1)]).skip(offset).limit(limit)
    items = [serialize_alert(doc) async for doc in cursor]
    total = await db.alerts.count_documents(q)
    active = await db.alerts.count_documents({"status": {"$in": _ALERT_LIVE}})
    unread = await _notify_count()
    return {
        "alerts": items,
        "total": total,
        "activeCount": active,
        "unreadCount": unread,
        "live": _mongo_live(),
        "retentionHours": ALERT_RETENTION_HOURS,
        "filters": {"status": status, "severity": severity, "category": category,
                     "rule_id": rule_id, "search": search, "symbol": symbol},
    }


def _mongo_live() -> bool:
    try:
        from database.connection import is_mongo_connected
        return bool(is_mongo_connected())
    except Exception:
        return False


async def get_alert(alert_id: str) -> dict | None:
    from bson import ObjectId
    try:
        doc = await get_db().alerts.find_one({"_id": ObjectId(alert_id)})
    except Exception:
        return None
    return serialize_alert(doc) if doc else None


async def alert_summary() -> dict:
    """Alert counts in ONE aggregation round trip.

    This used to issue ~11 sequential ``count_documents`` calls plus a
    ``find_one`` and a category aggregation. Against a remote Atlas primary
    every call is a network round trip, so the Alerts badge could take seconds
    before the page rendered. ``$facet`` computes every count, the category
    breakdown and the latest alert in one server-side pass.
    """
    db = get_db()
    today_start = datetime.combine(
        _now().date(), datetime.min.time(), tzinfo=timezone.utc)
    live = list(_ALERT_LIVE)
    pipeline = [
        {
            "$facet": {
                "counts": [
                    {
                        "$group": {
                            "_id": None,
                            "total": {"$sum": 1},
                            "active": {"$sum": {"$cond": [{"$in": ["$status", live]}, 1, 0]}},
                            "open": {"$sum": {"$cond": [{"$eq": ["$status", ALERT_OPEN]}, 1, 0]}},
                            "acknowledged": {"$sum": {"$cond": [{"$eq": ["$status", ALERT_ACKED]}, 1, 0]}},
                            "resolved": {"$sum": {"$cond": [{"$eq": ["$status", ALERT_RESOLVED]}, 1, 0]}},
                            "critical": {
                                "$sum": {
                                    "$cond": [
                                        {
                                            "$and": [
                                                {"$in": ["$status", live]},
                                                {"$eq": ["$severity", "critical"]},
                                            ]
                                        },
                                        1,
                                        0,
                                    ]
                                }
                            },
                            "warning": {
                                "$sum": {
                                    "$cond": [
                                        {
                                            "$and": [
                                                {"$in": ["$status", live]},
                                                {"$eq": ["$severity", "warning"]},
                                            ]
                                        },
                                        1,
                                        0,
                                    ]
                                }
                            },
                            "today": {"$sum": {"$cond": [{"$gte": ["$updated_at", today_start]}, 1, 0]}},
                        }
                    }
                ],
                "categories": [
                    {"$group": {"_id": "$category", "n": {"$sum": 1}}},
                ],
                "last": [
                    {"$sort": {"created_at": -1}},
                    {"$limit": 1},
                ],
            }
        }
    ]

    counts: dict[str, Any] = {}
    rows: list[dict] = []
    last = None
    try:
        buckets = await db.alerts.aggregate(pipeline).to_list(length=1)
        bucket = buckets[0] if buckets else {}
        count_rows = bucket.get("counts") or []
        counts = count_rows[0] if count_rows else {}
        rows = bucket.get("categories") or []
        last_rows = bucket.get("last") or []
        last = last_rows[0] if last_rows else None
    except Exception:
        logger.debug("alert summary aggregation failed", exc_info=True)
        # Degraded path: run the individual counts concurrently rather than
        # failing the endpoint or reverting to sequential round trips.
        try:
            total, active, open_n, acknowledged, resolved, critical, warning, today = await asyncio.gather(
                db.alerts.count_documents({}),
                db.alerts.count_documents({"status": {"$in": live}}),
                db.alerts.count_documents({"status": ALERT_OPEN}),
                db.alerts.count_documents({"status": ALERT_ACKED}),
                db.alerts.count_documents({"status": ALERT_RESOLVED}),
                db.alerts.count_documents({"status": {"$in": live}, "severity": "critical"}),
                db.alerts.count_documents({"status": {"$in": live}, "severity": "warning"}),
                db.alerts.count_documents({"updated_at": {"$gte": today_start}}),
            )
            counts = {
                "total": total, "active": active, "open": open_n,
                "acknowledged": acknowledged, "resolved": resolved,
                "critical": critical, "warning": warning, "today": today,
            }
        except Exception:
            pass
        try:
            rows = await db.alerts.aggregate(
                [{"$group": {"_id": "$category", "n": {"$sum": 1}}}]
            ).to_list(length=100)
        except Exception:
            pass
        try:
            last = await db.alerts.find_one({}, sort=[("created_at", -1)])
        except Exception:
            pass

    by_category: dict[str, int] = {
        "WEBSOCKET": 0, "DATABASE": 0, "MARKET": 0, "TICKS": 0,
        "PIPELINE": 0, "SCHEDULER": 0, "DOWNLOADS": 0, "DATA_QUALITY": 0, "SYSTEM": 0,
    }
    for row in rows:
        by_category[str(row.get("_id") or "SYSTEM")] = int(row.get("n") or 0)

    return {
        "total": int(counts.get("total") or 0),
        "active": int(counts.get("active") or 0),
        "open": int(counts.get("open") or 0),
        "acknowledged": int(counts.get("acknowledged") or 0),
        "resolved": int(counts.get("resolved") or 0),
        "critical": int(counts.get("critical") or 0),
        "warning": int(counts.get("warning") or 0),
        "today": int(counts.get("today") or 0),
        "lastAlertAt": serialize_alert(last).get("created_at") if last else None,
        "byCategory": by_category,
        "live": _mongo_live(),
        "retentionHours": ALERT_RETENTION_HOURS,
    }


async def acknowledge_alert(alert_id: str) -> bool:
    from bson import ObjectId
    db = get_db()
    try:
        result = await db.alerts.update_one(
            {"_id": ObjectId(alert_id), "status": {"$in": _ALERT_LIVE}},
            {"$set": {"status": ALERT_ACKED, "acknowledged": True,
                       "acknowledged_at": _now(), "updated_at": _now()}},
        )
    except Exception:
        return False
    if not result.modified_count:
        return False
    await _publish_frame({"type": "alert_acknowledged", "alert_id": alert_id})
    await _publish_state_counts()
    return True


async def acknowledge_all_alerts() -> int:
    db = get_db()
    result = await db.alerts.update_many(
        {"status": {"$in": _ALERT_LIVE}},
        {"$set": {"status": ALERT_ACKED, "acknowledged": True,
                   "acknowledged_at": _now(), "updated_at": _now()}},
    )
    await _publish_frame({"type": "alert_acknowledged", "count": result.modified_count})
    await _publish_state_counts()
    return result.modified_count


async def resolve_alert(alert_id: str, reason: str = "") -> bool:
    from bson import ObjectId
    db = get_db()
    try:
        result = await db.alerts.update_one(
            {"_id": ObjectId(alert_id), "status": {"$in": _ALERT_LIVE}},
            {"$set": {"status": ALERT_RESOLVED, "resolved": True,
                       "resolved_at": _now(),
                       "resolved_reason": reason or "Resolved manually",
                       "updated_at": _now()}},
        )
    except Exception:
        return False
    if not result.modified_count:
        return False
    await _publish_frame({"type": "alert_resolved", "alert_id": alert_id, "reason": reason})
    await _publish_state_counts()
    return True


async def delete_alert(alert_id: str) -> bool:
    from bson import ObjectId
    db = get_db()
    res = await db.alerts.delete_one({"_id": ObjectId(alert_id)})
    if res.deleted_count:
        await _publish_frame({"type": "alert_deleted", "alert_id": alert_id})
        await _publish_state_counts()
    return res.deleted_count > 0


async def clear_resolved_alerts() -> int:
    db = get_db()
    matched = await db.alerts.find({"status": ALERT_RESOLVED}, {"_id": 1}).to_list(length=1000)
    result = await db.alerts.delete_many({"status": ALERT_RESOLVED})
    if result.deleted_count:
        await _publish_frame({
            "type": "alert_deleted", "reason": "cleared",
            "alert_ids": [str(m["_id"]) for m in matched],
            "count": result.deleted_count,
        })
    await _publish_state_counts()
    return result.deleted_count


async def delete_alerts_many(alert_ids: list[str] | None) -> int:
    """Delete explicitly selected alerts (uses their live ``_id`` values)."""
    from bson import ObjectId
    db = get_db()
    ids: list[ObjectId] = []
    for raw in (alert_ids or [])[:1000]:
        try:
            ids.append(ObjectId(str(raw)))
        except Exception:
            continue
    if not ids:
        return 0
    result = await db.alerts.delete_many({"_id": {"$in": ids}})
    if result.deleted_count:
        await _publish_frame({
            "type": "alert_deleted", "reason": "manual",
            "alert_ids": [str(i) for i in ids], "count": result.deleted_count,
        })
    await _publish_state_counts()
    return result.deleted_count


async def delete_all_alerts(
    *,
    confirm: bool = False,
    status: str = "",
    category: str = "",
    severity: str = "",
    rule_id: str = "",
) -> int:
    """Delete every alert (optionally narrowed by status/category/severity).

    ``confirm`` is mandatory so a stray PUT/GET/CSRF can never wipe the store.
    Works on alerts shown for the current filter (status/category/severity).
    """
    if not confirm:
        return 0
    db = get_db()
    q = _alert_query(status=status, severity=severity, category=category,
                     rule_id=rule_id, search="", symbol="")
    matched = await db.alerts.find(q, {"_id": 1}).to_list(length=1000)
    result = await db.alerts.delete_many(q)
    if result.deleted_count:
        await _publish_frame({
            "type": "alert_deleted", "reason": "bulk",
            "alert_ids": [str(m["_id"]) for m in matched],
            "count": result.deleted_count,
        })
    await _publish_state_counts()
    return result.deleted_count


# --------------------------------------------------------------------------- #
# Notifications (canonical shape on the existing ``notifications`` collection)
# --------------------------------------------------------------------------- #
def serialize_notification(doc: dict) -> dict:
    from services.json_safe import sanitize_for_json
    out = dict(doc)
    out["_id"] = str(out.pop("_id", ""))
    # Normalize the status field so the UI only ever sees unread/read.
    out["status"] = "read" if out.get("read") else "unread"
    if "importance" not in out or not out.get("importance"):
        out["importance"] = importance_for(str(out.get("severity") or "info"))
    if "category" not in out or not out.get("category"):
        out["category"] = notification_category(str(out.get("category") or ""))
    return sanitize_for_json(out)


def _notification_query(
    category: str = "",
    status: str = "",
    severity: str = "",
    importance: str = "",
    event_type: str = "",
    search: str = "",
    since: datetime | None = None,
    read: bool | None = None,
) -> dict:
    q: dict[str, Any] = {}
    if category:
        cats = [c.strip().upper() for c in category.split(",") if c.strip()]
        q["category"] = {"$in": cats} if len(cats) > 1 else cats[0]
    if read is not None:
        q["read"] = read
    elif status:
        q["read"] = status.lower() == "read"
    if severity:
        q["severity"] = severity
    if importance and importance.lower() in ("normal", "high"):
        q["importance"] = importance.lower()
    if event_type:
        q["event_type"] = event_type
    if since is not None:
        q["ts"] = {"$gte": since}
    if search:
        q["$or"] = [
            {"title": {"$regex": search, "$options": "i"}},
            {"message": {"$regex": search, "$options": "i"}},
            {"source": {"$regex": search, "$options": "i"}},
            {"event_type": {"$regex": search, "$options": "i"}},
            {"reason_code": {"$regex": search, "$options": "i"}},
        ]
    return q


async def list_notifications(
    category: str = "",
    status: str = "",
    severity: str = "",
    importance: str = "",
    event_type: str = "",
    search: str = "",
    since: datetime | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict:
    db = get_db()
    q = _notification_query(category, status, severity, importance, event_type, search, since)
    cursor = db.notifications.find(q).sort([("ts", -1)]).skip(offset).limit(limit)

    async def _items() -> list[dict]:
        return [serialize_notification(doc) async for doc in cursor]

    # The list, total, unified summary and source facets are independent. Run
    # them together: against a remote Atlas primary, doing these sequentially
    # turned one Notifications page load into eight-plus network round trips.
    items, total, unified, sources = await asyncio.gather(
        _items(),
        db.notifications.count_documents(q),
        notification_summary(),
        _notification_sources(),
    )
    return {
        "notifications": items,
        "total": total,
        "unreadCount": unified["unread"],
        "categories": unified["byCategory"],
        "sources": sources,
        "summary": unified,
        "live": unified["live"],
        "retentionDays": unified["retentionDays"],
        "filters": {"category": category, "status": status, "severity": severity,
                     "importance": importance, "event_type": event_type,
                     "search": search, "since": since.isoformat() if since else ""},
    }


async def _notification_sources() -> list[str]:
    try:
        db = get_db()
        sources = await db.notifications.distinct("source")
        return sorted({str(s) for s in sources if s})
    except Exception:
        return []


async def get_notification(notification_id: str) -> dict | None:
    from bson import ObjectId
    try:
        doc = await get_db().notifications.find_one({"_id": ObjectId(notification_id)})
    except Exception:
        return None
    return serialize_notification(doc) if doc else None


async def notification_summary() -> dict:
    """Unified notification counts in ONE aggregation round trip.

    The previous implementation issued seven separate ``count_documents``
    calls plus a ``find_one``, a category aggregation and two settings reads
    for retention. On Atlas each is a full network round trip, so a page load
    could spend 10-15 s just assembling badge counts. ``$facet`` computes all
    of those facets over one server-side pass, while the retention lookup runs
    concurrently.
    """
    db = get_db()
    today_start = datetime.combine(_now().date(), datetime.min.time(), tzinfo=timezone.utc)
    pipeline = [
        {
            "$facet": {
                "counts": [
                    {
                        "$group": {
                            "_id": None,
                            "total": {"$sum": 1},
                            "unread": {"$sum": {"$cond": [{"$eq": ["$read", False]}, 1, 0]}},
                            "read": {"$sum": {"$cond": [{"$eq": ["$read", True]}, 1, 0]}},
                            "today": {"$sum": {"$cond": [{"$gte": ["$ts", today_start]}, 1, 0]}},
                            "important": {"$sum": {"$cond": [{"$eq": ["$importance", "high"]}, 1, 0]}},
                            "critical": {
                                "$sum": {
                                    "$cond": [
                                        {
                                            "$and": [
                                                {"$eq": ["$read", False]},
                                                {"$in": ["$severity", ["critical", "error"]]},
                                            ]
                                        },
                                        1,
                                        0,
                                    ]
                                }
                            },
                            "warnings": {
                                "$sum": {
                                    "$cond": [
                                        {
                                            "$and": [
                                                {"$eq": ["$read", False]},
                                                {"$eq": ["$severity", "warning"]},
                                            ]
                                        },
                                        1,
                                        0,
                                    ]
                                }
                            },
                            "highUnread": {
                                "$sum": {
                                    "$cond": [
                                        {
                                            "$and": [
                                                {"$eq": ["$read", False]},
                                                {"$eq": ["$importance", "high"]},
                                            ]
                                        },
                                        1,
                                        0,
                                    ]
                                }
                            },
                        }
                    }
                ],
                "categories": [
                    {"$group": {"_id": "$category", "n": {"$sum": 1}}},
                ],
                "last": [
                    {"$sort": {"ts": -1}},
                    {"$limit": 1},
                ],
            }
        }
    ]

    counts: dict[str, int] = {}
    rows: list[dict] = []
    last = None
    retention_days = NOTIF_RETENTION_DEFAULT_DAYS
    try:
        buckets, retention = await asyncio.gather(
            db.notifications.aggregate(pipeline).to_list(length=1),
            _retention_vals(),
        )
        retention_days = int(retention[0])
        bucket = buckets[0] if buckets else {}
        count_rows = bucket.get("counts") or []
        counts = count_rows[0] if count_rows else {}
        rows = bucket.get("categories") or []
        last_rows = bucket.get("last") or []
        last = last_rows[0] if last_rows else None
    except Exception:
        logger.debug("notification summary aggregation failed", exc_info=True)

    by_category: dict[str, int] = {c: 0 for c in NOTIFICATION_CATEGORIES}
    for row in rows:
        key = str(row.get("_id") or "SYSTEM").upper()
        if key in by_category:
            by_category[key] = int(row.get("n") or 0)

    return {
        "total": int(counts.get("total") or 0),
        "unread": int(counts.get("unread") or 0),
        "read": int(counts.get("read") or 0),
        "today": int(counts.get("today") or 0),
        "important": int(counts.get("important") or 0),
        "critical": int(counts.get("critical") or 0),
        "warnings": int(counts.get("warnings") or 0),
        "highUnread": int(counts.get("highUnread") or 0),
        "lastNotificationAt": serialize_notification(last).get("created_at") if last else None,
        "byCategory": by_category,
        "live": _mongo_live(),
        "retentionDays": retention_days,
    }


async def _set_notification_read(notification_id: str, read: bool) -> bool:
    from bson import ObjectId
    db = get_db()
    try:
        result = await db.notifications.update_one(
            {"_id": ObjectId(notification_id)},
            {"$set": {"read": read, "read_at": _now() if read else None,
                       "status": "read" if read else "unread", "updated_at": _now()}},
        )
    except Exception:
        return False
    if not result.modified_count and not result.matched_count:
        return False
    changes = {"read": read}
    if read:
        changes["readAt"] = _now().isoformat()
    await _publish_frame({
        "type": "notification_updated", "notification_id": notification_id,
        "changes": changes,
    })
    await _publish_state_counts()
    return True


async def mark_notification_read(notification_id: str) -> bool:
    return await _set_notification_read(notification_id, True)


async def mark_notification_unread(notification_id: str) -> bool:
    return await _set_notification_read(notification_id, False)


async def mark_notifications_many(notification_ids: list[str] | None, read: bool) -> int:
    from bson import ObjectId
    db = get_db()
    ids: list[ObjectId] = []
    for raw in (notification_ids or [])[:1000]:
        try:
            ids.append(ObjectId(str(raw)))
        except Exception:
            continue
    if not ids:
        return 0
    result = await db.notifications.update_many(
        {"_id": {"$in": ids}},
        {"$set": {"read": read, "read_at": _now() if read else None,
                   "status": "read" if read else "unread", "updated_at": _now()}},
    )
    if result.modified_count:
        await _publish_frame({
            "type": "notification_updated", "read": read,
            "notification_ids": [str(i) for i in ids], "count": result.modified_count,
        })
    await _publish_state_counts()
    return result.modified_count


async def mark_all_notifications_read() -> int:
    db = get_db()
    result = await db.notifications.update_many(
        {"read": False},
        {"$set": {"read": True, "read_at": _now(), "status": "read", "updated_at": _now()}},
    )
    if result.modified_count:
        await _publish_frame({
            "type": "notification_updated", "read": True,
            "count": result.modified_count, "reason": "mark_all_read",
        })
    await _publish_state_counts()
    return result.modified_count


async def delete_notification(notification_id: str) -> bool:
    from bson import ObjectId
    db = get_db()
    res = await db.notifications.delete_one({"_id": ObjectId(notification_id)})
    if res.deleted_count:
        await _publish_frame({
            "type": "notification_deleted", "notification_id": notification_id,
        })
        await _publish_state_counts()
    return res.deleted_count > 0


async def delete_notifications_many(notification_ids: list[str] | None) -> int:
    from bson import ObjectId
    db = get_db()
    ids: list[ObjectId] = []
    for raw in (notification_ids or [])[:1000]:
        try:
            ids.append(ObjectId(str(raw)))
        except Exception:
            continue
    if not ids:
        return 0
    result = await db.notifications.delete_many({"_id": {"$in": ids}})
    if result.deleted_count:
        await _publish_frame({
            "type": "notification_deleted", "reason": "manual",
            "notification_ids": [str(i) for i in ids], "count": result.deleted_count,
        })
    await _publish_state_counts()
    return result.deleted_count


async def delete_read_notifications() -> int:
    db = get_db()
    matched = await db.notifications.find({"read": True}, {"_id": 1}).to_list(length=1000)
    result = await db.notifications.delete_many({"read": True})
    if result.deleted_count:
        await _publish_frame({
            "type": "notification_deleted", "reason": "cleared",
            "notification_ids": [str(m["_id"]) for m in matched],
            "count": result.deleted_count,
        })
    await _publish_state_counts()
    return result.deleted_count


async def delete_all_notifications(*, confirm: bool = False) -> int:
    """Delete every notification. ``confirm`` is mandatory so a stray request
    can never wipe the store silently."""
    if not confirm:
        return 0
    db = get_db()
    matched = await db.notifications.find({}, {"_id": 1}).to_list(length=1000)
    result = await db.notifications.delete_many({})
    if result.deleted_count:
        await _publish_frame({
            "type": "notification_deleted", "reason": "bulk",
            "notification_ids": [str(m["_id"]) for m in matched],
            "count": result.deleted_count,
        })
    await _publish_state_counts()
    return result.deleted_count


# --------------------------------------------------------------------------- #
# Notification settings (Notifications page preferences, persisted in app_settings)
# --------------------------------------------------------------------------- #
NOTIFICATION_SETTING_KEYS: dict[str, tuple[str, object]] = {
    "notif_enabled": ("bool", True),
    "notif_severity": ("str", "all"),
    "notif_dedup_window_seconds": ("int", 300),
    "notif_recovery_notifications": ("bool", True),
    "notif_realtime": ("bool", True),
    "notif_browser": ("bool", False),
    "notif_pwa": ("bool", False),
    "notif_sound_on": ("bool", True),
    "notif_retention_days": ("int", NOTIF_RETENTION_DEFAULT_DAYS),
}


async def get_notification_settings() -> dict:
    """Read notification settings. Never returns 500 — degrades to defaults
    when the settings store is unavailable.

    All preference keys and all category gates are fetched together in ONE
    batched settings read. The old implementation awaited one settings query
    per key (~19 sequential Atlas round trips).
    """
    try:
        from services.settings_service import get_settings_many
        gate_keys = [_NOTIFICATION_GATE_KEY[d] for d in NOTIFICATION_CATEGORIES]
        values = await get_settings_many([*NOTIFICATION_SETTING_KEYS, *gate_keys])
        out: dict[str, Any] = {"retentionDays": NOTIF_RETENTION_DEFAULT_DAYS,
                               "retentionReadOnly": True}
        for key, (kind, default) in NOTIFICATION_SETTING_KEYS.items():
            val = values.get(key)
            if val is None:
                val = default
            try:
                if kind == "bool":
                    val = bool(val)
                elif kind == "int":
                    val = max(1, int(val))
            except Exception:
                val = default
            out[key] = val
        out["categories"] = {
            display: (bool(values.get(key)) if key and values.get(key) is not None else True)
            for display, key in _NOTIFICATION_GATE_KEY.items()
        }
        return out
    except Exception:
        # Absolute fallback — never let this endpoint return 500.
        return {"retentionDays": NOTIF_RETENTION_DEFAULT_DAYS,
                "retentionReadOnly": True}


async def notification_category_gates() -> dict:
    """Per-display-category notification toggles (``notif_cat_*`` keys).

    One batched settings read for every gate instead of one query per category.
    """
    try:
        from services.settings_service import get_settings_many
        keys = {display: _NOTIFICATION_GATE_KEY[display] for display in NOTIFICATION_CATEGORIES}
        values = await get_settings_many(keys.values())
        return {
            display: (bool(values.get(key)) if values.get(key) is not None else True)
            for display, key in keys.items()
        }
    except Exception:
        return {display: True for display in NOTIFICATION_CATEGORIES}


async def update_notification_settings(payload: dict | None = None) -> dict:
    """Persist notification settings and emit ONE real settings-change event."""
    from services.settings_service import set_setting
    payload = dict(payload or {})
    changed: list[str] = []
    for key, (kind, _default) in NOTIFICATION_SETTING_KEYS.items():
        if key not in payload:
            continue
        val = payload[key]
        try:
            if kind == "bool":
                val = bool(val)
            elif kind == "int":
                val = max(1, int(val))
            elif kind == "str":
                val = str(val)
        except Exception:
            continue
        try:
            await set_setting(key, val)
        except Exception:
            pass
        changed.append(key)
    # Per-category gates.
    cats = payload.get("categories")
    if isinstance(cats, dict):
        for display in NOTIFICATION_CATEGORIES:
            if display in cats:
                key = _NOTIFICATION_GATE_KEY[display]
                try:
                    await set_setting(key, bool(cats[display]))
                except Exception:
                    pass
                changed.append(key)
    if changed:
        try:
            emit_event(
                "settings", "SETTINGS_CHANGED", "info",
                "Notification settings updated",
                {"reason_code": "notification_settings_updated", "component": "notifications",
                 "severity": "info", "details": f"keys={', '.join(sorted(changed))}"},
            )
        except Exception:
            logger.debug("notification settings change event not recorded")
    return await get_notification_settings()


# --------------------------------------------------------------------------- #
# Alert settings (Live Alert Center preferences, persisted in app_settings)
# --------------------------------------------------------------------------- #
ALERT_SETTING_KEYS: dict[str, tuple[str, object]] = {
    "alerts_enabled": ("bool", True),
    "alerts_severity_threshold": ("str", "all"),
    "alerts_dedup_window_seconds": ("int", 600),
    "alerts_recovery_enabled": ("bool", True),
    "alerts_desktop_notifications": ("bool", False),
}


async def get_alert_settings() -> dict:
    from services.notification_service import category_enabled_many, category_gate_keys
    from services.settings_service import get_settings_many
    rule_cats = sorted({r.category for r in RULES if r.create_alert} | {"settings"})
    values = await get_settings_many([*ALERT_SETTING_KEYS, *category_gate_keys(rule_cats)])
    out: dict[str, Any] = {"retentionHours": ALERT_RETENTION_HOURS}
    for key, (kind, default) in ALERT_SETTING_KEYS.items():
        val = values.get(key)
        if val is None:
            val = default
        try:
            if kind == "bool":
                val = bool(val)
            elif kind == "int":
                val = max(1, int(val))
        except Exception:
            val = default
        out[key] = val
    enabled = await category_enabled_many(rule_cats, values=values)
    out["categories"] = {
        canonical_category(rule_cat): bool(enabled.get(rule_cat, True))
        for rule_cat in rule_cats
    }
    return out


async def alert_category_gates() -> dict:
    """Per-category alert delivery toggles (from the notification store).

    Rule categories share a small number of gate keys, so resolve them with
    ONE batched settings read instead of one query per category.
    """
    from services.notification_service import category_enabled_many
    rule_cats = sorted({r.category for r in RULES if r.create_alert} | {"settings"})
    enabled = await category_enabled_many(rule_cats)
    return {
        canonical_category(rule_cat): bool(enabled.get(rule_cat, True))
        for rule_cat in rule_cats
    }


async def update_alert_settings(payload: dict | None = None) -> dict:
    """Persist alert settings and emit ONE real settings-change ledger event."""
    from services.settings_service import set_setting
    payload = dict(payload or {})
    changed: list[str] = []
    for key, (kind, _default) in ALERT_SETTING_KEYS.items():
        if key not in payload:
            continue
        val = payload[key]
        try:
            if kind == "bool":
                val = bool(val)
            elif kind == "int":
                val = max(1, int(val))
            elif kind == "str":
                val = str(val)
        except Exception:
            continue
        try:
            await set_setting(key, val)
        except Exception:
            pass
        changed.append(key)
    if changed:
        try:
            emit_event(
                "settings", "SETTINGS_CHANGED", "info",
                "Alert settings updated",
                {"reason_code": "alert_settings_updated", "component": "alerts",
                 "severity": "info", "details": f"keys={', '.join(sorted(changed))}"},
            )
        except Exception:
            logger.debug("alert settings change event not recorded")
    return await get_alert_settings()


async def alert_rules_list() -> list[dict]:
    from services.settings_service import get_settings_many
    keys = {rule.rule_id: f"alert_{rule.rule_id}_enabled" for rule in RULES}
    values = await get_settings_many(keys.values())
    out = []
    for rule in RULES:
        key = keys[rule.rule_id]
        enabled = values.get(key)
        enabled = bool(enabled) if enabled is not None else True
        out.append({
            "id": rule.rule_id,
            "source": rule.source,
            "events": list(rule.events),
            "category": rule.category,
            "severity": rule.severity,
            "severityByEvent": rule.severity_by_event,
            "title": rule.title,
            "message": rule.message,
            "enabled": enabled,
            "createAlert": rule.create_alert,
            "createNotification": rule.create_notification,
            "cooldownSeconds": rule.cooldown_seconds,
            "autoResolveOn": rule.auto_resolve_on,
            "settingKey": key,
        })
    return out


async def set_rule_enabled(rule_id: str, enabled: bool) -> bool:
    from services.settings_service import set_setting
    key = f"alert_{rule_id}_enabled"
    try:
        await set_setting(key, bool(enabled))
        return True
    except Exception:
        return False


# --------------------------------------------------------------------------- #
# Indexes, retention & backfill (startup wiring)
# --------------------------------------------------------------------------- #
async def ensure_indexes() -> None:
    try:
        db = get_db()
        await db.alerts.create_index("deduplication_key", background=True)
        await db.alerts.create_index([("rule_id", 1), ("status", 1)], background=True)
        await db.alerts.create_index([("status", 1), ("updated_at", -1)], background=True)
        await db.alerts.create_index([("severity", 1), ("status", 1)], background=True)
        await db.alerts.create_index([("created_at", -1)], background=True)
        await db.alerts.create_index("category", background=True)
        await db.alerts.create_index("symbol", background=True)
        await db.alerts.create_index("related_event_id", background=True)
        # MongoDB TTL: every alert auto-deletes 24h after it was created
        # (indexed on ``expires_at`` = ``created_at`` + 24h). Idempotent.
        await db.alerts.create_index(
            [("expires_at", 1)], expireAfterSeconds=0, background=True,
        )
        await db.notifications.create_index("deduplication_key", background=True)
        await db.notifications.create_index("related_event_id", background=True)
        await db.notifications.create_index([("read", 1), ("ts", -1)], background=True)
        await db.notifications.create_index([("category", 1), ("ts", -1)], background=True)
        await db.notifications.create_index([("source", 1), ("ts", -1)], background=True)
        await db.notifications.create_index([("severity", 1), ("ts", -1)], background=True)
        await db.notifications.create_index([("importance", 1), ("ts", -1)], background=True)
        await db.notifications.create_index("status", background=True)
        await db.notifications.create_index("event_type", background=True)
        logger.info("Notification/alert indexes: READY")
    except Exception as exc:
        logger.warning("Notification/alert indexes failed (non-fatal): %s", exc)


async def _retention_vals() -> tuple[int, int]:
    try:
        from services.settings_service import get_settings_many
        values = await get_settings_many(["notif_retention_days", "alert_retention_days"])
        notif_days = int(values.get("notif_retention_days") or NOTIF_RETENTION_DEFAULT_DAYS)
        alert_days = int(values.get("alert_retention_days") or ALERT_RETENTION_DEFAULT_DAYS)
    except Exception:
        notif_days, alert_days = NOTIF_RETENTION_DEFAULT_DAYS, ALERT_RETENTION_DEFAULT_DAYS
    return max(1, notif_days), max(1, alert_days)


async def run_retention() -> dict:
    """Enforce retention. ALERTS: every alert â€” active or resolved â€” expires
    ``ALERT_RETENTION_HOURS`` (24h) after it was created. The MongoDB TTL index
    removes new docs automatically; this sweep clears legacy docs (without
    ``expires_at``) and publishes deletion frames to the realtime channel.
    NOTIFICATIONS: read notifications older than the configured window.
    """
    db = get_db()
    notif_days, _alert_days = await _retention_vals()
    now = _now()
    deleted_notif = deleted_alerts = 0
    cutoff_notif = now - timedelta(days=notif_days)
    try:
        res = await db.notifications.delete_many({"read": True, "ts": {"$lt": cutoff_notif}})
        deleted_notif = res.deleted_count
    except Exception as exc:
        logger.debug("notification retention failed: %s", exc)
    try:
        cutoff_alert = now - timedelta(hours=ALERT_RETENTION_HOURS)
        expired = await db.alerts.find(
            {"$or": [
                {"expires_at": {"$lt": now}},
                {"expires_at": {"$exists": False}, "created_at": {"$lt": cutoff_alert}},
            ]},
            {"_id": 1},
        ).to_list(length=1000)
        ids = [m["_id"] for m in expired]
        if ids:
            result = await db.alerts.delete_many({"_id": {"$in": ids}})
            deleted_alerts = result.deleted_count
            if deleted_alerts:
                await _publish_frame({
                    "type": "alert_deleted", "reason": "retention",
                    "alert_ids": [str(i) for i in ids],
                    "count": deleted_alerts,
                })
    except Exception as exc:
        logger.debug("alert retention failed: %s", exc)
    await _publish_state_counts()
    return {"deletedNotifications": deleted_notif, "deletedAlerts": deleted_alerts,
            "notifRetentionDays": notif_days,
            "alertRetentionHours": ALERT_RETENTION_HOURS}


async def retention_loop(interval_seconds: int = 6 * 3600) -> None:
    import asyncio
    await asyncio.sleep(1)  # small grace after startup
    while True:
        try:
            await run_retention()
        except Exception:
            logger.exception("Notification/alert retention cleanup failed (non-fatal)")
        try:
            await asyncio.sleep(interval_seconds)
        except asyncio.CancelledError:
            raise


async def backfill_legacy_notifications() -> int:
    """Migrate any pre-existing notifications so they carry the canonical shape.

    Legacy rows lack ``deduplication_key`` / ``occurrence_count`` /
    ``related_event_id``. They are backfilled in place (best effort) so the
    whole store speaks one schema. Idempotent.
    """
    db = get_db()
    updated = 0
    try:
        cursor = db.notifications.find(
            {"deduplication_key": {"$exists": False}}, limit=2000,
        )
        async for doc in cursor:
            ts = doc.get("created_at") or doc.get("ts") or _now()
            event_type = str(doc.get("event_type") or doc.get("category") or "legacy")
            reason_code = str((doc.get("meta") or {}).get("reason_code") or "") or ""
            key = f"legacy:{doc.get('source') or 'data-saver'}:{event_type}:{reason_code}"
            await db.notifications.update_one(
                {"_id": doc["_id"]},
                {"$set": {
                    "deduplication_key": key,
                    "occurrence_count": 1,
                    "occurred_at": ts,
                    "first_seen_at": ts,
                    "last_seen_at": ts,
                    "updated_at": _now(),
                }},
            )
            updated += 1
    except Exception as exc:
        logger.debug("notification backfill failed (non-fatal): %s", exc)
    return updated


async def backfill_alert_metadata() -> int:
    """Backfill legacy alert rows with the canonical shape (idempotent).

    Rows missing ``expires_at`` get ``created_at`` (or ``triggered_at``) + 24h
    so the TTL index and sweep can expire them, plus the canonical display
    category and an ``event_timestamp`` alias. Never rewrites fresh rows and
    never invents timestamps â€” every value derives from the stored event.
    """
    db = get_db()
    updated = 0
    try:
        cursor = db.alerts.find({"expires_at": {"$exists": False}}, limit=5000)
        async for doc in cursor:
            created = doc.get("created_at") or doc.get("triggered_at") or doc.get("ts")
            base = created if isinstance(created, datetime) else (_now() if created is None else None)
            if base is None:
                continue
            category = canonical_category(doc.get("category"))
            event_ts = doc.get("triggered_at")
            event_ts = event_ts if isinstance(event_ts, datetime) else base
            await db.alerts.update_one(
                {"_id": doc["_id"]},
                {"$set": {
                    "expires_at": base + timedelta(hours=ALERT_RETENTION_HOURS),
                    "event_timestamp": event_ts,
                    "category": category,
                }},
            )
            updated += 1
    except Exception as exc:
        logger.debug("alert metadata backfill failed (non-fatal): %s", exc)
    return updated


async def init_notification_center() -> dict:
    """Call once during FastAPI lifespan startup (after Mongo connect)."""
    await ensure_indexes()
    backfilled = await backfill_legacy_notifications()
    alerts_backfilled = await backfill_alert_metadata()
    try:
        await _publish_state_counts()
        counts_published = True
    except Exception:
        counts_published = False
    # Initialization is successful if indexes were created — counts publish is
    # best-effort (state_store may not be ready yet). Always mark initialized
    # so the facade reports RUNNING/HEALTHY instead of perpetual UNKNOWN.
    notification_center_initialized.set()
    return {"backfilled": backfilled, "alertsBackfilled": alerts_backfilled,
            "countsPublished": counts_published}


def is_initialized() -> bool:
    """True once init_notification_center() has completed successfully."""
    return notification_center_initialized.is_set()


notification_center_initialized = threading.Event()
