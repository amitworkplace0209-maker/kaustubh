"""WebSocket Gateway (WS #2) REST + WebSocket auth tests.

Exercises /api/realtime/token and /ws/realtime against a lightweight in-process
FastAPI app (the gateway router only — no lifespan). The connection engine is
stubbed so the WS endpoint's auth branches, welcome envelope and lifecycle
(attach/detach) are tested in isolation — no broker wiring or MongoDB.

Auth model under test:
  * APP_PASSWORD set (secure)   -> /api/realtime/token 401 without an operator
                                  JWT; /ws/realtime closes 4401 without one.
  * APP_PASSWORD empty (local)  -> anonymous token + anonymous welcome.
  * secure + valid operator JWT -> 200 token + named welcome.
"""
import time
import unittest
import uuid
from contextlib import contextmanager
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import ws_gateway
from connection_engine.client import ClientSession


class StubEngine:
    """Backs the gateway router without broker/DB wiring."""

    def __init__(self):
        self._sessions: dict[str, ClientSession] = {}

    def create_session(self, username: str = "anonymous") -> ClientSession:
        return ClientSession(connection_id=uuid.uuid4().hex, username=username)

    async def attach(self, session: ClientSession) -> ClientSession:
        self._sessions[session.connection_id] = session
        return session

    async def detach(self, connection_id: str) -> None:
        session = self._sessions.pop(connection_id, None)
        if session is not None:
            await session.close()

    def status(self) -> dict:
        return {"ok": True, "sessions": len(self._sessions), "started": True}

    def sessions(self) -> list[dict]:
        return [s.stats_dict() for s in self._sessions.values()]

    def health(self) -> dict:
        return {"state": "HEALTHY", "reason": "stub", "checkedAt": time.time()}

    def recent_events(self, limit=200, **kw):
        return []

    def config(self) -> dict:
        return {"envelopeVersion": "1.0", "channels": {"market": [], "state": []}}

    def session_records(self) -> list[dict]:
        return [{
            "connectionId": sid,
            "consumerType": "UI",
            "channels": sorted(s.channels) + sorted(s.state_channels),
            "status": s.current_state(),
            "lifecycleState": s.lifecycle_state,
            "source": "ws_engine",
            "deliveryMethod": "WEBSOCKET",
            "queueLimit": s.outbox.maxlen,
        } for sid, s in self._sessions.items()]


@contextmanager
def _gateway(secure: bool):
    """Minimal app: realtime routes + stubbed engine + chosen auth mode."""
    app = FastAPI()
    app.include_router(ws_gateway.router)
    client = TestClient(app, raise_server_exceptions=False)
    engine = StubEngine()
    with mock.patch.object(ws_gateway, "_security_enabled", return_value=secure), \
         mock.patch.object(ws_gateway, "connection_engine", engine):
        yield client, engine


def _wait_until(pred, timeout_s: float = 2.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.02)
    return pred()


class TokenEndpointTests(unittest.TestCase):
    def test_secure_requires_operator_jwt(self):
        with _gateway(secure=True) as (client, _engine):
            res = client.get("/api/realtime/token")
            self.assertEqual(res.status_code, 401)
            self.assertIn("operator", res.json().get("detail", "").lower())

    def test_secure_accepts_valid_jwt(self):
        from services.jwt_auth import issue_token

        token = issue_token("kaustubh")
        with _gateway(secure=True) as (client, _engine):
            res = client.get(
                "/api/realtime/token",
                headers={"Authorization": f"Bearer {token}"},
            )
            self.assertEqual(res.status_code, 200)
            body = res.json()
            self.assertTrue(body["ok"])
            self.assertTrue(body["token"])
            self.assertEqual(body["username"], "kaustubh")
            self.assertTrue(body["secure"])

    def test_insecure_returns_anonymous_token(self):
        with _gateway(secure=False) as (client, _engine):
            res = client.get("/api/realtime/token")
            self.assertEqual(res.status_code, 200)
            body = res.json()
            self.assertTrue(body["ok"])
            self.assertTrue(body["token"])
            self.assertEqual(body["username"], "anonymous")
            self.assertFalse(body["secure"])


