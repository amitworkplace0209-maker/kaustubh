"""Order Engine — the ONLY path to the broker order actions.

Every order (place / modify / cancel / square-off) for EVERY terminal runs
Risk → Audit → Adapter. A rejected order never reaches an adapter. This is the
single choke point the frontend, Dummy terminal, baskets and any future AI
executor must go through — no module may call an adapter's place_order
directly.
"""
from __future__ import annotations
import logging
from typing import Any

from brokers.manager import get_adapter
from brokers.models import BrokerError, safe_float
from core.engines import risk_engine, audit_engine

logger = logging.getLogger("app")

#: Accepted-but-not-yet-executed states. An order in one of these is WORKING:
#: the broker accepted it and still owes us a fill. Presenting any of these as
#: "executed" is the single most misleading thing an order book can do.
WORKING_STATUSES = frozenset({
    "PENDING", "OPEN", "TRIGGER_PENDING", "PARTIALLY_FILLED",
    "SUBMITTED", "ACCEPTED", "NEW", "NOT_TRADED", "NOT TRAED", "ACK",
    "TRIGGERED", "OPEN_PENDING", "CANCEL_PENDING",
})

#: Canonical status vocabulary shared by every terminal. Brokers speak different
#: words (Kotak "Not_Ok"/"complete", Shoonya "COMPLETE", the paper engine
#: "TRIGGER_PENDING"); the engine and the UI speak one.
EXECUTED_STATUSES = frozenset({"COMPLETE", "COMPLETED", "FILLED", "EXECUTED", "TRADED"})
TERMINAL_STATUSES = frozenset({
    "COMPLETE", "COMPLETED", "FILLED", "EXECUTED", "TRADED",
    "REJECTED", "REJECT", "CANCELLED", "CANCELED", "EXPIRED", "FAILED",
})


async def _publish_order_event(order: dict, status: str, *, reason: str = "") -> None:
    """Best-effort realtime ``order.update`` frame for the WS#2 orders channel.
    Emits only server-observed outcomes (submitted / rejected / failed)."""
    try:
        from services.realtime_events import order_update
        await order_update(
            order,
            status=status,
            terminal=order.get("terminal") or "",
            symbol=str(order.get("symbol") or order.get("tradingSymbol") or ""),
            token=str(order.get("token") or ""),
            reason=reason,
        )
    except Exception as exc:
        logger.debug("order realtime publish skipped: %s", exc)


async def _notify_order(order: dict, severity: str, title: str, message: str, event_type: str) -> None:
    """Best-effort global notification for an order lifecycle event. Never
    raises into the order path — a notification failure cannot reject an order."""
    if not order:
        return
    try:
        from services.notification_service import notify
        await notify(
            "trade",
            severity,
            title,
            message,
            source="order-engine",
            event_type=event_type,
            metadata={
                "terminal": order.get("terminal"),
                "symbol": str(order.get("symbol") or order.get("tradingSymbol") or "").upper(),
                "token": str(order.get("token") or ""),
                "exchange": order.get("exchange") or "nse_cm",
                "order_id": order.get("order_id") or order.get("orderId"),
                "quantity": order.get("quantity"),
                "side": order.get("transaction_type") or order.get("transactionType"),
                "product": order.get("product"),
                "order_type": order.get("order_type") or order.get("orderType"),
            },
        )
    except Exception as exc:
        logger.debug("order notification skipped: %s", exc)


def _order_kwargs(order: dict) -> dict:
    """Order-intent fields that every adapter understands."""
    allowed = (
        "exchange", "token", "symbol", "transaction_type", "product",
        "order_type", "quantity", "price", "trigger_price", "validity",
        "disclosed_quantity", "amo", "market_protection", "client_id",
    )
    return {k: order[k] for k in allowed if k in order and order[k] not in (None, "")}


