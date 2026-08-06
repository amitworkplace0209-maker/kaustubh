"""Session and WebSocket management routes."""
from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, HTTPException

from auth import SDK_AVAILABLE, SDK_VERSION, kotak_session
from models import (
    HealthResponse,
    LoginResponse,
    LogoutResponse,
    SessionResponse,
    StatusResponse,
    SubscribeRequest,
    SubscribeResponse,
)
from scheduler import do_login, do_logout, get_scheduler_info
from websocket.ws_manager import ws_manager

router = APIRouter(tags=["session"])
_START_TIME = time.time()


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok" if SDK_AVAILABLE else "degraded",
        uptime_seconds=round(time.time() - _START_TIME, 2),
        sdk_loaded=SDK_AVAILABLE,
    )


@router.get("/status", response_model=StatusResponse)
def status() -> StatusResponse:
    ws = ws_manager.status()
    sched = get_scheduler_info()
    return StatusResponse(
        logged_in=kotak_session.logged_in,
        session_active=kotak_session.session_active,
        websocket_connected=ws["connected"],
        subscribed_symbols=ws["subscribed_symbols"],
        last_login_at=kotak_session.last_login_at,
        last_logout_at=kotak_session.last_logout_at,
        reconnect_count=ws["reconnect_count"],
        sdk_version=SDK_VERSION,
    )


@router.post("/login", response_model=LoginResponse)
async def login() -> LoginResponse:
    try:
        ok = await do_login()
        return LoginResponse(ok=ok, message="Login successful" if ok else "Login failed")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/logout", response_model=LogoutResponse)
async def logout() -> LogoutResponse:
    ok = await do_logout()
    return LogoutResponse(ok=ok, message="Logout successful" if ok else "Logout failed")


@router.get("/session", response_model=SessionResponse)
def session() -> SessionResponse:
    info = kotak_session.session_info()
    return SessionResponse(**info)


@router.post("/subscribe", response_model=SubscribeResponse)
async def subscribe(req: SubscribeRequest) -> SubscribeResponse:
    if not kotak_session.logged_in:
        raise HTTPException(status_code=403, detail="Not logged in")
    result = await ws_manager.subscribe(req.instrument_tokens)
    return SubscribeResponse(ok=result["ok"], message=result["message"], count=result["count"])


@router.post("/unsubscribe", response_model=SubscribeResponse)
async def unsubscribe(req: SubscribeRequest) -> SubscribeResponse:
    if not kotak_session.logged_in:
        raise HTTPException(status_code=403, detail="Not logged in")
    result = await ws_manager.unsubscribe(req.instrument_tokens)
    return SubscribeResponse(ok=result["ok"], message=result["message"], count=result["count"])
