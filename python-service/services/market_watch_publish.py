"""Market Watch publish policy — what the frontend is allowed to receive.

docs/engines/MARKET_WATCH.md §15, §16, §19 and §25.

The backend keeps the FULL eligible state, but the frontend only receives a
controlled high-frequency set:

    Top ranked  +  Pinned  +  User selected  +  Currently visible

That is the rule that stops ~2800 continuous browser traffic. Two more rules from
the same section are enforced here:

* **Coalescing (doc §25)** — a display-only value publishes its LATEST state on the
  next flush window, so 10 ticks arriving before a render produce one frame. This
  is a transport optimisation only; the storage path is untouched (the tick
  buffer keeps every tick).
* **Show More (doc §16)** — paged, on demand, and never a silent promotion into the
  high-frequency set.

Event types are exactly the ones the spec lists (§19).
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

from services.market_watch_config import MarketWatchConfig, load as load_config

logger = logging.getLogger("app.market_watch_publish")

# --------------------------------------------------------------------------- #
# doc §19 event types
# --------------------------------------------------------------------------- #
EVENT_SNAPSHOT = "market_watch.snapshot"
EVENT_RANKING_UPDATE = "market_watch.ranking_update"
EVENT_STOCK_UPDATE = "market_watch.stock_update"
EVENT_INDEX_UPDATE = "market_watch.index_update"
EVENT_TIMEFRAME_UPDATE = "market_watch.timeframe_update"
EVENT_STOCK_BLOCKED = "market_watch.stock_blocked"
EVENT_STOCK_UNBLOCKED = "market_watch.stock_unblocked"
EVENT_STATUS = "market_watch.status"
EVENT_MORE_SNAPSHOT = "market_watch.more_snapshot"
EVENT_ERROR = "market_watch.error"

EVENT_TYPES: tuple[str, ...] = (
    EVENT_SNAPSHOT,
    EVENT_RANKING_UPDATE,
    EVENT_STOCK_UPDATE,
    EVENT_INDEX_UPDATE,
    EVENT_TIMEFRAME_UPDATE,
    EVENT_STOCK_BLOCKED,
    EVENT_STOCK_UNBLOCKED,
    EVENT_STATUS,
    EVENT_MORE_SNAPSHOT,
    EVENT_ERROR,
)

# --------------------------------------------------------------------------- #
# doc §16 / WS #4 command types
# --------------------------------------------------------------------------- #
CMD_SHOW_MORE = "market_watch.show_more"
CMD_SELECT_STOCK = "market_watch.select_stock"
CMD_PIN_STOCK = "market_watch.pin_stock"
CMD_UNPIN_STOCK = "market_watch.unpin_stock"
CMD_DISPLAY_INTENT = "market_watch.display_intent"

COMMAND_TYPES: tuple[str, ...] = (
    CMD_SHOW_MORE,
    CMD_SELECT_STOCK,
    CMD_PIN_STOCK,
    CMD_UNPIN_STOCK,
    CMD_DISPLAY_INTENT,
)

VALID_SECTIONS: tuple[str, ...] = ("top_gainers", "top_losers")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _token(value: Any) -> str:
    return str(value if value is not None else "").strip()


class PublishPolicy:
    """Tracks the frontend publish set and coalesces per-symbol updates.

    The engine owns the state; this object only decides WHAT may be sent and
    HOW OFTEN. It never computes a price, a rank or an eligibility decision.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._pending: dict[str, dict[str, Any]] = {}
        self._pending_timeframes: dict[str, dict[str, Any]] = {}
        self._ranked: set[str] = set()
        self._selected: set[str] = set()
        self._pinned: set[str] = set()
        self._visible: set[str] = set()
        self._last_flush_at: float = 0.0
        self._last_publish_at: float = 0.0
        self._stock_updates = 0
        self._timeframe_updates = 0
        self._coalesced = 0
        self._suppressed = 0
        self._coalesce_ms = 250
        self._max_symbols = 250
        self._live_enabled = True

    # ------------------------------------------------------------------ #
    def configure(self, cfg: Optional[MarketWatchConfig] = None) -> None:
        cfg = cfg or load_config()
        with self._lock:
            self._coalesce_ms = cfg.publish.coalesce_ms
            self._max_symbols = cfg.publish.max_symbols
            self._live_enabled = cfg.publish.live_stock_updates

    # ------------------------------------------------------------------ #
    # Publish-set membership (doc §15)
    # ------------------------------------------------------------------ #
    def set_ranked(self, tokens: Iterable[str]) -> None:
        """Replace the top-ranked token set (from the 30s ranking pass)."""
        with self._lock:
            self._ranked = {_token(t) for t in tokens if _token(t)}

    def select(self, token: str) -> None:
        with self._lock:
            self._selected.add(_token(token))

    def deselect(self, token: str) -> None:
        with self._lock:
            self._selected.discard(_token(token))

    def pin(self, token: str) -> None:
        with self._lock:
            self._pinned.add(_token(token))

    def unpin(self, token: str) -> None:
        with self._lock:
            self._pinned.discard(_token(token))

    def set_visible(self, tokens: Iterable[str]) -> None:
        """Replace the visible set (display intent / viewport)."""
        with self._lock:
            self._visible = {_token(t) for t in tokens if _token(t)}

    def clear_selection(self) -> None:
        with self._lock:
            self._selected.clear()
            self._visible.clear()
            self._pending.clear()
            self._pending_timeframes.clear()

    def set_pins(self, tokens: Iterable[str]) -> None:
        with self._lock:
            self._pinned = {_token(t) for t in tokens if _token(t)}

    def publish_set(self, ranked: Optional[Iterable[str]] = None) -> list[str]:
        """Top ranked + pinned + selected + visible, bounded and de-duplicated.

        The bound (``publish.max_symbols``) is a safety cap, NOT a way to reach a
        number: an over-large set is reported via :meth:`status`.
        """
        with self._lock:
            ranked_set = (
                {_token(t) for t in ranked if _token(t)} if ranked is not None
                else set(self._ranked)
            )
            merged = ranked_set | self._pinned | self._selected | self._visible
            return sorted(merged)[: self._max_symbols]

    def publish_set_size(self, ranked: Optional[Iterable[str]] = None) -> int:
        with self._lock:
            ranked_set = (
                {_token(t) for t in ranked if _token(t)} if ranked is not None
                else set(self._ranked)
            )
            return len(ranked_set | self._pinned | self._selected | self._visible)

    def in_publish_set(self, token: str) -> bool:
        with self._lock:
            token = _token(token)
            return (
                token in self._pinned
                or token in self._selected
                or token in self._visible
                or token in self._ranked
            )

    # ------------------------------------------------------------------ #
    # Coalesced per-symbol updates (doc §25)
    # ------------------------------------------------------------------ #
    def stage_stock(self, token: str, payload: dict[str, Any]) -> bool:
        """Buffer the latest state for one symbol. Returns True if accepted.

        Repeated ticks inside the coalesce window simply REPLACE the pending
        payload (latest state wins) — the count of replacements is reported as
        ``coalesced`` so the behaviour stays visible.
        """
        token = _token(token)
        if not token or not self._live_enabled:
            return False
        with self._lock:
            if not self.in_publish_set(token):
                self._suppressed += 1
                return False
            if token in self._pending:
                self._coalesced += 1
            self._pending[token] = payload
            return True

    def stage_timeframes(self, token: str, payload: dict[str, Any]) -> bool:
        token = _token(token)
        if not token:
            return False
        with self._lock:
            if not self.in_publish_set(token):
                self._suppressed += 1
                return False
            self._pending_timeframes[token] = payload
            return True

    def due(self, now: Optional[float] = None) -> bool:
        now = now if now is not None else time.time()
        with self._lock:
            if not self._pending and not self._pending_timeframes:
                return False
            return (now - self._last_flush_at) * 1000.0 >= self._coalesce_ms

    def drain(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Take the pending batch (stock updates, timeframe updates)."""
        with self._lock:
            stocks = [
                {"type": EVENT_STOCK_UPDATE, "timestamp": now_iso(), **payload}
                for payload in self._pending.values()
            ]
            timeframes = [
                {"type": EVENT_TIMEFRAME_UPDATE, "timestamp": now_iso(), **payload}
                for payload in self._pending_timeframes.values()
            ]
            self._pending.clear()
            self._pending_timeframes.clear()
            self._last_flush_at = time.time()
            self._stock_updates += len(stocks)
            self._timeframe_updates += len(timeframes)
            if stocks or timeframes:
                self._last_publish_at = self._last_flush_at
            return stocks, timeframes

    def pending_count(self) -> int:
        with self._lock:
            return len(self._pending) + len(self._pending_timeframes)

    def status(self) -> dict[str, Any]:
        with self._lock:
            ranked = set(self._ranked)
            return {
                "coalesceMs": self._coalesce_ms,
                "maxSymbols": self._max_symbols,
                "liveStockUpdates": self._live_enabled,
                "publishSetSize": len(ranked | self._pinned | self._selected | self._visible),
                "ranked": len(ranked),
                "pinned": len(self._pinned),
                "selected": len(self._selected),
                "visible": len(self._visible),
                "pending": len(self._pending) + len(self._pending_timeframes),
                "stockUpdates": self._stock_updates,
                "timeframeUpdates": self._timeframe_updates,
                "coalesced": self._coalesced,
                "suppressed": self._suppressed,
                "lastFlushAt": self._last_flush_at or None,
                "lastPublishAt": self._last_publish_at or None,
                "eventTypes": list(EVENT_TYPES),
                "commandTypes": list(COMMAND_TYPES),
            }

    def reset(self) -> None:
        with self._lock:
            self._pending.clear()
            self._pending_timeframes.clear()
            self._selected.clear()
            self._visible.clear()
            self._ranked = set()
            self._stock_updates = 0
            self._timeframe_updates = 0
            self._coalesced = 0
            self._suppressed = 0


# --------------------------------------------------------------------------- #
# Show More (doc §16)
# --------------------------------------------------------------------------- #
def validate_show_more(payload: dict[str, Any], cfg: Optional[MarketWatchConfig] = None) -> tuple[bool, str, dict[str, Any]]:
    """Validate a ``market_watch.show_more`` command.

    Bounded pagination: a client cannot ask for the entire eligible universe in
    one frame (``page_size`` is capped by ``show_more_max_page_size``).
    """
    cfg = cfg or load_config()
    request_id = _token(payload.get("request_id"))
    if not request_id:
        return False, "request_id is required", {}
    try:
        page = int(payload.get("page", 1))
    except (TypeError, ValueError):
        return False, "page must be an integer", {}
    if page < 1:
        return False, "page must be >= 1", {}
    try:
        page_size = int(payload.get("page_size") or cfg.universe.page_size)
    except (TypeError, ValueError):
        return False, "page_size must be an integer", {}
    page_size = max(1, min(page_size, cfg.universe.show_more_max_page_size))
    section = _token(payload.get("section") or "top_gainers")
    if section not in VALID_SECTIONS:
        return False, f"section must be one of {list(VALID_SECTIONS)}", {}
    return True, "", {
        "request_id": request_id,
        "page": page,
        "page_size": page_size,
        "section": section,
    }


def more_snapshot_event(request: dict[str, Any], stocks: list[dict[str, Any]], total_eligible: int) -> dict[str, Any]:
    """Build the doc §16 ``market_watch.more_snapshot`` response event."""
    return {
        "type": EVENT_MORE_SNAPSHOT,
        "request_id": request["request_id"],
        "timestamp": now_iso(),
        "stocks": stocks,
        "page": request["page"],
        "page_size": request["page_size"],
        "total_eligible": int(total_eligible),
    }


def error_event(request_id: Optional[str], code: str, message: str) -> dict[str, Any]:
    return {
        "type": EVENT_ERROR,
        "timestamp": now_iso(),
        "request_id": _token(request_id) or None,
        "code": code,
        "message": message,
    }


def blocked_event(entry, *, blocked: bool = True) -> dict[str, Any]:
    """``market_watch.stock_blocked`` / ``stock_unblocked`` from a ledger entry."""
    event = {
        "type": EVENT_STOCK_BLOCKED if blocked else EVENT_STOCK_UNBLOCKED,
        "timestamp": now_iso(),
        "symbol": getattr(entry, "symbol", None),
        "instrumentToken": getattr(entry, "instrument_token", None),
        "reason": getattr(entry, "reason", None),
        "threshold": getattr(entry, "threshold", None),
        "observedValue": getattr(entry, "observed_value", None),
        "detail": getattr(entry, "detail", None),
        "circuitBlockPct": getattr(entry, "circuit_block_pct", None),
        "date": getattr(entry, "date", None),
    }
    return event


def index_update_event(tracker_payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": EVENT_INDEX_UPDATE,
        "timestamp": now_iso(),
        **tracker_payload,
    }


def status_event(snapshot: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": EVENT_STATUS,
        "timestamp": now_iso(),
        **snapshot,
    }


def ranking_update_event(ranking: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": EVENT_RANKING_UPDATE,
        "timestamp": now_iso(),
        **ranking,
    }


publish_policy = PublishPolicy()

__all__ = [
    "COMMAND_TYPES",
    "CMD_DISPLAY_INTENT",
    "CMD_PIN_STOCK",
    "CMD_SELECT_STOCK",
    "CMD_SHOW_MORE",
    "CMD_UNPIN_STOCK",
    "EVENT_ERROR",
    "EVENT_INDEX_UPDATE",
    "EVENT_MORE_SNAPSHOT",
    "EVENT_RANKING_UPDATE",
    "EVENT_SNAPSHOT",
    "EVENT_STATUS",
    "EVENT_STOCK_BLOCKED",
    "EVENT_STOCK_UNBLOCKED",
    "EVENT_STOCK_UPDATE",
    "EVENT_TIMEFRAME_UPDATE",
    "EVENT_TYPES",
    "PublishPolicy",
    "blocked_event",
    "error_event",
    "index_update_event",
    "more_snapshot_event",
    "now_iso",
    "publish_policy",
    "ranking_update_event",
    "status_event",
    "validate_show_more",
]