def _adapter_kwargs(adapter: Any, order: dict) -> dict:
    """The order intent, narrowed to what THIS adapter actually accepts.

    Two things happen here. First, the REAL observed LTP the caller already holds
    is forwarded (only when positive) to paper/price-less engines that cannot tap
    a feed of their own — a real broker ignores it and prices from its own feed.
    Second, the payload is filtered against the adapter's real signature, so
    richer paper-engine fields (``source``, ``trading_symbol``,
    ``exchange_segment``, margin sizing) reach the Dummy adapter while a real
    broker never receives a keyword it does not declare. Sending an unknown
    keyword is a TypeError, which is how an order engine accidentally starts
    rejecting valid orders on one terminal only.
    """
    kwargs = _order_kwargs(order)

    optional = (
        "expected_ltp", "source", "trading_symbol", "exchange_segment",
        "amount", "lot_size", "margin_per_share",
    )
    for key in optional:
        value = order.get(key)
        if value in (None, ""):
            continue
        kwargs[key] = value
    try:
        ltp = float(order.get("expected_ltp") or 0)
    except (TypeError, ValueError):
        ltp = 0.0
    if ltp <= 0:
        # Never let a placeholder price reach an adapter.
        kwargs.pop("expected_ltp", None)

    accepted = _accepted_kwargs(adapter)
    if accepted is None:
        return kwargs
    return {k: v for k, v in kwargs.items() if k in accepted}


_ADAPTER_SIGNATURE_CACHE: dict[int, frozenset[str] | None] = {}


def _accepted_kwargs(adapter: Any) -> frozenset[str] | None:
    """Keyword names the adapter's `place_order` declares, or None if unknown.

    Cached per adapter instance (WeakKeyDictionary is overkill here — adapters
    are process-lifetime singletons and a stale entry only over-filters an
    optional field, never a required one).
    """
    key = id(adapter)
    if key in _ADAPTER_SIGNATURE_CACHE:
        return _ADAPTER_SIGNATURE_CACHE[key]
    accepted: frozenset[str] | None
    try:
        import inspect

        params = inspect.signature(adapter.place_order).parameters
        if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()):
            accepted = None  # accepts **kwargs — forward everything
        else:
            accepted = frozenset(
                name for name, p in params.items()
                if p.kind in (inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY)
            )
    except Exception:  # noqa: BLE001 — an uninspectable adapter gets everything
        accepted = None
    _ADAPTER_SIGNATURE_CACHE[key] = accepted
    return accepted


def _effective_broker_stat(broker_result: Any) -> tuple[str, str]:
    """(stat, remarks) as the BROKER actually reported it.

    A broker can put its verdict at the top level (``stat``) or nested under
    ``data`` — Kotak Neo answers ``{"stat": "Ok", "data": {"stat": "Not_Ok", ...}}``.
    Reading only the top level reported a rejected Kotak order as accepted with
    an empty order id, so the audit trail and the engine disagreed. Both levels
    are read here, and a rejection anywhere wins.
    """
    if not isinstance(broker_result, dict):
        return "Ok", ""
    data = broker_result.get("data") if isinstance(broker_result.get("data"), dict) else {}
    top = str(broker_result.get("stat") or "").strip()
    nested = str(data.get("stat") or "").strip()
    stat = top or nested or "Ok"
    if _stat_is_rejection(nested):
        stat = nested
    remarks = str(
        broker_result.get("remarks")
        or data.get("remarks")
        or data.get("errorMessage")
        or data.get("errMsg")
        or data.get("message")
        or ""
    )
    return stat, remarks


def _stat_is_rejection(stat: str) -> bool:
    """`Not_Ok`, `notok`, `FAIL`, `ERROR` … — any broker wording of a refusal."""
    return str(stat or "").strip().upper().replace("_", "").replace("-", "").replace(" ", "") in (
        "NOTOK", "FAIL", "FAILED", "ERROR", "REJECT", "REJECTED",
    )


