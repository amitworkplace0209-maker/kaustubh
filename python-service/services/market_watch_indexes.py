"""Market Watch index tracking — live indexes, independent of the ranking cycle.

docs/engines/MARKET_WATCH.md §17 and Phase 16.

Indexes are fed by REAL broker index ticks on WS #1 and are published on their own
cadence (default 1s), never waiting for the 30-second ranking cycle:

    Kotak index tick -> WebSocket Engine -> normalized index state
                    -> Connection Manager -> WS #3 -> Frontend

The configured index list is real metadata (name -> instrument token) sourced from
the instrument master when the broker publishes index instruments, with an
operator-configurable token override. No field is invented: an index that has not
ticked keeps ``data_quality = UNAVAILABLE`` and ``ltp = None`` and is published as
such (doc §20).
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Optional

from services.market_watch_config import DATA_QUALITY_UNAVAILABLE
from services.market_watch_state import IndexState

logger = logging.getLogger("app.market_watch_indexes")

#: Index names Market Watch can present. Tokens are resolved from the broker /
#: instrument master at runtime; a name with no resolved token stays UNAVAILABLE
#: and is never given a fabricated value.
DEFAULT_INDEX_NAMES: tuple[str, ...] = ("NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX")

#: Operator overrides for index instrument tokens (``mwr_index_tokens``):
#: ``"NIFTY=256265,BANKNIFTY=260105"``.
SETTING_INDEX_TOKENS = "mwr_index_tokens"
SETTING_INDEX_NAMES = "mwr_index_names"


def _configured_tokens() -> dict[str, str]:
    from services.market_watch_config import mw_str

    raw = mw_str(SETTING_INDEX_TOKENS, "")
    out: dict[str, str] = {}
    for part in raw.replace(";", ",").split(","):
        if not part.strip():
            continue
        name, _, token = part.partition("=")
        name = name.strip().upper().replace(" ", "")
        token = token.strip()
        if name and token:
            out[name] = token
    return out


def _configured_names() -> list[str]:
    from services.market_watch_config import mw_str

    raw = mw_str(SETTING_INDEX_NAMES, "")
    names = [n.strip().upper().replace(" ", "") for n in raw.replace(";", ",").split(",") if n.strip()]
    return names or list(DEFAULT_INDEX_NAMES)


def _resolve_tokens_from_master() -> dict[str, str]:
    """Best-effort index token discovery from the validated instrument master."""
    found: dict[str, str] = {}
    try:
        from services.instrument_cache import instrument_cache

        if not instrument_cache.loaded:
            return found
        for inst in instrument_cache.get_instruments():
            inst_type = str(inst.get("instrumentType") or inst.get("instType") or "").upper()
            seg = str(inst.get("exchangeSegment") or inst.get("exchange") or "").upper()
            if inst_type not in {"INDEX", "IDX"} and not seg.startswith("IDX"):
                continue
            symbol = str(inst.get("symbol") or inst.get("trdSym") or "").upper().replace(" ", "")
            if not symbol:
                continue
            key = "BANKNIFTY" if "BANKNIFTY" in symbol else symbol
            token = str(inst.get("token") or inst.get("instrumentToken") or "")
            if token and key not in found:
                found[key] = token
    except Exception as exc:
        logger.debug("[MARKET_WATCH_INDEX] master token discovery unavailable: %s", exc)
    return found


class IndexTracker:
    """Bounded, lock-protected registry of live index states."""

    def __init__(self, names: Optional[tuple[str, ...]] = None) -> None:
        self._lock = threading.RLock()
        self._indexes: dict[str, IndexState] = {}
        self._by_token: dict[str, str] = {}
        self._last_publish_at: float = 0.0
        self._published = 0
        self._ticks = 0
        self._config(names)

    def _config(self, names: Optional[tuple[str, ...]] = None) -> None:
        wanted = list(names or _configured_names())
        tokens = _resolve_tokens_from_master()
        tokens.update(_configured_tokens())
        with self._lock:
            self._indexes.clear()
            self._by_token.clear()
            for name in wanted:
                token = str(tokens.get(name) or "")
                state = IndexState(name=name, token=token)
                self._indexes[name] = state
                if token:
                    self._by_token[token] = name

    def reconfigure(self) -> None:
        """Re-resolve index tokens (after the master reloads / login)."""
        self._config()

    # ------------------------------------------------------------------ #
    def names(self) -> list[str]:
        with self._lock:
            return list(self._indexes.keys())

    def is_index_token(self, token: str) -> bool:
        """True when ``token`` is one of the configured index instruments.

        Used by the engine's tick admission check (doc §12) so an index tick is
        not counted as invalid just because it has no equity ``SymbolState``.
        """
        with self._lock:
            return str(token) in self._by_token

    def apply_tick(self, token: str, tick: dict[str, Any], now: Optional[float] = None) -> bool:
        """Fold a real index tick in. Returns True when it matched an index."""
        now = now if now is not None else time.time()
        with self._lock:
            name = self._by_token.get(str(token))
            if name is None:
                return False
            state = self._indexes[name]
        if not state.apply_tick(tick, now):
            return False
        self._ticks += 1
        return True

    def states(self) -> list[IndexState]:
        with self._lock:
            return list(self._indexes.values())

    def to_dict(self) -> dict[str, Any]:
        with self._lock:
            rows = [s.to_dict() for s in self._indexes.values()]
            return {
                "indexes": rows,
                "generatedAt": time.time(),
                "ticks": self._ticks,
                "lastPublishAt": self._last_publish_at or None,
                "published": self._published,
            }

    def mark_published(self) -> None:
        self._last_publish_at = time.time()
        self._published += 1

    def live_count(self) -> int:
        with self._lock:
            return sum(1 for s in self._indexes.values() if s.ltp is not None)

    def reset(self) -> None:
        with self._lock:
            for state in self._indexes.values():
                state.ltp = None
                state.change = None
                state.change_pct = None
                state.volume = None
                state.last_tick_time = None
                state.tick_count = 0
                state.data_quality = DATA_QUALITY_UNAVAILABLE
        self._ticks = 0


index_tracker = IndexTracker()

__all__ = [
    "DEFAULT_INDEX_NAMES",
    "IndexTracker",
    "index_tracker",
]
