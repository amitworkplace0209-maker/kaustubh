"""WebSocket Gateway (WS#3 + WS#4) — the backend ⇄ frontend realtime bridge.

One persistent, authenticated WebSocket per operator frontend. It owns the
master-architecture frontend sockets:

  WS#3: BACKEND → FRONTEND  realtime data/events (market, orders, positions,
        P&L, risk, notifications, system state) via Connection Manager
  WS#4: FRONTEND → BACKEND  commands/control (place/cancel/modify/square-off,
        watchlist/target actions) via Command Router → backend engines

Endpoints:
  GET  /api/realtime/token      issue a gateway token (operator JWT)
  GET  /api/realtime/status     gateway diagnostics (WS#3)
  GET  /api/realtime/sessions   live gateway sessions
  GET  /api/realtime/order-feed health/passthrough for WS#2 diagnostics
  WS   /ws/realtime             the bidirectional envelope stream (WS#3 down, WS#4 up)

Auth model:
  * Browser WebSockets cannot set custom headers, so the token is passed as a
    query parameter: ``wss://.../ws/realtime?token=<JWT>``.
  * When ``APP_PASSWORD`` is configured (security on) a valid operator JWT is
    required, otherwise the connection is closed with a 4401 policy frame.
  * When ``APP_PASSWORD`` is empty (default local single-operator dev) the
    gateway accepts an anonymous connection so the realtime layer works out of
    the box; ``GET /api/realtime/token`` still returns a token to pass along.
    With ``APP_PASSWORD`` set, that endpoint REQUIRES the operator JWT and
    answers 401 — an anonymous bootstrap token would defeat the 4401 handshake
    check below, so there is deliberately no anonymous fallback in secure mode.

Inbound control frames (JSON) — WS#4 command pipeline::

    {"action": "ping"}
    {"action": "auth", "token": "..."}
    {"action": "subscribe",  "request_id": "...",
     "channels": [{"channel": "watchlist", "instruments": [...tokens...]},
                  {"channel": "notifications"}]}
    {"action": "unsubscribe","request_id": "...", "channels": [...]}
    {"action": "snapshot",   "request_id": "..."}
    # WS#4 trading commands (frontend → backend, routed to Order Engine)
    {"action": "place_order", "request_id": "...", "order": {...}, "correlation_id": "..."}
    {"action": "cancel_order","request_id": "...", "order_id": "...", "correlation_id": "..."}
    {"action": "modify_order","request_id": "...", "order_id": "...", "order": {...}}
    {"action": "square_off",  "request_id": "...", "position": {...}}

Outbound frames use the shared envelope (``type`` / ``event_id`` /
``timestamp`` / ``sequence`` / ``channel`` / ``symbol`` / ``schema_version`` /
``data``) for every realtime event (market.tick, order.*, trade.fill,
position.*, notification.new, system.status, connection.status, ...).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid

from fastapi import APIRouter, HTTPException, Path, Query, Request, WebSocket, WebSocketDisconnect

from config.settings import settings
from connection_engine import connection_engine, client as client_mod
from connection_engine.channels import MARKET_CHANNELS, STATE_CHANNELS
from connection_engine.connection_engine import ENVELOPE_VERSION, SOURCE_GATEWAY
from services.jwt_auth import issue_token, read_token, verify_token
from ws_socket.engine.canonical import SCHEMA_VERSION

router = APIRouter(tags=["realtime"])
logger = logging.getLogger("ws_gateway")

HEARTBEAT_INTERVAL_S = client_mod.HEARTBEAT_INTERVAL_S


def _now_iso():
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _conn_id() -> str:
    """Short per-connection-attempt identifier (diagnostics / duplicate busting)."""
    return uuid.uuid4().hex[:8]


def _bad(message: str) -> dict:
    return {"ok": False, "error": message}


def _client_ip(websocket: WebSocket) -> str:
    try:
        host, _port = websocket.client.host, websocket.client.port
        return f"{host}:{_port}"
    except Exception:
        return "unknown"


# --------------------------------------------------------------------------- #
# Auth helpers
# --------------------------------------------------------------------------- #
def _security_enabled() -> bool:
    """Security is ON when an operator password is configured."""
    return bool(settings.app_password)


def _require_operator_jwt(request: Request) -> str:
    token = read_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="Unauthorized: operator token required")
    try:
        payload = verify_token(token)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=f"Unauthorized: {exc}") from exc
    return str(payload.get("sub") or "unknown")


# --------------------------------------------------------------------------- #
# REST: token + diagnostics
# --------------------------------------------------------------------------- #
@router.get("/api/realtime/token")
async def get_realtime_token(request: Request):
    """Issue the gateway token used by ``/ws/realtime?token=...``.

    With ``APP_PASSWORD`` configured this REQUIRES a valid operator JWT
    (``Authorization: Bearer`` / ``x-kaustubh-token``) and answers 401
    otherwise. In the default local dev build (no password) any caller may
    receive an anonymous token.

    The previous "bootstrap" fallback issued a valid gateway token to any
    unauthenticated caller even with security enabled. That defeated the
    ``4401`` handshake check below — the socket accepted the anonymous token —
    and it was the reason ``_require_operator_jwt`` was dead code. The web
    client already treats 401 as "ask the operator to sign in"
    (``lib/realtime-ws.ts``), so this is the flow it expects.
    """
    if _security_enabled():
        username = _require_operator_jwt(request)
    else:
        username = request.query_params.get("username") or "anonymous"
    token = issue_token(username)
    return {
        "ok": True,
        "token": token,
        "username": username,
        "expiresInSeconds": settings.jwt_ttl_seconds,
        "secure": _security_enabled(),
        "endpoint": "/ws/realtime",
    }


@router.get("/api/realtime/status")
async def realtime_status():
    return {"ok": True, "data": connection_engine.status()}


@router.get("/api/realtime/sessions")
async def realtime_sessions():
    return {"ok": True, "data": connection_engine.sessions()}


@router.get("/api/realtime/fields")
async def realtime_fields(fields: str = "", token: str = ""):
    """Control-plane field catalogue / availability resolver (§10/§14).

    Without ``fields`` this returns the catalogue of fields the real upstream
    sources can provide. With ``fields`` (comma-separated, optional ``token``)
    it resolves each requested field to AVAILABLE / UNAVAILABLE / PARTIAL /
    NOT_READY / SOURCE_ERROR — never fabricating a value.
    """
    from connection_engine import field_requirements as field_req

    requested = [f.strip() for f in fields.split(",") if f.strip()]
    if requested:
        feature_output = connection_engine._feature_output_for(token) if token else None
        result = field_req.resolve_requirements(
            requested,
            feature_output=feature_output,
            feature_source_ok=connection_engine._feature_source_ok(),
        )
        return {"ok": True, "data": result}
    return {"ok": True, "data": field_req.available_fields()}


@router.get("/api/realtime/health")
async def realtime_health():
    """Connection Manager health (HEALTHY/DEGRADED/NO_DATA/OVERLOADED/ERROR/STOPPED)."""
    return {"ok": True, "data": connection_engine.health()}


@router.get("/api/realtime/events")
async def realtime_events(
    limit: int = Query(200, ge=1, le=500),
    since: float = Query(0.0, ge=0.0),
    event_type: str = Query(""),
    level: str = Query(""),
    channel: str = Query(""),
):
    """Bounded event inspector — real gateway events (never fabricated)."""
    events = connection_engine.recent_events(
        limit=limit,
        since_epoch=since or None,
        event_type=event_type or "",
        level=level or "",
        channel=channel or "",
    )
    return {"ok": True, "data": {"events": events, "total": len(events), "limit": limit}}


@router.get("/api/realtime/connections/history")
async def realtime_connection_history(limit: int = Query(50, ge=1, le=250)):
    """§29 Connection history — real persisted attach/detach ledger.

    Every gateway session now lands in a bounded MongoDB collection
    (attached state, detach reason, duration, delivered frames, wire bytes).
    This endpoint reads it back with an honest live summary — the §29 gap is
    measured, not filled with a placeholder.

    NOTE: declared BEFORE ``/{connection_id}`` so FastAPI does not capture the
    literal ``history`` as a connection id (route order is match order).
    """
    from connection_engine.connection_engine import connection_history_rows
    return {"ok": True, "data": await connection_history_rows(limit=limit)}


@router.get("/api/realtime/connections/{connection_id}")
async def realtime_connection(connection_id: str = Path(...)):
    """One live connection registry record (control-plane diagnostics)."""
    for record in connection_engine.session_records():
        if record.get("connectionId") == connection_id:
            return {"ok": True, "data": record}
    return _bad(f"connection {connection_id} not found")


@router.get("/api/realtime/config")
async def realtime_config():
    """Read-only live configuration of the Connection Manager."""
    return {"ok": True, "data": connection_engine.config()}


@router.get("/api/realtime/order-feed")
async def realtime_order_feed():
    """WS#2 diagnostics — order/position feed health (real values only)."""
    try:
        from ws_socket.order_feed_manager import order_feed_manager
        return {"ok": True, "data": order_feed_manager.status()}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@router.get("/api/realtime/architecture")
