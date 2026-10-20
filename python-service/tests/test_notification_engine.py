"""Tests for the Notification Engine (services/notification_engine.py)."""

import unittest
from unittest import mock
from unittest.mock import AsyncMock

from core.engines.engine_base import EngineCategory, EngineHealth
from services.notification_engine import NotificationEngine


class NotificationEngineTest(unittest.IsolatedAsyncioTestCase):
    def test_identity(self):
        e = NotificationEngine()
        self.assertEqual(e.engine_id, "notification_engine")
        self.assertEqual(e.engine_name, "Notification Engine")
        self.assertEqual(e.engine_category, EngineCategory.CONTROL)

    async def test_start_registers_dependencies(self):
        e = NotificationEngine()
        with mock.patch("database.connection.is_mongo_connected", return_value=True):
            ok = await e.start()
        self.assertTrue(ok)
        self.assertTrue(e.is_running)
        self.assertEqual(e.get_dependencies(), ["storage_engine"])

    async def test_health_check_healthy_when_mongo_connected(self):
        e = NotificationEngine()
        with mock.patch("database.connection.is_mongo_connected", return_value=True), \
             mock.patch.object(e, "_get_active_alerts", new=AsyncMock(return_value=3)), \
             mock.patch.object(e, "_get_unread_count", new=AsyncMock(return_value=5)):
            health = await e.health_check()
        self.assertEqual(health, EngineHealth.HEALTHY)

    async def test_health_check_db_unavailable(self):
        e = NotificationEngine()
        with mock.patch("database.connection.is_mongo_connected", return_value=False):
            health = await e.health_check()
        self.assertEqual(health, EngineHealth.DEGRADED)

    async def test_flush_runs_retention(self):
        e = NotificationEngine()
        with mock.patch("services.notification_center.run_retention", new=AsyncMock(return_value={"deletedNotifications": 5, "deletedAlerts": 2})):
            result = await e.flush()
        self.assertEqual(result["deletedNotifications"], 5)
        self.assertEqual(result["deletedAlerts"], 2)

    async def test_test_notification_creates_doc(self):
        e = NotificationEngine()
        mock_doc = {"_id": "test123", "title": "Test"}
        with mock.patch("services.notification_service.notify", new=AsyncMock(return_value=mock_doc)):
            result = await e.test_notification("SYSTEM", "info")
        self.assertTrue(result["ok"])
        self.assertEqual(result["notification"]["_id"], "test123")

    async def test_test_notification_fails_gracefully(self):
        e = NotificationEngine()
        with mock.patch("services.notification_service.notify", new=AsyncMock(return_value=None)):
            result = await e.test_notification("SYSTEM", "error")
        self.assertFalse(result["ok"])

    async def test_status_snapshot_includes_cached_summaries(self):
        e = NotificationEngine()
        e._cached_alert_summary = {"total": 10, "active": 3}
        e._cached_notification_summary = {"unread": 5, "total": 100}
        e._cached_rules = [{"rule_id": "ws_disconnected"}]

        snap = e.status_snapshot()
        self.assertEqual(snap["alertSummary"], {"total": 10, "active": 3})
        self.assertEqual(snap["notificationSummary"], {"unread": 5, "total": 100})
        self.assertEqual(snap["rules"], [{"rule_id": "ws_disconnected"}])

    async def test_async_status_snapshot_refreshes_cache(self):
        e = NotificationEngine()
        with mock.patch("services.notification_center.alert_summary", new=AsyncMock(return_value={"total": 20})), \
             mock.patch("services.notification_center.notification_summary", new=AsyncMock(return_value={"unread": 10})), \
             mock.patch("services.notification_center.alert_rules_list", new=AsyncMock(return_value=[{"rule_id": "test"}])), \
             mock.patch.object(e, "_get_active_alerts", new=AsyncMock(return_value=2)), \
             mock.patch.object(e, "_get_unread_count", new=AsyncMock(return_value=10)):
            snap = await e.async_status_snapshot()
        self.assertEqual(snap["alertSummary"]["total"], 20)
        self.assertEqual(snap["notificationSummary"]["unread"], 10)
        self.assertEqual(snap["rules"], [{"rule_id": "test"}])


if __name__ == "__main__":
    unittest.main()