"""Order Engine API — the single control surface for the Order Engine page.

``docs/engines/order-engine.md`` defines Order Engine as one controlled path for
every order: validate → risk → broker adapter → execution state → result
distribution. This router is the view of that engine for the UI, and it is
deliberately the only place the page places, modifies or cancels an order — so
the page cannot reach a broker (or the paper store) by any other route.

Three things it adds on top of the raw terminal endpoints:

* a **canonical order row** — every terminal's native order shape folded into one
  vocabulary, so a Kotak ``not_Ok`` and a paper ``TRIGGER_PENDING`` are
  comparable rows and not two different tables to read;
* the **state machine** the doc specifies, with counts derived from live orders
  rather than a hard-coded list;
* the **real-time data provenance** — whether a live price exists right now and
  where it came from, so the page can say "waiting for live market data" instead
  of implying the feed is healthy.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from brokers.manager import active_terminal, get_adapter
from brokers.models import BrokerError, safe_float
from core.engines import order_engine

logger = logging.getLogger("order_engine_api")

router = APIRouter(prefix="/api/order-engine", tags=["order-engine"])


# ---------------------------------------------------------------------------
# Canonical status model (docs/engines/order-engine.md §24)
# ---------------------------------------------------------------------------
#: Accepted by the broker, still working. NOT executed.
WORKING = ("PENDING", "OPEN", "TRIGGER_PENDING", "PARTIALLY_FILLED", "SUBMITTED", "NEW", "ACK")
#: Fully executed against the real market.
EXECUTED = ("COMPLETE", "COMPLETED", "FILLED", "EXECUTED", "TRADED")
#: Refused — locally, by risk, or by the broker itself.
REJECTED = ("REJECTED", "REJECT", "NOTOK", "FAILED", "EXPIRED")
#: Withdrawn on request.
CANCELLED = ("CANCELLED", "CANCELED")

_STATE_ORDER = WORKING + EXECUTED + REJECTED + CANCELLED


def canonical_status(raw: Any) -> str:
    """Fold any terminal's native status into the doc's state machine.

    Brokers disagree on wording for the same event (Kotak ``complete``,
    Shoonya ``COMPLETE``, paper ``TRIGGER_PENDING``), and a handful of the
    tokens they return contain spaces. Normalizing here is what lets one status
    column and one status filter work across every terminal.
    """
    text = str(raw or "").strip().upper().replace("_", " ").replace("-", " ")
    text = " ".join(text.split())
    if text in _STATE_ORDER:
        return text
    if text in ("NOT TRADED", "NOT OK", "NOTOK", "OPEN PENDING", "TRIGGERED", "NOT TRAED"):
        return "PENDING"
    if "PARTIAL" in text or "PARTFULL" in text:
        return "PARTIALLY_FILLED"
    if text in ("COMPLETE", "COMPLETED", "FILLED", "FULLY FILLED", "TRADED", "EXECUTED"):
        return "COMPLETE"
    if "CANCEL" in text:
        return "CANCELLED"
    if "REJECT" in text or text in ("FAIL", "FAILED", "ERROR", "EXPIRED", "NOTOK"):
        return "REJECTED"
    if "TRIGGER" in text:
        return "TRIGGER_PENDING"
    if not text:
        return "UNKNOWN"
    if "PEND" in text or "NEW" in text or "OPEN" in text or "ACK" in text or "QUEU" in text:
        return "PENDING"
    return "UNKNOWN"


def is_working(status: Any) -> bool:
    return canonical_status(status) in WORKING


def _pick(row: dict, *keys: str, default: Any = "") -> Any:
    for key in keys:
        value = row.get(key)
        if value not in (None, ""):
            return value
    return default


def canonical_order(row: dict, terminal: str) -> dict:
    """One order row, whatever the terminal's native shape is."""
    qty = int(safe_float(_pick(row, "quantity", "qty", "Quantity", default=0)))
    filled = int(safe_float(_pick(row, "filledQuantity", "fldQty", "FilledQty", default=0)))
    avg = safe_float(_pick(row, "averageTradedPrice", "avgPrice", "AvgPrc", default=0))
    price = safe_float(_pick(row, "price", "prc", "Prc", default=0))
    raw_status = _pick(row, "status", "ordSt", "orderStatus", "order_status", "stat", default="")
    return {
        "orderId": str(_pick(row, "orderId", "nOrdNo", "n_ord_no", "orderid", "order_id", default="")),
        "symbol": str(_pick(row, "symbol", "tradingSymbol", "trdSym", "tradingsymbol", default="")).upper(),
        "token": str(_pick(row, "token", "instrumentToken", default="")),
        "terminal": terminal,
        "broker": _BROKER_LABEL.get(terminal, terminal),
        "isPaper": terminal == "dummy",
        "side": str(_pick(row, "transactionType", "trnsTp", "buyOrSell", "txnType", default="")).upper(),
        "product": str(_pick(row, "product", "prd", default="")),
        "orderType": str(_pick(row, "orderType", "ordType", default="")),
        "quantity": qty,
        "filledQuantity": filled,
        "pendingQuantity": max(qty - filled, 0),
        "price": price,
        "triggerPrice": safe_float(_pick(row, "triggerPrice", "trgPrice", default=0)),
        "averagePrice": avg,
        "orderValue": safe_float(_pick(row, "orderValue", default=price * qty)),
        "status": canonical_status(raw_status),
        "rawStatus": str(raw_status or ""),
        "working": is_working(raw_status),
        "executed": canonical_status(raw_status) == "COMPLETE",
        "reason": str(_pick(row, "errorMessage", "remarks", "reason", "message", default="") or ""),
        "waitingReason": str(row.get("waitingReason") or ""),
        "awaitingLtp": bool(row.get("awaitingLtp")),
        "source": str(_pick(row, "source", default="MANUAL")).upper(),
        "basketId": row.get("basketId") or row.get("basket_id"),
        "correlationId": row.get("correlationId") or row.get("correlation_id") or "",
        "charges": safe_float(_pick(row, "charges", "totalCharges", default=0)),
        "placedAt": str(_pick(row, "orderDate", "orderTime", "placedAt", "exchangeTime", default="")),
    }


