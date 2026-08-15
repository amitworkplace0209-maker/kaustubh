"""
In-memory tick buffer with periodic bulk-write to MongoDB.

Replaces the Node.js tickBuffer.js — receives ticks directly from the
WebSocket manager (no HTTP hop), batches them, and flushes to MongoDB
via Motor's bulk_write with ordered=False for partial-success tolerance.
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from datetime import datetime, timezone
from pymongo import InsertOne

from config.settings import settings
from database.connection import get_db

logger = logging.getLogger("app")

_buffer: deque[dict] = deque()
_recent: deque[dict] = deque(maxlen=200)
_listeners: list[asyncio.Queue] = []

_total_received = 0
_total_written = 0
_total_errors = 0
_last_flush_at: float | None = None
_last_flush_duration_ms: float | None = None
_last_error: str | None = None

# Live 1-second data-saving metrics
_window_started_at = time.monotonic()
_window_received = 0
_window_written = 0
_window_symbols: set[str] = set()

_last_tick_at: float | None = None
_last_write_at: float | None = None

_flush_task: asyncio.Task | None = None
_stopping = False
_latest_ticks: dict[str, dict] = {}

def add(tick: dict) -> None:
    global _total_received
    global _window_received
    global _window_symbols
    global _last_tick_at

    cache_key = str(
        tick.get("instrumentToken")
        or tick.get("instrument_token")
        or tick.get("token")
        or tick.get("symbol")
        or ""
    )

    if cache_key:
        previous = _latest_ticks.get(cache_key, {})

        merged = previous.copy()

        for key, value in tick.items():
            if value is not None and value != "":
                merged[key] = value

        _latest_ticks[cache_key] = merged
        tick = merged

    _buffer.append(tick)
    _total_received += 1

    # Live 1-second tick metrics
    _window_received += 1

    symbol = (
        tick.get("symbol")
        or tick.get("ts")
        or tick.get("tradingSymbol")
        or tick.get("trading_symbol")
    )

    if symbol:
        _window_symbols.add(str(symbol))

    _last_tick_at = time.time()

    _recent.append(tick)

    for q in _listeners:
        try:
            q.put_nowait(tick)
        except asyncio.QueueFull:
            pass


def add_listener() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=500)
    _listeners.append(q)
    return q


def remove_listener(q: asyncio.Queue) -> None:
    if q in _listeners:
        _listeners.remove(q)


def get_recent(limit: int = 200) -> list[dict]:
    return list(_recent)[-limit:]


def stats() -> dict:
    global _window_started_at
    global _window_received
    global _window_symbols
    global _window_written

    now = time.monotonic()
    elapsed = now - _window_started_at

    if elapsed <= 0:
        elapsed = 1.0

    ticks_per_second = _window_received / elapsed
    writes_per_second = _window_written / elapsed

    result = {
        "bufferLength": len(_buffer),

        # Lifetime totals
        "totalReceived": _total_received,
        "totalWritten": _total_written,
        "totalWriteErrors": _total_errors,

        # Current live activity
        "ticksPerSecond": round(ticks_per_second, 2),
        "writesPerSecond": round(writes_per_second, 2),
        "activeTickStocks": len(_window_symbols),

        "lastTickAt": _last_tick_at,
        "lastWriteAt": _last_write_at,

        "lastFlushAt": _last_flush_at,
        "lastFlushDurationMs": _last_flush_duration_ms,
        "lastError": _last_error,
    }

    # Start a fresh live window.
    _window_started_at = now
    _window_received = 0
    _window_written = 0
    _window_symbols = set()

    return result
async def start() -> None:
    global _flush_task, _stopping
    _stopping = False
    interval = settings.buffer_flush_interval_ms / 1000.0
    _flush_task = asyncio.create_task(_flush_loop(interval))
    logger.info("Tick buffer started (flush every %.1fs, max %d)", interval, settings.buffer_max_size)


async def stop() -> None:
    global _stopping
    _stopping = True
    if _flush_task:
        _flush_task.cancel()
        try:
            await _flush_task
        except asyncio.CancelledError:
            pass
    await _flush_all()
    logger.info("Tick buffer stopped (final flush done)")


async def _flush_loop(interval: float) -> None:
    while not _stopping:
        await asyncio.sleep(interval)
        if len(_buffer) >= settings.buffer_max_size:
            await _flush_all()
        else:
            await _flush_batch(settings.bulk_insert_size)


async def _flush_batch(max_size: int) -> None:
    if len(_buffer) == 0:
        return
    batch = []
    while _buffer and len(batch) < max_size:
        batch.append(_buffer.popleft())
    if not batch:
        return
    await _write_batch(batch)


async def _flush_all() -> None:
    while _buffer:
        batch = []
        while _buffer and len(batch) < settings.bulk_insert_size:
            batch.append(_buffer.popleft())
        if batch:
            await _write_batch(batch)


async def _write_batch(batch: list[dict]) -> None:
    global _total_written
    global _total_errors
    global _last_flush_at
    global _last_flush_duration_ms
    global _last_error
    global _window_written
    global _last_write_at
    if not batch:
        return

    start_ms = time.monotonic()
    db = get_db()

    # Preserve the complete Kotak SDK tick exactly as received.
    docs = [dict(t) for t in batch]
    ops = [InsertOne(d) for d in docs] 

    try:

       result = await db.ticks.bulk_write(ops, ordered=False)
       written = result.inserted_count

       _total_written += written

# Live 1-second MongoDB write metrics
       _window_written += written
       _last_write_at = time.time()
        
       errors = len(ops) - written
       if errors > 0:
            _total_errors += errors
    except Exception as exc:
        _total_errors += len(batch)
        _last_error = str(exc)
        logger.error("Tick bulk write failed (%d ticks): %s", len(batch), exc)
        _buffer.extendleft(reversed(batch))
        return

    _last_flush_at = time.time()
    _last_flush_duration_ms = round((time.monotonic() - start_ms) * 1000, 2)

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    try:
        await db.daily_summaries.update_one(
            {"date": today},
            {
                "$inc": {"totalTicks": len(batch), "totalWrites": written},
                "$setOnInsert": {"date": today},
                "$set": {"updatedAt": datetime.now(timezone.utc)},
            },
            upsert=True,
        )
    except Exception as exc:
        logger.error("Daily summary update failed: %s", exc)


def _normalize_tick(raw: dict) -> dict:
    ts = raw.get("ts") or raw.get("timestamp") or raw.get("fdtm")

    if isinstance(ts, str):
        try:
            if "/" in ts:
             ts = datetime.strptime(
                ts,
                "%d/%m/%Y %H:%M:%S"
            ).replace(tzinfo=timezone.utc)
            else:
             ts = datetime.fromisoformat(
                ts.replace("Z", "+00:00")
            )
        except ValueError:
         ts = datetime.now(timezone.utc)

    elif isinstance(ts, (int, float)):
     ts = datetime.fromtimestamp(
        ts / 1000,
        tz=timezone.utc
    )

    elif not isinstance(ts, datetime):
     ts = datetime.now(timezone.utc)
    
    return {
      "symbol": raw.get("symbol", ""),
        "instrumentToken": str(
    raw.get("instrumentToken")
    or raw.get("instrument_token")
    or raw.get("token")
    or raw.get("tk")
    or ""
),
        "exchangeSegment": raw.get("exchangeSegment", "nse_cm"),
        "ltp": _fnum(raw.get("ltp")),
        "open": _fnum(raw.get("op")),
        "high": _fnum(raw.get("h")),
        "low": _fnum(raw.get("lo")),
        "close": _fnum(raw.get("c")),
        "volume": _fnum(raw.get("v")),
        "ltq": _fnum(raw.get("ltq")),
        "tbq": _fnum(raw.get("tbq")),
        "tsq": _fnum(raw.get("tsq")),
        "bp": _fnum(raw.get("bp")),
        "sp": _fnum(raw.get("sp")),
        "bq": _fnum(raw.get("bq")),
        "bs": _fnum(raw.get("bs")),
        "averagePrice": _fnum(raw.get("averagePrice")),
        "change": _fnum(raw.get("change")),
        "changePercent": _fnum(raw.get("changePercent")),
        "oi": _fnum(raw.get("oi")),
        "ts": ts,
        "receivedAt": datetime.now(timezone.utc),
    }


def _fnum(v) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None

