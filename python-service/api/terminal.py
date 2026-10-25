"""Trading Terminal API — switch / connect / trade across Kotak, Shoonya, Dummy.

The terminal API is the ONLY broker-facing surface used by the trading UI
(next, any future frontend, any executor). Every operation is gated:

  * terminal actions require the requested terminal to be THE ACTIVE one
    (switch first, then act) — a Kotak session can never appear under the
    Shoonya/dummy terminal,
  * mutating actions (login / logout / orders / oauth-code) require a valid
    user JWT (see services.jwt_auth); the mode SWITCH is gated instead by Mode
    Lock — passwordless when the lock is OFF, unlock-token (423 MODE_LOCKED)
    when ON (see services/security + services.mode_lock),
  * order placement flows through the Common Trading Core (Risk → Audit →
    Adapter), never directly to any adapter.

All account data is REAL adapter output. Nothing is fabricated; adapters that
cannot serve return honest empty/unavailable state.
"""
from __future__ import annotations
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from brokers import capabilities
from brokers.manager import (
    TERMINALS,
    active_terminal,
    get_active_adapter,
    get_adapter,
    switch_terminal,
)
from brokers.models import BrokerError
from core.engines import order_engine, position_engine, audit_engine, target_engine, basket_engine
from services.jwt_auth import (
    authenticate_user,
    issue_token,
    read_token,
    verify_token,
)

router = APIRouter(prefix="/api/terminal", tags=["terminal"])
log = logging.getLogger("terminal_api")

_BROKER_NAMES = {"kotak": "Kotak Neo", "shoonya": "Shoonya", "dummy": "Dummy Mode"}


# ---- auth dependency -------------------------------------------------------

def require_jwt(request: Request) -> dict:
    token = read_token(request)
    if not token:
        raise HTTPException(401, "authentication required (JWT)")
    try:
        return verify_token(token)
    except ValueError as exc:
        raise HTTPException(401, f"invalid token: {exc}") from exc


def require_active(terminal: str) -> str:
    mode = (terminal or "").lower()
    if mode not in TERMINALS:
        raise HTTPException(400, "mode must be one of kotak|shoonya|dummy")
    if mode != active_terminal():
        raise HTTPException(409, f"terminal {mode} is not the active terminal (switch first)")
    return mode


async def require_mode_unlock(request: Request) -> None:
    """Switch gate: Mode Lock OFF → the switch is passwordless/open; Mode Lock
    ON → a freshly issued unlock token is required in `x-mode-unlock` (or the
    Authorization header), otherwise HTTP 423 with code MODE_LOCKED.

    This is SEPARATE from the user JWT: switching modes must work without the
    operator password, which is exactly what Mode Lock protects against.
    """
    from services.mode_lock import mode_lock_status, verify_unlock_token
    status = await mode_lock_status()
    if not status.get("lockEnabled"):
        return
    token = request.headers.get("x-mode-unlock") or ""
    if not token:
        auth = request.headers.get("authorization") or ""
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip()
    if token and verify_unlock_token(token):
        return
    raise HTTPException(423, detail={
        "code": "MODE_LOCKED",
        "message": ("terminal mode switch is locked — supply a fresh unlock token "
                    "(x-mode-unlock header) or disable Mode Lock in Settings"),
    })


async def _adapter_result(adapter, method: str, *args, **kwargs) -> dict:
    try:
        result = await getattr(adapter, method)(*args, **kwargs)
    except BrokerError as exc:
        raise HTTPException(502, detail=exc.to_dict()) from exc
    except Exception as exc:
        log.exception("terminal adapter call failed: %s", exc)
        raise HTTPException(502, detail={"code": "BROKER_UNAVAILABLE", "message": str(exc)}) from exc
    return result if isinstance(result, dict) else {"data": result}


# ---- user login ------------------------------------------------------------

user_router = APIRouter(prefix="/api/user", tags=["auth"])


@user_router.post("/login")
async def user_login(body: dict):
    username = str(body.get("username") or "")
    password = str(body.get("password") or "")
    if not authenticate_user(username, password):
        raise HTTPException(401, "invalid username or password")
    return {"ok": True, "token": issue_token(username), "expiresInSeconds": 28800, "username": username}