_BROKER_LABEL = {"kotak": "KOTAK", "shoonya": "SHOONYA", "dummy": "DUMMY"}


# ---------------------------------------------------------------------------
# Feed provenance — never let the page imply data that is not arriving
# ---------------------------------------------------------------------------
async def _market_data_status() -> dict[str, Any]:
    try:
        from services import tick_buffer

        stats = tick_buffer.stats()
    except Exception as exc:  # noqa: BLE001
        logger.debug("order-engine tick stats unavailable: %s", exc)
        stats = {}
    tps = float(stats.get("ticksPerSecond", 0.0) or 0.0)
    receiving = tps > 0
    try:
        from services.paper_market_feed import paper_market_feed

        paper = paper_market_feed.status()
    except Exception as exc:  # noqa: BLE001
        logger.debug("paper feed status unavailable: %s", exc)
        paper = {"running": False}
    return {
        "liveFeedReceiving": receiving,
        "ticksPerSecond": tps,
        "latestTickCount": int(stats.get("latestTickCount", 0) or 0),
        "lastTickAt": stats.get("lastTickAt"),
        "feedState": stats.get("feedState") or "NO_FEED",
        "source": "services.tick_buffer (WS#1 real broker feed)",
        "paperFeed": paper,
        "message": (
            "Live market data flowing" if receiving
            else "No live market data — new orders stay working until a real price arrives"
        ),
    }


# ---------------------------------------------------------------------------
# Requests
# ---------------------------------------------------------------------------
class OrderRequest(BaseModel):
    exchange: str = "nse_cm"
    exchange_segment: str = "NSE_CM"
    token: str = ""
    symbol: str = ""
    trading_symbol: str = ""
    transaction_type: str = "BUY"
    product: str = "MIS"
    order_type: str = "MKT"
    quantity: str = "1"
    price: str = "0"
    trigger_price: str = "0"
    disclosed_quantity: str = "0"
    validity: str = "DAY"
    source: str = "MANUAL"
    basket_id: str | None = None
    correlation_id: str = ""
    #: Only ever a genuinely observed real price. The page sends the live LTP it
    #: already renders; the engine falls back to the backend's own tick buffer,
    #: and parks the order if neither has one. Nothing here is ever invented.
    expected_ltp: str = "0"


class OrderIdRequest(BaseModel):
    order_id: str
    reason: str = ""


class ModifyEngineRequest(BaseModel):
    order_id: str
    quantity: str = "0"
    price: str = "0"
    trigger_price: str = "0"
    order_type: str = "MKT"
    exchange: str = "nse_cm"
    transaction_type: str = "BUY"
    product: str = "MIS"
    validity: str = "DAY"
    disclosed_quantity: str = "0"
    token: str = ""
    symbol: str = ""


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@router.get("/state")
async def order_engine_state() -> dict[str, Any]:
    """Engine identity, active terminal/session, state machine + feed status."""
    terminal = active_terminal()
    try:
        adapter = get_adapter(terminal)
        connected = bool(adapter.is_logged_in)
        capabilities = adapter.capabilities
    except Exception as exc:  # noqa: BLE001
        logger.debug("order-engine adapter probe failed: %s", exc)
        adapter, connected, capabilities = None, False, {}

    return {
        "ok": True,
        "engine": "order_engine",
        "terminal": terminal,
        "broker": _BROKER_LABEL.get(terminal, terminal),
        "isPaper": terminal == "dummy",
        "connected": connected,
        "capabilities": capabilities,
        "states": {
            "working": list(WORKING),
            "executed": list(EXECUTED),
            "rejected": list(REJECTED),
            "cancelled": list(CANCELLED),
        },
        "marketData": await _market_data_status(),
    }


