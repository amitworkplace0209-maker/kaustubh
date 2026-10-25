"""Notification Engine — centralized event-to-notification infrastructure.

Wraps the existing notification_center (alert rule engine, persistence, realtime
delivery) as an EngineBase so the Service Control Center can observe/control it.

Design per docs/engines/notification-engine.md:
- Source engines emit events via emit_event()
- Notification Engine classifies, deduplicates, cools down, groups, persists
- Alerts are a first-class notification type (no separate Alert Engine)
- Delivery channels: In-App, Toast, Sound, Browser/PWA
"""

from __future__ import annotations

import logging
from typing import Any

from core.engines.engine_config import ConfigField, read_only
from core.engines.engine_base import (
    EngineBase,
    EngineHealth,
    EngineCategory,
)

logger = logging.getLogger("app.notification_engine")


class NotificationEngine(EngineBase):
    engine_id = "notification_engine"
    engine_name = "Notification Engine"
    engine_category = EngineCategory.CONTROL
    engine_version = "1.0.0"

    # Per-rule notification toggles are edited on the Notifications page, which
    # owns that store; the engine summary reports the wiring, not knobs.
    config_fields = (
        read_only("collections", "Collections"),
        read_only("realtimeChannel", "Realtime Channel"),
        read_only("retention", "Retention"),
        read_only("deduplication", "Deduplication"),
        read_only("cooldown", "Cooldown"),
        read_only("autoResolve", "Auto Resolve"),
    )

    def __init__(self) -> None:
        super().__init__()
        self._last_alert_count = 0
        self._last_notification_count = 0
        self._cached_alert_summary: dict = {}
        self._cached_notification_summary: dict = {}
        self._cached_rules: list = []

    # ------------------------------------------------------------------ #
    # Lifecycle
    # ------------------------------------------------------------------ #
    async def _on_start(self) -> None:
        self.set_dependencies(["storage_engine"])
        self.set_config_summary({
            "collections": ["notifications", "alerts", "system_events"],
            "realtimeChannel": "system (state_store)",
            "retention": {
                "notificationsDays": 60,
                "alertsHours": 24,
            },
            "deduplication": "enabled (configurable window)",
            "cooldown": "enabled (per-rule, capped by global window)",
            "autoResolve": "enabled (configurable)",
        })
        await self._async_refresh_metrics()
        logger.info("[NOTIFICATION-ENGINE] engine started")
        self.record_event()

    async def _on_stop(self) -> None:
        await self._async_refresh_metrics()
        logger.info("[NOTIFICATION-ENGINE] engine stopped")

    # ------------------------------------------------------------------ #
    # Health
    # ------------------------------------------------------------------ #
    async def _on_health_check(self) -> EngineHealth:
        try:
            from database.connection import is_mongo_connected

            if not is_mongo_connected():
                self._set_health(EngineHealth.DEGRADED, "MongoDB disconnected")
                return self.health

            active_alerts = await self._get_active_alerts()
            unread_notifications = await self._get_unread_count()

            self._set_health(
                EngineHealth.HEALTHY,
                f"{active_alerts} active alerts, {unread_notifications} unread notifications",
            )
            self.heartbeat()
            return self.health
        except Exception as exc:
            self.record_error("health_check_error", str(exc))
            self._set_health(EngineHealth.UNHEALTHY, str(exc))
            return self.health

    # ------------------------------------------------------------------ #
    # Helpers
    # ------------------------------------------------------------------ #
    async def _get_active_alerts(self) -> int:
        try:
            from database.connection import get_db
            from services.notification_center import _ALERT_LIVE
            db = get_db()
            return await db.alerts.count_documents({"status": {"$in": _ALERT_LIVE}})
        except Exception:
            return 0

    async def _get_unread_count(self) -> int:
        try:
            from database.connection import get_db
            db = get_db()
            return await db.notifications.count_documents({"read": False})
        except Exception:
            return 0

    # ------------------------------------------------------------------ #
    # Control
    # ------------------------------------------------------------------ #
    async def flush(self) -> dict[str, Any]:
        """Run retention sweep immediately (operational/test)."""
        from services import notification_center as ncenter
        result = await ncenter.run_retention()
        await self._async_refresh_metrics()
        self.record_event()
        return result

    async def test_notification(self, category: str = "SYSTEM", severity: str = "info") -> dict[str, Any]:
        """Create a test notification (bypasses settings gates)."""
        from services.notification_service import notify as _ledger_notify

        doc = await _ledger_notify(
            category=category,
            severity=severity,
            title=f"Test {category} Notification",
            message=f"This is a test {severity} notification from Notification Engine.",
            source="notification_engine_test",
            event_type="TEST",
            metadata={"test": True},
            bypass_enabled=True,
        )
        if doc:
            await self._async_refresh_metrics()
            self.record_event()
        return {"ok": doc is not None, "notification": doc}

    # ------------------------------------------------------------------ #
    # Metrics / status
    # ------------------------------------------------------------------ #
    async def _async_refresh_metrics(self) -> None:
        try:
            active = await self._get_active_alerts()
            unread = await self._get_unread_count()
            self.set_metric("activeAlerts", active)
            self.set_metric("unreadNotifications", unread)
            self._last_alert_count = active
            self._last_notification_count = unread

            # Cache summaries for sync status_snapshot
            from services import notification_center as ncenter
            self._cached_alert_summary = await ncenter.alert_summary()
            self._cached_notification_summary = await ncenter.notification_summary()
            self._cached_rules = await ncenter.alert_rules_list()
        except Exception as exc:
            self.record_error("async_metrics_error", str(exc))

    def status_snapshot(self) -> dict:
        base = super().status_snapshot()
        base["metrics"]["custom"] = dict(self.get_metrics().get("custom", {}))
        base["realStatus"] = True
        base["alertSummary"] = self._cached_alert_summary
        base["notificationSummary"] = self._cached_notification_summary
        base["rules"] = self._cached_rules
        return base

    async def async_status_snapshot(self) -> dict:
        """Async version - refreshes cache then returns snapshot."""
        await self._async_refresh_metrics()
        return self.status_snapshot()


# Module singleton
notification_engine = NotificationEngine()