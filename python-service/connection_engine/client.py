"""ClientSession — one persistent backend → frontend WebSocket (WS #2) session.

Each session owns a single bounded ``Outbox`` drained by exactly one *writer*
task (the gateway endpoint). All producers on the event loop (fan-out loop,
state bridge, request handlers) enqueue into the outbox, so a socket is never
written concurrently.

Lifecycle (connection-manager.md §23): every session carries an explicit
lifecycle state machine driven by REAL transitions — CREATED → CONNECTING →
ACTIVE → DISCONNECTING → TERMINATED — plus two derived runtime states
(DEGRADED when drops/errors occur, STALE when the client goes idle) that are
computed on read from live counters. Nothing is fabricated.
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from typing import Optional

logger = logging.getLogger("connection_engine")

# Bounded outbox: latest-value semantics are applied on overflow (oldest market
# frames are evicted before critical frames ever are).
OUTBOX_MAXLEN = 1000

# Server-driven heartbeat cadence when the client is idle (pings).
HEARTBEAT_INTERVAL_S = 12.0

# A session is STALE when the client has been idle at least this long.
STALE_AFTER_S = 60.0

# Delivery-metric windows (real measurements, never estimates): bytes and
# enqueue→delivery latency are sampled on the actual WS write path and kept as
# bounded window samples, so aggregates are computed from real recent activity
# instead of a lifetime average that decays into meaninglessness.
_METRIC_WINDOW_S = 30.0
_METRIC_MAX_SAMPLES = 512

# Lifecycle vocabulary (connection-manager.md §23) — explicit transitions.
CREATED = "CREATED"
CONNECTING = "CONNECTING"
ACTIVE = "ACTIVE"
DISCONNECTING = "DISCONNECTING"
TERMINATED = "TERMINATED"
# Derived on read (never a stored transition unless it becomes terminal).
DEGRADED = "DEGRADED"
STALE = "STALE"

LIFECYCLE_EVENT_LIMIT = 16


def _outbox_limit() -> int:
    """Resolve the configured outbox capacity (runtime setting → default)."""
    try:
        from services.runtime_settings import get_runtime_setting

        value = get_runtime_setting("cm_outbox_maxlen")
        if value:
            try:
                return max(100, min(5000, int(value)))
            except (TypeError, ValueError):
                pass
    except Exception:
        pass
    return OUTBOX_MAXLEN


class Outbox:
    """Thread-safe-enough FIFO of frames for the single writer task.

    All access happens on the application event loop, so this uses a plain
    deque + asyncio.Event wake. On overflow:

    * an incoming **market** frame evicts an older market frame still in flight
      (the freshest tick always wins — the UI keeps latest-value state);
    * an incoming **critical** frame (order/notification) evicts one older
      non-critical frame so it can never be displaced.
    """

    def __init__(self, maxlen: int | None = None) -> None:
        self._items: deque[dict] = deque()
        self._maxlen = maxlen or _outbox_limit()
        self._wake = asyncio.Event()
        self.dropped_market = 0
        self.dropped_critical = 0

    @property
    def maxlen(self) -> int:
        return self._maxlen

    def put(self, frame: dict, critical: bool = False) -> None:
        if not isinstance(frame, dict):
            return
        ftype = str(frame.get("type") or "")
        is_market = ftype.startswith("market.")
        # Enqueue timestamp for REAL delivery-latency measurement (spec §51).
        # The writer strips the reserved key before the frame hits the socket,
        # so it never reaches the client — a missing/stale key simply means the
        # frame bypassed the outbox (hibernated paths) and contributes bytes
        # only, never a fabricated latency value.
        if "_cm_enq" not in frame:
            frame["_cm_enq"] = time.monotonic()
        if len(self._items) >= self._maxlen:
            if not self._make_room(is_market, critical):
                return
        self._items.append(frame)
        self._wake.set()

    def _make_room(self, is_market: bool, critical: bool) -> bool:
        if is_market:
            for i, item in enumerate(self._items):
                if str(item.get("type") or "").startswith("market."):
                    del self._items[i]
                    self.dropped_market += 1
                    return True
            self.dropped_market += 1
            return False
        for i, item in enumerate(self._items):
            if not str(item.get("type") or "").startswith("market."):
                del self._items[i]
                self.dropped_market += 1
                return True
        if self._items:
            self._items.popleft()
            self.dropped_market += 1
            return True
        self.dropped_critical += 1
        return False

    async def get(self, timeout: Optional[float] = None) -> Optional[dict]:
        """Pop the head frame; ``None`` on timeout or when empty after wait."""
        if self._items:
            return self._items.popleft()
        self._wake.clear()
        try:
            await asyncio.wait_for(self._wake.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            return None
        return self._items.popleft() if self._items else None

    def __len__(self) -> int:
        return len(self._items)


class ClientSession:
    """One connected operator frontend on the gateway WebSocket."""

    def __init__(self, connection_id: str, username: str = "anonymous") -> None:
        self.connection_id = connection_id
        self.username = username or "anonymous"
        self.closed = False
        self.attached_at = time.time()
        self.last_activity_at = time.time()
        self.sequence = 0
        self.outbox = Outbox()
        # market channel name -> {"consumer_id", "profile_id", "tokens": {"SEG|TOK": row}}
        self.channels: dict[str, dict] = {}
        # state-channel names subscribed by this client
        self.state_channels: set[str] = set()
        self._tasks: list[asyncio.Task] = []
        # (channel, token) -> last send epoch (rate control bookkeeping)
        self._last_sent: dict[tuple, float] = {}
        self.ticks_sent = 0
        self.frames_sent = 0

        # Real wire-delivery metrics (spec §51): bytes were previously untracked
        # and delivery latency had no measurement point at all. The gateway
        # writer samples both here per actual socket write.
        self._bytes_sent = 0
        self._bytes_window: deque[tuple[float, int]] = deque()
        self._latency_window: deque[tuple[float, float]] = deque()

        # Lifecycle state machine (real transitions only).
        self._lifecycle: list[dict] = []
        self._transition(CREATED, "session created")

        # Last recorded error (most recent non-fatal/fatal problem for this
        # session); None when the session never errored.
        self.last_error: dict | None = None

    # ------------------------------------------------------------------ #
    # Lifecycle
    # ------------------------------------------------------------------ #
    def _transition(self, state: str, reason: str = "") -> None:
        now = time.time()
        self._lifecycle.append({
            "state": state,
            "at": now,
            "reason": reason,
        })
        if len(self._lifecycle) > LIFECYCLE_EVENT_LIMIT:
            self._lifecycle = self._lifecycle[-LIFECYCLE_EVENT_LIMIT:]
        logger.info(
            "[CE] session %s -> %s%s",
            self.connection_id, state, f" ({reason})" if reason else "",
        )

    @property
    def lifecycle_state(self) -> str:
        """Explicit transition state (CREATED/CONNECTING/ACTIVE/DISCONNECTING/TERMINATED)."""
        if self._lifecycle:
            return self._lifecycle[-1]["state"]
        return CREATED

    def last_transition_at(self) -> float | None:
        return self._lifecycle[-1]["at"] if self._lifecycle else None

    def last_reason(self) -> str:
        return self._lifecycle[-1].get("reason") or "" if self._lifecycle else ""

    def lifecycle_events(self) -> list[dict]:
        return list(self._lifecycle)

    def transition(self, state: str, reason: str = "") -> None:
        """Public lifecycle move (the gateway records the REAL disconnect
        reason here so §29 history rows carry a truthful terminal cause)."""
        self._transition(state, reason)

    def current_state(self) -> str:
        """Derived runtime state (spec §23 vocabulary), computed from real signals.

        DEGRADED = the outbox has dropped frames or an error was recorded;
        STALE = attached but no client activity for > STALE_AFTER_S.
        """
        if self.closed:
            return TERMINATED
        base = self.lifecycle_state
        if base != ACTIVE:
            return base
        if self.last_error is not None:
            return DEGRADED
        if self.outbox.dropped_market + self.outbox.dropped_critical > 0:
            return DEGRADED
        if time.time() - self.last_activity_at > STALE_AFTER_S:
            return STALE
        return ACTIVE

    def record_error(self, code: str, message: str = "") -> None:
        self.last_error = {"code": code, "message": message, "at": time.time()}
        logger.warning("[CE] session %s error: %s — %s", self.connection_id, code, message)

    def attach_task(self, task: asyncio.Task) -> None:
        self._tasks.append(task)

    def mark_activity(self) -> None:
        self.last_activity_at = time.time()

    def next_sequence(self) -> int:
        self.sequence += 1
        return self.sequence

    def has_channel(self, channel: str) -> bool:
        return channel in self.channels or channel in self.state_channels

    async def close(self, reason: str = "") -> None:
        """Stop all background tasks and mark the session closed."""
        if self.closed:
            return
        self._transition(DISCONNECTING, reason or "session closing")
        self.closed = True
        try:
            self.outbox.put({"type": "connection.closed", "data": {}}, critical=True)
        except Exception:
            pass
        for task in self._tasks:
            if not task.done():
                task.cancel()
        for task in self._tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        self._tasks.clear()
        self._transition(TERMINATED, reason or "session closed")

    def record_delivery(self, nbytes: int, latency_ms: float | None = None) -> None:
        """Record one REAL wire delivery (called from the gateway writer).

        ``nbytes`` is the exact wire payload length that was handed to the
        socket; ``latency_ms`` is the enqueue→delivery delay for frames that
        travelled through the outbox (None for direct frames such as pings).
        Both feed bounded rolling windows (~``_METRIC_WINDOW_S``) that the
        control plane aggregates into spec §51's bytes/sec and average
        delivery latency — previously honest NOT_PROVIDED gaps.
        """
        now = time.time()
        if nbytes > 0:
            self._bytes_sent += nbytes
            self._bytes_window.append((now, nbytes))
            self._trim_window(self._bytes_window, now)
        if latency_ms is not None and latency_ms >= 0:
            self._latency_window.append((now, latency_ms))
            self._trim_window(self._latency_window, now)

    @staticmethod
    def _trim_window(window: deque, now: float) -> None:
        while window and (now - window[0][0]) > _METRIC_WINDOW_S:
            window.popleft()
        while len(window) > _METRIC_MAX_SAMPLES:
            window.popleft()

    def bytes_sent_total(self) -> int:
        return self._bytes_sent

    def bytes_per_sec(self) -> float | None:
        """Real wire bytes/sec over the recent window, or None when idle."""
        now = time.time()
        self._trim_window(self._bytes_window, now)
        if not self._bytes_window:
            return None
        total = sum(n for _, n in self._bytes_window)
        span = min(_METRIC_WINDOW_S, max(now - self._bytes_window[0][0], 0.25))
        return round(total / span, 2)

    def avg_delivery_latency_ms(self) -> float | None:
        """Average enqueue→delivery latency over the recent window, or None."""
        now = time.time()
        self._trim_window(self._latency_window, now)
        if not self._latency_window:
            return None
        return round(sum(v for _, v in self._latency_window) / len(self._latency_window), 2)

    def stats_dict(self) -> dict:
        return {
            "connectionId": self.connection_id,
            "username": self.username,
            "channels": sorted(self.channels) + sorted(self.state_channels),
            "upSeconds": round(time.time() - self.attached_at, 1),
            "outboxSize": len(self.outbox),
            "ticksSent": self.ticks_sent,
            "framesSent": self.frames_sent,
            "droppedMarket": self.outbox.dropped_market,
            "droppedCritical": self.outbox.dropped_critical,
            "bytesSent": self._bytes_sent,
            "bytesPerSec": self.bytes_per_sec(),
            "avgDeliveryLatencyMs": self.avg_delivery_latency_ms(),
        }