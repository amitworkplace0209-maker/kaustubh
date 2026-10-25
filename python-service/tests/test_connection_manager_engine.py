"""Tests for the Connection Manager Engine (services/connection_manager_engine.py)."""

import unittest
from unittest import mock
from unittest.mock import AsyncMock

from core.engines.engine_base import EngineCategory, EngineHealth
from services.connection_manager_engine import ConnectionManagerEngine

# Import the singleton to patch its methods
from connection_engine import connection_engine as ce_singleton


class ConnectionManagerEngineTest(unittest.IsolatedAsyncioTestCase):
    def test_identity(self):
        e = ConnectionManagerEngine()
        self.assertEqual(e.engine_id, "connection_manager")
        self.assertEqual(e.engine_name, "Connection Manager Engine")
        self.assertEqual(e.engine_category, EngineCategory.CONTROL)

    async def test_start_registers_dependencies(self):
        e = ConnectionManagerEngine()
        with mock.patch("database.connection.is_mongo_connected", return_value=True):
            ok = await e.start()
        self.assertTrue(ok)
        self.assertTrue(e.is_running)
        self.assertEqual(
            e.get_dependencies(),
            ["session_manager", "feature_engine", "websocket_engine", "scheduler"],
        )

    async def test_health_check_healthy_when_mongo_connected(self):
        e = ConnectionManagerEngine()
        mock_status = {"started": True, "stats": {"activeConnections": 3, "messagesDropped": 5}}
        mock_health = {"state": "HEALTHY", "reason": "feed=FRESH, active=3, dropped=5"}
        with mock.patch("database.connection.is_mongo_connected", return_value=True), \
             mock.patch.object(ce_singleton, "status", return_value=mock_status), \
             mock.patch.object(ce_singleton, "health", return_value=mock_health):
            health = await e.health_check()
        self.assertEqual(health, EngineHealth.HEALTHY)

    async def test_health_check_degraded_on_stale_feed(self):
        e = ConnectionManagerEngine()
        mock_status = {"started": True, "stats": {"activeConnections": 2, "messagesDropped": 0}}
        mock_health = {"state": "DEGRADED", "reason": "feed=STALE, dropped=0, active=2"}
        with mock.patch("database.connection.is_mongo_connected", return_value=True), \
             mock.patch.object(ce_singleton, "status", return_value=mock_status), \
             mock.patch.object(ce_singleton, "health", return_value=mock_health):
            health = await e.health_check()
        self.assertEqual(health, EngineHealth.DEGRADED)

    async def test_health_check_degraded_on_high_dropped(self):
        e = ConnectionManagerEngine()
        mock_status = {"started": True, "stats": {"activeConnections": 1, "messagesDropped": 1500}}
        mock_health = {"state": "DEGRADED", "reason": "feed=FRESH, dropped=1500, active=1"}
        with mock.patch("database.connection.is_mongo_connected", return_value=True), \
             mock.patch.object(ce_singleton, "status", return_value=mock_status), \
             mock.patch.object(ce_singleton, "health", return_value=mock_health):
            health = await e.health_check()
        self.assertEqual(health, EngineHealth.DEGRADED)

    async def test_health_check_db_unavailable(self):
        e = ConnectionManagerEngine()
        with mock.patch("database.connection.is_mongo_connected", return_value=False):
            health = await e.health_check()
        self.assertEqual(health, EngineHealth.DEGRADED)

    async def test_reconcile_calls_engine(self):
        e = ConnectionManagerEngine()
        mock_result = {"ok": True, "added": 5, "removed": 2}
        with mock.patch("api.ws_engine.get_wired_engine") as mock_get:
            mock_engine = mock.AsyncMock()
            mock_engine.reconcile_broker_subscriptions = AsyncMock(return_value=mock_result)
            mock_get.return_value = mock_engine
            result = await e.reconcile()
        self.assertEqual(result["ok"], True)
        self.assertEqual(result["reconcile"], mock_result)

    async def test_reconcile_engine_not_ready(self):
        e = ConnectionManagerEngine()
        with mock.patch("api.ws_engine.get_wired_engine", return_value=None):
            result = await e.reconcile()
        self.assertFalse(result["ok"])

    async def test_get_field_requirements(self):
        e = ConnectionManagerEngine()
        mock_result = {"status": "AVAILABLE", "resolvedFields": ["ltp", "volume"]}
        with mock.patch.object(ce_singleton, "_feature_output_for", return_value=None), \
             mock.patch.object(ce_singleton, "_feature_source_ok", return_value=True), \
             mock.patch("connection_engine.field_requirements.resolve_requirements", return_value=mock_result):
            result = await e.get_field_requirements(["ltp", "volume"], instrument_token="12345")
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["status"], "AVAILABLE")

    async def test_get_available_fields(self):
        e = ConnectionManagerEngine()
        mock_result = {"sources": ["MARKET_DATA_WEBSOCKET", "FEATURE_ENGINE"]}
        with mock.patch("connection_engine.field_requirements.available_fields", return_value=mock_result):
            result = await e.get_available_fields()
        self.assertTrue(result["ok"])
        self.assertIn("sources", result["data"])

    async def test_status_snapshot_includes_connection_engine(self):
        e = ConnectionManagerEngine()
        mock_status = {"started": True, "stats": {"activeConnections": 2}}
        with mock.patch.object(ce_singleton, "status", return_value=mock_status):
            snap = e.status_snapshot()
        self.assertEqual(snap["connectionEngine"], mock_status)


if __name__ == "__main__":
    unittest.main()