"""Market Watch ranking engine (docs/engines/MARKET_WATCH.md §9-§14).

Builds 30-second ranking snapshots from the scanner's latest valid gainers and
losers, tracks repeated Top-5 appearances per trading day, and maintains up to
five automatic Gainer pins and five automatic Loser pins.

The pins are automatic (never manual). Ranking frequency is decoupled from the
live tick feed: the scanner's full-universe ranking cadence bounds how often a
snapshot can be produced, and the engine never fabricates a snapshot or a
frequency count. All counters are trading-day scoped and reset on a new
trading day.

Pure/in-memory and deterministic so it is unit-testable without a broker.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Optional

logger = logging.getLogger("app.market_watch_ranking")

RANKING_INTERVAL_SECONDS = 30.0
MAX_GAINER_PINS = 5
MAX_LOSER_PINS = 5
TOP_N_TRACKED = 5
MAX_SNAPSHOTS_KEPT = 240


def _fnum(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        f = float(value)
        return f if f == f else None
    except (TypeError, ValueError):
        return None


class MarketWatchRankingEngine:
    """Trading-day scoped ranking snapshots + automatic Top-5 pins."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._trading_date: str | None = None
        self._last_snapshot_at: float = 0.0
        self._snapshots: list[dict] = []
        self._gainer_appearances: dict[str, dict] = {}
        self._loser_appearances: dict[str, dict] = {}
        self._gainer_pins: list[dict] = []
        self._loser_pins: list[dict] = []
        self._gainer_pin_changes = 0
        self._loser_pin_changes = 0
        self._interval = RANKING_INTERVAL_SECONDS

    # ------------------------------------------------------------------
    # Trading-day scope
    # ------------------------------------------------------------------
    def ensure_trading_day(self, trading_date: str | None) -> bool:
        """Reset all counters when the trading day changes. Returns True if reset."""
        if not trading_date:
            return False
        with self._lock:
            if self._trading_date == trading_date:
                return False
            self._trading_date = trading_date
            self._snapshots.clear()
            self._gainer_appearances.clear()
            self._loser_appearances.clear()
            self._gainer_pins = []
            self._loser_pins = []
            self._last_snapshot_at = 0.0
        logger.info("[MW-RANK] trading day reset -> %s", trading_date)
        return True

    def due(self, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        return (now - self._last_snapshot_at) >= self._interval

    # ------------------------------------------------------------------
    # Snapshot + frequency tracking
    # ------------------------------------------------------------------
    def record_snapshot(
        self,
        gainers: list[dict],
        losers: list[dict],
        *,
        trading_date: str | None = None,
        now: float | None = None,
        force: bool = False,
        volume_rows: list[dict] | None = None,
    ) -> Optional[dict]:
        """Record one ranking snapshot and refresh the automatic pins.

        ``gainers``/``losers`` must already be ranked (best first). ``volume_rows``
        may carry the highest-volume rows (best first) for the snapshot's
        ``topVolume`` read model. Returns the snapshot dict, or ``None`` when
        throttled (not due and not forced).
        """
        now = time.time() if now is None else now
        with self._lock:
            self.ensure_trading_day(trading_date)
            if not force and not self.due(now):
                return None

            top_gainers = self._top_tokens(gainers)
            top_losers = self._top_tokens(losers)
            top_volume = self._top_tokens(volume_rows or [])
            if not top_gainers and not top_losers:
                return None

            self._last_snapshot_at = now
            self._absorb(self._gainer_appearances, gainers, now)
            self._absorb(self._loser_appearances, losers, now)

            new_gainer_pins = self._select_pins(self._gainer_appearances, MAX_GAINER_PINS)
            new_loser_pins = self._select_pins(self._loser_appearances, MAX_LOSER_PINS)
            if {p["token"] for p in new_gainer_pins} != {p["token"] for p in self._gainer_pins}:
                self._gainer_pin_changes += 1
            if {p["token"] for p in new_loser_pins} != {p["token"] for p in self._loser_pins}:
                self._loser_pin_changes += 1
            self._gainer_pins = new_gainer_pins
            self._loser_pins = new_loser_pins

            snapshot = {
                "timestamp": time.strftime("%H:%M:%S", time.localtime(now)),
                "epoch": now,
                "tradingDate": self._trading_date,
                "topGainers": top_gainers,
                "topLosers": top_losers,
                "topVolume": top_volume,
            }
            self._snapshots.append(snapshot)
            if len(self._snapshots) > MAX_SNAPSHOTS_KEPT:
                del self._snapshots[: len(self._snapshots) - MAX_SNAPSHOTS_KEPT]
            return snapshot

    def _top_tokens(self, rows: list[dict]) -> list[str]:
        out: list[str] = []
        for row in rows[:TOP_N_TRACKED]:
            token = str(row.get("token") or row.get("instrumentToken") or "")
            if token:
                out.append(token)
        return out

    def _absorb(self, store: dict[str, dict], rows: list[dict], now: float) -> None:
        for rank, row in enumerate(rows[:TOP_N_TRACKED], start=1):
            token = str(row.get("token") or row.get("instrumentToken") or "")
            if not token:
                continue
            entry = store.setdefault(token, {
                "token": token,
                "symbol": row.get("symbol") or "",
                "appearances": 0,
                "lastRank": rank,
                "lastSeen": now,
            })
            entry["appearances"] += 1
            entry["lastRank"] = rank
            entry["lastSeen"] = now
            entry["symbol"] = row.get("symbol") or entry.get("symbol") or ""

    def _select_pins(self, store: dict[str, dict], limit: int) -> list[dict]:
        candidates = list(store.values())
        candidates.sort(key=lambda e: (
            -e["appearances"],
            e["lastRank"],
            -e["lastSeen"],
            str(e.get("symbol") or ""),
            str(e.get("token") or ""),
        ))
        return [dict(c) for c in candidates[:limit]]

    # ------------------------------------------------------------------
    # Read models
    # ------------------------------------------------------------------
    def snapshot(self) -> dict:
        with self._lock:
            return {
                "tradingDate": self._trading_date,
                "lastSnapshotAt": self._last_snapshot_at or None,
                "latest": self._snapshots[-1] if self._snapshots else None,
                "snapshotCount": len(self._snapshots),
                "gainers": self._snapshots[-1]["topGainers"] if self._snapshots else [],
                "losers": self._snapshots[-1]["topLosers"] if self._snapshots else [],
                "volume": self._snapshots[-1]["topVolume"] if self._snapshots else [],
            }

    def pins(self) -> dict:
        with self._lock:
            return {
                "tradingDate": self._trading_date,
                "gainers": [dict(p) for p in self._gainer_pins],
                "losers": [dict(p) for p in self._loser_pins],
            }

    def status(self) -> dict:
        with self._lock:
            return {
                "tradingDate": self._trading_date,
                "rankingIntervalSeconds": self._interval,
                "maxGainerPins": MAX_GAINER_PINS,
                "maxLoserPins": MAX_LOSER_PINS,
                "snapshotCount": len(self._snapshots),
                "gainerTracked": len(self._gainer_appearances),
                "loserTracked": len(self._loser_appearances),
                "gainerPins": len(self._gainer_pins),
                "loserPins": len(self._loser_pins),
                "gainerPinChanges": self._gainer_pin_changes,
                "loserPinChanges": self._loser_pin_changes,
                "lastSnapshotAt": self._last_snapshot_at or None,
            }

    def reset(self) -> None:
        """Force a full reset (used for tests / end-of-day cleanup)."""
        with self._lock:
            self._trading_date = None
            self._gainer_appearances.clear()
            self._loser_appearances.clear()
            self._gainer_pins = []
            self._loser_pins = []
            self._snapshots.clear()
            self._last_snapshot_at = 0.0


market_watch_ranking = MarketWatchRankingEngine()
