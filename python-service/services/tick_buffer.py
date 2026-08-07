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

_flush_task: asyncio.Task | None = None
_stopping = False


def add(tick: dict) -> None:
    global _total_received
    _buffer.append(tick)
    _total_received += 1
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
    return {
        "bufferLength": len(_buffer),
        "totalReceived": _total_received,
        "totalWritten": _total_written,
        "totalWriteErrors": _total_errors,
        "lastFlushAt": _last_flush_at,
        "lastFlushDurationMs": _last_flush_duration_ms,
        "lastError": _last_error,
    }


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
    global _total_written, _total_errors, _last_flush_at, _last_flush_duration_ms, _last_error

    if not batch:
        return

    start_ms = time.monotonic()
    db = get_db()

    docs = [_normalize_tick(t) for t in batch]
    ops = [{"insert_one": {"document": d}} for d in docs]

    try:
        result = await db.ticks.bulk_write(ops, ordered=False)
        written = result.inserted_count
        _total_written += written
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
    ts = raw.get("ts") or raw.get("timestamp")
    if isinstance(ts, str):
        try:
            ts = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            ts = datetime.now(timezone.utc)
    elif isinstance(ts, (int, float)):
        ts = datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
    elif not isinstance(ts, datetime):
        ts = datetime.now(timezone.utc)

    return {
        "symbol": raw.get("symbol", ""),
        "instrumentToken": str(raw.get("instrumentToken") or raw.get("token") or ""),
        "exchangeSegment": raw.get("exchangeSegment", "nse_cm"),
        "ltp": _fnum(raw.get("ltp")),
        "open": _fnum(raw.get("open")),
        "high": _fnum(raw.get("high")),
        "low": _fnum(raw.get("low")),
        "close": _fnum(raw.get("close")),
        "volume": _fnum(raw.get("volume")),
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

