"""Tests for the Session Manager Engine (services/session_manager_engine.py)."""

import unittest
from unittest import mock
from unittest.mock import AsyncMock

from core.engines.engine_base import EngineCategory, EngineHealth
from services.session_manager_engine import SessionManagerEngine


class SessionManagerEngineTest(unittest.IsolatedAsyncioTestCase):
    def test_identity(self):
        e = SessionManagerEngine()
        self.assertEqual(e.engine_id, "session_manager")
        self.assertEqual(e.engine_name, "Session Manager Engine")
        self.assertEqual(e.engine_category, EngineCategory.CONTROL)

    async def test_start_registers_dependencies(self):
        e = SessionManagerEngine()
        with mock.patch("database.connection.is_mongo_connected", return_value=True):
            ok = await e.start()
        self.assertTrue(ok)
        self.assertTrue(e.is_running)
        self.assertEqual(
            e.get_dependencies(),
            ["connection_manager", "websocket_engine", "scheduler"],
        )

    async def test_health_check_healthy_when_mongo_connected(self):
        e = SessionManagerEngine()
        mock_snap = {
            "active": True,
            "counts": {"total": 100},
            "health": {"ok": True, "reasons": []},
        }
        with mock.patch("database.connection.is_mongo_connected", return_value=True), \
             mock.patch("services.session.session_manager.session_manager.phase3_snapshot", return_value=mock_snap):
            health = await e.health_check()
        self.assertEqual(health, EngineHealth.HEALTHY)

    async def test_health_check_degraded_when_mongo_disconnected(self):
        e = SessionManagerEngine()
        with mock.patch("database.connection.is_mongo_connected", return_value=False):
            health = await e.health_check()
        self.assertEqual(health, EngineHealth.DEGRADED)

    async def test_health_check_unhealthy_on_exception(self):
        e = SessionManagerEngine()
        with mock.patch("database.connection.is_mongo_connected", side_effect=Exception("db error")):
            health = await e.health_check()
        self.assertEqual(health, EngineHealth.UNHEALTHY)

    async def test_reconcile_calls_session_manager(self):
        e = SessionManagerEngine()
        mock_result = {"expired": 2, "normalized": 5}
        with mock.patch("services.session.session_manager.session_manager.reconcile", new=AsyncMock(return_value=mock_result)):
            result = await e.reconcile()
        self.assertEqual(result, mock_result)

    async def test_set_mode_calls_session_manager(self):
        e = SessionManagerEngine()
        with mock.patch("services.session.session_manager.session_manager.set_mode") as mock_set:
            result = await e.set_mode("kotak", broker="Kotak Neo", user_id="user123")
        self.assertEqual(result, {"ok": True, "mode": "kotak"})
        mock_set.assert_called_once_with("kotak", broker="Kotak Neo", user_id="user123")

    async def test_login_calls_session_manager(self):
        e = SessionManagerEngine()
        mock_result = {"session_id": "ses_123", "expires_at": 1_700_000_000.0}
        with mock.patch("services.session.session_manager.session_manager.mark_login_success", return_value=mock_result):
            result = await e.login("kotak", "Kotak Neo", user_id="user123")
        self.assertEqual(result, {"ok": True, "session": mock_result})

    async def test_logout_calls_session_manager(self):
        e = SessionManagerEngine()
        mock_result = {"state": "DISCONNECTED"}
        with mock.patch("services.session.session_manager.session_manager.mark_logout", return_value=mock_result):
            result = await e.logout(reason="manual_logout")
        self.assertEqual(result, {"ok": True, "session": mock_result})

    async def test_expire_calls_session_manager(self):
        e = SessionManagerEngine()
        mock_result = {"state": "SESSION_EXPIRED"}
        with mock.patch("services.session.session_manager.session_manager.mark_expired", return_value=mock_result):
            result = await e.expire(reason="session_expired")
        self.assertEqual(result, {"ok": True, "session": mock_result})

    async def test_status_snapshot_includes_phase3_and_subscription(self):
        e = SessionManagerEngine()
        mock_phase3 = {"active": True, "counts": {"total": 50}}
        mock_sub = {"instruments": [{"symbol": "RELIANCE"}]}
        with mock.patch("services.session.session_manager.session_manager.phase3_snapshot", return_value=mock_phase3), \
             mock.patch("services.session.session_manager.session_manager.subscription_snapshot", return_value=mock_sub):
            snap = e.status_snapshot()
        self.assertEqual(snap["phase3Snapshot"], mock_phase3)
        self.assertEqual(snap["subscriptionSnapshot"], mock_sub)


if __name__ == "__main__":
    unittest.main()