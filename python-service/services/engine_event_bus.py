"""Engine Event Bus — typed, async, internal event system for engine communication.

Engines publish events to the bus; consumers subscribe to specific event types.
This decouples engines from each other — no direct inter-engine imports.

Usage::

    from services.engine_event_bus import get_event_bus, EngineEvent

    # Publishing
    await get_event_bus().publish(EngineEvent(
        event_type="TICK_RECEIVED",
        source_engine="websocket_engine",
        data={"symbol": "RELIANCE", "ltp": 2500.0},
    ))

    # Subscribing
    queue = await get_event_bus().subscribe(["TICK_RECEIVED", "ORDER_FILLED"])
    event = await queue.get()
"""

from __future__ import annotations

import asyncio
import logging
import time
import threading
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Optional

logger = logging.getLogger("app.engine_event_bus")


@dataclass
class EngineEvent:
    event_type: str
    source_engine: str
    data: dict[str, Any] = field(default_factory=dict)
    timestamp: float = 0.0
    correlation_id: str = ""
    severity: str = "info"  # info, warning, error, critical

    def __post_init__(self) -> None:
        if self.timestamp <= 0:
            self.timestamp = time.time()

    def to_dict(self) -> dict:
        return {
            "eventType": self.event_type,
            "sourceEngine": self.source_engine,
            "data": self.data,
            "timestamp": self.timestamp,
            "correlationId": self.correlation_id,
            "severity": self.severity,
        }


# Canonical event types
class EngineEvents:
    # Lifecycle
    ENGINE_STARTED = "ENGINE_STARTED"
    ENGINE_STOPPED = "ENGINE_STOPPED"
    ENGINE_ERROR = "ENGINE_ERROR"
    ENGINE_HEARTBEAT = "ENGINE_HEARTBEAT"

    # Session
    SESSION_CREATED = "SESSION_CREATED"
    SESSION_EXPIRED = "SESSION_EXPIRED"
    SESSION_LOGGED_IN = "SESSION_LOGGED_IN"
    SESSION_LOGGED_OUT = "SESSION_LOGGED_OUT"

    # Connection
    CONNECTION_CONNECTED = "CONNECTION_CONNECTED"
    CONNECTION_DISCONNECTED = "CONNECTION_DISCONNECTED"
    SUBSCRIPTION_UPDATED = "SUBSCRIPTION_UPDATED"

    # WebSocket
    WEBSOCKET_CONNECTED = "WEBSOCKET_CONNECTED"
    WEBSOCKET_DISCONNECTED = "WEBSOCKET_DISCONNECTED"
    WEBSOCKET_RECONNECTED = "WEBSOCKET_RECONNECTED"

    # Broker
    BROKER_CHANGED = "BROKER_CHANGED"
    MARKET_DATA_BROKER_CHANGED = "MARKET_DATA_BROKER_CHANGED"
    TRADING_BROKER_CHANGED = "TRADING_BROKER_CHANGED"

    # Market data
    TICK_RECEIVED = "TICK_RECEIVED"
    TICK_VALIDATED = "TICK_VALIDATED"
    TICK_REJECTED = "TICK_REJECTED"
    MARKET_STATUS_CHANGED = "MARKET_STATUS_CHANGED"
    MARKET_OPEN = "MARKET_OPEN"
    MARKET_CLOSED = "MARKET_CLOSED"

    # Features
    FEATURE_CALCULATED = "FEATURE_CALCULATED"

    # Orders
    ORDER_CREATED = "ORDER_CREATED"
    ORDER_SUBMITTED = "ORDER_SUBMITTED"
    ORDER_REJECTED = "ORDER_REJECTED"
    ORDER_FILLED = "ORDER_FILLED"
    ORDER_CANCELLED = "ORDER_CANCELLED"
    ORDER_MODIFIED = "ORDER_MODIFIED"
    ORDER_PARTIALLY_FILLED = "ORDER_PARTIALLY_FILLED"

    # Positions
    POSITION_UPDATED = "POSITION_UPDATED"
    POSITION_LIMIT_REACHED = "POSITION_LIMIT_REACHED"

    # Margin
    MARGIN_UPDATED = "MARGIN_UPDATED"
    MARGIN_REJECTED = "MARGIN_REJECTED"

    # Square-off
    SQUARE_OFF_STARTED = "SQUARE_OFF_STARTED"
    SQUARE_OFF_COMPLETED = "SQUARE_OFF_COMPLETED"
    SQUARE_OFF_FAILED = "SQUARE_OFF_FAILED"

    # Suggestions
    SUGGESTION_CREATED = "SUGGESTION_CREATED"

    # Notifications
    NOTIFICATION_CREATED = "NOTIFICATION_CREATED"

    # Watchlist
    WATCHLIST_UPDATED = "WATCHLIST_UPDATED"

    # Market Coach
    MARKET_COACH_UPDATED = "MARKET_COACH_UPDATED"

    # Storage
    STORAGE_WRITE_COMPLETE = "STORAGE_WRITE_COMPLETE"
    STORAGE_ERROR = "STORAGE_ERROR"


