"""Session and WebSocket management routes."""
from __future__ import annotations

import asyncio
import time
from datetime import datetime, timedelta, timezone

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
from scheduler import do_login, do_logout, get_scheduler_info, get_schedule, get_scheduler_state, get_scheduler_summary, get_scheduler_readiness, get_scheduler_phases
from ws_socket.ws_manager import ws_manager
from brokers.manager import active_mode, get_active_adapter
from services.session.session_manager import session_manager, MANUAL_SESSION_SECONDS
from services.event_history import last_event
from services.notification_center import emit_event as record_event
from services import market_calendar

router = APIRouter(tags=["session"])
_start_time = time.time()

from core.timezones import IST


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok" if SDK_AVAILABLE else "degraded",
        uptime_seconds=round(time.time() - _start_time, 2),
        sdk_loaded=SDK_AVAILABLE,
    )


@router.get("/api/health")
async def api_health():
    """Alias route: GET /api/health → same health shape as /health."""
    return {
        "status": "ok" if SDK_AVAILABLE else "degraded",
        "service": "kaustubh-python-service",
        "uptime_seconds": round(time.time() - _start_time, 2),
        "sdk_loaded": SDK_AVAILABLE,
        "mongo": None,
    }


@router.get("/status", response_model=StatusResponse)
def status() -> StatusResponse:
    ws = ws_manager.status()
    sched = get_scheduler_info()
    snap = session_manager.snapshot()
    return StatusResponse(
        logged_in=kotak_session.logged_in or snap["active"],
        session_active=snap["active"],
        websocket_connected=ws["connected"],
        subscribed_symbols=ws["subscribed_symbols"],
        last_login_at=snap["loginTime"] or kotak_session.last_login_at,
        last_logout_at=kotak_session.last_logout_at,
        reconnect_count=ws["reconnect_count"],
        sdk_version=SDK_VERSION,
    )


@router.get("/session/state")
def session_state():
    """Authoritative central session snapshot for EVERY phase."""
    snap = session_manager.snapshot()
    ws = ws_manager.status()
    sched = get_scheduler_info()
    snap["websocket"]["connected"] = ws["connected"]
    snap["websocket"]["subscribedSymbols"] = ws["subscribed_symbols"]
    snap["scheduler"] = {
        "running": sched["running"],
        "state": sched["state"],
    }
    return snap


@router.get("/session/history")
def session_history():
    """Logout/session history (honest reasons only)."""
    return {"history": session_manager.snapshot()["sessionHistory"]}


@router.get("/sessions")
def terminal_sessions():
    """Per-terminal session records — one independent record per terminal.

    Each record tracks: terminal_id, broker_id, session_id, session_status,
    login_status, created_at, expires_at, last_activity, connection_status.
    Terminal switching NEVER destroys another terminal's record.
    """
    snap = session_manager.snapshot()
    return {
        "ok": True,
        "activeTerminal": snap.get("mode"),
        "sessions": snap.get("sessions", {}),
    }


@router.post("/mode")
async def set_mode(mode: str = ""):
    """Switch the active broker mode (kotak | shoonya | dummy).

    A pure context switch: the previous terminal's session is NEVER destroyed.
    Switching back restores the previous terminal's session state. Only an
    explicit logout or real broker expiry terminates a terminal session.
    """
    mode = (mode or "").lower()
    if mode not in {"kotak", "shoonya", "dummy"}:
        raise HTTPException(400, "mode must be one of kotak|shoonya|dummy")

    current = active_mode()
    if current == mode and session_manager.is_active():
        return {"ok": True, "mode": mode, "message": "Already active"}

    # Pure context switch: session manager restores the target terminal's
    # own session record (from a prior login) into the active view.
    session_manager.set_mode(mode)
    record_event("session", "mode_switched", "info", f"{current} -> {mode}")
    return {"ok": True, "mode": mode, "message": f"Mode switched to {mode}"}


