"""Broker Adapter Layer — the ONE interface every terminal implements.

Every broker terminal (Kotak Neo, Shoonya, Dummy) exposes the exact same
async contract so the Common Trading Core (risk / order / position / target /
basket / p&l / audit engines) can drive whichever terminal is active without
ever knowing which broker it is.

Contracts:
  * ``is_logged_in``    — boolean, derived from the real session state.
  * read endpoints      — funds / positions / holdings / orders / trade_book.
  * actions             — place_order / modify_order / cancel_order / square_off.
  * market data         — search / quote (shared market-data path).
  * ``capabilities``    — frozen capability model (brokers.capabilities).

Adapters MUST NOT invent data. When a broker cannot serve a result it returns
a structured BrokerError, not fabricated numbers.
"""
from __future__ import annotations
from abc import ABC, abstractmethod
from typing import Any

from brokers.models import BrokerError  # noqa: F401 (re-export)


class BrokerAdapter(ABC):
    mode: str = "base"
    broker_name: str = "Broker"

    @property
    @abstractmethod
    def is_logged_in(self) -> bool:
        raise NotImplementedError

    # ---- capabilities (static; override per adapter) -----------------------
    @property
    def capabilities(self) -> dict[str, Any]:
        from brokers.capabilities import capabilities_for
        return capabilities_for(self.mode).to_dict()

    # ---- session lifecycle -------------------------------------------------
    @abstractmethod
    async def login(self) -> bool:
        raise NotImplementedError

    @abstractmethod
    async def logout(self, reason: str | None = None) -> bool:
        raise NotImplementedError

    # ---- read endpoints ----------------------------------------------------
    @abstractmethod
    async def funds(self) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    async def positions(self) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    async def holdings(self) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    async def orders(self) -> dict[str, Any]:
        """Full order book (canonical 'orders' shape, see order_engine)."""
        raise NotImplementedError

    async def order_history(self, order_id: str | None = None) -> dict[str, Any]:
        return await self.orders()

    async def trade_book(self) -> dict[str, Any]:
        return {"data": [], "stat": "ok"}

    async def margin_required(self, **kwargs: Any) -> dict[str, Any]:
        """Real broker-computed margin preview where the broker provides it.
        Adapters without a broker margin API return an honest unavailable
        envelope — never a fabricated estimate."""
        return {"api": "margin", "unavailable": True,
                "message": f"{self.broker_name} does not provide a margin API"}

    # ---- order actions -----------------------------------------------------
    @abstractmethod
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
        raise NotImplementedError

    @abstractmethod
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
        raise NotImplementedError

    @abstractmethod
    async def cancel_order(self, order_id: str) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
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
        raise NotImplementedError

    # ---- market data -------------------------------------------------------
    @abstractmethod
    async def search(self, exchange: str = "nse_cm", search_text: str = "") -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    async def quote(self, instrument_tokens: list[dict], quote_type: str = "ltp") -> dict[str, Any]:
        raise NotImplementedError


def require_logged_in(adapter: BrokerAdapter, endpoint: str) -> None:
    """Shared auth gate: raises BrokerError(NOT_LOGGED_IN) when no session."""
    if not adapter.is_logged_in:
        raise BrokerError("NOT_LOGGED_IN", f"{endpoint} requires an active {adapter.broker_name} session")