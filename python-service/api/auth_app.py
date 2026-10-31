"""App-level authentication API for the single-owner KDS trading platform.

This module is the VM1 port of the audit-proven Next.js auth layer
(``lib/auth-*.ts`` under the frontend root). Every contract — status codes,
JSON field names, cookie names/attributes, hashing parameters, lockout
counters — matches the frontend implementation exactly, because the Vercel
routes became thin proxies over this API (see ``lib/auth-proxy.ts``).

Endpoints (all under the shared ``/api/auth`` prefix of the FastAPI backend):

    POST  /api/auth/signup              - one-time owner bootstrap
    POST  /api/auth/login               - password login, OTP for a 2nd device
    POST  /api/auth/login/verify-otp    - complete the second-device login
    POST  /api/auth/session/revoke      - app-session logout (POST + legacy DELETE)
    GET   /api/auth/status              - public bootstrap probe for /login
    GET   /api/auth/session             - single source of truth for the UI
    GET   /api/auth/whoami              - requireSession-equivalent gate (proxies)
    GET   /api/auth/live                - tiny session-liveness probe (middleware)
    GET   /api/auth/devices             - active logins with real IP + timestamps
    POST  /api/auth/devices/revoke      - {sessionId | deviceId | all}
    GET   /api/auth/overview            - one payload for Security settings
    GET   /api/auth/events              - the login/IP audit trail
    GET   /api/auth/setup               - legacy MPIN card read
    POST  /api/auth/setup               - legacy MPIN card create (step=create-pin)
    POST  /api/auth/mpin/setup|verify|change|disable
    POST  /api/auth/pin/change|disable  - legacy aliases
    GET   /api/auth/webauthn/credentials       - data plane for the Vercel crypto
    POST  /api/auth/webauthn/credentials       - persist a verified credential
    DELETE /api/auth/webauthn/credentials      - remove with the self-lockout guard
    POST  /api/auth/webauthn/challenge         - persist a WebAuthn challenge (TTL)
    POST  /api/auth/webauthn/challenge/take    - consume a challenge exactly once
    POST  /api/auth/webauthn/counters          - persist counter + login/failed event
    GET   /api/auth/health              - service health (mongo + session secret)

Deliberately NOT here: ``DELETE /api/auth/login`` stays the *broker* logout
(``api/auth.py``) and ``POST /api/auth/logout`` stays broker logout too — the
Vercel app-session proxies call ``POST /api/auth/session/revoke`` instead.

Database: reuses the ONE existing MongoDB connection (``database.connection``)
and the SAME ``app_auth_*`` collections and doc shapes the frontend created.
No separate auth database.

Security invariants (unchanged from the frontend layer):
  * scrypt password/MPIN hashing — ``scrypt$16384$8$1$<salt>$<key>`` (N=16384,
    r=8, p=1, keylen=64, per-secret base64url salt, NFKC normalization).
  * HMAC-SHA256 session tokens ``base64url(payload).base64url(sig)`` payload
    ``{v:2, authenticated:true, sid, did, iat, exp}`` signed with
    ``AUTH_SESSION_SECRET``/``APP_SESSION_SECRET`` (>= 32 chars).
  * ``kaustubh_session`` / ``kaustubh_mpin_pending`` cookies: httpOnly,
    SameSite=Lax, Path=/, 7-day Max-Age, Secure when HTTPS.
  * Real client IP via the same forwarded-header order as the frontend;
    signup/login FAIL CLOSED (400 IP_REQUIRED) when it cannot be resolved.
  * In-memory sliding-window rate limits for signup / login / OTP verification.
  * Device policy: max 2 concurrent devices (``AUTH_MAX_ACTIVE_SESSIONS``,
    clamped 1..2); a second device always needs a FRESH email OTP; device-slot
    overflow is blocked server-side; repeat logins rotate the session.
  * Every attempt (success or failure) is appended to ``app_auth_events``.
  * MongoDB credentials exist only on VM1; nothing here is ever sent to the
    browser except the owner's own public profile.

Never exposes ``MONGODB_URI``, ``AUTH_SESSION_SECRET``, ``APP_PASSWORD`` or any
other credential in logs or responses.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import smtplib
import ssl as ssl_module
import time
import uuid
from datetime import date as _date
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path
from typing import Any
import unicodedata
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse

from core.timezones import now_ist
from database.connection import get_db, is_mongo_connected

router = APIRouter(prefix="/api/auth", tags=["auth-app"])

log = logging.getLogger("auth_app")

# ---------------------------------------------------------------------------
# Constants (byte-identical parity with lib/auth-crypto.ts + route constants)
# ---------------------------------------------------------------------------

SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000          # 7 days
OTP_TTL_MS = 10 * 60 * 1000                       # 10 minutes
MAX_OTP_ATTEMPTS = 5
SCRYPT_N = 16_384
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_KEYLEN = 64
SCRYPT_MAXMEM = 64 * 1024 * 1024

MAX_FAILED_MPIN_ATTEMPTS = 5
MPIN_LOCK_MS = 5 * 60 * 1000                      # 5 minutes MPIN lockout
MAX_PASSWORD_FAILURES = 8
PASSWORD_LOCK_MS = 15 * 60 * 1000                 # 15 minutes password lockout

SESSION_COOKIE = "kaustubh_session"
MPIN_PENDING_COOKIE = "kaustubh_mpin_pending"

WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000

# The frontend keeps this always at 1..2 (lib/auth-config.ts getMaxActiveSessions).
MAX_ACTIVE_SESSIONS_CLAMP = (1, 2)

ROTATION_EXCLUDE_REASONS = frozenset({"rotated"})


def _env(key: str, default: str = "") -> str:
    return (os.environ.get(key) or default).strip()


def _is_production() -> bool:
    """Frontend parity: NODE_ENV=production disables dev-side conveniences."""
    return _env("NODE_ENV").lower() == "production"


def _env_bool(key: str, default: bool) -> bool:
    value = _env(key).lower()
    if not value:
        return default
    return value in ("1", "true", "yes", "on")


def _env_int(key: str, default: int) -> int:
    try:
        return int(_env(key))
    except ValueError:
        return default


# ---------------------------------------------------------------------------
# Session signing secret (parity with lib/auth-crypto.ts resolution order)
# ---------------------------------------------------------------------------

_session_secret_cache: str | None = None


def _session_secret_candidates() -> list[tuple[str, Path]]:
    """Files to consider, in priority order, for the generated-secret fallback.

    The frontend root writes ``<repo>/.auth/session-secret`` and ``server.mjs``
    reads the same file, so local dev stays consistent across all three
    processes. VM1 (cwd = the python-service directory) checks the repo-root
    copy first, then its own ``.auth`` copy, and only generates its own file
    when neither exists (dev-only; production must set the env secret).
    """
    here = Path(__file__).resolve()
    root = here.parent.parent.parent           # .../python-service/api/x.py -> repo root
    return [
        ("repo-root", root / ".auth" / "session-secret"),
        ("cwd", Path.cwd() / ".auth" / "session-secret"),
    ]


def resolve_session_secret() -> str:
    """AUTH_SESSION_SECRET -> APP_SESSION_SECRET -> .auth/session-secret -> generate once."""
    global _session_secret_cache
    if _session_secret_cache is not None:
        return _session_secret_cache

    from_env = _env("AUTH_SESSION_SECRET") or _env("APP_SESSION_SECRET")
    if len(from_env) >= 32:
        _session_secret_cache = from_env
        return _session_secret_cache

    for label, path in _session_secret_candidates():
        try:
            if path.exists():
                stored = path.read_text("utf-8").strip()
                if len(stored) >= 32:
                    _session_secret_cache = stored
                    return _session_secret_cache
        except OSError:
            continue

    # No env secret and no stored file (dev box). Generate once and persist only
    # into the process-local `.auth` copy — the frontend resolves the same file
    # when it cannot reach the repo-root copy, and they agree by `wx` semantics.
    generated = secrets.token_hex(48)
    for label, path in _session_secret_candidates():
        if label == "repo-root":
            continue  # never write outside this service's own directory
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(str(path), "x", encoding="utf-8") as handle:
                handle.write(generated)
            stored = path.read_text("utf-8").strip()
            if len(stored) >= 32:
                generated = stored
            break
        except FileExistsError:
            try:
                generated = path.read_text("utf-8").strip()
            except OSError:
                pass
            break
        except OSError:
            continue

    if len(from_env) < 32 and not generated:
        generated = secrets.token_hex(48)
    _session_secret_cache = generated
    return _session_secret_cache


class SessionSecretNotConfigured(RuntimeError):
    """Raised when no usable signing secret exists (requests fail closed)."""


def _require_session_secret() -> str:
    secret = resolve_session_secret()
    if len(secret) < 32:
        raise SessionSecretNotConfigured(
            "Session secret not configured on the backend "
            "(set AUTH_SESSION_SECRET, at least 32 characters)."
        )
    return secret


# ---------------------------------------------------------------------------
# scrypt hashing + HMAC tokens (parity with lib/auth-crypto.ts)
# ---------------------------------------------------------------------------

def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def _hash_secret(secret: str) -> str:
    salt = os.urandom(16)
    try:
        derived = hashlib.scrypt(
            unicodedata.normalize("NFKC", str(secret)).encode("utf-8"),
            salt=salt,
            n=SCRYPT_N,
            r=SCRYPT_R,
            p=SCRYPT_P,
            dklen=SCRYPT_KEYLEN,
            maxmem=SCRYPT_MAXMEM,
        )
    except ValueError as exc:   # pragma: no cover - defensive
        raise RuntimeError(f"scrypt hashing failed: {exc}") from exc
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${_b64url_encode(salt)}${_b64url_encode(derived)}"


def _verify_secret(secret: str, stored: str | None) -> bool:
    if not stored:
        return False
    parts = stored.split("$")
    if len(parts) != 6 or parts[0] != "scrypt":
        return False
    _, n_raw, r_raw, p_raw, salt_b64, expected_b64 = parts
    try:
        n = int(n_raw)
        r = int(r_raw)
        p = int(p_raw)
    except ValueError:
        return False
    try:
        salt = _b64url_decode(salt_b64)
        expected = _b64url_decode(expected_b64)
    except Exception:
        return False
    try:
        derived = hashlib.scrypt(
            unicodedata.normalize("NFKC", str(secret)).encode("utf-8"),
            salt=salt,
            n=n,
            r=r,
            p=p,
            dklen=SCRYPT_KEYLEN,
            maxmem=SCRYPT_MAXMEM,
        )
    except ValueError:
        return False
    return hmac.compare_digest(derived, expected)


def _sign_payload(encoded: str, secret: str) -> str:
    return _b64url_encode(hmac.new(secret.encode("utf-8"), encoded.encode("utf-8"), hashlib.sha256).digest())


def _create_session_token(session_id: str, device_id: str) -> str:
    issued_at = int(time.time() * 1000)
    payload: dict[str, Any] = {
        "v": 2,
        "authenticated": True,
        "sid": session_id,
        "did": device_id,
        "iat": issued_at,
        "exp": issued_at + SESSION_TTL_MS,
    }
    encoded = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    return f"{encoded}.{_sign_payload(encoded, _require_session_secret())}"


def _verify_session_token(token: str | None) -> dict[str, Any] | None:
    if not token:
        return None
    parts = token.split(".")
    if len(parts) != 2:
        return None
    encoded, signature = parts
    try:
        secret = _require_session_secret()
    except Exception:
        return None
    expected = _b64url_encode(hmac.new(secret.encode("utf-8"), encoded.encode("utf-8"), hashlib.sha256).digest())
    try:
        provided = _b64url_decode(signature)
        wanted = _b64url_decode(expected)
    except Exception:
        return None
    if len(provided) != len(wanted) or not hmac.compare_digest(provided, wanted):
        return None
    try:
        payload = json.loads(_b64url_decode(encoded).decode("utf-8"))
    except Exception:
        return None
    if not isinstance(payload, dict) or payload.get("authenticated") is not True:
        return None
    try:
        expires = float(payload.get("exp"))
    except (TypeError, ValueError):
        return None
    if expires <= time.time() * 1000:
        return None
    return payload


def _constant_time_compare(a: str, b: str) -> bool:
    if len(a) != len(b):
        return False
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


# ---------------------------------------------------------------------------
# Rate limiting (parity with lib/auth-rate-limit.ts: in-memory sliding window)
# ---------------------------------------------------------------------------

_rate_buckets: dict[str, list[float]] = {}
_rate_last_sweep = 0.0


def _rate_sweep(now_ms: float) -> None:
    global _rate_last_sweep
    if now_ms - _rate_last_sweep < 60_000:
        return
    _rate_last_sweep = now_ms
    for key in [key for key, hits in _rate_buckets.items() if not hits]:
        _rate_buckets.pop(key, None)


def _rate_limit(kind: str, ip: str, limit: int, window_ms: int) -> tuple[bool, int]:
    """(allowed, retry_after_seconds) — the same math as checkRateLimit()."""
    now = time.time() * 1000
    _rate_sweep(now)
    key = f"{kind}:{ip}"
    hits = [t for t in _rate_buckets.get(key, []) if now - t < window_ms]
    if len(hits) >= limit:
        _rate_buckets[key] = hits
        oldest = hits[0]
        return False, max(1, int((window_ms - (now - oldest)) / 1000))
    hits.append(now)
    _rate_buckets[key] = hits
    return True, 0


def _rate_limit_or_429(kind: str, ip: str, limit: int, window_ms: int, message: str) -> None:
    """Exactly the wording the frontend routes used, with a numeric retry hint."""
    allowed, retry_after = _rate_limit(kind, ip, limit, window_ms)
    if not allowed:
        fail(f"{message} Try again in {retry_after}s.", 429, {"retryAfterSec": retry_after})


# ---------------------------------------------------------------------------
# Signup / account configuration (parity with lib/auth-config.ts)
# ---------------------------------------------------------------------------

def get_signup_email() -> str:
    return _env("AUTH_SIGNUP_EMAIL").lower()


def get_signup_mpin() -> str:
    return _env("AUTH_SIGNUP_MPIN")


def get_signup_full_email() -> str:
    """Original-cased signup email (used to mask the OTP recipient)."""
    return _env("AUTH_SIGNUP_EMAIL")


def get_owner_email() -> str:
    """Fixed owner email from server-side configuration (OWNER_EMAIL env var)."""
    return _env("OWNER_EMAIL")


def get_owner_mpin() -> str:
    """Fixed owner MPIN from server-side configuration (OWNER_MPIN env var)."""
    return _env("OWNER_MPIN")


def get_max_active_sessions() -> int:
    configured = _env_int("AUTH_MAX_ACTIVE_SESSIONS", 2)
    return min(max(configured, MAX_ACTIVE_SESSIONS_CLAMP[0]), MAX_ACTIVE_SESSIONS_CLAMP[1])


def mailer_configured() -> bool:
    return bool(_env("AUTH_SMTP_HOST") or _env("AUTH_OTP_WEBHOOK_URL"))


def allow_dev_otp() -> bool:
    """Dev console fallback: off under NODE_ENV=production (frontend parity)."""
    return not _is_production() and _env_bool("AUTH_OTP_DEV_FALLBACK", True)


def get_smtp_config() -> dict[str, Any] | None:
    host = _env("AUTH_SMTP_HOST")
    user = _env("AUTH_SMTP_USER")
    password = _env("AUTH_SMTP_PASS")  # never logged, never returned
    if not (host and user and password):
        return None
    port = _env_int("AUTH_SMTP_PORT", 587)
    return {
        "host": host,
        "port": port,
        "secure": _env_bool("AUTH_SMTP_SECURE", port == 465),
        "user": user,
        "password": password,
        "from": _env("AUTH_EMAIL_FROM") or user,
        "to": _env("AUTH_EMAIL_TO") or get_signup_email(),
    }


def mask_email(email: str) -> str:
    if "@" not in email:
        return "your email"
    name, domain = email.split("@", 1)
    if not name or not domain:
        return "your email"
    visible = name[: min(2, len(name))]
    return f"{visible}{'*' * max(1, len(name) - len(visible))}@{domain}"


def _redact(text: Any) -> str:
    """Strip any mongodb://user:pass@ fragment from free text before it leaves."""
    import re

    try:
        return re.sub(
            r"(mongodb(?:\+srv)?://)[^:@/\s]+:[^@/\s]+@", r"\1***:***@", str(text)
        )
    except Exception:
        return str(text)


