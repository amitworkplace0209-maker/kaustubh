"""Dummy Broker adapter — a first-class, selectable terminal.

Selecting Dummy Mode performs a real "login" that establishes an ACTIVE
central session with the standard 60-minute lifetime. Every order is executed
by the shared paper engine (``api.demo``) which is DRIVEN BY REAL MARKET LTP
and validated by the same Risk Engine as every other terminal. Dummy never
touches a real broker endpoint: its adapter implements only the paper store.
"""
from __future__ import annotations
import logging
from typing import Any

from services.session.session_manager import session_manager
from services.instrument_cache import instrument_cache

from brokers.base import BrokerAdapter
from brokers.capabilities import Capabilities
from brokers.models import BrokerError

_log = logging.getLogger("dummy_adapter")

_DEMO_USER = "KAUSTUBH_DUMMY"


class DummyAdapter(BrokerAdapter):
    mode = "dummy"
    broker_name = "Dummy Mode"

    def __init__(self) -> None:
        self._logged_in = False
        self._managed = False

    @property
    def capabilities(self) -> dict[str, Any]:
        return Capabilities.DUMMY.to_dict()

    @property
    def is_logged_in(self) -> bool:
        # Managed mode: Dummy is always-on while the backend runs (paper engine
        # needs no credentials), independent of the central real-broker session.
        if self._managed:
            return bool(self._logged_in)
        return bool(self._logged_in and session_manager.is_active())

    # ---- session lifecycle -------------------------------------------------

    async def login(self) -> bool:
        self._logged_in = True
        self._managed = True
        session_manager.set_mode("dummy", broker=self.broker_name, user_id=_DEMO_USER)
        session_manager.mark_login_started()
        session_manager.mark_login_success(
            mode="dummy",
            broker=self.broker_name,
            user_id=_DEMO_USER,
            session_ref="dummy-secure-session",
        )
        _log.info("DUMMY_ADAPTER_LOGIN_SUCCESS")
        return True

    async def ensure_auto_ready(self) -> bool:
        """Managed always-on connection for the paper engine.

        Dummy needs no broker credentials, so once the paper store is reachable
        the backend keeps the mode connected for the whole run — the Broker
        Terminal engine then reports the live paper account (balance / margins /
        P&L / positions / orders) without anyone starting the mode manually. The
        per-terminal session record is written WITHOUT hijacking the active
        terminal view (Kotak stays active); an explicit ``logout()`` still
        disconnects it and ``login()`` turns it back on.
        """
        if self._logged_in:
            return True
        self._logged_in = True
        self._managed = True
        try:
            session_manager.manage_terminal_session(
                self.mode,
                broker=self.broker_name,
                user_id=_DEMO_USER,
                session_ref="dummy-managed-session",
            )
        except Exception as exc:  # noqa: BLE001
            _log.debug("dummy managed session record unavailable: %s", exc)
        _log.info("DUMMY_ADAPTER_MANAGED_READY")
        return True

    async def logout(self, reason: str | None = None) -> bool:
        self._logged_in = False
        self._managed = False
        session_manager.mark_logout(reason)
        _log.info("DUMMY_ADAPTER_LOGOUT reason=%s", reason)
        return True

    # ---- read endpoints (delegate to the paper engine) ---------------------

    async def funds(self) -> dict[str, Any]:
        self._require()
        from api.demo import get_dummy_account
        return {"data": [await get_dummy_account()], "stat": "Ok", "isDemo": True}

    async def positions(self) -> dict[str, Any]:
        self._require()
        from api.demo import get_dummy_positions
        return {"data": await get_dummy_positions(), "stat": "Ok", "isDemo": True}

    async def holdings(self) -> dict[str, Any]:
        self._require()
        return {"data": [], "stat": "Ok", "isDemo": True}

    async def orders(self) -> dict[str, Any]:
        self._require()
        from api.demo import get_dummy_orders
        return {"data": await get_dummy_orders(), "stat": "Ok", "isDemo": True}

    async def order_history(self, order_id: str | None = None) -> dict[str, Any]:
        self._require()
        from api.demo import get_dummy_orders
        orders = await get_dummy_orders()
        if order_id:
            orders = [o for o in orders if o.get("orderId") == order_id]
        return {"data": orders, "stat": "Ok", "isDemo": True}

    async def trade_book(self) -> dict[str, Any]:
        self._require()
        from api.demo import get_dummy_orders
        orders = await get_dummy_orders()
        trades = [o for o in orders if o.get("filledQuantity", 0) and o.get("status") == "COMPLETE"]
        return {"data": trades, "stat": "Ok", "isDemo": True}

    # ---- order actions (all through the shared paper engine) ---------------

    async def place_order(
        self,
        *,
        exchange: str = "nse_cm",
        token: str = "",
        symbol: str = "",
        transaction_type: str = "BUY",
        product: str = "MIS",
        order_type: str = "MKT",
        quantity: str = "1",
        price: str = "0",
        trigger_price: str = "0",
        validity: str = "DAY",
        disclosed_quantity: str = "0",
        amo: str = "NO",
        market_protection: str = "NO",
        client_id: str = "",
        expected_ltp: str = "0",
        # Richer order intent the Order Engine forwards to the paper engine.
        # A real broker has no use for these, which is why ``_adapter_kwargs``
        # filters by each adapter's own signature instead of a flat whitelist.
        source: str = "MANUAL",
        trading_symbol: str = "",
        exchange_segment: str = "NSE_CM",
        amount: str = "0",
        lot_size: str = "0",
        margin_per_share: str = "0",
    ) -> dict[str, Any]:
        self._require()
        from api.demo import execute_dummy_order
        try:
            return await execute_dummy_order(
                symbol=symbol, token=token, exchange=exchange,
                exchangeSegment=exchange_segment,
                tradingSymbol=trading_symbol or symbol,
                transactionType=transaction_type, product=product,
                orderType=order_type, quantity=quantity, price=price,
                triggerPrice=trigger_price, disclosedQty=disclosed_quantity,
                validity=validity, ltp=expected_ltp,
                source=source,
                amount=amount, lotSize=lot_size, marginPerShare=margin_per_share,
            )
        except Exception as exc:
            raise BrokerError("ORDER_REJECTED", f"dummy order rejected: {exc}")

    async def modify_order(
        self,
        *,
        order_id: str,
        exchange: str = "nse_cm",
        token: str = "",
        symbol: str = "",
        quantity: str = "1",
        price: str = "0",
        trigger_price: str = "0",
        order_type: str = "MKT",
        validity: str = "DAY",
        disclosed_quantity: str = "0",
    ) -> dict[str, Any]:
        from api.demo import get_dummy_orders, _save_orders
        self._require()
        orders = await get_dummy_orders()
        order = next((o for o in orders if o.get("orderId") == order_id), None)
        if order is None:
            raise BrokerError("INVALID_REQUEST", f"Dummy order {order_id} not found")
        if order.get("status") not in ("OPEN", "TRIGGER_PENDING", "PENDING"):
            raise BrokerError("ORDER_REJECTED", f"Order {order_id} cannot be modified (status={order.get('status')})")
        order["price"] = float(price or order.get("price", 0))
        order["triggerPrice"] = float(trigger_price or order.get("triggerPrice", 0))
        order["orderType"] = order_type
        order["quantity"] = int(quantity or order.get("quantity", 0))
        await _save_orders(orders)
        return {"data": {"n_ord_no": order_id, "stat": "Ok"}, "stat": "Ok", "isDemo": True, "demoOrder": order}

    async def cancel_order(self, order_id: str) -> dict[str, Any]:
        self._require()
        from api.demo import cancel_dummy_order
        return await cancel_dummy_order(order_id)

    async def square_off(
        self,
        *,
        exchange: str = "nse_cm",
        token: str = "",
        symbol: str = "",
        product: str = "MIS",
        quantity: str = "1",
        position_type: str = "LONG",
    ) -> dict[str, Any]:
        self._require()
        from api.demo import squareoff_dummy_position
        return await squareoff_dummy_position(symbol, product)

    # ---- market data (shared instrument cache + known LTP) -----------------

    async def search(self, exchange: str = "nse_cm", search_text: str = "") -> dict[str, Any]:
        if instrument_cache.loaded:
            results = instrument_cache.search(
                query=search_text, exchange=exchange, eq_only=True, limit=10,
            )
            return {"data": results, "stat": "ok", "source": "cache"}
        return {"data": [], "stat": "ok", "source": "cache_empty"}

    async def quote(self, instrument_tokens: list[dict], quote_type: str = "ltp") -> dict[str, Any]:
        from api.demo import known_ltp
        from services.last_price import last_close
        try:
            from services import tick_buffer as _tb
        except Exception:
            _tb = None
        rows = []
        live_hits = 0
        stored_hits = 0
        for ref in instrument_tokens or []:
            token = str(ref.get("instrument_token", "") or "")
            inst = instrument_cache.lookup_by_token(token) if token else None
            sym = (inst or {}).get("symbol") or (inst or {}).get("tradingSymbol") or ""
            # Live websocket tick first (the engine's direct feed access), then
            # the last known real LTP — never fabricated.
            ltp = 0.0
            live = False
            src = "none"
            if _tb is not None:
                try:
                    for _key in ([token] if token else []) + ([sym, sym.upper()] if sym else []):
                        if not _key:
                            continue
                        _px = _tb.latest_ltp(str(_key))
                        if _px is not None and float(_px) > 0:
                            ltp = float(_px)
                            live = True
                            break
                except (TypeError, ValueError):
                    pass
            if live:
                src = "ws_tick"
            if ltp <= 0:
                ltp = known_ltp(sym or token)
                if ltp > 0:
                    src = "known"
            # Final honest fallback: the newest stored 1-minute candle close —
            # the last price this system actually recorded. This is what keeps
            # Dummy mode priceable after hours with nobody feeding ticks.
            ohlc = {"open": 0.0, "high": 0.0, "low": 0.0, "close": 0.0}
            stored: dict[str, Any] = {}
            if ltp <= 0:
                stored = await last_close(token, sym)
                if stored.get("ltp") is not None:
                    ltp = float(stored["ltp"])
                    src = "last_close"
                    stored_hits += 1
            if stored.get("ltp") is None and ltp > 0 and not live:
                # A known-LTP hit still deserves the stored session context.
                stored = await last_close(token, sym)
            if stored.get("ltp") is not None:
                ohlc = {
                    "open": float(stored.get("open") or 0.0),
                    "high": float(stored.get("high") or 0.0),
                    "low": float(stored.get("low") or 0.0),
                    "close": float(stored.get("prevClose") or 0.0),
                }
            live_hits += 1 if live else 0
            rows.append(
                {
                    "exchange_token": token,
                    "symbol": sym,
                    "last_price": ltp,
                    "open": ohlc["open"],
                    "high": ohlc["high"],
                    "low": ohlc["low"],
                    "close": ohlc["close"],
                    "ltp": ltp,
                    "ohlc": ohlc,
                    "ltp_known": ltp > 0,
                    "ltp_live": live,
                    "ltp_source": src,
                    "asOf": stored.get("asOf"),
                }
            )
        source = "dummy_live_ws" if live_hits else ("dummy_last_close" if stored_hits else "dummy_known_ltp")
        return {"data": rows, "stat": "ok", "source": source, "isDemo": True}

    # ---- helpers -----------------------------------------------------------

    def _require(self) -> None:
        if not self.is_logged_in:
            raise BrokerError("NOT_LOGGED_IN", "Dummy session required (login first)")


dummy_adapter = DummyAdapter()