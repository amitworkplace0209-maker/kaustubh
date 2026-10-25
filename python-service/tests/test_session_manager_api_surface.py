"""Session Manager API surface tests for the new control-plane endpoints
(session detail / history, diagnostics, configuration). No live MongoDB
required — a fake database backs the persistence paths.

Run:  python -m pytest tests/test_session_manager_api_surface.py -q
"""
from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)


class FakeMongoCollection:
    def __init__(self):
        self._docs: dict[str, dict] = {}

    def find(self, query=None):
        async def _gen():
            for d in self._docs.values():
                yield dict(d)
        return _gen()

    async def update_one(self, filter_doc, update, upsert=False):
        key = filter_doc.get("key")
        doc = dict(self._docs.get(key) or {})
        doc.update({"key": key, **update.get("$set", {})})
        self._docs[key] = doc
        return {"modified": 1}

    async def delete_one(self, filter_doc):
        self._docs.pop(filter_doc.get("key"), None)
        return {"deleted": 1}

    async def delete_many(self, filter_doc=None):
        count = len(self._docs)
        self._docs.clear()
        return {"deleted": count}


class FakeDB:
    def __init__(self):
        self._collections: dict[str, FakeMongoCollection] = {}

    def __getitem__(self, name):
        if name not in self._collections:
            self._collections[name] = FakeMongoCollection()
        return self._collections[name]


class SessionManagerApiSurfaceTest(unittest.TestCase):
    def setUp(self):
        self.db = FakeDB()
        from fastapi import FastAPI
        from api.session_manager import router
        app = FastAPI()
        app.include_router(router)
        from fastapi.testclient import TestClient
        self.client = TestClient(app)
        self.patches = (
            mock.patch("database.connection.get_db", return_value=self.db),
            mock.patch("database.connection.is_mongo_connected", return_value=True),
        )
        for p in self.patches:
            p.start()
        self.addCleanup(lambda: [p.stop() for p in self.patches])

    def test_session_detail_shape(self):
        res = self.client.get("/api/phase3/session-manager/session")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertTrue(body["ok"])
        data = body["data"]
        self.assertIn("identity", data)
        self.assertIn("lifecycle", data)
        self.assertIn("terminalSessions", data)
        self.assertIn("websocket", data)
        self.assertIn("routing", data)
        for key in ("sessionId", "mode", "broker", "userId", "loginSource",
                    "remainingSeconds", "sessionDurationSeconds"):
            self.assertIn(key, data["identity"])
        for key in ("state", "stateMessage", "stateSince", "lifecycleState", "active"):
            self.assertIn(key, data["lifecycle"])

    def test_session_history_returns_rows(self):
        # Seed one session event into the persisted ledger source.
        from services.event_history import record_event
        record_event("session", "LOGIN_SUCCESS", "info", "test login",
                     {"session_id": "s1"})
        res = self.client.get("/api/phase3/session-manager/session/history?limit=20")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertTrue(body["ok"])
        rows = body["data"]
        self.assertIsInstance(rows, list)
        self.assertTrue(any(r.get("event") == "LOGIN_SUCCESS" for r in rows))

    def test_diagnostics_endpoint(self):
        res = self.client.get("/api/phase3/session-manager/diagnostics")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertTrue(body["ok"])
        data = body["data"]
        for key in ("engines", "sessionHealth", "revisionStatus",
                    "connections", "mongo", "config", "recentSessionEvents"):
            self.assertIn(key, data)
        self.assertTrue(data["mongo"]["connected"])
        self.assertIn("effective", data["config"])

    def test_config_read_returns_schema(self):
        res = self.client.get("/api/phase3/session-manager/config")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertTrue(body["ok"])
        config = body["data"]["config"]
        for key in ("session_lifetime_seconds", "expiry_warning_seconds",
                    "tick_active_window_seconds"):
            self.assertIn(key, config)
            self.assertEqual(config[key]["value"], config[key]["default"])
            self.assertEqual(config[key]["persisted"], False)

    def test_config_update_valid_and_live(self):
        res = self.client.put(
            "/api/phase3/session-manager/config",
            json={"session_lifetime_seconds": 7200},
        )
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertTrue(body["ok"], body)
        self.assertEqual(
            body["data"]["session_lifetime_seconds"]["value"], 7200)
        self.assertEqual(
            body["data"]["session_lifetime_seconds"]["persisted"], True)
        from services.session.session_manager_config import session_lifetime_seconds
        self.assertEqual(session_lifetime_seconds(), 7200)

    def test_config_update_rejects_unknown_key(self):
        res = self.client.put(
            "/api/phase3/session-manager/config",
            json={"bogus_key": 1},
        )
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertFalse(body["ok"])
        self.assertIn("Unknown session config key", body["error"])

    def test_config_reset_and_single_key_reset(self):
        self.client.put(
            "/api/phase3/session-manager/config",
            json={"session_lifetime_seconds": 7200, "expiry_warning_seconds": 300},
        )
        res = self.client.post("/api/phase3/session-manager/config/reset")
        self.assertTrue(res.json()["ok"])
        from services.session.session_manager_config import session_lifetime_seconds
        self.assertEqual(session_lifetime_seconds(), 3600)
        # re-set both, reset only one key
        self.client.put(
            "/api/phase3/session-manager/config",
            json={"session_lifetime_seconds": 7200, "expiry_warning_seconds": 300},
        )
        res = self.client.post(
            "/api/phase3/session-manager/config/session_lifetime_seconds/reset")
        self.assertTrue(res.json()["ok"])
        self.assertEqual(
            res.json()["data"]["session_lifetime_seconds"]["persisted"], False)
        self.assertEqual(
            res.json()["data"]["expiry_warning_seconds"]["value"], 300)


if __name__ == "__main__":
    unittest.main(verbosity=2)