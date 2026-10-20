"""Kotak Neo adapter — real broker adapter over the KotakSession SDK engine.

Thin, honest wrapper over ``kotak_session`` (the ONLY place the kotakneoapi
SDK is touched). Read endpoints use the shared single-flight TTL broker cache;
mutating actions hit the broker directly and are bounded by the caller.
"""
from __future__ import annotations
import logging
from typing import Any

from brokers.base import BrokerAdapter
from brokers.models import BrokerError, normalize_status, safe_float
from brokers.capabilities import Capabilities

from services.broker_cache import broker_cache
from services.instrument_cache import instrument_cache

_log = logging.getLogger("kotak_adapter")

_BROKER_CACHE_TTL = 5.0
_BROKER_CACHE_COOLDOWN = 15.0
_BROKER_CACHE_TIMEOUT = 4.0


class KotakAdapter(BrokerAdapter):
    mode = "kotak"
    broker_name = "Kotak Neo"
    terminal_id = "kotak"

    def __init__(self, engine) -> None:
        self._engine = engine

    @property
    def capabilities(self) -> dict[str, Any]:
        return Capabilities.KOTAK.to_dict()

    @property
    def is_logged_in(self) -> bool:
        return bool(self._engine.session_active)

    async def login(self) -> bool:
        return await self._engine.async_login()

    async def logout(self, reason: str | None = None) -> bool:
        return await self._engine.async_logout()

    # ---- read endpoints ----------------------------------------------------

    async def funds(self) -> dict[str, Any]:
        self._require()
        return await broker_cache.get(
            "limits", self._engine.async_limits,
            ttl=_BROKER_CACHE_TTL, fail_cooldown=_BROKER_CACHE_COOLDOWN,
            timeout=_BROKER_CACHE_TIMEOUT,
        )

    async def positions(self) -> dict[str, Any]:
        self._require()
        return await broker_cache.get(
            "positions", self._engine.async_positions,
            ttl=_BROKER_CACHE_TTL, fail_cooldown=_BROKER_CACHE_COOLDOWN,
            timeout=_BROKER_CACHE_TIMEOUT,
        )

    async def holdings(self) -> dict[str, Any]:
        self._require()
        return await broker_cache.get(
            "holdings", self._engine.async_holdings,
            ttl=_BROKER_CACHE_TTL, fail_cooldown=_BROKER_CACHE_COOLDOWN,
            timeout=_BROKER_CACHE_TIMEOUT,
        )

    async def orders(self) -> dict[str, Any]:
        self._require()
        return await broker_cache.get(
            "order_book", self._engine.async_order_book,
            ttl=_BROKER_CACHE_TTL, fail_cooldown=_BROKER_CACHE_COOLDOWN,
            timeout=_BROKER_CACHE_TIMEOUT,
        )

    async def order_history(self, order_id: str | None = None) -> dict[str, Any]:
        self._require()
        return await self._engine.async_order_history(book="orders", order_id=order_id or "")

    async def trade_book(self) -> dict[str, Any]:
        self._require()
        return await broker_cache.get(
            "trade_book", self._engine.async_trade_report,
            ttl=_BROKER_CACHE_TTL, fail_cooldown=_BROKER_CACHE_COOLDOWN,
            timeout=_BROKER_CACHE_TIMEOUT,
        )

    # ---- order actions -----------------------------------------------------

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
    ) -> dict[str, Any]:
        # `expected_ltp` is accepted for contract parity: Kotak prices from its
        # own Neo feed, never from a caller-supplied number.
        self._require()
        try:
            return await self._engine.async_place_order(
                exchange=exchange, token=token, transaction_type=transaction_type,
                product=product, order_type=order_type, quantity=quantity,
                price=price, trigger_price=trigger_price,
                disclosed_quantity=disclosed_quantity, validity=validity,
                amo=amo, market_protection=market_protection,
            )
        except Exception as exc:
            raise self._normalize_exc(exc, "place_order")

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
        self._require()
        try:
            return await self._engine.async_modify_order(
                order_id=order_id, exchange=exchange, token=token,
                quantity=quantity, price=price, trigger_price=trigger_price,
                order_type=order_type, validity=validity,
                disclosed_quantity=disclosed_quantity,
            )
        except Exception as exc:
            raise self._normalize_exc(exc, "modify_order")

    async def cancel_order(self, order_id: str) -> dict[str, Any]:
        self._require()
        try:
            return await self._engine.async_cancel_order(order_id)
        except Exception as exc:
            raise self._normalize_exc(exc, "cancel_order")

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
        try:
            return await self._engine.async_square_off_position(
                exchange=exchange, token=token, product=product,
                quantity=quantity, position_type=position_type,
            )
        except Exception as exc:
            raise self._normalize_exc(exc, "square_off")

    # ---- market data -------------------------------------------------------

    async def margin_required(
        self,
        *,
        exchange: str = "nse_cm",
        token: str = "",
        product: str = "MIS",
        order_type: str = "MKT",
        quantity: str = "1",
        price: str = "0",
        trigger_price: str = "0",
        transaction_type: str = "BUY",
    ) -> dict[str, Any]:
        """Real broker-computed margin preview (SDK margin API), never a local
        estimate. Requires an active session and a numeric instrument token."""
        self._require()
        try:
            result = await self._engine.async_margin_required(
                exchange=exchange, token=token, product=product,
                order_type=order_type, quantity=quantity, price=price,
                trigger_price=trigger_price, transaction_type=transaction_type,
            )
            if isinstance(result, dict):
                err_key = next((k for k in ("Error", "Error Message", "error", "errorMessage") if result.get(k) is not None), None)
                if err_key:
                    return {"api": "margin", "unavailable": True, "message": str(result[err_key])[:300]}
            return dict(result or {})
        except Exception as exc:
            raise self._normalize_exc(exc, "margin_required")

    async def search(self, exchange: str = "nse_cm", search_text: str = "") -> dict[str, Any]:
        if instrument_cache.loaded:
            results = instrument_cache.search(
                query=search_text, exchange=exchange, eq_only=True, limit=10,
            )
            return {"data": results, "stat": "ok", "source": "cache"}
        self._require()
        try:
            result = await self._engine.async_search_scrip(exchange, search_text)
            raw = result.get("data", []) if isinstance(result, dict) else (result or [])
            eq = [
                r for r in (raw if isinstance(raw, list) else [])
                if r.get("pInstType") == "EQ" or r.get("pSeries") == "EQ"
            ] or raw
            return {"data": eq, "stat": "ok", "source": "kotak_api"}
        except Exception as exc:
            raise self._normalize_exc(exc, "search")

    async def quote(self, instrument_tokens: list[dict], quote_type: str = "ltp") -> dict[str, Any]:
        self._require()
        try:
            return await self._engine.async_quote(
                instrument_tokens=instrument_tokens, quote_type=quote_type, isIndex=False,
            )
        except Exception as exc:
            raise self._normalize_exc(exc, "quote")

    # ---- helpers -----------------------------------------------------------

    def _require(self) -> None:
        if not self.is_logged_in:
            raise BrokerError("NOT_LOGGED_IN", f"Kotak Neo session required ({self._require_hint()})")

    @staticmethod
    def _require_hint() -> str:
        return "login via /api/auth/manual-login"

    @staticmethod
    def _normalize_exc(exc: Exception, action: str) -> BrokerError:
        text = str(exc)
        lowered = text.lower()
        if any(k in lowered for k in ("timeout", "timed out", "safe_call")):
            return BrokerError("ORDER_TIMEOUT", f"{action} timed out", meta={"detail": text})
        if any(k in lowered for k in ("margin", "insufficient", "limit exceeded", "order limit")):
            return BrokerError("INSUFFICIENT_MARGIN", f"{action} rejected: {text}")
        if any(k in lowered for k in ("reject", "not allowed", "invalid", "error in placing")):
            return BrokerError("ORDER_REJECTED", f"{action} rejected: {text}")
        return BrokerError("BROKER_UNAVAILABLE", f"{action} failed: {text}")