# ---- terminal introspection -------------------------------------------------

@router.get("/list")
async def terminal_list():
    """Real state of every terminal (capabilities, adapter enablement, login)."""
    terminals = []
    for term in TERMINALS:
        adapter = get_adapter(term)
        caps = capabilities.capabilities_for(term)
        terminals.append({
            "id": term,
            "name": _BROKER_NAMES[term],
            "active": term == active_terminal(),
            "enabled": bool(getattr(adapter, "enabled", True)),
            "isLoggedIn": bool(adapter.is_logged_in),
            "capabilities": caps.to_dict() if hasattr(caps, "to_dict") else {
                "supportsSearch": caps.supports_search, "products": caps.products,
                "orderTypes": caps.order_types, "exchangeTypes": caps.exchange_types,
            },
            "status": "disconnected" if not adapter.is_logged_in else "connected",
        })
    return {"ok": True, "active": active_terminal(), "terminals": terminals}


@router.get("/state")
async def terminal_state():
    """Safe, minimal state snapshot for the whole trading terminal (no secrets)."""
    adapter = get_active_adapter()
    return {
        "ok": True,
        "terminal": active_terminal(),
        "broker": _BROKER_NAMES.get(active_terminal(), active_terminal()),
        "isLoggedIn": bool(adapter.is_logged_in),
        "mode": adapter.mode,
    }


# ---- switching / connect ----------------------------------------------------

@router.post("/switch")
async def terminal_switch(body: dict, _unlock: None = Depends(require_mode_unlock)):
    mode = str(body.get("mode") or "")
    try:
        result = await switch_terminal(mode)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    # Durable canonical mode: mirror the active terminal into the settings store
    # (best effort — the switch itself already happened and is atomic in the
    # session manager).
    if result.get("ok"):
        try:
            from services.settings_service import set_setting as _persist_terminal_mode
            await _persist_terminal_mode("terminal_mode", mode)
        except Exception as exc:
            log.warning("could not persist terminal_mode=%s: %s", mode, exc)
    return result


@router.post("/auto-login")
async def terminal_auto_login(body: dict, _auth: dict = Depends(require_jwt)):
    """Obtain the session for a terminal THE WAY THAT TERMINAL CAN.

    * ``kotak``   — TOTP + MPIN, fully automatic (the backend holds both).
    * ``dummy``   — a managed paper session, no broker call.
    * ``shoonya`` — OAuth: the stored session is restored when there is one;
      otherwise the result says ``requires: "oauth_handshake"`` and carries the
      URL the operator has to open (the Noren SDK has no password login).

    The endpoint never returns a secret — only the method, the message and the
    OAuth URL.
    """
    from services.auto_login import auto_login

    mode = str(body.get("terminal") or active_terminal()).lower()
    if mode not in ("kotak", "shoonya", "dummy"):
        raise HTTPException(400, "terminal must be one of kotak|shoonya|dummy")
    result = await auto_login(mode, source=str(body.get("source") or "api"))
    payload = result.to_dict()
    payload["isLoggedIn"] = bool(getattr(get_adapter(mode), "is_logged_in", False))
    return payload


@router.get("/auto-login/state")
async def terminal_auto_login_state(_auth: dict = Depends(require_jwt)):
    """What each terminal can do about its own session right now."""
    from services.terminal_credentials import has_session_material

    rows = []
    for term in ("kotak", "shoonya", "dummy"):
        adapter = get_adapter(term)
        rows.append({
            "terminal": term,
            "name": getattr(adapter, "broker_name", term),
            "enabled": bool(getattr(adapter, "enabled", True)),
            "isLoggedIn": bool(getattr(adapter, "is_logged_in", False)),
            "capabilities": getattr(adapter, "capabilities", {}),
            "hasStoredSession": has_session_material(term) if term == "shoonya" else False,
        })
    return {"ok": True, "active": active_terminal(), "terminals": rows}


