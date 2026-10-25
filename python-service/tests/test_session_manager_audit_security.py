"""Session Manager — audit integration, security redaction and notification
wiring regression tests (spec §33-35).

Run:  python -m pytest tests/test_session_manager_audit_security.py -q
"""
from __future__ import annotations

import asyncio
import os
import sys
import threading
import time
import unittest
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)


# Credential-like keys that MUST never appear in any session-manager payload.
_HOSTILE_KEYS = (
    "access_token", "accessToken", "refresh_token", "refreshToken",
    "jwt", "jwt_token", "bearer", "bearer_token", "api_key", "apiKey",
    "api_secret", "apiSecret", "consumer_key", "consumerSecret",
    "mpin", "mpinist", "mpin_ist", "totp", "totp_secret", "otp",
    "password", "password_hash", "secret", "secret_key", "credential",
    "session_token", "auth_token",
)
_SECRET_MARKER = "HOSTILE_SECRET_7f2a9ce4"


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


class FakeDB:
    def __init__(self):
        self._collections: dict[str, FakeMongoCollection] = {}

    def __getitem__(self, name):
        if name not in self._collections:
            self._collections[name] = FakeMongoCollection()
        return self._collections[name]


class SessionManagerAuditSecurityTest(unittest.TestCase):
    def setUp(self):
        from services.session.session_manager import session_manager
        self.sm = session_manager
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

    def _inject_hostile_fields(self):
        """Seed credential-like fields into the runtime records the way a
        future refactor might, then prove the API boundary never leaks them."""
        from services.session.session_manager import session_manager
        key = ("nse_cm", "999991")
        with session_manager._lock:
            session_manager._subs[key] = {
                "exchange_segment": key[0],
                "instrument_token": key[1],
                "symbol": "SECRETTEST",
                "desired": True,
                "sources": ["manual"],
                "access_token": _SECRET_MARKER,
                "api_secret": _SECRET_MARKER,
                "totp_secret": _SECRET_MARKER,
            }
            session_manager._subs_revision += 1
            target = session_manager._mode or "kotak"
            session_manager._sessions[target] = dict(
                session_manager._sessions.get(target) or {})
            session_manager._sessions[target]["refresh_token"] = _SECRET_MARKER
            session_manager._sessions[target]["password_hash"] = _SECRET_MARKER

    def _assert_clean(self, endpoint):
        res = self.client.get(endpoint)
        self.assertEqual(res.status_code, 200)
        text = res.text
        self.assertNotIn(_SECRET_MARKER, text,
                          f"secret leaked via {endpoint}")
        for key in _HOSTILE_KEYS:
            self.assertNotIn(key, text,
                             f"credential key '{key}' leaked via {endpoint}")

    def test_no_credential_leak_across_all_endpoints(self):
        self._inject_hostile_fields()
        for endpoint in (
            "/api/phase3/session-manager/overview",
            "/api/phase3/session-manager/status",
            "/api/phase3/session-manager/health",
            "/api/phase3/session-manager/connections",
            "/api/phase3/session-manager/subscriptions",
            "/api/phase3/session-manager/sources",
            "/api/phase3/session-manager/pins",
            "/api/phase3/session-manager/expiry",
            "/api/phase3/session-manager/session",
            "/api/phase3/session-manager/instruments",
            "/api/phase3/session-manager/instruments/nse_cm%7C999991",
            "/api/phase3/session-manager/diagnostics",
        ):
            self._assert_clean(endpoint)

    def test_lifecycle_action_is_audited(self):
        res = self.client.post(
            "/api/phase3/session-manager/instruments/nse_cm%7C999992/subscribe",
            json={"symbol": "AUDITSTOCK"},
        )
        self.assertTrue(res.json()["ok"], res.text)
        from services.event_history import recent_events
        rows = recent_events(limit=500, source="session_manager")
        self.assertTrue(
            any(r.get("event") == "INSTRUMENT_SUBSCRIBE" for r in rows),
            "expected an INSTRUMENT_SUBSCRIBE audit row")

    def test_manual_add_and_reconcile_are_audited(self):
        self.client.post(
            "/api/phase3/session-manager/instruments",
            json={"exchange_segment": "nse_cm", "instrument_token": "999993",
                  "symbol": "ADDSTOCK", "feed_level": 4},
        ).raise_for_status()
        self.client.post("/api/phase3/session-manager/reconcile").raise_for_status()
        from services.event_history import recent_events
        rows = recent_events(limit=2000, source="session_manager")
        events = {r.get("event") for r in rows}
        self.assertIn("MANUAL_ADD", events)
        self.assertIn("RECONCILE", events)

    def test_config_change_is_audited(self):
        self.client.put(
            "/api/phase3/session-manager/config",
            json={"expiry_warning_seconds": 120},
        ).raise_for_status()
        from services.event_history import recent_events
        rows = recent_events(limit=2000, source="session_manager")
        self.assertTrue(
            any(r.get("event") == "CONFIG_CHANGE" for r in rows))


class SessionManagerNotificationTest(unittest.TestCase):
    """Notification Engine integration smoke test (spec §35)."""

    def _run_with_temp_loop(self, fn):
        from core.event_loop import set_loop
        loop = asyncio.new_event_loop()
        set_loop(loop)
        thread = threading.Thread(target=loop.run_forever, daemon=True)
        thread.start()
        try:
            deadline = time.time() + 3.0
            while not loop.is_running() and time.time() < deadline:
                time.sleep(0.01)
            self.assertTrue(loop.is_running(), "temp event loop failed to start")
            return fn(loop)
        finally:
            loop.call_soon_threadsafe(loop.stop)
            thread.join(timeout=2)
            set_loop(None)

    def test_session_expiry_publishes_notification(self):
        from services.session.session_manager import CentralSessionManager
        mgr = CentralSessionManager()
        import services.notification_service as ns
        calls: list[tuple] = []

        async def fake_notify(category, severity, title, message, *,
                              source="data-saver", event_type="", metadata=None,
                              bypass_enabled=False):
            calls.append((category, severity, title, message, source))

        def scenario(loop):
            self.assertTrue(loop.is_running(), "temp event loop not running")
            original = ns.notify
            ns.notify = fake_notify
            try:
                _ = mgr.mark_expired(reason="test_expiry")
                deadline = time.time() + 3.0
                while not calls and time.time() < deadline:
                    time.sleep(0.02)
            finally:
                ns.notify = original
            self.assertTrue(calls, "notification was never scheduled (smoke test)")
            self.assertEqual(calls[0][2], "Session expired")

        self._run_with_temp_loop(scenario)
        self.assertEqual(calls[0][0], "session")
        self.assertEqual(calls[0][1], "warning")
        self.assertIn("expired", calls[0][2].lower())
        self.assertEqual(calls[0][4], "session_manager")

    def test_notify_is_noop_without_running_loop(self):
        from core.event_loop import set_loop
        set_loop(None)
        from services.session.session_manager import CentralSessionManager
        mgr = CentralSessionManager()
        with mock.patch("services.notification_service.notify",
                        new=mock.AsyncMock()) as n:
            _ = mgr.mark_expired(reason="no_loop")
            n.assert_not_called()


if __name__ == "__main__":
    unittest.main()