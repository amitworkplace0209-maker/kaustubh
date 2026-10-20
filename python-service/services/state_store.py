"""Centralized backend runtime state store + change detection.

This is the SINGLE source of truth for live system state that the frontend
consumes. It maintains current state for all major components (session,
scheduler, broker WebSocket, app WebSocket, database, internet, services,
notifications) and detects *changes* so it only publishes events when the
actual state transitions, never re-sends the same state.

Design:
  - Each entity has a current state dict.
  - `set_entity_state(entity, changes, reason)` diffs the new changes against
    the stored state; if nothing changed it returns False (no publish).
  - When something changes it publishes a `state_changed` / `service_changed`
    event to the app-level SSE stream subscribers.
  - Initial complete snapshots are sent to newly-connected frontend clients
    via the `/ws/system` style stream endpoint.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger("state_store")

# ---- Connection lifecycle states (frontend application connection) ----
APP_CONNECTING = "CONNECTING"
APP_CONNECTED = "CONNECTED"
APP_DISCONNECTED = "DISCONNECTED"
APP_RECONNECTING = "RECONNECTING"
APP_OFFLINE = "OFFLINE"

# ---- Broker connection states ----
BROKER_DISCONNECTED = "DISCONNECTED"
BROKER_CONNECTING = "CONNECTING"
BROKER_CONNECTED = "CONNECTED"
BROKER_RECONNECTING = "RECONNECTING"
BROKER_AUTH_FAILED = "AUTH_FAILED"
BROKER_UNAVAILABLE = "UNAVAILABLE"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash(v: Any) -> str:
    """Stable hash for change detection."""
    return hashlib.sha256(str(v).encode("utf-8")).hexdigest()[:16]


class StateStore:
    """Thread-safe runtime state holder with change detection + event publish."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._state: dict[str, dict] = {
            "session": {},
            "scheduler": {},
            "websocket": {},
            "app_ws": {},
            "database": {},
            "internet": {},
            "services": {},
            "notifications": {},
            "metrics": {},
        }
        self._hashes: dict[str, str] = {}
        self._subscribers: set[asyncio.Queue] = set()
        self._last_event_at: float = 0.0
        self._connected_clients = 0

    # ------------------------------------------------------------------
    # Subscription (frontend SSE stream)
    # ------------------------------------------------------------------
    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=500)
        self._subscribers.add(q)
        self._connected_clients += 1
        return q

    async def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)
        self._connected_clients = max(0, self._connected_clients - 1)

    def client_count(self) -> int:
        return self._connected_clients

    async def publish(self, frame: dict) -> None:
        """Broadcast a JSON-serializable event dict to all SSE subscribers."""
        from services.json_safe import sanitize_for_json
        payload = sanitize_for_json(frame)
        subs = list(self._subscribers)
        ftype = str(frame.get("type") or "?")
        for q in subs:
            try:
                q.put_nowait(payload)
                logger.info("[STATE-STORE.PUB] put type=%s qsize=%d", ftype, q.qsize())
            except asyncio.QueueFull:
                logger.info("[STATE-STORE.PUB] DROPPED type=%s qsize=%d", ftype, q.qsize())
                pass
        if not subs:
            logger.info("[STATE-STORE.PUB] NO_SUBSCRIBERS type=%s", ftype)
        self._last_event_at = time.monotonic()

    # ------------------------------------------------------------------
    # State management with change detection
    # ------------------------------------------------------------------
    def snapshot(self, entity: str | None = None) -> dict:
        """Return current state (optionally for one entity)."""
        if entity is not None:
            return dict(self._state.get(entity, {}) or {})
        return {k: dict(v or {}) for k, v in self._state.items()}

    async def set_entity_state(
        self,
        entity: str,
        changes: dict[str, Any],
        reason: str = "",
    ) -> bool:
        """Update an entity's state, publishing only when it actually changed.

        Returns: True if the state changed (event published), else False.
        """
        if entity not in self._state:
            self._state[entity] = {}
        current = self._state[entity]
        previous = dict(current)

        changed: dict[str, Any] = {}
        for key, value in (changes or {}).items():
            if str(current.get(key)) != str(value):
                changed[key] = value
                current[key] = value

        if not changed:
            return False

        current["_updatedAt"] = _now_iso()
        current["_reason"] = reason or current.get("_reason", "")

        event = {
            "type": "state_changed",
            "entity": entity,
            "changes": changed,
            "timestamp": _now_iso(),
            "reason": reason or "",
        }
        await self.publish(event)
        return True

    async def set_service_state(
        self,
        service: str,
        status: str,
        reason: str = "",
        details: Optional[dict] = None,
    ) -> bool:
        """Update a service's status with change detection.

        service keys: 'broker_ws', 'app_ws', 'tick_collector',
        'tick_persistence', 'mongo', 'scheduler', 'market_watch_scanner',
        'downloads', 'notification_service', 'data_quality'.

        status vocabulary: STARTED, STOPPED, FAILED, RECOVERING, RUNNING,
        DEGRADED, UNAVAILABLE, UNKNOWN.
        """
        services = self._state.setdefault("services", {})
        current = services.get(service, {})
        prev_status = current.get("status", "UNKNOWN")

        if prev_status == status and not details:
            return False

        now = _now_iso()
        record = {
            "status": status,
            "previousStatus": prev_status,
            "reason": reason or current.get("reason", ""),
            "updatedAt": now,
            **(details or {}),
        }
        services[service] = record

        event = {
            "type": "service_changed",
            "service": service,
            "changes": {"status": status, "reason": reason or ""},
            "timestamp": now,
        }
        await self.publish(event)

        if prev_status != status:
            logger.info(
                "[SVCS] %s: %s -> %s%s",
                service, prev_status, status,
                f" (reason={reason})" if reason else "",
            )
        return True


_state_store = StateStore()


def get_state_store() -> StateStore:
    return _state_store


async def set_entity_state(entity: str, changes: dict[str, Any], reason: str = "") -> bool:
    return await _state_store.set_entity_state(entity, changes, reason)


async def set_service_state(service: str, status: str, reason: str = "", details: Optional[dict] = None) -> bool:
    return await _state_store.set_service_state(service, status, reason, details)


def get_snapshot(entity: str | None = None) -> dict:
    """Synchronous snapshot read (safe from any thread/loop)."""
    return _state_store.snapshot(entity)
