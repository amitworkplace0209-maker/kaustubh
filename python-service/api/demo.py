"""Dummy Trading Engine â€” the SINGLE authoritative server-side paper engine.

This module is the only place dummy-mode orders, positions, virtual balance
and the funds ledger are executed and persisted (MongoDB via ``app_settings``).

Broker-style execution model (PENDING-first, LTP-matched):
  * Every order is ACCEPTED into the engine first as a working order
    (``PENDING`` for market, ``OPEN`` for limit, ``TRIGGER_PENDING`` for
    stop) â€” one orderId for the full lifecycle, exactly like a real broker
    that acknowledges a placement before it fills.
  * The fill price is resolved SERVER-SIDE with full websocket + instrument
    access: the live WS#1 tick buffer (``services.tick_buffer``, the same
    real broker feed the Paper Market Feed pumps) wins, then the last known
    real LTP, then the caller-observed LTP. Nothing is ever fabricated â€” with
    no live price the order stays working until a real tick makes it
    marketable (via ``PaperMarketFeed`` or the ``/api/demo/ltp`` funnel).
  * A marketable order fills in the same call at that instant's live LTP
    (Â± slippage); a non-marketable one rests PENDING and is (re)filled when
    the websocket moves. MKT fills at the real LTP with a fixed Â±0.1%
    slippage, LMT fills only when marketable (else rests OPEN), SL/SL-M orders
    fill only after the live LTP crosses the trigger. Partial fills fall out
    of the deterministic marketability model. Fund movements are capped and
    validated server-side.

Isolation rules enforced HERE (never in the frontend):
  * Dummy orders are placed through the ``DummyAdapter``/``/api/demo`` ONLY.
    They can never reach the Kotak/Shoonya SDKs because the terminal API
    strictly routes by the ACTIVE terminal and each real adapter requires its
    own real session.
  * Dummy positions/orders/balance are generated and stored by this engine â€”
    none of it is ever read from (or written to) a real broker.
"""
from __future__ import annotations

import asyncio
import contextvars
import logging
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from database.connection import get_db
from services import read_cache

from datetime import timedelta
from core.timezones import IST


def _session_stamps() -> tuple[str, str]:
    """(trading_date, session_id) metadata for records written by this engine.

    Pure additive metadata â€” never affects fill/accounting logic. Best-effort:
    when the daily-session lifecycle is unavailable it degrades to an empty
    stamp so the engine never depends on the lifecycle to record a trade.
    """
    try:
        import services.dummy_session as ds
        trading_date = ds.session_date_for(ds._now_utc())
        return trading_date, f"DUMMY:{trading_date}"
    except Exception:
        return "", ""

logger = logging.getLogger("app")

#: Serializes every positions/orders/account read-modify-write cycle (order
#: fills, resting refills, LTP-funnel saves). Concurrent fills used to
#: interleave loads and saves â€” duplicate closed-trail entries, over-credited
#: realized P&L and resurrected rows.
#:
#: Reentrancy: the LTP funnel holds the lock while target square-offs re-enter
#: _execute_order on the SAME task (asyncio locks are not reentrant). The
#: contextvar marks the holder task so nested entries run inline â€” mutual
#: exclusion against OTHER tasks is still guaranteed by the outer hold.
_FILL_LOCK = asyncio.Lock()
_FILL_HELD: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "_demo_fill_held", default=False)


async def _with_fill_lock(fn, *args, **kwargs):
    """Run ``fn`` with the fill lock unless this task already holds it."""
    if _FILL_HELD.get():
        return await fn(*args, **kwargs)
    token = _FILL_HELD.set(True)
    try:
        async with _FILL_LOCK:
            return await fn(*args, **kwargs)
    finally:
        _FILL_HELD.reset(token)
router = APIRouter(prefix="/api/demo", tags=["demo"])

DEMO_ACCOUNT_KEY = "demo_account"
DEMO_ORDERS_KEY = "demo_orders"
DEMO_POSITIONS_KEY = "demo_positions"
DEMO_TRANSACTIONS_KEY = "demo_transactions"

# Server-side per-transaction cap for dummy fund movements.
MAX_DEMO_TRANSACTION_AMOUNT = 10_000_000

# Deterministic execution model (never fabricated â€” driven by real market LTP):
#   * MKT fills at the real LTP with a fixed Â±0.1% slippage.
#   * LMT fills only when marketable against the live LTP; otherwise the order
#     rests OPEN and is (re)filled when the frontend pushes fresher LTP.
#   * SL / SL-M orders stay TRIGGER_PENDING until the live LTP crosses the
#     trigger, then fill at market (SL-M) or limit (SL).
MKT_SLIPPAGE = 0.001
LMT_TOLERANCE = 0.005

CHARGE_RATES = {
    "brokerage": 0.0003,
    "brokerage_flat": 10,  # â‚¹10 per executed order when DUMMY_FLAT_BROKERAGE is enabled
    "stt_buy": 0.001,
    "stt_sell": 0.00025,
    "exchange_txn": 0.0000345,
    "gst": 0.18,
    "sebi": 0.00001,
    "stamp_duty": 0.000015,
}

# When True, brokerage is flat â‚¹10 per order (centralized config, Dummy Terminal
# business rule). When False, percentage 0.03% is used. No React hard-coding â€”
# this is the single backend charge source for Dummy (mirrors config/brokerage.ts).
import os
DUMMY_FLAT_BROKERAGE = os.getenv("DUMMY_BROKERAGE_MODE", "").lower() == "flat10"
# Also allow runtime override via a marker file or env; default is percentage but
# the engine can be switched to flat without code changes.

# Best-known LTP registry for the dummy terminal â€” populated ONLY from real
# market data the terminal pushed (never fabricated). Used by the adapter's
# quote() so pricing workflows see the last known live price.
_KNOWN_LTP: dict[str, float] = {}


def remember_ltp(symbol: str, price: float) -> None:
    sym = str(symbol or "").strip().upper()
    if sym and price and price > 0:
        _KNOWN_LTP[sym] = float(price)


def known_ltp(symbol: str) -> float:
    return _KNOWN_LTP.get(str(symbol or "").strip().upper(), 0.0)


async def _resolve_server_ltp(symbol: str, token: str = "") -> tuple[float, str]:
    """Authoritative live price for the paper engine â€” full websocket access.

    Resolution order (never fabricated, 0.0/``"none"`` when nothing is known):
      1. ``"ws_tick"`` â€” the backend's own live WS#1 tick buffer
         (``services.tick_buffer``: token-exact, then symbol match), i.e. the
         same real broker feed every terminal shares;
      2. ``"known"`` â€” the last real LTP this engine actually saw
         (``remember_ltp`` registry, fed only by real ticks / observed prices);
      3. ``"last_close"`` â€” the newest stored 1-minute candle close
         (``services.last_price``, cached), i.e. the last price the system
         recorded. This is what makes Dummy mode executable after hours with
         no feed and no browser open.

    The caller-supplied LTP is only a fallback when all three are silent.
    """
    sym = str(symbol or "").strip().upper()
    tok = str(token or "").strip()
    try:
        from services import tick_buffer as _tb
        if tok:
            try:
                live = _tb.latest_ltp(tok)
                if live is not None and float(live) > 0:
                    return float(live), "ws_tick"
            except (TypeError, ValueError):
                pass
        if sym:
            try:
                live = _tb.latest_ltp(sym)
                if live is not None and float(live) > 0:
                    return float(live), "ws_tick"
            except (TypeError, ValueError):
                pass
            try:
                for _tick in _tb.get_latest_ticks().values():
                    if not isinstance(_tick, dict):
                        continue
                    matched = any(
                        str(_tick.get(_sk) or "").strip().upper() == sym
                        for _sk in ("symbol", "tradingSymbol", "trading_symbol")
                    )
                    if not matched:
                        continue
                    for _pk in ("ltp", "lastPrice", "last_price", "lastTradedPrice"):
                        try:
                            _pv = float(_tick.get(_pk) or 0)
                        except (TypeError, ValueError):
                            _pv = 0.0
                        if _pv > 0:
                            return _pv, "ws_tick"
                    break
            except Exception:
                pass
    except Exception:
        pass
    try:
        px = known_ltp(sym)
        if px and px > 0:
            return float(px), "known"
    except Exception:
        pass
    try:
        from services.last_price import last_close
        stored = last_close(tok, sym)
        if stored.get("ltp"):
            return float(stored["ltp"]), "last_close"
    except Exception:
        pass
    return 0.0, "none"


def _resolve_instrument(symbol: str, token: str = "") -> dict:
    """Best-effort canonical instrument from the REAL instrument master.

    Gives the paper engine the same instrument data every other terminal uses
    (fills a missing token/symbol so the broker feed can be subscribed for the
    paper book). Never rejects â€” ``{}`` when the master is unavailable, in
    which case the order proceeds with exactly what the caller sent.
    """
    try:
        from services.instrument_cache import instrument_cache
        if not instrument_cache.loaded:
            return {}
        if token:
            inst = instrument_cache.lookup_by_token(str(token))
            if inst:
                return dict(inst)
        if symbol:
            inst = instrument_cache.lookup_by_symbol(str(symbol).strip().upper())
            if inst:
                return dict(inst)
    except Exception:
        pass
    return {}


def _pending_status_for(order_type: str) -> str:
    """Working status a fresh placement parks in (broker accept, pre-fill)."""
    ot = str(order_type or "").strip().upper()
    if ot in ("SL", "SL-M", "SLM", "SL-LMT"):
        return "TRIGGER_PENDING"
    if ot == "MKT":
        return "PENDING"
    return "OPEN"


def _calculate_charges(side: str, price: float, quantity: int, product: str = "MIS") -> dict:
    value = price * quantity
    # Centralized brokerage model: flat â‚¹10 per executed order for Dummy when
    # DUMMY_FLAT_BROKERAGE is active (mirrors frontend config/brokerage.ts
    # Dummy Flat â‚¹10 profile), otherwise percentage 0.03%.
    if DUMMY_FLAT_BROKERAGE:
        brokerage = float(CHARGE_RATES.get("brokerage_flat", 10))
    else:
        brokerage = value * CHARGE_RATES["brokerage"]
    # Statutory charges â€” same rules as frontend config/statutory-charges.ts
    # CASH = cash delivery: same delivery treatment as CNC.
    is_delivery = str(product or "").strip().upper() in ("CNC", "CASH", "CO", "MARGIN")
    # STT: delivery 0.001 both sides, intraday 0 on BUY, 0.00025 on SELL
    if is_delivery:
        stt = value * 0.001
    else:
        stt = 0.0 if side == "BUY" else value * CHARGE_RATES["stt_sell"]
    # Stamp duty: BUY side only
    if side != "BUY":
        stamp_rate = 0
    elif is_delivery:
        stamp_rate = 0.00015
    else:
        stamp_rate = 0.00003
    exchange_txn = value * CHARGE_RATES["exchange_txn"]
    sebi = value * CHARGE_RATES["sebi"]
    gst = (brokerage + exchange_txn + sebi) * CHARGE_RATES["gst"] if (brokerage + exchange_txn + sebi) > 0 else 0
    stamp_duty = value * stamp_rate
    total = brokerage + stt + exchange_txn + gst + sebi + stamp_duty
    return {
        "brokerage": round(brokerage, 2),
        "stt": round(stt, 2),
        "exchangeTxn": round(exchange_txn, 2),
        "gst": round(gst, 2),
        "sebi": round(sebi, 2),
        "stampDuty": round(stamp_duty, 2),
        "total": round(total, 2),
    }