@router.post("/connect")
async def terminal_connect(body: dict, _auth: dict = Depends(require_jwt)):
    """Authenticate the ACTIVE terminal's adapter (real login, not fabricated)."""
    mode = require_active(body.get("terminal") or active_terminal())
    adapter = get_adapter(mode)
    if not getattr(adapter, "enabled", True):
        raise HTTPException(409, f"{adapter.broker_name} is not enabled (credentials not configured)")
    try:
        ok = await adapter.login()
    except BrokerError as exc:
        raise HTTPException(502, detail=exc.to_dict()) from exc
    except Exception as exc:
        log.exception("terminal connect failed: %s", exc)
        raise HTTPException(502, detail={"code": "BROKER_UNAVAILABLE", "message": str(exc)}) from exc
    return {"ok": bool(ok), "terminal": mode, "isLoggedIn": bool(adapter.is_logged_in), "message": "logged in" if ok else "login failed"}


@router.post("/disconnect")
async def terminal_disconnect(body: dict, _auth: dict = Depends(require_jwt)):
    adapter = get_active_adapter()
    mode = active_terminal()
    try:
        await adapter.logout(reason="manual")
    except Exception as exc:
        log.warning("terminal disconnect failed: %s", exc)
        raise HTTPException(502, detail=str(exc)) from exc
    return {"ok": True, "terminal": mode, "isLoggedIn": bool(adapter.is_logged_in), "message": "disconnected"}


@router.get("/oauth-link")
async def terminal_oauth_link():
    """Shoonya OAuth entry point: return the one-time authorization URL.
    The user opens it in a browser, signs in, and the redirect provides the
    short-lived auth code exchanged via /oauth-code (never persisted)."""
    adapter = get_adapter("shoonya")
    if not getattr(adapter, "enabled", False):
        return {"ok": True, "terminal": "shoonya", "enabled": False, "message": "shoonya terminal not enabled"}
    url = adapter.oauth_url()
    if not url:
        return {"ok": True, "terminal": "shoonya", "enabled": True, "url": None, "message": "oauth url unavailable"}
    return {"ok": True, "terminal": "shoonya", "enabled": True, "url": url}


@router.post("/oauth-code")
async def terminal_accept_oauth_code(body: dict, _auth: dict = Depends(require_jwt)):
    """Shoonya quick-auth: accept the one-time auth code (never persisted)."""
    code = str(body.get("code") or "")
    if not code:
        raise HTTPException(400, "code required")
    adapter = get_adapter("shoonya")
    accepted = adapter.accept_auth_code(code)
    if not accepted:
        raise HTTPException(409, "auth code already used or invalid")
    return {"ok": True, "message": "auth code accepted once"}


# Dedicated Shoonya OAuth aliases (contract-permanent: the settings docstring
# and the scheduler's oauth report reference POST /api/shoonya/oauth-code and
# GET /api/shoonya/oauth-link; these are thin delegations to the canonical
# /api/terminal/* routes so the OAuth bootstrap path is addressable).
shoonya_router = APIRouter(prefix="/api/shoonya", tags=["terminal"])
shoonya_router.get("/oauth-link")(terminal_oauth_link)
shoonya_router.post("/oauth-code")(terminal_accept_oauth_code)


# ---- account data (REAL adapter output for the ACTIVE terminal) -------------

@router.get("/account/{terminal}")
async def terminal_account(terminal: str):
    mode = require_active(terminal)
    adapter = get_adapter(mode)
    if not adapter.is_logged_in:
        return {"ok": True, "terminal": mode, "isLoggedIn": False, "data": [], "message": "not connected"}
    return {"ok": True, "terminal": mode, "isLoggedIn": True, **await _adapter_result(adapter, "funds")}


@router.get("/positions/{terminal}")
async def terminal_positions(terminal: str):
    mode = require_active(terminal)
    try:
        return {"ok": True, "terminal": mode, **await position_engine.get_positions(mode)}
    except BrokerError as exc:
        return {"ok": True, "terminal": mode, "isLoggedIn": False, "data": [], "totals": {}, "message": exc.message}


@router.get("/holdings/{terminal}")
async def terminal_holdings(terminal: str):
    mode = require_active(terminal)
    adapter = get_adapter(mode)
    if not adapter.is_logged_in:
        return {"ok": True, "terminal": mode, "isLoggedIn": False, "data": [], "message": "not connected"}
    return {"ok": True, "terminal": mode, "isLoggedIn": True, **await _adapter_result(adapter, "holdings")}


