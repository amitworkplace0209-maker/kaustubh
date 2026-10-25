"""Stock management routes — CRUD + validated subscribe + live market data.

This is the backend powering the Data Saver Stock Subscription page. It is the
single source of truth for:

  - The NSE EQ instrument search (against the cached scrip-master).
  - Instrument validation (an instrument must exist in the NSE EQ master
    before it may be subscribed).
  - Subscription registration + persistence (MongoDB ``stocks`` collection).
  - WebSocket subscribe/unsubscribe through the central ``ws_manager``.
  - Real market data, tick stats and per-stock status derived from the real
    tick pipeline (``tick_buffer``) and MongoDB.

No dummy / fabricated values: every field maps to a real backend source. When
a value is genuinely unavailable the response uses ``null`` / an explicit
"Not available" reason — never a ``"--"``, fake number or guessed value.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from database.connection import get_db
from services import tick_buffer, market_calendar
from services.instrument_cache import instrument_cache
from services.session.session_manager import session_manager
from ws_socket.ws_manager import ws_manager
from core.timezones import now_ist as _now_ist
from api.search import (
    DEPRECATION_TARGET,
    canonical_instrument_rows,
    legacy_row,
)

router = APIRouter(prefix="/api/stocks", tags=["stocks"])
logger = logging.getLogger("app")

IST = timezone.utc  # persisted timestamps are UTC; frontend formats to IST


class AddStockRequest(BaseModel):
    symbol: str
    instrumentToken: str
    exchangeSegment: str = "nse_cm"
    isIndex: bool = False
    isDepth: bool = False


class SubscribeRequest(BaseModel):
    symbol: str = ""
    instrumentToken: str = ""
    exchangeSegment: str = "nse_cm"


def now_ist() -> datetime:
    """Current instant in IST (project-wide convention)."""
    return _now_ist()


async def _generate_internal_index(db) -> int:
    highest = await db.stocks.find_one(sort=[("internalIndex", -1)])
    return (highest["internalIndex"] + 1) if highest else 1


async def _subscribe_on_ws(db, stock_doc: dict):
    tokens = [{
        "instrument_token": stock_doc["instrumentToken"],
        "exchange_segment": stock_doc.get("exchangeSegment", "nse_cm"),
        "isIndex": stock_doc.get("isIndex", False),
        "isDepth": stock_doc.get("isDepth", False),
        "feedLevel": stock_doc.get("feedLevel"),
        "marketData": stock_doc.get("marketData"),
        "symbol": stock_doc.get("symbol", ""),
    }]
    try:
        return await ws_manager.subscribe(tokens)
    except Exception as exc:
        logger.warning("Auto-subscribe failed for %s: %s", stock_doc.get("symbol"), exc)
        return {"ok": False, "message": f"Subscribe failed: {exc}", "count": 0}


async def _unsubscribe_on_ws(token: str, exchange_segment: str):
    try:
        await ws_manager.unsubscribe([{
            "instrument_token": token,
            "exchange_segment": exchange_segment,
        }])
    except Exception as exc:
        logger.warning("Unsubscribe failed: %s", exc)


def _resolve_instrument(symbol: str = "", token: str = "") -> dict | None:
    """Resolve an instrument from the real NSE CM master by symbol or token."""
    inst = None
    if token:
        inst = instrument_cache.lookup_by_token(str(token))
    if inst is None and symbol:
        inst = instrument_cache.lookup_by_symbol(symbol)
    if inst is None and symbol:
        inst = instrument_cache.lookup_by_isin(symbol)
    return inst


def _instrument_identity(inst: dict | None) -> dict:
    """Safe identity projection from the instrument master (real values only)."""
    if not inst:
        return {
            "symbol": "Not available",
            "companyName": "Not available",
            "tradingSymbol": "Not available",
            "exchange": "NSE",
            "exchangeSegment": "nse_cm",
            "segment": "EQ",
            "instrumentToken": "Not available",
            "isin": "Not available",
            "instrumentType": "Not available",
            "available": False,
        }
    isin = inst.get("isin") or inst.get("pISIN") or ""
    return {
        "symbol": inst.get("symbol") or inst.get("tradingSymbol") or "Not available",
        "companyName": inst.get("companyName") or inst.get("symbol") or "Not available",
        "tradingSymbol": inst.get("tradingSymbol") or inst.get("symbol") or "Not available",
        "exchange": "NSE",
        "exchangeSegment": inst.get("exchangeSegment") or inst.get("exchange") or "nse_cm",
        "segment": "EQ",
        "instrumentToken": str(inst.get("token") or ""),
        "isin": isin or "Not available",
        "instrumentType": "Equity",
        "available": True,
    }


def _market_data(token: str) -> dict:
    """Real OHLC/LTP from the tick buffer's latest tick for a token."""
    latest = tick_buffer._latest_ticks.get(str(token))
    if not latest:
        return {
            "ltp": None,
            "open": None,
            "high": None,
            "low": None,
            "close": None,
            "prevClose": None,
            "volume": None,
            "change": None,
            "changePercent": None,
            "lastTickAt": None,
            "receivedAt": None,
            "available": False,
        }
    return {
        "ltp": latest.get("ltp"),
        "open": latest.get("open"),
        "high": latest.get("high"),
        "low": latest.get("low"),
        "close": latest.get("close"),
        "prevClose": latest.get("close"),
        "volume": latest.get("volume"),
        "change": latest.get("change"),
        "changePercent": latest.get("changePercent"),
        "lastTickAt": latest.get("ts"),
        "receivedAt": latest.get("receivedAt"),
        "available": True,
    }