# ---------------------------------------------------------------------------
# Client context (parity with lib/auth-config.ts requestContext)
# ---------------------------------------------------------------------------

def _normalize_ip(candidate: str | None) -> str | None:
    if not candidate:
        return None
    ip = candidate.strip()
    if not ip:
        return None
    ip = ip.replace('"', "").strip("[]")
    # Strip an IPv4 :port suffix.
    if "." in ip and ":" in ip:
        maybe_port = ip.rsplit(":", 1)[1]
        if maybe_port.isdigit():
            ip = ip.rsplit(":", 1)[0]
    return ip if _looks_like_ip(ip) else None


def _looks_like_ip(value: str) -> bool:
    """Cheap IPv4/IPv6 shape check (mirrors node:net isIP for our header uses)."""
    if ":" in value:                                   # IPv6
        labels = [part for part in value.split(":") if part]
        if not labels or len(labels) > 8:
            return False
        try:
            for part in value.split("::") if "::" in value else (value,):
                if part and not part.replace(":", "").isascii():
                    return False
            # hex nibbles
            for label in labels:
                if label and not all(ch in "0123456789abcdefABCDEF" for ch in label):
                    return False
            return True
        except Exception:
            return False
    labels = value.split(".")
    if len(labels) != 4:
        return False
    return all(label.isdigit() and 0 <= int(label) <= 255 for label in labels)


def _first_forwarded_ip(value: str | None) -> str | None:
    if not value:
        return None
    first = value.split(",")[0].strip()
    return first or None


def _get_client_ip(request: Request) -> str | None:
    """Same forwarded-header priority as the frontend, with an honest socket fallback."""
    headers = request.headers
    candidates = [
        _first_forwarded_ip(headers.get("x-forwarded-for")),
        headers.get("x-real-ip"),
        headers.get("cf-connecting-ip"),
        _first_forwarded_ip(headers.get("x-vercel-forwarded-for")),
        headers.get("x-client-ip"),
        headers.get("true-client-ip"),
    ]
    for candidate in candidates:
        ip = _normalize_ip(candidate)
        if ip:
            return ip
    # Local development has no proxy headers: the connected socket is the answer.
    try:
        host = request.client.host if request.client else ""
    except Exception:                                     # pragma: no cover
        host = ""
    if host in ("127.0.0.1", "::1", "localhost") or host.startswith("127."):
        return host
    return None


def describe_user_agent(value: str) -> str:
    value = value or ""
    if "Edg/" in value:
        browser = "Edge"
    elif "OPR/" in value:
        browser = "Opera"
    elif "Chrome/" in value:
        browser = "Chrome"
    elif "Firefox/" in value:
        browser = "Firefox"
    elif "Safari/" in value:
        browser = "Safari"
    else:
        browser = "Browser"
    if any(needle in value for needle in ("iPhone", "iPad", "iPod")):
        os_name = "iOS"
    elif "Android" in value:
        os_name = "Android"
    elif "Windows" in value:
        os_name = "Windows"
    elif "Mac OS X" in value:
        os_name = "macOS"
    elif "Linux" in value:
        os_name = "Linux"
    else:
        os_name = "Device"
    pwa = "PWA" if ("standalone" in value or "KAUSTUBH-PWA" in value) else ""
    return " · ".join(part for part in (browser, os_name, pwa) if part)


def get_request_ua(request: Request) -> str:
    return request.headers.get("user-agent") or "unknown"


def _request_origin(request: Request) -> str:
    """The frontend origin this request is exchanged with (Vercel app for prod)."""
    explicit = [
        origin.strip()
        for origin in _env("AUTH_ORIGIN").split(",")
        if origin.strip()
    ]
    if explicit:
        return explicit[0]
    forwarded_proto = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    host = request.headers.get("host") or "localhost"
    secure = forwarded_proto == "https"
    return f"{'https' if secure else 'http'}://{host}"


# ---------------------------------------------------------------------------
# Validation (parity with lib/auth-validation.ts)
# ---------------------------------------------------------------------------

_WEAK_MPINS = frozenset({
    "000000", "111111", "222222", "333333", "444444", "555555",
    "666666", "777777", "888888", "999999", "123456", "654321",
    "121212", "112233", "123123", "159753", "147258", "102030",
})


def normalize_name(value: Any) -> str:
    return " ".join(str(value or "").strip().split())[:60]


def valid_name(name: str) -> str | None:
    if len(name) < 2:
        return "Name must be at least 2 characters."
    if len(name) > 40:
        return "Name must be at most 40 characters."
    try:
        if not all(ch.isalpha() or ch.isdigit() or ch in " ._'’-" for ch in name):
            return "Name may only contain letters, numbers, spaces, dots, dashes, underscores and apostrophes."
    except Exception:
        return "Name may only contain letters, numbers, spaces, dots, dashes, underscores and apostrophes."
    return None


def normalize_email(value: Any) -> str:
    return str(value or "").strip().lower()


def valid_email(email: str) -> str | None:
    if len(email) < 5 or len(email) > 254:
        return "Enter a valid email address."
    import re

    if not re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$", email):
        return "Enter a valid email address."
    return None


def validate_password(password: Any) -> str | None:
    value = str(password or "")
    if len(value) < 10:
        return "Password must be at least 10 characters."
    if len(value) > 128:
        return "Password must be at most 128 characters."
    import re

    if not re.search(r"[a-z]", value):
        return "Password must include a lowercase letter."
    if not re.search(r"[A-Z]", value):
        return "Password must include an uppercase letter."
    if not re.search(r"\d", value):
        return "Password must include a number."
    if re.search(r"\s", value):
        return "Password must not contain spaces."
    if re.match(r"^(.)\1+$", value):
        return "Password is too weak."
    return None


def validate_mpin(mpin: Any) -> str | None:
    value = str(mpin or "")
    import re

    if not re.match(r"^\d{6}$", value):
        return "MPIN must be exactly 6 digits."
    if value in _WEAK_MPINS:
        return "That MPIN is too easy to guess. Choose another 6-digit MPIN."
    if re.match(r"^(\d)\1{5}$", value):
        return "That MPIN is too easy to guess. Choose another 6-digit MPIN."
    digits = [int(ch) for ch in value]
    if all(d == digits[i - 1] + 1 for i, d in enumerate(digits) if i > 0):
        return "Sequential MPINs are not allowed. Choose another 6-digit MPIN."
    if all(d == digits[i - 1] - 1 for i, d in enumerate(digits) if i > 0):
        return "Sequential MPINs are not allowed. Choose another 6-digit MPIN."
    return None


def safe_device_id(value: Any) -> str:
    import re

    raw = str(value or "").strip()
    if re.match(r"^[A-Za-z0-9_-]{8,80}$", raw):
        return raw
    return ""


def new_device_id() -> str:
    return f"dev_{_b64url_encode(os.urandom(12))}"


def safe_device_label(value: Any, fallback: str) -> str:
    raw = " ".join(str(value or "").strip().split())[:60]
    return raw or fallback


# ---------------------------------------------------------------------------
# Response helpers (parity with lib/auth-validation.ts json()/fail())
# ---------------------------------------------------------------------------

def _json_headers() -> dict[str, str]:
    return {
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Pragma": "no-cache",
        "X-Content-Type-Options": "nosniff",
    }


async def read_json(request: Request) -> dict[str, Any] | None:
    try:
        value = await request.json()
    except Exception:
        return None
    if not isinstance(value, dict) or isinstance(value, list):
        return None
    return value


def _detail(message: Any, hint: str = "") -> dict[str, str]:
    detail: dict[str, str] = {"message": str(message)}
    if hint:
        detail["hint"] = hint
    return detail


def fail(message: str, status: int = 400, extra: dict[str, Any] | None = None) -> None:
    """Raise the ONE structured failure the proxy layer understands."""
    payload: dict[str, Any] = {"ok": False, "message": message, "error": message}
    if extra:
        payload.update(extra)
    raise HTTPException(status_code=status, detail=payload)


class AuthJSONResponse(JSONResponse):
    def __init__(self, content: Any, status_code: int = 200, **kwargs: Any) -> None:
        super().__init__(content=content, status_code=status_code, headers=_json_headers(), **kwargs)


def json_ok(
    payload: dict[str, Any],
    status: int = 200,
    carry: Response | None = None,
) -> AuthJSONResponse:
    """Build the JSON response, optionally carrying cookies that the endpoint
    already set on the injected ``Response`` parameter.

    FastAPI discards the injected response object when the handler returns its
    own Response, so the Set-Cookie headers must be copied over explicitly —
    otherwise a successful signup/login would create the session row but the
    browser would never receive the cookie.
    """
    out = AuthJSONResponse(payload, status)
    if carry is not None:
        for name, value in carry.raw_headers:
            if name.lower() == b"set-cookie":
                out.raw_headers.append((name, value))
    return out


def _db_down_error(exc: BaseException) -> HTTPException:
    """The exact 503 the UI treats as 'database unavailable, retry'. Never leaks a URI."""
    message = _redact(str(exc)) or "The auth database is unavailable."
    return HTTPException(
        status_code=503,
        detail={
            "ok": False,
            "message": f"The auth database is unavailable: {message}",
            "error": f"The auth database is unavailable: {message}",
            "database": False,
        },
    )