@router.get("/orders/{terminal}")
async def terminal_orders(terminal: str):
    mode = require_active(terminal)
    adapter = get_adapter(mode)
    if not adapter.is_logged_in:
        return {"ok": True, "terminal": mode, "isLoggedIn": False, "data": [], "message": "not connected"}
    return {"ok": True, "terminal": mode, "isLoggedIn": True, **await _adapter_result(adapter, "orders")}


@router.get("/orders/{terminal}/{order_id}/history")
async def terminal_order_history(terminal: str, order_id: str):
    mode = require_active(terminal)
    adapter = get_adapter(mode)
    return {"ok": True, "terminal": mode, **await _adapter_result(adapter, "order_history", order_id=order_id)}


@router.get("/trades/{terminal}")
async def terminal_trades(terminal: str):
    mode = require_active(terminal)
    adapter = get_adapter(mode)
    if not adapter.is_logged_in:
        return {"ok": True, "terminal": mode, "isLoggedIn": False, "data": [], "message": "not connected"}
    return {"ok": True, "terminal": mode, "isLoggedIn": True, **await _adapter_result(adapter, "trade_book")}


@router.get("/search")
async def terminal_search(q: str = "", exchange: str = "nse_cm", terminal: str = ""):
    mode = require_active(terminal)
    adapter = get_adapter(mode)
    try:
        rows = await adapter.search(search_text=q, exchange=exchange)
    except Exception as exc:
        raise HTTPException(502, detail={"code": "SEARCH_FAILED", "message": str(exc)}) from exc
    return {"ok": True, "terminal": mode, "query": q, "data": rows or []}


@router.get("/quote")
async def terminal_quote(terminal: str = "", token: str = "", exchange: str = "nse_cm", symbol: str = ""):
    mode = require_active(terminal)
    adapter = get_adapter(mode)
    exchange = exchange or "nse_cm"
    # Common Trading Core market-data contract: adapters take instrument_tokens
    # (list of {exchange_segment, instrument_token}); translate the scalar form.
    refs = []
    if token:
        refs.append({"exchange_segment": exchange or "nse_cm", "instrument_token": str(token)})
    if not refs and symbol:
        try:
            results = await adapter.search(exchange=exchange, search_text=symbol)
            data = results.get("data") if isinstance(results, dict) else (results or [])
            row = (data or [{}])[0] if isinstance(data, list) else {}
            inst_token = row.get("instrument_token") or row.get("instrumentToken") or row.get("tok")
            if inst_token:
                refs.append({"exchange_segment": exchange or "nse_cm", "instrument_token": str(inst_token)})
        except Exception:
            refs = []
    if not refs:
        raise HTTPException(400, "token required to fetch a quote")
    try:
        quote = await adapter.quote(instrument_tokens=refs, quote_type="ltp")
    except Exception as exc:
        raise HTTPException(502, detail={"code": "QUOTE_FAILED", "message": str(exc)}) from exc
    data = quote.get("data") if isinstance(quote, dict) else (quote or [])
    first = (data or [{}])[0] if isinstance(data, list) else quote
    return {"ok": True, "terminal": mode, "data": first}


@router.get("/margin")
async def terminal_margin(
    terminal: str = "",
    token: str = "",
    product: str = "MIS",
    order_type: str = "MKT",
    quantity: str = "1",
    price: str = "0",
    trigger_price: str = "0",
    transaction_type: str = "BUY",
    exchange: str = "nse_cm",
):
    """Real broker-computed margin preview (Kotak SDK margin API). Returns an
    honest `unavailable` envelope when the broker cannot compute a value —
    this endpoint NEVER fabricates a margin estimate."""
    mode = require_active(terminal)
    adapter = get_adapter(mode)
    if not adapter.is_logged_in:
        return {"ok": True, "terminal": mode, "available": False,
                "message": "not connected to broker"}
    caps = capabilities.capabilities_for(mode)
    if not getattr(caps, "supports_margin_preview", False):
        return {"ok": True, "terminal": mode, "available": False, "api": "margin",
                "message": f"{adapter.broker_name} does not provide a margin API"}
    try:
        result = await adapter.margin_required(
            exchange=exchange, token=token, product=product, order_type=order_type,
            quantity=quantity, price=price, trigger_price=trigger_price,
            transaction_type=transaction_type,
        )
    except BrokerError as exc:
        return {"ok": True, "terminal": mode, "available": False, "api": "margin",
                "message": exc.message}
    if isinstance(result, dict) and result.get("unavailable"):
        return {"ok": True, "terminal": mode, "available": False, "api": "margin",
                "message": result.get("message", "margin information unavailable")}
    return {"ok": True, "terminal": mode, "available": True, "data": result}