async def realtime_architecture():
    """Four-WebSocket ownership matrix (truthful, from code)."""
    try:
        from ws_socket.ws_manager import ws_manager
        from ws_socket.order_feed_manager import order_feed_manager
        ws1 = ws_manager.status()
        of2 = order_feed_manager.status()
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    cm = connection_engine.status()
    return {
        "ok": True,
        "data": {
            "WS#1": {"direction": "Kotak → Backend", "owner": "WebSocketManager/WebSocketEngine", "purpose": "Market Data (SFeed)", "connected": ws1.get("connected"), "state": ws1.get("supervisor_state")},
            "WS#2": {"direction": "Kotak → Backend", "owner": "OrderFeedManager", "purpose": "OrderUpdate/PositionUpdate", "connected": of2.get("connected"), "state": of2.get("state")},
            "WS#3": {"direction": "Backend → Frontend", "owner": "ConnectionManager/connection_engine", "purpose": "Realtime events", "sessions": cm.get("sessions"), "framesRouted": cm.get("framesRouted")},
            "WS#4": {"direction": "Frontend → Backend", "owner": "ConnectionManager/ws_gateway command router", "purpose": "Commands/control", "endpoint": "/ws/realtime"},
            "REST": {"direction": "Frontend ↔ Backend", "purpose": "Search, snapshots, previews"},
            "Broker REST": {"direction": "Backend ↔ Kotak", "purpose": "Order actions, authoritative snapshots"},
            "Event Bus": {"direction": "Backend internal", "purpose": "Engine-to-engine distribution", "implementation": "services.engine_event_bus"},
        },
    }