# ---------------------------------------------------------------------------
# Cookie helpers (parity with lib/auth-sessions.ts)
# ---------------------------------------------------------------------------

def _cookie_attrs(request: Request) -> dict[str, Any]:
    forwarded_proto = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    secure = forwarded_proto == "https" or request.url.scheme == "https"
    return {
        "httponly": True,
        "secure": secure,
        "samesite": "lax",
        "path": "/",
        "max_age": SESSION_TTL_MS // 1000,
    }


def _set_session_cookie(response: Response, token: str, request: Request) -> None:
    response.set_cookie(SESSION_COOKIE, token, **_cookie_attrs(request))


def mpin_pending_cookie(request: Request) -> dict[str, Any]:
    return _cookie_attrs(request)


def _set_mpin_pending_cookie(response: Response, request: Request) -> None:
    response.set_cookie(MPIN_PENDING_COOKIE, "1", **_cookie_attrs(request))


def _delete_cookie(response: Response, name: str) -> None:
    response.delete_cookie(name, path="/")


def clear_auth_cookies(response: Response) -> None:
    _delete_cookie(response, SESSION_COOKIE)
    _delete_cookie(response, MPIN_PENDING_COOKIE)


# ---------------------------------------------------------------------------
# MongoDB access (existing connection; existing collections/schema)
# ---------------------------------------------------------------------------

def _db():
    return get_db()


def _users():
    return _db()["app_auth_users"]


def _sessions():
    return _db()["app_auth_sessions"]


def _events():
    return _db()["app_auth_events"]


def _pending():
    return _db()["app_auth_pending_logins"]


def _webauthn():
    return _db()["app_auth_webauthn"]


def _challenges():
    return _db()["app_auth_webauthn_challenges"]


_indexes_ensured = False
_indexes_lock = asyncio.Lock()


async def _ensure_auth_indexes() -> None:
    """One-time index guarantee per process — mirrors the frontend ensureIndexes.

    Index failures never take the API down (see database.connection._ensure_indexes);
    they are re-attempted on the next start.
    """
    global _indexes_ensured
    if _indexes_ensured:
        return
    async with _indexes_lock:
        if _indexes_ensured:
            return
        try:
            now = datetime.now(timezone.utc)
            users = _users()
            sessions = _sessions()
            events = _events()
            pending = _pending()
            webauthn = _webauthn()
            challenges = _challenges()
            await asyncio.gather(
                users.create_index("singleton", unique=True),
                users.create_index("nameLower", unique=True),
                users.create_index("emailLower", unique=True),
                sessions.create_index("sessionId", unique=True),
                sessions.create_index([("userId", 1), ("revokedAt", 1), ("expiresAt", 1)]),
                sessions.create_index("expiresAt", expireAfterSeconds=0),
                events.create_index([("at", -1)]),
                events.create_index([("ip", 1), ("type", 1), ("at", -1)]),
                pending.create_index("pendingId", unique=True),
                pending.create_index("expiresAt", expireAfterSeconds=0),
                webauthn.create_index("credentialId", unique=True),
                webauthn.create_index("userId"),
                challenges.create_index("challenge", unique=True),
                challenges.create_index("expiresAt", expireAfterSeconds=0),
            )
            _indexes_ensured = True
        except Exception as exc:
            log.warning("Auth indexes not ensured (continuing): %s", _redact(exc))


def _iso(value: Any) -> Any:
    """Serialize dates the way the frontend stored them (ISO-8601 strings)."""
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, _date):
        return value.isoformat()
    return value


def _epoch_ms(value: Any) -> float | None:
    """Read a lockout/expiry field that may be an epoch-ms number OR a datetime."""
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.timestamp() * 1000
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _as_dt(value: Any) -> datetime | None:
    ms = _epoch_ms(value)
    if ms is None:
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)


# ---------------------------------------------------------------------------
# Owner / session / event operations (parity with lib/auth-db.ts)
# ---------------------------------------------------------------------------

async def has_owner() -> bool:
    await _ensure_auth_indexes()
    return await _users().count_documents({"singleton": "owner"}, limit=1) > 0


async def get_owner() -> dict[str, Any] | None:
    await _ensure_auth_indexes()
    return await _users().find_one({"singleton": "owner"})


async def create_owner(user: dict[str, Any]) -> dict[str, Any]:
    await _ensure_auth_indexes()
    result = await _users().insert_one(user)
    user["_id"] = result.inserted_id
    return user


async def update_owner(update: dict[str, Any]) -> None:
    await _ensure_auth_indexes()
    data = {key: value for key, value in update.items()}
    data["updatedAt"] = _now_iso()
    await _users().update_one({"singleton": "owner"}, {"$set": data})


async def create_session_doc(doc: dict[str, Any]) -> dict[str, Any]:
    await _ensure_auth_indexes()
    await _sessions().insert_one(dict(doc))
    return doc


async def get_session_doc(session_id: str) -> dict[str, Any] | None:
    if not session_id:
        return None
    await _ensure_auth_indexes()
    return await _sessions().find_one({"sessionId": session_id})


async def list_active_sessions(user_id: str) -> list[dict[str, Any]]:
    await _ensure_auth_indexes()
    cursor = _sessions().find({
        "userId": user_id,
        "revokedAt": None,
        "expiresAt": {"$gt": datetime.now(timezone.utc)},
    }).sort("createdAt", -1)
    return await cursor.to_list(length=100)


async def list_active_sessions_or_fail(user_id: str) -> list[dict[str, Any]]:
    try:
        return await list_active_sessions(user_id)
    except Exception as exc:
        raise _db_down_error(exc) from exc


async def touch_session(session_id: str, previous: Any) -> None:
    # Throttle writes: lastSeenAt granularity of one minute is enough for UI.
    previous_ms = _epoch_ms(previous)
    if previous_ms is not None and (time.time() * 1000 - previous_ms) < 60_000:
        return
    try:
        await _sessions().update_one({"sessionId": session_id}, {"$set": {"lastSeenAt": datetime.now(timezone.utc)}})
    except Exception:
        # A failed last-seen write must not invalidate a valid session.
        pass


async def revoke_session_doc(session_id: str, reason: str = "logout") -> bool:
    result = await _sessions().update_one(
        {"sessionId": session_id, "revokedAt": None},
        {"$set": {"revokedAt": datetime.now(timezone.utc), "revokedReason": reason}},
    )
    return result.modified_count > 0


async def revoke_all_session_docs(user_id: str, except_session_id: str | None = None) -> int:
    query: dict[str, Any] = {"userId": user_id, "revokedAt": None}
    if except_session_id:
        query["sessionId"] = {"$ne": except_session_id}
    result = await _sessions().update_many(query, {
        "$set": {"revokedAt": datetime.now(timezone.utc), "revokedReason": "logout_all"},
    })
    return result.modified_count


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def record_auth_event(event: dict[str, Any]) -> None:
    doc = dict(event)
    doc.setdefault("at", datetime.now(timezone.utc))
    for required in ("type", "ip", "userAgent", "success"):
        doc.setdefault(required, "unknown" if required != "success" else False)
    try:
        await _events().insert_one(doc)
    except Exception:
        # Audit logging must never break a login. The session itself is still safe.
        log.debug("auth event insert failed: %s", _redact(doc.get("type")))


async def list_auth_events(limit: int = 25) -> list[dict[str, Any]]:
    safe = min(max(int(limit), 1), 100)
    cursor = _events().find({}).sort("at", -1).limit(safe)
    return await cursor.to_list(length=safe)


async def list_credentials(user_id: str) -> list[dict[str, Any]]:
    cursor = _webauthn().find({"userId": user_id}).sort("createdAt", 1)
    return await cursor.to_list(length=100)


async def count_credentials(user_id: str) -> int:
    return await _webauthn().count_documents({"userId": user_id})


async def credentials_or_fail(user_id: str) -> list[dict[str, Any]]:
    try:
        return await list_credentials(user_id)
    except Exception as exc:
        raise _db_down_error(exc) from exc


# ---------------------------------------------------------------------------
# Session issue / requireSession (parity with lib/auth-sessions.ts)
# ---------------------------------------------------------------------------

async def issue_session_for_user(
    request: Request,
    user: dict[str, Any],
    device_id: str,
    device_label: str,
    kind: str,
) -> tuple[dict[str, Any], str]:
    ip = _get_client_ip(request)
    if not ip:
        raise RuntimeError("A verified client IP is required to create a session.")
    now = datetime.now(timezone.utc)
    user_agent = get_request_ua(request)

    # One live session per physical device: a repeat login in the same place
    # rotates the cookie instead of stacking sessions.
    user_id = _owner_id(user)
    try:
        active = await list_active_sessions(user_id)
    except Exception as exc:
        raise _db_down_error(exc) from exc
    for existing in active:
        if existing.get("deviceId") == device_id:
            await revoke_session_doc(existing["sessionId"], "rotated")

    session_id = str(uuid.uuid4())
    doc = {
        "sessionId": session_id,
        "userId": user_id,
        "deviceId": device_id,
        "deviceLabel": device_label,
        "ip": ip,
        "userAgent": user_agent,
        "kind": kind,
        "createdAt": now,
        "lastSeenAt": now,
        "expiresAt": now + timedelta(milliseconds=SESSION_TTL_MS),
        "revokedAt": None,
    }
    await create_session_doc(doc)
    token = _create_session_token(session_id, device_id)
    return doc, token


def _owner_id(owner: dict[str, Any]) -> str:
    return str(owner.get("_id"))


def public_user(owner: dict[str, Any], reveal_email: bool = True) -> dict[str, Any]:
    email = str(owner.get("email") or "")
    return {
        "id": _owner_id(owner) if owner.get("_id") is not None else "",
        "name": str(owner.get("name") or ""),
        "email": email if reveal_email else mask_email(email),
        "emailMasked": mask_email(email),
        "hasMpin": bool(owner.get("mpinHash")),
        "mpinUpdatedAt": _iso(owner.get("mpinUpdatedAt")) if owner.get("mpinUpdatedAt") else None,
        "createdAt": _iso(owner.get("createdAt")) if owner.get("createdAt") else "",
        "lastLoginAt": _iso(owner.get("lastLoginAt")) if owner.get("lastLoginAt") else None,
    }


def public_session(session: dict[str, Any], current_session_id: str | None = None) -> dict[str, Any]:
    created = _iso(session.get("createdAt")) if session.get("createdAt") else ""
    last_seen = _iso(session.get("lastSeenAt")) if session.get("lastSeenAt") else ""
    expires = _iso(session.get("expiresAt")) if session.get("expiresAt") else ""
    return {
        "id": str(session.get("sessionId") or ""),
        "deviceId": str(session.get("deviceId") or ""),
        "deviceLabel": str(session.get("deviceLabel") or "") or describe_user_agent(str(session.get("userAgent") or "")),
        "ip": str(session.get("ip") or ""),
        "userAgent": str(session.get("userAgent") or ""),
        "kind": str(session.get("kind") or ""),
        "current": session.get("sessionId") == current_session_id,
        "createdAt": created,
        "lastSeenAt": last_seen,
        "expiresAt": expires,
    }


async def get_active_session(request: Request) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]] | None:
    """(payload, session, owner) when the cookie names a live session for the owner."""
    payload = _verify_session_token(request.cookies.get(SESSION_COOKIE))
    if not payload or not payload.get("sid"):
        return None
    session = await get_session_doc(str(payload["sid"]))
    if not session or session.get("revokedAt"):
        return None
    expires_at = _epoch_ms(session.get("expiresAt"))
    if expires_at is None or expires_at <= time.time() * 1000:
        return None
    owner = await get_owner()
    if not owner or _owner_id(owner) != str(session.get("userId")):
        return None
    await touch_session(str(session.get("sessionId")), session.get("lastSeenAt"))
    return payload, session, owner


async def require_session(
    request: Request,
    require_mpin: bool = False,
) -> dict[str, Any]:
    """MIRROR of the frontend requireSession: raise structured failures."""
    try:
        active = await get_active_session(request)
    except Exception as exc:
        raise _db_down_error(exc) from exc
    if not active:
        fail("Your session has expired. Please log in again.", 401, {
            "authenticated": False,
            "code": "UNAUTHENTICATED",
        })
    _, session, owner = active

    if require_mpin:
        has_mpin = bool(owner.get("mpinHash"))
        if not has_mpin:
            # MPIN and biometric are alternatives. An account that removed its
            # MPIN but registered a real WebAuthn credential is still usable.
            try:
                biometric = await count_credentials(_owner_id(owner))
            except Exception:
                biometric = 0
            if biometric == 0:
                fail("Set your MPIN before continuing.", 403, {
                    "code": "MPIN_SETUP_REQUIRED",
                    "needsMpinSetup": True,
                })
    return {"payload": active[0], "session": session, "owner": owner}


