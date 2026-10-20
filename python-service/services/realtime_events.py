"""Realtime lifecycle publishers — real order / position / trade events onto
the single backend→frontend WebSocket #2 via the state bridge.

Order Engine (core/engines/order_engine.py), the Dummy paper engine
(api/demo.py) and the Kotak order feed (ws_socket/order_feed_manager.py) are the
only producers. Each publishes a JSON-serializable frame into
``services.state_store``; ConnectionEngine._bridge_loop drains that queue and
``_broadcast_frame`` routes it to sessions subscribed to the derived channel
(order.* → orders, position.* / trade.* → positions). The event types mirror the
frontend wire vocabulary used by order_feed_manager, so KOTAK WS#2 events and
these engine events are indistinguishable to consumers.

Nothing here fabricates a value: every call site passes real, server-observed
state after it was persisted.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger("realtime_events")


def _iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def publish_frame(frame: dict[str, Any]) -> None:
    """Best-effort publish to the state bridge. Never raises into the caller."""
    try:
        from services.state_store import get_state_store
        await get_state_store().publish(frame)
        logger.info("[REALTIME-FRAME] published type=%s status=%s", frame.get("type"), (frame.get("data") or {}).get("status"))
    except Exception as exc:
        logger.info("[REALTIME-FRAME] PUBLISH ERROR type=%s exc=%s", frame.get("type"), exc)
        logger.debug("realtime frame publish skipped: %s", exc)


async def order_update(
    order: dict,
    *,
    status: str,
    terminal: str = "",
    symbol: str = "",
    token: str = "",
    reason: str = "",
) -> None:
    """Emit an ``order.update`` frame for the ``orders`` channel."""
    filled_raw = order.get("fills", 0) if isinstance(order.get("fills", 0), int) else None
    filled = order.get("filledQuantity") or order.get("filled_quantity") or filled_raw or 0
    payload: dict[str, Any] = {
        "orderId": order.get("orderId") or order.get("order_id") or order.get("n_ord_no"),
        "status": status,
        "symbol": symbol or order.get("symbol") or order.get("tradingSymbol") or str(order.get("trading_symbol") or ""),
        "token": token or order.get("token") or "",
        "exchange": order.get("exchange") or order.get("exchangeSegment") or str(order.get("exchange_segment") or ""),
        "terminal": terminal or order.get("terminal") or order.get("terminal_id") or "",
        "quantity": order.get("quantity"),
        "filledQuantity": filled,
        "averageTradedPrice": order.get("averageTradedPrice") or order.get("averagePrice") or order.get("average_price"),
        "transactionType": order.get("transactionType") or order.get("transaction_type"),
        "product": order.get("product"),
        "orderType": order.get("orderType") or order.get("order_type"),
        "order": order,
    }
    if reason:
        payload["reason"] = reason
    frame = {
        "type": "order.update",
        "timestamp": _iso(),
        "source": "order_engine",
        "data": payload,
    }
    await publish_frame(frame)


async def trade_fill(
    order: dict,
    *,
    terminal: str = "",
    symbol: str = "",
    token: str = "",
    price: Optional[float] = None,
    quantity: Optional[int] = None,
) -> None:
    """Emit a ``trade.fill`` frame for the ``positions`` channel."""
    payload: dict[str, Any] = {
        "orderId": order.get("orderId") or order.get("order_id") or order.get("n_ord_no"),
        "symbol": symbol or order.get("symbol") or order.get("tradingSymbol") or str(order.get("trading_symbol") or ""),
        "token": token or order.get("token") or "",
        "exchange": order.get("exchange") or order.get("exchangeSegment") or str(order.get("exchange_segment") or ""),
        "terminal": terminal or order.get("terminal") or "",
        "quantity": quantity if quantity is not None else order.get("filledQuantity") or order.get("quantity"),
        "price": price if price is not None else order.get("averageTradedPrice") or order.get("averagePrice"),
        "transactionType": order.get("transactionType") or order.get("transaction_type"),
        "product": order.get("product"),
        "order": order,
    }
    frame = {
        "type": "trade.fill",
        "timestamp": _iso(),
        "source": "order_engine",
        "data": payload,
    }
    await publish_frame(frame)


async def position_update(
    positions: list[dict],
    *,
    terminal: str = "",
    symbol: str = "",
) -> None:
    """Emit a ``position.update`` frame for the ``positions`` channel."""
    frame = {
        "type": "position.update",
        "timestamp": _iso(),
        "source": "order_engine",
        "symbol": symbol,
        "data": {
            "positions": positions,
            "terminal": terminal or "dummy",
            "count": len(positions or []),
        },
    }
    await publish_frame(frame)