"""Auth API — manual login / logout against the ONE central broker session.

Single entry point for manual broker login. It never creates a second login:
if a valid central session already exists (auto or manual), it returns the
existing session with its real timestamps and remaining time (#6/#7).

Failure responses are structured / JSON (never a bare string):
    {success:false, status:"FAILED", reason, errorCode, timestamp}
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException
from starlette.responses import JSONResponse

from auth.kotak_client import kotak_session
from brokers.manager import active_mode, active_terminal, switch_terminal
from scheduler import do_login, do_logout
from services.notification_center import emit_event as record_event
from services.session.session_manager import session_manager
from ws_socket.ws_manager import ws_manager

router = APIRouter(prefix="/api/auth", tags=["auth"])
log = logging.getLogger("auth_api")

from core.timezones import IST


def _failure_payload(err: str) -> dict:
    """Honest structured login-failure payload (never fabricated data)."""
    text = str(err).strip() or "login failed"
    lowered = text.lower()
    if "timed out" in lowered or "timeout" in lowered:
        error_code = "LOGIN_TIMEOUT"
    elif any(k in lowered for k in (
        "invalid", "unauthor", "authentication", "auth failed",
        "wrong", "mpin", "totp", "rejected", "credentials",
    )):
        error_code = "AUTH_REJECTED"
    elif any(k in lowered for k in (
        "network", "connect", "socket", "ssl", "dns", "unreachable",
        "unavailable", "connection",
    )):
        error_code = "BROKER_UNAVAILABLE"
    else:
        error_code = "UNKNOWN"
    return {
        "ok": False,
        "success": False,
        "status": "FAILED",
        "reason": text,
        "errorCode": error_code,
        "timestamp": datetime.now(IST).isoformat(),
    }


def _existing_payload(created: bool = False) -> dict:
    """Snapshot of the CURRENT central session — timestamps are real."""
    snap = session_manager.snapshot()
    ws = ws_manager.status()
    status = str(snap.get("status") or snap.get("state") or "UNKNOWN")
    return {
        "ok": True,
        "message": status,
        "created": created,
        "status": snap["status"],
        "state": snap["state"],
        "session_id": snap["sessionId"],
        "mode": snap["mode"],
        "broker": snap["broker"] or "Kotak Neo",
        "user_id": snap["userId"],
        "login_source": snap.get("loginSource"),
        "login_time": snap["loginTime"],
        "expires_at": snap["expiresAt"],
        "validated_at": snap["validatedAt"],
        "remaining_seconds": snap["remainingSeconds"],
        "session_duration_seconds": snap["sessionDurationSeconds"],
        "websocket": {
            "connected": ws["connected"],
            "state": ws["lifecycle_state"],
            "id": ws["websocket_id"],
            "session_id": ws["session_id"],
            "subscription_count": ws["subscription_count"],
            "disconnect_reason": ws["disconnect_reason"],
            "disconnect_reason_code": ws["disconnect_reason_code"],
        },
    }


@router.post("/manual-login")
async def manual_login():
    snap = session_manager.snapshot()

    # This endpoint is Kotak's canonical login. If the backend is not on the
    # Kotak terminal (e.g. a persisted/auto dummy default), switch the active
    # terminal first so the real Kotak login actually runs instead of being
    # silently swallowed by the scheduler's dummy-mode safety gate.
    if active_terminal() != "kotak":
        try:
            switched = await switch_terminal("kotak")
            record_event(
                "auth", "MANUAL_LOGIN", "info",
                f"manual login switched active terminal to kotak "
                f"(changed={bool(switched.get('changed'))})",
            )
        except Exception as exc:
            log.warning("manual login: terminal switch to kotak failed (continuing): %s", exc)

    # 1) A valid session already exists → never login again (#7).
    if snap["active"] and kotak_session.session_active:
        record_event("auth", "MANUAL_LOGIN", "info",
                     "login skipped - central session already active")
        return _existing_payload(created=False)

    # 2) Central record says expired but the broker session is still alive:
    #    clear the stale physical session before starting a fresh one.
    if snap["status"] == "SESSION_EXPIRED" and kotak_session.session_active:
        try:
            await do_logout(source="manual")
        except Exception as exc:
            log.warning("Stale session cleanup failed (continuing): %s", exc)

    session_manager.mark_login_started()
    record_event("auth", "MANUAL_LOGIN", "info", "manual login requested")
    try:
        ok = await do_login(source="manual")
    except Exception as exc:
        session_manager.mark_login_failure(str(exc))
        record_event("auth", "LOGIN_FAILED", "error", str(exc))
        return JSONResponse(status_code=503, content=_failure_payload(str(exc)))

    if not ok:
        err = session_manager.snapshot().get("lastAuthError") or "login failed"
        record_event("auth", "LOGIN_FAILED", "error", err)
        return JSONResponse(status_code=503, content=_failure_payload(err))

    record_event("auth", "LOGIN_SUCCESS", "info", f"manual login ok mode={active_mode()}")
    return _existing_payload(created=True)


@router.post("/logout")
async def manual_logout():
    return await _logout_response()


@router.delete("/login")
async def manual_logout_via_login():
    """Accept the legacy logout path used by the UI (DELETE /api/auth/login).

    Performs the SAME real logout as POST /api/auth/logout — central session,
    Kotak broker session and WebSocket teardown are called exactly once.
    """
    return await _logout_response()


async def _logout_response() -> dict:
    if not kotak_session.session_active and not session_manager.is_active():
        snap = session_manager.snapshot()
        return {
            "ok": True,
            "message": "already logged out",
            "status": snap["status"],
            "last_logout": snap["lastLogout"],
        }

    try:
        ok = await do_logout(source="manual")
    except Exception as exc:
        session_manager.mark_logout("unknown")
        record_event("auth", "LOGOUT_FAILED", "error", str(exc))
        raise HTTPException(status_code=500, detail=str(exc))

    snap = session_manager.snapshot()
    record_event("auth", "LOGOUT_SUCCESS", "info", "manual logout")
    return {
        "ok": ok,
        "message": "LOGGED_OUT" if ok else "logout failed",
        "status": snap["status"],
        "mode": snap["mode"],
        "last_logout": snap["lastLogout"],
    }