# --------------------------------------------------------------------------- #
# WebSocket endpoint
# --------------------------------------------------------------------------- #
def _frame(session, event_type: str, *, channel: str = "", data: dict | None = None,
           correlation_id: str = "") -> dict:
    return {
        "type": event_type,
        "event_id": f"{session.connection_id}:{session.next_sequence()}",
        "timestamp": _now_iso(),
        "sequence": session.sequence,
        "channel": channel,
        "symbol": "",
        "instrument_token": "",
        "exchange_segment": "",
        "schema_version": SCHEMA_VERSION,
        "version": ENVELOPE_VERSION,
        "source": SOURCE_GATEWAY,
        "correlation_id": correlation_id or "",
        "data": data or {},
    }


def deliver_frame(session, frame: dict, *, ping: bool = False) -> str:
    """Serialize one frame and record its REAL wire metrics on the session.

    The returned string is exactly what the writer hands to the socket (compact
    JSON, sent via ``send_text``). The internal ``_cm_enq`` enqueue stamp is
    popped here so it never reaches the wire, and its delta becomes the REAL
    enqueue→delivery latency (spec §51). Ping frames bypass the outbox, so they
    contribute bytes only — latency samples are never invented.
    """
    enq = frame.pop("_cm_enq", None) if isinstance(frame, dict) else None
    payload = json.dumps(frame, default=str)
    latency_ms = None
    if enq is not None and not ping:
        try:
            latency_ms = max((time.monotonic() - float(enq)) * 1000.0, 0.0)
        except Exception:
            latency_ms = None
    session.record_delivery(len(payload.encode("utf-8")), latency_ms)
    return payload


