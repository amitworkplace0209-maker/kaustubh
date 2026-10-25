"""Mode Lock — server-side protection of Trading Terminal mode switching.

Honest scope / design:

  * Mode Lock OFF (default): ``POST /api/terminal/switch`` is passwordless.
  * Mode Lock ON: switching requires a SHORT-LIVED unlock token in the
    ``x-mode-unlock`` header (the API raises HTTP 423 ``MODE_LOCKED`` without
    it). Unlock is granted by a correct PIN and/or a real WebAuthn platform
    authenticator.
  * Configuration lives in MongoDB ``terminal_security``:
      - ``{key: 'mode_lock'}`` : enabled flag + salted PBKDF2-SHA256 PIN hash
      - ``{key: 'webauthn'}``  : passkey credential (raw COSE public key)
    The PIN hash is NEVER exposed over any API.
  * Unlock tokens are HMAC-SHA256 over a JSON payload signed with
    ``settings.jwt_secret`` (~2-minute TTL, single use by the caller).
  * WebAuthn registration + assertion are genuinely verified server-side:
    origin allow-list, challenge freshness, rpIdHash and an ECDSA P-256
    signature over ``authenticatorData || SHA256(clientDataJSON)`` using
    ``cryptography``. Attestation *statements* (device-bound trust) are NOT
    verified — a passkey cryptographically proves key possession, which is the
    honest scope for a local relying party.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import secrets
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature, encode_dss_signature
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

from services._cbor import cbor_loads

logger = logging.getLogger("mode_lock")

_BUCKET = "terminal_security"
_PIN_ITERATIONS = 310_000
_UNLOCK_TTL_SECONDS = 120
_CHALLENGE_TTL_SECONDS = 300
_WEBAUTHN_ALG = -7   # COSE alg ES256
_WEBAUTHN_CRV = 1    # COSE crv P-256

# brute-force window: >5 failed unlocks / minute per (ip, method) -> 429
_FAIL_WINDOW_SECONDS = 60
_MAX_FAILS_PER_WINDOW = 5
_fail_windows: dict[tuple[str, str], tuple[int, float]] = {}

# in-memory single-use challenge registry (this backend is a single process)
_challenges: dict[str, dict] = {}


# ---- byte helpers ------------------------------------------------------------

def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def b64u_decode(s: str) -> bytes:
    s = (s or "").strip()
    if not s:
        return b""
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _doc(key: str) -> dict | None:
    try:
        from database.connection import get_db
        db = get_db()
    except Exception:
        logger.debug("mode lock: database not connected")
        return None
    return await db[_BUCKET].find_one({"key": key})


async def _set_doc(key: str, doc: dict) -> None:
    from database.connection import get_db
    await get_db()[_BUCKET].update_one({"key": key}, {"$set": doc}, upsert=True)


# ---- PIN hashing (PBKDF2-SHA256, salted, constant-time verify) ---------------

def validate_pin(pin: str) -> None:
    if not isinstance(pin, str) or not pin.isdigit() or not (4 <= len(pin) <= 8):
        raise ValueError("PIN must be 4-8 digits")


def _hash_pin(pin: str, salt: bytes, iterations: int = _PIN_ITERATIONS) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations)
    return kdf.derive(pin.encode("utf-8"))


def _verify_pin(pin: str, pin_doc) -> bool:
    if not pin_doc or not pin_doc.get("hash"):
        return False
    try:
        salt = b64u_decode(str(pin_doc["salt"]))
        iterations = int(pin_doc.get("iterations") or _PIN_ITERATIONS)
        candidate = _hash_pin(pin, salt, iterations)
        stored = b64u_decode(str(pin_doc["hash"]))
    except Exception:
        return False
    return hmac.compare_digest(stored, candidate)


async def _store_pin(pin: str, salt: bytes, enabled: bool | None = None) -> dict:
    validate_pin(pin)
    pin_doc = {
        "hash": b64u(_hash_pin(pin, salt)),
        "salt": b64u(salt),
        "iterations": _PIN_ITERATIONS,
        "algo": "pbkdf2-sha256",
    }
    lock = await _doc("mode_lock") or {}
    if enabled is None:
        enabled = bool(lock.get("enabled"))
    lock.update({
        "enabled": enabled,
        "pin": pin_doc,
        "updated_at": _iso_now(),
    })
    await _set_doc("mode_lock", lock)
    return {"ok": True, "configured": True}


async def set_pin(pin: str) -> dict:
    validate_pin(pin)
    lock = await _doc("mode_lock") or {}
    if lock.get("pin") and lock["pin"].get("hash"):
        raise ValueError("a Mode Lock PIN is already configured — change or disable it first")
    return await _store_pin(pin, secrets.token_bytes(16))


async def change_pin(current: str, new: str) -> dict:
    lock = await _doc("mode_lock") or {}
    if not _verify_pin(current, lock.get("pin")):
        raise ValueError("current PIN is incorrect")
    validate_pin(new)
    return await _store_pin(new, secrets.token_bytes(16), enabled=bool(lock.get("enabled")))


async def disable_pin(pin: str) -> dict:
    lock = await _doc("mode_lock") or {}
    if not _verify_pin(pin, lock.get("pin")):
        raise ValueError("PIN is incorrect")
    lock["pin"] = None
    lock["enabled"] = False  # a lock with no unlock method must never stay enabled
    lock["updated_at"] = _iso_now()
    await _set_doc("mode_lock", lock)
    return {"ok": True, "disabled": True, "lockDisabled": True}


async def verify_pin_against_store(pin: str) -> bool:
    lock = await _doc("mode_lock") or {}
    return _verify_pin(pin, lock.get("pin"))


# ---- lock state ---------------------------------------------------------------

async def _webauthn_credential() -> dict | None:
    wn = await _doc("webauthn")
    if not wn or not wn.get("credential_id"):
        return None
    return wn


async def mode_lock_status() -> dict:
    # Both documents are independent; issuing the reads together removes one
    # sequential Atlas round trip from every terminal page load.
    lock, wn = await asyncio.gather(_doc("mode_lock"), _doc("webauthn"))
    lock = lock or {}
    if not wn or not wn.get("credential_id"):
        wn = None
    pin_ok = bool(lock.get("pin") and lock["pin"].get("hash"))
    methods: list[str] = []
    if pin_ok:
        methods.append("pin")
    if wn:
        methods.append("webauthn")
    return {
        "ok": True,
        "lockEnabled": bool(lock.get("enabled")),
        "configured": bool(pin_ok or wn),
        "methods": methods,
        "webauthnRegistered": bool(wn),
    }


async def set_lock_enabled(flag: bool) -> dict:
    lock = await _doc("mode_lock") or {}
    if flag and not (bool(lock.get("pin") and lock["pin"].get("hash")) or await _webauthn_credential()):
        raise ValueError("cannot enable Mode Lock: set a PIN or register biometrics first")
    lock["enabled"] = bool(flag)
    lock["updated_at"] = _iso_now()
    await _set_doc("mode_lock", lock)
    return {"ok": True, "lockEnabled": bool(flag)}


# ---- unlock tokens (HMAC-SHA256, ~2-minute TTL) ------------------------------

def _token_secret() -> bytes:
    from config.settings import settings
    secret = getattr(settings, "jwt_secret", None)
    if not secret:
        raise ValueError("JWT_SECRET not configured")
    return str(secret).encode("utf-8")


def issue_unlock_token() -> str | None:
    try:
        secret = _token_secret()
    except ValueError:
        return None
    now = int(time.time())
    payload = {
        "purpose": "mode_unlock",
        "iat": now,
        "nbf": now,
        "exp": now + _UNLOCK_TTL_SECONDS,
        "jti": secrets.token_hex(8),
    }
    body = b64u(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    sig = hmac.new(secret, body.encode("ascii"), hashlib.sha256).digest()
    return f"{body}.{b64u(sig)}"


def verify_unlock_token(token: str | None) -> bool:
    if not token:
        return False
    try:
        secret = _token_secret()
    except ValueError:
        return False
    try:
        body, raw_sig = token.split(".", 1)
        sig = b64u_decode(raw_sig)
    except Exception:
        return False
    expected = hmac.new(secret, body.encode("ascii"), hashlib.sha256).digest()
    if not hmac.compare_digest(sig, expected):
        return False
    try:
        payload = json.loads(b64u_decode(body).decode("utf-8"))
    except Exception:
        return False
    if payload.get("purpose") != "mode_unlock":
        return False
    now = int(time.time())
    if payload.get("nbf", 0) > now or payload.get("exp", 0) < now:
        return False
    return True


# ---- challenges ---------------------------------------------------------------

def _new_challenge(purpose: str) -> str:
    ch = b64u(secrets.token_bytes(32))
    _challenges[ch] = {"purpose": purpose, "exp": time.time() + _CHALLENGE_TTL_SECONDS}
    return ch


def _consume_challenge(ch: str, purpose: str) -> bool:
    rec = _challenges.pop(ch, None)
    if not rec:
        return False
    if rec.get("purpose") != purpose:
        return False
    if rec.get("exp", 0) < time.time():
        return False
    return True


# ---- WebAuthn origin / rpId helpers -------------------------------------------

def _allowed_origins() -> list[str]:
    from config.settings import settings
    raw = getattr(settings, "cors_origins", None) or "http://localhost:3000"
    origins = [o.strip().rstrip("/") for o in str(raw).split(",") if o.strip()]
    if "http://localhost:3000" not in origins:
        origins.append("http://localhost:3000")
    return origins


def _rp_id_for_origin(origin: str) -> str:
    return (urlsplit(origin).hostname or "").lower()


def _rp_id_hash(rp_id: str) -> bytes:
    return hashlib.sha256(rp_id.encode("utf-8")).digest()


def _rp_id_matches(origin: str, rp_id_hash: bytes) -> bool:
    return hmac.compare_digest(_rp_id_hash(_rp_id_for_origin(origin)), rp_id_hash)


# ---- authenticatorData / COSE parsing ------------------------------------------

def _parse_authenticator_data(raw: bytes, need_attested: bool = False) -> tuple[dict, dict | None]:
    """Parse WebAuthn authenticatorData; optionally extract attested credential.
    Returns (header, attested_credential | None)."""
    if len(raw) < 37:
        raise ValueError("authenticatorData too short")
    rp_id_hash = raw[0:32]
    flags = raw[32]
    sign_count = int.from_bytes(raw[33:37], "big")
    offset = 37
    cred: dict | None = None
    if flags & 0x40:  # AT flag — attested credential data present
        if len(raw) < offset + 18:
            raise ValueError("attested credential data truncated")
        aaguid = raw[offset:offset + 16]
        cred_len = int.from_bytes(raw[offset + 16:offset + 18], "big")
        offset += 18
        cred_end = offset + cred_len
        if cred_end > len(raw):
            raise ValueError("credential id truncated")
        cred_id = raw[offset:cred_end]
        public_key = raw[cred_end:]
        if not public_key:
            raise ValueError("credential public key missing")
        cred = {
            "aaguid": aaguid,
            "credential_id": cred_id,
            "public_key": public_key,
        }
    elif need_attested:
        raise ValueError("attested credential data missing")
    header = {
        "rp_id_hash": rp_id_hash,
        "flags": {
            "up": bool(flags & 0x01),
            "uv": bool(flags & 0x04),
            "at": bool(flags & 0x40),
        },
        "sign_count": sign_count,
    }
    return header, cred


def _cose_key_to_ec_public_key(cose_raw: bytes):
    cose = cbor_loads(cose_raw)
    if not isinstance(cose, dict):
        raise ValueError("COSE public key must be a map")
    kty = cose.get(1)
    alg = cose.get(3)
    crv = cose.get(-1)
    x = cose.get(-2)
    y = cose.get(-3)
    if kty != 2 or alg != _WEBAUTHN_ALG or crv != _WEBAUTHN_CRV:
        raise ValueError(f"unsupported COSE key (kty={kty} alg={alg} crv={crv}) — expected EC2/ES256/P-256")
    if not isinstance(x, bytes) or not isinstance(y, bytes) or len(x) != 32 or len(y) != 32:
        raise ValueError("invalid P-256 public key coordinates")
    return ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), b"\x04" + x + y)


def _verify_es256(pub_key, signed: bytes, sig_raw: bytes) -> bool:
    """Verify an ES256 signature that may be raw (r||s, 64 bytes) or DER."""
    try:
        if len(sig_raw) == 64:
            r = int.from_bytes(sig_raw[0:32], "big")
            s = int.from_bytes(sig_raw[32:64], "big")
        else:
            r, s = decode_dss_signature(sig_raw)
        pub_key.verify(encode_dss_signature(r, s), signed, ec.ECDSA(hashes.SHA256()))
        return True
    except Exception:
        return False


# ---- WebAuthn registration ------------------------------------------------------

async def webauthn_register_options() -> dict:
    if await _webauthn_credential():
        raise ValueError("biometric already registered — disable/remove it first")
    challenge = _new_challenge("register")
    origins = _allowed_origins()
    rp_id = _rp_id_for_origin(origins[0])
    user_id = hashlib.sha256("kaustubh-terminal-user".encode("utf-8")).digest()
    return {
        "challenge": challenge,
        "rp": {"id": rp_id, "name": "KAUSTUBH Trading Terminal"},
        "user": {
            "id": b64u(user_id),
            "name": "terminal-user",
            "displayName": "KAUSTUBH Terminal",
        },
        "pubKeyCredParams": [{"type": "public-key", "alg": _WEBAUTHN_ALG}],
        "authenticatorSelection": {
            "authenticatorAttachment": "platform",
            "userVerification": "preferred",
        },
        "timeout": 60000,
        "attestation": "none",
        "excludeCredentials": [],
    }


async def webauthn_register_complete(payload: dict) -> dict:
    """Verify and store a passkey registration.

    ``payload`` uses the WebAuthn response contract (base64url strings):
    ``credentialId``, ``clientDataJSON``, ``attestationObject``.
    """
    try:
        client_raw = b64u_decode(str(payload["clientDataJSON"]))
        attestation_raw = b64u_decode(str(payload["attestationObject"]))
    except KeyError as exc:
        raise ValueError(f"missing registration field: {exc}") from exc
    except Exception as exc:
        raise ValueError("registration payload is not valid base64url") from exc

    try:
        client = json.loads(client_raw.decode("utf-8"))
    except Exception as exc:
        raise ValueError("clientDataJSON is not valid JSON") from exc
    if client.get("type") != "webauthn.create":
        raise ValueError("registration response has wrong type")
    if not _consume_challenge(str(client.get("challenge", "")), "register"):
        raise ValueError("registration challenge missing or expired")
    origin = str(client.get("origin", ""))
    if origin not in _allowed_origins():
        raise ValueError(f"registration origin not allowed: {origin}")

    try:
        attestation = cbor_loads(attestation_raw)
    except Exception as exc:
        raise ValueError(f"invalid attestationObject: {exc}") from exc
    if not isinstance(attestation, dict):
        raise ValueError("invalid attestation object")
    auth_data_raw = attestation.get(3)  # "authData" key in WebAuthn attestation CBOR
    if not isinstance(auth_data_raw, bytes):
        raise ValueError("authenticatorData missing from attestationObject")

    try:
        auth_data, cred = _parse_authenticator_data(auth_data_raw, need_attested=True)
    except ValueError as exc:
        raise ValueError(f"invalid authenticatorData: {exc}") from exc
    if not _rp_id_matches(origin, auth_data["rp_id_hash"]):
        raise ValueError("rpIdHash mismatch")
    if not auth_data["flags"]["up"]:
        raise ValueError("user presence flag not set")
    cred_id = (cred or {}).get("credential_id")
    if not cred_id or cred_id != b64u_decode(str(payload.get("credentialId", ""))):
        raise ValueError("credential id mismatch")
    # attestation statements are intentionally not verified (local RP, see module doc).

    wn = {
        "key": "webauthn",
        "credential_id": b64u(cred_id),
        "credential_public_key": b64u((cred or {})["public_key"]),
        "sign_count": auth_data["sign_count"],
        "rp_id": _rp_id_for_origin(origin),
        "alg": _WEBAUTHN_ALG,
        "created_at": _iso_now(),
    }
    await _set_doc("webauthn", wn)
    logger.info("Mode Lock: WebAuthn credential registered")
    return {"ok": True, "credentialId": wn["credential_id"]}


# ---- WebAuthn assertion ---------------------------------------------------------

async def webauthn_authenticate_options() -> dict:
    wn = await _webauthn_credential()
    if not wn:
        raise ValueError("no biometric registered for this terminal")
    return {
        "challenge": _new_challenge("authenticate"),
        "rpId": wn.get("rp_id") or "localhost",
        "allowCredentials": [{"type": "public-key", "id": wn["credential_id"]}],
        "timeout": 60000,
        "userVerification": "preferred",
    }


async def webauthn_authenticate_complete(payload: dict) -> dict:
    """Verify a passkey assertion. ``payload``: ``credentialId``,
    ``clientDataJSON``, ``authenticatorData``, ``signature`` (base64url)."""
    wn = await _webauthn_credential()
    if not wn:
        raise ValueError("no biometric registered for this terminal")
    peer_id = str(payload.get("credentialId") or payload.get("rawId") or "")
    if peer_id != wn["credential_id"]:
        raise ValueError("unknown credential id")

    try:
        client_raw = b64u_decode(str(payload["clientDataJSON"]))
        auth_data_raw = b64u_decode(str(payload["authenticatorData"]))
        sig_raw = b64u_decode(str(payload["signature"]))
    except Exception as exc:
        raise ValueError("assertion payload is not valid base64url") from exc
    try:
        client = json.loads(client_raw.decode("utf-8"))
    except Exception as exc:
        raise ValueError("clientDataJSON is not valid JSON") from exc
    if client.get("type") != "webauthn.get":
        raise ValueError("assertion response has wrong type")
    if not _consume_challenge(str(client.get("challenge", "")), "authenticate"):
        raise ValueError("assertion challenge missing or expired")
    origin = str(client.get("origin", ""))
    if origin not in _allowed_origins():
        raise ValueError(f"assertion origin not allowed: {origin}")

    try:
        auth_data, _ = _parse_authenticator_data(auth_data_raw, need_attested=False)
    except ValueError as exc:
        raise ValueError(f"invalid authenticatorData: {exc}") from exc
    if not _rp_id_matches(origin, auth_data["rp_id_hash"]):
        raise ValueError("rpIdHash mismatch")
    if not auth_data["flags"]["up"]:
        raise ValueError("user presence flag not set")

    try:
        pub_key = _cose_key_to_ec_public_key(b64u_decode(wn["credential_public_key"]))
    except ValueError as exc:
        raise ValueError(f"stored credential public key is invalid: {exc}") from exc

    signed = auth_data_raw + hashlib.sha256(client_raw).digest()
    if not _verify_es256(pub_key, signed, sig_raw):
        raise ValueError("invalid authenticator signature")

    prev = int(wn.get("sign_count") or 0)
    if auth_data["sign_count"] > prev:
        wn["sign_count"] = auth_data["sign_count"]
        await _set_doc("webauthn", wn)
    return {"ok": True}