# ---------------------------------------------------------------------------
# MPIN policy (parity with lib/auth-mpin.ts)
# ---------------------------------------------------------------------------

def mpin_lock_remaining_ms(owner: dict[str, Any]) -> float:
    until = _epoch_ms(owner.get("mpinLockedUntil")) or 0
    return max(0.0, until - time.time() * 1000)


async def verify_owner_mpin(owner: dict[str, Any], mpin: Any) -> dict[str, Any]:
    """{ok, message?, status?, lockedUntil?} — same semantics as the frontend."""
    if not owner.get("mpinHash"):
        return {"ok": False, "message": "No MPIN is configured for this account.", "status": 409}

    remaining = mpin_lock_remaining_ms(owner)
    if remaining > 0:
        return {
            "ok": False,
            "message": f"Too many incorrect MPIN attempts. Try again in {int(remaining / 60_000)} minute(s).",
            "status": 429,
            "lockedUntil": _iso(owner.get("mpinLockedUntil")),
        }

    value = str(mpin or "")
    import re
    if not re.match(r"^\d{6}$", value):
        return {"ok": False, "message": "MPIN must be exactly 6 digits.", "status": 400}

    if not _verify_secret(value, str(owner.get("mpinHash"))):
        attempts = int(owner.get("mpinFailedAttempts") or 0) + 1
        lock = attempts >= MAX_FAILED_MPIN_ATTEMPTS
        update: dict[str, Any] = {
            "mpinFailedAttempts": 0 if lock else attempts,
            "mpinLockedUntil": None if not lock else time.time() * 1000 + MPIN_LOCK_MS,
        }
        try:
            await update_owner(update)
        except Exception:
            pass  # the verdict stands; the counter is advisory
        return {
            "ok": False,
            "message": (
                "Too many incorrect MPIN attempts. Locked for 5 minutes."
                if lock
                else f"Incorrect MPIN. {MAX_FAILED_MPIN_ATTEMPTS - attempts} attempt(s) left."
            ),
            "status": 429 if lock else 401,
        }

    if int(owner.get("mpinFailedAttempts") or 0) > 0 or owner.get("mpinLockedUntil"):
        try:
            await update_owner({"mpinFailedAttempts": 0, "mpinLockedUntil": None})
        except Exception:
            pass
    return {"ok": True}


async def set_owner_mpin(mpin: Any) -> dict[str, Any]:
    error = validate_mpin(mpin)
    if error:
        return {"ok": False, "message": error, "status": 400}
    await ensure_db()  # fail cleanly before hashing if the DB is down
    try:
        await update_owner({
            "mpinHash": _hash_secret(str(mpin)),
            "mpinUpdatedAt": _now_iso(),
            "mpinFailedAttempts": 0,
            "mpinLockedUntil": None,
        })
    except Exception as exc:
        raise _db_down_error(exc) from exc
    return {"ok": True}


async def clear_owner_mpin() -> None:
    try:
        await update_owner({
            "mpinHash": None,
            "mpinUpdatedAt": None,
            "mpinFailedAttempts": 0,
            "mpinLockedUntil": None,
        })
    except Exception as exc:
        raise _db_down_error(exc) from exc


async def ensure_db() -> None:
    """The get_db() sentinel: raises the structured 503 when MongoDB is down."""
    try:
        return _db()
    except Exception as exc:
        raise _db_down_error(exc) from exc


# ---------------------------------------------------------------------------
# OTP delivery (parity with lib/auth-mail.ts: webhook -> SMTP -> dev fallback)
# ---------------------------------------------------------------------------

def _ist_now() -> str:
    try:
        return now_ist().strftime("%b %d, %Y, %I:%M:%S %p")
    except Exception:                                     # pragma: no cover
        return datetime.now(timezone.utc).strftime("%b %d, %Y, %I:%M:%S %p")


def _otp_text(input: dict[str, str]) -> str:
    return "\n".join([
        "🔐 KAUSTUBH — New device login verification",
        "",
        "A login to your KAUSTUBH account needs approval because another device is already signed in.",
        "",
        f"OTP: {input['otp']}",
        f"Device: {input['deviceLabel']}",
        f"IP address: {input['ip']}",
        f"Time (IST): {_ist_now()}",
        "",
        "This code expires in 10 minutes. If this was not you, do not share the code and change your password immediately.",
        "",
        f"Account: {input['to']}",
    ])


def escape_html(value: str) -> str:
    return (value.replace("&", "&amp;").replace("<", "&lt;")
                 .replace(">", "&gt;").replace('"', "&quot;"))


def _otp_html(input: dict[str, str]) -> str:
    return f"""<!doctype html>
<html><body style="margin:0;padding:24px;background:#070b12;font-family:Inter,Segoe UI,Arial,sans-serif;color:#e8eefc">
  <div style="max-width:520px;margin:0 auto;border:1px solid rgba(148,163,184,.25);border-radius:20px;overflow:hidden;background:linear-gradient(160deg,#0d1728,#0a111d)">
    <div style="padding:22px 24px;background:linear-gradient(120deg,rgba(16,185,129,.18),rgba(59,130,246,.18));border-bottom:1px solid rgba(148,163,184,.18)">
      <div style="font-size:22px;font-weight:800;letter-spacing:.5px">🛡️ KAUSTUBH</div>
      <div style="font-size:12px;color:#94a3b8;letter-spacing:2px;text-transform:uppercase;margin-top:4px">New device verification</div>
    </div>
    <div style="padding:26px 24px">
      <p style="margin:0 0 14px;font-size:15px;line-height:1.6">🚨 A new device is trying to sign in while another device is already active.</p>
      <div style="margin:18px 0;padding:20px;border-radius:16px;background:#0b1220;border:1px dashed rgba(16,185,129,.45);text-align:center">
        <div style="font-size:11px;letter-spacing:3px;color:#64748b;text-transform:uppercase">Your one-time code</div>
        <div style="font-size:40px;font-weight:900;letter-spacing:12px;color:#34d399;margin-top:8px">{input['otp']}</div>
        <div style="font-size:11px;color:#64748b;margin-top:8px">Expires in 10 minutes · single use</div>
      </div>
      <table style="width:100%;font-size:13px;color:#cbd5e1;border-collapse:collapse">
        <tr><td style="padding:6px 0;color:#64748b">📱 Device</td><td style="padding:6px 0;text-align:right">{escape_html(input['deviceLabel'])}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b">🌐 IP address</td><td style="padding:6px 0;text-align:right">{escape_html(input['ip'])}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b">🕒 Time (IST)</td><td style="padding:6px 0;text-align:right">{escape_html(_ist_now())}</td></tr>
      </table>
      <p style="margin:18px 0 0;font-size:12px;line-height:1.6;color:#94a3b8">If this was not you, do not share this code. Change your password and revoke the device from Settings → Security.</p>
    </div>
  </div>
</body></html>"""