@router.websocket("/ws/realtime")
async def realtime_ws(websocket: WebSocket, token: str = "", access_token: str = ""):
    conn = _conn_id()
    started = time.time()
    await websocket.accept()
    provided = (token or access_token or "").strip()
    logger.info(
        "[WS] connection attempt conn=%s client=%s token_present=%s",
        conn, _client_ip(websocket), bool(provided),
    )

    if provided:
        try:
            payload = verify_token(provided)
            username = str(payload.get("sub") or "anonymous")
        except ValueError:
            username = ""
    else:
        username = "anonymous" if not _security_enabled() else ""

    if not username:
        try:
            await websocket.send_json({
                "type": "error.event",
                "code": "401",
                "message": "Unauthorized: a valid gateway token is required (?token=<JWT>)",
                "schema_version": SCHEMA_VERSION,
            })
            await websocket.close(code=4401)
        except Exception:
            pass
        logger.warning("[WS] authentication failed conn=%s reason=invalid_or_missing_token", conn)
        return

    logger.info("[WS] authenticated conn=%s username=%s", conn, username)

    session = connection_engine.create_session(username)
    await connection_engine.attach(session)
    logger.info(
        "[WS] connected conn=%s session=%s username=%s elapsed_ms=%.0f",
        conn, session.connection_id, session.username, (time.time() - started) * 1000,
    )

    welcome = {
        "type": "welcome",
        "event_id": f"{session.connection_id}:{session.next_sequence()}",
        "timestamp": _now_iso(),
        "sequence": session.sequence,
        "channel": "system",
        "symbol": "",
        "schema_version": SCHEMA_VERSION,
        "version": ENVELOPE_VERSION,
        "source": SOURCE_GATEWAY,
        "correlation_id": "",
        "data": {
            "connectionId": session.connection_id,
            "username": username,
            "serverTime": _now_iso(),
            "heartbeatIntervalS": HEARTBEAT_INTERVAL_S,
            "channels": {
                "market": sorted(k for k in MARKET_CHANNELS),
                "state": sorted(k for k in STATE_CHANNELS),
            },
        },
    }
    session.outbox.put(welcome, critical=True)

    async def writer():
        while not session.closed:
            frame = await session.outbox.get(timeout=HEARTBEAT_INTERVAL_S)
            if frame is None:
                try:
                    await websocket.send_text(deliver_frame(session, _frame(session, "ping"), ping=True))
                except Exception as exc:
                    session.record_error("writer_ping_failed", str(exc))
                    logger.info("[WS] error conn=%s session=%s writer=%s", conn, session.connection_id, exc)
                    break
                continue
            try:
                await websocket.send_text(deliver_frame(session, frame))
            except Exception as exc:
                session.record_error("writer_send_failed", str(exc))
                logger.info("[WS] error conn=%s session=%s writer=%s", conn, session.connection_id, exc)
                break

    async def reader():
        reason = "reader ended"
        try:
            while True:
                raw = await websocket.receive_text()
                session.mark_activity()
                try:
                    message = json.loads(raw)
                except Exception:
                    continue
                await _handle_message(session, websocket, message)
        except WebSocketDisconnect:
            reason = "client WebSocketDisconnect"
        except Exception as exc:
            reason = f"reader error: {exc}"
            logger.info("[WS] error conn=%s session=%s reader=%s", conn, session.connection_id, exc)
        finally:
            # The REAL terminal cause, recorded BEFORE detach() writes the §29
            # history row — the history row carries this as its reason.
            session.transition(client_mod.DISCONNECTING, reason)
            session.closed = True
            session.outbox.put({"type": "connection.closed"}, critical=True)

    writer_task = asyncio.create_task(writer())
    reader_task = asyncio.create_task(reader())
    session.attach_task(writer_task)
    session.attach_task(reader_task)
    try:
        await writer_task
    finally:
        await connection_engine.detach(session.connection_id)
        if not reader_task.done():
            reader_task.cancel()
        logger.info("[WS] disconnected conn=%s session=%s", conn, session.connection_id)