async def place(terminal: str, order: dict) -> dict:
    """Risk-checked order placement. Returns a structured result (never raises
    a raw BrokerError — failures are normalized into the result)."""
    adapter = get_adapter(terminal)
    order = {**order, "terminal": terminal}
    if not adapter.is_logged_in:
        await audit_engine.record_action(
            terminal=terminal, action="place", order=order, status="rejected",
            error="not logged in to broker",
        )
        await _notify_order(
            order, "warning", "Order not placed — session required",
            f"{adapter.broker_name} session required to place an order", "ORDER_SUBMIT_REJECTED",
        )
        await _publish_order_event(order, "REJECTED", reason="broker session required")
        return {
            "ok": False, "accepted": False, "terminal": terminal,
            "error": {"code": "NOT_LOGGED_IN", "message": f"{adapter.broker_name} session required"},
        }

    decision = await risk_engine.risk_engine.validate_order(
        terminal=terminal,
        symbol=order.get("symbol", ""),
        token=order.get("token", ""),
        exchange=order.get("exchange", "nse_cm"),
        transaction_type=order.get("transaction_type", "BUY"),
        product=order.get("product", "MIS"),
        order_type=order.get("order_type", "MKT"),
        quantity=order.get("quantity", "1"),
        price=order.get("price", "0"),
        trigger_price=order.get("trigger_price", "0"),
        expected_ltp=safe_float(order.get("expected_ltp")),
    )
    await audit_engine.record_decision(terminal=terminal, decision=decision, order=order, reason="risk_validation")

    if not decision.accepted:
        await audit_engine.record_action(
            terminal=terminal, action="place", order=order, status="rejected",
            error="; ".join(decision.reasons),
        )
        await _notify_order(
            order, "error", "Order rejected — risk check failed",
            "; ".join(decision.reasons)[:500], "ORDER_REJECTED",
        )
        await _publish_order_event(order, "REJECTED", reason="; ".join(decision.reasons)[:500])
        return {
            "ok": False, "accepted": False, "terminal": terminal,
            "reasons": decision.reasons, "error": {"code": "ORDER_REJECTED", "message": "; ".join(decision.reasons)},
        }

    try:
        broker_result = await adapter.place_order(**_adapter_kwargs(adapter, order))
    except BrokerError as exc:
        await audit_engine.record_action(
            terminal=terminal, action="place", order=order, status="failed", error=exc.message,
        )
        await _notify_order(
            order, "error", "Order failed", exc.message[:500], "ORDER_FAILED",
        )
        await _publish_order_event(order, "FAILED", reason=exc.message[:500])
        return {"ok": False, "accepted": False, "terminal": terminal, "error": exc.to_dict()}
    except Exception as exc:
        await audit_engine.record_action(
            terminal=terminal, action="place", order=order, status="failed", error=str(exc),
        )
        await _notify_order(
            order, "error", "Order failed — broker unavailable",
            str(exc)[:500], "ORDER_FAILED",
        )
        await _publish_order_event(order, "FAILED", reason=str(exc)[:500])
        return {
            "ok": False, "accepted": False, "terminal": terminal,
            "error": {"code": "BROKER_UNAVAILABLE", "message": f"order failed: {exc}"},
        }

    await audit_engine.record_action(
        terminal=terminal, action="place", order=order, status="submitted",
        broker_response=broker_result,
    )
    order_id = _extract_order_id(broker_result)

    demo_order = broker_result.get("demoOrder") if isinstance(broker_result, dict) else None
    broker_stat, remarks = _effective_broker_stat(broker_result)
    outcome = (demo_order or {}).get("status", "") if isinstance(demo_order, dict) else ""
    if _stat_is_rejection(broker_stat) or str(outcome).upper() in ("REJECTED", "REJECT", "FAILED"):
        reason = str(remarks or (demo_order or {}).get("errorMessage", "")) or "order rejected by broker"
        await _notify_order(
            order, "error", "Order rejected",
            f"{(demo_order or {}).get('symbol') or order.get('symbol')} — {reason[:500]}",
            "ORDER_REJECTED",
        )
        await _publish_order_event({**order, "order_id": order_id or order.get("order_id")}, "REJECTED", reason=reason[:500])
        return {
            "ok": True, "accepted": False, "terminal": terminal,
            "orderId": order_id, "data": broker_result,
            "reasons": [reason], "error": {"code": "ORDER_REJECTED", "message": reason},
        }

    # A real broker only confirms a placement by returning an order number.
    # "Accepted with no order id" is an unverified state, and reporting it as
    # executed is how a rejected order ends up shown as filled.
    if not order_id and terminal != "dummy":
        reason = f"{adapter.broker_name} returned no order number — placement not confirmed"
        await _notify_order(order, "error", "Order not confirmed", reason[:500], "ORDER_FAILED")
        await _publish_order_event(order, "FAILED", reason=reason[:500])
        return {
            "ok": True, "accepted": False, "terminal": terminal,
            "orderId": None, "data": broker_result,
            "reasons": [reason], "error": {"code": "ORDER_NOT_CONFIRMED", "message": reason},
        }

    await _notify_order(
        order, "success", "Order submitted",
        f"{order.get('transaction_type') or 'BUY'} {order.get('quantity')} x {str(order.get('symbol') or '').upper()} accepted"
        + (f" (order {order_id})" if order_id else ""),
        "ORDER_SUBMITTED",
    )

    # A parked order is accepted-but-working (PENDING / OPEN / TRIGGER_PENDING),
    # not executed. The terminal's own status is carried through so the UI can
    # render the real state instead of assuming "accepted == filled".
    terminal_status = "SUBMITTED"
    if isinstance(demo_order, dict) and demo_order.get("status"):
        terminal_status = str(demo_order["status"]).upper()
    working = terminal_status in WORKING_STATUSES

    await _publish_order_event({**order, "order_id": order_id or order.get("order_id")}, terminal_status)
    return {
        "ok": True, "accepted": True, "terminal": terminal,
        "orderId": order_id, "data": broker_result,
        "status": terminal_status, "working": working,
        "awaitingLtp": bool(isinstance(demo_order, dict) and demo_order.get("awaitingLtp")),
        "waitingReason": (demo_order or {}).get("waitingReason") if isinstance(demo_order, dict) else None,
    }