# ---------------------------------------------------------------------------
# Persistence (shared with brokers.dummy adapter)
# ---------------------------------------------------------------------------
async def get_dummy_account() -> dict:
    db = get_db()
    doc = await db.app_settings.find_one({"key": DEMO_ACCOUNT_KEY})
    if doc and doc.get("value"):
        return doc["value"]
    default = {
        "balance": 100000,
        "usedMargin": 0,
        "freeMargin": 100000,
        "totalPnl": 0,
        "totalCharges": 0,
        "realizedPnl": 0,
        "unrealizedPnl": 0,
        "dailyOrders": 0,
        "startDate": datetime.now(timezone.utc).isoformat(),
    }
    await db.app_settings.update_one(
        {"key": DEMO_ACCOUNT_KEY},
        {"$set": {"key": DEMO_ACCOUNT_KEY, "value": default, "category": "demo", "description": "Demo Account", "updatedAt": datetime.now(timezone.utc)}},
        upsert=True,
    )
    return default


async def _save_account(account: dict):
    db = get_db()
    await db.app_settings.update_one(
        {"key": DEMO_ACCOUNT_KEY},
        {"$set": {"value": account, "updatedAt": datetime.now(timezone.utc)}},
        upsert=True,
    )
    read_cache.invalidate("dummy:state")


async def get_dummy_orders() -> list:
    db = get_db()
    doc = await db.app_settings.find_one({"key": DEMO_ORDERS_KEY})
    if doc and doc.get("value"):
        return doc["value"]
    return []


async def _save_orders(orders: list):
    db = get_db()
    await db.app_settings.update_one(
        {"key": DEMO_ORDERS_KEY},
        {"$set": {"value": orders, "updatedAt": datetime.now(timezone.utc)}},
        upsert=True,
    )
    read_cache.invalidate("dummy:state")


async def _load_positions_raw() -> list:
    db = get_db()
    doc = await db.app_settings.find_one({"key": DEMO_POSITIONS_KEY})
    if doc and doc.get("value"):
        return doc["value"]
    return []


#: Intraday products auto-settled by the day rollover (same-evening square-off
#: like the real broker). Delivery/carry products are holdings, not intraday â€”
#: they are never touched by the rollover.
_ROLLOVER_PRODUCTS = frozenset({"MIS", "CO", "BO"})


def _positions_trading_today() -> str:
    """Today's positions partition (IST calendar date, 12:00 AM flip â€” the
    same boundary as ``services.dummy_session``, so the page is clean from
    midnight and every position belongs to exactly one day)."""
    from services.dummy_extras import trading_date
    return trading_date(datetime.now(timezone.utc))


async def rollover_demo_positions(today: str | None = None) -> dict:
    """Archive prior-date open intraday positions into the closed trail.

    One trading date per page: anything still open from a previous date is
    settled here at its last known LTP (average-price fallback) with reason
    ``AUTO_DAY_ROLLOVER`` and backdated to its own date, so yesterday can never
    leak into today's open list, closed list, or Day P&L. Idempotent per date.
    """
    from datetime import timedelta
    from core.timezones import IST
    from services.dummy_extras import record_closed_position

    today = today or _positions_trading_today()
    positions = await _load_positions_raw()
    # One-time stamp for legacy positions stored without a date: they belong to
    # the current date (kept, never nuked by the rollover).
    touched = False
    for p in positions:
        if not p.get("tradingDate"):
            p["tradingDate"] = today
            touched = True
    stale = [
        p for p in positions
        if str(p.get("tradingDate") or today) < today
        and int(p.get("netQuantity") or 0) != 0
        and str(p.get("product") or "MIS").upper() in _ROLLOVER_PRODUCTS
    ]
    rolled: list[str] = []
    realized_total = 0.0
    account = await get_dummy_account()
    for p in stale:
        net = int(p.get("netQuantity") or 0)
        qty = abs(net)
        avg = float(p.get("averageBuyPrice") or 0) if net > 0 else float(p.get("averageSellPrice") or 0)
        ltp = float(p.get("ltp") or 0)
        exit_price = ltp if ltp > 0 else avg
        realized = round(((exit_price - avg) if net > 0 else (avg - exit_price)) * qty, 2)
        realized_total = round(realized_total + realized, 2)
        try:
            prev = datetime.fromisoformat(str(p.get("tradingDate"))).date()
        except (ValueError, TypeError):
            prev = datetime.now(IST).date() - timedelta(days=1)
        closed_at = datetime(prev.year, prev.month, prev.day, 15, 30, tzinfo=IST)
        await record_closed_position(
            symbol=p.get("symbol", ""),
            trading_symbol=p.get("tradingSymbol", ""),
            exchange=p.get("exchange", "nse_cm"),
            exchange_segment=p.get("exchangeSegment", "NSE_CM"),
            token=p.get("token", ""),
            product=p.get("product", "MIS"),
            side=p.get("side", "FLAT"),
            quantity=qty,
            average_price=avg,
            exit_price=exit_price,
            realized_pnl=realized,
            charges=0.0,
            reason="AUTO_DAY_ROLLOVER",
            closed_at=closed_at,
        )
        rolled.append(str(p.get("symbol") or ""))
    if stale:
        stale_ids = {id(p) for p in stale}
        positions = [p for p in positions if id(p) not in stale_ids]
        account["realizedPnl"] = round(float(account.get("realizedPnl") or 0) + realized_total, 2)
        _recompute_pnl(positions)
        account["unrealizedPnl"] = round(sum(float(p.get("unrealizedPnl") or 0) for p in positions), 2)
        account["totalPnl"] = round(account["realizedPnl"] + account["unrealizedPnl"], 2)
        await _save_positions(positions)
        await _save_account(account)
        touched = False
        logger.info("[DEMO] day rollover %s: auto-squared %d (%s) realized=%s",
                    today, len(stale), ",".join(rolled), realized_total)
    elif touched:
        await _save_positions(positions)
    return {"today": today, "rolled": len(stale), "symbols": rolled, "realized": realized_total}


async def get_dummy_positions() -> list:
    """Today's open positions. Lazy day-rollover: any read past the date
    boundary settles prior-date intraday opens first, so every consumer
    (state, fills, LTP funnel, square-off) only ever sees the current date.
    Zero-net ghost rows (fully-closed leftovers) are purged â€” one order lives
    in exactly one place: open XOR the closed trail, never both."""
    positions = await _load_positions_raw()
    today = _positions_trading_today()
    needs_roll = any(
        str(p.get("tradingDate") or today) < today
        and int(p.get("netQuantity") or 0) != 0
        and str(p.get("product") or "MIS").upper() in _ROLLOVER_PRODUCTS
        for p in positions
    )
    needs_stamp = any(not p.get("tradingDate") for p in positions)
    ghosts = [p for p in positions if int(p.get("netQuantity") or 0) == 0]
    if needs_roll:
        await rollover_demo_positions(today)
        positions = await _load_positions_raw()
    elif needs_stamp:
        for p in positions:
            if not p.get("tradingDate"):
                p["tradingDate"] = today
        await _save_positions(positions)
    if ghosts:
        positions = [p for p in positions if int(p.get("netQuantity") or 0) != 0]
        await _save_positions(positions)
    return [p for p in positions if str(p.get("tradingDate") or today) <= today]


async def _save_positions(positions: list):
    db = get_db()
    await db.app_settings.update_one(
        {"key": DEMO_POSITIONS_KEY},
        {"$set": {"value": positions, "updatedAt": datetime.now(timezone.utc)}},
        upsert=True,
    )
    read_cache.invalidate("dummy:state")


async def get_dummy_transactions() -> list:
    db = get_db()
    doc = await db.app_settings.find_one({"key": DEMO_TRANSACTIONS_KEY})
    if doc and doc.get("value"):
        return doc["value"]
    return []


async def _save_transactions(txns: list):
    db = get_db()
    await db.app_settings.update_one(
        {"key": DEMO_TRANSACTIONS_KEY},
        {"$set": {"value": txns, "updatedAt": datetime.now(timezone.utc)}},
        upsert=True,
    )
    read_cache.invalidate("dummy:state")


async def _append_ledger_entry(
    txn_type: str,
    subtype: str | None,
    amount: float,
    direction: str,
    balance_before: float,
    balance_after: float,
    description: str | None = None,
    reference_type: str | None = None,
    reference_id: str | None = None,
    symbol: str | None = None,
    order_id: str | None = None,
    position_id: str | None = None,
    metadata: dict | None = None,
) -> dict:
    """Authoritative ledger append â€” every balance/P&L/charge event creates one entry.
    Never duplicates by reference_id+type within same millis (id includes uuid)."""
    txns = await get_dummy_transactions()
    t_date, s_id = _session_stamps()
    # Deduplicate by reference_id+type+amount to avoid double ledger on retry
    if reference_id:
        for existing in txns[:10]:
            if existing.get("referenceId") == reference_id and existing.get("type") == txn_type and str(existing.get("orderId") or "") == str(order_id or ""):
                # Already recorded very recently â€” prevent duplicate
                return existing
    txn = {
        "id": f"TXN{int(time.time() * 1000)}{uuid.uuid4().hex[:4].upper()}",
        "transaction_id": None,  # alias filled after
        "account_id": DEMO_ACCOUNT_KEY,
        "terminal": "dummy",
        "type": str(txn_type or "").upper(),
        "subtype": str(subtype or "").upper() if subtype else None,
        "amount": round(abs(float(amount)), 2),
        "direction": "CREDIT" if str(direction).upper() == "CREDIT" else "DEBIT",
        "balanceBefore": round(float(balance_before), 2),
        "balanceAfter": round(float(balance_after), 2),
        "referenceType": reference_type,
        "referenceId": reference_id,
        "symbol": str(symbol or "").upper() if symbol else None,
        "orderId": order_id,
        "positionId": position_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "tradingDate": t_date,
        "sessionId": s_id,
        "status": "COMPLETED",
        "description": description,
        "note": description,
        "metadata": metadata or {},
    }
    txn["transaction_id"] = txn["id"]
    txns.insert(0, txn)
    txns = txns[:500]
    await _save_transactions(txns)
    return txn

async def _record_transaction(txn_type: str, amount: float, balance_after: float) -> dict:
    # Legacy wrapper â€” fund movements (DEPOSIT/WITHDRAWAL) now go through authoritative ledger
    # Balance_before derived from balance_after - amount for DEPOSIT, + amount for WITHDRAWAL
    amt = round(float(amount), 2)
    bal_after = round(float(balance_after), 2)
    if str(txn_type).upper() == "DEPOSIT":
        bal_before = round(bal_after - amt, 2)
        direction = "CREDIT"
        desc = f"Funds added Â· {amt:,.2f} Coins credited"
    else:
        bal_before = round(bal_after + amt, 2)
        direction = "DEBIT"
        desc = f"Funds withdrawn Â· {amt:,.2f} Coins debited"
    return await _append_ledger_entry(
        txn_type=str(txn_type).upper(),
        subtype=None,
        amount=amt,
        direction=direction,
        balance_before=bal_before,
        balance_after=bal_after,
        description=desc,
        reference_type="FUND_MOVEMENT",
        reference_id=None,
    )


# ---------------------------------------------------------------------------
# Execution model â€” driven ONLY by the live market LTP supplied by the caller
# ---------------------------------------------------------------------------
class DemoPlaceOrderRequest(BaseModel):
    symbol: str
    tradingSymbol: str = ""
    exchange: str = "nse_cm"
    exchangeSegment: str = "NSE_CM"
    token: str = ""
    transactionType: str
    product: str = "MIS"
    orderType: str = "MKT"
    quantity: int
    price: float = 0
    triggerPrice: float = 0
    disclosedQty: int = 0
    validity: str = "DAY"
    ltp: float = 0
    source: str = "MANUAL"
    # Margin the caller wants to commit. When > 0 the engine sizes the order
    # itself (qty = amount / margin-per-share, whole lots) so the broker-like
    # contract holds even for callers that never knew the LTP. The frontend
    # sends both; the engine treats the AMOUNT as authoritative.
    amount: float = 0
    lotSize: int = 0
    marginPerShare: float = 0


#: Margin block per share as a fraction of price â€” the single dummy margin rule
#: shared by sizing (`_size_from_amount`) and the fill's margin accounting.
#: CASH = full payment (delivery into Holdings, factor 1.0).
MARGIN_FACTOR = {"MIS": 0.2, "INTRADAY": 0.2, "CASH": 1.0}