async def _handle_message(session, websocket: WebSocket, message: dict) -> None:
    action = str(message.get("action") or message.get("type") or "")
    request_id = str(message.get("request_id") or message.get("requestId") or "")
    correlation_id = str(message.get("correlation_id") or message.get("correlationId") or request_id or "")

    if action in ("ping", "heartbeat"):
        session.outbox.put(_frame(session, "pong", channel="system",
                                  data={"requestId": request_id}, correlation_id=request_id))
        return
    if action == "auth":
        provided = (message.get("token") or "").strip()
        try:
            payload = verify_token(provided) if provided else None
        except ValueError:
            payload = None
        if payload:
            session.username = str(payload.get("sub") or session.username)
            session.outbox.put(_frame(session, "auth.ok", channel="system",
                                      data={"username": session.username}, correlation_id=request_id))
        else:
            session.outbox.put(_frame(session, "error.event", channel="system",
                                      data={"requestId": request_id, "code": "401", "message": "invalid token"},
                                      correlation_id=request_id))
        return
    if action == "subscribe":
        result = await connection_engine.subscribe(session, message.get("channels") or [])
        session.outbox.put(_frame(session, "subscription.ack", channel="system",
                                  data={"requestId": request_id, "results": result["results"], "errors": result["errors"], "sync": result["sync"]},
                                  correlation_id=request_id),
                           critical=True)
        return
    if action == "unsubscribe":
        result = await connection_engine.unsubscribe(session, message.get("channels") or [])
        session.outbox.put(_frame(session, "subscription.ack", channel="system",
                                  data={"requestId": request_id, "results": result["results"]},
                                  correlation_id=request_id),
                           critical=True)
        return
    if action == "snapshot":
        await connection_engine.request_snapshot(session, request_id)
        return

    # ---- WS#4 Command Router (Frontend → Backend) ----
    # Trading commands are routed into backend engines, NEVER directly to Kotak.
    # Order placement uses broker REST via Order Engine → Risk → Audit → Broker Terminal.
    if action in ("place_order", "placeOrder", "order.place", "order_place"):
        await _handle_place_order(session, message, request_id, correlation_id)
        return
    if action in ("cancel_order", "cancelOrder", "order.cancel", "order_cancel"):
        await _handle_cancel_order(session, message, request_id, correlation_id)
        return
    if action in ("modify_order", "modifyOrder", "order.modify", "order_modify"):
        await _handle_modify_order(session, message, request_id, correlation_id)
        return
    if action in ("square_off", "squareOff", "square-off", "position.square_off"):
        await _handle_square_off(session, message, request_id, correlation_id)
        return
    if action in ("watchlist_add", "watchlist_remove", "target_set", "target_remove"):
        await _handle_generic_command(session, action, message, request_id, correlation_id)
        return

    # Market Watch commands (doc §16/§18/§19): show_more / select / pin /
    # unpin / display intent. The gateway only routes; the Market Watch Engine
    # validates and owns the rules.
    if action.startswith("market_watch."):
        await _handle_market_watch_command(session, action, message, request_id, correlation_id)
        return

    session.outbox.put(_frame(session, "error.event", channel="system",
                              data={"requestId": request_id, "code": "400", "message": f"unknown action: {action}"},
                              correlation_id=request_id),
                       critical=True)


# ------------------------------------------------------------------ #
# WS#4 command handlers — each validates, authorizes, audits
# ------------------------------------------------------------------ #

