"""
Tests for the app-level authentication API (python-service/api/auth_app.py).

These exercise the real signatures and return shapes used by the Vercel proxy:
FastAPI JSONResponse objects are parsed from their body, and gated endpoints are
driven with patched storage helpers so no MongoDB is required.

Run:  python -m pytest tests/test_auth_app.py -q
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import types
import unittest
from contextlib import contextmanager
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from fastapi import HTTPException  # noqa: E402
from starlette.responses import Response  # noqa: E402

from api import auth_app  # noqa: E402


TEST_SECRET = "test-secret-key-0123456789abcdef0123456789abcdef"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(coro):
    return asyncio.run(coro)


def _body(response) -> dict:
    return json.loads(bytes(response.body).decode("utf-8"))


class FakeRequest:
    """Minimal starlette Request stand-in for the helpers under test."""

    def __init__(
        self,
        body: dict | None = None,
        headers: dict | None = None,
        client_host: str = "203.0.113.5",
        scheme: str = "https",
    ):
        self._body = body
        self.headers = headers if headers is not None else {"x-forwarded-for": client_host}
        self.client = types.SimpleNamespace(host=client_host)
        self.url = types.SimpleNamespace(scheme=scheme)
        self.cookies: dict[str, str] = {}

    async def json(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body


@contextmanager
def auth_env(**values: str):
    """Set auth env vars for one test and reset the cached signing secret."""
    keys = ["AUTH_SESSION_SECRET", "APP_SESSION_SECRET", "AUTH_SIGNUP_EMAIL", "AUTH_SIGNUP_MPIN"]
    saved = {key: os.environ.get(key) for key in keys}
    old_secret = auth_app._session_secret_cache
    try:
        for key in keys:
            os.environ.pop(key, None)
        for key, value in values.items():
            os.environ[key] = value
        auth_app._session_secret_cache = None
        auth_app._rate_buckets.clear()
        yield
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        auth_app._session_secret_cache = old_secret
        auth_app._rate_buckets.clear()


def _mock_owner(**overrides):
    owner = {
        "_id": "oid-1",
        "singleton": "owner",
        "name": "Test Owner",
        "nameLower": "test owner",
        "email": "owner@example.com",
        "emailLower": "owner@example.com",
        "passwordHash": auth_app._hash_secret("CorrectPass123"),
        "mpinHash": None,
        "mpinUpdatedAt": None,
        "mpinFailedAttempts": 0,
        "mpinLockedUntil": None,
        "passwordFailedAttempts": 0,
        "passwordLockedUntil": None,
        "createdAt": None,
        "updatedAt": None,
        "lastLoginAt": None,
    }
    owner.update(overrides)
    return owner


# ---------------------------------------------------------------------------
# Session token
# ---------------------------------------------------------------------------

class SessionTokenTests(unittest.TestCase):
    def test_create_and_verify_token(self):
        with auth_env(AUTH_SESSION_SECRET=TEST_SECRET):
            token = auth_app._create_session_token("sess-123", "dev-456")
            self.assertEqual(len(token.split(".")), 2)
            payload = auth_app._verify_session_token(token)
            self.assertIsNotNone(payload)
            self.assertEqual(payload["sid"], "sess-123")
            self.assertEqual(payload["did"], "dev-456")
            self.assertTrue(payload["authenticated"])
            self.assertEqual(payload["v"], 2)

    def test_verify_tampered_token(self):
        with auth_env(AUTH_SESSION_SECRET=TEST_SECRET):
            token = auth_app._create_session_token("sess-123", "dev-456")
            tampered = token[:-5] + "XXXXX"
            self.assertIsNone(auth_app._verify_session_token(tampered))

    def test_verify_none_and_malformed(self):
        with auth_env(AUTH_SESSION_SECRET=TEST_SECRET):
            self.assertIsNone(auth_app._verify_session_token(None))
            self.assertIsNone(auth_app._verify_session_token(""))
            self.assertIsNone(auth_app._verify_session_token("not-a-token"))

    def test_verify_wrong_secret(self):
        with auth_env(AUTH_SESSION_SECRET=TEST_SECRET):
            token = auth_app._create_session_token("sess-123", "dev-456")
        with auth_env(AUTH_SESSION_SECRET="different-secret-key-0123456789abcdef0123456789abcdef"):
            self.assertIsNone(auth_app._verify_session_token(token))

    def test_expired_token_rejected(self):
        with auth_env(AUTH_SESSION_SECRET=TEST_SECRET):
            with mock.patch.object(auth_app, "SESSION_TTL_MS", -1_000):
                token = auth_app._create_session_token("sess-123", "dev-456")
            self.assertIsNone(auth_app._verify_session_token(token))


# ---------------------------------------------------------------------------
# Secret hashing (scrypt)
# ---------------------------------------------------------------------------

class PasswordHashTests(unittest.TestCase):
    def test_hash_format_and_verify(self):
        hashed = auth_app._hash_secret("mypassword123")
        self.assertTrue(hashed.startswith("scrypt$"))
        self.assertEqual(len(hashed.split("$")), 6)
        self.assertTrue(auth_app._verify_secret("mypassword123", hashed))
        self.assertFalse(auth_app._verify_secret("wrongpassword", hashed))

    def test_verify_missing_or_malformed(self):
        self.assertFalse(auth_app._verify_secret("anything", None))
        self.assertFalse(auth_app._verify_secret("anything", ""))
        self.assertFalse(auth_app._verify_secret("anything", "not-a-hash"))
        self.assertFalse(auth_app._verify_secret("anything", "sha256$1$1$salt$hash"))


# ---------------------------------------------------------------------------
# Rate limiting
# ---------------------------------------------------------------------------

class RateLimitTests(unittest.TestCase):
    def setUp(self):
        auth_app._rate_buckets.clear()

    def tearDown(self):
        auth_app._rate_buckets.clear()

    def test_allows_under_limit_and_reports_retry(self):
        for _ in range(3):
            allowed, retry_after = auth_app._rate_limit("login", "1.2.3.4", 3, 60_000)
            self.assertTrue(allowed)
            self.assertEqual(retry_after, 0)

        allowed, retry_after = auth_app._rate_limit("login", "1.2.3.4", 3, 60_000)
        self.assertFalse(allowed)
        self.assertGreaterEqual(retry_after, 1)

    def test_limit_is_per_ip_and_per_kind(self):
        auth_app._rate_limit("login", "1.2.3.4", 1, 60_000)
        self.assertFalse(auth_app._rate_limit("login", "1.2.3.4", 1, 60_000)[0])
        self.assertTrue(auth_app._rate_limit("login", "5.6.7.8", 1, 60_000)[0])
        self.assertTrue(auth_app._rate_limit("signup", "1.2.3.4", 1, 60_000)[0])

    def test_window_expires(self):
        auth_app._rate_limit("login", "1.2.3.4", 1, 1)
        time.sleep(0.01)
        self.assertTrue(auth_app._rate_limit("login", "1.2.3.4", 1, 1)[0])


# ---------------------------------------------------------------------------
# Client IP extraction
# ---------------------------------------------------------------------------

class ClientIPTests(unittest.TestCase):
    def test_x_forwarded_for_first_value(self):
        req = FakeRequest(headers={"x-forwarded-for": "203.0.113.5, 10.0.0.1"})
        self.assertEqual(auth_app._get_client_ip(req), "203.0.113.5")

    def test_x_vercel_forwarded_for(self):
        req = FakeRequest(headers={"x-vercel-forwarded-for": "198.51.100.23"})
        self.assertEqual(auth_app._get_client_ip(req), "198.51.100.23")

    def test_socket_fallback_for_loopback(self):
        req = FakeRequest(headers={}, client_host="127.0.0.1")
        self.assertEqual(auth_app._get_client_ip(req), "127.0.0.1")

    def test_no_ip(self):
        req = FakeRequest(headers={}, client_host="10.0.0.9")
        self.assertIsNone(auth_app._get_client_ip(req))


# ---------------------------------------------------------------------------
# Validation parity
# ---------------------------------------------------------------------------

class ValidationTests(unittest.TestCase):
    def test_weak_mpins_rejected(self):
        for mpin in ("000000", "111111", "123456", "654321", "121212", "112233"):
            self.assertIsNotNone(auth_app.validate_mpin(mpin), mpin)

    def test_strong_mpin_accepted(self):
        for mpin in ("482917", "730592", "918273"):
            self.assertIsNone(auth_app.validate_mpin(mpin), mpin)

    def test_password_policy(self):
        self.assertIsNone(auth_app.validate_password("CorrectPass123"))
        self.assertIsNotNone(auth_app.validate_password("short"))
        self.assertIsNotNone(auth_app.validate_password("alllowercase1"))
        self.assertIsNotNone(auth_app.validate_password("ALLUPPERCASE1"))
        self.assertIsNotNone(auth_app.validate_password("NoNumbersHere"))
        self.assertIsNotNone(auth_app.validate_password("Has Space 123"))
        self.assertIsNotNone(auth_app.validate_password("aaaaaaaaaaaa"))

    def test_email_and_name(self):
        self.assertIsNone(auth_app.valid_email("owner@example.com"))
        self.assertIsNotNone(auth_app.valid_email("not-an-email"))
        self.assertIsNone(auth_app.valid_name("Test Owner"))
        self.assertIsNotNone(auth_app.valid_name("X"))

    def test_mask_email(self):
        self.assertEqual(auth_app.mask_email("owner@example.com"), "ow***@example.com")


# ---------------------------------------------------------------------------
# Signup gating
# ---------------------------------------------------------------------------

class SignupTests(unittest.TestCase):
    def _payload(self):
        return {
            "name": "Test Owner",
            "email": "owner@example.com",
            "password": "CorrectPass123",
            "mpin": "482917",
        }

    @mock.patch("api.auth_app.has_owner", new_callable=mock.AsyncMock)
    def test_signup_not_configured(self, mock_has_owner):
        with auth_env():
            req = FakeRequest(self._payload())
            with self.assertRaises(HTTPException) as ctx:
                _run(auth_app.app_signup(req, Response()))
            self.assertEqual(ctx.exception.status_code, 503)
            self.assertEqual(ctx.exception.detail["code"], "SIGNUP_NOT_CONFIGURED")
            mock_has_owner.assert_not_awaited()

    @mock.patch("api.auth_app.has_owner", new_callable=mock.AsyncMock)
    def test_signup_owner_exists(self, mock_has_owner):
        mock_has_owner.return_value = True
        with auth_env(AUTH_SIGNUP_EMAIL="owner@example.com", AUTH_SIGNUP_MPIN="482917"):
            req = FakeRequest(self._payload())
            with self.assertRaises(HTTPException) as ctx:
                _run(auth_app.app_signup(req, Response()))
            self.assertEqual(ctx.exception.status_code, 409)
            self.assertEqual(ctx.exception.detail["code"], "OWNER_EXISTS")

    @mock.patch("api.auth_app.issue_session_for_user", new_callable=mock.AsyncMock)
    @mock.patch("api.auth_app.record_auth_event", new_callable=mock.AsyncMock)
    @mock.patch("api.auth_app.create_owner", new_callable=mock.AsyncMock)
    @mock.patch("api.auth_app.has_owner", new_callable=mock.AsyncMock)
    def test_signup_success(self, mock_has_owner, mock_create_owner, mock_record, mock_issue):
        mock_has_owner.return_value = False
        mock_create_owner.return_value = _mock_owner(mpinHash=None)
        mock_issue.return_value = ({"sessionId": "sess-1"}, "token-value")
        with auth_env(AUTH_SIGNUP_EMAIL="owner@example.com", AUTH_SIGNUP_MPIN="482917"):
            req = FakeRequest(self._payload())
            response = Response()
            result = _run(auth_app.app_signup(req, response))
            data = _body(result)
            self.assertEqual(result.status_code, 201)
            self.assertTrue(data["ok"])
            self.assertTrue(data["authenticated"])
            self.assertTrue(data["needsMpinSetup"])
            self.assertEqual(data["deviceCount"], 1)
            self.assertEqual(data["maxDevices"], 2)
            cookies = response.headers.getlist("set-cookie")
            self.assertTrue(any(cookie.startswith("kaustubh_session=") for cookie in cookies))
            self.assertTrue(any(cookie.startswith("kaustubh_mpin_pending=1") for cookie in cookies))
            self.assertTrue(all("HttpOnly" in cookie for cookie in cookies))
            self.assertTrue(all("SameSite=lax" in cookie for cookie in cookies))
            self.assertTrue(all("Secure" in cookie for cookie in cookies))


# ---------------------------------------------------------------------------
# Login gating
# ---------------------------------------------------------------------------

class LoginTests(unittest.TestCase):
    @mock.patch("api.auth_app.get_owner", new_callable=mock.AsyncMock)
    def test_login_no_owner(self, mock_get_owner):
        mock_get_owner.return_value = None
        with auth_env(AUTH_SESSION_SECRET=TEST_SECRET):
            req = FakeRequest({"email": "owner@example.com", "password": "CorrectPass123"})
            with self.assertRaises(HTTPException) as ctx:
                _run(auth_app.app_login(req, Response()))
            self.assertEqual(ctx.exception.status_code, 409)
            self.assertEqual(ctx.exception.detail["code"], "NO_OWNER")

    @mock.patch("api.auth_app.record_auth_event", new_callable=mock.AsyncMock)
    @mock.patch("api.auth_app.update_owner", new_callable=mock.AsyncMock)
    @mock.patch("api.auth_app.get_owner", new_callable=mock.AsyncMock)
    def test_login_wrong_password(self, mock_get_owner, mock_update_owner, mock_record):
        mock_get_owner.return_value = _mock_owner()
        with auth_env(AUTH_SESSION_SECRET=TEST_SECRET):
            req = FakeRequest({"email": "owner@example.com", "password": "WrongPass123"})
            with self.assertRaises(HTTPException) as ctx:
                _run(auth_app.app_login(req, Response()))
            self.assertEqual(ctx.exception.status_code, 401)
            mock_update_owner.assert_awaited()

    @mock.patch("api.auth_app.get_owner", new_callable=mock.AsyncMock)
    def test_login_requires_verifiable_ip(self, mock_get_owner):
        with auth_env(AUTH_SESSION_SECRET=TEST_SECRET):
            req = FakeRequest({"email": "owner@example.com", "password": "CorrectPass123"}, headers={}, client_host="10.0.0.9")
            with self.assertRaises(HTTPException) as ctx:
                _run(auth_app.app_login(req, Response()))
            self.assertEqual(ctx.exception.status_code, 400)
            self.assertEqual(ctx.exception.detail["code"], "IP_REQUIRED")
            mock_get_owner.assert_not_awaited()


# ---------------------------------------------------------------------------
# Status / live
# ---------------------------------------------------------------------------

class StatusTests(unittest.TestCase):
    @mock.patch("api.auth_app.get_owner", new_callable=mock.AsyncMock)
    def test_status_signup_configured_no_owner(self, mock_get_owner):
        mock_get_owner.return_value = None
        with auth_env(AUTH_SIGNUP_EMAIL="owner@example.com", AUTH_SIGNUP_MPIN="482917"):
            req = FakeRequest()
            data = _body(_run(auth_app.app_status(req)))
            self.assertTrue(data["signupConfigured"])
            self.assertFalse(data["hasOwner"])
            self.assertTrue(data["needsSignup"])
            self.assertFalse(data["authenticated"])
            self.assertFalse(data["needsUnlock"])

    @mock.patch("api.auth_app.get_owner", new_callable=mock.AsyncMock)
    def test_status_owner_no_session(self, mock_get_owner):
        mock_get_owner.return_value = _mock_owner()
        with auth_env(AUTH_SIGNUP_EMAIL="owner@example.com", AUTH_SIGNUP_MPIN="482917"):
            req = FakeRequest(headers={})
            data = _body(_run(auth_app.app_status(req)))
            self.assertTrue(data["hasOwner"])
            self.assertFalse(data["authenticated"])
            self.assertFalse(data["needsSignup"])


class OperatorTokenTests(unittest.TestCase):
    @mock.patch("api.auth_app.require_session", new_callable=mock.AsyncMock)
    def test_operator_token_is_issued_for_a_valid_session(self, mock_require):
        mock_require.return_value = {
            "payload": {"sid": "sess-1"},
            "session": {"sessionId": "sess-1"},
            "owner": _mock_owner(),
        }
        with auth_env(AUTH_SESSION_SECRET=TEST_SECRET):
            req = FakeRequest()
            data = _body(_run(auth_app.app_operator_token(req)))
        self.assertTrue(data["ok"])
        self.assertTrue(data["token"])
        self.assertEqual(data["username"], "kaustubh")
        mock_require.assert_awaited_once()
        self.assertTrue(mock_require.await_args.kwargs.get("require_mpin"))

    @mock.patch("api.auth_app.require_session", new_callable=mock.AsyncMock)
    def test_operator_token_requires_the_session_gate(self, mock_require):
        mock_require.side_effect = HTTPException(
            status_code=401,
            detail={"ok": False, "code": "UNAUTHENTICATED", "message": "expired"},
        )
        with self.assertRaises(HTTPException) as ctx:
            _run(auth_app.app_operator_token(FakeRequest()))
        self.assertEqual(ctx.exception.status_code, 401)


class LiveTests(unittest.TestCase):
    @mock.patch("api.auth_app.get_owner", new_callable=mock.AsyncMock)
    @mock.patch("api.auth_app.get_session_doc", new_callable=mock.AsyncMock)
    def test_live_true(self, mock_session, mock_owner):
        future = time.time() * 1000 + 60_000
        mock_session.return_value = {"sessionId": "sess-1", "userId": "oid-1", "expiresAt": future}
        mock_owner.return_value = {"_id": "oid-1"}
        req = types.SimpleNamespace(query_params={"sid": "sess-1"})
        data = _body(_run(auth_app.app_live(req)))
        self.assertTrue(data["ok"])
        self.assertTrue(data["live"])

    @mock.patch("api.auth_app.get_session_doc", new_callable=mock.AsyncMock)
    def test_live_missing_revoked_or_expired(self, mock_session):
        for stored in (None, {"sessionId": "s", "revokedAt": time.time()}, {"sessionId": "s", "expiresAt": time.time() * 1000 - 1}):
            mock_session.return_value = stored
            req = types.SimpleNamespace(query_params={"sid": "s"})
            data = _body(_run(auth_app.app_live(req)))
            self.assertFalse(data["live"], stored)

    def test_live_without_sid(self):
        req = types.SimpleNamespace(query_params={})
        data = _body(_run(auth_app.app_live(req)))
        self.assertFalse(data["live"])


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

class HealthTests(unittest.TestCase):
    @mock.patch("api.auth_app.is_mongo_connected")
    def test_health_ok(self, mock_connected):
        mock_connected.return_value = True
        with auth_env(AUTH_SESSION_SECRET=TEST_SECRET):
            data = _body(_run(auth_app.app_auth_health()))
            self.assertTrue(data["ok"])
            self.assertTrue(data["mongodb"])
            self.assertTrue(data["sessionSecretConfigured"])
            self.assertEqual(data["service"], "kaustubh-auth-app")
            self.assertNotIn(TEST_SECRET, json.dumps(data))

    @mock.patch("api.auth_app.is_mongo_connected")
    def test_health_mongo_down(self, mock_connected):
        mock_connected.return_value = False
        with auth_env(AUTH_SESSION_SECRET=TEST_SECRET):
            data = _body(_run(auth_app.app_auth_health()))
            self.assertFalse(data["ok"])
            self.assertFalse(data["mongodb"])


if __name__ == "__main__":
    unittest.main()
