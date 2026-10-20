"""Mode Lock API — /api/terminal/security/*.

Server-side configuration + unlock for Trading Terminal mode switching.

  * Configuration endpoints (pin / lock / webauthn/register*) require the user
    JWT (operator action) — same credential that protects all other terminal
    mutating operations.
  * Unlock endpoints are PUBLIC by design: Mode Lock exists so the per-browser
    trading session can switch modes WITHOUT the operator JWT; the lock gates
    the switch with a short-lived unlock token instead.
  * The PIN hash and WebAuthn private material are never exposed (see
    services.mode_lock).
"""
from __future__ import annotations

import logging
import time

from fastapi import APIRouter, Depends, HTTPException, Request

from services import mode_lock as ml

router = APIRouter(prefix="/api/terminal/security", tags=["terminal-security"])
log = logging.getLogger("security_api")

# ---- brute-force guard (in-memory) -------------------------------------------

def _rate_limit_key(request: Request) -> tuple[str, str]:
    ip = (request.client.host if request.client else "unknown")
    path = request.url.path
    return (ip, path)


def _check_rate_limit(key: tuple[str, str]) -> None:
    now = time.monotonic()
    count, until = ml._fail_windows.get(key, (0, None))
    if count >= ml._MAX_FAILS_PER_WINDOW and until is not None and until > now:
        raise HTTPException(429, detail={
            "code": "TOO_MANY_ATTEMPTS",
            "message": "too many failed unlock attempts — try again later",
        })


def _record_fail(key: tuple[str, str]) -> None:
    now = time.monotonic()
    count, until = ml._fail_windows.get(key, (0, None))
    count += 1
    until = now + ml._FAIL_WINDOW_SECONDS if count >= ml._MAX_FAILS_PER_WINDOW else until
    ml._fail_windows[key] = (count, until)


def _clear_fails(key: tuple[str, str]) -> None:
    ml._fail_windows.pop(key, None)


async def _issue_token_or_503() -> str:
    token = ml.issue_unlock_token()
    if not token:
        raise HTTPException(503, detail={
            "code": "UNLOCK_TOKEN_UNAVAILABLE",
            "message": "JWT_SECRET not configured — cannot issue an unlock token",
        })
    return token


# ---- status (public, no secrets) ----------------------------------------------

@router.get("")
async def security_status():
    try:
        return await ml.mode_lock_status()
    except Exception as exc:
        raise HTTPException(503, detail={
            "code": "SECURITY_UNAVAILABLE", "message": str(exc),
        }) from exc


# ---- configuration (JWT-protected) --------------------------------------------

def _require_user(request: Request) -> dict:
    from api.terminal import require_jwt
    return require_jwt(request)


@router.post("/pin")
async def security_pin(body: dict, _auth: dict = Depends(_require_user)):
    action = str(body.get("action") or "")
    try:
        if action == "set":
            result = await ml.set_pin(str(body.get("pin") or ""))
        elif action == "change":
            result = await ml.change_pin(
                str(body.get("currentPin") or ""),
                str(body.get("newPin") or ""),
            )
        elif action == "disable":
            result = await ml.disable_pin(str(body.get("pin") or ""))
        else:
            raise ValueError("action must be one of set|change|disable")
    except ValueError as exc:
        raise HTTPException(400, detail={"code": "PIN_ERROR", "message": str(exc)}) from exc
    return {"ok": True, **result}


@router.post("/lock")
async def security_set_lock(body: dict, _auth: dict = Depends(_require_user)):
    try:
        result = await ml.set_lock_enabled(bool(body.get("enabled")))
    except ValueError as exc:
        raise HTTPException(400, detail={"code": "MODE_LOCK", "message": str(exc)}) from exc
    return {"ok": True, **result}


# ---- PIN unlock (public) -------------------------------------------------------

@router.post("/unlock")
async def security_unlock(body: dict, request: Request):
    key = _rate_limit_key(request)
    _check_rate_limit(key)
    method = str(body.get("method") or "pin")
    status = await ml.mode_lock_status()
    if not status["lockEnabled"]:
        return {"ok": True, "unlockToken": None, "message": "Mode Lock is not enabled"}
    if not status["configured"]:
        raise HTTPException(409, detail={
            "code": "MODE_LOCK", "message": "Mode Lock has no unlock method configured",
        })
    if method == "pin":
        if not await ml.verify_pin_against_store(str(body.get("pin") or "")):
            _record_fail(key)
            raise HTTPException(401, detail={
                "code": "UNLOCK_FAILED", "message": "incorrect PIN",
            })
        _clear_fails(key)
        token = await _issue_token_or_503()
        return {"ok": True, "unlockToken": token, "expiresInSeconds": ml._UNLOCK_TTL_SECONDS}
    raise HTTPException(400, detail={"code": "UNLOCK_METHOD", "message": "method must be 'pin'"})


# ---- WebAuthn (begin: public / register config: JWT) ----------------------------

@router.post("/webauthn/register/begin")
async def webauthn_register_begin(_auth: dict = Depends(_require_user)):
    try:
        return {"ok": True, **await ml.webauthn_register_options()}
    except ValueError as exc:
        raise HTTPException(409, detail={"code": "WEBAUTHN", "message": str(exc)}) from exc


@router.post("/webauthn/register/complete")
async def webauthn_register_done(body: dict, _auth: dict = Depends(_require_user)):
    try:
        return {"ok": True, **await ml.webauthn_register_complete(body)}
    except ValueError as exc:
        raise HTTPException(400, detail={"code": "WEBAUTHN", "message": str(exc)}) from exc


@router.post("/webauthn/authenticate/begin")
async def webauthn_authenticate_begin():
    try:
        return {"ok": True, **await ml.webauthn_authenticate_options()}
    except ValueError as exc:
        raise HTTPException(409, detail={
            "code": "WEBAUTHN_NOT_REGISTERED", "message": str(exc),
        }) from exc


@router.post("/webauthn/authenticate/complete")
async def webauthn_authenticate_done(body: dict, request: Request):
    key = _rate_limit_key(request)
    _check_rate_limit(key)
    try:
        await ml.webauthn_authenticate_complete(body)
    except ValueError as exc:
        _record_fail(key)
        raise HTTPException(401, detail={
            "code": "WEBAUTHN_FAILED", "message": str(exc),
        }) from exc
    _clear_fails(key)
    token = await _issue_token_or_503()
    return {"ok": True, "unlockToken": token, "expiresInSeconds": ml._UNLOCK_TTL_SECONDS}