async def _handle_place_order(session, message: dict, request_id: str, correlation_id: str) -> None:
    """Frontend → WS#4 → Order Engine (Risk → Margin → Audit → Broker REST)."""
    import logging as _lg
    _lg.getLogger("ws_gateway").info("[WS#4] place_order request_id=%s correlation=%s user=%s", request_id, correlation_id, session.username)
    try:
        from services.session.session_manager import session_manager
        session_manager.auth_gate("trading")
    except Exception as exc:
        session.outbox.put(_frame(session, "order.ack", channel="orders",
                                  data={"requestId": request_id, "correlationId": correlation_id, "ok": False, "error": str(exc), "code": "UNAUTHORIZED"},
                                  correlation_id=correlation_id))
        return
    order = message.get("order") or message.get("data") or message.get("payload") or {}
    if not isinstance(order, dict) or not order:
        session.outbox.put(_frame(session, "order.ack", channel="orders",
                                  data={"requestId": request_id, "correlationId": correlation_id, "ok": False, "error": "order payload required"},
                                  correlation_id=correlation_id))
        return
    # Idempotency: correlation_id dedup (Phase 11)
    try:
        from services.command_idempotency import get_idempotency_store
        store = get_idempotency_store()
        existing = store.check("kotak", correlation_id, "place_order", order)
        if existing is not None:
            if existing.get("conflict"):
                session.outbox.put(_frame(session, "order.ack", channel="orders",
                                          data={"requestId": request_id, "correlationId": correlation_id, "ok": False, "error": existing.get("message"), "code": "IDEMPOTENCY_CONFLICT"},
                                          correlation_id=correlation_id))
                return
            state = existing.get("state")
            if state in ("PENDING",):
                session.outbox.put(_frame(session, "order.ack", channel="orders",
                                          data={"requestId": request_id, "correlationId": correlation_id, "ok": False, "error": "duplicate — still pending", "code": "PENDING", "state": state},
                                          correlation_id=correlation_id))
                return
            ok = bool(existing.get("result", {}).get("ok") and existing.get("result", {}).get("accepted"))
            session.outbox.put(_frame(session, "order.ack", channel="orders",
                                      data={"requestId": request_id, "correlationId": correlation_id, "ok": ok, "result": existing.get("result"), "state": state, "replayed": True},
                                      correlation_id=correlation_id))
            return
        try:
            snap = session_manager.snapshot()
            sid = snap.get("sessionId")
        except Exception:
            sid = None
        store.create_pending("kotak", correlation_id, "place_order", order, session_id=sid)
    except Exception as exc:
        _lg.getLogger("ws_gateway").warning("[WS#4] idempotency check failed (non-fatal): %s", exc)
    order = {**order, "correlation_id": correlation_id, "request_id": request_id, "ws_session": session.connection_id}
    try:
        from core.engines.order_engine import place as order_place
        result = await order_place("kotak", order)
        ok = bool(result.get("ok") and result.get("accepted"))
        try:
            from services.command_idempotency import get_idempotency_store
            get_idempotency_store().complete("kotak", correlation_id, "ACCEPTED" if ok else "REJECTED", result=result)
        except Exception:
            pass
        session.outbox.put(_frame(session, "order.ack", channel="orders",
                                  data={"requestId": request_id, "correlationId": correlation_id, "ok": ok, "result": result},
                                  correlation_id=correlation_id))
        try:
            from services.state_store import get_state_store
            await get_state_store().publish({"type": "order.ack", "channel": "orders", "timestamp": _now_iso(), "data": {"requestId": request_id, "correlationId": correlation_id, "order": order, "result": result}})
        except Exception:
            pass
    except Exception as exc:
        try:
            from services.command_idempotency import get_idempotency_store
            get_idempotency_store().complete("kotak", correlation_id, "REJECTED", error=str(exc)[:500])
        except Exception:
            pass
        session.outbox.put(_frame(session, "order.ack", channel="orders",
                                  data={"requestId": request_id, "correlationId": correlation_id, "ok": False, "error": str(exc)[:500]},
                                  correlation_id=correlation_id))