async def modify(terminal: str, order_id: str, order: dict) -> dict:
    adapter = get_adapter(terminal)
    if not adapter.is_logged_in:
        return {"ok": False, "accepted": False, "terminal": terminal,
                "error": {"code": "NOT_LOGGED_IN", "message": f"{adapter.broker_name} session required"}}

    decision = await risk_engine.risk_engine.validate_order(
        terminal=terminal,
        symbol=order.get("symbol", ""), token=order.get("token", ""),
        transaction_type=order.get("transaction_type", "BUY"),
        product=order.get("product", "MIS"), order_type=order.get("order_type", "MKT"),
        quantity=order.get("quantity", "1"), price=order.get("price", "0"),
        trigger_price=order.get("trigger_price", "0"),
    )
    await audit_engine.record_decision(terminal=terminal, decision=decision, order=order, reason="risk_validation_modify")
    if not decision.accepted:
        return {"ok": False, "accepted": False, "terminal": terminal,
                "reasons": decision.reasons,
                "error": {"code": "ORDER_REJECTED", "message": "; ".join(decision.reasons)}}

    try:
        kwargs = {**_order_kwargs(order), "order_id": order_id}
        broker_result = await adapter.modify_order(**kwargs)
    except Exception as exc:
        msg = exc.message if isinstance(exc, BrokerError) else str(exc)
        await audit_engine.record_action(terminal=terminal, action="modify", order={**order, "order_id": order_id}, status="failed", error=msg)
        return {"ok": False, "accepted": False, "terminal": terminal, "error": (exc.to_dict() if isinstance(exc, BrokerError) else {"code": "BROKER_UNAVAILABLE", "message": msg})}

    await audit_engine.record_action(terminal=terminal, action="modify", order={**order, "order_id": order_id}, status="submitted", broker_response=broker_result)
    await _publish_order_event({**order, "order_id": order_id}, "MODIFIED")
    return {"ok": True, "accepted": True, "terminal": terminal, "orderId": order_id, "data": broker_result}