@router.get("/orders")
async def order_engine_orders(terminal: str = "") -> dict[str, Any]:
    """Canonical live order book for a terminal, plus state-machine counts."""
    mode = terminal if terminal in ("kotak", "shoonya", "dummy") else active_terminal()
    try:
        adapter = get_adapter(mode)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    connected = bool(adapter.is_logged_in)
    if not connected:
        return {
            "ok": True, "terminal": mode, "broker": _BROKER_LABEL.get(mode, mode),
            "isPaper": mode == "dummy", "connected": False, "orders": [], "counts": {},
            "total": 0, "message": f"{adapter.broker_name} not connected",
            "marketData": await _market_data_status(),
        }

    try:
        raw = await adapter.orders()
    except BrokerError as exc:
        return {
            "ok": True, "terminal": mode, "connected": False, "orders": [], "counts": {},
            "total": 0, "message": exc.message,
            "marketData": await _market_data_status(),
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning("order-engine order book failed: %s", exc)
        return {
            "ok": True, "terminal": mode, "connected": True, "orders": [], "counts": {},
            "total": 0, "message": f"order book unavailable: {exc}",
            "marketData": await _market_data_status(),
        }

    rows = _extract_rows(raw)
    orders = [canonical_order(r, mode) for r in rows]

    counts: dict[str, int] = {}
    for order in orders:
        counts[order["status"]] = counts.get(order["status"], 0) + 1
    counts["TOTAL"] = len(orders)
    counts["WORKING"] = sum(1 for o in orders if o["working"])

    return {
        "ok": True,
        "terminal": mode,
        "broker": _BROKER_LABEL.get(mode, mode),
        "isPaper": mode == "dummy",
        "connected": True,
        "orders": orders,
        "counts": counts,
        "total": len(orders),
        "marketData": await _market_data_status(),
    }


def _extract_rows(raw: Any) -> list[dict]:
    """Pull the order list out of whatever envelope the terminal returns."""
    if isinstance(raw, list):
        return [r for r in raw if isinstance(r, dict)]
    if not isinstance(raw, dict):
        return []
    for key in ("orderBook", "orders", "data", "tradeBook", "trade_book"):
        value = raw.get(key)
        if isinstance(value, list):
            return [r for r in value if isinstance(r, dict)]
        if isinstance(value, dict):
            nested = _extract_rows(value)
            if nested:
                return nested
    return []


@router.post("/place")
async def order_engine_place(body: OrderRequest) -> dict[str, Any]:
    """Place an order on the active terminal through the Order Engine.

    This is the page's only placement route. Risk → Audit → Adapter, and the
    response distinguishes ACCEPTED-WORKING from EXECUTED, because those are
    different facts and the doc requires the UI to tell them apart.
    """
    terminal = active_terminal()
    intent = body.model_dump()
    intent["terminal"] = terminal
    try:
        result = await order_engine.place(terminal, intent)
    except BrokerError as exc:
        raise HTTPException(502, exc.message) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    broker_result = result.get("data") if isinstance(result.get("data"), dict) else {}
    demo_order = broker_result.get("demoOrder") if isinstance(broker_result, dict) else None
    order_row = canonical_order(demo_order or {}, terminal) if isinstance(demo_order, dict) else None
    return {
        **result,
        "order": order_row,
        "status": result.get("status") or (order_row or {}).get("status") or "UNKNOWN",
        "marketData": await _market_data_status(),
    }


@router.post("/cancel")
async def order_engine_cancel(body: OrderIdRequest) -> dict[str, Any]:
    """Cancel an order on the active terminal through the Order Engine."""
    terminal = active_terminal()
    try:
        result = await order_engine.cancel(terminal, body.order_id)
    except BrokerError as exc:
        raise HTTPException(502, exc.message) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {**result, "status": "CANCELLED" if result.get("ok") else "CANCEL_FAILED"}


@router.post("/modify")
async def order_engine_modify(body: ModifyEngineRequest) -> dict[str, Any]:
    """Modify a working order on the active terminal through the Order Engine.

    The engine's risk gate still runs, so a modification that would leave the
    order invalid (a stop without a trigger, a limit without a price) is refused
    before it reaches the terminal.
    """
    terminal = active_terminal()
    try:
        result = await order_engine.modify(terminal, body.order_id, body.model_dump())
    except BrokerError as exc:
        raise HTTPException(502, exc.message) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {**result, "status": "MODIFIED" if result.get("ok") else "MODIFY_FAILED"}


@router.get("/history")
async def order_engine_history(terminal: str = "", limit: int = 200) -> dict[str, Any]:
    """Order history for a terminal, canonicalised to the same row shape."""
    mode = terminal if terminal in ("kotak", "shoonya", "dummy") else active_terminal()
    try:
        adapter = get_adapter(mode)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not adapter.is_logged_in:
        return {"ok": True, "terminal": mode, "connected": False, "orders": [],
                "message": f"{adapter.broker_name} not connected"}
    try:
        raw = await adapter.order_history()
    except Exception as exc:  # noqa: BLE001
        logger.warning("order-engine history failed: %s", exc)
        return {"ok": True, "terminal": mode, "connected": True, "orders": [], "message": str(exc)}
    rows = _extract_rows(raw)[: max(1, min(int(limit or 200), 1000))]
    return {
        "ok": True, "terminal": mode, "broker": _BROKER_LABEL.get(mode, mode),
        "isPaper": mode == "dummy", "connected": True,
        "orders": [canonical_order(r, mode) for r in rows],
    }