#: Products whose LONG positions live in Holdings, never in Positions.
#: Cash equity settles into delivery â€” the positions reads below hide CASH
#: longs (they surface through /holdings instead). CASH shorts stay visible
#: in positions so they can still be covered.
HOLDINGS_ONLY_PRODUCTS = {"CASH"}


def position_visible_in_positions(p: dict) -> bool:
    """True when a stored position belongs on the Positions page.

    CASH longs settle into Holdings (delivery) and must not appear in
    Positions; everything else â€” including CASH shorts awaiting cover â€”
    stays visible so it can be managed/squared off.
    """
    try:
        if str(p.get("product") or "").strip().upper() in HOLDINGS_ONLY_PRODUCTS:
            return int(p.get("netQuantity") or 0) <= 0
        return True
    except (TypeError, ValueError):
        return True


def margin_factor(product: str) -> float:
    return MARGIN_FACTOR.get(str(product or "").strip().upper(), 1.0)


def margin_per_share(price: float, product: str, override: float = 0.0) -> float:
    """Margin required for ONE share. An explicit broker-reported value wins;
    otherwise it is the product's margin factor applied to the real price."""
    try:
        if override and float(override) > 0:
            return float(override)
    except (TypeError, ValueError):
        pass
    return max(0.0, float(price or 0)) * margin_factor(product)