@router.get("/audit")
async def terminal_audit(terminal: str = "", limit: int = 50):
    mode = require_active(terminal)
    entries = await audit_engine.recent_from_db(terminal=mode, limit=min(max(limit, 1), 200))
    return {"ok": True, "terminal": mode, "data": entries}


# ---- order actions (Risk → Audit → Adapter, JWT-protected) ------------------

@router.post("/order")
async def terminal_place_order(body: dict, _auth: dict = Depends(require_jwt)):
    mode = require_active(body.get("terminal") or active_terminal())
    result = await order_engine.place(mode, body.get("order") or body)
    if not result.get("ok"):
        raise HTTPException(400, detail=result)
    return {**result, "terminal": mode}


@router.post("/order/modify")
async def terminal_modify_order(body: dict, _auth: dict = Depends(require_jwt)):
    mode = require_active(body.get("terminal") or active_terminal())
    order_id = str(body.get("order_id") or body.get("orderId") or "")
    if not order_id:
        raise HTTPException(400, "order_id required")
    result = await order_engine.modify(mode, order_id, body.get("order") or body)
    if not result.get("ok"):
        raise HTTPException(400, detail=result)
    return {**result, "terminal": mode}


@router.post("/order/cancel")
async def terminal_cancel_order(body: dict, _auth: dict = Depends(require_jwt)):
    mode = require_active(body.get("terminal") or active_terminal())
    order_id = str(body.get("order_id") or body.get("orderId") or "")
    result = await order_engine.cancel(mode, order_id)
    if not result.get("ok"):
        raise HTTPException(400, detail=result)
    return {**result, "terminal": mode}


@router.post("/order/square-off")
async def terminal_square_off(body: dict, _auth: dict = Depends(require_jwt)):
    mode = require_active(body.get("terminal") or active_terminal())
    result = await order_engine.square_off(mode, body.get("position") or body)
    if not result.get("ok"):
        raise HTTPException(400, detail=result)
    return {**result, "terminal": mode}


@router.post("/order/basket")
async def terminal_basket(body: dict, _auth: dict = Depends(require_jwt)):
    mode = require_active(body.get("terminal") or active_terminal())
    orders = body.get("orders")
    if not isinstance(orders, list) or not orders:
        raise HTTPException(400, "orders list required")
    result = await basket_engine.place_basket(mode, orders)
    if not result.get("ok"):
        raise HTTPException(400, detail=result)
    return {**result, "terminal": mode}


# ---- targets (Dummy; monetary value) ----------------------------------------

@router.get("/targets")
async def terminal_targets(terminal: str = ""):
    """All engine targets for the term actice terminal (real engine state)."""
    mode = require_active(terminal)
    targets = await target_engine.get_all(mode)
    return {"ok": True, "terminal": mode, "data": targets}


@router.post("/target")
async def terminal_set_target(body: dict, _auth: dict = Depends(require_jwt)):
    mode = require_active(body.get("terminal") or active_terminal())
    symbol = str(body.get("symbol") or "").upper()
    value = body.get("targetValue") or body.get("value")
    if not symbol or value is None:
        raise HTTPException(400, "symbol and targetValue required")
    try:
        entry = await target_engine.set_target(mode, symbol, float(value))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True, "terminal": mode, "target": entry}


@router.delete("/target/{symbol}")
async def terminal_remove_target(symbol: str, terminal: str = "", _auth: dict = Depends(require_jwt)):
    mode = require_active(terminal)
    removed = await target_engine.remove_target(mode, symbol)
    return {"ok": bool(removed), "terminal": mode}