async def _login_impl() -> LoginResponse:
    session_manager.mark_login_started()
    try:
        if active_mode() == "dummy":
            adapter = get_active_adapter()
            ok = await adapter.login()
            return LoginResponse(ok=ok, message="Login successful" if ok else "Login failed")
        ok = await do_login(source="manual")
        if not ok:
            # do_login reports exhausted retries as False (not an exception);
            # without this the view set by mark_login_started above would sit
            # at LOGGING_IN forever and the UI would read "session inactive".
            session_manager.mark_login_failure("broker login failed")
        return LoginResponse(ok=ok, message="Login successful" if ok else "Login failed")
    except Exception as exc:
        session_manager.mark_login_failure(str(exc))
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/login", response_model=LoginResponse)
async def login() -> LoginResponse:
    return await _login_impl()


@router.post("/api/login", response_model=LoginResponse)
async def login_alias() -> LoginResponse:
    """POST /api/login — same REAL manual login as POST /login (phase2 proxy)."""
    return await _login_impl()


async def _logout_impl() -> LogoutResponse:
    try:
        if active_mode() == "dummy":
            adapter = get_active_adapter()
            ok = await adapter.logout("manual_logout")
            session_manager.mark_logout("manual_logout")
            return LogoutResponse(ok=ok, message="Logout successful" if ok else "Logout failed")
        ok = await do_logout(source="manual")
        return LogoutResponse(ok=ok, message="Logout successful" if ok else "Logout failed")
    except Exception as exc:
        session_manager.mark_logout("unknown")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/logout", response_model=LogoutResponse)
async def logout() -> LogoutResponse:
    return await _logout_impl()


@router.post("/api/logout", response_model=LogoutResponse)
async def logout_alias() -> LogoutResponse:
    """POST /api/logout — same REAL manual logout as POST /logout (phase2 proxy)."""
    return await _logout_impl()


@router.get("/session")
def session() -> dict:
    """Safe session intro — legacy fields + authoritative central snapshot."""
    snap = session_manager.snapshot()
    info = kotak_session.session_info()
    return {
        # ---- legacy SessionResponse shape (backward compatible) ----
        "logged_in": info["logged_in"] or snap["active"],
        "view_token_present": info["view_token_present"],
        "session_id_present": info["session_id_present"],
        "trade_token_present": info["trade_token_present"],
        "user_id": snap["userId"] or info["user_id"],
        "exchanges": info["exchanges"],
        "products": info["products"],
        "last_login_at": snap["loginTime"] or info["last_login_at"],
        "last_logout_at": info["last_logout_at"],
        "login_count": info["login_count"],
        # ---- authoritative central snapshot (new) ----
        "session_active": snap["active"],
        "state": snap["state"],
        "mode": snap["mode"],
        "broker": snap["broker"],
        "loginTime": snap["loginTime"],
        "expiresAt": snap["expiresAt"],
        "remainingSeconds": snap["remainingSeconds"],
        "remainingSecondsIso": snap["expiresAt"],
        # ---- per-terminal session records (§4 terminal isolation) ----
        "sessions": snap.get("sessions", {}),
        "terminalSessions": snap.get("terminalSessions", {}),
    }


@router.post("/subscribe", response_model=SubscribeResponse)
async def subscribe(req: SubscribeRequest) -> SubscribeResponse:
    if not kotak_session.logged_in:
        raise HTTPException(status_code=403, detail="Not logged in")
    # Phase 3: mirror explicit subscribes into the canonical store (best effort).
    try:
        from services.session.session_manager import session_manager
        for ref in (req.instrument_tokens or []):
            await session_manager.upsert_instrument({
                "exchange_segment": ref.get("exchange_segment") or "nse_cm",
                "instrument_token": str(ref.get("instrument_token") or ref.get("instrumentToken") or ""),
                "symbol": ref.get("symbol", ""),
            }, source="trading")
    except Exception:
        pass
    result = await ws_manager.subscribe(req.instrument_tokens)
    return SubscribeResponse(ok=result["ok"], message=result["message"], count=result["count"])


