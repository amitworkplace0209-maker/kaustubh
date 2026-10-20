"""Watch List CRUD + live market data (NSE EQ Watch List).

Powers the Data Saver "Watch List" page (/data-saver/watch-list). Unlike the
basic favourites watchlist, this stores the FULL identity required for reliable
live subscription (token, symbol, exchange/segment, ISIN, company) and
integrates with the central WebSocket subscription manager so that adding a
stock immediately subscribes its token to the real feed and removing it may
unsubscribe (without disconnecting the whole WebSocket).

Persistence: MongoDB ``watchlist`` collection, scoped by a stable
``watchlist_id`` (session/user). Each entry carries:
  watchlist_id, user/session, token, symbol, exchange, exchangeSegment, isin,
  companyName, tradingSymbol, created_at, updated_at.

Real-time data (LTP, change, momentum, volume, tick-age) for each entry comes
from the ONE central market-data store (tick_buffer latest ticks + real price
history) — never per-stock polling and never a fabricated value. It is merged
server-side into the watch-list projection.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database.connection import get_db
from services import market_calendar, tick_buffer
from services.instrument_cache import instrument_cache
from session_scope import get_or_create_session_id
from core.timezones import now_ist as _now_ist

router = APIRouter(prefix="/api/watch-list", tags=["watch-list"])

from core.timezones import IST


def _today_trading_date() -> str:
    """IST trading date for today, using the authoritative market calendar.

    Returns 'YYYY-MM-DD'. On a non-trading day this is still today's IST date;
    hides recorded on a non-trading day simply apply whenever they are read.
    """
    return str(market_calendar.snapshot().get("market_date") or "")


async def active_hidden_identity() -> tuple[set[str], set[str]]:
    """``(symbols, tokens)`` hidden for the CURRENT IST trading date only.

    Hide-today semantics: a hide persists (with its ``trading_date``) until the
    next trading day, then naturally stops applying. Entries written on earlier
    dates stay dormant in the DB — no delete job needed.
    """
    try:
        db = get_db()
        session_id = get_or_create_session_id()
        doc = await db.watch_hidden.find_one({"watchlist_id": session_id})
    except Exception:
        return set(), set()
    if not doc:
        return set(), set()

    today = _today_trading_date()
    entries = doc.get("entries") if isinstance(doc.get("entries"), dict) else {}
    entry = entries.get(today) if isinstance(entries.get(today), dict) else None
    if entry is not None:
        symbols = {str(s).strip().upper() for s in (entry.get("symbols") or []) if str(s).strip()}
        tokens = {str(t).strip() for t in (entry.get("tokens") or []) if str(t).strip()}
        return symbols, tokens

    # Legacy flat storage (pre date-scope) — treated as active for today so
    # existing hides keep working after the upgrade.
    symbols = {str(s).strip().upper() for s in (doc.get("symbols") or []) if str(s).strip()}
    tokens = {str(t).strip() for t in (doc.get("tokens") or []) if str(t).strip()}
    return symbols, tokens


def hidden_today() -> set[str]:
    """Sync shim over ``active_hidden_identity`` (symbols + tokens).

    Only safe when no event loop is already running (legacy callers). The
    scanner uses ``await active_hidden_identity()`` directly.
    """
    import asyncio
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            return set()
        symbols, tokens = loop.run_until_complete(active_hidden_identity())
        return symbols | tokens
    except Exception:
        return set()


def now_ist() -> datetime:
    """Current instant in IST (project-wide convention)."""
    return _now_ist()


def _iso(v) -> str | None:
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, str):
        return v
    return None


class AddWatchListRequest(BaseModel):
    symbol: str = ""
    instrumentToken: str = ""
    exchangeSegment: str = "nse_cm"
    isin: str | None = None
    companyName: str | None = None
    tradingSymbol: str | None = None


def _resolve_instrument(symbol: str = "", token: str = "") -> dict | None:
    inst = None
    if token:
        inst = instrument_cache.lookup_by_token(str(token))
    if inst is None and symbol:
        inst = instrument_cache.lookup_by_symbol(symbol)
    if inst is None and symbol:
        inst = instrument_cache.lookup_by_isin(symbol)
    return inst


def _instrument_identity(inst: dict | None) -> dict:
    if not inst:
        return {}
    return {
        "symbol": inst.get("symbol") or inst.get("tradingSymbol") or "",
        "tradingSymbol": inst.get("tradingSymbol") or inst.get("symbol") or "",
        "companyName": inst.get("companyName") or "",
        "exchangeSegment": inst.get("exchangeSegment") or inst.get("exchange") or "nse_cm",
        "isin": inst.get("isin") or "",
    }


async def _subscribe_ws(token: str, segment: str, symbol: str):
    """Best-effort central subscription of the token to the live WebSocket feed."""
    try:
        from ws_socket.ws_manager import ws_manager
        return await ws_manager.subscribe([{
            "instrument_token": token,
            "exchange_segment": segment,
            "symbol": symbol,
        }])
    except Exception:
        return {"ok": False, "message": "subscribe error", "count": 0}


async def _unsubscribe_ws(token: str, segment: str):
    """Best-effort unsubscribe; does NOT tear down the whole WebSocket."""
    try:
        from ws_socket.ws_manager import ws_manager
        return await ws_manager.unsubscribe([{
            "instrument_token": token,
            "exchange_segment": segment,
        }])
    except Exception:
        return {"ok": False, "message": "unsubscribe error", "count": 0}


def _fnum(v):
    try:
        n = float(v)
        return n if n == n and n not in (float("inf"), float("-inf")) else None
    except (TypeError, ValueError):
        return None


def _market_projection(token: str) -> dict:
    """Real, merged market data for a token from the central tick store."""
    latest = tick_buffer._latest_ticks.get(str(token))
    ltp = None
    if latest:
        try:
            ltp = float(latest.get("ltp"))
        except (TypeError, ValueError):
            ltp = None
    if latest is None:
        md = {
            "ltp": None, "change": None, "changePct": None,
            "prevClose": None, "open": None, "high": None, "low": None,
            "volume": None, "bid": None, "ask": None, "lastTickAt": None,
            "available": False,
        }
    else:
        md = {
            "ltp": ltp,
            "change": _fnum(latest.get("change")),
            "changePct": _fnum(latest.get("changePercent")),
            "prevClose": _fnum(latest.get("close")),
            "open": _fnum(latest.get("open")),
            "high": _fnum(latest.get("high")),
            "low": _fnum(latest.get("low")),
            "volume": _fnum(latest.get("volume")),
            "bid": _fnum(latest.get("bp")),
            "ask": _fnum(latest.get("sp")),
            "lastTickAt": latest.get("ts"),
            "available": ltp is not None,
        }
    age = tick_buffer.latest_tick_age_seconds(token)
    md["tickAgeSec"] = age if age is not None else None
    md["momentum"] = tick_buffer.momentum_windows(token, ltp)
    return md


def _enrich(entry: dict) -> dict:
    entry = dict(entry)
    entry["_id"] = str(entry["_id"])
    token = str(entry.get("token") or entry.get("instrumentToken") or "")
    md = _market_projection(token)
    return {
        "watchlistId": entry.get("watchlist_id"),
        "symbol": entry.get("symbol", ""),
        "tradingSymbol": entry.get("tradingSymbol") or entry.get("symbol", ""),
        "companyName": entry.get("companyName") or None,
        "instrumentToken": token,
        "exchange": entry.get("exchange", "NSE"),
        "exchangeSegment": entry.get("exchangeSegment", "nse_cm"),
        "isin": entry.get("isin") or None,
        "createdAt": _iso(entry.get("created_at")) or _iso(entry.get("createdAt")),
        "updatedAt": _iso(entry.get("updated_at")) or _iso(entry.get("updatedAt")),
        "marketData": md,
    }


@router.get("")
async def get_watch_list():
    """Full Watch List with live merged market data (real backend state)."""
    db = get_db()
    session_id = get_or_create_session_id()
    cursor = db.watchlist.find(
        {"watchlist_id": session_id}
    ).sort([("symbol", 1)])
    items = await cursor.to_list(length=None)
    return {
        "data": [_enrich(i) for i in items],
        "session": session_id,
    }


@router.post("")
async def add_to_watch_list(req: AddWatchListRequest):
    """Add a real NSE EQ stock to the Watch List (validated + persisted + WS)."""
    db = get_db()
    token = str(req.instrumentToken or "").strip()
    symbol = req.symbol.strip().upper()

    if not token and not symbol:
        raise HTTPException(400, "A symbol or instrument token is required")

    inst = _resolve_instrument(symbol=symbol, token=token)
    if inst is None:
        raise HTTPException(400, {
            "status": "rejected",
            "reason": "Instrument is not available in the current NSE EQ instrument master.",
        })
    token = token or str(inst.get("token") or "")
    if not token:
        raise HTTPException(400, "Could not resolve an instrument token.")
    resolved_symbol = (symbol or str(inst.get("symbol") or "")).upper()
    segment = req.exchangeSegment or str(inst.get("exchangeSegment") or "nse_cm")
    identity = _instrument_identity(inst)

    session_id = get_or_create_session_id()
    now = now_ist()

    existing = await db.watchlist.find_one({
        "watchlist_id": session_id,
        "token": token,
    })
    if existing:
        existing["_id"] = str(existing["_id"])
        return {
            "ok": True,
            "status": "already_in_watch_list",
            "reason": f"{resolved_symbol} is already in the Watch List.",
            "data": _enrich(existing),
        }

    doc = {
        "watchlist_id": session_id,
        "uuid": str(uuid.uuid4()),
        "user": session_id,
        "session": session_id,
        "token": token,
        "symbol": resolved_symbol,
        "tradingSymbol": identity.get("tradingSymbol") or resolved_symbol,
        "companyName": identity.get("companyName") or req.companyName,
        "exchange": "NSE",
        "exchangeSegment": segment,
        "isin": identity.get("isin") or req.isin,
        "favorite": False,
        "created_at": now,
        "updated_at": now,
    }
    await db.watchlist.update_one(
        {"watchlist_id": session_id, "token": token},
        {"$set": doc},
        upsert=True,
    )
    saved = await db.watchlist.find_one({"watchlist_id": session_id, "token": token})

    sub = await _subscribe_ws(token, segment, resolved_symbol)

    saved["_id"] = str(saved["_id"])
    return {
        "ok": True,
        "status": "added",
        "reason": f"{resolved_symbol} added to Watch List.",
        "websocketApplied": bool(sub.get("ok")),
        "data": _enrich(saved),
    }


@router.delete("/{token}")
async def remove_from_watch_list(token: str):
    """Remove a stock from the Watch List (persisted + central unsubscribe)."""
    db = get_db()
    session_id = get_or_create_session_id()
    tok = str(token)
    item = await db.watchlist.find_one({"watchlist_id": session_id, "token": tok})
    if not item:
        raise HTTPException(404, "Stock not found in Watch List")
    symbol = item.get("symbol", "")
    segment = item.get("exchangeSegment", "nse_cm")
    await db.watchlist.delete_one({"watchlist_id": session_id, "token": tok})
    await _unsubscribe_ws(tok, segment)
    return {"deleted": 1, "symbol": symbol, "token": tok}


class HideStockRequest(BaseModel):
    symbol: str = ""
    instrumentToken: str = ""
    hidden: bool = True
    reason: str | None = None


@router.put("/hidden")
async def update_hidden_stocks(req: HideStockRequest):
    """Persist a user hide / unhide action for the scanner (server-side).

    Date-scoped "hide today": the hide is stored against the CURRENT IST
    trading date. It stops applying on the next trading day automatically.
    """
    db = get_db()
    session_id = get_or_create_session_id()
    symbol = str(req.symbol or "").strip().upper()
    token = str(req.instrumentToken or "").strip()
    today = _today_trading_date() or datetime.now(IST).date().isoformat()

    if req.hidden and not symbol and not token:
        raise HTTPException(400, "A symbol or instrument token is required to hide")

    doc = await db.watch_hidden.find_one({"watchlist_id": session_id})
    entries = dict(doc.get("entries") or {}) if doc else {}
    current = entries.get(today) if isinstance(entries.get(today), dict) else {}
    symbols = set(current.get("symbols") or [])
    tokens = set(current.get("tokens") or [])

    if req.hidden:
        if symbol:
            symbols.add(symbol)
        if token:
            tokens.add(token)
    else:
        if symbol:
            symbols.discard(symbol)
        if token:
            tokens.discard(token)

    hides_remaining = bool(symbols or tokens)
    entries[today] = {
        "symbols": sorted(symbols),
        "tokens": sorted(tokens),
        "trading_date": today,
        "hidden_at": _iso(now_ist()),
        "active": True,
        "reason": str(req.reason or "manual_hide"),
    }
    # Fully-unhidden day entries can be dropped entirely (nothing to keep).
    if not hides_remaining:
        entries.pop(today, None)

    payload = {
        "watchlist_id": session_id,
        "entries": entries,
        "updated_at": now_ist(),
    }
    # Legacy flat mirrors (today's active set) so older readers keep working.
    if hides_remaining:
        payload["symbols"] = sorted(symbols)
        payload["tokens"] = sorted(tokens)

    await db.watch_hidden.update_one(
        {"watchlist_id": session_id},
        {"$set": payload},
        upsert=True,
    )
    return {
        "ok": True,
        "symbol": symbol or None,
        "instrumentToken": token or None,
        "hidden": req.hidden,
        "tradingDate": today,
        "count": len(symbols) + len(tokens),
    }


@router.get("/hidden")
async def get_hidden_stocks():
    """User-hidden scanner symbols/tokens for TODAY (date-scoped)."""
    db = get_db()
    session_id = get_or_create_session_id()
    today = _today_trading_date()
    doc = await db.watch_hidden.find_one({"watchlist_id": session_id})
    if doc and isinstance(doc.get("entries"), dict):
        entry = doc["entries"].get(today)
        if isinstance(entry, dict):
            return {
                "ok": True,
                "tradingDate": today or None,
                "symbols": entry.get("symbols") or [],
                "tokens": entry.get("tokens") or [],
            }
    return {
        "ok": True,
        "tradingDate": today or None,
        "symbols": (doc or {}).get("symbols") or [],
        "tokens": (doc or {}).get("tokens") or [],
    }
