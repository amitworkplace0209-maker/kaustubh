"""Dummy Trading Terminal API — the Dummy terminal's own read/write surface.

Backed by ``services.dummy_extras`` (terminal-scoped state, ``terminal=dummy``)
and by the authoritative paper engine in ``api/demo.py`` for orders, positions,
funds and settlement. All market reads use the broker-free market calendar.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services import dummy_extras as dex
from services import read_cache

logger = logging.getLogger("app")
router = APIRouter(prefix="/api/dummy", tags=["dummy-terminal"])

#: The combined state poll is read-only; a short cache makes repeated polls
#: from several mounted panels share ONE Mongo read instead of queuing a new
#: one per panel. Every paper-engine write invalidates the key. The UI polls
#: every 2-3 s, so a 2 s bound adds no visible staleness beyond that cadence.
_STATE_CACHE_TTL_S = 2.0
_STATE_DOC_KEYS = (
    "demo_account", "demo_positions", "demo_orders",
    dex.KEY_NOTIFICATIONS, dex.KEY_TARGETS, dex.KEY_ALERTS,
)

#: Read-only endpoints need the active daily session, but not fresh counters.
#: Caching that existence check for a few seconds removes one Atlas round trip
#: from every positions/notifications/prefs/report poll. Write paths call
#: ``_ensure_session(refresh_counters=True)`` and never read this entry.
_SESSION_READ_CACHE_KEY = "dummy:session-read"
_SESSION_READ_CACHE_TTL_S = 3.0


async def _ensure_session_uncached(refresh_counters: bool) -> dict:
    from services.dummy_session import ensure_dummy_session
    return await ensure_dummy_session(refresh_counters=refresh_counters)


async def _ensure_session(refresh_counters: bool = True) -> dict:
    """Idempotent open of the current Dummy daily session (09:00 IST reset).

    Every Dummy terminal read/write flows through this so the operational
    store always belongs to the current trading date. Non-fatal by contract:
    when the lifecycle is unavailable the endpoint continues (reads degrade to
    the engine's own store fallback) instead of 500-ing the whole terminal.
    """
    try:
        if refresh_counters:
            # A write path may have changed the session document; the next
            # read must observe it immediately.
            read_cache.invalidate(_SESSION_READ_CACHE_KEY)
            return await _ensure_session_uncached(True)
        return await read_cache.get(
            _SESSION_READ_CACHE_KEY,
            lambda: _ensure_session_uncached(False),
            ttl=_SESSION_READ_CACHE_TTL_S,
        )
    except Exception as exc:
        logger.warning("dummy session ensure skipped: %s", exc)
        return {}


def _bad(exc: Exception) -> HTTPException:
    if isinstance(exc, HTTPException):
        return exc
    return HTTPException(400, str(exc))


# ---- request models ---------------------------------------------------------
class BasketLeg(BaseModel):
    symbol: str
    tradingSymbol: str = ""
    exchange: str = "nse_cm"
    exchangeSegment: str = "NSE_CM"
    token: str = ""
    transactionType: str = "BUY"
    product: str = "MIS"
    orderType: str = "MKT"
    quantity: int
    price: float = 0
    triggerPrice: float = 0


class BasketPolicy(BaseModel):
    mode: str = "ALL"
    minimum: int = 0


class BasketCreate(BaseModel):
    name: str
    legs: list[BasketLeg]
    policy: Optional[BasketPolicy] = None
    expirySeconds: int = 0
    instructions: str = ""


class BasketExecute(BaseModel):
    basketId: str = ""
    inline: bool = False
    legs: list[BasketLeg] = []
    policy: Optional[BasketPolicy] = None
    ltpMap: Optional[dict] = None
    terminal: str = ""


class AlertCreate(BaseModel):
    symbol: str
    condition: str = "ABOVE"
    price: float
    cooldownSec: int = 0
    note: str = ""


class TargetCreate(BaseModel):
    symbol: str
    targetType: str = "PERCENT"
    value: float
    direction: str = "PROFIT"
    autoExecute: bool = True


class NotifyRead(BaseModel):
    id: str = ""


class PrefsUpdate(BaseModel):
    autoRefreshMs: Optional[int] = None
    defaultProduct: Optional[str] = None
    defaultOrderType: Optional[str] = None
    defaultBasketPolicy: Optional[str] = None
    confirmBasketExecute: Optional[bool] = None
    alertCooldownSec: Optional[int] = None
    autoSquareOffOnTarget: Optional[bool] = None
    retentionDays: Optional[int] = None
    slippageBps: Optional[int] = None
    maxDailyOrders: Optional[int] = None
    maxOrderValue: Optional[float] = None
    startingCapital: Optional[float] = None
    notificationDelivery: Optional[dict] = None


class PreviewOrder(BaseModel):
    symbol: str
    tradingSymbol: str = ""
    exchange: str = "nse_cm"
    exchangeSegment: str = "NSE_CM"
    token: str = ""
    transactionType: str = "BUY"
    product: str = "MIS"
    orderType: str = "MKT"
    quantity: int
    price: float = 0
    triggerPrice: float = 0
    ltp: float = 0


class WatchlistSymbol(BaseModel):
    symbol: str
    tradingSymbol: str = ""
    exchange: str = "nse_cm"
    exchangeSegment: str = "NSE_CM"
    token: str = ""


class WatchlistCreate(BaseModel):
    name: str
    symbols: Optional[list[WatchlistSymbol]] = None


class WatchlistSymbolAdd(BaseModel):
    symbol: WatchlistSymbol


class WatchlistSymbolRemove(BaseModel):
    symbol: str


class CalendarEventCreate(BaseModel):
    date: str
    category: str = "PERSONAL"
    title: str
    note: str = ""
    pinned: bool = False
    reminderMinutes: Optional[int] = None


class CalendarEventUpdate(BaseModel):
    date: Optional[str] = None
    category: Optional[str] = None
    title: Optional[str] = None
    note: Optional[str] = None
    pinned: Optional[bool] = None
    reminderMinutes: Optional[int] = None


class ModifyOrder(BaseModel):
    orderId: str
    price: float = 0
    triggerPrice: float = 0
    quantity: int = 0


class SuggestionReceive(BaseModel):
    symbol: str
    direction: str = "BUY"
    confidence: float = 50
    quantity: int = 1
    entry: float = 0
    target: float = 0
    stopLoss: float = 0
    expectedValue: float = 0
    risk: float = 0
    model: str = ""
    source: str = "KHUMBHA_AI"
    type: str = "NORMAL"
    legs: list[BasketLeg] = []
    reason: str = ""
    product: str = "MIS"
    orderType: str = "MKT"
    expiry: str = ""
    autoProcess: bool = True


class SuggestionReject(BaseModel):
    reason: str = ""


# ---- suggestion pipeline (Khumbha AI future integration) ----------------------
@router.get("/suggestions")
async def dummy_suggestions(status: str = "", limit: int = 100):
    items = await dex.get_suggestions()
    if status and status.upper() != "ALL":
        items = [s for s in items if str(s.get("status") or "").upper() == status.upper()]
    return {
        "ok": True,
        "data": items[: max(1, min(int(limit), 200))],
        "pipeline": list(dex.SUGGESTION_PIPELINE),
        "statuses": list(dex.SUGGESTION_STATUSES),
    }


@router.post("/suggestions")
async def dummy_suggestion_receive(body: SuggestionReceive):
    try:
        suggestion = await dex.receive_suggestion(body.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if body.autoProcess:
        try:
            suggestion = await dex.process_suggestion(suggestion["id"])
        except Exception as exc:
            raise _bad(exc) from exc
    return {"ok": True, "suggestion": suggestion}


@router.post("/suggestions/{suggestion_id}/process")
async def dummy_suggestion_process(suggestion_id: str, body: dict):
    ltp_map = (body or {}).get("ltpMap") or None
    try:
        suggestion = await dex.process_suggestion(suggestion_id, ltp_map)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True, "suggestion": suggestion}


@router.post("/suggestions/{suggestion_id}/reject")
async def dummy_suggestion_reject(suggestion_id: str, body: Optional[SuggestionReject] = None):
    try:
        suggestion = await dex.reject_suggestion(suggestion_id, (body or SuggestionReject()).reason)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True, "suggestion": suggestion}


@router.delete("/suggestions/{suggestion_id}")
async def dummy_suggestion_delete(suggestion_id: str):
    if not await dex.delete_suggestion(suggestion_id):
        raise HTTPException(404, f"suggestion {suggestion_id} not found")
    return {"ok": True}


# ---- combined state ----------------------------------------------------------
async def _build_dummy_state() -> dict:
    """Build the combined snapshot from a SINGLE settings read.

    The old implementation made ~15 sequential Atlas round trips (session
    ensure + account + positions + orders + notifications + risk, where risk
    re-read account/positions/orders/alerts/targets). It now reads the six
    documents it needs in one query and derives risk + session counters from
    those same rows. Read-only: the session is not written on a GET.
    """
    from api.demo import (
        _positions_trading_today,
        _ROLLOVER_PRODUCTS,
        get_dummy_account,
        get_dummy_positions,
        position_visible_in_positions,
    )
    from services.dummy_session import _session_summary, session_date_for, session_snapshot

    # The session existence check and the six-document state read are
    # independent. Run them together: on Atlas each round trip is expensive and
    # the old sequential pair doubled every poll. If the session loader had to
    # create/reset the operational store, the concurrent read may predate that
    # write, so re-read once in that (once-per-day) case.
    session, docs = await asyncio.gather(
        _ensure_session(refresh_counters=False),
        dex.get_settings_many(list(_STATE_DOC_KEYS)),
    )
    session_day = session_date_for(dex._now_utc())
    if session and str(session.get("trading_date") or "") != session_day:
        docs = await dex.get_settings_many(list(_STATE_DOC_KEYS))

    account = docs.get("demo_account")
    if not isinstance(account, dict):
        # First run after a wipe: create the default account (one write).
        account = await get_dummy_account()

    raw_positions = docs.get("demo_positions")
    positions = raw_positions if isinstance(raw_positions, list) else []
    today = _positions_trading_today()
    needs_roll = any(
        str(p.get("tradingDate") or today) < today
        and int(p.get("netQuantity") or 0) != 0
        and str(p.get("product") or "MIS").upper() in _ROLLOVER_PRODUCTS
        for p in positions
    )
    needs_stamp = any(not p.get("tradingDate") for p in positions)
    ghosts = any(int(p.get("netQuantity") or 0) == 0 for p in positions)
    if needs_roll or needs_stamp or ghosts:
        # Rare maintenance path (day rollover / legacy rows): reuse the
        # canonical writer so the same rules apply everywhere.
        positions = await get_dummy_positions()

    # CASH longs settle into Holdings, never into Positions; zero-net rows are
    # closed-by-trade leftovers and belong to the closed trail only.
    positions = [
        p for p in positions
        if position_visible_in_positions(p) and int(p.get("netQuantity") or 0) != 0
    ]
    orders = docs.get("demo_orders") or []
    notification_items = dex.filter_today_notifications(docs.get(dex.KEY_NOTIFICATIONS) or [])
    targets = docs.get(dex.KEY_TARGETS) or []
    alerts = docs.get(dex.KEY_ALERTS) or []

    return {
        "ok": True,
        "terminal": "dummy",
        "account": account,
        "positions": positions,
        "orders": orders,
        "risk": dex.risk_from_components(account, positions, orders, alerts, targets),
        "market": dex.market_snapshot(),
        "unreadNotifications": sum(1 for n in notification_items if not n.get("read")),
        "targets": targets,
        "alerts": alerts,
        "nowUtc": dex._now_utc().isoformat(),
        "session": await session_snapshot(
            session,
            _session_summary(session, account, positions, orders, notification_items),
        ),
    }


@router.get("/state")
async def dummy_state():
    return await read_cache.get("dummy:state", _build_dummy_state, ttl=_STATE_CACHE_TTL_S)


# ---- daily session lifecycle ---------------------------------------------------
@router.get("/session")
async def dummy_session():
    from services.dummy_session import session_snapshot

    # ``_ensure_session`` already returns the current document (including the
    # throttled counter patch). Calling ``current_session`` re-ran ensure and
    # re-read the same document for no additional information.
    session = await _ensure_session()
    return {
        "ok": True,
        "session": await session_snapshot(session),
        "istNow": dex._now_ist().isoformat(),
    }


@router.post("/session/reset")
async def dummy_session_reset(body: dict):
    from services.dummy_session import reset_dummy_session, session_snapshot

    await _ensure_session()
    capital = (body or {}).get("startingCapital")
    force = bool((body or {}).get("force", False))
    try:
        session = await reset_dummy_session(capital, force=force)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True, "session": await session_snapshot(dict(session))}


# ---- portfolio / holdings / risk / history -----------------------------------
@router.get("/portfolio")
async def dummy_portfolio():
    await _ensure_session(refresh_counters=False)
    return {"ok": True, **await dex.portfolio_summary()}


@router.get("/holdings")
async def dummy_holdings():
    await _ensure_session(refresh_counters=False)
    return {"ok": True, **await dex.holdings_summary()}


@router.get("/risk")
async def dummy_risk():
    # Risk is already part of the authoritative state snapshot. Serving it from
    # the same short-TTL single-flight cache avoids a second, independent read
    # of account/positions/orders/alerts/targets when the Risk page (or a
    # consumer panel) polls alongside ``/state``.
    state = await read_cache.get("dummy:state", _build_dummy_state, ttl=_STATE_CACHE_TTL_S)
    return {"ok": True, **state["risk"]}


@router.get("/history")
async def dummy_history(days: int = 7):
    await _ensure_session(refresh_counters=False)
    return {"ok": True, **await dex.history_series(days)}


@router.post("/maintenance/retention")
async def dummy_retention(cutoffDays: int = 7):
    try:
        purged = await dex.apply_retention(cutoff_days=max(1, min(int(cutoffDays), 30)))
    except Exception as exc:
        raise _bad(exc) from exc
    return {"ok": True, "purged": purged}


# ---- market session / calendar ------------------------------------------------
@router.get("/market-session")
async def dummy_market_session():
    await _ensure_session(refresh_counters=False)
    return {"ok": True, **dex.market_snapshot()}


@router.get("/calendar")
async def dummy_calendar():
    await _ensure_session(refresh_counters=False)
    return {"ok": True, **dex.calendar_payload()}


# ---- baskets ------------------------------------------------------------------
@router.get("/baskets")
async def dummy_baskets():
    await _ensure_session(refresh_counters=False)
    return {"ok": True, "data": await dex.get_baskets()}


@router.post("/baskets")
async def dummy_basket_create(body: BasketCreate):
    await _ensure_session()
    try:
        basket = await dex.create_basket(
            body.name,
            [leg.model_dump() for leg in body.legs],
            body.policy.model_dump() if body.policy else None,
            body.expirySeconds,
            body.instructions,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True, "basket": basket}


@router.delete("/baskets/{basket_id}")
async def dummy_basket_delete(basket_id: str):
    removed = await dex.delete_basket(basket_id)
    if not removed:
        raise HTTPException(404, f"basket {basket_id} not found")
    return {"ok": True}


@router.post("/baskets/execute")
async def dummy_basket_execute(body: BasketExecute):
    await _ensure_session()
    try:
        if body.inline:
            result = await dex.execute_inline_basket(
                [leg.model_dump() for leg in body.legs],
                body.policy.model_dump() if body.policy else None,
                body.ltpMap or None,
            )
        else:
            if not body.basketId:
                raise HTTPException(400, "basketId required (or inline=true with legs)")
            result = await dex.execute_basket(body.basketId, body.ltpMap or None)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True, **result}


# ---- alerts -------------------------------------------------------------------
@router.get("/alerts")
async def dummy_alerts():
    return {"ok": True, "data": await dex.get_alerts()}


@router.post("/alerts")
async def dummy_alert_create(body: AlertCreate):
    try:
        alert = await dex.create_alert(body.symbol, body.condition, body.price, body.cooldownSec, body.note)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True, "alert": alert}


@router.delete("/alerts/{alert_id}")
async def dummy_alert_delete(alert_id: str):
    removed = await dex.delete_alert(alert_id)
    if not removed:
        raise HTTPException(404, f"alert {alert_id} not found")
    return {"ok": True}


# ---- targets -------------------------------------------------------------------
@router.get("/targets")
async def dummy_targets():
    return {"ok": True, "data": await dex.get_targets()}


@router.post("/targets")
async def dummy_target_create(body: TargetCreate):
    try:
        target = await dex.set_target(body.symbol, body.targetType, body.value, body.direction, body.autoExecute)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True, "target": target}


@router.delete("/targets/{target_id}")
async def dummy_target_delete(target_id: str):
    removed = await dex.delete_target(target_id)
    if not removed:
        raise HTTPException(404, f"target {target_id} not found")
    return {"ok": True}


# ---- notifications ---------------------------------------------------------------
@router.get("/notifications")
async def dummy_notifications(category: str = "", limit: int = 100):
    await _ensure_session(refresh_counters=False)
    return {"ok": True, **await dex.list_notifications(category, limit)}


@router.post("/notifications/read")
async def dummy_notify_read(body: NotifyRead):
    ok = await dex.mark_notification_read(body.id)
    if not ok:
        raise HTTPException(404, f"notification {body.id} not found")
    return {"ok": True}


@router.post("/notifications/read-all")
async def dummy_notify_read_all():
    return {"ok": True, "touched": await dex.mark_all_notifications_read()}


@router.delete("/notifications/{nid}")
async def dummy_notify_delete(nid: str):
    removed = await dex.delete_notification(nid)
    if not removed:
        raise HTTPException(404, f"notification {nid} not found")
    return {"ok": True}


@router.delete("/notifications")
async def dummy_notify_clear():
    return {"ok": True, "cleared": await dex.clear_notifications()}


# ---- preferences -----------------------------------------------------------------
@router.get("/prefs")
async def dummy_prefs():
    return {"ok": True, "prefs": await dex.get_prefs()}


@router.post("/prefs")
async def dummy_prefs_update(body: PrefsUpdate):
    return {"ok": True, "prefs": await dex.update_prefs(body.model_dump(exclude_none=True))}


# ---- order maintenance (resting order modify) -------------------------------------
@router.post("/order/modify")
async def dummy_order_modify(body: ModifyOrder):
    """Modify a working paper order THROUGH the Order Engine.

    Risk → Audit → Adapter, like every other order action. The engine's risk
    gate is what stops an invalid modification (e.g. a stop order left without a
    trigger) from reaching the paper book.
    """
    await _ensure_session()
    from brokers.models import BrokerError
    from core.engines import order_engine

    try:
        result = await order_engine.modify("dummy", body.orderId, {
            "exchange": "nse_cm",
            "transaction_type": "BUY",
            "product": "MIS",
            "order_type": "MKT",
            "quantity": str(body.quantity or 0),
            "price": str(body.price or 0),
            "trigger_price": str(body.triggerPrice or 0),
        })
    except BrokerError as exc:
        raise HTTPException(400, exc.message) from exc
    if not result.get("ok"):
        err = result.get("error") or {}
        status = 404 if "not found" in str(err.get("message", "")).lower() else 400
        raise HTTPException(status, err.get("message") or "; ".join(result.get("reasons") or []) or "modify rejected")
    return {"ok": True, **result}


# ---- order preview (server-side charges / margin estimate) --------------------------
@router.post("/preview")
async def dummy_preview(body: PreviewOrder):
    await _ensure_session(refresh_counters=False)
    from api.demo import _calculate_charges, get_dummy_account

    quantity = max(1, int(body.quantity or 0))
    side = body.transactionType.upper()
    if side not in ("BUY", "SELL"):
        raise HTTPException(400, "transactionType must be BUY or SELL")
    ltp = float(body.ltp or 0)
    price_est = float(body.price or 0)
    if ltp <= 0 and price_est <= 0:
        raise HTTPException(400, "ltp or price required for estimate")
    base = price_est or ltp
    value = round(round(base, 2) * quantity, 2)
    # Delivery-aware charges: CASH settles like CNC (STT both sides, stamp on BUY).
    charges = _calculate_charges(side, round(base, 2), quantity, body.product)
    factor = 0.2 if body.product == "MIS" else 1.0
    margin_required = round(value * factor, 2)
    account = await get_dummy_account()
    free_margin = float(account.get("freeMargin", 0) or 0)
    after = round(free_margin - margin_required, 2)
    return {
        "ok": True,
        "symbol": body.symbol.strip().upper(),
        "side": side,
        "product": body.product,
        "orderType": body.orderType,
        "quantity": quantity,
        "estimatedPrice": round(base, 2),
        "baseValue": value,
        "charges": charges,
        "marginFactor": factor,
        "marginRequired": margin_required,
        "freeMargin": free_margin,
        "remainingAfterBuy": after,
        "sufficient": after >= 0 or side == "SELL",
    }


# ---- open + closed positions --------------------------------------------------------
@router.get("/positions")
async def dummy_positions(date: str = ""):
    """Today's positions page: open (post-rollover) + closed scoped to one
    trading date. ``date`` defaults to today (IST, 08:30 cutoff); pass an
    explicit YYYY-MM-DD to read history."""
    await _ensure_session(refresh_counters=False)
    from api.demo import _positions_trading_today, get_dummy_positions, position_visible_in_positions

    day = (date or "").strip() or _positions_trading_today()
    # The open book and the closed trail are independent reads. Run them
    # together: on Atlas this removes one full round trip from every poll of
    # the Positions page. The session ensure above stays sequential because it
    # may reset the operational store at the date boundary.
    raw_positions, closed = await asyncio.gather(
        get_dummy_positions(),
        dex.list_closed_positions(limit=200, date=day),
    )
    open_positions = [p for p in raw_positions if position_visible_in_positions(p)]
    return {
        "ok": True,
        "tradingDate": day,
        "open": [p for p in open_positions if p.get("netQuantity", 0) != 0],
        "closed": closed,
    }


# ---- P&L reports (daily / weekly / monthly, permanent MongoDB stores) -----------
@router.get("/reports")
async def dummy_reports(range: str = "daily", limit: int = 60):
    """Day-wise P&L table (realized, charges, net, orders, turnover) with
    weekly/monthly aggregation. Daily rows come from the closed-session
    archive (frozen book) plus today's live book — all persisted in MongoDB."""
    await _ensure_session(refresh_counters=False)
    return {"ok": True, **await dex.build_pnl_reports(range, limit)}


# ---- broker comparison (read-only) ---------------------------------------------------
@router.get("/comparison")
async def dummy_comparison():
    await _ensure_session(refresh_counters=False)
    return {"ok": True, **await dex.build_terminal_comparison()}


# ---- audit trail ---------------------------------------------------------------------
@router.get("/audit")
async def dummy_audit(category: str = "", limit: int = 100):
    return {"ok": True, "data": await dex.list_audit(category, limit)}


# ---- watchlists (multi-list, terminal-scoped) ----------------------------------------
@router.get("/watchlists")
async def dummy_watchlists():
    await _ensure_session(refresh_counters=False)
    return {"ok": True, **await dex.list_watchlists()}


@router.post("/watchlists")
async def dummy_watchlist_create(body: WatchlistCreate):
    try:
        watchlist = await dex.create_watchlist(
            body.name[:60],
            [s.model_dump() for s in (body.symbols or [])],
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True, "watchlist": watchlist}


@router.delete("/watchlists/{watchlist_id}")
async def dummy_watchlist_delete(watchlist_id: str):
    try:
        removed = await dex.delete_watchlist(watchlist_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not removed:
        raise HTTPException(404, f"watchlist {watchlist_id} not found")
    return {"ok": True}


@router.post("/watchlists/active")
async def dummy_watchlist_set_active(body: dict):
    list_id = str((body or {}).get("id") or "")
    if not await dex.set_active_watchlist(list_id):
        raise HTTPException(404, f"watchlist {list_id} not found")
    return {"ok": True}


@router.post("/watchlists/{watchlist_id}/symbols")
async def dummy_watchlist_add_symbol(watchlist_id: str, body: WatchlistSymbolAdd):
    try:
        added = await dex.add_watchlist_symbol(watchlist_id, body.symbol.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not added:
        raise HTTPException(404, f"watchlist {watchlist_id} not found")
    return {"ok": True}


@router.post("/watchlists/{watchlist_id}/symbols/remove")
async def dummy_watchlist_remove_symbol(watchlist_id: str, body: WatchlistSymbolRemove):
    removed = await dex.remove_watchlist_symbol(watchlist_id, body.symbol)
    if not removed:
        raise HTTPException(404, f"symbol {body.symbol!r} not in watchlist {watchlist_id}")
    return {"ok": True}


# ---- calendar events (terminal-scoped, layered over the market calendar) --------------
@router.get("/calendar-events")
async def dummy_calendar_events(date_from: str = "", date_to: str = ""):
    await _ensure_session(refresh_counters=False)
    return {"ok": True, "data": await dex.list_calendar_events(date_from, date_to)}


@router.post("/calendar-events")
async def dummy_calendar_event_create(body: CalendarEventCreate):
    try:
        event = await dex.create_calendar_event(
            body.date, body.category, body.title, body.note, body.pinned, body.reminderMinutes,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True, "event": event}


@router.patch("/calendar-events/{event_id}")
async def dummy_calendar_event_update(event_id: str, body: CalendarEventUpdate):
    try:
        event = await dex.update_calendar_event(event_id, body.model_dump(exclude_none=True))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if event is None:
        raise HTTPException(404, f"event {event_id} not found")
    return {"ok": True, "event": event}


@router.delete("/calendar-events/{event_id}")
async def dummy_calendar_event_delete(event_id: str):
    if not await dex.delete_calendar_event(event_id):
        raise HTTPException(404, f"event {event_id} not found")
    return {"ok": True}