def _delivered(data: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {"delivered": True, "channel": "smtp"}
    if data.get("dev_otp"):
        result["devOtp"] = data["dev_otp"]
    return result


async def deliver_otp(otp: str, device_label: str, ip: str, to: str) -> dict[str, Any]:
    """Webhook first, then SMTP, then the dev-only console/boxed fallback."""
    webhook = _env("AUTH_OTP_WEBHOOK_URL")
    if webhook:
        text = _otp_text({"otp": otp, "deviceLabel": device_label, "ip": ip, "to": to})
        html = _otp_html({"otp": otp, "deviceLabel": device_label, "ip": ip, "to": to})
        body = {
            "to": to,
            "subject": "🛡️ KAUSTUBH — your new-device login code",
            "text": text,
            "html": html,
            "otp": otp,
            "deviceLabel": device_label,
            "ip": ip,
            "app": "KAUSTUBH",
        }
        try:
            import httpx

            async with httpx.AsyncClient(timeout=12.0) as client:
                response = await client.post(webhook, json=body)
            if response.status_code < 400:
                return _delivered({"channel": "webhook"})
            return {
                "delivered": False,
                "channel": "webhook",
                "reason": f"Webhook responded {response.status_code}",
            }
        except Exception as exc:
            return {
                "delivered": False,
                "channel": "webhook",
                "reason": _redact(exc),
            }

    smtp = get_smtp_config()
    if smtp is not None:
        try:
            await asyncio.to_thread(_send_smtp, smtp, to, otp, device_label, ip)
            return _delivered({"channel": "smtp"})
        except Exception as exc:
            log.warning("OTP SMTP delivery failed: %s", _redact(exc))
            return {
                "delivered": False,
                "channel": "smtp",
                "reason": _redact(exc),
            }

    if allow_dev_otp():
        log.warning("[auth-otp] SMTP not configured. DEV OTP for %s: %s", to, otp)  # noqa: T201 - dev only
        return {
            "delivered": True,
            "channel": "dev",
            "devOtp": otp,
        }

    return {
        "delivered": False,
        "channel": "none",
        "reason": (
            "No OTP delivery channel configured. Set AUTH_SMTP_* or AUTH_OTP_WEBHOOK_URL."
            if _is_production()
            else "No OTP delivery channel configured."
        ),
    }


def _send_smtp(smtp: dict[str, Any], to: str, otp: str, device_label: str, ip: str) -> None:
    message = EmailMessage()
    message["Subject"] = "🛡️ KAUSTUBH — your new-device login code"
    message["From"] = smtp["from"]
    message["To"] = to or smtp["to"]
    message.set_content(_otp_text({"otp": otp, "deviceLabel": device_label, "ip": ip, "to": to}))
    message.add_alternative(
        _otp_html({"otp": otp, "deviceLabel": device_label, "ip": ip, "to": to}),
        subtype="html",
    )
    context = ssl_module.create_default_context()
    if smtp["secure"]:
        # Implicit TLS (port 465): the whole connection starts encrypted.
        server: smtplib.SMTP = smtplib.SMTP_SSL(smtp["host"], smtp["port"], timeout=12, context=context)
    else:
        # Plaintext then STARTTLS when the server advertises it (nodemailer
        # parity: secure=false means opportunistic upgrade).
        server = smtplib.SMTP(smtp["host"], smtp["port"], timeout=12)
    try:
        if not smtp["secure"]:
            server.starttls(context=context)
        server.login(smtp["user"], smtp["password"])
        server.send_message(message)
    finally:
        try:
            server.quit()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Auth event helpers used by the routes
# ---------------------------------------------------------------------------

def _event_base(request: Request) -> dict[str, Any]:
    ip = _get_client_ip(request)
    return {
        "ip": ip or "unknown",
        "userAgent": get_request_ua(request),
    }


# ===========================================================================
# Endpoints
# ===========================================================================

@router.post("/signup")
async def app_signup(request: Request, response: Response) -> JSONResponse:
    """POST /api/auth/signup — the ONE-TIME owner bootstrap.

    Only exists while ``app_auth_users`` is empty. The owner email is fixed
    from OWNER_EMAIL (server-side config); the client submits name + password
    + confirmPassword only. The MPIN is validated server-side against OWNER_MPIN
    at login time and is never stored in MongoDB.
    """
    ip = _get_client_ip(request)
    if not ip:
        fail("Cannot verify your IP address, so signup is blocked. Connect through the app proxy and retry.", 400, {
            "code": "IP_REQUIRED",
        })

    body = await read_json(request)
    if not body:
        fail("Invalid request body.", 400)

    _rate_limit_or_429("signup", ip, 5, 60 * 60 * 1000, "Too many signup attempts.")

    owner_email = get_owner_email()
    owner_mpin = get_owner_mpin()
    if not owner_email or not owner_mpin:
        fail("Owner configuration is missing on the server. Set OWNER_EMAIL and OWNER_MPIN in the backend env.", 503, {
            "code": "OWNER_NOT_CONFIGURED",
        })

    name = normalize_name(body.get("name"))
    password = str(body.get("password") or "")
    confirm_password = str(body.get("confirmPassword") or "")

    # Atomic guard: owner must not already exist (unique singleton index enforces this at DB level too).
    try:
        if await has_owner():
            fail("The owner account already exists. Please log in.", 409, {"code": "OWNER_EXISTS"})
    except HTTPException:
        raise
    except Exception as exc:
        raise _db_down_error(exc) from exc

    # Validate inputs.
    name_error = valid_name(name)
    if name_error:
        fail(name_error, 400)

    email_error = valid_email(owner_email)
    if email_error:
        fail("Owner email is not configured correctly.", 503, {"code": "OWNER_EMAIL_INVALID"})

    password_error = validate_password(password)
    if password_error:
        fail(password_error, 400)

    if password != confirm_password:
        fail("Password and confirm password do not match.", 400)

    event_base = _event_base(request)

    try:
        password_hash = _hash_secret(password)
        owner = await create_owner({
            "singleton": "owner",
            "name": name,
            "nameLower": name.lower(),
            "email": owner_email,
            "emailLower": owner_email.lower(),
            "passwordHash": password_hash,
            # MPIN is NOT stored in MongoDB — it is validated against OWNER_MPIN env at login.
            "mpinHash": None,
            "mpinUpdatedAt": None,
            "mpinFailedAttempts": 0,
            "mpinLockedUntil": None,
            "passwordFailedAttempts": 0,
            "passwordLockedUntil": None,
            "status": "active",
            "createdAt": _now_iso(),
            "updatedAt": _now_iso(),
            "lastLoginAt": None,
        })

        await record_auth_event({
            "type": "signup",
            "userId": _owner_id(owner),
            "ip": event_base["ip"],
            "userAgent": event_base["userAgent"],
            "success": True,
            "detail": "One-time owner account created",
        })

        device_id = new_device_id()
        device_label = "This device"
        session_doc, token = await issue_session_for_user(request, owner, device_id, device_label, "primary")
        _set_session_cookie(response, token, request)

        return json_ok({
            "ok": True,
            "authenticated": True,
            "hasOwner": True,
            "needsSignup": False,
            "needsMpinSetup": False,
            "needsUnlock": False,
            "user": public_user(owner),
            "deviceId": device_id,
            "sessionId": str(session_doc["sessionId"]),
            "deviceCount": 1,
            "maxDevices": 1,
            "message": "Owner account created successfully.",
        }, 201, carry=response)
    except HTTPException:
        raise
    except Exception as exc:
        if getattr(exc, "code", None) == 11000:
            fail("The owner account already exists. Please log in.", 409, {"code": "OWNER_EXISTS"})
        raise _db_down_error(exc) from exc


@router.post("/login")
async def app_login(request: Request, response: Response) -> JSONResponse:
    """POST /api/auth/login — single-owner login with Email + Password + MPIN.

    All three factors are validated server-side:
      1. Email must match OWNER_EMAIL (server-side config).
      2. Password must match the stored scrypt hash in MongoDB.
      3. MPIN must match OWNER_MPIN (server-side config).

    On ANY failure, a generic authentication error is returned — the client
    cannot tell which factor was incorrect.

    No OTP, no second-device verification, no WebAuthn, no device limits.
    """
    ip = _get_client_ip(request)
    if not ip:
        fail("Cannot verify your IP address, so login is blocked. Connect through the app proxy and retry.", 400, {
            "code": "IP_REQUIRED",
        })

    _rate_limit_or_429("login", ip, 12, 10 * 60 * 1000, "Too many login attempts.")

    body = await read_json(request)
    if not body:
        fail("Invalid request body.", 400)

    email = normalize_email(body.get("email")) or ""
    password = str(body.get("password") or "")
    mpin = str(body.get("mpin") or "")

    if not email or not password or not mpin:
        fail("Email, password and MPIN are all required.", 400)

    owner_email = get_owner_email()
    owner_mpin = get_owner_mpin()
    if not owner_email or not owner_mpin:
        fail("Owner configuration is missing on the server.", 503, {
            "code": "OWNER_NOT_CONFIGURED",
        })

    try:
        owner = await get_owner()
    except Exception as exc:
        raise _db_down_error(exc) from exc

    if not owner:
        fail("Authentication failed.", 401, {"code": "AUTH_FAILED"})

    event_base = _event_base(request)

    # Validate all three factors. Any mismatch produces the SAME generic error.
    email_matches = _constant_time_compare(email, owner_email)
    password_matches = _verify_secret(password, owner.get("passwordHash"))
    mpin_matches = _constant_time_compare(mpin, owner_mpin)

    if not (email_matches and password_matches and mpin_matches):
        # Record failed attempt for audit but never reveal which factor failed.
        try:
            attempts = int(owner.get("passwordFailedAttempts") or 0) + 1
            lock = attempts >= MAX_PASSWORD_FAILURES
            await update_owner({
                "passwordFailedAttempts": 0 if lock else attempts,
                "passwordLockedUntil": None if not lock else time.time() * 1000 + PASSWORD_LOCK_MS,
            })
            await record_auth_event({
                "type": "login_failed",
                "userId": _owner_id(owner),
                "ip": event_base["ip"],
                "userAgent": event_base["userAgent"],
                "success": False,
                "detail": "Authentication failed (generic)",
            })
        except Exception:
            pass
        fail("Authentication failed. Please check your credentials and try again.", 401, {
            "code": "AUTH_FAILED",
        })

    # All factors valid — reset failure counter and issue session.
    try:
        await update_owner({
            "passwordFailedAttempts": 0,
            "passwordLockedUntil": None,
            "lastLoginAt": _now_iso(),
        })
    except Exception:
        pass  # non-fatal

    device_id = new_device_id()
    device_label = "This device"

    try:
        session_doc, token = await issue_session_for_user(
            request,
            owner,
            device_id,
            device_label,
            "primary",
        )
        _set_session_cookie(response, token, request)

        await record_auth_event({
            "type": "login",
            "userId": _owner_id(owner),
            "ip": event_base["ip"],
            "userAgent": event_base["userAgent"],
            "deviceId": device_id,
            "deviceLabel": device_label,
            "sessionId": str(session_doc["sessionId"]),
            "success": True,
            "detail": f"Login from {ip}",
        })

        return json_ok({
            "ok": True,
            "authenticated": True,
            "hasOwner": True,
            "needsSignup": False,
            "needsMpinSetup": False,
            "needsUnlock": False,
            "user": public_user(owner),
            "deviceId": device_id,
            "sessionId": str(session_doc["sessionId"]),
            "deviceCount": 1,
            "maxDevices": 1,
            "message": "Login successful.",
        }, carry=response)
    except HTTPException:
        raise
    except Exception as exc:
        fail("Authentication failed." if not str(exc) else _redact(str(exc)), 500)


@router.post("/password/reset")
async def app_password_reset(request: Request, response: Response) -> JSONResponse:
    """POST /api/auth/password/reset — verify MPIN, then set a new password.

    Allows the owner to recover a forgotten password by proving knowledge of
    the MPIN (validated against OWNER_MPIN server-side config). On success the
    stored scrypt password hash is rotated in MongoDB.
    """
    ip = _get_client_ip(request)
    if not ip:
        fail("Cannot verify your IP address, so password reset is blocked.", 400, {
            "code": "IP_REQUIRED",
        })

    _rate_limit_or_429("password_reset", ip, 5, 60 * 60 * 1000, "Too many password reset attempts.")

    body = await read_json(request)
    if not body:
        fail("Invalid request body.", 400)

    owner_email = get_owner_email()
    owner_mpin = get_owner_mpin()
    if not owner_email or not owner_mpin:
        fail("Owner configuration is missing on the server.", 503, {
            "code": "OWNER_NOT_CONFIGURED",
        })

    mpin = str(body.get("mpin") or "")
    new_password = str(body.get("newPassword") or "")
    confirm_password = str(body.get("confirmPassword") or "")

    if not mpin or not new_password or not confirm_password:
        fail("MPIN, new password and confirm password are all required.", 400)

    # Verify MPIN against server config
    if not _constant_time_compare(mpin, owner_mpin):
        fail("Incorrect MPIN.", 401, {"code": "MPIN_INVALID"})

    # Validate new password
    password_error = validate_password(new_password)
    if password_error:
        fail(password_error, 400)

    if new_password != confirm_password:
        fail("New password and confirm password do not match.", 400)

    try:
        owner = await get_owner()
    except Exception as exc:
        raise _db_down_error(exc) from exc

    if not owner:
        fail("Authentication failed.", 401, {"code": "AUTH_FAILED"})

    event_base = _event_base(request)

    try:
        await update_owner({
            "passwordHash": _hash_secret(new_password),
            "passwordFailedAttempts": 0,
            "passwordLockedUntil": None,
            "updatedAt": _now_iso(),
        })

        await record_auth_event({
            "type": "login_failed",  # reuse closest type; a dedicated "password_reset" type can be added
            "userId": _owner_id(owner),
            "ip": event_base["ip"],
            "userAgent": event_base["userAgent"],
            "success": True,
            "detail": "Password reset via MPIN verification",
        })

        return json_ok({
            "ok": True,
            "authenticated": True,
            "message": "Password reset successfully.",
        }, 200, carry=response)
    except HTTPException:
        raise
    except Exception as exc:
        raise _db_down_error(exc) from exc


@router.post("/login/verify-otp")
async def app_verify_otp(request: Request, response: Response) -> JSONResponse:
    """POST /api/auth/login/verify-otp — completes the second-device login.

    The OTP is single-use, expires in 10 minutes, and is stored only as an
    HMAC. The device-limit check is repeated here because another device may
    have connected meanwhile.
    """
    ip = _get_client_ip(request)
    if not ip:
        fail("Cannot verify your IP address, so login is blocked.", 400, {"code": "IP_REQUIRED"})

    _rate_limit_or_429("otp", ip, 10, 10 * 60 * 1000, "Too many code attempts.")

    body = await read_json(request)
    if not body:
        fail("Invalid request body.", 400)

    import re
    pending_id = str(body.get("pendingId") or "").strip()
    otp = str(body.get("otp") or "").strip()
    if not pending_id or not re.match(r"^\d{6}$", otp):
        fail("Enter the 6-digit code from your email.", 400)

    try:
        pending = await _pending().find_one({"pendingId": pending_id})
    except Exception as exc:
        raise _db_down_error(exc) from exc

    if not pending:
        fail("This login request no longer exists. Start again.", 404, {"code": "OTP_NOT_FOUND"})
    if str(pending.get("status")) != "pending":
        fail("This code was already used. Start the login again.", 409, {"code": "OTP_ALREADY_USED"})
    expires = _epoch_ms(pending.get("expiresAt"))
    if expires is None or expires <= time.time() * 1000:
        try:
            await _pending().update_one({"pendingId": pending_id}, {"$set": {"status": "expired"}})
        except Exception:
            pass
        fail("That code expired. Start the login again to get a fresh one.", 410, {"code": "OTP_EXPIRED"})
    if int(pending.get("attempts") or 0) >= MAX_OTP_ATTEMPTS:
        try:
            await _pending().update_one({"pendingId": pending_id}, {"$set": {"status": "denied"}})
        except Exception:
            pass
        fail("Too many incorrect codes for this request. Start the login again.", 429)
    if str(pending.get("ip")) != ip:
        await record_auth_event({
            "type": "login_otp_failed",
            "userId": str(pending.get("userId") or ""),
            "ip": ip,
            "userAgent": get_request_ua(request),
            "deviceId": pending.get("deviceId"),
            "deviceLabel": pending.get("deviceLabel"),
            "success": False,
            "detail": f"OTP presented from a different IP (expected {pending.get('ip')})",
        })
        fail("This code was issued to a different network. Start the login again.", 403, {"code": "OTP_IP_MISMATCH"})

    salt = str(pending.get("otpSalt") or "")
    expected_hash = str(pending.get("otpHash") or "")
    computed = _b64url_encode(
        hmac.new(_require_session_secret().encode("utf-8"), f"{salt}:{otp}".encode("utf-8"), hashlib.sha256).digest()
    )
    if not _constant_time_compare(computed, expected_hash):
        try:
            await _pending().update_one({"pendingId": pending_id}, {"$inc": {"attempts": 1}})
        except Exception:
            pass
        await record_auth_event({
            "type": "login_otp_failed",
            "userId": str(pending.get("userId") or ""),
            "ip": ip,
            "userAgent": get_request_ua(request),
            "deviceId": pending.get("deviceId"),
            "deviceLabel": pending.get("deviceLabel"),
            "success": False,
            "detail": "Incorrect OTP",
        })
        left = MAX_OTP_ATTEMPTS - int(pending.get("attempts") or 0) - 1
        fail(f"Incorrect code. {max(0, left)} attempt(s) left.", 401)

    device_label = safe_device_label(body.get("deviceLabel"), str(pending.get("deviceLabel") or ""))
    event_base = _event_base(request)

    try:
        owner = await get_owner()
        if not owner:
            fail("No owner account exists.", 409, {"code": "NO_OWNER"})
        sessions = await list_active_sessions_or_fail(_owner_id(owner))
    except HTTPException:
        raise
    except Exception as exc:
        raise _db_down_error(exc) from exc

    max_devices = get_max_active_sessions()
    device_ids = {str(s.get("deviceId")) for s in sessions}
    if str(pending.get("deviceId")) not in device_ids and len(device_ids) >= max_devices:
        try:
            await _pending().update_one({"pendingId": pending_id}, {"$set": {"status": "denied"}})
        except Exception:
            pass
        fail(
            f"All {max_devices} device slots are in use. Sign out elsewhere and try again.",
            403,
            {"code": "DEVICE_LIMIT_REACHED", "deviceCount": len(device_ids), "maxDevices": max_devices},
        )

    try:
        await _pending().update_one({"pendingId": pending_id}, {"$set": {"status": "approved"}})
        session_doc, token = await issue_session_for_user(
            request,
            owner,
            str(pending.get("deviceId")),
            device_label,
            "primary" if len(device_ids) == 0 else "secondary",
        )

        needs_mpin_setup = not owner.get("mpinHash")
        credentials = await credentials_or_fail(_owner_id(owner))
        needs_mpin_setup = needs_mpin_setup and len(credentials) == 0
        if needs_mpin_setup:
            _set_mpin_pending_cookie(response, request)
        else:
            _delete_cookie(response, MPIN_PENDING_COOKIE)
        _set_session_cookie(response, token, request)

        await record_auth_event({
            "type": "login_otp_verified",
            "userId": _owner_id(owner),
            "ip": event_base["ip"],
            "userAgent": event_base["userAgent"],
            "deviceId": pending.get("deviceId"),
            "deviceLabel": device_label,
            "sessionId": str(session_doc["sessionId"]),
            "success": True,
            "detail": f"Second-device OTP verified from {ip}",
        })
        await record_auth_event({
            "type": "login",
            "userId": _owner_id(owner),
            "ip": event_base["ip"],
            "userAgent": event_base["userAgent"],
            "deviceId": pending.get("deviceId"),
            "deviceLabel": device_label,
            "sessionId": str(session_doc["sessionId"]),
            "success": True,
            "detail": f"Login from {ip} (OTP)",
        })

        after = await list_active_sessions_or_fail(_owner_id(owner))
        devices = {str(s.get("deviceId")) for s in after}

        return json_ok({
            "ok": True,
            "authenticated": True,
            "needsMpinSetup": needs_mpin_setup,
            "needsUnlock": bool(owner.get("mpinHash")) or len(credentials) > 0,
            "user": public_user(owner),
            "deviceId": str(pending.get("deviceId")),
            "sessionId": str(session_doc["sessionId"]),
            "deviceCount": len(devices),
            "maxDevices": max_devices,
            "sessions": [public_session(s, str(session_doc["sessionId"])) for s in after],
            "message": "Second device verified.",
        }, carry=response)
    except HTTPException:
        raise
    except Exception as exc:
        fail("Could not finish the login." if not str(exc) else _redact(str(exc)), 500)


# ---------------------------------------------------------------------------
# Bootstrap probe + session endpoints
# ---------------------------------------------------------------------------

def _status_base() -> dict[str, Any]:
    owner_email = get_owner_email()
    owner_mpin = get_owner_mpin()
    configured = bool(owner_email and owner_mpin)
    return {
        "ok": True,
        "ownerConfigured": configured,
        "ownerEmailMasked": mask_email(owner_email) if configured else "",
        "mailerConfigured": mailer_configured(),
        "devOtp": False,
        "maxDevices": 1,
    }


def _status_not_authenticated() -> dict[str, Any]:
    return {
        "needsSignup": False,
        "authenticated": False,
        "needsMpinSetup": False,
        "needsUnlock": False,
        "deviceCount": 0,
        "sessions": [],
        "biometricCount": 0,
    }


@router.get("/status")
async def app_status(request: Request) -> JSONResponse:
    """GET /api/auth/status — public bootstrap probe. Reveals only non-secret facts."""
    try:
        owner = await get_owner()
        if not owner:
            return json_ok({
                **_status_base(),
                "hasOwner": False,
                "needsSignup": True,
                "signupOpen": True,
                "authenticated": False,
                "needsMpinSetup": False,
                "needsUnlock": False,
                "deviceCount": 0,
                "sessions": [],
                "biometricCount": 0,
            })

        active = await get_active_session(request)
        if not active:
            return json_ok({
                **_status_base(),
                "hasOwner": True,
                "needsSignup": False,
                "signupOpen": False,
                **_status_not_authenticated(),
            })

        _, session, config_owner = active
        sessions = await list_active_sessions_or_fail(_owner_id(config_owner))
        devices = {str(s.get("deviceId")) for s in sessions}

        return json_ok({
            **_status_base(),
            "hasOwner": True,
            "needsSignup": False,
            "signupOpen": False,
            "authenticated": True,
            "needsMpinSetup": False,
            "needsUnlock": False,
            "user": public_user(config_owner),
            "deviceId": str(session.get("deviceId") or ""),
            "sessionId": str(session.get("sessionId") or ""),
            "deviceCount": len(devices),
            "sessions": [public_session(s, str(session.get("sessionId"))) for s in sessions],
            "biometricCount": 0,
            "currentSession": public_session(session, str(session.get("sessionId"))),
        })
    except Exception as exc:
        raise _db_down_error(exc) from exc


@router.get("/session")
async def app_session(request: Request) -> JSONResponse:
    """GET /api/auth/session — single source of truth for the UI session."""
    try:
        owner = await get_owner()
        if not owner:
            return json_ok({
                "ok": True,
                "authenticated": False,
                "hasOwner": False,
                "needsSignup": True,
                "signupOpen": True,
                "needsMpinSetup": False,
                "needsUnlock": False,
            })
        active = await get_active_session(request)
        if not active:
            return json_ok({
                "ok": True,
                "authenticated": False,
                "hasOwner": True,
                "needsSignup": False,
                "signupOpen": False,
                "needsMpinSetup": False,
                "needsUnlock": False,
            })

        _, session, config_owner = active
        sessions = await list_active_sessions_or_fail(_owner_id(config_owner))
        devices = {str(s.get("deviceId")) for s in sessions}
        session_id = str(session.get("sessionId") or "")

        return json_ok({
            "ok": True,
            "authenticated": True,
            "hasOwner": True,
            "needsSignup": False,
            "signupOpen": False,
            "needsMpinSetup": False,
            "needsUnlock": False,
            "user": public_user(config_owner),
            "deviceId": str(session.get("deviceId") or ""),
            "sessionId": session_id,
            "deviceCount": len(devices),
            "maxDevices": 1,
            "sessions": [public_session(s, session_id) for s in sessions],
            "biometricCount": 0,
        })
    except Exception as exc:
        raise _db_down_error(exc) from exc


@router.get("/whoami")
async def app_whoami(request: Request) -> JSONResponse:
    """GET /api/auth/whoami[?requireMpin=true] — requireSession equivalent.

    Used by the Vercel proxy routes that perform WebAuthn verification locally
    and need the same gate the frontend `requireSession` used to provide.
    """
    require_mpin = (request.query_params.get("requireMpin") or "").strip().lower() in (
        "1", "true", "yes", "on",
    )
    auth = await require_session(request, require_mpin=require_mpin)
    _, session, owner = auth["payload"], auth["session"], auth["owner"]
    return json_ok({
        "ok": True,
        "user": public_user(owner),
        "session": public_session(session, str(session.get("sessionId"))),
        "needsUnlock": bool(owner.get("mpinHash")) or await count_credentials(_owner_id(owner)) > 0,
    })


@router.post("/operator-token")
async def app_operator_token(request: Request) -> JSONResponse:
    """POST /api/auth/operator-token — app session -> backend operator JWT.

    The trading terminal and the realtime gateway require the backend operator
    JWT. Historically the Next layer had to hold a copy of APP_PASSWORD to mint
    it. That is unnecessary and violates the single-source rule: the app session
    is already validated by VM1, so VM1 can issue the same short-lived JWT here.
    The browser only ever sees the token, never APP_PASSWORD.
    """
    await require_session(request, require_mpin=True)
    from config.settings import settings
    from services.jwt_auth import issue_token

    username = settings.app_username or "operator"
    return json_ok({
        "ok": True,
        "token": issue_token(username),
        "expiresInSeconds": settings.jwt_ttl_seconds,
        "username": username,
    })


@router.get("/live")
async def app_live(request: Request) -> JSONResponse:
    """GET /api/auth/live?sid=<sessionId> — tiny liveness probe for the proxy gate.

    Returns only {ok, live} — no owner data. Used by proxy.ts with a 10s
    in-process cache, so revocations propagate within one cache generation.
    """
    sid = request.query_params.get("sid") or ""
    if not sid:
        return json_ok({"ok": True, "live": False})
    try:
        session = await get_session_doc(sid)
        if not session or session.get("revokedAt"):
            return json_ok({"ok": True, "live": False})
        expires_at = _epoch_ms(session.get("expiresAt"))
        if expires_at is None or expires_at <= time.time() * 1000:
            return json_ok({"ok": True, "live": False})
        owner = await get_owner()
        live = bool(owner) and _owner_id(owner) == str(session.get("userId"))
        response = json_ok({
            "ok": True,
            "live": live,
            "expiresAtMs": int(expires_at) if live else None,
        })
        return response
    except Exception:
        # Fail closed on a database error; the login page still loads.
        return json_ok({"ok": False, "live": False, "database": False})


@router.post("/session/revoke")
async def app_session_revoke(request: Request, response: Response) -> JSONResponse:
    """POST /api/auth/session/revoke — revokes THIS device's app session.

    Matches POST/DELETE /api/auth/logout of the frontend layer: even when the
    database is unreachable, the cookies are still cleared so the browser is
    never stuck half-signed-in.
    """
    event_base = _event_base(request)
    try:
        active = await get_active_session(request)
        if active:
            _, session, owner = active
            try:
                await revoke_session_doc(str(session.get("sessionId")), "logout")
                await record_auth_event({
                    "type": "logout",
                    "userId": _owner_id(owner),
                    "ip": event_base["ip"],
                    "userAgent": event_base["userAgent"],
                    "deviceId": session.get("deviceId"),
                    "deviceLabel": session.get("deviceLabel"),
                    "sessionId": str(session.get("sessionId")),
                    "success": True,
                    "detail": "Logged out",
                })
            except Exception:
                log.warning("session revoke bookkeeping failed", exc_info=True)
    except Exception:
        pass

    clear_auth_cookies(response)
    return json_ok({"ok": True, "authenticated": False, "message": "Logged out."})


# ---------------------------------------------------------------------------
# Device inventory / revocation
# ---------------------------------------------------------------------------

@router.get("/devices")
async def app_devices(request: Request) -> JSONResponse:
    """GET /api/auth/devices — every active login with its real IP and timestamps."""
    auth = await require_session(request)
    sessions = await list_active_sessions_or_fail(_owner_id(auth["owner"]))
    devices = {str(s.get("deviceId")) for s in sessions}
    return json_ok({
        "ok": True,
        "deviceCount": len(devices),
        "maxDevices": get_max_active_sessions(),
        "sessions": [public_session(s, str(auth["session"].get("sessionId"))) for s in sessions],
    })


@router.post("/devices/revoke")
async def app_devices_revoke(request: Request, response: Response) -> JSONResponse:
    """POST /api/auth/devices/revoke — {sessionId | deviceId | all}.

    ``all`` keeps the current device signed in and revokes every other one; it
    is the manual escape hatch when both device slots are full.
    """
    auth = await require_session(request)
    session = auth["session"]
    owner = auth["owner"]

    body = await read_json(request)
    if not body:
        fail("Invalid request body.", 400)

    current_session_id = str(session.get("sessionId"))
    target_session_id = str(body.get("sessionId") or "").strip()
    device_id = str(body.get("deviceId") or "").strip()
    revoke_all = body.get("all") is True
    event_base = _event_base(request)

    if not revoke_all and not target_session_id and not device_id:
        fail("Specify sessionId, deviceId, or all=true.", 400)

    try:
        if revoke_all:
            revoked = await revoke_all_session_docs(_owner_id(owner), current_session_id)
            await record_auth_event({
                "type": "logout_all",
                "userId": _owner_id(owner),
                "ip": event_base["ip"],
                "userAgent": event_base["userAgent"],
                "deviceId": session.get("deviceId"),
                "deviceLabel": session.get("deviceLabel"),
                "sessionId": current_session_id,
                "success": True,
                "detail": f"{revoked} other session(s) revoked",
            })
            return json_ok({
                "ok": True,
                "revoked": revoked,
                "message": "All other devices were signed out.",
            })

        if device_id:
            sessions = await list_active_sessions_or_fail(_owner_id(owner))
            targets = [s for s in sessions if str(s.get("deviceId")) == device_id]
            revoked = 0
            for target in targets:
                if await revoke_session_doc(str(target.get("sessionId")), "device_revoked"):
                    revoked += 1
            await record_auth_event({
                "type": "device_revoked",
                "userId": _owner_id(owner),
                "ip": event_base["ip"],
                "userAgent": event_base["userAgent"],
                "deviceId": targets[0].get("deviceId") if targets else device_id,
                "deviceLabel": targets[0].get("deviceLabel") if targets else "Unknown device",
                "sessionId": current_session_id,
                "success": True,
                "detail": f"{revoked} session(s) revoked for device {device_id[:8]}",
            })
            self_revoked = any(str(t.get("sessionId")) == current_session_id for t in targets)
            if self_revoked:
                clear_auth_cookies(response)
            return json_ok({
                "ok": True,
                "revoked": revoked,
                "selfRevoked": self_revoked,
                "message": "This device was signed out." if self_revoked else "Device signed out.",
            })

        self_revoked = target_session_id == current_session_id
        revoked = await revoke_session_doc(target_session_id, "device_revoked")
        await record_auth_event({
            "type": "device_revoked",
            "userId": _owner_id(owner),
            "ip": event_base["ip"],
            "userAgent": event_base["userAgent"],
            "deviceId": session.get("deviceId") if self_revoked else None,
            "deviceLabel": session.get("deviceLabel") if self_revoked else "Another device",
            "sessionId": target_session_id if self_revoked else current_session_id,
            "success": bool(revoked),
            "detail": "Session revoked" if revoked else "Session not found or already revoked",
        })
        if self_revoked:
            clear_auth_cookies(response)
        return json_ok({
            "ok": True,
            "revoked": 1 if revoked else 0,
            "selfRevoked": self_revoked,
            "message": "Session revoked." if revoked else "That session was already inactive.",
        })
    except HTTPException:
        raise
    except Exception as exc:
        fail("Could not revoke the session." if not str(exc) else _redact(str(exc)), 500)


# ---------------------------------------------------------------------------
# Overview / events (Security settings page)
# ---------------------------------------------------------------------------

@router.get("/overview")
async def app_overview(request: Request) -> JSONResponse:
    """GET /api/auth/overview — one payload for the Security settings page."""
    auth = await require_session(request, require_mpin=True)
    owner = auth["owner"]
    try:
        sessions = await list_active_sessions_or_fail(_owner_id(owner))
        credentials = await credentials_or_fail(_owner_id(owner))
        events = await list_auth_events(20)
    except HTTPException:
        raise

    devices = {str(s.get("deviceId")) for s in sessions}
    current_session_id = str(auth["session"].get("sessionId"))
    return json_ok({
        "ok": True,
        "user": public_user(owner),
        "ownerEmailMasked": mask_email(get_signup_full_email() or str(owner.get("email") or "")),
        "mailerConfigured": mailer_configured(),
        "hasMpin": bool(owner.get("mpinHash")),
        "mpinUpdatedAt": _iso(owner.get("mpinUpdatedAt")) if owner.get("mpinUpdatedAt") else None,
        "biometricCount": len(credentials),
        "credentials": [
            {
                "id": str(cred.get("credentialId") or ""),
                "deviceLabel": str(cred.get("deviceLabel") or ""),
                "transports": cred.get("transports") or [],
                "createdAt": _iso(cred.get("createdAt")) or "",
                "lastUsedAt": (_iso(cred.get("lastUsedAt")) if cred.get("lastUsedAt") else None),
            }
            for cred in credentials
        ],
        "deviceCount": len(devices),
        "maxDevices": get_max_active_sessions(),
        "sessions": [public_session(s, current_session_id) for s in sessions],
        "events": [_public_event(event) for event in events],
    })


def _public_event(event: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(event.get("_id") or ""),
        "type": str(event.get("type") or ""),
        "ip": str(event.get("ip") or ""),
        "userAgent": str(event.get("userAgent") or ""),
        "deviceLabel": str(event.get("deviceLabel") or ""),
        "success": bool(event.get("success")),
        "detail": str(event.get("detail") or ""),
        "at": _iso(event.get("at")) or "",
    }


@router.get("/events")
async def app_events(request: Request) -> JSONResponse:
    """GET /api/auth/events?limit=50 — the login/IP audit trail."""
    auth = await require_session(request, require_mpin=True)

    import re
    raw = request.query_params.get("limit")
    limit = int(re.match(r"^-?\d+$", raw).group()) if raw and re.match(r"^-?\d+$", raw) else 50
    try:
        events = await list_auth_events(limit if limit else 50)
    except Exception as exc:
        raise _db_down_error(exc) from exc
    return json_ok({
        "ok": True,
        "count": len(events),
        "events": [_public_event(event) for event in events],
    })


# ---------------------------------------------------------------------------
# MPIN endpoints
# ---------------------------------------------------------------------------

@router.post("/mpin/setup")
async def app_mpin_setup(request: Request, response: Response) -> JSONResponse:
    """POST /api/auth/mpin/setup — mandatory after the FIRST login."""
    auth = await require_session(request)
    owner = auth["owner"]
    if owner.get("mpinHash"):
        fail("An MPIN is already set. Use Change MPIN instead.", 409, {"code": "MPIN_ALREADY_SET"})

    body = await read_json(request)
    if not body:
        fail("Invalid request body.", 400)

    mpin = str(body.get("mpin") or "")
    confirm = str(body.get("confirm") if body.get("confirm") is not None else body.get("confirmMpin") or "")
    if confirm and confirm != mpin:
        fail("The two MPIN entries do not match.", 400)

    result = await set_owner_mpin(mpin)
    if not result.get("ok"):
        fail(result.get("message") or "Could not set the MPIN.", int(result.get("status") or 400))

    _delete_cookie(response, MPIN_PENDING_COOKIE)   # markMpinConfigured
    event = auth["session"]
    await record_auth_event({
        "type": "mpin_setup",
        "userId": _owner_id(owner),
        "ip": _get_client_ip(request) or "unknown",
        "userAgent": get_request_ua(request),
        "deviceId": event.get("deviceId"),
        "deviceLabel": event.get("deviceLabel"),
        "sessionId": str(event.get("sessionId") or ""),
        "success": True,
        "detail": "MPIN configured",
    })

    return json_ok({
        "ok": True,
        "hasMpin": True,
        "needsMpinSetup": False,
        "needsUnlock": True,
        "message": "MPIN set. The app is now unlocked.",
    })


@router.post("/mpin/verify")
async def app_mpin_verify(request: Request) -> JSONResponse:
    """POST /api/auth/mpin/verify — app unlock with the MPIN."""
    auth = await require_session(request)
    owner = auth["owner"]

    body = await read_json(request)
    if not body:
        fail("Invalid request body.", 400)

    result = await verify_owner_mpin(owner, body.get("mpin"))
    session = auth["session"]
    event_base = _event_base(request)
    await record_auth_event({
        "type": "mpin_verified" if result.get("ok") else "mpin_failed",
        "userId": _owner_id(owner),
        "ip": event_base["ip"],
        "userAgent": event_base["userAgent"],
        "deviceId": session.get("deviceId"),
        "deviceLabel": session.get("deviceLabel"),
        "sessionId": str(session.get("sessionId") or ""),
        "success": bool(result.get("ok")),
        "detail": "App unlocked with MPIN" if result.get("ok") else (result.get("message") or "MPIN verification failed"),
    })

    if not result.get("ok"):
        fail(result.get("message") or "Incorrect MPIN.", int(result.get("status") or 401), {
            "lockedUntil": result.get("lockedUntil"),
        })

    return json_ok({"ok": True, "unlocked": True, "message": "Unlocked."})


@router.post("/mpin/change")
async def app_mpin_change(request: Request) -> JSONResponse:
    """POST /api/auth/mpin/change — Body: { currentMpin, newMpin, confirm? }"""
    auth = await require_session(request)
    owner = auth["owner"]
    if not owner.get("mpinHash"):
        fail("No MPIN is set yet. Use Set MPIN instead.", 409, {"code": "MPIN_NOT_SET"})

    body = await read_json(request)
    if not body:
        fail("Invalid request body.", 400)

    current_mpin = str(body.get("currentMpin") if body.get("currentMpin") is not None else body.get("currentPin") or "")
    new_mpin = str(body.get("newMpin") if body.get("newMpin") is not None else body.get("newPin") or "")
    confirm = str(body.get("confirm") or "")

    if new_mpin and confirm and new_mpin != confirm:
        fail("The two new MPIN entries do not match.", 400)
    if current_mpin == new_mpin:
        fail("The new MPIN must be different from the current one.", 400)

    current = await verify_owner_mpin(owner, current_mpin)
    if not current.get("ok"):
        fail(current.get("message") or "Incorrect current MPIN.", int(current.get("status") or 401))

    result = await set_owner_mpin(new_mpin)
    if not result.get("ok"):
        fail(result.get("message") or "Could not change the MPIN.", int(result.get("status") or 400))

    session = auth["session"]
    event_base = _event_base(request)
    await record_auth_event({
        "type": "mpin_changed",
        "userId": _owner_id(owner),
        "ip": event_base["ip"],
        "userAgent": event_base["userAgent"],
        "deviceId": session.get("deviceId"),
        "deviceLabel": session.get("deviceLabel"),
        "sessionId": str(session.get("sessionId") or ""),
        "success": True,
        "detail": "MPIN changed",
    })
    return json_ok({"ok": True, "message": "MPIN changed."})


@router.post("/mpin/disable")
async def app_mpin_disable(request: Request, response: Response) -> JSONResponse:
    """POST /api/auth/mpin/disable — Body: { mpin }

    MPIN and biometric are alternatives, so an MPIN can only be removed while
    at least one real WebAuthn credential is registered — otherwise the owner
    could lock themselves out of their only account permanently.
    """
    auth = await require_session(request)
    owner = auth["owner"]
    if not owner.get("mpinHash"):
        fail("No MPIN is configured.", 409, {"code": "MPIN_NOT_SET"})

    body = await read_json(request)
    if not body:
        fail("Invalid request body.", 400)

    credentials = await credentials_or_fail(_owner_id(owner))
    if not credentials:
        fail(
            "Register a fingerprint / face credential first. MPIN and biometric are alternatives — "
            "removing both would lock you out.",
            409,
            {"code": "BIOMETRIC_REQUIRED"},
        )

    result = await verify_owner_mpin(owner, body.get("mpin") if body.get("mpin") is not None else body.get("pin"))
    if not result.get("ok"):
        fail(result.get("message") or "Incorrect MPIN.", int(result.get("status") or 401))

    await clear_owner_mpin()
    session = auth["session"]
    event_base = _event_base(request)
    await record_auth_event({
        "type": "mpin_removed",
        "userId": _owner_id(owner),
        "ip": event_base["ip"],
        "userAgent": event_base["userAgent"],
        "deviceId": session.get("deviceId"),
        "deviceLabel": session.get("deviceLabel"),
        "sessionId": str(session.get("sessionId") or ""),
        "success": True,
        "detail": "MPIN removed; biometric unlock remains active",
    })

    _delete_cookie(response, MPIN_PENDING_COOKIE)
    return json_ok({
        "ok": True,
        "hasMpin": False,
        "needsMpinSetup": False,
        "needsUnlock": True,
        "message": "MPIN removed. Biometric unlock is still active.",
    })


# ---------------------------------------------------------------------------
# Legacy aliases (kept for the existing Settings -> Security card)
# ---------------------------------------------------------------------------

@router.get("/setup")
async def app_setup_get(request: Request) -> JSONResponse:
    """GET /api/auth/setup — legacy MPIN card read."""
    auth = await require_session(request)
    owner = auth["owner"]
    configured = bool(owner.get("mpinHash"))
    return json_ok({
        "ok": True,
        "configured": configured,
        "source": "database" if configured else ("environment" if get_signup_mpin() else "none"),
        "hasMpin": configured,
        "signupConfigured": bool(get_signup_email() and get_signup_mpin()),
    })


@router.post("/setup")
async def app_setup_post(request: Request, response: Response) -> JSONResponse:
    """POST /api/auth/setup — legacy MPIN card create (step=create-pin)."""
    auth = await require_session(request)
    owner = auth["owner"]

    body = await read_json(request)
    if not body:
        fail("Invalid request body.", 400)

    step = str(body.get("step") or "create-pin")
    if step != "create-pin":
        fail("Unsupported setup step. Use step=create-pin.", 400)
    if owner.get("mpinHash"):
        fail("An MPIN is already configured. Use Change MPIN instead.", 409)

    raw = (body.get("pin") if body.get("pin") is not None else body.get("mpin"))
    result = await set_owner_mpin(raw)
    if not result.get("ok"):
        fail(result.get("message") or "Could not set the MPIN.", int(result.get("status") or 400))

    _delete_cookie(response, MPIN_PENDING_COOKIE)
    session = auth["session"]
    event_base = _event_base(request)
    await record_auth_event({
        "type": "mpin_setup",
        "userId": _owner_id(owner),
        "ip": event_base["ip"],
        "userAgent": event_base["userAgent"],
        "deviceId": session.get("deviceId"),
        "deviceLabel": session.get("deviceLabel"),
        "sessionId": str(session.get("sessionId") or ""),
        "success": True,
        "detail": "MPIN configured (legacy setup endpoint)",
    })
    return json_ok({"ok": True, "configured": True})


@router.post("/pin/change")
async def app_pin_change(request: Request) -> JSONResponse:
    """POST /api/auth/pin/change — legacy alias of MPIN change."""
    auth = await require_session(request)
    owner = auth["owner"]
    if not owner.get("mpinHash"):
        fail("No MPIN is set yet. Use the setup flow first.", 409, {"code": "MPIN_NOT_SET"})

    body = await read_json(request)
    if not body:
        fail("Invalid request body.", 400)

    current = str(body.get("currentPin") if body.get("currentPin") is not None else body.get("currentMpin") or "")
    nxt = str(body.get("newPin") if body.get("newPin") is not None else body.get("newMpin") or "")
    if not current or not nxt:
        fail("Both current and new MPIN are required.", 400)
    if current == nxt:
        fail("The new MPIN must be different.", 400)

    verified = await verify_owner_mpin(owner, current)
    if not verified.get("ok"):
        fail(verified.get("message") or "Incorrect current MPIN.", int(verified.get("status") or 401))

    result = await set_owner_mpin(nxt)
    if not result.get("ok"):
        fail(result.get("message") or "Could not change the MPIN.", int(result.get("status") or 400))

    session = auth["session"]
    event_base = _event_base(request)
    await record_auth_event({
        "type": "mpin_changed",
        "userId": _owner_id(owner),
        "ip": event_base["ip"],
        "userAgent": event_base["userAgent"],
        "deviceId": session.get("deviceId"),
        "deviceLabel": session.get("deviceLabel"),
        "sessionId": str(session.get("sessionId") or ""),
        "success": True,
        "detail": "MPIN changed (legacy pin endpoint)",
    })
    return json_ok({"ok": True, "message": "MPIN changed."})


@router.post("/pin/disable")
async def app_pin_disable(request: Request, response: Response) -> JSONResponse:
    """POST /api/auth/pin/disable — legacy alias of MPIN disable."""
    auth = await require_session(request)
    owner = auth["owner"]
    if not owner.get("mpinHash"):
        fail("No MPIN is configured.", 409, {"code": "MPIN_NOT_SET"})

    body = await read_json(request)
    if not body:
        fail("Invalid request body.", 400)

    credentials = await credentials_or_fail(_owner_id(owner))
    if not credentials:
        fail(
            "Register a fingerprint / face credential first. MPIN and biometric are alternatives.",
            409,
            {"code": "BIOMETRIC_REQUIRED"},
        )

    verified = await verify_owner_mpin(owner, body.get("pin") if body.get("pin") is not None else body.get("mpin"))
    if not verified.get("ok"):
        fail(verified.get("message") or "Incorrect MPIN.", int(verified.get("status") or 401))

    await clear_owner_mpin()
    session = auth["session"]
    event_base = _event_base(request)
    await record_auth_event({
        "type": "mpin_removed",
        "userId": _owner_id(owner),
        "ip": event_base["ip"],
        "userAgent": event_base["userAgent"],
        "deviceId": session.get("deviceId"),
        "deviceLabel": session.get("deviceLabel"),
        "sessionId": str(session.get("sessionId") or ""),
        "success": True,
        "detail": "MPIN removed; biometric unlock remains active",
    })
    return json_ok({"ok": True, "configured": False, "message": "MPIN removed."})


# ---------------------------------------------------------------------------
# WebAuthn data plane (crypto verification stays on the Vercel route where the
# browser origin is known; VM1 owns persistence + the self-lockout guards).
# ---------------------------------------------------------------------------

def _webauthn_error(exc: BaseException) -> HTTPException:
    message = _redact(str(exc)) or "The auth database is unavailable."
    return HTTPException(status_code=503, detail={
        "ok": False, "message": message, "error": message, "database": False,
    })


def _credential_public(cred: dict[str, Any], include_secret: bool) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": str(cred.get("credentialId") or ""),
        "deviceLabel": str(cred.get("deviceLabel") or ""),
        "transports": cred.get("transports") or [],
        "createdAt": _iso(cred.get("createdAt")) if cred.get("createdAt") else "",
        "lastUsedAt": _iso(cred.get("lastUsedAt")) if cred.get("lastUsedAt") else None,
    }
    if include_secret:
        out["publicKey"] = str(cred.get("publicKey") or "")
        out["counter"] = int(cred.get("counter") or 0)
    return out