class WsAuthTests(unittest.TestCase):
    def test_secure_rejects_without_token(self):
        with _gateway(secure=True) as (client, _engine):
            with client.websocket_connect("/ws/realtime") as ws:
                frame = ws.receive_json()
            self.assertEqual(frame.get("type"), "error.event")
            self.assertEqual(frame.get("code"), "401")

    def test_secure_rejects_without_token_logs_structured(self):
        with _gateway(secure=True) as (client, _engine):
            with self.assertLogs("ws_gateway", level="INFO") as logs:
                with client.websocket_connect("/ws/realtime") as ws:
                    ws.receive_json()
            self.assertTrue(
                any("[WS] authentication failed" in line for line in logs.output),
                logs.output,
            )

    def test_secure_reject_never_attaches_session(self):
        with _gateway(secure=True) as (client, engine):
            with client.websocket_connect("/ws/realtime") as ws:
                ws.receive_json()
            self.assertEqual(len(engine._sessions), 0)

    def test_secure_welcome_with_valid_token(self):
        from services.jwt_auth import issue_token

        token = issue_token("kaustubh")
        with _gateway(secure=True) as (client, engine):
            with client.websocket_connect(f"/ws/realtime?token={token}") as ws:
                welcome = ws.receive_json()
                self.assertEqual(welcome.get("type"), "welcome")
                self.assertEqual(welcome["data"]["username"], "kaustubh")
                self.assertTrue(welcome["data"]["connectionId"])
                sessions = client.get("/api/realtime/sessions").json()["data"]
                self.assertEqual(len(sessions), 1)
                self.assertEqual(sessions[0]["username"], "kaustubh")
            self.assertTrue(
                _wait_until(lambda: len(engine._sessions) == 0),
                "session was not detached after close",
            )

    def test_insecure_anonymous_welcome(self):
        with _gateway(secure=False) as (client, engine):
            with client.websocket_connect("/ws/realtime") as ws:
                welcome = ws.receive_json()
                self.assertEqual(welcome.get("type"), "welcome")
                self.assertEqual(welcome["data"]["username"], "anonymous")
                self.assertEqual(len(engine._sessions), 1)
            self.assertTrue(
                _wait_until(lambda: len(engine._sessions) == 0),
                "session was not detached after close",
            )


class ControlPlaneEndpointTests(unittest.TestCase):
    def test_health_endpoint(self):
        with _gateway(secure=False) as (client, _engine):
            res = client.get("/api/realtime/health")
            self.assertEqual(res.status_code, 200)
            body = res.json()
            self.assertTrue(body["ok"])
            self.assertEqual(body["data"]["state"], "HEALTHY")

    def test_events_endpoint(self):
        with _gateway(secure=False) as (client, _engine):
            res = client.get("/api/realtime/events")
            self.assertEqual(res.status_code, 200)
            body = res.json()
            self.assertTrue(body["ok"])
            self.assertEqual(body["data"]["events"], [])
            self.assertEqual(body["data"]["total"], 0)

    def test_config_endpoint(self):
        with _gateway(secure=False) as (client, _engine):
            res = client.get("/api/realtime/config")
            self.assertEqual(res.status_code, 200)
            body = res.json()
            self.assertTrue(body["ok"])
            self.assertEqual(body["data"]["envelopeVersion"], "1.0")

    def test_connection_lookup_found(self):
        from unittest import mock as _mock
        record = {
            "connectionId": "abc123",
            "consumerType": "UI",
            "status": "ACTIVE",
            "lifecycleState": "ACTIVE",
        }
        with _gateway(secure=False) as (client, engine):
            with _mock.patch.object(engine, "session_records", return_value=[record]):
                res = client.get("/api/realtime/connections/abc123")
                self.assertEqual(res.status_code, 200)
                body = res.json()
                self.assertTrue(body["ok"])
                self.assertEqual(body["data"]["connectionId"], "abc123")

    def test_connection_lookup_missing(self):
        from unittest import mock as _mock
        with _gateway(secure=False) as (client, engine):
            with _mock.patch.object(engine, "session_records", return_value=[]):
                res = client.get("/api/realtime/connections/nope")
                self.assertEqual(res.status_code, 200)
                body = res.json()
                self.assertFalse(body["ok"])

    def test_envelope_supports_query_filters(self):
        with _gateway(secure=False) as (client, _engine):
            res = client.get("/api/realtime/events?limit=10&event_type=session.attached&level=info")
            self.assertEqual(res.status_code, 200)


if __name__ == "__main__":
    unittest.main()