class EngineEventBus:
    """Async pub/sub event bus for inter-engine communication."""

    MAX_SUBSCRIBERS = 500
    QUEUE_MAX_SIZE = 1000

    def __init__(self) -> None:
        self._subscribers: dict[str, list[asyncio.Queue]] = defaultdict(list)
        self._wildcard_subscribers: list[asyncio.Queue] = []
        self._lock = threading.RLock()
        self._event_history: list[dict] = []
        self._max_history = 500
        self._total_published = 0
        self._total_delivered = 0

    async def publish(self, event: EngineEvent) -> int:
        """Publish an event to all matching subscribers. Returns delivery count."""
        delivered = 0
        payload = event.to_dict()

        with self._lock:
            # Record history
            self._event_history.append(payload)
            if len(self._event_history) > self._max_history:
                self._event_history = self._event_history[-self._max_history:]
            self._total_published += 1

            # Get matching subscribers
            typed = list(self._subscribers.get(event.event_type, []))
            wild = list(self._wildcard_subscribers)
            all_subscribers = typed + wild

        for queue in all_subscribers:
            try:
                queue.put_nowait(payload)
                delivered += 1
            except asyncio.QueueFull:
                # Drop oldest and add new
                try:
                    queue.get_nowait()
                    queue.put_nowait(payload)
                    delivered += 1
                except Exception:
                    pass

        with self._lock:
            self._total_delivered += delivered

        if event.severity in ("error", "critical"):
            logger.warning(
                "[EVENT_BUS] %s from %s: %s",
                event.event_type, event.source_engine,
                event.data.get("message", "")[:200],
            )

        return delivered

    async def subscribe(
        self, event_types: list[str] | None = None
    ) -> asyncio.Queue:
        """Subscribe to specific event types or all events (None)."""
        queue: asyncio.Queue = asyncio.Queue(maxsize=self.QUEUE_MAX_SIZE)

        with self._lock:
            if event_types is None:
                self._wildcard_subscribers.append(queue)
            else:
                for et in event_types:
                    self._subscribers[et].append(queue)

        return queue

    async def unsubscribe(self, queue: asyncio.Queue) -> None:
        with self._lock:
            for et in list(self._subscribers.keys()):
                self._subscribers[et] = [q for q in self._subscribers[et] if q is not queue]
            self._wildcard_subscribers = [q for q in self._wildcard_subscribers if q is not queue]

    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._wildcard_subscribers) + sum(
                len(qs) for qs in self._subscribers.values()
            )

    def get_history(self, limit: int = 50) -> list[dict]:
        with self._lock:
            return list(self._event_history)[-limit:]

    def stats(self) -> dict:
        with self._lock:
            return {
                "totalPublished": self._total_published,
                "totalDelivered": self._total_delivered,
                "subscriberCount": self.subscriber_count(),
                "eventTypes": len(self._subscribers),
                "historySize": len(self._event_history),
            }


# Module singleton
_bus: EngineEventBus | None = None


def get_event_bus() -> EngineEventBus:
    global _bus
    if _bus is None:
        _bus = EngineEventBus()
    return _bus
