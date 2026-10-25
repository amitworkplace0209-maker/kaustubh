"""Order Feed Manager — WS#2: Broker → Backend Order & Position stream.

Owns the single Kotak OrderFeedWebSocket (create_order_feed) lifecycle.
This is the Brother of ws_manager.WebSocketManager but for Order & Position
events (OrderUpdate / PositionUpdate). It is NOT an order placement API;
order actions remain Broker REST (place/modify/cancel via kotak_client).

Direction: Kotak → Backend (WS#2)
Purpose: OrderUpdate + PositionUpdate
Flow:
    Kotak realtime broker
      ↓ WS#2
    OrderFeedManager (this file)
      ↓ validation / normalization
    EngineEventBus (ORDER_UPDATE / POSITION_UPDATE)
      ↓
    OrderEngine / Risk / Audit / ConnectionManager → WS#3 → Frontend

Reconnect semantics mirror ws_manager supervisor but session-driven
(not market-window gated) — the feed is alive while a Kotak session is
active. Market-window gating would silently drop post-market order events.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Any

from auth.kotak_client import kotak_session

logger = logging.getLogger("order_feed")

# Supervisor states for WS#2 (mirrors ws_manager but session-driven)
OF_STOPPED = "OF_STOPPED"
OF_CONNECTING = "OF_CONNECTING"
OF_CONNECTED = "OF_CONNECTED"
OF_DISCONNECTED = "OF_DISCONNECTED"
OF_RECONNECTING = "OF_RECONNECTING"
OF_AUTH_REQUIRED = "OF_AUTH_REQUIRED"
OF_WAITING = "OF_WAITING_SESSION"
OF_ERROR = "OF_ERROR"

_RECONNECT_DELAYS = [1.0, 2.0, 4.0, 8.0, 15.0, 30.0, 60.0]
_MAX_RECONNECT_ATTEMPTS_DEFAULT = 0  # 0 = unlimited (like market feed)


def _iso(ts: float | None) -> str | None:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def _new_of_id() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    return f"of_{stamp}_{uuid.uuid4().hex[:5]}"


class OrderFeedManager:
    """Single owner of the Kotak OrderFeedWebSocket (WS#2)."""

    def __init__(self) -> None:
        self._feed: Any | None = None
        self._consume_task: asyncio.Task | None = None
        self._supervisor_task: asyncio.Task | None = None
        self._supervisor_event: asyncio.Event = asyncio.Event()
        self._state: str = OF_STOPPED
        self._connected: bool = False
        self._connected_at: float | None = None
        self._disconnected_at: float | None = None
        self._feed_id: str = _new_of_id()
        self._session_id: str | None = None
        self._total_order_updates: int = 0
        self._total_position_updates: int = 0
        self._total_messages: int = 0
        self._total_errors: int = 0
        self._last_order_at: float | None = None
        self._last_position_at: float | None = None
        self._last_message_at: float | None = None
        self._reconnect_attempt: int = 0
        self._stop_requested: bool = False
        self._start_requested: bool = False
        self._connection_history: deque[dict] = deque(maxlen=200)
        self._last_error: str | None = None
        self._lock = asyncio.Lock() if False else None  # avoid import cycle; threading lock used for sync sections
        import threading as _th
        self._tlock = _th.RLock()

    # ------------------------------------------------------------------
    # Public lifecycle (called by app.py + scheduler/login hooks)
    # ------------------------------------------------------------------
    def start_supervisor(self) -> None:
        """Request supervisor to run. Idempotent; safe from any thread."""
        logger.info("[OF-SUPERVISOR] start requested")
        self._start_requested = True
        self._stop_requested = False
        if self._supervisor_task is not None and not self._supervisor_task.done():
            self._signal()
            return
        try:
            from core.event_loop import get_loop
            loop = get_loop()
            if loop.is_running():
                loop.call_soon_threadsafe(self._launch)
        except RuntimeError:
            logger.error("[OF-SUPERVISOR] cannot start: event loop not ready")

    def stop_supervisor(self) -> None:
        """Request supervisor to stop (on logout/shutdown)."""
        logger.info("[OF-SUPERVISOR] stop requested")
        self._stop_requested = True
        self._start_requested = False
        self._signal()

    def get_supervisor_state(self) -> str:
        return self._state

    def is_connected(self) -> bool:
        with self._tlock:
            return bool(self._connected and self._feed is not None)

    # ------------------------------------------------------------------
    # Internal supervisor
    # ------------------------------------------------------------------
    def _launch(self) -> None:
        task = self._supervisor_task
        if task is not None and not task.done():
            return
        self._supervisor_event = asyncio.Event()
        try:
            self._supervisor_task = asyncio.ensure_future(self._supervisor_loop())
            self._supervisor_task.add_done_callback(self._on_done)
        except RuntimeError:
            logger.exception("[OF-SUPERVISOR] launch failed")

    def _on_done(self, task: asyncio.Task) -> None:
        if task.cancelled():
            return
        if task.exception() is not None:
            logger.exception("[OF-SUPERVISOR] crashed", exc_info=task.exception())
            try:
                from core.event_loop import get_loop
                loop = get_loop()
                if loop.is_running():
                    loop.call_soon_threadsafe(self._launch)
            except RuntimeError:
                pass

    def _signal(self) -> None:
        try:
            self._supervisor_event.set()
        except Exception:
            pass

    def _set_state(self, state: str, reason: str = "") -> None:
        with self._tlock:
            old = self._state
            if old == state:
                return
            self._state = state
        logger.info("[OF-SUPERVISOR] state=%s -> %s%s", old, state, f" reason={reason}" if reason else "")
        # publish state to state_store for observability
        try:
            from services.state_store import get_state_store

            # fire-and-forget publish via loop
            try:
                from core.event_loop import get_loop
                loop = get_loop()
                if loop.is_running():
                    loop.call_soon_threadsafe(
                        lambda: asyncio.ensure_future(
                            get_state_store().set_entity_state(
                                "order_feed", {"state": state, "reason": reason, "connected": state == OF_CONNECTED}, f"order_feed_{state.lower()}"
                            )
                        )
                    )
            except Exception:
                pass
        except Exception:
            pass

    async def _supervisor_loop(self) -> None:
        import os as _os
        logger.info("[OF-SUPERVISOR] loop started pid=%s", _os.getpid())
        while not self._stop_requested:
            try:
                await self._tick()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.exception("[OF-SUPERVISOR] tick error: %s", exc)
                self._set_state(OF_ERROR, str(exc))
            try:
                self._supervisor_event.clear()
                await asyncio.wait_for(self._supervisor_event.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                pass
        # teardown
        self._set_state(OF_STOPPED, "supervisor stopped")
        await self._teardown()
        logger.info("[OF-SUPERVISOR] loop ended")

    async def _tick(self) -> None:
        state = self._state

        if self._stop_requested:
            if state not in (OF_STOPPED,):
                await self._teardown()
                self._set_state(OF_STOPPED, "stop requested")
            return

        if not self._start_requested:
            self._set_state(OF_WAITING, "not started")
            return

        if not kotak_session.session_active:
            if state != OF_AUTH_REQUIRED:
                await self._teardown()
                self._set_state(OF_AUTH_REQUIRED, "session not active")
            return

        if state in (OF_STOPPED, OF_WAITING, OF_AUTH_REQUIRED):
            self._set_state(OF_CONNECTING, "session available")
            await self._connect()
            return

        if state == OF_DISCONNECTED:
            self._set_state(OF_RECONNECTING, "unexpected disconnect")
            self._reconnect_attempt = 0
            await self._connect()
            return

        if state == OF_RECONNECTING:
            # bounded by configured attempts (0 = unlimited)
            try:
                from services.runtime_settings import rt_int
                max_attempts = rt_int("ws_max_reconnect_attempts", 0)
            except Exception:
                max_attempts = 0
            if max_attempts > 0 and self._reconnect_attempt >= max_attempts:
                self._set_state(OF_STOPPED, f"reconnect exhausted ({max_attempts})")
                return
            delay = self._get_delay(self._reconnect_attempt)
            logger.info("[OF-SUPERVISOR] reconnect attempt=%d delay=%.1fs", self._reconnect_attempt, delay)
            await asyncio.sleep(delay)
            self._reconnect_attempt += 1
            await self._connect()
            return

        if state in (OF_CONNECTED, OF_CONNECTING):
            # verify liveness
            with self._tlock:
                alive = bool(self._connected and self._feed is not None and getattr(self._feed, "is_connected", False))
                if hasattr(self._feed, "is_connected"):
                    try:
                        alive = bool(self._feed.is_connected)
                    except Exception:
                        alive = self._connected
            if not alive and state == OF_CONNECTED:
                self._set_state(OF_DISCONNECTED, "connection lost")
            return

    def _get_delay(self, attempt: int) -> float:
        import random

        base = _RECONNECT_DELAYS[attempt] if attempt < len(_RECONNECT_DELAYS) else _RECONNECT_DELAYS[-1]
        try:
            from services.runtime_settings import rt_int, rt_bool
            delay_ms = rt_int("ws_reconnect_delay_ms", 0)
            if delay_ms and delay_ms > 0:
                configured = delay_ms / 1000.0
                if rt_bool("ws_backoff", True):
                    base = min(float(2 ** min(attempt, 6)), configured)
                else:
                    base = configured
        except Exception:
            pass
        return base * random.uniform(0.5, 1.0)

    async def _connect(self) -> None:
        """Attempt to create and connect the OrderFeedWebSocket."""
        self._set_state(OF_CONNECTING)
        feed = None
        try:
            # Must be called from thread pool? create_order_feed is sync but needs session
            # The SDK method itself is sync (creates object), connect is async
            client = kotak_session.client
            if client is None:
                raise RuntimeError("kotak client not initialised")
            # Re-use SDK create_order_feed (handles dynamic URL correctly)
            feed = client.create_order_feed()
        except Exception as exc:
            self._last_error = str(exc)
            logger.warning("[OF-SUPERVISOR] create_order_feed failed: %s", exc)
            self._set_state(OF_RECONNECTING, str(exc)[:200])
            return

        try:
            await feed.connect()
        except Exception as exc:
            self._last_error = str(exc)
            self._total_errors += 1
            logger.warning("[OF-SUPERVISOR] connect failed attempt=%d error=%s", self._reconnect_attempt, exc)
            # Map auth failure
            if "Authentication" in str(exc) or "auth" in str(exc).lower():
                self._set_state(OF_AUTH_REQUIRED, str(exc)[:200])
                return
            self._set_state(OF_RECONNECTING, str(exc)[:200])
            return

        # connected
        with self._tlock:
            self._feed = feed
            self._connected = True
            self._connected_at = time.time()
            self._feed_id = _new_of_id()
            self._session_id = self._read_session_id()
            self._connection_history.append({
                "event": "connect",
                "at": _iso(self._connected_at),
                "feedId": self._feed_id,
                "reason": "connected",
            })
        was_reconnect = self._reconnect_attempt > 0
        self._set_state(OF_CONNECTED, "connected")
        self._reconnect_attempt = 0
        logger.info("[OF-SUPERVISOR] connected feedId=%s session=%s reconnect=%s", self._feed_id, self._session_id, was_reconnect)

        # Bridge callbacks for observability
        try:
            feed.on_message = self._on_feed_message  # type: ignore[attr-defined]
        except Exception:
            pass
        try:
            feed.on_error = self._on_error  # type: ignore[attr-defined]
        except Exception:
            pass
        try:
            # ensure receive task is managed
            pass
        except Exception:
            pass

        # start consume loop
        if self._consume_task is None or self._consume_task.done():
            self._consume_task = asyncio.create_task(self._consume_loop(feed))

        # publish connected event
        self._publish_state_event("ORDER_FEED_CONNECTED", {"feedId": self._feed_id, "reason": "connected", "wasReconnect": was_reconnect})

        # WS#2 reconnect reconciliation: invalidate stale cache + fetch authoritative REST
        # Never assume no events were missed.
        if was_reconnect:
            try:
                asyncio.create_task(self._reconcile_after_reconnect())
            except Exception as exc:
                logger.warning("[OF-SUPERVISOR] reconcile task schedule failed: %s", exc)

    def _read_session_id(self) -> str | None:
        try:
            from services.session.session_manager import session_manager
            return session_manager.snapshot().get("sessionId")
        except Exception:
            return None

    def _on_error(self, exc: Exception) -> None:
        self._total_errors += 1
        self._last_error = str(exc)
        logger.warning("[OF-SUPERVISOR] feed error: %s", exc)

    def _on_feed_message(self, msg: Any) -> None:
        """SDK on_message callback (sync context) — forward to async handler."""
        # This is called from the feed's receive loop thread; we must not block.
        # We enqueue via call_soon_threadsafe to the main loop.
        try:
            from core.event_loop import get_loop
            loop = get_loop()
            if loop.is_running():
                # schedule async handle
                loop.call_soon_threadsafe(lambda: asyncio.ensure_future(self._handle_message_async(msg)))
            else:
                # fallback: sync handle
                asyncio.ensure_future(self._handle_message_async(msg))
        except Exception:
            # last resort: try direct async
            try:
                asyncio.ensure_future(self._handle_message_async(msg))
            except Exception:
                logger.exception("[OF-SUPERVISOR] on_feed_message forward failed")

    async def _consume_loop(self, feed: Any) -> None:
        """Consume async iterator (fallback if on_message not wired)."""
        try:
            async for msg in feed:  # type: ignore[attr-defined]
                await self._handle_message_async(msg)
        except asyncio.CancelledError:
            return
        except Exception as exc:
            logger.warning("[OF-SUPERVISOR] consume loop ended: %s", exc)
        finally:
            # feed closed unexpectedly
            with self._tlock:
                was_connected = self._connected
                self._connected = False
                self._disconnected_at = time.time()
            if was_connected:
                self._set_state(OF_DISCONNECTED, "feed closed")
                self._publish_state_event("ORDER_FEED_DISCONNECTED", {"reason": "feed closed", "feedId": self._feed_id})
            self._signal()

    async def _handle_message_async(self, msg: Any) -> None:
        """Validate, normalize and publish OrderUpdate/PositionUpdate."""
        now = time.time()
        self._total_messages += 1
        self._last_message_at = now

        # Determine type
        msg_type = None
        data = None
        # SDK typed objects
        try:
            mt = getattr(msg, "type", None)
            if mt in ("order", "position"):
                msg_type = mt
                data_obj = getattr(msg, "data", None)
                data = data_obj
            elif isinstance(msg, dict):
                msg_type = msg.get("type")
                data = msg.get("data")
            else:
                # fallback raw
                msg_type = getattr(msg, "type", None) or (msg.get("type") if isinstance(msg, dict) else None)
        except Exception:
            msg_type = None

        if msg_type == "order":
            self._total_order_updates += 1
            self._last_order_at = now
            await self._publish_order_update(msg, data, now)
        elif msg_type == "position":
            self._total_position_updates += 1
            self._last_position_at = now
            await self._publish_position_update(msg, data, now)
        else:
            # unknown — still count and log
            logger.debug("[OF-SUPERVISOR] unknown message type=%s payload=%s", msg_type, str(msg)[:500])

    async def _publish_order_update(self, raw_msg: Any, data: Any, received_at: float) -> None:
        """Normalize OrderUpdate and publish to EngineEventBus + ConnectionManager."""
        try:
            normalized = self._normalize_order(data, raw_msg, received_at)
        except Exception as exc:
            logger.warning("[OF-SUPERVISOR] order normalize failed: %s", exc)
            return

        # EngineEventBus: canonical ORDER_UPDATE + legacy ORDER_UPDATED for compatibility
        try:
            from services.engine_event_bus import get_event_bus, EngineEvent

            bus = get_event_bus()
            # New canonical
            await bus.publish(EngineEvent(event_type="ORDER_UPDATE", source_engine="order_feed_manager", data=normalized))
            # Legacy compat
            await bus.publish(EngineEvent(event_type="ORDER_UPDATED", source_engine="order_feed_manager", data=normalized))
            # Also publish order.updated for frontend event naming (target architecture)
            await bus.publish(EngineEvent(event_type="order.updated", source_engine="order_feed_manager", data=normalized))
        except Exception as exc:
            logger.warning("[OF-SUPERVISOR] EngineEventBus publish order failed: %s", exc)

        # Idempotency: mark correlation completed on final OrderUpdate (Phase 11)
        try:
            from services.command_idempotency import get_idempotency_store
            get_idempotency_store().mark_completed_from_order_update(str(normalized.get("orderId") or ""), str(normalized.get("orderStatus") or ""))
        except Exception:
            pass
        # ConnectionManager → WS#3 (orders channel)
        try:
            from connection_engine import connection_engine as ce

            frame = {
                "type": "order.update",
                "orderId": normalized.get("orderId") or normalized.get("order_id"),
                "orderStatus": normalized.get("orderStatus") or normalized.get("order_status"),
                "symbol": normalized.get("symbol"),
                "exchangeSegment": normalized.get("exchangeSegment"),
                "quantity": normalized.get("quantity"),
                "filledQuantity": normalized.get("filledQuantity"),
                "averagePrice": normalized.get("averagePrice"),
                "receivedAt": received_at,
                "feedId": self._feed_id,
                "raw": normalized,
            }
            ce._broadcast_frame(frame)
        except Exception as exc:
            logger.debug("[OF-SUPERVISOR] ConnectionManager order broadcast failed: %s", exc)

        # Also publish to state_store for SSE fallback
        try:
            from services.state_store import get_state_store

            await get_state_store().publish({
                "type": "order.update",
                "channel": "orders",
                "timestamp": _iso(received_at),
                "data": normalized,
                "feedId": self._feed_id,
            })
        except Exception:
            pass

    async def _publish_position_update(self, raw_msg: Any, data: Any, received_at: float) -> None:
        try:
            normalized = self._normalize_position(data, raw_msg, received_at)
        except Exception as exc:
            logger.warning("[OF-SUPERVISOR] position normalize failed: %s", exc)
            return

        try:
            from services.engine_event_bus import get_event_bus, EngineEvent

            bus = get_event_bus()
            await bus.publish(EngineEvent(event_type="POSITION_UPDATE", source_engine="order_feed_manager", data=normalized))
            await bus.publish(EngineEvent(event_type="POSITION_UPDATED", source_engine="order_feed_manager", data=normalized))
            await bus.publish(EngineEvent(event_type="position.updated", source_engine="order_feed_manager", data=normalized))
        except Exception as exc:
            logger.warning("[OF-SUPERVISOR] EngineEventBus publish position failed: %s", exc)

        try:
            from connection_engine import connection_engine as ce

            frame = {
                "type": "position.update",
                "symbol": normalized.get("symbol"),
                "exchangeSegment": normalized.get("exchangeSegment"),
                "product": normalized.get("product"),
                "filledBuyQty": normalized.get("filledBuyQty"),
                "filledSellQty": normalized.get("filledSellQty"),
                "buyAmount": normalized.get("buyAmount"),
                "sellAmount": normalized.get("sellAmount"),
                "receivedAt": received_at,
                "feedId": self._feed_id,
                "raw": normalized,
            }
            ce._broadcast_frame(frame)
        except Exception as exc:
            logger.debug("[OF-SUPERVISOR] ConnectionManager position broadcast failed: %s", exc)

        try:
            from services.state_store import get_state_store

            await get_state_store().publish({
                "type": "position.update",
                "channel": "positions",
                "timestamp": _iso(received_at),
                "data": normalized,
                "feedId": self._feed_id,
            })
        except Exception:
            pass

    def _normalize_order(self, data: Any, raw_msg: Any, received_at: float) -> dict:
        """Flatten OrderData into canonical backend event."""
        # data may be OrderData pydantic or dict
        def _get(obj, *keys):
            for k in keys:
                if obj is None:
                    return None
                if isinstance(obj, dict):
                    v = obj.get(k)
                    if v is not None:
                        return v
                else:
                    v = getattr(obj, k, None)
                    if v is not None:
                        return v
            return None

        # handle pydantic alias vs field name
        order_id = _get(data, "order_id", "nOrdNo") or _get(raw_msg, "order_id")
        exch_ord_id = _get(data, "exchange_order_id", "exOrdId")
        status = _get(data, "order_status", "ordSt")
        avg_prc = _get(data, "average_price", "avgPrc")
        qty = _get(data, "quantity", "qty")
        fld_qty = _get(data, "filled_quantity", "fldQty")
        unfilled = _get(data, "unfilled_size", "unFldSz")
        trns = _get(data, "transaction_type", "trnsTp")
        prc_tp = _get(data, "price_type", "prcTp")
        prod = _get(data, "product", "prod")
        ex_seg = _get(data, "exchange_segment", "exSeg")
        sym = _get(data, "symbol", "sym")
        trd_sym = _get(data, "trading_symbol", "trdSym")
        tok = _get(data, "token", "tok")
        ord_dt = _get(data, "order_date_time", "ordDtTm")
        upd_tm = _get(data, "update_receive_time", "updRecvTm")
        boe = _get(data, "exchange_broadcast_time", "boeSec")
        ex_cfm = _get(data, "exchange_confirmation_time", "exCfmTm")

        # preserve extra fields
        extra = {}
        if isinstance(data, dict):
            for k, v in data.items():
                if k not in ("nOrdNo", "exOrdId", "ordSt", "avgPrc", "qty", "fldQty", "unFldSz", "trnsTp", "prcTp", "prod", "exSeg", "sym", "trdSym", "tok", "ordDtTm", "updRecvTm", "boeSec", "exCfmTm", "type", "data"):
                    extra[k] = v
        elif hasattr(data, "model_extra") and data.model_extra:
            extra = dict(data.model_extra)

        normalized = {
            "orderId": str(order_id) if order_id is not None else None,
            "order_id": str(order_id) if order_id is not None else None,
            "exchangeOrderId": str(exch_ord_id) if exch_ord_id is not None else None,
            "orderStatus": str(status) if status is not None else None,
            "order_status": str(status) if status is not None else None,
            "averagePrice": str(avg_prc) if avg_prc is not None else None,
            "quantity": qty,
            "filledQuantity": fld_qty,
            "unfilledSize": unfilled,
            "transactionType": str(trns) if trns is not None else None,
            "priceType": str(prc_tp) if prc_tp is not None else None,
            "product": str(prod) if prod is not None else None,
            "exchangeSegment": str(ex_seg) if ex_seg is not None else None,
            "symbol": str(sym) if sym is not None else None,
            "tradingSymbol": str(trd_sym) if trd_sym is not None else None,
            "token": str(tok) if tok is not None else None,
            "orderDateTime": str(ord_dt) if ord_dt is not None else None,
            "updateReceiveTime": upd_tm,
            "exchangeBroadcastTime": boe,
            "exchangeConfirmationTime": str(ex_cfm) if ex_cfm is not None else None,
            "receivedAt": received_at,
            "timestamp": _iso(received_at),
            "source": "order_feed_ws2",
            "feedId": self._feed_id,
        }
        if extra:
            normalized["extra"] = extra
        # also include raw for debugging
        try:
            normalized["raw"] = data.model_dump() if hasattr(data, "model_dump") else dict(data) if isinstance(data, dict) else str(data)
        except Exception:
            normalized["raw"] = str(data)[:1000]
        return {k: v for k, v in normalized.items() if v is not None}

    def _normalize_position(self, data: Any, raw_msg: Any, received_at: float) -> dict:
        def _get(obj, *keys):
            for k in keys:
                if obj is None:
                    return None
                if isinstance(obj, dict):
                    v = obj.get(k)
                    if v is not None:
                        return v
                else:
                    v = getattr(obj, k, None)
                    if v is not None:
                        return v
            return None

        act_id = _get(data, "account_id", "actId")
        sym = _get(data, "symbol", "sym")
        ex_seg = _get(data, "exchange_segment", "exSeg")
        prod = _get(data, "product", "prod")
        fl_buy = _get(data, "filled_buy_quantity", "flBuyQty")
        fl_sell = _get(data, "filled_sell_quantity", "flSellQty")
        buy_amt = _get(data, "buy_amount", "buyAmt")
        sell_amt = _get(data, "sell_amount", "sellAmt")
        pos_flg = _get(data, "position_flag", "posFlg")
        sqr_flg = _get(data, "square_off_flag", "sqrFlg")
        lot_sz = _get(data, "lot_size", "lotSz")
        mult = _get(data, "multiplier")
        hs_up = _get(data, "update_time", "hsUpTm")

        extra = {}
        if isinstance(data, dict):
            for k, v in data.items():
                if k not in ("actId", "sym", "exSeg", "prod", "flBuyQty", "flSellQty", "buyAmt", "sellAmt", "posFlg", "sqrFlg", "lotSz", "multiplier", "hsUpTm", "type", "data"):
                    extra[k] = v
        elif hasattr(data, "model_extra") and data.model_extra:
            extra = dict(data.model_extra)

        normalized = {
            "accountId": str(act_id) if act_id is not None else None,
            "symbol": str(sym) if sym is not None else None,
            "exchangeSegment": str(ex_seg) if ex_seg is not None else None,
            "product": str(prod) if prod is not None else None,
            "filledBuyQty": str(fl_buy) if fl_buy is not None else None,
            "filledSellQty": str(fl_sell) if fl_sell is not None else None,
            "buyAmount": str(buy_amt) if buy_amt is not None else None,
            "sellAmount": str(sell_amt) if sell_amt is not None else None,
            "positionFlag": str(pos_flg) if pos_flg is not None else None,
            "squareOffFlag": str(sqr_flg) if sqr_flg is not None else None,
            "lotSize": str(lot_sz) if lot_sz is not None else None,
            "multiplier": str(mult) if mult is not None else None,
            "updateTime": str(hs_up) if hs_up is not None else None,
            "receivedAt": received_at,
            "timestamp": _iso(received_at),
            "source": "order_feed_ws2",
            "feedId": self._feed_id,
        }
        if extra:
            normalized["extra"] = extra
        try:
            normalized["raw"] = data.model_dump() if hasattr(data, "model_dump") else dict(data) if isinstance(data, dict) else str(data)
        except Exception:
            normalized["raw"] = str(data)[:1000]
        return {k: v for k, v in normalized.items() if v is not None}

    async def _teardown(self) -> None:
        with self._tlock:
            feed = self._feed
            task = self._consume_task
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        if feed is not None:
            with contextlib.suppress(Exception):
                await feed.close()
        with self._tlock:
            self._feed = None
            self._consume_task = None
            if self._connected:
                self._connected = False
                self._disconnected_at = time.time()
                self._connection_history.append({
                    "event": "disconnect",
                    "at": _iso(self._disconnected_at),
                    "feedId": self._feed_id,
                    "reason": self._last_error or "teardown",
                })

    def _publish_state_event(self, event_type: str, data: dict) -> None:
        try:
            from services.engine_event_bus import get_event_bus, EngineEvent
            from core.event_loop import get_loop
            loop = get_loop()
            if loop.is_running():
                loop.call_soon_threadsafe(
                    lambda: asyncio.ensure_future(
                        get_event_bus().publish(EngineEvent(event_type=event_type, source_engine="order_feed_manager", data=data))
                    )
                )
        except Exception:
            pass

    async def _reconcile_after_reconnect(self) -> None:
        """WS#2 reconnect reconciliation (Phase 12).

        1. mark stream state
        2. invalidate stale broker cache
        3. fetch positions() + order state + trade_report()
        4. reconcile canonical state
        5. publish corrected state through Event Bus
        6. Connection Manager sends updated state to frontend (via its bridge)
        """
        logger.info("[OF-SUPERVISOR] post-reconnect reconciliation started")
        try:
            from services.state_store import get_state_store
            await get_state_store().set_entity_state(
                "order_feed", {"state": OF_CONNECTED, "reconciling": True, "feedId": self._feed_id}, "ws2_reconnect_reconcile"
            )
        except Exception:
            pass
        # 2. invalidate broker cache
        try:
            from services.broker_cache import broker_cache
            broker_cache.invalidate("positions")
            broker_cache.invalidate("order_book")
            broker_cache.invalidate("trade_book")
            logger.info("[OF-SUPERVISOR] broker cache invalidated for reconciliation")
        except Exception as exc:
            logger.warning("[OF-SUPERVISOR] broker cache invalidate failed: %s", exc)
        # 3-4. fetch authoritative REST
        positions_data = orders_data = trades_data = None
        try:
            if kotak_session.session_active:
                try:
                    positions_data = await kotak_session.async_positions()
                    logger.info("[OF-SUPERVISOR] positions() fetched for reconciliation")
                except Exception as exc:
                    logger.warning("[OF-SUPERVISOR] positions() fetch failed: %s", exc)
                try:
                    orders_data = await kotak_session.async_order_book()
                    logger.info("[OF-SUPERVISOR] order_report() fetched for reconciliation")
                except Exception as exc:
                    logger.warning("[OF-SUPERVISOR] order_book() fetch failed: %s", exc)
                try:
                    trades_data = await kotak_session.async_trade_report()
                    logger.info("[OF-SUPERVISOR] trade_report() fetched for reconciliation")
                except Exception as exc:
                    logger.warning("[OF-SUPERVISOR] trade_report() fetch failed: %s", exc)
            else:
                logger.info("[OF-SUPERVISOR] reconciliation skipped — session not active")
                return
        except Exception as exc:
            logger.warning("[OF-SUPERVISOR] reconciliation fetch envelope failed: %s", exc)
        # 5. publish corrected state (canonical REST snapshots win over stale WS state)
        try:
            from services.engine_event_bus import get_event_bus, EngineEvent
            bus = get_event_bus()
            if positions_data is not None:
                await bus.publish(EngineEvent(event_type="POSITION_RECONCILED", source_engine="order_feed_manager", data={"feedId": self._feed_id, "positions": positions_data, "reconciled": True, "source": "REST positions() after WS#2 reconnect"}))
            if orders_data is not None:
                await bus.publish(EngineEvent(event_type="ORDER_RECONCILED", source_engine="order_feed_manager", data={"feedId": self._feed_id, "orders": orders_data, "reconciled": True, "source": "REST order_report() after WS#2 reconnect"}))
            if trades_data is not None:
                await bus.publish(EngineEvent(event_type="TRADE_RECONCILED", source_engine="order_feed_manager", data={"feedId": self._feed_id, "trades": trades_data, "reconciled": True}))
            # generic reconciled event for state_store bridge
            await bus.publish(EngineEvent(event_type="ORDER_FEED_RECONCILED", source_engine="order_feed_manager", data={"feedId": self._feed_id, "at": _iso(time.time())}))
        except Exception as exc:
            logger.warning("[OF-SUPERVISOR] reconciliation publish failed: %s", exc)
        # notify Connection Manager via its state bridge (frontend will receive via orders/positions channels)
        try:
            from connection_engine import connection_engine as ce
            ce._broadcast_frame({"type": "position.reconciled", "feedId": self._feed_id, "at": _iso(time.time()), "source": "ws2_reconnect"})
            ce._broadcast_frame({"type": "order.reconciled", "feedId": self._feed_id, "at": _iso(time.time()), "source": "ws2_reconnect"})
        except Exception:
            pass
        try:
            from services.state_store import get_state_store
            await get_state_store().set_entity_state(
                "order_feed", {"state": OF_CONNECTED, "reconciling": False, "lastReconciledAt": _iso(time.time()), "feedId": self._feed_id}, "ws2_reconcile_done"
            )
        except Exception:
            pass
        logger.info("[OF-SUPERVISOR] post-reconnect reconciliation complete")

    # ------------------------------------------------------------------
    # Diagnostics / status
    # ------------------------------------------------------------------
    def status(self) -> dict:
        with self._tlock:
            return {
                "feedId": self._feed_id,
                "state": self._state,
                "connected": bool(self._connected),
                "connectedAt": _iso(self._connected_at),
                "disconnectedAt": _iso(self._disconnected_at),
                "sessionId": self._session_id,
                "totalMessages": self._total_messages,
                "totalOrderUpdates": self._total_order_updates,
                "totalPositionUpdates": self._total_position_updates,
                "totalErrors": self._total_errors,
                "reconnectAttempt": self._reconnect_attempt,
                "lastOrderAt": _iso(self._last_order_at),
                "lastPositionAt": _iso(self._last_position_at),
                "lastMessageAt": _iso(self._last_message_at),
                "lastError": self._last_error,
                "connectionHistory": list(self._connection_history)[-20:],
                "connectionHistoryCount": len(self._connection_history),
            }

    def live_snapshot(self) -> dict:
        st = self.status()
        return {
            "feedId": st.get("feedId"),
            "state": st.get("state"),
            "connected": st.get("connected"),
            "lastOrderAt": st.get("lastOrderAt"),
            "lastPositionAt": st.get("lastPositionAt"),
            "totalOrderUpdates": st.get("totalOrderUpdates"),
            "totalPositionUpdates": st.get("totalPositionUpdates"),
            "totalMessages": st.get("totalMessages"),
            "totalErrors": st.get("totalErrors"),
        }


# Singleton
order_feed_manager = OrderFeedManager()
