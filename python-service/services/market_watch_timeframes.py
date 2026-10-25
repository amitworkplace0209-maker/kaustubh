"""Market Watch timeframe engine — real 1m / 5m / 10m / 30m aggregation.

docs/engines/MARKET_WATCH.md §11 / Phase 9.

Design:

* Every validated tick folds into exactly the four buckets it belongs to. The
  per-tick cost is O(#timeframes) — never a full-universe pass.
* A bucket is identified by its floor-aligned start epoch, so a tick at 09:14:37
  belongs to the 09:14 1m bucket, the 09:10 5m bucket, the 09:10 10m bucket and
  the 09:00 30m bucket.
* On roll-over the finished bucket is emitted to the DB Writer (buffered; never
  a synchronous Mongo write from the tick path) and retained for the current
  window so the UI can still read the last completed candle.
* ``change`` / ``change_pct`` follow doc §11 exactly:

      completed candle   change = close - open
                         change_pct = (close - open) / open * 100
      in-progress candle change = current - open
                         change_pct = (current - open) / open * 100

  A candle with no ``open`` keeps ``price_move``/``change_pct`` as ``None``.
* Recovery: ``restore_symbol`` rebuilds in-progress buckets from stored candles.
  Anything that cannot be reconstructed is marked ``INCOMPLETE`` — it is never
  invented (doc §21).
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from typing import Any, Callable, Optional

from services.market_watch_config import (
    DATA_QUALITY_INCOMPLETE,
    DATA_QUALITY_UNAVAILABLE,
    TIMEFRAMES,
    TIMEFRAME_SECONDS,
)
from services.market_watch_state import TimeframeState, epoch_seconds, utc_iso

logger = logging.getLogger("app.market_watch_timeframes")

# A bounded per-symbol ring of recently completed candles. The engine keeps only
# what the UI + ranking need; durable history lives in Mongo (never unbounded in
# memory — doc §31 "No unbounded in-memory tick history").
COMPLETED_HISTORY_PER_SYMBOL = 4


def bucket_start(now: float, timeframe: str) -> float:
    """Floor-align ``now`` to the timeframe boundary (epoch seconds)."""
    span = TIMEFRAME_SECONDS.get(timeframe)
    if not span:
        return now
    return float(int(now // span) * span)


def next_boundary(now: float, timeframe: str) -> float:
    return bucket_start(now, timeframe) + TIMEFRAME_SECONDS.get(timeframe, 60)


class TimeframeEngine:
    """Owns the four per-symbol timeframe buckets and candle roll-over."""

    def __init__(self, on_candle: Optional[Callable[[str, str, dict[str, Any]], None]] = None) -> None:
        self._lock = threading.RLock()
        # token -> timeframe -> completed candle history (bounded)
        self._completed: dict[str, dict[str, list[dict[str, Any]]]] = {}
        # token -> SymbolState, bound by the owning engine so candles can be
        # force-closed on the 15:15 Market Watch stop.
        self._bound: dict[str, Any] = {}
        self._on_candle = on_candle
        self._candles_emitted = 0
        self._rollovers = 0
        self._last_commit_at = 0.0
        self._recovered_incomplete = 0

    # ------------------------------------------------------------------ #
    def set_candle_sink(self, sink: Callable[[str, str, dict[str, Any]], None]) -> None:
        self._on_candle = sink

    def observe_tick(self, state, now: float) -> list[dict[str, Any]]:
        """Fold a tick into the symbol's timeframe buckets.

        ``state`` is a :class:`services.market_watch_state.SymbolState`. Returns
        the list of candles that just completed (usually empty, at most one per
        timeframe when a boundary is crossed).
        """
        ltp = state.ltp
        if ltp is None or ltp <= 0:
            return []
        emitted: list[dict[str, Any]] = []
        for tf in TIMEFRAMES:
            span = TIMEFRAME_SECONDS[tf]
            bucket = float(int((state.last_tick_time or now) // span) * span)
            tfs = state.timeframe(tf)
            if tfs.start_time is not None and tfs.start_time != bucket and tfs.tick_count > 0:
                # Boundary crossed: close the previous bucket before opening the new one.
                self._finish(state, tfs, emitted, complete=True)
                tfs.start_time = None
                tfs.open = None
                tfs.high = None
                tfs.low = None
                tfs.close = None
                tfs.volume = None
                tfs.vwap = None
                tfs.price_move = None
                tfs.change_pct = None
                tfs.tick_count = 0
                tfs.complete = False
                tfs.data_quality = DATA_QUALITY_UNAVAILABLE
                tfs._cum_turnover = 0.0
                tfs._cum_volume = 0.0
                tfs._last_volume = None
            tfs.apply_tick(ltp, state.volume, now, bucket)
        return emitted

    def _finish(self, state, tfs: TimeframeState, emitted: list[dict[str, Any]], *, complete: bool) -> None:
        tfs.complete = complete
        if tfs.tick_count == 0:
            return
        doc = tfs.to_storage_doc(state.symbol, state.instrument_token, "")
        doc["closedAt"] = utc_iso(tfs.end_time)
        emitted.append(doc)
        self._remember(state.instrument_token, tfs.timeframe, doc)
        self._candles_emitted += 1
        self._rollovers += 1
        if self._on_candle is not None:
            try:
                self._on_candle(state.instrument_token, tfs.timeframe, doc)
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning("[MARKET_WATCH_TF] candle sink failed: %s", exc)

    def _remember(self, token: str, timeframe: str, doc: dict[str, Any]) -> None:
        with self._lock:
            per_tf = self._completed.setdefault(token, {})
            history = per_tf.setdefault(timeframe, [])
            history.append(doc)
            if len(history) > COMPLETED_HISTORY_PER_SYMBOL:
                del history[: len(history) - COMPLETED_HISTORY_PER_SYMBOL]

    # ------------------------------------------------------------------ #
    def completed_history(self, token: str, timeframe: str) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(d) for d in self._completed.get(token, {}).get(timeframe, [])]

    def close_open_candles(self, date: str) -> int:
        """Force-close every in-progress bucket (15:15 stop / EOD).

        The finished candles are persisted so the EOD report and the next
        session's recovery read real values, not an open bucket.
        """
        emitted: list[dict[str, Any]] = []
        for state in list(self._bound.values()):
            for tf in TIMEFRAMES:
                tfs = state.timeframe(tf)
                if tfs.tick_count == 0:
                    continue
                self._finish(state, tfs, emitted, complete=True)
            # Reset so a later restart in the same process starts clean.
            for tf in TIMEFRAMES:
                tfs = state.timeframe(tf)
                tfs.tick_count = 0
                tfs.complete = False
                tfs.data_quality = DATA_QUALITY_UNAVAILABLE
        for doc in emitted:
            doc["date"] = date
        return len(emitted)

    def bind(self, states: dict[str, Any]) -> None:
        """Attach the engine's live state map so candles can be force-closed."""
        self._bound = states

    # ------------------------------------------------------------------ #
    def restore_symbol(self, state, candles: list[dict[str, Any]], now: float) -> int:
        """Rebuild in-progress buckets for one symbol from stored candles.

        ``candles`` are the most recent stored candles for the symbol across all
        timeframes (newest last). A bucket whose stored start is the CURRENT
        bucket is restored; older ones are only used to seed VWAP/continuity.
        Anything not present is simply absent — the bucket keeps
        ``data_quality = UNAVAILABLE`` and the caller marks the symbol INCOMPLETE.
        """
        restored = 0
        by_tf: dict[str, list[dict[str, Any]]] = {}
        for doc in candles:
            tf = str(doc.get("timeframe") or "")
            if tf in TIMEFRAMES:
                by_tf.setdefault(tf, []).append(doc)
        for tf, docs in by_tf.items():
            docs.sort(key=lambda d: d.get("bucketStartEpoch") or 0.0)
            current = docs[-1]
            start = epoch_seconds(current.get("bucketStartEpoch") or current.get("bucketStart"))
            if start is None or start != bucket_start(now, tf):
                # The stored candle is not the current bucket: the in-progress
                # window cannot be reconstructed. Mark it, never invent it.
                tfs = state.timeframe(tf)
                tfs.data_quality = DATA_QUALITY_INCOMPLETE
                tfs.mark_incomplete()
                self._recovered_incomplete += 1
                continue
            tfs = state.timeframe(tf)
            tfs.open = current.get("open")
            tfs.high = current.get("high")
            tfs.low = current.get("low")
            tfs.close = current.get("close")
            tfs.volume = current.get("volume")
            tfs.vwap = current.get("vwap")
            tfs.tick_count = int(current.get("tickCount") or 0)
            tfs.start_time = start
            tfs.end_time = epoch_seconds(current.get("bucketEnd"))
            tfs.data_quality = DATA_QUALITY_INCOMPLETE
            tfs.mark_incomplete()
            restored += 1
        return restored

    # ------------------------------------------------------------------ #
    def metrics(self) -> dict[str, Any]:
        with self._lock:
            tracked = len(self._completed)
        return {
            "candlesEmitted": self._candles_emitted,
            "rollovers": self._rollovers,
            "trackedSymbols": tracked,
            "recoveredIncomplete": self._recovered_incomplete,
            "lastCommitAt": self._last_commit_at or None,
            "timeframes": list(TIMEFRAMES),
        }

    def reset(self) -> None:
        with self._lock:
            self._completed.clear()
        self._candles_emitted = 0
        self._rollovers = 0
        self._recovered_incomplete = 0

    def stats(self) -> dict[str, Any]:
        """Operational counters for status/health (doc §24 monitoring)."""
        with self._lock:
            symbols = len(self._completed)
            history = sum(len(rows) for per_tf in self._completed.values() for rows in per_tf.values())
        return {
            "candlesEmitted": self._candles_emitted,
            "rollovers": self._rollovers,
            "symbolsWithHistory": symbols,
            "completedCandles": history,
            "recoveredIncomplete": self._recovered_incomplete,
            "lastCommitAt": self._last_commit_at or None,
            "timeframes": list(TIMEFRAMES),
        }

    def history(self, token: str, timeframe: str, limit: int = 10) -> list[dict[str, Any]]:
        """Recent completed candles for one symbol (REST/AI context)."""
        with self._lock:
            rows = list(self._completed.get(str(token), {}).get(timeframe, ()))
        return rows[-max(1, min(limit, 200)):]