@router.get("/webauthn/credentials")
async def webauthn_credentials(request: Request) -> JSONResponse:
    """GET /api/auth/webauthn/credentials — registered authenticators for reruns."""
    auth = await require_session(request)
    owner = auth["owner"]
    try:
        credentials = await list_credentials(_owner_id(owner))
    except Exception as exc:
        raise _webauthn_error(exc) from exc
    return json_ok({
        "ok": True,
        "hasMpin": bool(owner.get("mpinHash")),
        "biometricCount": len(credentials),
        "credentials": [_credential_public(cred, include_secret=True) for cred in credentials],
    })


@router.post("/webauthn/credentials")
async def webauthn_credential_add(request: Request) -> JSONResponse:
    """POST /api/auth/webauthn/credentials — persist a VERIFIED credential.

    Body: { credentialId, publicKey, counter?, transports?, deviceLabel? }
    The WebAuthn registration itself was already verified on the Vercel route;
    this endpoint only stores public crypto material (never a secret).
    """
    auth = await require_session(request)
    owner = auth["owner"]
    body = await read_json(request)
    if not body:
        fail("Invalid request body.", 400)

    credential_id = str(body.get("credentialId") or "").strip()
    public_key = str(body.get("publicKey") or "").strip()
    if not credential_id or not public_key:
        fail("credentialId and publicKey are required.", 400)

    try:
        existing = await _webauthn().find_one({"credentialId": credential_id})
        if existing:
            return json_ok({
                "ok": True,
                "alreadyRegistered": True,
                "biometricCount": await count_credentials(_owner_id(owner)),
                "message": "This biometric is already registered.",
            })
        now = datetime.now(timezone.utc)
        await _webauthn().insert_one({
            "credentialId": credential_id,
            "userId": _owner_id(owner),
            "publicKey": public_key,
            "counter": int(body.get("counter") or 0),
            "transports": [str(t) for t in (body.get("transports") or []) if isinstance(t, str)],
            "deviceLabel": safe_device_label(body.get("deviceLabel"), auth["session"].get("deviceLabel") or "This device"),
            "createdAt": now,
            "lastUsedAt": None,
        })
        await record_auth_event({
            "type": "biometric_registered",
            "userId": _owner_id(owner),
            "ip": _get_client_ip(request) or "unknown",
            "userAgent": get_request_ua(request),
            "deviceId": auth["session"].get("deviceId"),
            "deviceLabel": safe_device_label(body.get("deviceLabel"), auth["session"].get("deviceLabel") or "This device"),
            "sessionId": str(auth["session"].get("sessionId") or ""),
            "success": True,
            "detail": "WebAuthn credential registered",
        })
        return json_ok({
            "ok": True,
            "registered": True,
            "credentialId": credential_id,
            "biometricCount": await count_credentials(_owner_id(owner)),
            "message": "Fingerprint / face unlock is now registered.",
        })
    except HTTPException:
        raise
    except Exception as exc:
        raise _webauthn_error(exc) from exc