async def _handle_cancel_order(session, message: dict, request_id: str, correlation_id: str) -> None:
    order_id = str(message.get("order_id") or message.get("orderId") or message.get("orderID") or "").strip()
    if not order_id:
        session.outbox.put(_frame(session, "order.ack", channel="orders",
                                  data={"requestId": request_id, "correlationId": correlation_id, "ok": False, "error": "order_id required"},
                                  correlation_id=correlation_id))
        return
    try:
        from core.engines.order_engine import cancel as order_cancel
        result = await order_cancel("kotak", order_id)
        ok = bool(result.get("ok"))
        session.outbox.put(_frame(session, "order.ack", channel="orders",
                                  data={"requestId": request_id, "correlationId": correlation_id, "ok": ok, "result": result, "orderId": order_id},
                                  correlation_id=correlation_id))
    except Exception as exc:
        session.outbox.put(_frame(session, "order.ack", channel="orders",
                                  data={"requestId": request_id, "correlationId": correlation_id, "ok": False, "error": str(exc)[:500]},
                                  correlation_id=correlation_id))


async def _handle_modify_order(session, message: dict, request_id: str, correlation_id: str) -> None:
    order_id = str(message.get("order_id") or message.get("orderId") or "").strip()
    order = message.get("order") or message.get("data") or {}
    if not order_id:
        session.outbox.put(_frame(session, "order.ack", channel="orders",
                                  data={"requestId": request_id, "correlationId": correlation_id, "ok": False, "error": "order_id required"},
                                  correlation_id=correlation_id))
        return
    try:
        from core.engines.order_engine import modify as order_modify
        result = await order_modify("kotak", order_id, order if isinstance(order, dict) else {})
        ok = bool(result.get("ok"))
        session.outbox.put(_frame(session, "order.ack", channel="orders",
                                  data={"requestId": request_id, "correlationId": correlation_id, "ok": ok, "result": result},
                                  correlation_id=correlation_id))
    except Exception as exc:
        session.outbox.put(_frame(session, "order.ack", channel="orders",
                                  data={"requestId": request_id, "correlationId": correlation_id, "ok": False, "error": str(exc)[:500]},
                                  correlation_id=correlation_id))


async def _handle_square_off(session, message: dict, request_id: str, correlation_id: str) -> None:
    position = message.get("position") or message.get("data") or {}
    if not isinstance(position, dict) or not position:
        session.outbox.put(_frame(session, "square_off.ack", channel="positions",
                                  data={"requestId": request_id, "correlationId": correlation_id, "ok": False, "error": "position payload required"},
                                  correlation_id=correlation_id))
        return
    try:
        from core.engines.order_engine import square_off as do_square
        result = await do_square("kotak", position)
        ok = bool(result.get("ok"))
        session.outbox.put(_frame(session, "square_off.ack", channel="positions",
                                  data={"requestId": request_id, "correlationId": correlation_id, "ok": ok, "result": result},
                                  correlation_id=correlation_id))
    except Exception as exc:
        session.outbox.put(_frame(session, "square_off.ack", channel="positions",
                                  data={"requestId": request_id, "correlationId": correlation_id, "ok": False, "error": str(exc)[:500]},
                                  correlation_id=correlation_id))


async def _handle_market_watch_command(session, action: str, message: dict, request_id: str, correlation_id: str) -> None:
    """WS#4 -> Connection Manager -> Market Watch Engine (doc §16/§19).

    Market Watch is the intelligence owner: this handler only forwards the
    validated envelope (request_id / correlation_id / channel) and returns
    whatever event the engine produced. A failure answers with the engine's
    ``market_watch.error`` so the frontend always gets a correlated response.
    """
    import logging as _lg

    _lg.getLogger("ws_gateway").info(
        "[WS#4] market watch command=%s request_id=%s user=%s", action, request_id, session.username,
    )
    try:
        from services.market_watch_engine import market_watch_engine

        payload = dict(message)
        payload["type"] = action
        payload.setdefault("request_id", request_id)
        event = await market_watch_engine.handle_ws_command(payload)
    except Exception as exc:
        _lg.getLogger("ws_gateway").warning("[WS#4] market watch command failed: %s", exc)
        session.outbox.put(_frame(session, "error.event", channel="system",
                                  data={"requestId": request_id, "correlationId": correlation_id,
                                        "code": "500", "message": str(exc)[:300]},
                                  correlation_id=correlation_id),
                           critical=True)
        return
    if event is None:
        # No response event: still acknowledge the correlation id.
        session.outbox.put(_frame(session, f"{action}.ack", channel="market_watch",
                                  data={"requestId": request_id, "correlationId": correlation_id, "ok": True,
                                        "action": action},
                                  correlation_id=correlation_id))
        return
    if event.get("type") == "market_watch.error":
        session.outbox.put(_frame(session, "error.event", channel="system",
                                  data={"requestId": request_id, "correlationId": correlation_id,
                                        "code": str(event.get("code") or "400"),
                                        "message": event.get("message")},
                                  correlation_id=correlation_id),
                           critical=True)
        return
    # Snapshot-shaped responses go straight back to the requesting session on the
    # market_watch channel (and are also published to every subscriber below).
    session.outbox.put(_frame(session, str(event.get("type") or "market_watch.status"),
                              channel="market_watch", data=event,
                              correlation_id=correlation_id or request_id))
    try:
        from services.event_bus import get_event_bus

        await get_event_bus().publish(event)
    except Exception as exc:
        _lg.getLogger("ws_gateway").debug("[WS#4] market watch broadcast failed: %s", exc)


