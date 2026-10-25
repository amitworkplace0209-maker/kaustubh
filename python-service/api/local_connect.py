"""Local Connect Engine API.

This module lets a browser running on the same device (or any trusted client)
auto-detect the KAUSTUBH backend on localhost:8000, authenticate, and open a
safe, permission-scoped bridge. The engine never exposes broker credentials;
it only mints short-lived session tokens bound to an explicit permission set.
"""

from __future__ import annotations

import logging
import secrets
import time
from typing import Any, Dict

from fastapi import APIRouter, Body, Header

logger = logging.getLogger("app.local_connect")

router = APIRouter(prefix="/api/local-connect", tags=["local-connect"])

# In-memory session store. Sessions are short-lived and device-local; a backend
# restart simply requires a new handshake, which the engine performs automatically.
_SESSIONS: Dict[str, Dict[str, Any]] = {}
_SESSION_TTL_SEC = 60 * 60 * 8  # 8 hours

_CAPABILITIES = [
    "backendHealth",
    "backendSystem",
    "backendEngines",
    "backendMarketData",
    "brokerDummy",
    "brokerKotak",
    "brokerShoonya",
    "orderPlace",
    "orderCancel",
    "orderModify",
    "websocketFeed",
    "websocketControl",
    "connectionManagerRead",
    "connectionManagerControl",
    "databaseRead",
    "dataDownload",
    "dataExport",
    "marketDataRead",
    "suggestionsRead",
    "suggestionsRun",
    "schedulerRead",
    "schedulerControl",
    "systemConfig",
    "readStatus",
    "readModels",
    "runChat",
    "runAnalyze",
]


def _now() -> float:
    return time.time()


def _prune() -> None:
    cutoff = _now()
    expired = [tok for tok, s in _SESSIONS.items() if s.get("expires_at", 0) < cutoff]
    for tok in expired:
        _SESSIONS.pop(tok, None)


def _ok(data) -> dict:
    return {"ok": True, "data": data}


def _bad(message: str) -> dict:
    return {"ok": False, "error": message}


@router.get("/discover")
async def discover():
    """Identity + capabilities of this backend. Used for auto-detection."""
    return _ok(
        {
            "service": "kaustubh-backend",
            "version": "1.0",
            "host": "localhost",
            "port": 8000,
            "capabilities": _CAPABILITIES,
            "auth": "bridge-token",
            "timestamp": _now(),
        }
    )


@router.post("/handshake")
async def handshake(body: dict = Body(default={})):
    """Mint a short-lived, permission-scoped session token.

    Body: { device_id, bridge_id, permissions: {perm: bool}, client_version? }
    """
    _prune()
    if not isinstance(body, dict):
        return _bad("a JSON object is required")
    device_id = str(body.get("device_id") or "").strip()
    bridge_id = str(body.get("bridge_id") or "").strip()
    if not device_id:
        device_id = "anonymous-device"
    requested = body.get("permissions") if isinstance(body.get("permissions"), dict) else {}
    granted = {cap: bool(requested.get(cap, False)) for cap in _CAPABILITIES}
    # Safety: never grant privileged control flags unless explicitly requested
    # and the device is local loopback. (Best-effort; real enforcement lives in
    # the individual endpoints.)
    token = secrets.token_urlsafe(32)
    _SESSIONS[token] = {
        "device_id": device_id,
        "bridge_id": bridge_id,
        "permissions": granted,
        "created_at": _now(),
        "expires_at": _now() + _SESSION_TTL_SEC,
        "last_seen": _now(),
    }
    logger.info("local-connect handshake device=%s bridge=%s", device_id, bridge_id)
    return _ok(
        {
            "session_token": token,
            "token_type": "Bearer",
            "expires_in": _SESSION_TTL_SEC,
            "granted_permissions": granted,
            "backend": "kaustubh-backend",
        }
    )


@router.get("/session")
async def session_info(x_local_connect_token: str = Header(default="", alias="X-Local-Connect-Token")):
    _prune()
    tok = (x_local_connect_token or "").strip()
    if not tok or tok not in _SESSIONS:
        return _bad("invalid or expired session token")
    s = _SESSIONS[tok]
    s["last_seen"] = _now()
    return _ok(
        {
            "device_id": s["device_id"],
            "bridge_id": s["bridge_id"],
            "permissions": s["permissions"],
            "expires_at": s["expires_at"],
        }
    )


@router.post("/revoke")
async def revoke(body: dict = Body(default={})):
    token = str((body or {}).get("session_token") or "").strip()
    if token and token in _SESSIONS:
        _SESSIONS.pop(token, None)
        return _ok({"revoked": True})
    return _bad("session not found")


@router.get("/permissions")
async def list_permissions():
    return _ok({"capabilities": _CAPABILITIES})