async def cancel(terminal: str, order_id: str) -> dict:
    adapter = get_adapter(terminal)
    if not adapter.is_logged_in:
        return {"ok": False, "accepted": False, "terminal": terminal,
                "error": {"code": "NOT_LOGGED_IN", "message": f"{adapter.broker_name} session required"}}
    if not order_id:
        return {"ok": False, "accepted": False, "terminal": terminal,
                "error": {"code": "INVALID_REQUEST", "message": "order_id required"}}
    try:
        broker_result = await adapter.cancel_order(order_id)
    except Exception as exc:
        msg = exc.message if isinstance(exc, BrokerError) else str(exc)
        await audit_engine.record_action(terminal=terminal, action="cancel", order={"order_id": order_id}, status="failed", error=msg)
        return {"ok": False, "accepted": False, "terminal": terminal, "error": (exc.to_dict() if isinstance(exc, BrokerError) else {"code": "BROKER_UNAVAILABLE", "message": msg})}
    await audit_engine.record_action(terminal=terminal, action="cancel", order={"order_id": order_id}, status="submitted", broker_response=broker_result)
    # `cancel()` only receives the order id, so the event carries no symbol
    # rather than inventing one.
    await _publish_order_event({"order_id": order_id, "symbol": ""}, "CANCELLED", reason="cancel requested")
    await _notify_order(
        {"order_id": order_id, "terminal": terminal},
        "info", "Cancel requested", f"Cancellation request submitted for order {order_id}", "ORDER_CANCEL_REQUESTED",
    )
    return {"ok": True, "accepted": True, "terminal": terminal, "orderId": order_id, "data": broker_result}


async def square_off(terminal: str, position: dict) -> dict:
    adapter = get_adapter(terminal)
    if not adapter.is_logged_in:
        return {"ok": False, "accepted": False, "terminal": terminal,
                "error": {"code": "NOT_LOGGED_IN", "message": f"{adapter.broker_name} session required"}}
    try:
        broker_result = await adapter.square_off(
            exchange=position.get("exchange", "nse_cm"),
            token=position.get("token", ""),
            symbol=position.get("symbol", ""),
            product=position.get("product", "MIS"),
            quantity=str(position.get("netQuantity", "1") or 1).replace("-", ""),
            position_type=position.get("positionType", "LONG"),
        )
    except Exception as exc:
        msg = exc.message if isinstance(exc, BrokerError) else str(exc)
        await audit_engine.record_action(terminal=terminal, action="square_off", order=position, status="failed", error=msg)
        return {"ok": False, "accepted": False, "terminal": terminal, "error": (exc.to_dict() if isinstance(exc, BrokerError) else {"code": "BROKER_UNAVAILABLE", "message": msg})}
    await audit_engine.record_action(terminal=terminal, action="square_off", order=position, status="submitted", broker_response=broker_result)
    await _publish_order_event({**position, "symbol": position.get("symbol") or ""}, "SQUARE_OFF_REQUESTED")
    return {"ok": True, "accepted": True, "terminal": terminal, "data": broker_result}


def _extract_order_id(broker_result: dict) -> str | None:
    if not isinstance(broker_result, dict):
        return None
    data = broker_result.get("data")
    if isinstance(data, dict):
        for key in ("n_ord_no", "orderid", "order_id", "orderno", "OrderNo"):
            if data.get(key):
                return str(data[key])
    for key in ("orderId", "orderid", "order_id", "n_ord_no", "orderno"):
        if broker_result.get(key):
            return str(broker_result[key])
    return None