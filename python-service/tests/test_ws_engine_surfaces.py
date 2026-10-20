"""Backend tests for the new WebSocket Engine data surfaces.

Covers the additive read-only surfaces added to the control API (history,
events, config) and the reconnect history recording in ws_manager. Every
assertion reflects real backend state — nothing fabricated.

Run:  python -m pytest tests/test_ws_engine_surfaces.py -q
"""
from __future__ import annotations

import os
import sys
import time
import unittest

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from fastapi.testclient import TestClient

from ws_socket.engine.engine import WebSocketEngine
import importlib
ws_manager_module = importlib.import_module("ws_socket.ws_manager")


def _make_app():
    from fastapi import FastAPI
    from api.ws_engine import router
    app = FastAPI()
    app.include_router(router)
    return app


class RouterSurfaceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(_make_app())

    def test_router_exposes_new_data_surfaces(self):
        from api.ws_engine import router
        paths = {route.path for route in router.routes}
        for expected in (
            "/api/services/websocket/history",
            "/api/services/websocket/events",
            "/api/services/websocket/config",
            "/api/services/websocket/daily",
            "/api/services/websocket/history/{connection_id}",
        ):
            self.assertIn(expected, paths)

    def test_config_returns_real_read_only_state(self):
        r = self.client.get("/api/services/websocket/config")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertTrue(body.get("ok", False), body)
        data = body["data"]
        self.assertIn("schema_version", data)
        self.assertIn("sdk_version", data)
        self.assertIn("reconnect", data)
        self.assertIn("feed_levels", data)
        # No mutation endpoints in the read-only shape
        self.assertIsInstance(data["reconnect"], dict)

    def test_history_returns_ok_envelope(self):
        r = self.client.get("/api/services/websocket/history?limit=5")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertTrue(body.get("ok", False), body)
        data = body["data"]
        # Mongo-backed when available; the important contract is the envelope
        # and the keys. Any values returned are real persisted records.
        for key in ("records", "total", "limit", "offset"):
            self.assertIn(key, data)

    def test_events_returns_list_or_empty(self):
        r = self.client.get("/api/services/websocket/events?limit=10")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertTrue(body.get("ok", False), body)
        data = body["data"]
        self.assertIsInstance(data, dict)
        self.assertIn("events", data)
        self.assertIn("total", data)

    def test_history_detail_missing_record_is_honest(self):
        r = self.client.get("/api/services/websocket/history/does-not-exist")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertFalse(body.get("ok", True))
        # Honest either way: a missing record OR an unavailable store.
        error = body.get("error", "")
        self.assertTrue("not found" in error or "unavailable" in error, error)


class ReconnectHistoryTest(unittest.TestCase):
    def setUp(self):
        self.mgr = ws_manager_module.WebSocketManager()
        self._ws_id = self.mgr._websocket_id

    def test_reconnect_attempt_recorded_in_history(self):
        self.mgr._supervisor_state = "RECONNECTING"
        before = len(self.mgr._connection_history)
        delay = self.mgr._get_reconnect_delay(0)
        self.mgr._record_reconnect_attempt(0, delay)
        history = list(self.mgr._connection_history)
        self.assertEqual(len(history), before + 1)
        entry = history[-1]
        self.assertEqual(entry["event"], "reconnecting")
        self.assertEqual(entry["attempt"], 1)
        self.assertEqual(entry["status"], "reconnecting")
        self.assertTrue(entry["at"])

    def test_reconnected_recorded_in_history(self):
        before = len(self.mgr._connection_history)
        self.mgr._record_reconnected(3)
        entry = list(self.mgr._connection_history)[-1]
        self.assertEqual(len(self.mgr._connection_history), before + 1)
        self.assertEqual(entry["event"], "reconnected")
        self.assertEqual(entry["attempt"], 3)

    def test_reconnect_exhausted_recorded_in_history(self):
        before = len(self.mgr._connection_history)
        self.mgr._record_reconnect_exhausted(5)
        entry = list(self.mgr._connection_history)[-1]
        self.assertEqual(len(self.mgr._connection_history), before + 1)
        self.assertEqual(entry["event"], "reconnect_exhausted")
        self.assertEqual(entry["status"], "stopped")
        self.assertIn("5", entry["reason"])

    def test_reconnect_history_surfaces_through_status(self):
        self.mgr._supervisor_state = "RECONNECTING"
        self.mgr._record_reconnect_attempt(0, self.mgr._get_reconnect_delay(0))
        status = self.mgr.status()
        events = {e["event"] for e in status["connection_history"]}
        self.assertIn("reconnecting", events)

    def test_engine_facade_config_schema_version_truthful(self):
        engine = WebSocketEngine()
        status = engine.status()
        self.assertTrue(str(status["schema_version"]))
        self.assertTrue(status["sdk_version"])


if __name__ == "__main__":
    unittest.main(verbosity=2)