@router.post("/webauthn/credentials/remove")
async def webauthn_credential_remove(request: Request) -> JSONResponse:
    """POST /api/auth/webauthn/credentials/remove — DELETE parity for proxies.

    Body: { credentialId }. The LAST credential cannot be removed while no MPIN
    exists, otherwise the owner would have no way back in.
    """
    auth = await require_session(request)
    owner = auth["owner"]
    body = await read_json(request)
    credential_id = str((body or {}).get("credentialId") or "").strip()
    if not credential_id:
        fail("Specify credentialId.", 400)

    try:
        credentials = await list_credentials(_owner_id(owner))
        target = next((c for c in credentials if str(c.get("credentialId")) == credential_id), None)
        if not target:
            fail("That biometric credential was not found.", 404)
        if len(credentials) <= 1 and not owner.get("mpinHash"):
            fail("This is your only unlock method. Set an MPIN before removing it.", 409, {
                "code": "LAST_UNLOCK_METHOD",
            })

        removed = (await _webauthn().delete_one({"credentialId": credential_id, "userId": _owner_id(owner)})).deleted_count > 0
        await record_auth_event({
            "type": "biometric_removed",
            "userId": _owner_id(owner),
            "ip": _get_client_ip(request) or "unknown",
            "userAgent": get_request_ua(request),
            "deviceId": auth["session"].get("deviceId"),
            "deviceLabel": target.get("deviceLabel"),
            "sessionId": str(auth["session"].get("sessionId") or ""),
            "success": bool(removed),
            "detail": "WebAuthn credential removed" if removed else "Credential not found",
        })
        remaining = len(await list_credentials(_owner_id(owner)))
        return json_ok({
            "ok": bool(removed),
            "removed": bool(removed),
            "biometricCount": remaining,
            "message": "Biometric credential removed." if removed else "That credential was already removed.",
        })
    except HTTPException:
        raise
    except Exception as exc:
        raise _webauthn_error(exc) from exc


