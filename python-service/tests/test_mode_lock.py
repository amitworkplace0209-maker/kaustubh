"""Mode Lock + WebAuthn + switch-gating tests.

No live MongoDB required: the terminal_security store is mocked in-memory.
WebAuthn registration / assertion are exercised end-to-end with a synthetic
ECDSA P-256 key produced by `cryptography` (the same library the verifier uses).

Run:  python -m pytest tests/test_mode_lock.py -q
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import sys
import time
import unittest
from unittest import mock

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)


def _b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


class _MemStore:
    """In-memory stand-in for the terminal_security collection."""

    def __init__(self):
        self.docs: dict[str, dict] = {}

    async def get(self, key: str):
        import copy
        return copy.deepcopy(self.docs.get(key))

    async def set(self, key: str, doc: dict):
        import copy
        self.docs[key] = copy.deepcopy(doc)

    def reset(self):
        self.docs.clear()


class CborCodecTest(unittest.TestCase):
    def test_roundtrip_maps_bytes_ints(self):
        from services._cbor import cbor_dumps, cbor_loads
        value = {1: 2, 3: -7, -1: 1, -2: b"\x00" * 32, -3: b"\xff" * 32, "x": "text", "arr": [1, 2, -3]}
        self.assertEqual(cbor_loads(cbor_dumps(value)), value)

    def test_bounds_and_errors(self):
        from services._cbor import CborError, cbor_loads
        with self.assertRaises(CborError):
            cbor_loads(b"")  # empty
        with self.assertRaises(CborError):
            cbor_loads(b"\x18\x01")  # non-minimal length
        with self.assertRaises(CborError):
            cbor_loads(b"\xa0\x01")  # trailing bytes


class PinStoreTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import services.mode_lock as ml
        self.ml = ml
        self.store = _MemStore()
        self._p1 = mock.patch("services.mode_lock._doc", side_effect=self.store.get)
        self._p2 = mock.patch("services.mode_lock._set_doc", side_effect=self.store.set)
        self._p1.start()
        self._p2.start()
        self.addCleanup(self._p1.stop)
        self.addCleanup(self._p2.stop)

    async def test_set_verify_and_status_never_exposes_hash(self):
        await self.ml.set_pin("1234")
        status = await self.ml.mode_lock_status()
        self.assertTrue(status["configured"])
        self.assertIn("pin", status["methods"])
        self.assertNotIn("pin_hash", json.dumps(status))
        self.assertTrue(await self.ml.verify_pin_against_store("1234"))
        self.assertFalse(await self.ml.verify_pin_against_store("0000"))
        # stored document never contains plaintext
        raw = json.dumps(self.store.docs.get("mode_lock"))
        self.assertNotIn("1234", raw)

    async def test_duplicate_pin_set_rejected(self):
        await self.ml.set_pin("1234")
        with self.assertRaises(ValueError):
            await self.ml.set_pin("5678")

    async def test_change_requires_current(self):
        await self.ml.set_pin("1234")
        with self.assertRaises(ValueError):
            await self.ml.change_pin("9999", "1111")
        await self.ml.change_pin("1234", "5678")
        self.assertTrue(await self.ml.verify_pin_against_store("5678"))

    async def test_disable_pin_drops_lock(self):
        await self.ml.set_pin("1234")
        await self.ml.set_lock_enabled(True)
        result = await self.ml.disable_pin("1234")
        self.assertTrue(result["lockDisabled"])
        status = await self.ml.mode_lock_status()
        self.assertFalse(status["lockEnabled"])
        self.assertFalse(status["configured"])

    async def test_lock_cannot_enable_without_method(self):
        with self.assertRaises(ValueError):
            await self.ml.set_lock_enabled(True)

    async def test_validate_pin_rules(self):
        with self.assertRaises(ValueError):
            await self.ml.set_pin("12")
        with self.assertRaises(ValueError):
            await self.ml.set_pin("ab-cd")


class UnlockTokenTest(unittest.IsolatedAsyncioTestCase):
    def _secret(self):
        from config import settings
        settings.jwt_secret = "test-secret-123"

    def test_valid_token(self):
        from services.mode_lock import issue_unlock_token, verify_unlock_token
        self._secret()
        token = issue_unlock_token()
        self.assertTrue(token)
        self.assertTrue(verify_unlock_token(token))

    def test_tampered_token(self):
        from services.mode_lock import issue_unlock_token, verify_unlock_token
        self._secret()
        token = issue_unlock_token()
        bad = token[:-2] + ("aa" if not token[-2:] == "aa" else "bb")
        self.assertFalse(verify_unlock_token(bad))

    def test_expired_token(self):
        from services.mode_lock import _token_secret, b64u, verify_unlock_token
        self._secret()
        import hmac as hmac_mod
        now = int(time.time())
        payload = {"purpose": "mode_unlock", "iat": now - 1000, "nbf": now - 1000, "exp": now - 500, "jti": "x"}
        body = b64u(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
        sig = hmac_mod.new(_token_secret(), body.encode("ascii"), hashlib.sha256).digest()
        self.assertFalse(verify_unlock_token(f"{body}.{b64u(sig)}"))

    def test_wrong_purpose(self):
        from services.mode_lock import _token_secret, b64u, verify_unlock_token
        import hmac as hmac_mod
        self._secret()
        now = int(time.time())
        payload = {"purpose": "something_else", "iat": now, "nbf": now, "exp": now + 100, "jti": "x"}
        body = b64u(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
        sig = hmac_mod.new(_token_secret(), body.encode("ascii"), hashlib.sha256).digest()
        self.assertFalse(verify_unlock_token(f"{body}.{b64u(sig)}"))

    def test_no_secret_fails_closed(self):
        from config import settings
        from services.mode_lock import issue_unlock_token, verify_unlock_token
        original = settings.jwt_secret
        settings.jwt_secret = ""
        try:
            self.assertIsNone(issue_unlock_token())
            self.assertFalse(verify_unlock_token("anything"))
        finally:
            settings.jwt_secret = original


class WebAuthnFlowTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import services.mode_lock as ml
        self.ml = ml
        from config import settings
        settings.jwt_secret = "test-secret-123"
        settings.cors_origins = "http://localhost:3000"
        self.store = _MemStore()
        self._p1 = mock.patch("services.mode_lock._doc", side_effect=self.store.get)
        self._p2 = mock.patch("services.mode_lock._set_doc", side_effect=self.store.set)
        self._p1.start()
        self._p2.start()
        self.addCleanup(self._p1.stop)
        self.addCleanup(self._p2.stop)
        self.key = ec.generate_private_key(ec.SECP256R1())
        pub = self.key.public_key().public_numbers()
        self.x = pub.x.to_bytes(32, "big")
        self.y = pub.y.to_bytes(32, "big")
        self.cred_id = b"test-credential-id-0123456789"

    def _cose_key(self) -> bytes:
        from services._cbor import cbor_dumps
        return cbor_dumps({1: 2, 3: -7, -1: 1, -2: self.x, -3: self.y})

    def _auth_data(self, challenge: str, flags: int, with_cred: bool) -> bytes:
        rp_id_hash = hashlib.sha256(b"localhost").digest()
        sign_count = b"\x00\x00\x00\x01"
        header = rp_id_hash + bytes([flags]) + sign_count
        if not with_cred:
            return header + b"\x00\x00\x00\x02"
        aaguid = b"\x00" * 16
        cred_len = len(self.cred_id).to_bytes(2, "big")
        return header + aaguid + cred_len + self.cred_id + self._cose_key()

    def _client_json(self, typ: str, challenge: str) -> bytes:
        return json.dumps({
            "type": typ,
            "challenge": challenge,
            "origin": "http://localhost:3000",
            "crossOrigin": False,
        }).encode("utf-8")

    async def test_register_then_authenticate_end_to_end(self):
        # ---- registration ----
        opts = await self.ml.webauthn_register_options()
        self.assertEqual(opts["rp"]["id"], "localhost")
        challenge = opts["challenge"]
        client = self._client_json("webauthn.create", challenge)
        auth_data = self._auth_data(challenge, flags=0x45, with_cred=True)  # UP|AT
        from services._cbor import cbor_dumps
        attestation = cbor_dumps({1: "none", 2: {}, 3: auth_data})
        result = await self.ml.webauthn_register_complete({
            "credentialId": _b64u(self.cred_id),
            "clientDataJSON": _b64u(client),
            "attestationObject": _b64u(attestation),
        })
        self.assertTrue(result["ok"])

        status = await self.ml.mode_lock_status()
        self.assertIn("webauthn", status["methods"])

        # duplicate registration rejected
        with self.assertRaises(ValueError):
            await self.ml.webauthn_register_options()

        # ---- assertion ----
        auth_opts = await self.ml.webauthn_authenticate_options()
        ch = auth_opts["challenge"]
        self.assertEqual(auth_opts["allowCredentials"][0]["id"], _b64u(self.cred_id))
        client_get = self._client_json("webauthn.get", ch)
        auth_data_get = self._auth_data(ch, flags=0x01, with_cred=False)
        signed = auth_data_get + hashlib.sha256(client_get).digest()
        # Real authenticators emit RAW r||s (64 bytes); build that form.
        from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
        r, s = decode_dss_signature(self.key.sign(signed, ec.ECDSA(hashes.SHA256())))
        sig = r.to_bytes(32, "big") + s.to_bytes(32, "big")
        self.assertEqual(len(sig), 64)
        done = await self.ml.webauthn_authenticate_complete({
            "credentialId": _b64u(self.cred_id),
            "clientDataJSON": _b64u(client_get),
            "authenticatorData": _b64u(auth_data_get),
            "signature": _b64u(sig),
        })
        self.assertTrue(done["ok"])

    async def test_assertion_rejects_bad_signature(self):
        from services._cbor import cbor_dumps
        opts = await self.ml.webauthn_register_options()
        client = self._client_json("webauthn.create", opts["challenge"])
        auth_data = self._auth_data(opts["challenge"], flags=0x45, with_cred=True)
        await self.ml.webauthn_register_complete({
            "credentialId": _b64u(self.cred_id),
            "clientDataJSON": _b64u(client),
            "attestationObject": _b64u(cbor_dumps({1: "none", 2: {}, 3: auth_data})),
        })
        auth_opts = await self.ml.webauthn_authenticate_options()
        client_get = self._client_json("webauthn.get", auth_opts["challenge"])
        auth_data_get = self._auth_data(auth_opts["challenge"], flags=0x01, with_cred=False)
        signed = auth_data_get + hashlib.sha256(client_get).digest()
        sig = self.key.sign(signed, ec.ECDSA(hashes.SHA256()))
        bad = sig[:-2] + (b"\x00" if sig[-2] != 0 else b"\x01") + sig[-1:]
        with self.assertRaises(ValueError):
            await self.ml.webauthn_authenticate_complete({
                "credentialId": _b64u(self.cred_id),
                "clientDataJSON": _b64u(client_get),
                "authenticatorData": _b64u(auth_data_get),
                "signature": _b64u(bad),
            })

    async def test_assertion_challenge_is_single_use(self):
        from services._cbor import cbor_dumps
        opts = await self.ml.webauthn_register_options()
        client = self._client_json("webauthn.create", opts["challenge"])
        auth_data = self._auth_data(opts["challenge"], flags=0x45, with_cred=True)
        await self.ml.webauthn_register_complete({
            "credentialId": _b64u(self.cred_id),
            "clientDataJSON": _b64u(client),
            "attestationObject": _b64u(cbor_dumps({1: "none", 2: {}, 3: auth_data})),
        })
        auth_opts = await self.ml.webauthn_authenticate_options()
        client_get = self._client_json("webauthn.get", auth_opts["challenge"])
        auth_data_get = self._auth_data(auth_opts["challenge"], flags=0x01, with_cred=False)
        signed = auth_data_get + hashlib.sha256(client_get).digest()
        sig = self.key.sign(signed, ec.ECDSA(hashes.SHA256()))
        payload = {
            "credentialId": _b64u(self.cred_id),
            "clientDataJSON": _b64u(client_get),
            "authenticatorData": _b64u(auth_data_get),
            "signature": _b64u(sig),
        }
        self.assertTrue((await self.ml.webauthn_authenticate_complete(payload))["ok"])
        with self.assertRaises(ValueError):
            await self.ml.webauthn_authenticate_complete(payload)

    async def test_rejects_wrong_origin(self):
        from services._cbor import cbor_dumps
        opts = await self.ml.webauthn_register_options()
        client = json.dumps({
            "type": "webauthn.create",
            "challenge": opts["challenge"],
            "origin": "https://evil.example",
        }).encode("utf-8")
        auth_data = self._auth_data(opts["challenge"], flags=0x45, with_cred=True)
        with self.assertRaises(ValueError):
            await self.ml.webauthn_register_complete({
                "credentialId": _b64u(self.cred_id),
                "clientDataJSON": _b64u(client),
                "attestationObject": _b64u(cbor_dumps({1: "none", 2: {}, 3: auth_data})),
            })


class SettingsServiceIntegrationTest(unittest.TestCase):
    def test_terminal_mode_presets_json_validation(self):
        from services.settings_service import _validate_setting, DEFAULTS
        self.assertIn("terminal_mode", DEFAULTS)
        self.assertEqual(DEFAULTS["terminal_mode"]["options"], ["kotak", "shoonya", "dummy"])
        _validate_setting("terminal_mode", "dummy")
        with self.assertRaises(ValueError):
            _validate_setting("terminal_mode", "paper")
        _validate_setting("terminal_mode_presets", '{"dummy": {}, "kotak": {}}')
        _validate_setting("terminal_mode_presets", {"dummy": {}})
        with self.assertRaises(ValueError):
            _validate_setting("terminal_mode_presets", '[1,2,3]')
        with self.assertRaises(ValueError):
            _validate_setting("terminal_mode_presets", "not-json")


class SwitchGateContractTest(unittest.IsolatedAsyncioTestCase):
    async def test_switch_open_when_lock_off(self):
        from api.terminal import require_mode_unlock
        from starlette.requests import Request
        req = Request({"type": "http", "method": "POST", "headers": []})
        with mock.patch("services.mode_lock.mode_lock_status", new=mock.AsyncMock(return_value={
            "lockEnabled": False, "configured": True,
        })):
            result = await require_mode_unlock(req)
        self.assertIsNone(result)

    async def test_switch_423_when_locked_without_token(self):
        from fastapi import HTTPException
        from api.terminal import require_mode_unlock
        from starlette.requests import Request
        req = Request({"type": "http", "method": "POST", "headers": []})
        with mock.patch("services.mode_lock.mode_lock_status", new=mock.AsyncMock(return_value={
            "lockEnabled": True, "configured": True,
        })):
            with self.assertRaises(HTTPException) as ctx:
                await require_mode_unlock(req)
        self.assertEqual(ctx.exception.status_code, 423)
        self.assertEqual(ctx.exception.detail.get("code"), "MODE_LOCKED")

    async def test_switch_allowed_when_locked_with_valid_token(self):
        from services.mode_lock import issue_unlock_token
        from api.terminal import require_mode_unlock
        from starlette.requests import Request
        token = issue_unlock_token()
        headers = [(b"x-mode-unlock", token.encode("ascii"))]
        req = Request({"type": "http", "method": "POST", "headers": headers})
        with mock.patch("services.mode_lock.mode_lock_status", new=mock.AsyncMock(return_value={
            "lockEnabled": True, "configured": True,
        })):
            result = await require_mode_unlock(req)
        self.assertIsNone(result)

    async def test_security_routes_registered(self):
        from api.security import router
        paths = {getattr(r, "path", "") for r in router.routes}
        for expected in (
            "/api/terminal/security",
            "/api/terminal/security/pin",
            "/api/terminal/security/lock",
            "/api/terminal/security/unlock",
            "/api/terminal/security/webauthn/register/begin",
            "/api/terminal/security/webauthn/register/complete",
            "/api/terminal/security/webauthn/authenticate/begin",
            "/api/terminal/security/webauthn/authenticate/complete",
        ):
            self.assertIn(expected, paths)

    async def test_switch_route_uses_mode_unlock_gate(self):
        from api.terminal import router
        switch = next(r for r in router.routes if getattr(r, "path", "") == "/api/terminal/switch")
        deps = [d for d in getattr(switch, "dependant", None).dependencies
                if getattr(getattr(d, "call", None), "__name__", "") == "require_mode_unlock"]
        self.assertEqual(len(deps), 1)

    async def test_connect_route_still_requires_jwt(self):
        from api.terminal import router
        connect = next(r for r in router.routes if getattr(r, "path", "") == "/api/terminal/connect")
        deps = [d for d in getattr(connect, "dependant", None).dependencies
                if getattr(getattr(d, "call", None), "__name__", "") == "require_jwt"]
        self.assertEqual(len(deps), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)