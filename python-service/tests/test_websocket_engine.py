"""Tests for the WebSocket Engine wrapper (services/websocket_engine.py)."""

import unittest
from unittest import mock
from unittest.mock import AsyncMock

from core.engines.engine_base import EngineCategory, EngineHealth
from services.websocket_engine import WebSocketEngineWrapper


class WebSocketEngineWrapperTest(unittest.IsolatedAsyncioTestCase):
    def test_identity(self):
        e = WebSocketEngineWrapper()
        self.assertEqual(e.engine_id, "websocket_engine")
        self.assertEqual(e.engine_name, "Market Data WebSocket Engine")
        self.assertEqual(e.engine_category, EngineCategory.MARKET_DATA)

    async def test_start_registers_dependencies(self):
        e = WebSocketEngineWrapper()
        with mock.patch("database.connection.is_mongo_connected", return_value=True):
            ok = await e.start()
        self.assertTrue(ok)
        self.assertTrue(e.is_running)
        self.assertEqual(
            e.get_dependencies(),
            ["session_manager", "connection_manager", "feature_engine", "scheduler"],
        )

    async def test_health_check_healthy_when_connected(self):
        e = WebSocketEngineWrapper()
        mock_health = {
            "connection_ok": True,
            "feed_stale": False,
            "ram": {"severity": "NORMAL"},
        }
        mock_status = {"subscription_count": 50}
        with mock.patch("database.connection.is_mongo_connected", return_value=True), \
             mock.patch("ws_socket.engine.engine.engine.health", return_value=mock_health), \
             mock.patch("ws_socket.engine.engine.engine.status", return_value=mock_status):
            health = await e.health_check()
        self.assertEqual(health, EngineHealth.HEALTHY)

    async def test_health_check_degraded_on_disconnected(self):
        e = WebSocketEngineWrapper()
        mock_health = {
            "connection_ok": False,
            "feed_stale": False,
            "ram": {"severity": "NORMAL"},
        }
        with mock.patch("database.connection.is_mongo_connected", return_value=True), \
             mock.patch("ws_socket.engine.engine.engine.health", return_value=mock_health):
            health = await e.health_check()
        self.assertEqual(health, EngineHealth.DEGRADED)

    async def test_health_check_degraded_on_stale_feed(self):
        e = WebSocketEngineWrapper()
        mock_health = {
            "connection_ok": True,
            "feed_stale": True,
            "ram": {"severity": "NORMAL"},
        }
        with mock.patch("database.connection.is_mongo_connected", return_value=True), \
             mock.patch("ws_socket.engine.engine.engine.health", return_value=mock_health):
            health = await e.health_check()
        self.assertEqual(health, EngineHealth.DEGRADED)

    async def test_health_check_degraded_on_ram_critical(self):
        e = WebSocketEngineWrapper()
        mock_health = {
            "connection_ok": True,
            "feed_stale": False,
            "ram": {"severity": "CRITICAL"},
        }
        with mock.patch("database.connection.is_mongo_connected", return_value=True), \
             mock.patch("ws_socket.engine.engine.engine.health", return_value=mock_health):
            health = await e.health_check()
        self.assertEqual(health, EngineHealth.DEGRADED)

    async def test_health_check_db_unavailable(self):
        e = WebSocketEngineWrapper()
        with mock.patch("database.connection.is_mongo_connected", return_value=False):
            health = await e.health_check()
        self.assertEqual(health, EngineHealth.DEGRADED)

    async def test_reconcile_calls_engine(self):
        e = WebSocketEngineWrapper()
        mock_result = {"ok": True, "wanted": 10, "to_subscribe": 2, "to_unsubscribe": 1, "count": 2}
        with mock.patch("ws_socket.engine.engine.engine.reconcile_broker_subscriptions", new=AsyncMock(return_value=mock_result)):
            result = await e.reconcile()
        self.assertEqual(result, mock_result)

    async def test_control_connection_start(self):
        e = WebSocketEngineWrapper()
        mock_owner = mock.MagicMock()
        mock_owner.start_supervisor = mock.MagicMock()
        with mock.patch("ws_socket.engine.engine.engine.owner", mock_owner):
            result = await e.control_connection("connect")
        self.assertTrue(result["ok"])

    async def test_control_connection_stop(self):
        e = WebSocketEngineWrapper()
        mock_owner = mock.MagicMock()
        mock_owner.stop_supervisor = mock.MagicMock()
        with mock.patch("ws_socket.engine.engine.engine.owner", mock_owner):
            result = await e.control_connection("disconnect")
        self.assertTrue(result["ok"])

    async def test_control_connection_reconnect(self):
        e = WebSocketEngineWrapper()
        mock_owner = mock.MagicMock()
        mock_owner.reconnect = mock.MagicMock()
        with mock.patch("ws_socket.engine.engine.engine.owner", mock_owner):
            result = await e.control_connection("reconnect")
        self.assertTrue(result["ok"])

    async def test_control_connection_owner_missing(self):
        e = WebSocketEngineWrapper()
        with mock.patch("ws_socket.engine.engine.engine.owner", None):
            result = await e.control_connection("connect")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "no connection owner")

    async def test_set_pin(self):
        e = WebSocketEngineWrapper()
        mock_result = {"pin": {"instrument_key": "nse_cm|12345"}, "sync": {"ok": True}}
        with mock.patch("ws_socket.engine.engine.engine.set_pin", new=AsyncMock(return_value=mock_result)):
            result = await e.set_pin({"instrument_key": "nse_cm|12345", "symbol": "RELIANCE"})
        self.assertEqual(result, mock_result)

    async def test_unset_pin(self):
        e = WebSocketEngineWrapper()
        mock_result = {"removed": True, "sync": {"ok": True}}
        with mock.patch("ws_socket.engine.engine.engine.unset_pin", new=AsyncMock(return_value=mock_result)):
            result = await e.unset_pin("nse_cm|12345")
        self.assertEqual(result, mock_result)

    async def test_status_snapshot_includes_engine_status(self):
        e = WebSocketEngineWrapper()
        mock_status = {"subscription_count": 25}
        mock_quality = {"overall": "LIVE", "instruments": {}}
        mock_live = {"instrument_count": 20, "ticks_per_second": 150.0}
        mock_resources = {"ram_percent": 45.0}
        with mock.patch("ws_socket.engine.engine.engine.status", return_value=mock_status), \
             mock.patch("ws_socket.engine.engine.engine.quality_snapshot", return_value=mock_quality), \
             mock.patch("ws_socket.engine.engine.engine.live_feed", return_value=mock_live), \
             mock.patch("ws_socket.engine.engine.engine.resources_view", return_value=mock_resources), \
             mock.patch("ws_socket.engine.engine.engine.owner", None):
            snap = e.status_snapshot()
        self.assertEqual(snap["engineStatus"], mock_status)
        self.assertEqual(snap["feedQuality"], mock_quality)
        self.assertEqual(snap["liveFeed"], mock_live)
        self.assertEqual(snap["resources"], mock_resources)
        self.assertIsNone(snap["ownerStatus"])


if __name__ == "__main__":
    unittest.main()