@router.post("/unsubscribe", response_model=SubscribeResponse)
async def unsubscribe(req: SubscribeRequest) -> SubscribeResponse:
    if not kotak_session.logged_in:
        raise HTTPException(status_code=403, detail="Not logged in")
    result = await ws_manager.unsubscribe(req.instrument_tokens)
    return SubscribeResponse(ok=result["ok"], message=result["message"], count=result["count"])


@router.get("/api/session/status")
async def session_status_endpoint() -> dict:
    """GET /api/session/status — authoritative, safe session overview.

    Real values only: timestamps come from the central session manager and the
    WebSocket manager; nothing is fabricated when a session is absent.
    """
    snap = session_manager.snapshot()
    ws = ws_manager.status()
    info = get_scheduler_info()
    last_logout = snap.get("lastLogout") or {}
    source = info.get("session_owner") or ("manual" if snap.get("active") else "none")
    return {
        "status": snap["status"],
        "state": snap["state"],
        "active": snap["active"],
        "source": source,
        "loginAt": snap["loginTime"],
        "expiresAt": snap["expiresAt"],
        "remainingSeconds": snap["remainingSeconds"],
        "userId": snap["userId"],
        "lastValidatedAt": snap["validatedAt"],
        "logoutAt": last_logout.get("logoutTime"),
        "logoutReason": last_logout.get("logoutReason"),
        "websocketState": ws["lifecycle_state"],
        "websocketConnected": ws["connected"],
        "schedulerState": info["state"],
        "mode": snap["mode"],
        "broker": snap["broker"] or "Kotak Neo",
        "reason": snap.get("stateMessage") or "",
        "timestamp": datetime.now(IST).isoformat(),
    }


@router.get("/api/scheduler/status")
async def scheduler_status_endpoint() -> dict:
    """GET /api/scheduler/status — scheduler state + market + next events.

    Backend is the source of truth for every countdown; windows are honest
    (NOT APPLICABLE on non-trading days) and only real schedule info is shown.
    """
    state = get_scheduler_state()
    schedule = get_schedule()
    last = last_event("scheduler", f"state:{state['state']}")
    last_ts = last.get("ts") if last else None
    if isinstance(last_ts, datetime):
        if last_ts.tzinfo is None:
            last_ts = last_ts.replace(tzinfo=IST)
        last_ts = last_ts.astimezone(IST).isoformat()
    return {
        "schedulerState": state["state"],
        "stateSince": state["state_since"],
        "phase": state.get("phase"),
        "phaseSince": state.get("phase_since"),
        "nextPhase": state.get("next_phase"),
        "nextPhaseAt": state.get("next_phase_at"),
        "readiness": state.get("readiness"),
        "sessionOwner": state["session_owner"],
        "inLoginWindow": state["in_login_window"] if state.get("login_window_applicable") else None,
        "inWsWindow": state["in_ws_window"] if state.get("ws_window_applicable") else None,
        "marketState": schedule["today_trading_day"],
        "marketStatus": market_calendar.market_status(datetime.now(IST)),
        "marketSession": market_calendar.market_session(datetime.now(IST)),
        "marketClosureReason": market_calendar.snapshot().get("closure_reason"),
        "isTradingDay": state["is_trading_day"],
        "currentTime": schedule["now_ist"],
        "nextLogin": schedule["next_login_time"],
        "nextWebSocketConnect": schedule["next_ws_connect_time"],
        "nextWebSocketDisconnect": schedule["next_ws_disconnect_time"],
        "nextLogout": schedule["next_logout_time"],
        "nextEvent": schedule["next_event"],
        "nextEventAt": schedule["next_event_at"],
        "lastEvent": last.get("event") if last else None,
        "lastEventTime": last_ts,
        "lastReason": last.get("message") if last else None,
        "todaySchedule": {
            "login": schedule["today_login_time"],
            "tickCollection": schedule["today_tick_collection_time"],
            "wsConnect": schedule["today_ws_connect_time"],
            "wsDisconnect": schedule["today_ws_disconnect_time"],
            "logout": schedule["today_logout_time"],
            "tradingDay": schedule["today_trading_day"],
        },
        "todayPhases": schedule.get("today_phase_times"),
        "nextTickCollection": schedule["next_tick_collection_time"],
        "enabledBrokers": state.get("enabled_brokers", []),
        "brokers": state.get("brokers", {}),
        "timestamp": datetime.now(IST).isoformat(),
    }


