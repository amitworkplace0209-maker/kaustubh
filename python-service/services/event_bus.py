"""Browser-facing SSE event bus.

A single lightweight async pub/sub that lets long-running background workers
(the download scheduler, export worker) broadcast lifecycle events to open
browser tabs via Server-Sent Events. One bus, one stream endpoint
(``api/schedule_events.py``); consumers never own a WebSocket connection.

There is no per-client WebSocket state here — clients subscribe by adding a
bounded ``asyncio.Queue`` and events are fanned out. This is deliberately NOT
tied to the Kotak broker feed (``ws_socket/ws_manager.py``), which is a
separate, outbound-only concern.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

logger = logging.getLogger("event_bus")

MAX_SUBSCRIBERS = 200
QUEUE_MAX = 500


class EventBus:
    """Async event fan-out to browser SSE subscribers."""

    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue] = set()
        self._lock = asyncio.Lock()

    async def publish(self, event: dict[str, Any]) -> None:
        """Broadcast a JSON-serializable event dict to every subscriber."""
        try:
            payload = json.dumps(event, default=str)
        except (TypeError, ValueError):
            logger.warning("Event bus dropped unserializable event: %s", event)
            return
        async with self._lock:
            subs = list(self._subscribers)
        for q in subs:
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                pass

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAX)
        # Registration runs on the loop; a plain add is fine.
        self._subscribers.add(q)
        if len(self._subscribers) > MAX_SUBSCRIBERS:
            logger.warning("Event bus subscriber count high: %d", len(self._subscribers))
        return q

    async def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    def subscriber_count(self) -> int:
        return len(self._subscribers)


_bus = EventBus()


def get_event_bus() -> EventBus:
    return _bus


async def publish_event(event: dict[str, Any]) -> None:
    try:
        await _bus.publish(event)
    except Exception:
        logger.exception("Event bus publish failed")


def subscribe() -> asyncio.Queue:
    return _bus.subscribe()


async def unsubscribe(q: asyncio.Queue) -> None:
    await _bus.unsubscribe(q)
