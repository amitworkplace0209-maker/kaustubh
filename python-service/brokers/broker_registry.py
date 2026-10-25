"""Broker Registry — capability-based registry for Trading and Market Data brokers.

Supports independent selection of:
  - Trading Broker (orders, positions, margin, square-off)
  - Market Data Broker (WebSocket feed, live ticks, subscriptions)

Current state:
  - Kotak Neo: Trading YES, Market Data YES
  - Shoonya: Trading NOT IMPLEMENTED, Market Data NOT IMPLEMENTED
  - Dummy: Trading YES (paper), Market Data YES (simulated)

Do NOT assume future capabilities. Only register what actually works.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Optional

logger = logging.getLogger("app.broker_registry")


@dataclass(frozen=True)
class BrokerCapability:
    trading: bool = False
    market_data: bool = False
    positions: bool = False
    margin: bool = False
    orders: bool = False
    holdings: bool = False
    search: bool = False
    websocket: bool = False
    auth_flow: str = "none"
    display_name: str = ""

    def to_dict(self) -> dict:
        return {
            "trading": self.trading,
            "marketData": self.market_data,
            "positions": self.positions,
            "margin": self.margin,
            "orders": self.orders,
            "holdings": self.holdings,
            "search": self.search,
            "websocket": self.websocket,
            "authFlow": self.auth_flow,
            "displayName": self.display_name,
        }


# Honest capability declarations (NO fake implementations)
BROKER_CAPABILITIES: dict[str, BrokerCapability] = {
    "kotak": BrokerCapability(
        trading=True,
        market_data=True,
        positions=True,
        margin=True,
        orders=True,
        holdings=True,
        search=True,
        websocket=True,
        auth_flow="credentials",
        display_name="Kotak Neo",
    ),
    "shoonya": BrokerCapability(
        trading=False,
        market_data=False,
        positions=False,
        margin=False,
        orders=False,
        holdings=False,
        search=False,
        websocket=False,
        auth_flow="oauth",
        display_name="Shoonya",
    ),
    "dummy": BrokerCapability(
        trading=True,
        market_data=True,
        positions=True,
        margin=False,
        orders=True,
        holdings=False,
        search=True,
        websocket=False,
        auth_flow="simulated",
        display_name="Dummy Mode",
    ),
}


class BrokerRegistry:
    """Registry for Trading and Market Data broker selections.

    The two selections are INDEPENDENT:
      - Trading Broker: used for orders, positions, margin, square-off
      - Market Data Broker: used for WebSocket feed, live ticks

    Currently both default to Kotak Neo.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._trading_broker: str = "kotak"
        self._market_data_broker: str = "kotak"
        self._trading_status: dict = {"state": "UNKNOWN", "lastChecked": 0}
        self._market_data_status: dict = {"state": "UNKNOWN", "lastChecked": 0}

    # ------------------------------------------------------------------
    # Capability queries
    # ------------------------------------------------------------------
    def get_capabilities(self, broker: str) -> Optional[BrokerCapability]:
        return BROKER_CAPABILITIES.get(broker)

    def get_all_brokers(self) -> list[dict]:
        result = []
        for broker_id, cap in BROKER_CAPABILITIES.items():
            result.append({
                "id": broker_id,
                "name": cap.display_name,
                "capabilities": cap.to_dict(),
            })
        return result

    def get_trading_brokers(self) -> list[dict]:
        return [
            {"id": b, "name": c.display_name, "implemented": c.trading}
            for b, c in BROKER_CAPABILITIES.items()
        ]

    def get_market_data_brokers(self) -> list[dict]:
        return [
            {"id": b, "name": c.display_name, "implemented": c.market_data}
            for b, c in BROKER_CAPABILITIES.items()
        ]

    # ------------------------------------------------------------------
    # Selection
    # ------------------------------------------------------------------
    def get_trading_broker(self) -> str:
        return self._trading_broker

    def set_trading_broker(self, broker: str) -> dict:
        with self._lock:
            if broker not in BROKER_CAPABILITIES:
                return {"ok": False, "error": f"unknown broker: {broker}"}
            cap = BROKER_CAPABILITIES[broker]
            if not cap.trading:
                return {
                    "ok": False,
                    "error": f"{cap.display_name} trading adapter is NOT IMPLEMENTED",
                }
            old = self._trading_broker
            self._trading_broker = broker
            logger.info("[BROKER_REGISTRY] trading broker: %s -> %s", old, broker)
            return {"ok": True, "previous": old, "current": broker}

    def get_market_data_broker(self) -> str:
        return self._market_data_broker

    def set_market_data_broker(self, broker: str) -> dict:
        with self._lock:
            if broker not in BROKER_CAPABILITIES:
                return {"ok": False, "error": f"unknown broker: {broker}"}
            cap = BROKER_CAPABILITIES[broker]
            if not cap.market_data:
                return {
                    "ok": False,
                    "error": f"{cap.display_name} market data adapter is NOT IMPLEMENTED",
                }
            old = self._market_data_broker
            self._market_data_broker = broker
            logger.info("[BROKER_REGISTRY] market data broker: %s -> %s", old, broker)
            return {"ok": True, "previous": old, "current": broker}

    # ------------------------------------------------------------------
    # Status reporting (honest — never fake connection state)
    # ------------------------------------------------------------------
    def get_trading_status(self) -> dict:
        broker = self._trading_broker
        cap = BROKER_CAPABILITIES.get(broker)
        status = {
            "broker": broker,
            "displayName": cap.display_name if cap else broker,
            "implemented": cap.trading if cap else False,
            "capabilities": cap.to_dict() if cap else {},
        }

        if not cap or not cap.trading:
            status["state"] = "NOT_IMPLEMENTED"
            status["message"] = f"{cap.display_name if cap else broker} trading adapter is not implemented yet"
            return status

        # Real status from the active adapter
        try:
            from brokers.manager import get_adapter
            adapter = get_adapter(broker)
            logged_in = adapter.is_logged_in
            status["state"] = "CONNECTED" if logged_in else "DISCONNECTED"
            status["sessionActive"] = logged_in
        except Exception as exc:
            status["state"] = "ERROR"
            status["error"] = str(exc)

        return status

    def get_market_data_status(self) -> dict:
        broker = self._market_data_broker
        cap = BROKER_CAPABILITIES.get(broker)
        status = {
            "broker": broker,
            "displayName": cap.display_name if cap else broker,
            "implemented": cap.market_data if cap else False,
            "capabilities": cap.to_dict() if cap else {},
        }

        if not cap or not cap.market_data:
            status["state"] = "NOT_IMPLEMENTED"
            status["message"] = f"{cap.display_name if cap else broker} market data adapter is not implemented yet"
            return status

        # Real status from the WebSocket manager
        try:
            from ws_socket.ws_manager import ws_manager
            ws_status = ws_manager.status()
            status["state"] = "CONNECTED" if ws_status.get("connected") else "DISCONNECTED"
            status["subscribedSymbols"] = ws_status.get("subscribed_count", 0)
            status["ticksPerSecond"] = ws_status.get("ticks_per_second", 0)
            status["reconnectCount"] = ws_status.get("supervisor_reconnect_attempt", 0)
            status["lastTickAt"] = ws_status.get("last_tick_at")
            status["heartbeatAge"] = ws_status.get("heartbeat_age")
            status["latencyMs"] = ws_status.get("latency_ms")
        except Exception as exc:
            status["state"] = "ERROR"
            status["error"] = str(exc)

        return status

    def full_status(self) -> dict:
        return {
            "trading": self.get_trading_status(),
            "marketData": self.get_market_data_status(),
            "availableBrokers": self.get_all_brokers(),
        }


# Module singleton
_broker_registry: BrokerRegistry | None = None


def get_broker_registry() -> BrokerRegistry:
    global _broker_registry
    if _broker_registry is None:
        _broker_registry = BrokerRegistry()
    return _broker_registry