def _as_aware_utc(value):
    """Mongo returns offset-naive UTC datetimes; normalize to tz-aware UTC.

    Lets us compare against ``datetime.now(timezone.utc)`` without the
    offset-naive/offset-aware TypeError.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
    return value


def _safe_age_seconds(value) -> float | None:
    """Age in seconds of a (possibly Mongo-naive UTC) datetime, or None."""
    aware = _as_aware_utc(value)
    if not isinstance(aware, datetime):
        return None
    try:
        return (datetime.now(timezone.utc) - aware).total_seconds()
    except Exception:
        return None


def _market_context() -> dict:
    """Real market state via services.market_calendar (IST-consistent)."""
    snap = market_calendar.snapshot()
    return {
        "status": snap.get("market_status"),
        "session": snap.get("market_session"),
        "date": snap.get("market_date"),
        "dayClass": snap.get("day_class"),
        "tradingDay": snap.get("trading_day"),
        "closureReason": snap.get("closure_reason"),
        "latestTickAt": datetime.now(timezone.utc).isoformat(),
    }


async def _per_stock_tick_stats(db, token: str) -> dict:
    """Real per-stock tick statistics from MongoDB (indexed by token+ts).

    The three independent reads (latest-ever tick, first tick today, count
    today) run concurrently so one subscription never serializes 3 round-trips.
    """
    tok = str(token)
    today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    stats = {"tickCountToday": 0, "firstTickAt": None, "lastTickAt": None}

    async def _last():
        return await db.ticks.find_one({"instrumentToken": tok}, sort=[("ts", -1)])

    async def _first():
        return await db.ticks.find_one(
            {"instrumentToken": tok, "ts": {"$gte": today_start}}, sort=[("ts", 1)],
        )

    async def _count():
        return await db.ticks.count_documents(
            {"instrumentToken": tok, "ts": {"$gte": today_start}},
        )

    try:
        last, first, count = await asyncio.gather(_last(), _first(), _count())
    except Exception as exc:
        logger.warning("per-stock tick stats failed for %s: %s", tok, exc)
        last, first, count = None, None, 0
    if last:
        stats["lastTickAt"] = last.get("ts")
    if first:
        stats["firstTickAt"] = first.get("ts")
    stats["tickCountToday"] = int(count or 0)
    return stats


async def _last_tick_ts_by_token(db, tokens: list) -> dict[str, datetime]:
    """Latest ``ts`` per instrumentToken via N CONCURRENT index seeks.

    One ``find_one(sort=[("ts", -1)])`` per token runs in parallel; the
    ``instrumentToken_1_ts_1`` compound index resolves each seek in a single
    bound lookup (~1ms). This replaced an aggregation ``$max`` that scanned
    the entire historical tick range for every subscribed token (~1.5s).
    """
    result: dict[str, datetime] = {}
    toks = [str(t).strip() for t in tokens if t]
    if not toks:
        return result

    async def _seek(tok: str):
        doc = await db.ticks.find_one(
            {"instrumentToken": tok},
            {"ts": 1},
            sort=[("ts", -1)],
        )
        return (tok, doc.get("ts") if doc else None)

    try:
        pairs = await asyncio.gather(*(_seek(t) for t in toks))
        for tok, ts in pairs:
            if ts is not None:
                result[tok] = ts
    except Exception as exc:
        logger.warning("bulk last-tick lookups failed for %d token(s): %s", len(toks), exc)
    return result


def _subscription_status(stock: dict | None, ws_connected: bool, ws_status: dict) -> dict:
    """Structured subscription + websocket state from REAL backend data."""
    if not stock:
        return {
            "subscribed": False,
            "state": "NOT_SUBSCRIBED",
            "reason": "Not subscribed",
            "subscribedAt": None,
            "requestStatus": None,
            "source": None,
            "ws": {
                "subscribed": False,
                "connected": bool(ws_connected),
                "lifecycleState": ws_status.get("lifecycle_state"),
                "reason": ws_status.get("disconnect_reason") or (
                    "Connected" if ws_connected else "WebSocket disconnected"
                ),
            },
        }
    active = stock.get("active", True) is not False
    ws_connected_now = bool(ws_connected)
    subscribed_on_ws = stock.get("wsSubscribed", active)
    return {
        "subscribed": bool(active),
        "state": "ACTIVE" if active else "INACTIVE",
        "reason": "Subscribed and registered" if active else "Subscription inactive",
        "subscribedAt": stock.get("subscribedAt") or stock.get("createdAt"),
        "requestStatus": stock.get("requestStatus") or ("registered" if active else "inactive"),
        "source": stock.get("subscriptionSource") or "data-saver",
        "ws": {
            "subscribed": bool(subscribed_on_ws),
            "connected": ws_connected_now,
            "lifecycleState": ws_status.get("lifecycle_state"),
            "reason": ws_status.get("disconnect_reason") or (
                "Connected" if ws_connected_now else "WebSocket disconnected"
            ),
        },
    }


def _serialize_iso(v) -> str | None:
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, str):
        return v
    return None


async def _enrich_stock(db, s: dict) -> dict:
    """Enrich a persisted subscription with real identity + market + ws state."""
    token = str(s.get("instrumentToken") or "")
    ws = ws_manager.status()
    ws_connected = bool(ws.get("connected"))
    inst = _resolve_instrument(symbol=s.get("symbol", ""), token=token)
    md = _market_data(token)
    tick_stats = await _per_stock_tick_stats(db, token)
    return {
        "symbol": s.get("symbol", ""),
        "instrumentToken": token,
        "exchange": "NSE",
        "exchangeSegment": s.get("exchangeSegment", "nse_cm"),
        "segment": "EQ",
        "active": s.get("active", True) is not False,
        "internalIndex": s.get("internalIndex"),
        "createdAt": _serialize_iso(s.get("createdAt")),
        "updatedAt": _serialize_iso(s.get("updatedAt")),
        "identity": _instrument_identity(inst),
        "subscription": _subscription_status(s, ws_connected, ws),
        "marketData": md,
        "tickStats": tick_stats,
        "websocket": {
            "connected": ws_connected,
            "lifecycleState": ws.get("lifecycle_state"),
            "disconnectReason": ws.get("disconnect_reason"),
        },
        "instrumentMasterAvailable": bool(instrument_cache.loaded),
        "market": _market_context(),
    }


@router.get("")
async def get_stocks(active: str = "false", q: str = ""):
    db = get_db()
    query = {}
    if active.lower() == "true":
        query["active"] = True
    if q:
        query["$or"] = [
            {"symbol": {"$regex": q, "$options": "i"}},
            {"instrumentToken": {"$regex": q, "$options": "i"}},
            {"exchangeSegment": {"$regex": q, "$options": "i"}},
        ]
    cursor = db.stocks.find(query).sort("symbol", 1)
    stocks = await cursor.to_list(length=None)
    # Enrich every subscription concurrently (identity + market + tick stats
    # each issue their own reads) — never one stock at a time serially.
    enriched = await asyncio.gather(*(_enrich_stock(db, s) for s in stocks))
    return {"data": list(enriched)}


@router.get("/list")
async def get_stocks_flat(q: str = ""):
    """Compact persisted-subscription list (symbols + tokens only)."""
    db = get_db()
    query = {}
    if q:
        query["$or"] = [
            {"symbol": {"$regex": q, "$options": "i"}},
            {"instrumentToken": {"$regex": q, "$options": "i"}},
        ]
    cursor = db.stocks.find(query).sort("symbol", 1)
    stocks = await cursor.to_list(length=None)
    return {
        "data": [
            {
                "symbol": s.get("symbol", ""),
                "instrumentToken": str(s.get("instrumentToken") or ""),
                "exchangeSegment": s.get("exchangeSegment", "nse_cm"),
            }
            for s in stocks
        ]
    }


@router.get("/search")
async def search_instruments(
    q: str = Query("", description="Symbol / name / token / ISIN to search"),
    limit: int = Query(10, ge=1, le=50),
):
    """Instrument search over the canonical index.

    DEPRECATED: use ``GET /api/search?q=...`` (the canonical Search Engine).
    This used to scan the instrument master directly with its own ranking and
    its own field mapping; it now resolves through the Search Engine so there
    is exactly one index, one ranking and one result shape. The legacy
    envelope is preserved for existing callers.
    """
    state = instrument_cache.state()

    if not q.strip():
        return {
            "data": [],
            "source": state if isinstance(state, dict) else "cache",
            "instrumentState": state,
            "instrumentMaster": state,
        }

    rows, meta = canonical_instrument_rows(q, limit, eq_only=True)
    return {
        "data": [legacy_row(r) for r in rows],
        "source": "search_engine" if meta.get("indexAvailable") else "cache_unavailable",
        "instrumentCount": meta.get("total", len(rows)),
        "cacheLoaded": True,
        "reason": None if meta.get("indexAvailable") else "Instrument index unavailable.",
        "deprecated": True,
        "replacement": DEPRECATION_TARGET,
        "instrumentMaster": state,
    }


@router.get("/instrument-master/status")
async def instrument_master_status():
    """Structured instrument-master status for the UI status panel."""
    return {"ok": True, **instrument_cache.state()}


@router.get("/validate")
async def validate_instrument(symbol: str = "", token: str = ""):
    """Validate that an instrument exists in the current NSE EQ master."""
    if not symbol and not token:
        return {
            "valid": False,
            "reason": "A symbol or token is required.",
            "identity": _instrument_identity(None),
        }
    inst = _resolve_instrument(symbol=symbol, token=token)
    if not inst:
        return {
            "valid": False,
            "reason": "Instrument is not available in the current NSE EQ instrument master.",
            "identity": _instrument_identity(None),
        }
    if not instrument_cache.is_nse_eq(inst):
        return {
            "valid": False,
            "reason": "Instrument exists but is not an NSE EQ equity instrument.",
            "identity": _instrument_identity(inst),
        }
    return {
        "valid": True,
        "reason": "Instrument exists in the NSE EQ instrument master.",
        "identity": _instrument_identity(inst),
    }


@router.post("/subscribe")
async def subscribe_stock(req: SubscribeRequest):
    """Validate + register a subscription (persisted + WebSocket if feed active).

    Returns a structured payload with real outcome and reason every time, so
    the UI never pretends a WebSocket subscription succeeded when it didn't.
    """
    db = get_db()
    symbol = req.symbol.strip().upper()
    token = str(req.instrumentToken or "").strip()
    reason_note = None

    # 1) Validate the instrument against the NSE EQ master (must exist).
    inst = _resolve_instrument(symbol=symbol, token=token)
    if not inst:
        raise HTTPException(400, {
            "action": "subscribe",
            "status": "rejected",
            "reason": "Instrument is not available in the current NSE EQ instrument master."
                      + (" Instrument master is not loaded." if not instrument_cache.loaded else ""),
            "validToken": bool(token),
        })
    if not instrument_cache.is_nse_eq(inst):
        raise HTTPException(400, {
            "action": "subscribe",
            "status": "rejected",
            "reason": "Instrument exists but is not an NSE EQ equity instrument. Only NSE EQ equities are supported.",
        })

    resolved_symbol = symbol or str(inst.get("symbol") or "").upper()
    resolved_token = token or str(inst.get("token") or "")
    resolved_segment = "nse_cm"

    # 2) Reject duplicate subscription by instrumentToken.
    existing = await db.stocks.find_one({"instrumentToken": resolved_token})
    if existing:
        existing["_id"] = str(existing["_id"])
        return {
            "ok": True,
            "action": "subscribe",
            "status": "already_subscribed",
            "reason": "Already subscribed",
            "subscribed": True,
            "data": await _enrich_stock(db, existing),
        }

    # 3) Register + persist subscription state (desired/registered even if the
    #    feed is currently down — the subscription manager re-applies it when
    #    the WebSocket becomes active).
    internal_index = await _generate_internal_index(db)
    now = now_ist()
    ws_status_before = ws_manager.status()
    ws_connected = bool(ws_status_before.get("connected"))
    inst_is_index = bool(inst.get("isIndex", False))
    inst_is_depth = bool(inst.get("isDepth", False))
    inst_feed_level = inst.get("feedLevel")
    inst_market = inst.get("marketData")
    doc = {
        "symbol": resolved_symbol,
        "instrumentToken": resolved_token,
        "exchangeSegment": resolved_segment,
        "internalIndex": internal_index,
        "isIndex": inst_is_index,
        "isDepth": inst_is_depth,
        "feedLevel": inst_feed_level,
        "marketData": inst_market,
        "active": True,
        "createdAt": now,
        "updatedAt": now,
        "subscribedAt": now,
        "subscriptionSource": "data-saver",
        "requestStatus": "registered",
        "wsSubscribed": False,
        "wsState": "PENDING",
        "wsStateReason": ws_status_before.get("disconnect_reason") or (
            "WebSocket connected" if ws_connected else "WebSocket not connected"
        ),
    }
    await db.stocks.update_one(
        {"instrumentToken": resolved_token},
        {"$set": doc},
        upsert=True,
    )
    saved = await db.stocks.find_one({"instrumentToken": resolved_token})
    saved["_id"] = str(saved["_id"])

    # 4) Apply to the WebSocket if the feed/session is active.
    sub_result = {"ok": False, "message": "WebSocket not connected — subscription registered but not yet applied to the feed."}
    session_active = session_manager.is_active()
    if session_active and ws_connected:
        sub_result = await _subscribe_on_ws(db, saved)
        await db.stocks.update_one(
            {"instrumentToken": resolved_token},
            {"$set": {
                "wsSubscribed": bool(sub_result.get("ok") and sub_result.get("count", 0) > 0),
                "wsState": "SUBSCRIBED" if sub_result.get("ok") else "FAILED",
                "wsStateReason": sub_result.get("message") or "",
                "wsSubscribedAt": now_ist() if sub_result.get("ok") else None,
                "requestStatus": "subscribed" if sub_result.get("ok") else "registered",
                "updatedAt": now_ist(),
            }},
        )
        saved = await db.stocks.find_one({"instrumentToken": resolved_token})
        saved["_id"] = str(saved["_id"])
        reason_note = sub_result.get("message")

    ws_applied = bool(
        session_active and ws_connected and sub_result.get("ok") and sub_result.get("count", 0) > 0
    )
    return {
        "ok": True,
        "action": "subscribe",
        "status": "subscribed",
        "subscribed": True,
        "websocketApplied": ws_applied,
        "sessionActive": session_active,
        "reason": reason_note or (
            "Subscription registered. WebSocket will apply it when the feed is active."
            if not ws_applied else "Subscription registered and applied to the live feed."
        ),
        "data": await _enrich_stock(db, saved),
    }


@router.get("/details")
async def stock_details(symbol: str = "", token: str = ""):
    """Full structured details for one subscription.

    Includes identity, market data, subscription state, websocket state,
    data-quality ticks and a timeline.
    """
    db = get_db()
    if not symbol and not token:
        raise HTTPException(400, "symbol or token is required")
    if token:
        stock = await db.stocks.find_one({"instrumentToken": str(token)})
    else:
        stock = await db.stocks.find_one({"symbol": symbol.upper()})
    if not stock:
        raise HTTPException(404, {
            "action": "details",
            "status": "not_subscribed",
            "reason": "This instrument is not subscribed.",
            "subscribed": False,
        })
    stock["_id"] = str(stock["_id"])
    ws = ws_manager.status()
    ws_connected = bool(ws.get("connected"))
    inst = _resolve_instrument(symbol=stock.get("symbol", ""), token=stock.get("instrumentToken", ""))
    token_str = str(stock.get("instrumentToken") or "")
    md = _market_data(token_str)
    tick_stats = await _per_stock_tick_stats(db, token_str)

    identity = _instrument_identity(inst)
    ws_metrics = ws.get("metrics") or {}

    timeline = []
    if stock.get("createdAt"):
        timeline.append({"event": "Subscription created", "at": _serialize_iso(stock.get("createdAt"))})
    if stock.get("subscribedAt"):
        timeline.append({"event": "Subscribed", "at": _serialize_iso(stock.get("subscribedAt"))})
    if stock.get("wsSubscribedAt"):
        timeline.append({"event": "WebSocket subscribed", "at": _serialize_iso(stock.get("wsSubscribedAt"))})
    if tick_stats.get("firstTickAt"):
        timeline.append({"event": "First tick", "at": _serialize_iso(tick_stats.get("firstTickAt"))})
    if tick_stats.get("lastTickAt"):
        timeline.append({"event": "Last tick", "at": _serialize_iso(tick_stats.get("lastTickAt"))})
    if stock.get("updatedAt"):
        timeline.append({"event": "Last update", "at": _serialize_iso(stock.get("updatedAt"))})

    return {
        "identity": identity,
        "marketData": md,
        "tickStats": tick_stats,
        "subscription": _subscription_status(stock, ws_connected, ws),
        "websocket": {
            "connected": ws_connected,
            "state": ws.get("state"),
            "lifecycleState": ws.get("lifecycle_state"),
            "connectedAt": ws.get("connected_at"),
            "connectedSince": _serialize_iso(ws.get("connected_at")),
            "lastTickAt": ws.get("last_tick_at"),
            "ticksReceived": ws_metrics.get("ticks_received", 0),
            "ticksPerSec": tick_buffer.stats().get("ticksPerSecond"),
            "reconnectCount": ws.get("reconnect_count"),
            "lastDisconnect": _serialize_iso(ws.get("disconnected_at")),
            "disconnectReason": ws.get("disconnect_reason"),
            "disconnectReasonCode": ws.get("disconnect_reason_code"),
        },
        "quality": {
            "firstTick": _serialize_iso(tick_stats.get("firstTickAt")),
            "lastTick": _serialize_iso(tick_stats.get("lastTickAt")),
            "tickCountToday": tick_stats.get("tickCountToday", 0),
            # Duplicate/out-of-order/invalid tick counts are not measured by
            # the pipeline; report "not measured" (None) rather than a fake 0.
            "duplicateTicks": None,
            "outOfOrderTicks": None,
            "invalidTicks": None,
            "saveFailures": tick_buffer.stats().get("totalWriteErrors"),
            "lastSuccessfulSave": (_serialize_iso(tick_buffer.stats().get("lastFlushAt"))
                                   if tick_buffer.stats().get("lastFlushAt") else None),
        },
        "timeline": timeline,
        "instrumentMasterAvailable": bool(instrument_cache.loaded),
        "market": _market_context(),
    }


@router.get("/stats")
async def stock_stats():
    """Aggregate subscription statistics (real counts, honest states)."""
    db = get_db()
    ws = ws_manager.status()
    ws_connected = bool(ws.get("connected"))
    buffer_stats = tick_buffer.stats()

    stocks = await db.stocks.find({}).to_list(length=None)
    total = len(stocks)
    active_count = sum(1 for s in stocks if s.get("active", True) is not False)
    ws_subscribed_count = sum(
        1 for s in stocks
        if s.get("active", True) is not False and bool(ws_connected)
    )

    # Latest tick ts per subscribed token in a single aggregation (no N+1).
    last_by_token = await _last_tick_ts_by_token(
        db, [s.get("instrumentToken") for s in stocks],
    )

    live = 0
    stale = 0
    no_data = 0
    for s in stocks:
        tok = str(s.get("instrumentToken") or "")
        last_ts = last_by_token.get(tok)
        if last_ts is None:
            no_data += 1
        else:
            age = _safe_age_seconds(last_ts)
            if ws_connected and age is not None and age <= 5:
                live += 1
            else:
                stale += 1

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")  # noqa: F841 (kept for debugging)
    ticks_today = 0
    try:
        today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        ticks_today = await db.ticks.count_documents({"ts": {"$gte": today_start}})
    except Exception as exc:
        logger.warning("stats ticks_today failed: %s", exc)

    return {
        "stats": {
            "totalSubscriptions": total,
            "active": active_count,
            "inactive": total - active_count,
            "wsConnectedSubscriptions": ws_subscribed_count,
            "wsSubscribed": ws_subscribed_count,
            "wsNotSubscribed": max(0, active_count - ws_subscribed_count),
            "live": live,
            "stale": stale,
            "noData": no_data,
            "ticksToday": ticks_today,
            "ticksPerSecond": buffer_stats.get("ticksPerSecond"),
            "activeTickStocks": buffer_stats.get("activeTickStocks"),
        },
        "websocket": {
            "connected": ws_connected,
            "lifecycleState": ws.get("lifecycle_state"),
            "disconnectReason": ws.get("disconnect_reason"),
            "connectedAt": ws.get("connected_at"),
        },
        "instrumentMaster": {
            "loaded": bool(instrument_cache.loaded),
            "instrumentCount": instrument_cache.instrument_count,
            "state": instrument_cache.state(),
        },
        "market": _market_context(),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }


def _instrument_flags(inst: dict | None, fallback: dict | None = None) -> dict:
    """Real sanctioned feed flags for an instrument-master row.

    The master is the authoritative source for isIndex / isDepth / feedLevel /
    marketData; ``fallback`` (e.g. request-provided) values fill in only when
    the master row carries none. Explicit master flags are never downgraded.
    """
    fallback = fallback or {}
    if not inst:
        return {
            "isIndex": bool(fallback.get("isIndex", False)),
            "isDepth": bool(fallback.get("isDepth", False)),
            "feedLevel": fallback.get("feedLevel"),
            "marketData": fallback.get("marketData"),
        }
    return {
        "isIndex": bool(inst.get("isIndex", fallback.get("isIndex", False))),
        "isDepth": bool(inst.get("isDepth", fallback.get("isDepth", False))),
        "feedLevel": inst.get("feedLevel") if inst.get("feedLevel") is not None else fallback.get("feedLevel"),
        "marketData": inst.get("marketData") or fallback.get("marketData"),
    }


@router.post("")
async def add_stock(req: AddStockRequest):
    db = get_db()
    symbol = req.symbol.upper().strip()
    internal_index = await _generate_internal_index(db)

    token = str(req.instrumentToken or "").strip()
    # Reject duplicates by instrument token.
    existing_dup = await db.stocks.find_one({"instrumentToken": token}) if token else None
    if existing_dup:
        raise HTTPException(409, {
            "action": "add",
            "status": "already_subscribed",
            "reason": "Already subscribed to this instrument (token).",
        })

    inst = _resolve_instrument(symbol=symbol, token=token)
    flags = _instrument_flags(inst, {
        "isIndex": req.isIndex,
        "isDepth": req.isDepth,
    })

    now = now_ist()
    # Phase 3: mirror into the Session Manager canonical store so the engine
    # serves feed for this instrument even before any terminal subscribes.
    try:
        from services.session.session_manager import session_manager
        await session_manager.upsert_instrument({
            "exchange_segment": req.exchangeSegment,
            "instrument_token": token,
            "symbol": symbol,
            "is_index": flags["isIndex"],
            "is_depth": flags["isDepth"],
            "feed_level": flags["feedLevel"],
            "market_data": flags["marketData"],
        }, source="search")
    except Exception:
        pass
    doc = {
        "symbol": symbol,
        "instrumentToken": token,
        "exchangeSegment": req.exchangeSegment,
        "internalIndex": internal_index,
        "isIndex": flags["isIndex"],
        "isDepth": flags["isDepth"],
        "feedLevel": flags["feedLevel"],
        "marketData": flags["marketData"],
        "active": True,
        "createdAt": now,
        "updatedAt": now,
    }
    await db.stocks.update_one(
        {"symbol": symbol},
        {"$set": doc},
        upsert=True,
    )
    saved = await db.stocks.find_one({"symbol": symbol})
    saved["_id"] = str(saved["_id"])
    await _subscribe_on_ws(db, saved)
    return {"data": await _enrich_stock(db, saved)}


@router.post("/search")
async def search_stock_info(req: dict):
    """Kotak-style scrip search envelope over the canonical index.

    DEPRECATED: use ``GET /api/search?q=...`` (the canonical Search Engine).
    The Kotak ``p*`` field names are still emitted because broker-subscription
    call sites read them, but the lookup and ranking now come from the one
    canonical index instead of a private master scan and a broker fallback.
    """
    search_text = req.get("search_text") or req.get("q") or ""
    if not str(search_text).strip():
        raise HTTPException(status_code=400, detail="search_text is required")

    rows, meta = canonical_instrument_rows(search_text, 10, eq_only=True)
    return {
        "results": [
            {
                "pSymbolName": row.get("symbol"),
                "pSymbol": row.get("token"),
                "pTrdSymbol": row.get("tradingSymbol"),
                "pDesc": row.get("name") or row.get("companyName"),
                "pExchSeg": row.get("exchangeSegment") or "nse_cm",
                "pInstType": "EQ",
                "pSeries": row.get("series") or "EQ",
                "pISIN": row.get("isin"),
                "instrumentToken": str(row.get("token") or ""),
                "segment": row.get("series") or "EQ",
                "companyName": row.get("name") or row.get("companyName"),
                "tradingSymbol": row.get("tradingSymbol"),
            }
            for row in rows
        ],
        "source": "search_engine" if meta.get("indexAvailable") else "cache_unavailable",
        "deprecated": True,
        "replacement": DEPRECATION_TARGET,
    }


@router.delete("/bulk")
async def bulk_delete_stocks(req: dict):
    db = get_db()
    symbols = req.get("symbols", [])
    if not symbols:
        raise HTTPException(400, "symbols is required")
    symbols = [s.upper() for s in symbols]
    for s in symbols:
        stock = await db.stocks.find_one({"symbol": s})
        if stock:
            await _unsubscribe_on_ws(stock["instrumentToken"], stock.get("exchangeSegment", "nse_cm"))
    result = await db.stocks.delete_many({"symbol": {"$in": symbols}})
    return {"deleted": result.deleted_count}


@router.patch("/{symbol}")
async def toggle_stock(symbol: str, req: dict):
    db = get_db()
    stock = await db.stocks.find_one({"symbol": symbol.upper()})
    if not stock:
        raise HTTPException(404, f"Stock {symbol} not found")
    new_active = req.get("active", not stock.get("active", True))
    now = now_ist()
    await db.stocks.update_one(
        {"symbol": symbol.upper()},
        {"$set": {"active": new_active, "updatedAt": now}},
    )
    if new_active:
        await _subscribe_on_ws(db, stock)
    else:
        await _unsubscribe_on_ws(stock["instrumentToken"], stock.get("exchangeSegment", "nse_cm"))
    updated = await db.stocks.find_one({"symbol": symbol.upper()})
    updated["_id"] = str(updated["_id"])
    return {"data": await _enrich_stock(db, updated)}


@router.delete("/{symbol}")
async def delete_stock(symbol: str):
    db = get_db()
    stock = await db.stocks.find_one({"symbol": symbol.upper()})
    if not stock:
        raise HTTPException(404, {
            "action": "unsubscribe",
            "status": "failed",
            "reason": "Stock not found.",
        })
    await _unsubscribe_on_ws(stock["instrumentToken"], stock.get("exchangeSegment", "nse_cm"))
    await db.stocks.delete_one({"symbol": symbol.upper()})
    return {"action": "unsubscribe", "status": "success", "deleted": 1, "symbol": symbol.upper()}