class TimeframeCommitter:
    """Periodic committer that flushes buffered candles through the DB Writer.

    Candle documents are produced on the tick path but written in batches from
    this loop, so Mongo is never touched synchronously per tick (doc §10 / §24).
    """

    def __init__(self, engine: TimeframeEngine, sink=None, interval_seconds: float = 5.0, batch: int = 2000) -> None:
        self._engine = engine
        self._sink = sink
        self._interval = interval_seconds
        self._batch = batch
        self._queue: list[tuple[str, str, dict[str, Any]]] = []
        self._lock = threading.Lock()
        self._task: Optional[asyncio.Task] = None
        self._submitted = 0
        self._write_errors = 0
        self._last_error: Optional[str] = None
        self._max_queue = 0

    def set_sink(self, sink) -> None:
        """Register the write sink. The default is the DB Writer, which owns
        the buffered candle collections (doc §10) — Market Watch never writes
        to MongoDB itself."""
        self._sink = sink

    def default_sink(self):
        from services.db_writer_engine import db_writer_engine

        return db_writer_engine.buffer_candles

    def _resolve_sink(self):
        if self._sink is None:
            self._sink = self.default_sink()
        return self._sink

    def submit(self, token: str, timeframe: str, doc: dict[str, Any]) -> None:
        with self._lock:
            self._queue.append((token, timeframe, doc))
            if len(self._queue) > self._max_queue:
                self._max_queue = len(self._queue)
        self._engine._last_commit_at = time.time()

    def queue_depth(self) -> int:
        with self._lock:
            return len(self._queue)

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except Exception:
                pass
            self._task = None
        await self.flush()

    async def _loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(self._interval)
                await self.flush()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._write_errors += 1
                self._last_error = str(exc)
                logger.warning("[MARKET_WATCH_TF] commit loop error: %s", exc)

    async def flush(self) -> int:
        with self._lock:
            if not self._queue:
                return 0
            batch = self._queue[: self._batch]
            del self._queue[: len(batch)]
        try:
            docs = [doc for _, _, doc in batch]
            sink = self._resolve_sink()
            if sink is not None:
                result = sink(docs)
                if asyncio.iscoroutine(result):
                    await result
            self._submitted += len(docs)
            return len(docs)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._write_errors += 1
            self._last_error = str(exc)
            logger.warning("[MARKET_WATCH_TF] candle write failed (%d docs): %s", len(batch), exc)
            return 0

    def status(self) -> dict[str, Any]:
        with self._lock:
            depth = len(self._queue)
        return {
            "queueDepth": depth,
            "maxQueueDepth": self._max_queue,
            "submitted": self._submitted,
            "writeErrors": self._write_errors,
            "lastError": self._last_error,
            "intervalSeconds": self._interval,
            "batchSize": self._batch,
        }


timeframe_engine = TimeframeEngine()

__all__ = [
    "COMPLETED_HISTORY_PER_SYMBOL",
    "TimeframeCommitter",
    "TimeframeEngine",
    "bucket_start",
    "next_boundary",
    "timeframe_engine",
]