@router.get("/api/scheduler/readiness")
async def scheduler_readiness_endpoint() -> dict:
    """GET /api/scheduler/readiness — engine readiness + current phase.

    Backend-owned report (spec §6): each critical component is probed live; a
    critical failure surfaces overall=NOT_READY so the UI never implies a
    healthy system. Phase + next phase boundary come from the same source.
    """
    state = get_scheduler_state()
    return {
        "phase": state.get("phase"),
        "phaseSince": state.get("phase_since"),
        "nextPhase": state.get("next_phase"),
        "nextPhaseAt": state.get("next_phase_at"),
        "readiness": get_scheduler_readiness(),
        "phases": get_scheduler_phases(),
        "timestamp": datetime.now(IST).isoformat(),
    }


@router.get("/api/scheduler/summary")
async def scheduler_summary_endpoint() -> dict:
    """GET /api/scheduler/summary — authoritative persisted scheduler summary.

    Single backend source of truth for the scheduler dashboard (Phase 22/53).
    ``today`` counters, ``last_event`` and ``executions`` are computed from
    MongoDB ledger records only; ``next_event`` comes from the server IST clock
    + the real market calendar. The frontend merely reads this.
    """
    return await get_scheduler_summary()


@router.get("/api/scheduler/history")
async def scheduler_history_endpoint(
    limit: str | None = None,
    business_date: str = "",
) -> dict:
    """GET /api/scheduler/history — persisted scheduler run ledger.

    Newest-first execution history from MongoDB ``scheduler_runs``, optionally
    filtered by a ``business_date`` (YYYY-MM-DD). ``limit`` is optional and
    defaults to 50 (an empty value never 422s).
    """
    from scheduler import get_scheduler_history
    if business_date:
        return await get_scheduler_history(limit=int(limit) if limit else 50, business_date=business_date)
    return await get_scheduler_history(limit=int(limit) if limit else 50)


@router.get("/api/scheduler/runs")
async def scheduler_runs_endpoint(
    business_date: str = "",
    job_id: str = "",
    status: str = "",
    trigger: str = "",
    schedule_id: str = "",
    search: str = "",
    failed_only: bool = False,
    catch_up_only: bool = False,
    sort: str = "scheduled_at",
    order: str = "desc",
    page: int = 1,
    page_size: int = 20,
) -> dict:
    """GET /api/scheduler/runs — paginated, filterable scheduler-run ledger.

    Real persisted ``scheduler_runs`` records only. ``status`` accepts a
    comma-separated UI vocabulary (PENDING, DUE, RUNNING, COMPLETED, FAILED,
    RETRYING, WAITING, ALREADY_SATISFIED, MISSED_SCHEDULE_CATCHUP, SKIPPED)
    and is expanded server-side onto the canonical backend states. ``sort`` is
    one of scheduled_at / updated_at / started_at / completed_at / failed_at /
    job_id / status / trigger / business_date; ``order`` is asc|desc.
    """
    from scheduler import get_scheduler_runs
    return await get_scheduler_runs(
        business_date=business_date,
        job_id=job_id,
        status=status,
        trigger=trigger,
        schedule_id=schedule_id,
        search=search,
        failed_only=failed_only,
        catch_up_only=catch_up_only,
        sort=sort,
        order=order,
        page=page,
        page_size=page_size,
    )


@router.get("/api/scheduler/runs/{run_id}")
async def scheduler_run_endpoint(run_id: str) -> dict:
    """GET /api/scheduler/runs/{run_id} — one run by its execution_id.

    Returns the full real record (timestamps, attempt, reason, error, trigger)
    so the Runs UI can show a detail view without fabricating anything.
    """
    from scheduler import get_scheduler_run
    run = await get_scheduler_run(run_id)
    if run is None:
        raise HTTPException(
            status_code=404,
            detail=f"No scheduler run found for run_id={run_id}",
        )
    return {"run": run}

