"""Tick Routing Engine.

One canonical tick in, N consumer-specific payloads out. Each consumer has a
field profile, a priority, an online flag and an optional bounded queue. The
router applies profile projection, measures delivery latency, and honours
backpressure: a consumer whose queue is full or too deep is gated (deferred)
rather than the broker socket ever being touched.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass, field

from ws_socket.engine.canonical import SCHEMA_VERSION
from ws_socket.engine.profiles import FieldProfile, FieldProfileStore

QUEUE_CAPACITY: int = 5_000
BACKPRESSURE_THRESHOLD: int = 4_000

PRIORITY_ORDER: dict[str, int] = {
    "P0": 0, "P1": 1, "P2": 2, "P3": 3,
}


@dataclass
class Consumer:
    consumer_id: str
    consumer_type: str = "CUSTOM"
    profile_id: str = "FULL_RAW"
    priority: str = "P2"
    enabled: bool = True
    online: bool = True
    instruments: set[str] | None = None  # None = all instruments
    queue: deque[dict] = field(default_factory=lambda: deque())
    maxlen: int = QUEUE_CAPACITY
    created_at: float = 0.0
    updated_at: float = 0.0
    route_id: str = ""
    bps_deferred: int = 0
    bps_dropped: int = 0

    def __post_init__(self) -> None:
        self.created_at = self.created_at or time.time()
        self.route_id = self.route_id or f"{self.consumer_id}:route"
        self._last_state_lock = threading.Lock()

    def wants(self, segment: str, token: str) -> bool:
        if self.instruments is None:
            return True
        return f"{segment}|{token}" in self.instruments or token in self.instruments

    def to_dict(self) -> dict:
        return {
            "consumer_id": self.consumer_id,
            "consumer_type": self.consumer_type,
            "profile_id": self.profile_id,
            "priority": self.priority,
            "enabled": self.enabled,
            "online": self.online,
            "route_id": self.route_id,
            "queue_size": len(self.queue),
            "backpressure_deferred": self.bps_deferred,
            "backpressure_dropped": self.bps_dropped,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class TickRouter:
    def __init__(self, profile_store: FieldProfileStore) -> None:
        self._profiles = profile_store
        self._consumers: dict[str, Consumer] = {}
        self._routed: int = 0
        self._dropped: int = 0
        self._deferred: int = 0
        self._latency_samples: deque[float] = deque(maxlen=2000)
        self._lock = threading.Lock()
        # Optional sync callback fired whenever a tick is routed to >=1 consumer
        # queue. The Connection Manager registers one so its fan-out loop can be
        # event-driven instead of polling every FANOUT_POLL_S. Runs on the SDK
        # callback thread, so the callback must be thread-safe.
        self._wakeup = None

    def set_wakeup(self, callback) -> None:
        self._wakeup = callback

    def register(self, data: dict) -> Consumer:
        consumer = Consumer(
            consumer_id=data.get("consumer_id") or f"consumer{len(self._consumers) + 1}",
            consumer_type=data.get("consumer_type", "CUSTOM"),
            profile_id=data.get("profile_id", "FULL_RAW"),
            priority=data.get("priority", "P2"),
            enabled=bool(data.get("enabled", True)),
            online=bool(data.get("online", True)),
            instruments=_to_instrument_set(data.get("instruments")),
        )
        with self._lock:
            self._consumers[consumer.consumer_id] = consumer
        return consumer

    def update(self, consumer_id: str, data: dict) -> Consumer | None:
        with self._lock:
            consumer = self._consumers.get(consumer_id)
            if consumer is None:
                return None
            if data.get("profile_id") is not None:
                consumer.profile_id = data["profile_id"]
            if data.get("priority") is not None:
                consumer.priority = data["priority"]
            if data.get("enabled") is not None:
                consumer.enabled = bool(data["enabled"])
            if data.get("online") is not None:
                consumer.online = bool(data["online"])
            if data.get("instruments") is not None:
                consumer.instruments = _to_instrument_set(data["instruments"])
            if data.get("consumer_type") is not None:
                consumer.consumer_type = data["consumer_type"]
            consumer.updated_at = time.time()
        return consumer

    def unregister(self, consumer_id: str) -> bool:
        with self._lock:
            return self._consumers.pop(consumer_id, None) is not None

    def list(self) -> list[dict]:
        with self._lock:
            return [c.to_dict() for c in self._consumers.values()]

    def get(self, consumer_id: str) -> int | None:
        return consumer_id in self._consumers

    def clear(self) -> None:
        with self._lock:
            self._consumers.clear()

    # -- routing -------------------------------------------------------
    def route(self, canonical: dict, raw: dict | None = None) -> dict:
        """Route one canonical tick to all eligible consumers.

        ``raw`` is the immutable broker ``model_dump`` blob captured by the
        engine; it is attached only to FULL_RAW profile payloads (Data Saver
        keeps it for lossless Mongo persistence).
        """
        segment = canonical.get("exchange_segment", "")
        token = canonical.get("instrument_token", "")
        started = time.monotonic()
        routed = 0
        delayed = 0
        dropped = 0

        consumers = list(self._consumers.values())
        consumers.sort(key=lambda c: PRIORITY_ORDER.get(c.priority, 3))
        for consumer in consumers:
            if not consumer.enabled or not consumer.online:
                continue
            if not consumer.wants(segment, token):
                continue
            profile = self._profiles.get(consumer.profile_id)
            if profile is None or not profile.enabled:
                consumer.bps_deferred += 1
                delayed += 1
                continue
            blob = raw if profile.profile_id == "FULL_RAW" else None
            payload = self._build_payload(canonical, consumer, profile, started, blob)
            if len(consumer.queue) >= consumer.maxlen:
                consumer.bps_dropped += 1
                dropped += 1
                continue
            if len(consumer.queue) >= BACKPRESSURE_THRESHOLD and consumer.priority not in ("P0", "P1"):
                # High-water mark on a low-priority consumer: defer this tick
                # (counted, never silent) instead of unbounded appending.
                consumer.bps_deferred += 1
                delayed += 1
                continue
            consumer.queue.append(payload)
            routed += 1
            self._latency_samples.append((time.monotonic() - started) * 1000.0)

        with self._lock:
            self._routed += routed
            self._deferred += delayed
            self._dropped += dropped

        if routed > 0 and self._wakeup is not None:
            try:
                self._wakeup()
            except Exception:
                pass

        return {
            "routed": routed,
            "deferred": delayed,
            "dropped": dropped,
            "queues": self.queue_summary(),
        }

    def _build_payload(self, canonical: dict, consumer: Consumer, profile: FieldProfile, started: float, raw: dict | None = None) -> dict:
        return {
            "event_id": canonical.get("event_id"),
            "event_type": canonical.get("event_type", "tick"),
            "schema_version": SCHEMA_VERSION,
            "sdk_version": canonical.get("sdk_version"),
            "priority": consumer.priority,
            "route_id": consumer.route_id,
            "consumer_id": consumer.consumer_id,
            "consumer_type": consumer.consumer_type,
            "field_profile": profile.profile_id,
            "instrument_token": canonical.get("instrument_token"),
            "trading_symbol": canonical.get("trading_symbol"),
            "exchange_segment": canonical.get("exchange_segment"),
            "broker_timestamp": canonical.get("broker_timestamp"),
            "broker_update_time": canonical.get("broker_update_time"),
            "received_at": canonical.get("received_at"),
            "raw_reference": canonical.get("raw_reference"),
            "feed_type": canonical.get("feed_type"),
            "feed_level": canonical.get("feed_level"),
            "fields": profile.select(canonical.get("fields") or {}),
            # The master canonical adapter attaches its object to the envelope
            # (engine.py). It must be forwarded here or downstream provenance
            # lookups (storage doc "master_canonical", Market Watch msrc)
            # silently receive None for every tick.
            "master_canonical": canonical.get("master_canonical"),
            "source": "kotak_neo_sfeed",
            "stale": False,
            "raw": raw,
        }

    # -- metrics -------------------------------------------------------
    def queue_summary(self) -> list[dict]:
        return [
            {"consumer_id": c.consumer_id, "queue_size": len(c.queue), "route_id": c.route_id}
            for c in self._consumers.values()
        ]

    def drain(self, consumer_id: str, limit: int = 100) -> list[dict]:
        consumer = self._consumers.get(consumer_id)
        if consumer is None:
            return []
        items = []
        while len(items) < limit and consumer.queue:
            items.append(consumer.queue.popleft())
        return items

    def stats(self) -> int:
        return self._routed

    @property
    def dropped(self) -> int:
        return self._dropped

    @property
    def deferred(self) -> int:
        return self._deferred

    def latency(self) -> tuple[float, float]:
        samples = list(self._latency_samples)
        if not samples:
            return 0.0, 0.0
        return min(samples), (sum(samples) / len(samples))


def _to_instrument_set(instruments) -> set[str] | None:
    if instruments is None:
        return None
    out: set[str] = set()
    for item in instruments:
        if isinstance(item, dict):
            # Accept {"exchange_segment": ..., "instrument_token": ...} rows.
            seg = item.get("exchange_segment") or item.get("exchangeSegment") or ""
            num = item.get("instrument_token") or item.get("instrumentToken")
            if seg and num is not None:
                out.add(f"{seg}|{num}")
            continue
        out.add(item)
    return out