async def _handle_generic_command(session, action: str, message: dict, request_id: str, correlation_id: str) -> None:
    """Route watchlist/target realtime controls to the owning engine.

    Acknowledgements are REAL: the watchlist engine's own result is echoed back
    (including its ``ok: False`` outcomes like "already exists"), and an action
    with no owning engine answers a CLEAR unsupported error instead of the
    previous silent ``ok=True`` lie.
    """
    data = message.get("data") or message.get("payload") or message

    def ack(ok: bool, payload: dict) -> None:
        session.outbox.put(_frame(session, f"{action}.ack", channel="system",
                                  data={"requestId": request_id, "correlationId": correlation_id,
                                        "ok": ok, "action": action, **payload},
                                  correlation_id=correlation_id),
                           critical=True)

    try:
        if action.startswith("watchlist"):
            from services.watchlist_engine import watchlist_engine, DEFAULT_WATCHLIST_ID

            watchlist_id = str(data.get("watchlist_id") or data.get("watchlistId") or DEFAULT_WATCHLIST_ID)
            symbol = str(data.get("symbol") or data.get("tradingSymbol") or "").strip()
            token = str(data.get("token") or data.get("instrumentToken") or "").strip()
            metadata = {
                key: data.get(key)
                for key in ("name", "companyName", "exchange", "exchangeSegment", "tradingSymbol", "isin")
                if data.get(key)
            }
            if action == "watchlist_add":
                if not token:
                    ack(False, {"code": "400", "error": "token required — instrument token bhejo"})
                    return
                result = watchlist_engine.add_stock(watchlist_id, symbol, token, **metadata)
            elif action == "watchlist_remove":
                if not token:
                    ack(False, {"code": "400", "error": "token required — remove ke liye instrument token bhejo"})
                    return
                result = watchlist_engine.remove_stock(watchlist_id, token)
            else:
                ack(False, {"code": "400", "error": f"unsupported watchlist action: {action}"})
                return
            echo = {k: v for k, v in (result or {}).items() if not isinstance(v, dict)} if isinstance(result, dict) else {}
            if isinstance(result, dict) and isinstance(result.get("entry"), dict):
                echo["entry"] = {k: result["entry"].get(k) for k in ("symbol", "token", "tradingSymbol")} if result["entry"] else {}
            ack(bool((result or {}).get("ok")), {"result": echo, "watchlistId": watchlist_id,
                                                 "error": (result or {}).get("error")})
            return
        if action.startswith("target"):
            # No target rule engine is wired to the gateway yet — answering
            # ok=True without doing anything would be a fabricated success.
            ack(False, {"code": "501", "error": f"{action} is not routed by the gateway yet — risk/target endpoints se use karo"})
            return
        ack(False, {"code": "400", "error": f"unknown realtime action: {action}"})
    except Exception as exc:
        session.outbox.put(_frame(session, "error.event", channel="system",
                                  data={"requestId": request_id, "correlationId": correlation_id, "code": "500", "message": str(exc)[:300]},
                                  correlation_id=correlation_id))