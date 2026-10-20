"""User-level JWT auth for the trading terminal (backend-only secret).

Independent of broker login: this authenticates the human operator against
the app password in Settings BEFORE any mutating terminal action is allowed.
Implementations is stdlib-only (HMAC-SHA256 HS256 JWT), no new dependencies.
Secrets (JWT_SECRET / APP_PASSWORD) never leave the backend.
"""
from __future__ import annotations
import base64
import hashlib
import hmac
import json
import time
from typing import Any

from config.settings import settings


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def _sign(header_b64: str, payload_b64: str) -> str:
    message = f"{header_b64}.{payload_b64}".encode("ascii")
    secret = (settings.jwt_secret or "dev-insecure-jwt-secret").encode("utf-8")
    digest = hmac.new(secret, message, hashlib.sha256).digest()
    return _b64url(digest)


def issue_token(username: str) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    now = int(time.time())
    payload = {
        "sub": username,
        "iat": now,
        "exp": now + settings.jwt_ttl_seconds,
        "iss": settings.jwt_issuer,
        "aud": settings.jwt_audience,
    }
    header_b64 = _b64url(json.dumps(header, separators=(",", ":")).encode("utf-8"))
    payload_b64 = _b64url(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    return f"{header_b64}.{payload_b64}.{_sign(header_b64, payload_b64)}"


def verify_token(token: str) -> dict[str, Any]:
    """Verify signature, exp, iss and aud. Returns the payload; raises on any
    failure (signature mismatch, expired, wrong audience, malformed)."""
    try:
        parts = token.split(".")
        if len(parts) != 3:
            raise ValueError("malformed token")
        header_b64, payload_b64, signature = parts
        expected = _sign(header_b64, payload_b64)
        if not hmac.compare_digest(expected, signature):
            raise ValueError("signature mismatch")
        payload = json.loads(_b64url_decode(payload_b64).decode("utf-8"))
    except Exception as exc:
        raise ValueError(f"invalid token: {exc}") from exc

    now = int(time.time())
    if payload.get("exp", 0) <= now:
        raise ValueError("token expired")
    if payload.get("iss") != settings.jwt_issuer:
        raise ValueError("invalid issuer")
    if payload.get("aud") != settings.jwt_audience:
        raise ValueError("invalid audience")
    return payload


def authenticate_user(username: str, password: str) -> bool:
    """Constant-time comparison against the configured app password. Never
    times-dependent; never logs either value."""
    expected = settings.app_password or ""
    if not expected or not username or not password:
        return False
    if username != settings.app_username:
        return False
    return hmac.compare_digest(password.encode("utf-8"), expected.encode("utf-8"))


def read_token(request) -> str | None:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return request.headers.get("x-kaustubh-token") or None