def _size_from_amount(amount: float, price: float, product: str,
                      lot: int = 0, override: float = 0.0) -> int:
    """Whole-lot quantity whose margin block fits inside `amount`.
    Returns 0 when the amount cannot even fund one lot (caller rejects)."""
    per = margin_per_share(price, product, override)
    if per <= 0:
        return 0
    raw_qty = int(float(amount) // per)
    step = int(lot) if lot and int(lot) >= 1 else 1
    return (raw_qty // step) * step


def _execution_decision(req: DemoPlaceOrderRequest, slippage: float = MKT_SLIPPAGE) -> dict:
    """Decide the fill from the real LTP. Returns:
        kind: "FULL" | "RESTING" | "REJECT"
        status, price, fill (int), reason

    The LTP is the ONLY price authority. When no live price has arrived yet the
    order is PARKED (``RESTING``) in its real working state â€” PENDING for a
    market order, TRIGGER_PENDING for a stop, OPEN for a limit â€” instead of
    being filled at an invented price or thrown away with a rejection. A broker
    queues an order it cannot price yet and fills it when the market moves; the
    paper engine does the same, and ``_refill_resting_orders_inner`` completes it
    on the first real tick that makes it marketable.
    """
    side = req.transactionType.upper()
    order_type = req.orderType.upper()
    ltp = float(req.ltp or 0)

    def rest(status: str, reason: str | None = None) -> dict:
        return {"kind": "RESTING", "status": status, "price": 0.0, "fill": 0, "reason": reason}

    if side not in ("BUY", "SELL"):
        return {"kind": "REJECT", "status": "REJECTED", "price": 0.0, "fill": 0,
                "reason": "Invalid transaction type"}
    if order_type == "MKT":
        if ltp <= 0:
            return rest("PENDING", "Waiting for live market price (LTP)")
        px = round(ltp * (1 + (slippage if side == "BUY" else -slippage)), 2)
        if px <= 0:
            px = ltp
        return {"kind": "FULL", "status": "COMPLETE", "price": px, "fill": req.quantity, "reason": None}
    if order_type in ("SL", "SL-M", "SLM", "SL-LMT"):
        trigger = float(req.triggerPrice or 0)
        if trigger <= 0:
            return {"kind": "REJECT", "status": "REJECTED", "price": 0.0, "fill": 0,
                    "reason": "Stop order requires a trigger price"}
        if ltp <= 0:
            return rest("TRIGGER_PENDING", "Waiting for live market price (LTP) to evaluate trigger")
        hit = (side == "BUY" and ltp >= trigger) or (side == "SELL" and ltp <= trigger)
        if not hit:
            return {"kind": "RESTING", "status": "TRIGGER_PENDING", "price": 0.0, "fill": 0, "reason": None}
        px = ltp if order_type in ("SL-M", "SLM") else float(req.price or 0)
        if px <= 0:
            px = ltp
        return {"kind": "FULL", "status": "COMPLETE", "price": px, "fill": req.quantity, "reason": None}
    # Limit family
    price = float(req.price or 0)
    if price <= 0:
        return {"kind": "REJECT", "status": "REJECTED", "price": 0.0, "fill": 0,
                "reason": "Limit order requires a limit price"}
    if ltp <= 0:
        return rest("OPEN", "Waiting for live market price (LTP)")
    marketable = (side == "BUY" and ltp <= price * (1 + LMT_TOLERANCE)) or (
        side == "SELL" and ltp >= price * (1 - LMT_TOLERANCE))
    if not marketable:
        return {"kind": "RESTING", "status": "OPEN", "price": 0.0, "fill": 0, "reason": None}
    return {"kind": "FULL", "status": "COMPLETE", "price": price, "fill": req.quantity, "reason": None}


def _recompute_pnl(positions: list) -> None:
    for p in positions:
        net = p.get("netQuantity", 0)
        if net > 0:
            p["side"] = "LONG"
            p["unrealizedPnl"] = (p.get("ltp", 0) - p.get("averageBuyPrice", 0)) * net
        elif net < 0:
            p["side"] = "SHORT"
            p["unrealizedPnl"] = (p.get("averageSellPrice", 0) - p.get("ltp", 0)) * abs(net)
        else:
            p["side"] = "FLAT"
            p["unrealizedPnl"] = 0
        p["grossPnl"] = p.get("realizedPnl", 0) + p["unrealizedPnl"]
        p["netPnl"] = p["grossPnl"] - p.get("estimatedCharges", 0)
        p["marketValue"] = p.get("ltp", 0) * abs(net)


async def _make_position(req: DemoPlaceOrderRequest, symbol: str, side: str, price: float, qty: int) -> dict:
    is_long = side == "BUY"
    t_date, s_id = _session_stamps()
    return {
        "id": f"{symbol}_{req.product}_{int(time.time())}",
        "symbol": symbol,
        "tradingSymbol": req.tradingSymbol or req.symbol,
        "exchange": req.exchange,
        "exchangeSegment": req.exchangeSegment,
        "token": req.token,
        "product": req.product,
        "side": "LONG" if is_long else "SHORT",
        "netQuantity": qty if is_long else -qty,
        "buyQuantity": qty if is_long else 0,
        "sellQuantity": 0 if is_long else qty,
        "averageBuyPrice": price if is_long else 0,
        "averageSellPrice": 0 if is_long else price,
        "ltp": price,
        "realizedPnl": 0,
        "unrealizedPnl": 0,
        "grossPnl": 0,
        "estimatedCharges": 0,
        "netPnl": 0,
        "marketValue": price * qty,
        "sessionId": s_id,
        "tradingDate": t_date,
    }


def _build_order(req: DemoPlaceOrderRequest, symbol: str, status: str, filled_qty: int,
                 avg_price: float, charges: dict, reason: str | None = None,
                 price_basis: float | None = None) -> dict:
    t_date, s_id = _session_stamps()
    # Margin actually blocked, priced off the real fill price when we have one
    # (so the blotter agrees with the account's usedMargin).
    basis = price_basis if price_basis and price_basis > 0 else (float(req.price or 0) or float(req.ltp or 0))
    per_share = margin_per_share(basis, req.product, float(req.marginPerShare or 0))
    return {
        "orderId": f"DEMO{int(time.time() * 1000)}{int(time.time() % 1000):03d}",
        "symbol": symbol,
        "tradingSymbol": req.tradingSymbol or req.symbol,
        "exchange": req.exchange,
        "exchangeSegment": req.exchangeSegment,
        "token": req.token,
        "transactionType": req.transactionType,
        "product": req.product,
        "orderType": req.orderType,
        "quantity": req.quantity,
        "price": req.price,
        "triggerPrice": req.triggerPrice,
        "disclosedQty": req.disclosedQty,
        "validity": req.validity,
        "source": (req.source or "MANUAL").upper(),
        "status": status,
        "averageTradedPrice": avg_price,
        "orderDate": datetime.now(timezone.utc).isoformat(),
        "filledQuantity": filled_qty,
        "unfilledQuantity": req.quantity - filled_qty,
        "marginPerShare": round(per_share, 2),
        "marginAmount": round(per_share * int(req.quantity or 0), 2),
        "orderValue": round(basis * int(req.quantity or 0), 2),
        "errorMessage": reason,
        "charges": charges,
        "sessionId": s_id,
        "tradingDate": t_date,
    }


async def _apply_fill(req: DemoPlaceOrderRequest, decision: dict, orders: list,
                      positions: list, account: dict,
                      reuse: dict | None = None,
                      fill_source: str = "placement") -> dict:
    """Apply a FULL fill to positions + account and record the completed order.

    ``reuse`` is a parked working order (PENDING / OPEN / TRIGGER_PENDING)
    that transitions PENDING â†’ COMPLETE in place â€” one orderId for the full
    broker-style lifecycle. Without it a fresh COMPLETE row is recorded (the
    legacy direct-fill path). ``fill_source`` records whether the fill happened
    at placement time (live LTP already marketable) or later off a websocket
    tick (``"ws_tick"`` via the refill funnel).
    """
    execution_price = float(decision["price"])
    fill_qty = int(decision["fill"])
    side = req.transactionType.upper()
    # Margin block per share: honor a broker-reported margin-per-share when
    # supplied, so account accounting matches exactly what `quantityFromMargin`
    # sized the order to; else price Ã— the product's margin factor.
    per_share = margin_per_share(execution_price, req.product, float(req.marginPerShare or 0))
    symbol = req.symbol.strip().upper()
    signed = fill_qty if side == "BUY" else -fill_qty
    charges = _calculate_charges(side, execution_price, fill_qty, req.product)

    existing = next((p for p in positions if p["symbol"].upper() == symbol and p["product"] == req.product), None)
    old_net = existing["netQuantity"] if existing else 0
    new_net = old_net + signed
    old_exposure = abs(old_net) * per_share
    new_exposure = abs(new_net) * per_share
    margin_delta = new_exposure - old_exposure

    if margin_delta > 0 and margin_delta > max(0.0, account["freeMargin"]):
        return None

    if margin_delta != 0:
        account["usedMargin"] = max(0.0, round(account["usedMargin"] + margin_delta, 2))
        account["freeMargin"] = max(0.0, round(account["balance"] - account["usedMargin"], 2))

    account["totalCharges"] = round(account["totalCharges"] + charges["total"], 2)
    account["dailyOrders"] += 1
    realized = 0.0

    if existing is None:
        existing = await _make_position(req, symbol, side, execution_price, fill_qty)
        existing["estimatedCharges"] = round(charges["total"], 2)
        positions.append(existing)
    else:
        # Accumulate charges per position (centralized charge model â€” never fabricated)
        existing["estimatedCharges"] = round(float(existing.get("estimatedCharges", 0) or 0) + float(charges["total"] or 0), 2)
        if side == "BUY":
            if old_net < 0:
                covered = min(fill_qty, -old_net)
                realized = (existing["averageSellPrice"] - execution_price) * covered
                remaining = fill_qty - covered
                existing["netQuantity"] = new_net
                if remaining > 0:
                    existing["buyQuantity"] = remaining
                    existing["averageBuyPrice"] = execution_price
                    existing["sellQuantity"] = max(0, existing["sellQuantity"] - covered)
            else:
                old_buy_qty = existing["buyQuantity"]
                new_buy_qty = old_buy_qty + fill_qty
                existing["averageBuyPrice"] = (
                    (existing["averageBuyPrice"] * old_buy_qty + execution_price * fill_qty) / new_buy_qty
                )
                existing["buyQuantity"] = new_buy_qty
                existing["netQuantity"] = new_net
        else:
            if old_net > 0:
                covered = min(fill_qty, old_net)
                realized = (execution_price - existing["averageBuyPrice"]) * covered
                remaining = fill_qty - covered
                existing["netQuantity"] = new_net
                if remaining > 0:
                    existing["sellQuantity"] = remaining
                    existing["averageSellPrice"] = execution_price
                    existing["buyQuantity"] = max(0, existing["buyQuantity"] - covered)
            else:
                old_sell_qty = existing["sellQuantity"]
                new_sell_qty = old_sell_qty + fill_qty
                existing["averageSellPrice"] = (
                    (existing["averageSellPrice"] * old_sell_qty + execution_price * fill_qty) / new_sell_qty
                )
                existing["sellQuantity"] = new_sell_qty
                existing["netQuantity"] = new_net
        existing["ltp"] = execution_price
        existing["realizedPnl"] = round(existing.get("realizedPnl", 0) + realized, 2)

    # Build the order FIRST so the close-record below carries its id â€” the
    # trail is idempotent per order and concurrent square-offs of the same
    # position record exactly one entry (double-click / overlapping funnels).
    # A parked order keeps its own id: PENDING â†’ COMPLETE is one row, exactly
    # like a broker order that was accepted first and filled afterwards.
    if reuse is not None:
        order = reuse
        basis = execution_price if execution_price > 0 else (
            float(req.price or 0) or float(req.ltp or 0))
        per_share = margin_per_share(basis, req.product, float(req.marginPerShare or 0))
        order["status"] = "COMPLETE"
        order["averageTradedPrice"] = execution_price
        order["filledQuantity"] = fill_qty
        order["unfilledQuantity"] = max(0, int(order.get("quantity", fill_qty) or 0) - fill_qty)
        order["marginPerShare"] = round(per_share, 2)
        order["marginAmount"] = round(per_share * int(order.get("quantity", fill_qty) or 0), 2)
        order["orderValue"] = round(basis * int(order.get("quantity", fill_qty) or 0), 2)
        order["errorMessage"] = None
        order["waitingReason"] = None
        order["awaitingLtp"] = False
        order["fillSource"] = fill_source
        order["filledAt"] = datetime.now(timezone.utc).isoformat()
        order["charges"] = charges
    else:
        order = _build_order(req, symbol, "COMPLETE", fill_qty, execution_price, charges,
                             price_basis=execution_price)
        order["fillSource"] = fill_source
    if new_net == 0:
        account["realizedPnl"] = round(account["realizedPnl"] + existing["realizedPnl"], 2)
        # In-place removal: callers save THEIR list object afterwards, so a
        # rebinding here would silently resurrect the closed row on save
        # (ghost zero-net rows showing in both open and closed).
        positions[:] = [p for p in positions if p["id"] != existing["id"]]
        await _term_closed_position(existing, fill_qty, execution_price,
                                    existing.get("realizedPnl", 0), charges["total"],
                                    order_id=order.get("orderId", ""))

    _recompute_pnl(positions)
    account["unrealizedPnl"] = round(sum(p.get("unrealizedPnl", 0) for p in positions), 2)
    account["totalPnl"] = round(account["realizedPnl"] + account["unrealizedPnl"], 2)

    if reuse is None:
        orders.insert(0, order)
        orders[:] = orders[:500]
    else:
        # The transitioned row stays where the parked order was (already at the
        # top from parking); just enforce the cap.
        orders[:] = orders[:500]
    await _publish_order_frame(order, "COMPLETE")
    try:
        from services.realtime_events import trade_fill, position_update
        await trade_fill(
            order, terminal="dummy", symbol=symbol, token=str(req.token or ""),
            price=execution_price, quantity=fill_qty,
        )
        # The positions frame mirrors the positions reads: CASH longs live
        # in Holdings, so they are excluded here too.
        await position_update(
            [p for p in positions if position_visible_in_positions(p)],
            terminal="dummy", symbol=symbol,
        )
    except Exception as exc:
        logger.debug("demo fill frame publish skipped: %s", exc)
    await _term_notify(
        "success", "Order filled",
        f"{side} {fill_qty} {symbol} @ â‚¹{execution_price:.2f} Â· charges â‚¹{charges.get('total', 0):.2f}",
        "ORDER_FILLED",
        {"symbol": symbol, "token": req.token, "exchange": req.exchange,
         "order_id": order["orderId"], "side": side, "quantity": fill_qty,
         "price": execution_price, "product": req.product},
    )
    # Authoritative ledger: each execution creates charge entries + realized PnL entry (if any)
    # Balance is authoritative cash balance (unchanged by trade, mutated only by fund movements);
    # ledger still records direction/amount for daily report aggregation.
    bal = float(account.get("balance", 0) or 0)
    try:
        # Charges: one DEBIT entry per filled order with breakdown in metadata (not duplicated)
        if float(charges.get("total", 0) or 0) > 0:
            await _append_ledger_entry(
                txn_type="CHARGE",
                subtype="TOTAL_CHARGES",
                amount=float(charges["total"]),
                direction="DEBIT",
                balance_before=bal,
                balance_after=bal,
                description=f"Charges {symbol} {side} {fill_qty} @ {execution_price:.2f} Â· brokerage {charges.get('brokerage',0):.2f} STT {charges.get('stt',0):.2f} Exch {charges.get('exchangeTxn',0):.2f}",
                reference_type="ORDER",
                reference_id=order["orderId"],
                symbol=symbol,
                order_id=order["orderId"],
                position_id=existing["id"] if existing else None,
                metadata={"charges": charges, "product": req.product, "price": execution_price, "quantity": fill_qty, "side": side},
            )
        # Realized P&L: CREDIT if profit, DEBIT if loss â€” only when cover happened
        if realized != 0:
            is_profit = realized > 0
            await _append_ledger_entry(
                txn_type="TRADE_REALIZED_PNL",
                subtype="REALIZED_PNL",
                amount=abs(float(realized)),
                direction="CREDIT" if is_profit else "DEBIT",
                balance_before=bal,
                balance_after=bal,
                description=f"Realized P&L {symbol} {'+' if is_profit else ''}{realized:.2f} on {fill_qty} @ {execution_price:.2f}",
                reference_type="POSITION",
                reference_id=existing["id"] if existing else order["orderId"],
                symbol=symbol,
                order_id=order["orderId"],
                position_id=existing["id"] if existing else None,
                metadata={"realizedPnl": round(float(realized),2), "product": req.product, "side": side, "covered": True},
            )
    except Exception as exc:
        logger.warning("ledger append skipped for order %s: %s", order.get("orderId"), exc)
    return {"order": order}


async def _execute_order(req: DemoPlaceOrderRequest) -> dict:
    return await _with_fill_lock(_execute_order_inner, req)


async def _execute_order_inner(req: DemoPlaceOrderRequest) -> dict:
    orders = await get_dummy_orders()
    positions = await get_dummy_positions()
    account = await get_dummy_account()

    symbol = req.symbol.strip().upper()
    if not symbol:
        return {
            "data": {"n_ord_no": None, "stat": "NotOk", "remarks": "Symbol required"},
            "stat": "NotOk", "isDemo": True,
        }

    # Simulation control prefs (effective defaults equal the engine's real
    # constants: 10 bps slippage, no order caps).
    slippage = MKT_SLIPPAGE
    max_daily_orders = 0
    max_order_value = 0.0
    try:
        from services.dummy_extras import get_prefs
        prefs = await get_prefs()
        bps = int(prefs.get("slippageBps") or 0)
        if 0 <= bps <= 100:
            slippage = bps / 10000.0
        max_daily_orders = int(prefs.get("maxDailyOrders") or 0)
        max_order_value = float(prefs.get("maxOrderValue") or 0.0)
    except Exception:
        pass

    if max_daily_orders > 0 and account.get("dailyOrders", 0) >= max_daily_orders:
        return await _reject_order(req, f"Daily order limit reached ({max_daily_orders})")

    # Authoritative live price: the engine resolves the LTP ITSELF from the
    # backend websocket feed + instrument master (full direct access, never
    # trusting a possibly-stale caller price). Server websocket price wins;
    # the caller-observed LTP is only a fallback when the feed is silent; with
    # no price at all the order parks PENDING until a real tick arrives.
    server_ltp, ltp_source = await _resolve_server_ltp(symbol, str(req.token or ""))
    caller_ltp = float(req.ltp or 0)
    if server_ltp > 0:
        req.ltp = server_ltp
        remember_ltp(symbol, server_ltp)
        ltp_source = ltp_source  # "ws_tick" | "known"
    elif caller_ltp > 0:
        remember_ltp(symbol, caller_ltp)
        ltp_source = "caller"
    else:
        ltp_source = "none"

    # Canonicalize through the real instrument master (fills a missing token
    # so the broker feed can be subscribed for this paper instrument).
    if not str(req.token or "").strip():
        _inst = _resolve_instrument(symbol, "")
        if _inst.get("token"):
            req.token = str(_inst["token"])

    ref = float(req.price or req.ltp or 0)
    probed = float(req.ltp or 0) or known_ltp(symbol)

    # Margin-driven sizing. The AMOUNT is authoritative when present: the
    # quantity is whatever whole lots of margin it can fund at the real price
    # (LTP 200, MIS margin 40, amount 400 -> 10 qty â€” never 400/200 = 2).
    if float(req.amount or 0) > 0:
        sizing_price = float(req.price or 0) or float(req.ltp or 0) or probed
        sized = _size_from_amount(
            float(req.amount), sizing_price, req.product,
            int(req.lotSize or 0), float(req.marginPerShare or 0),
        )
        if sized <= 0:
            per = margin_per_share(sizing_price, req.product, float(req.marginPerShare or 0))
            return await _reject_order(
                req,
                f"Margin {float(req.amount):,.2f} cannot fund one lot"
                + (f" (needs {per * (int(req.lotSize) if req.lotSize else 1):,.2f})" if per > 0 else ""),
            )
        req.quantity = sized
        req.amount = round(float(req.amount), 2)

    if req.quantity is None or int(req.quantity or 0) <= 0:
        return {
            "data": {"n_ord_no": None, "stat": "NotOk", "remarks": "Quantity must be positive"},
            "stat": "NotOk", "isDemo": True,
        }

    # Cap check runs on the FINAL quantity, so a margin-sized order is measured
    # by what it actually trades, not by whatever qty the caller pre-filled.
    order_value = max(float(req.price or 0), float(req.ltp or 0), probed) * int(req.quantity or 0)
    if max_order_value > 0 and order_value > max_order_value:
        return await _reject_order(
            req, f"Order value {order_value:,.0f} exceeds the max order value cap ({max_order_value:,.0f})")

    decision = _execution_decision(req, slippage)

    if decision["kind"] == "REJECT":
        return await _reject_order(req, decision["reason"])

    # Broker-style accept: EVERY order parks in the engine first as a working
    # order with its own id (PENDING / OPEN / TRIGGER_PENDING). A marketable
    # order then fills against this instant's live LTP in the same call
    # (PENDING â†’ COMPLETE, one row); a non-marketable one rests until the
    # websocket moves â€” never executed at an invented price.
    park_status = decision["status"] if decision["kind"] == "RESTING" else _pending_status_for(req.orderType)
    parked = _build_order(
        req, symbol, park_status, 0, 0.0,
        _calculate_charges(req.transactionType.upper(), float(req.price or req.ltp or 0), req.quantity, req.product),
    )
    parked["waitingReason"] = (
        decision.get("reason") if decision["kind"] == "RESTING"
        else f"Accepted by engine â€” matching live LTP ({ltp_source})"
    )
    parked["awaitingLtp"] = not (float(req.ltp or 0) > 0)
    parked["ltpSource"] = ltp_source
    parked["receivedAt"] = datetime.now(timezone.utc).isoformat()
    orders.insert(0, parked)
    orders[:] = orders[:500]
    await _save_orders(orders)
    await _term_audit("order", "accepted", {"status": parked["status"], "symbol": symbol,
                                           "orderId": parked["orderId"], "quantity": parked["quantity"],
                                           "ltpSource": ltp_source})
    await _publish_order_frame(parked, parked["status"], reason=str(parked.get("waitingReason") or ""))

    if decision["kind"] == "RESTING":
        # Not marketable at this instant's live LTP â€” rests working until a
        # real websocket tick fills it (Paper Market Feed / LTP funnel).
        await _term_notify(
            "info", "Order working",
            f"{req.transactionType.upper()} {req.quantity} {symbol} is {parked['status']}"
            + (f" (trigger â‚¹{req.triggerPrice})" if float(req.triggerPrice or 0) > 0 else "")
            + (f" â€” {decision['reason']}" if decision.get("reason") else ""),
            "ORDER_WORKING",
            {"symbol": symbol, "order_id": parked["orderId"], "side": req.transactionType.upper(),
             "quantity": parked["quantity"], "status": parked["status"]},
        )
        return {
            "data": {"n_ord_no": parked["orderId"], "stat": "Ok"},
            "stat": "Ok", "isDemo": True, "demoOrder": parked,
            "accepted": True, "status": parked["status"], "working": True,
        }

    # FULL â€” marketable at this instant's live LTP: fill the parked order in
    # place (same id, PENDING â†’ COMPLETE).
    result = await _apply_fill(req, decision, orders, positions, account,
                               reuse=parked, fill_source="placement")
    if result is None:  # margin rejection after accept: flip the parked row
        parked["status"] = "REJECTED"
        parked["errorMessage"] = "Insufficient margin"
        parked["waitingReason"] = None
        parked["awaitingLtp"] = False
        await _save_orders(orders)
        await _term_audit("order", "reject", {"symbol": symbol, "reason": "Insufficient margin",
                                              "quantity": req.quantity, "orderType": req.orderType,
                                              "orderId": parked["orderId"]})
        await _term_notify(
            "error", "Order rejected",
            f"{req.transactionType.upper()} {req.quantity} {symbol} — Insufficient margin",
            "ORDER_REJECTED",
            {"symbol": symbol, "token": req.token, "exchange": req.exchange,
             "order_id": parked["orderId"], "side": req.transactionType.upper(),
             "quantity": req.quantity, "reason": "Insufficient margin"},
        )
        await _publish_order_frame(parked, "REJECTED", reason="Insufficient margin")
        return {
            "data": {"n_ord_no": parked["orderId"], "stat": "NotOk", "remarks": "Insufficient margin"},
            "stat": "NotOk", "isDemo": True, "demoOrder": parked,
        }
    await _save_account(account)
    await _save_orders(orders)
    await _save_positions(positions)
    order = result["order"]
    await _term_audit("order", "place", {"status": "COMPLETE", "symbol": symbol,
                                         "orderId": order["orderId"], "filledQuantity": order["filledQuantity"],
                                         "averageTradedPrice": order["averageTradedPrice"]})
    return {
        "data": {"n_ord_no": order["orderId"], "stat": "Ok"},
        "stat": "Ok", "isDemo": True, "demoOrder": order,
        "accepted": True, "status": "COMPLETE", "working": False,
    }


async def _term_audit(category: str, action: str, meta: dict = None) -> None:
    """Best-effort audit write; never raises into the order path."""
    try:
        from services.dummy_extras import record_audit
        await record_audit(category, action, meta)
    except Exception as exc:
        logger.warning("dummy audit skipped: %s", exc)
async def connect_dummy():
    """Connect / ensure-ready the Dummy (paper) terminal.

    Idempotent: if Dummy is already managed+logged in this is a no-op success.
    Otherwise calls ensure_auto_ready() so the paper engine is live for the
    whole backend run without needing broker credentials.
    """
    from brokers.dummy import dummy_adapter
    try:
        ok = await dummy_adapter.ensure_auto_ready()
        return {
            "ok": ok,
            "connected": bool(dummy_adapter.is_logged_in),
            "managed": bool(dummy_adapter._managed),
            "terminal": "dummy",
            "broker": dummy_adapter.broker_name,
            "message": "Dummy terminal connected" if ok else "Dummy connect failed",
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "connected": bool(dummy_adapter.is_logged_in),
            "terminal": "dummy",
            "broker": dummy_adapter.broker_name,
            "error": {"code": "CONNECT_FAILED", "message": str(exc)},
        }
    ref = float(req.price or req.ltp or 0)
    probed = float(req.ltp or 0) or known_ltp(symbol)

    # Margin-driven sizing. The AMOUNT is authoritative when present: the
    # quantity is whatever whole lots of margin it can fund at the real price
    # (LTP 200, MIS margin 40, amount 400 -> 10 qty â€” never 400/200 = 2).
    if float(req.amount or 0) > 0:
        sizing_price = float(req.price or 0) or float(req.ltp or 0) or probed
        sized = _size_from_amount(
            float(req.amount), sizing_price, req.product,
            int(req.lotSize or 0), float(req.marginPerShare or 0),
        )
        if sized <= 0:
            per = margin_per_share(sizing_price, req.product, float(req.marginPerShare or 0))
            return await _reject_order(
                req,
                f"Margin {float(req.amount):,.2f} cannot fund one lot"
                + (f" (needs {per * (int(req.lotSize) if req.lotSize else 1):,.2f})" if per > 0 else ""),
            )
        req.quantity = sized
        req.amount = round(float(req.amount), 2)

    if req.quantity is None or int(req.quantity or 0) <= 0:
        return {
            "data": {"n_ord_no": None, "stat": "NotOk", "remarks": "Quantity must be positive"},
            "stat": "NotOk", "isDemo": True,
        }

    # Cap check runs on the FINAL quantity, so a margin-sized order is measured
    # by what it actually trades, not by whatever qty the caller pre-filled.
    order_value = max(float(req.price or 0), float(req.ltp or 0), probed) * int(req.quantity or 0)
    if max_order_value > 0 and order_value > max_order_value:
        return await _reject_order(
            req, f"Order value {order_value:,.0f} exceeds the max order value cap ({max_order_value:,.0f})")

    decision = _execution_decision(req, slippage)

    if decision["kind"] == "REJECT":
        return await _reject_order(req, decision["reason"])

    # Broker-style accept: EVERY order parks in the engine first as a working
    # order with its own id (PENDING / OPEN / TRIGGER_PENDING). A marketable
    # order then fills against this instant's live LTP in the same call
    # (PENDING â†’ COMPLETE, one row); a non-marketable one rests until the
    # websocket moves â€” never executed at an invented price.
    park_status = decision["status"] if decision["kind"] == "RESTING" else _pending_status_for(req.orderType)
    parked = _build_order(
        req, symbol, park_status, 0, 0.0,
        _calculate_charges(req.transactionType.upper(), float(req.price or req.ltp or 0), req.quantity, req.product),
    )
    parked["waitingReason"] = (
        decision.get("reason") if decision["kind"] == "RESTING"
        else f"Accepted by engine â€” matching live LTP ({ltp_source})"
    )
    parked["awaitingLtp"] = not (float(req.ltp or 0) > 0)
    parked["ltpSource"] = ltp_source
    parked["receivedAt"] = datetime.now(timezone.utc).isoformat()
    orders.insert(0, parked)
    orders[:] = orders[:500]
    await _save_orders(orders)
    await _term_audit("order", "accepted", {"status": parked["status"], "symbol": symbol,
                                           "orderId": parked["orderId"], "quantity": parked["quantity"],
                                           "ltpSource": ltp_source})
    await _publish_order_frame(parked, parked["status"], reason=str(parked.get("waitingReason") or ""))

    if decision["kind"] == "RESTING":
        # Not marketable at this instant's live LTP â€” rests working until a
        # real websocket tick fills it (Paper Market Feed / LTP funnel).
        await _term_notify(
            "info", "Order working",
            f"{req.transactionType.upper()} {req.quantity} {symbol} is {parked['status']}"
            + (f" (trigger â‚¹{req.triggerPrice})" if float(req.triggerPrice or 0) > 0 else "")
            + (f" â€” {decision['reason']}" if decision.get("reason") else ""),
            "ORDER_WORKING",
            {"symbol": symbol, "order_id": parked["orderId"], "side": req.transactionType.upper(),
             "quantity": parked["quantity"], "status": parked["status"]},
        )
        return {
            "data": {"n_ord_no": parked["orderId"], "stat": "Ok"},
            "stat": "Ok", "isDemo": True, "demoOrder": parked,
            "accepted": True, "status": parked["status"], "working": True,
        }

    # FULL â€” marketable at this instant's live LTP: fill the parked order in
    # place (same id, PENDING â†’ COMPLETE).
    result = await _apply_fill(req, decision, orders, positions, account,
                               reuse=parked, fill_source="placement")
    if result is None:  # margin rejection after accept: flip the parked row
        parked["status"] = "REJECTED"
        parked["errorMessage"] = "Insufficient margin"
        parked["waitingReason"] = None
        parked["awaitingLtp"] = False
        await _save_orders(orders)
        await _term_audit("order", "reject", {"symbol": symbol, "reason": "Insufficient margin",
                                              "quantity": req.quantity, "orderType": req.orderType,
                                              "orderId": parked["orderId"]})
        await _term_notify(
            "error", "Order rejected",
            f"{req.transactionType.upper()} {req.quantity} {symbol} â€” Insufficient margin",
            "ORDER_REJECTED",
            {"symbol": symbol, "token": req.token, "exchange": req.exchange,
             "order_id": parked["orderId"], "side": req.transactionType.upper(),
             "quantity": req.quantity, "reason": "Insufficient margin"},
        )
        await _publish_order_frame(parked, "REJECTED", reason="Insufficient margin")
        return {
            "data": {"n_ord_no": parked["orderId"], "stat": "NotOk", "remarks": "Insufficient margin"},
            "stat": "NotOk", "isDemo": True, "demoOrder": parked,
        }
    await _save_account(account)
    await _save_orders(orders)
    await _save_positions(positions)
    order = result["order"]
    await _term_audit("order", "place", {"status": "COMPLETE", "symbol": symbol,
                                         "orderId": order["orderId"], "filledQuantity": order["filledQuantity"],
                                         "averageTradedPrice": order["averageTradedPrice"]})
    return {
        "data": {"n_ord_no": order["orderId"], "stat": "Ok"},
        "stat": "Ok", "isDemo": True, "demoOrder": order,
        "accepted": True, "status": "COMPLETE", "working": False,
    }


async def _term_audit(category: str, action: str, meta: dict = None) -> None:
    """Best-effort audit write; never raises into the order path."""
    try:
        from services.dummy_extras import record_audit
        await record_audit(category, action, meta)
    except Exception as exc:
        logger.warning("dummy audit skipped: %s", exc)


_DUMMY_CATEGORY_BY_EVENT = {
    "ORDER_FILLED": "ORDER",
    "ORDER_REJECTED": "ORDER",
    "ORDER_CANCELLED": "ORDER",
}


async def _term_notify(severity: str, title: str, message: str, event_type: str, metadata: dict = None) -> None:
    """Best-effort global order notification from the demo engine. Never raises
    into the order path. Writes BOTH stores (ledger + dummy terminal feed) so
    every app surface shows it; push is sent once (via the ledger path)."""
    try:
        from services.notification_service import notify
        await notify(
            "trade", severity, title, message,
            source="demo-engine", event_type=event_type, metadata=metadata or {},
        )
    except Exception as exc:
        logger.debug("order notification skipped: %s", exc)
    try:
        from services.dummy_extras import notify as dummy_notify
        await dummy_notify(
            _DUMMY_CATEGORY_BY_EVENT.get(str(event_type or "").upper(), "SYSTEM"),
            title, message, metadata or {}, push=False,
        )
    except Exception as exc:
        logger.debug("demo dummy-feed notification skipped: %s", exc)


async def _publish_order_frame(order: dict, status: str, *, reason: str = "") -> None:
    """Best-effort realtime ``order.update`` frame for the WS#2 orders channel.
    Emitted after the order was persisted; never raises into the order path."""
    try:
        from services.realtime_events import order_update
        logger.info("[DEMO-ORDER-FRAME] begin status=%s orderId=%s", status, order.get("orderId"))
        await order_update(
            order,
            status=status,
            terminal="dummy",
            symbol=str(order.get("symbol") or ""),
            token=str(order.get("token") or ""),
            reason=reason,
        )
        logger.info("[DEMO-ORDER-FRAME] done status=%s orderId=%s", status, order.get("orderId"))
    except Exception as exc:
        logger.info("[DEMO-ORDER-FRAME] ERROR status=%s exc=%s", status, exc)
        logger.debug("demo order frame publish skipped: %s", exc)


async def _term_closed_position(position: dict, quantity: int, exit_price: float, realized_pnl: float,
                                charges: float, reason: str = "EXECUTED", order_id: str = "") -> None:
    """Best-effort closed-position record; never raises into the order path."""
    try:
        from services.dummy_extras import record_closed_position
        await record_closed_position(
            symbol=position.get("symbol", ""),
            trading_symbol=position.get("tradingSymbol", ""),
            exchange=position.get("exchange", "nse_cm"),
            exchange_segment=position.get("exchangeSegment", "NSE_CM"),
            token=position.get("token", ""),
            product=position.get("product", "MIS"),
            side=position.get("side", "FLAT"),
            quantity=int(quantity or 0),
            average_price=position.get("averageBuyPrice") or position.get("averageSellPrice") or 0,
            exit_price=exit_price,
            realized_pnl=realized_pnl,
            charges=charges,
            reason=reason,
            order_id=order_id,
        )
    except Exception as exc:
        logger.warning("dummy closed-position record skipped: %s", exc)


async def _reject_order(req: DemoPlaceOrderRequest, reason: str) -> dict:
    orders = await get_dummy_orders()
    charges = _calculate_charges(req.transactionType.upper(), float(req.ltp or req.price or 0), req.quantity, req.product)
    order = _build_order(req, req.symbol.strip().upper(), "REJECTED", 0, 0.0, charges, reason)
    orders.insert(0, order)
    orders[:] = orders[:500]
    await _save_orders(orders)
    await _term_audit("order", "reject", {"symbol": req.symbol.strip().upper(), "reason": reason,
                                          "quantity": req.quantity, "orderType": req.orderType})
    await _term_notify(
        "error", "Order rejected",
        f"{req.transactionType.upper()} {req.quantity} {req.symbol.strip().upper()} â€” {reason}",
        "ORDER_REJECTED",
        {"symbol": req.symbol.strip().upper(), "token": req.token, "exchange": req.exchange,
         "order_id": order["orderId"], "side": req.transactionType.upper(),
         "quantity": req.quantity, "reason": reason},
    )
    await _publish_order_frame(order, "REJECTED", reason=str(reason or ""))
    return {
        "data": {"n_ord_no": order["orderId"], "stat": "NotOk", "remarks": reason},
        "stat": "NotOk", "isDemo": True, "demoOrder": order,
    }


async def _refill_resting_orders(ltp_map: dict[str, float]) -> int:
    return await _with_fill_lock(_refill_resting_orders_inner, ltp_map)


async def _refill_resting_orders_inner(ltp_map: dict[str, float]) -> int:
    """(Re)fill parked orders (PENDING / OPEN / TRIGGER_PENDING) the moment the
    live LTP makes them marketable. Returns the number of orders newly filled â€”
    real market data drives every fill, never fabricated prices.

    ``PENDING`` is a market order with no price yet: it has no marketability
    condition, so the first real tick for its instrument fills it. This is the
    path that makes a queued paper order execute like a broker order the moment
    the market actually moves.
    """
    orders = await get_dummy_orders()
    positions = await get_dummy_positions()
    account = await get_dummy_account()
    filled = 0
    slippage = MKT_SLIPPAGE
    try:
        from services.dummy_extras import get_prefs
        bps = int((await get_prefs()).get("slippageBps") or 0)
        if 0 <= bps <= 100:
            slippage = bps / 10000.0
    except Exception:
        pass
    parked = [
        o for o in orders
        if o.get("status") in ("PENDING", "OPEN", "TRIGGER_PENDING", "PARTIALLY_FILLED")
    ]
    if not parked:
        return 0
    for order in parked:
        sym_key = str(order.get("symbol", "")).upper()
        token_key = str(order.get("token", "")).strip()
        # Symbol first (what every caller sends), then token â€” the broker feed is
        # token-keyed, so a token match is what keeps a parked order priced even
        # when the symbol spelling on the order row differs from the tick.
        ltp = ltp_map.get(sym_key, 0.0)
        if ltp <= 0 and token_key:
            ltp = ltp_map.get(token_key, 0.0) or known_ltp(sym_key)
        if ltp <= 0:
            # The engine consults its own live websocket feed directly, so a
            # resting order fills even when this funnel batch did not carry
            # its symbol (browser-independent execution, like a broker).
            _srv, _src = await _resolve_server_ltp(sym_key, token_key)
            if _srv > 0:
                ltp = _srv
                ltp_map[sym_key] = _srv
                if token_key:
                    ltp_map.setdefault(token_key, _srv)
                order["ltpSource"] = _src
        if ltp <= 0 and not parked_needs_price(order):
            continue
        req = DemoPlaceOrderRequest(
            symbol=order.get("symbol", ""),
            tradingSymbol=order.get("tradingSymbol", ""),
            exchange=order.get("exchange", "nse_cm"),
            exchangeSegment=order.get("exchangeSegment", "NSE_CM"),
            token=order.get("token", ""),
            transactionType=order.get("transactionType", "BUY"),
            product=order.get("product", "MIS"),
            orderType=order.get("orderType", "MKT"),
            quantity=int(order.get("quantity", 0)),
            price=float(order.get("price", 0) or 0),
            triggerPrice=float(order.get("triggerPrice", 0) or 0),
            disclosedQty=int(order.get("disclosedQty", 0) or 0),
            validity=order.get("validity", "DAY"),
            ltp=ltp,
            source=order.get("source") or "MANUAL",
        )
        decision = _execution_decision(req, slippage)
        if decision["kind"] != "FULL":
            continue
        # Same-id transition: the parked row becomes the fill (PENDING â†’
        # COMPLETE), filled off this websocket tick.
        result = await _apply_fill(req, decision, orders, positions, account,
                                   reuse=order, fill_source="ws_tick")
        if result is None:
            continue
        filled += 1
    if filled:
        await _save_account(account)
        await _save_orders(orders)
        await _save_positions(positions)
    return filled


def parked_needs_price(order: dict) -> bool:
    """True when a parked order still requires a live price to be evaluated."""
    status = str(order.get("status") or "").upper()
    if status == "PARTIALLY_FILLED":
        return True
    return str(order.get("orderType") or "").upper() == "MKT" or status in (
        "PENDING", "OPEN", "TRIGGER_PENDING",
    )


# ---------------------------------------------------------------------------
# API surface
# ---------------------------------------------------------------------------
class DemoFundsRequest(BaseModel):
    amount: float


class DemoResetRequest(BaseModel):
    startingBalance: float = 100000


class DemoSquareOffRequest(BaseModel):
    symbol: str
    product: str = "MIS"


class DemoCancelOrderRequest(BaseModel):
    orderId: str


class DemoLtpRequest(BaseModel):
    updates: list[dict]


async def execute_dummy_order(**params) -> dict:
    req = DemoPlaceOrderRequest(**{
        "symbol": params.get("symbol", ""),
        "tradingSymbol": params.get("tradingSymbol", ""),
        "exchange": params.get("exchange", "nse_cm"),
        "exchangeSegment": params.get("exchangeSegment", "NSE_CM"),
        "token": params.get("token", ""),
        "transactionType": params.get("transactionType", "BUY"),
        "product": params.get("product", "MIS"),
        "orderType": params.get("orderType", "MKT"),
        "quantity": int(params.get("quantity", 0)),
        "price": float(params.get("price", 0) or 0),
        "triggerPrice": float(params.get("triggerPrice", 0) or 0),
        "disclosedQty": int(params.get("disclosedQty", 0) or 0),
        "validity": params.get("validity", "DAY"),
        "ltp": float(params.get("ltp", 0) or 0),
        "source": params.get("source", "MANUAL"),
        "amount": float(params.get("amount", 0) or 0),
        "lotSize": int(params.get("lotSize", 0) or 0),
        "marginPerShare": float(params.get("marginPerShare", 0) or 0),
    })
    return await _execute_order(req)


async def cancel_dummy_order(order_id: str) -> dict:
    if not order_id:
        raise HTTPException(400, "orderId is required")
    orders = await get_dummy_orders()
    order = next((o for o in orders if o.get("orderId") == order_id), None)
    if order is None:
        raise HTTPException(404, f"Order {order_id} not found")
    if order.get("status") not in ("OPEN", "TRIGGER_PENDING", "PENDING"):
        raise HTTPException(400, f"Order {order_id} cannot be cancelled (status={order.get('status')})")
    order["status"] = "CANCELLED"
    order["errorMessage"] = "User cancelled order"
    order["unfilledQuantity"] = order.get("quantity", 0) - order.get("filledQuantity", 0)
    await _save_orders(orders)
    await _term_notify(
        "info", "Order cancelled",
        f"{order.get('transactionType') or 'BUY'} {order.get('quantity')} {order.get('symbol')} â€” cancelled by user",
        "ORDER_CANCELLED",
        {"symbol": order.get("symbol"), "token": order.get("token"),
         "order_id": order["orderId"], "quantity": order.get("quantity")},
    )
    await _publish_order_frame(order, "CANCELLED", reason="cancelled by user")
    return {"data": {"n_ord_no": order["orderId"], "stat": "Ok"}, "stat": "Ok", "isDemo": True, "demoOrder": order}


async def modify_dummy_order(order_id: str, price: float = 0, trigger_price: float = 0, quantity: int = 0) -> dict:
    """Modify a resting (OPEN / TRIGGER_PENDING) dummy order. Only the fields
    applicable to the order type are changed; invalid modifications reject."""
    if not order_id:
        raise ValueError("orderId is required")
    orders = await get_dummy_orders()
    order = next((o for o in orders if o.get("orderId") == order_id), None)
    if order is None:
        raise KeyError(f"Order {order_id} not found")
    if order.get("status") not in ("OPEN", "TRIGGER_PENDING", "PENDING"):
        raise ValueError(f"order {order_id} cannot be modified (status={order.get('status')})")
    order_type = str(order.get("orderType") or "").upper()
    if quantity:
        qty = int(quantity)
        if qty > 0:
            order["quantity"] = qty
            order["unfilledQuantity"] = qty - int(order.get("filledQuantity", 0))
    if price and price > 0 and order_type not in ("MKT", "SL-M", "SLM"):
        order["price"] = round(float(price), 2)
    if trigger_price and trigger_price > 0 and order_type in ("SL", "SL-M", "SLM", "SL-LMT"):
        order["triggerPrice"] = round(float(trigger_price), 2)
    order["modifiedAt"] = datetime.now(timezone.utc).isoformat()
    await _save_orders(orders)
    await _publish_order_frame(order, str(order.get("status") or "OPEN"), reason="order modified")
    return {"data": {"n_ord_no": order["orderId"], "stat": "Ok"}, "stat": "Ok", "isDemo": True, "demoOrder": order}


async def squareoff_dummy_position(symbol: str, product: str = "MIS", source: str = "MANUAL") -> dict:
    if not symbol.strip():
        raise HTTPException(400, "symbol is required")

    async def _sq() -> dict:
        # Target lookup INSIDE the fill lock: a concurrent square-off that
        # already closed the position must see "no open position" (honest 404)
        # instead of opening a reverse leg on a stale read.
        positions = await get_dummy_positions()
        target = next(
            (p for p in positions
             if str(p.get("symbol", "")).upper() == str(symbol or "").strip().upper()
             and (not product or str(p.get("product", "")).upper() == str(product).upper())),
            None,
        )
        if target is None or int(target.get("netQuantity") or 0) == 0:
            raise HTTPException(404, f"No open {symbol} {product} position to square off")
        quantity = abs(int(target["netQuantity"]))
        return await _execute_order_inner(DemoPlaceOrderRequest(
            symbol=target["symbol"],
            tradingSymbol=target.get("tradingSymbol") or target["symbol"],
            exchange=target.get("exchange") or "nse_cm",
            exchangeSegment=target.get("exchangeSegment") or "NSE_CM",
            token=target.get("token") or "",
            transactionType="SELL" if int(target["netQuantity"]) > 0 else "BUY",
            product=target["product"],
            orderType="MKT",
            quantity=quantity,
            price=0,
            ltp=float(target.get("ltp") or 0),
            disclosedQty=0,
            validity="DAY",
            source=source,
        ))

    return await _with_fill_lock(_sq)


async def apply_demo_ltp(updates: list[dict]) -> dict:
    # Whole funnel serialized: its own positions save must not clobber a
    # concurrent fill's save (lost-update resurrection). Nested legs (refill,
    # target square-offs) re-enter safely via the _FILL_HELD mark.
    return await _with_fill_lock(_apply_demo_ltp_inner, updates)


async def _apply_demo_ltp_inner(updates: list[dict]) -> dict:
    positions = await get_dummy_positions()
    side_effects: dict = {"alerts": [], "targets": []}
    if updates:
        # Index by symbol AND token. The browser pushes symbol-keyed updates; the
        # backend Paper Market Feed pushes the broker feed, which is token-keyed.
        # Parked orders resolve through either key, so a resting order stays
        # priced no matter which side the price came from.
        ltp_map: dict[str, float] = {}
        by_symbol: dict[str, float] = {}
        for u in updates:
            if not isinstance(u, dict):
                continue
            price = float(u.get("ltp", 0) or 0)
            if price <= 0:
                continue
            sym = str(u.get("symbol", "")).strip().upper()
            token = str(u.get("token", "") or "").strip()
            if sym:
                ltp_map[sym] = price
                by_symbol[sym] = price
            if token:
                ltp_map.setdefault(token, price)
        for sym, price in by_symbol.items():
            remember_ltp(sym, price)
        for p in positions:
            price = by_symbol.get(p["symbol"].upper())
            if price and price > 0:
                p["ltp"] = price
        _recompute_pnl(positions)
        await _save_positions(positions)
        await _refill_resting_orders_inner(ltp_map)
        # Terminal-scoped side effects (price alerts, target auto square-off)
        # run on the same LTP funnel, best-effort, never blocking the refresh.
        try:
            from services.dummy_extras import on_dummy_ltp
            side_effects = await on_dummy_ltp(by_symbol, positions)
        except Exception as exc:
            logger.warning("dummy ltp side-effects skipped: %s", exc)
    account = await get_dummy_account()
    account["unrealizedPnl"] = round(sum(p.get("unrealizedPnl", 0) for p in positions), 2)
    account["totalPnl"] = round(account["realizedPnl"] + account["unrealizedPnl"], 2)
    await _save_account(account)
    return {"account": account, "data": positions, "stat": "Ok", "sideEffects": side_effects}


async def deposit_demo_funds(amount: float) -> dict:
    amount = float(amount)
    if not (0 < amount <= MAX_DEMO_TRANSACTION_AMOUNT):
        raise HTTPException(400, f"Amount must be between 0 and {MAX_DEMO_TRANSACTION_AMOUNT}")
    account = await get_dummy_account()
    account["balance"] = round(account["balance"] + amount, 2)
    account["freeMargin"] = round(account["balance"] - account["usedMargin"], 2)
    await _save_account(account)
    txn = await _record_transaction("DEPOSIT", amount, account["balance"])
    return {"txn": txn, "account": account, "stat": "Ok", "isDemo": True}


async def withdrawal_demo_funds(amount: float) -> dict:
    amount = float(amount)
    if amount > account["freeMargin"] or amount > account["balance"]:
        raise HTTPException(400, "Insufficient free margin for withdrawal")
    account = await get_dummy_account()
    account["balance"] = round(account["balance"] - amount, 2)
    account["freeMargin"] = round(account["balance"] - account["usedMargin"], 2)
    await _save_account(account)
    txn = await _record_transaction("WITHDRAWAL", amount, account["balance"])
    return {"txn": txn, "account": account, "stat": "Ok", "isDemo": True}


async def reset_dummy_account(starting_balance: float = 0) -> dict:
    db = get_db()
    if not starting_balance or starting_balance <= 0:
        try:
            from services.dummy_extras import get_prefs
            starting_balance = float((await get_prefs()).get("startingCapital") or 100000)
        except Exception:
            starting_balance = 100000
    t_date, s_id = _session_stamps()
    account = {
        "balance": starting_balance,
        "usedMargin": 0,
        "freeMargin": starting_balance,
        "totalPnl": 0,
        "totalCharges": 0,
        "realizedPnl": 0,
        "unrealizedPnl": 0,
        "dailyOrders": 0,
        "startDate": datetime.now(timezone.utc).isoformat(),
        "sessionId": s_id,
        "tradingDate": t_date,
    }
    await db.app_settings.update_one(
        {"key": DEMO_ACCOUNT_KEY},
        {"$set": {"value": account, "updatedAt": datetime.now(timezone.utc)}},
        upsert=True,
    )
    for key in (DEMO_ORDERS_KEY, DEMO_POSITIONS_KEY, DEMO_TRANSACTIONS_KEY):
        await db.app_settings.update_one(
            {"key": key},
            {"$set": {"value": [], "updatedAt": datetime.now(timezone.utc)}},
            upsert=True,
        )
    read_cache.invalidate("dummy:state")
    return {"account": account, "stat": "Ok", "message": "Dummy account reset successfully"}


# ---------------------------------------------------------------------------
# HTTP router (thin â€” delegates to the engine above)
# ---------------------------------------------------------------------------
@router.get("/account")
async def get_demo_account_endpoint():
    account = await get_dummy_account()
    return {"account": account, "stat": "Ok"}


@router.get("/orders")
async def get_demo_orders_endpoint():
    return {"data": await get_dummy_orders(), "stat": "Ok"}


@router.get("/positions")
async def get_demo_positions_endpoint():
    rows = await get_dummy_positions()
    # CASH longs settle into Holdings â€” never list them as positions.
    return {"data": [p for p in rows if position_visible_in_positions(p)], "stat": "Ok"}


@router.get("/transactions")
async def get_demo_transactions(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    type: Optional[str] = Query(None),
    direction: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None, alias="from"),
    date_to: Optional[str] = Query(None, alias="to"),
    trading_date: Optional[str] = Query(None),
):
    """Paginated, filtered ledger. All params are optional; filtering is server-side for large ledgers."""
    all_txns = await get_dummy_transactions()
    filtered = list(all_txns)
    # Type filter
    if type:
        t = str(type).strip().upper()
        if t != "ALL":
            filtered = [x for x in filtered if str(x.get("type") or "").upper() == t or (t in ("DEBIT","CREDIT") and str(x.get("direction") or "").upper() == t)]
    if direction:
        d = str(direction).strip().upper()
        filtered = [x for x in filtered if str(x.get("direction") or "").upper() == d]
    if trading_date:
        td = str(trading_date).strip()
        filtered = [x for x in filtered if str(x.get("tradingDate") or "") == td]
    if date_from:
        try:
            from_dt = datetime.fromisoformat(str(date_from).replace("Z","").split("T")[0])
            filtered = [x for x in filtered if str(x.get("timestamp") or "") >= date_from]
        except Exception:
            pass
    if date_to:
        try:
            filtered = [x for x in filtered if str(x.get("timestamp") or "") <= date_to + "T23:59:59"]
        except Exception:
            pass
    if search:
        s = str(search).strip().lower()
        filtered = [x for x in filtered if s in str(x.get("id") or "").lower() or s in str(x.get("orderId") or "").lower() or s in str(x.get("symbol") or "").lower() or s in str(x.get("referenceId") or "").lower()]
    total = len(filtered)
    paged = filtered[offset: offset + limit]
    return {"data": paged, "total": total, "limit": limit, "offset": offset, "stat": "Ok"}


@router.get("/transactions/{txn_id}")
async def get_demo_transaction_detail(txn_id: str):
    all_txns = await get_dummy_transactions()
    for t in all_txns:
        if str(t.get("id") or t.get("transaction_id") or "") == str(txn_id):
            return {"data": t, "stat": "Ok"}
    raise HTTPException(404, f"Transaction {txn_id} not found")


@router.get("/daily-report")
async def get_demo_daily_report(date: Optional[str] = Query(None)):
    """Daily account report for a trading date (IST). Defaults to today."""
    # Resolve trading date
    if not date:
        try:
            import services.dummy_session as ds
            date = ds.session_date_for(ds._now_utc())
        except Exception:
            date = datetime.now(timezone.utc).astimezone(IST).date().isoformat()
    # Normalize date string YYYY-MM-DD
    try:
        target = datetime.fromisoformat(str(date).strip()[:10]).date().isoformat()
    except Exception:
        target = str(date).strip()[:10]
    account = await get_dummy_account()
    txns = await get_dummy_transactions()
    txns_today = [t for t in txns if str(t.get("tradingDate") or "") == target]
    # Also include legacy transactions without tradingDate but whose timestamp date matches (fallback)
    if not txns_today:
        for t in txns:
            ts = str(t.get("timestamp") or "")
            try:
                ts_date = datetime.fromisoformat(ts.replace("Z"," +00:00")).astimezone(IST).date().isoformat()
                if ts_date == target and not t.get("tradingDate"):
                    txns_today.append(t)
            except Exception:
                continue
    # Opening balance: previous day closing balance or startDate balance
    # For demo, opening = balance before first txn of day, else current balance if no txn
    # Find previous day closing
    all_sorted = sorted(txns, key=lambda x: str(x.get("timestamp") or ""), reverse=False)
    # Deposits/Withdrawals
    deposits = sum(float(x.get("amount") or 0) for x in txns_today if str(x.get("type") or "").upper() == "DEPOSIT")
    withdrawals = sum(float(x.get("amount") or 0) for x in txns_today if str(x.get("type") or "").upper() == "WITHDRAWAL")
    # Gross realized: sum of TRADE_REALIZED_PNL credits minus debits
    gross_realized = 0.0
    for x in txns_today:
        if str(x.get("type") or "").upper() == "TRADE_REALIZED_PNL":
            amt = float(x.get("amount") or 0)
            if str(x.get("direction") or "").upper() == "CREDIT":
                gross_realized += amt
            else:
                gross_realized -= amt
    # Charges: sum of CHARGE debits
    charges = sum(float(x.get("amount") or 0) for x in txns_today if str(x.get("type") or "").upper() == "CHARGE")
    # Net = gross - charges
    net_realized = round(gross_realized - charges, 2)
    # If no ledger realized entries, fallback to account realizedPnl allocated to today (when today is current trading day)
    # Use closed positions for that date as secondary source
    if gross_realized == 0 and charges == 0:
        try:
            from services.dummy_extras import list_closed_positions
            closed = await list_closed_positions()
            for c in (closed or []):
                if str(c.get("tradingDate") or "") == target or str(c.get("closedAt") or "")[:10] == target:
                    gross_realized += float(c.get("realizedPnl") or 0)
                    charges += float(c.get("charges") or 0)
            net_realized = round(gross_realized - charges, 2)
        except Exception:
            pass
    # Opening/Closing balances: derive from ledger
    # Opening = balanceBefore of earliest today txn, else previous day closing or starting balance
    opening_balance = None
    closing_balance = None
    if txns_today:
        # Sort today txns by timestamp asc to find opening/closing
        today_sorted = sorted(txns_today, key=lambda x: str(x.get("timestamp") or ""))
        first = today_sorted[0]
        last = today_sorted[-1]
        opening_balance = first.get("balanceBefore", first.get("balanceAfter"))
        if opening_balance is None:
            # Fallback: compute from last before today
            opening_balance = float(account.get("balance") or 0) - deposits + withdrawals + charges - gross_realized
        closing_balance = last.get("balanceAfter", last.get("balanceBefore"))
        if closing_balance is None:
            closing_balance = float(account.get("balance") or 0)
    else:
        # No activity today
        # Try to get previous snapshot opening from daily history
        try:
            from services.dummy_extras import _load_history as _gdh
            hist = await _gdh()
            # hist is list of {date, balance, ...} sorted
            for h in sorted(hist or [], key=lambda x: str(x.get("date") or "")):
                if str(h.get("date") or "") < target:
                    opening_balance = float(h.get("balance") or h.get("closingBalance") or opening_balance or 0)
                    closing_balance = opening_balance
            if opening_balance is None:
                opening_balance = float(account.get("balance") or 0)
                closing_balance = opening_balance
        except Exception:
            opening_balance = float(account.get("balance") or 0)
            closing_balance = opening_balance
        if opening_balance is None:
            opening_balance = float(account.get("balance") or 0)
        if closing_balance is None:
            closing_balance = opening_balance
    opening_balance = round(float(opening_balance or 0), 2)
    closing_balance = round(float(closing_balance or 0), 2)
    # Equity
    unrealized = float(account.get("unrealizedPnl") or 0) if target == (await _session_stamps())[0] else 0.0
    # For historical dates, unrealized not available unless snapshot stored
    hist_unreal = None
    try:
        from services.dummy_extras import _load_history as _gdh2
        hist2 = await _gdh2()
        for h in hist2 or []:
            if str(h.get("date") or "") == target:
                hist_unreal = float(h.get("unrealizedPnl") or 0)
                break
    except Exception:
        pass
    current_unreal = hist_unreal if hist_unreal is not None else unrealized
    opening_equity = round(opening_balance + (0 if hist_unreal is None else 0), 2)  # without intraday snapshots, opening equity = opening balance
    closing_equity = round(closing_balance + float(current_unreal or 0), 2) if target == (await _session_stamps())[0] else closing_balance
    # Orders/positions counts for date
    try:
        orders = await get_dummy_orders()
        orders_today = [o for o in orders if str(o.get("tradingDate") or "") == target or str(o.get("orderDate") or "")[:10] == target]
        filled = len([o for o in orders_today if str(o.get("status") or "").upper() in ("COMPLETE","FILLED","EXECUTED")])
        rejected = len([o for o in orders_today if str(o.get("status") or "").upper() == "REJECTED"])
        cancelled = len([o for o in orders_today if str(o.get("status") or "").upper() == "CANCELLED"])
        total_orders = len(orders_today)
    except Exception:
        total_orders = filled = rejected = cancelled = 0
    try:
        positions = await get_dummy_positions()
        open_pos = len([p for p in positions if int(p.get("netQuantity") or 0) != 0])
    except Exception:
        open_pos = 0
    try:
        from services.dummy_extras import list_closed_positions as _gcp
        closed_all = await _gcp()
        closed_today = len([c for c in closed_all or [] if str(c.get("tradingDate") or "") == target or str(c.get("closedAt") or "")[:10] == target])
    except Exception:
        closed_today = 0
    return {
        "date": target,
        "openingBalance": opening_balance,
        "deposits": round(deposits, 2),
        "withdrawals": round(withdrawals, 2),
        "grossRealizedPnl": round(gross_realized, 2),
        "totalCharges": round(charges, 2),
        "netRealizedPnl": net_realized,
        "openingEquity": opening_equity,
        "closingEquity": closing_equity,
        "peakEquity": None,
        "lowestEquity": None,
        "unrealizedPnl": round(float(current_unreal or 0),2),
        "orders": total_orders,
        "filledOrders": filled,
        "rejectedOrders": rejected,
        "cancelledOrders": cancelled,
        "openPositions": open_pos,
        "closedPositions": closed_today,
        "stat": "Ok",
    }


def _to_engine_order_intent(req: DemoPlaceOrderRequest) -> dict:
    """Map the paper-engine request shape onto the Order Engine's order intent.

    The Order Engine speaks ONE shape for every terminal (``_order_kwargs`` /
    ``_adapter_kwargs`` in ``core/engines/order_engine.py``): snake_case keys,
    scalar values, and the optional richer paper fields (``expected_ltp``,
    ``amount``, ``lot_size``, ``margin_per_share`` …) that only the Dummy
    adapter declares.

    The browser sends the paper shape (``transactionType``, ``orderType``,
    ``disclosedQty``, ``ltp`` …). This function is the single, explicit
    translation between the two.

    It used to be MISSING from this module: ``place_demo_order`` called it
    without ever defining or importing it, so every ``POST
    /api/demo/order/place`` died with ``NameError: name
    '_to_engine_order_intent' is not defined`` → HTTP 500. No paper order could
    ever be placed from the trade page.
    """
    def _int(value: Any, default: int = 0) -> str:
        try:
            return str(int(value))
        except (TypeError, ValueError):
            return str(default)

    def _float(value: Any, default: float = 0.0) -> str:
        try:
            return str(float(value))
        except (TypeError, ValueError):
            return str(default)

    return {
        # identity
        "symbol": str(req.symbol or ""),
        "trading_symbol": str(req.tradingSymbol or req.symbol or ""),
        "token": str(req.token or ""),
        "exchange": str(req.exchange or "nse_cm"),
        "exchange_segment": str(req.exchangeSegment or "NSE_CM"),
        # order intent
        "transaction_type": str(req.transactionType or "BUY").upper(),
        "product": str(req.product or "MIS").upper(),
        "order_type": str(req.orderType or "MKT").upper(),
        "quantity": _int(req.quantity),
        "price": _float(req.price),
        "trigger_price": _float(req.triggerPrice),
        "disclosed_quantity": _int(req.disclosedQty),
        "validity": str(req.validity or "DAY").upper(),
        # paper-only extras (forwarded only because the Dummy adapter declares them)
        "expected_ltp": _float(req.ltp),
        "source": str(req.source or "MANUAL").upper(),
        "amount": _float(req.amount),
        "lot_size": _int(req.lotSize),
        "margin_per_share": _float(req.marginPerShare),
    }


@router.post("/order/place")
async def place_demo_order(req: DemoPlaceOrderRequest):
    """Place a paper order THROUGH the Order Engine.

    Every terminal â€” including Dummy â€” goes Risk â†’ Audit â†’ Adapter, so a Dummy
    order is validated and audited identically to a Kotak one and the UI cannot
    reach the paper store by any other route.
    """
    from brokers.manager import active_terminal
    from core.engines import order_engine

    terminal = active_terminal()
    if terminal != "dummy":
        # A real broker is active: the paper engine must never shadow it. The
        # shared terminal route owns real orders; refuse rather than silently
        # simulate while a live terminal is selected.
        return {
            "data": {"n_ord_no": None, "stat": "NotOk",
                     "remarks": f"{terminal} terminal is active â€” switch to Dummy to place paper orders"},
            "stat": "NotOk", "isDemo": False, "terminal": terminal,
        }
    result = await order_engine.place("dummy", _to_engine_order_intent(req))
    if not result.get("ok"):
        err = result.get("error") or {}
        return {
            "data": {"n_ord_no": None, "stat": "NotOk",
                     "remarks": err.get("message") or "; ".join(result.get("reasons") or []) or "order rejected"},
            "stat": "NotOk", "isDemo": True, "terminal": "dummy",
            "error": err, "reasons": result.get("reasons") or [],
        }
    broker_result = result.get("data") or {}
    demo_order = broker_result.get("demoOrder") if isinstance(broker_result, dict) else None
    status = str((demo_order or {}).get("status") or result.get("status") or "COMPLETE").upper()
    # PENDING / OPEN / TRIGGER_PENDING are WORKING orders: accepted by the
    # engine, not yet executed. Reporting them as "filled" is exactly the lie
    # this route exists to prevent.
    working = status not in ("COMPLETE", "REJECTED", "CANCELLED")
    return {
        "data": {"n_ord_no": result.get("orderId"), "stat": "Ok"},
        "stat": "Ok", "isDemo": True, "terminal": "dummy",
        "orderId": result.get("orderId"), "status": status,
        "accepted": True, "working": working,
        "demoOrder": demo_order, "engine": result,
    }


@router.post("/order/cancel")
async def cancel_demo_order(req: DemoCancelOrderRequest):
    """Cancel a paper order through the Order Engine (verify â†’ cancel â†’ publish)."""
    from core.engines import order_engine

    result = await order_engine.cancel("dummy", req.orderId)
    if not result.get("ok"):
        err = result.get("error") or {}
        return {
            "data": {"n_ord_no": req.orderId, "stat": "NotOk",
                     "remarks": err.get("message") or "order cancel rejected"},
            "stat": "NotOk", "isDemo": True, "terminal": "dummy", "error": err,
        }
    broker_result = result.get("data") or {}
    demo_order = broker_result.get("demoOrder") if isinstance(broker_result, dict) else None
    return {
        "data": {"n_ord_no": req.orderId, "stat": "Ok"},
        "stat": "Ok", "isDemo": True, "terminal": "dummy",
        "orderId": req.orderId, "status": "CANCELLED",
        "accepted": True, "working": False, "demoOrder": demo_order,
    }


@router.post("/position/squareoff")
async def squareoff_demo_position(req: DemoSquareOffRequest):
    """Square off a paper position THROUGH the Order Engine.

    A square-off is an order: it gets the same Risk â†’ Audit â†’ Adapter treatment
    as a manual order instead of mutating the paper book directly.
    """
    from brokers.manager import get_adapter
    from core.engines import order_engine

    positions = await get_dummy_positions()
    position = next(
        (p for p in positions
         if str(p.get("symbol", "")).upper() == str(req.symbol or "").strip().upper()
         and (not req.product or str(p.get("product", "")).upper() == str(req.product).upper())),
        None,
    )
    if position is None:
        return {
            "data": {"n_ord_no": None, "stat": "NotOk",
                     "remarks": f"No open {req.symbol} {req.product} position to square off"},
            "stat": "NotOk", "isDemo": True, "terminal": "dummy",
        }
    result = await order_engine.square_off("dummy", position)
    if not result.get("ok"):
        err = result.get("error") or {}
        return {
            "data": {"n_ord_no": None, "stat": "NotOk",
                     "remarks": err.get("message") or "square-off rejected"},
            "stat": "NotOk", "isDemo": True, "terminal": "dummy", "error": err,
        }
    return {
        "data": {"n_ord_no": None, "stat": "Ok"},
        "stat": "Ok", "isDemo": True, "terminal": "dummy",
        "accepted": True, "engine": result,
    }


@router.post("/ltp")
async def update_demo_ltp(req: DemoLtpRequest):
    return await apply_demo_ltp(req.updates)


@router.post("/funds/add")
async def add_demo_funds(req: DemoFundsRequest):
    return await deposit_demo_funds(req.amount)


@router.post("/funds/withdraw")
async def withdraw_demo_funds(req: DemoFundsRequest):
    return await withdrawal_demo_funds(req.amount)


@router.post("/reset")
async def reset_demo_account(req: DemoResetRequest):
    return await reset_dummy_account(req.startingBalance)


@router.post("/connect")
async def connect_dummy():
    """Connect / ensure-ready the Dummy (paper) terminal.

    Idempotent: if Dummy is already managed+logged in this is a no-op success.
    Otherwise calls ensure_auto_ready() so the paper engine is live for the
    whole backend run without needing broker credentials.
    """
    from brokers.dummy import dummy_adapter
    try:
        ok = await dummy_adapter.ensure_auto_ready()
        return {
            "ok": ok,
            "connected": bool(dummy_adapter.is_logged_in),
            "managed": bool(dummy_adapter._managed),
            "terminal": "dummy",
            "broker": dummy_adapter.broker_name,
            "message": "Dummy terminal connected" if ok else "Dummy connect failed",
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "connected": bool(dummy_adapter.is_logged_in),
            "terminal": "dummy",
            "broker": dummy_adapter.broker_name,
            "error": {"code": "CONNECT_FAILED", "message": str(exc)},
        }