@router.post("/webauthn/challenge")
async def webauthn_challenge_save(request: Request) -> JSONResponse:
    """POST /api/auth/webauthn/challenge — persist a fresh challenge (5 min TTL)."""
    auth = await require_session(request)
    body = await read_json(request)
    if not body:
        fail("Invalid request body.", 400)

    challenge = str(body.get("challenge") or "").strip()
    kind = str(body.get("type") or "")
    if not challenge or len(challenge) > 256:
        fail("A valid challenge string is required.", 400)
    if kind not in ("registration", "authentication"):
        fail("type must be registration or authentication.", 400)

    try:
        await _ensure_auth_indexes()
        await _challenges().insert_one({
            "challenge": challenge,
            "type": kind,
            "userId": _owner_id(auth["owner"]),
            "createdAt": datetime.now(timezone.utc),
            "expiresAt": datetime.now(timezone.utc) + timedelta(milliseconds=WEBAUTHN_CHALLENGE_TTL_MS),
        })
    except Exception as exc:
        raise _webauthn_error(exc) from exc
    return json_ok({"ok": True})


@router.post("/webauthn/challenge/take")
async def webauthn_challenge_take(request: Request) -> JSONResponse:
    """POST /api/auth/webauthn/challenge/take — consume the newest challenge ONCE."""
    auth = await require_session(request)
    body = await read_json(request)
    kind = str((body or {}).get("type") or "")
    if kind not in ("registration", "authentication"):
        fail("type must be registration or authentication.", 400)

    try:
        row = await _challenges().find_one_and_delete(
            {"type": kind, "expiresAt": {"$gt": datetime.now(timezone.utc)}},
            sort=[("createdAt", -1)],
        )
    except Exception as exc:
        raise _webauthn_error(exc) from exc
    if not row:
        return json_ok({"ok": True, "challenge": None})
    return json_ok({"ok": True, "challenge": str(row.get("challenge") or "")})


@router.post("/webauthn/counters")
async def webauthn_counter_update(request: Request) -> JSONResponse:
    """POST /api/auth/webauthn/counters — persist counter + the unlock event.

    Body: { credentialId, counter?, success, detail? } — after the Vercel route
    verified the WebAuthn assertion (biometric_login / biometric_failed).
    """
    auth = await require_session(request)
    owner = auth["owner"]
    body = await read_json(request)
    if not body:
        fail("Invalid request body.", 400)

    credential_id = str(body.get("credentialId") or "").strip()
    success = body.get("success") is True
    try:
        if success and credential_id:
            try:
                await _webauthn().update_one(
                    {"credentialId": credential_id},
                    {"$set": {"counter": int(body.get("counter") or 0), "lastUsedAt": datetime.now(timezone.utc)}},
                )
            except Exception as exc:
                raise _webauthn_error(exc) from exc
        await record_auth_event({
            "type": "biometric_login" if success else "biometric_failed",
            "userId": _owner_id(owner),
            "ip": _get_client_ip(request) or "unknown",
            "userAgent": get_request_ua(request),
            "deviceId": auth["session"].get("deviceId"),
            "deviceLabel": auth["session"].get("deviceLabel"),
            "sessionId": str(auth["session"].get("sessionId") or ""),
            "success": success,
            "detail": str(body.get("detail") or ("App unlocked with biometrics" if success else "App unlock failed")),
        })
    except HTTPException:
        raise
    return json_ok({"ok": True})


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@router.get("/health")
async def app_auth_health() -> JSONResponse:
    """GET /api/auth/health — auth-service health; reveals no secret material."""
    mongo_ok = is_mongo_connected()
    secret = resolve_session_secret()
    try:
        _require_session_secret()
        secret_ok = True
    except Exception:
        secret_ok = False
        del secret
    return json_ok({
        "ok": bool(mongo_ok and secret_ok),
        "service": "kaustubh-auth-app",
        "mongodb": mongo_ok,
        "sessionSecretConfigured": secret_ok,
    })
