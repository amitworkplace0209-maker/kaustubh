"""Buffered persistence for Market Watch documents — owned by the DB Writer.

docs/engines/MARKET_WATCH.md §10, §21, §24 and Phase 22/23.

Why this lives here: the specification forbids Market Watch from writing to
MongoDB directly ("all writes go through the DB Writer's buffered writes") and
forbids a second database pipeline. So this module is a *generic, per-collection
document buffer* used by the existing ``DBWriterEngine``:

    Market Watch engine -> market_watch_doc_buffer.add(collection, docs)
                         -> (DB Writer owns start/stop/flush)
                         -> MongoDB upsert/insert

Design rules:
* Documents are produced on the tick path, written in batches from one flush
  loop — Mongo is never touched synchronously per tick.
* Idempotent collections (candles, decisions, daily report) are written with
  ``ReplaceOne(upsert=True)`` keyed by a deterministic ``_id``, so a restart or
  a duplicate flush can never create a second row for the same candle/decision.
* ``market_ticks`` is append-only: every real tick is preserved with
  ``InsertOne``.
* Failures are counted, never re-queued (a poisoned batch must not block the
  loop), and never fabricate data.
* Every collection has an enable gate (``set_enabled``) wired to the operator
  on/off switches in ``market_watch_config`` (doc §23). A disabled collection
  accepts nothing, drains nothing, and its already-buffered backlog is dropped
  rather than written — so "off" means off, including for the documents that
  were buffered microseconds before the switch flipped.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from collections import deque
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger("app.market_watch_doc_buffer")

#: Collection -> (idempotent?, hard buffer cap)
COLLECTIONS: dict[str, tuple[bool, int]] = {
    "market_ticks": (False, 60000),
    "market_candles_1m": (True, 8000),
    "market_candles_2m": (True, 8000),
    "market_candles_5m": (True, 8000),
    "market_candles_10m": (True, 6000),
    "market_candles_30m": (True, 4000),
    "market_watch_decisions": (True, 4000),
    "market_watch_daily_report": (True, 8),
    # doc §6/§31 — the weekly locked universe and its audit trail. Every write
    # is idempotent on ``_id`` (weekId), so a re-flush or restart can never
    # produce a second lock row for the same week. The universe document is the
    # ONE live LOCKED row, so it is upserted by ``_id`` too.
    "market_watch_universe": (True, 64),
    "market_watch_universe_history": (True, 512),
    "market_watch_review_decisions": (True, 20000),
    "market_watch_weekly_reports": (True, 104),
    # Per-symbol weekly cap-crossing counters that back the manual add/remove
    # review. Idempotent on `_id` = "<weekId>:<instrumentToken>", which every
    # writer must set — the buffer silently drops idempotent docs with no `_id`.
    "market_watch_weekly_crossings": (True, 2000),
    # The weekly screen run itself (candidates, survivors, rejections with
    # reasons). One row per evidence-week -> target-week pair, idempotent on that
    # same compound `_id`, so re-running a scan overwrites the previous result
    # instead of stacking duplicates. Follows ``persist_decisions`` like the
    # other review records.
    "market_watch_weekly_screen": (True, 208),
}

_HARD_CAP = 120000
_BULK_SIZE_DEFAULT = 500
_FLUSH_INTERVAL_SEC = 3.0

_lock = threading.RLock()
_buffers: dict[str, deque[dict[str, Any]]] = {name: deque() for name in COLLECTIONS}
_counts: dict[str, int] = {name: 0 for name in COLLECTIONS}
#: Per-collection on/off gate, driven by the doc §23 storage switches. A
#: collection starts enabled; the resolved config decides the real value.
_enabled: dict[str, bool] = {name: True for name in COLLECTIONS}
_total_received = 0
_total_written = 0
_total_errors = 0
#: Documents dropped because their collection was switched off before the
#: flush loop could write them. Never silent — a switch is an operator action
#: and the loss must be visible in the status surface.
_total_gated_drops = 0
#: Documents skipped because an identical ``_id`` was already stored. These are
#: NOT errors: the tick is already persisted, so counting them as write failures
#: would report lost data that was in fact written.
_total_duplicate_skips = 0
#: Documents an idempotent collection could not store because they carried no
#: ``_id``. Unlike duplicate skips these are a REAL loss and must be visible.
_total_unidentifiable_drops = 0
_last_flush_at: Optional[float] = None
_last_write_at: Optional[float] = None
_last_error: Optional[str] = None
_pipeline_running = False
_pipeline_started_at: Optional[float] = None
_pipeline_stopped_at: Optional[float] = None
_task: Optional[asyncio.Task] = None
_stopping = False


def _capped() -> int:
    return _HARD_CAP


def _note_duplicate_skip(collection: str, count: int) -> None:
    """Record benign ``_id`` dedup skips (already-persisted ticks)."""
    global _total_duplicate_skips
    if count <= 0:
        return
    with _lock:
        _total_duplicate_skips += count
        total = _total_duplicate_skips
    # Rate-limited: duplicates are normal at tick rates, so never log each one.
    if total % 5000 < count:
        logger.info(
            "[MW-DOCS] %s: %d docs already stored under the same _id (skipped)",
            collection,
            total,
        )


def _note_unidentifiable(collection: str) -> None:
    """Count a document an idempotent collection could not store (no ``_id``).

    This is a REAL data loss, not a benign dedup, so it is reported loudly and
    counted separately in the storage snapshot.
    """
    global _total_unidentifiable_drops
    with _lock:
        _total_unidentifiable_drops += 1
        total = _total_unidentifiable_drops
    logger.error(
        "[MW-DOCS] %s: dropped a document with no _id (cannot upsert an "
        "idempotent collection). Total unidentifiable drops: %d — the producer "
        "must set a deterministic _id.",
        collection,
        total,
    )


def set_enabled(collection: str, enabled: bool) -> dict[str, Any]:
    """Switch one collection's persistence on or off. Never raises.

    Turning a collection OFF drops whatever is still buffered for it. Those
    documents were accepted while the switch was on, but writing them after the
    operator asked for "off" would make the control a lie; the loss is counted
    and reported instead. Turning it ON drops nothing.
    """
    global _total_gated_drops
    if collection not in COLLECTIONS:
        logger.warning("[MW-DOCS] set_enabled for unknown collection %s ignored", collection)
        return {"ok": False, "collection": collection, "reason": "unknown_collection"}
    dropped = 0
    with _lock:
        changed = _enabled[collection] != bool(enabled)
        _enabled[collection] = bool(enabled)
        if not _enabled[collection]:
            buf = _buffers[collection]
            dropped = len(buf)
            buf.clear()
            _total_gated_drops += dropped
    if changed:
        logger.info(
            "[MW-DOCS] persistence %s for %s (dropped %d buffered docs)",
            "ENABLED" if _enabled[collection] else "DISABLED",
            collection,
            dropped,
        )
    return {
        "ok": True,
        "collection": collection,
        "enabled": _enabled[collection],
        "changed": changed,
        "dropped": dropped,
    }


def enabled(collection: str) -> bool:
    with _lock:
        return _enabled.get(collection, True)


def is_enabled() -> bool:
    """True when at least one collection is still writing (i.e. the pipeline
    has a reason to run)."""
    with _lock:
        return any(_enabled.values())


def apply_storage_config(storage: Any) -> dict[str, bool]:
    """Reconcile every gate from a resolved ``StorageConfig`` (doc §23).

    Called on the tick path / lifecycle tick, so an operator flipping a switch
    needs no restart. ``persist_ticks`` owns ``market_ticks``; ``persist_candles``
    owns the four ``market_candles_*`` collections; ``persist_decisions`` owns
    the ledger and the daily report.
    """
    return {
        "market_ticks": set_enabled("market_ticks", bool(getattr(storage, "persist_ticks", True)))["enabled"],
        "market_candles_1m": set_enabled("market_candles_1m", bool(getattr(storage, "persist_candles", True)))["enabled"],
        "market_candles_2m": set_enabled("market_candles_2m", bool(getattr(storage, "persist_candles", True)))["enabled"],
        "market_candles_5m": set_enabled("market_candles_5m", bool(getattr(storage, "persist_candles", True)))["enabled"],
        "market_candles_10m": set_enabled("market_candles_10m", bool(getattr(storage, "persist_candles", True)))["enabled"],
        "market_candles_30m": set_enabled("market_candles_30m", bool(getattr(storage, "persist_candles", True)))["enabled"],
        "market_watch_decisions": set_enabled("market_watch_decisions", bool(getattr(storage, "persist_decisions", True)))["enabled"],
        "market_watch_daily_report": set_enabled("market_watch_daily_report", bool(getattr(storage, "persist_decisions", True)))["enabled"],
        # The weekly review record is durable operator state, not tick data: it
        # follows ``persist_decisions`` rather than a tick-rate switch, so a LOCK
        # can never be lost because a Market Watch tick switch is off.
        "market_watch_universe": set_enabled("market_watch_universe", bool(getattr(storage, "persist_decisions", True)))["enabled"],
        "market_watch_universe_history": set_enabled("market_watch_universe_history", bool(getattr(storage, "persist_decisions", True)))["enabled"],
        "market_watch_review_decisions": set_enabled("market_watch_review_decisions", bool(getattr(storage, "persist_decisions", True)))["enabled"],
        "market_watch_weekly_reports": set_enabled("market_watch_weekly_reports", bool(getattr(storage, "persist_decisions", True)))["enabled"],
        # Per-symbol weekly cap-crossing counters that back the manual
        # add/remove review. Same category as the other weekly review records:
        # durable operator state, not tick data — so it follows
        # ``persist_decisions``. A switch that is not listed here would keep its
        # default-enabled state and would never be reconciled by an operator
        # turning everything off.
        "market_watch_weekly_crossings": set_enabled("market_watch_weekly_crossings", bool(getattr(storage, "persist_decisions", True)))["enabled"],
        "market_watch_weekly_screen": set_enabled("market_watch_weekly_screen", bool(getattr(storage, "persist_decisions", True)))["enabled"],
    }


def add(collection: str, docs: Any) -> int:
    """Buffer one document or an iterable of documents. Never raises.

    Returns the number of documents accepted. A disabled collection accepts
    nothing. Over-cap buffers drop the OLDEST documents and count the loss,
    mirroring the tick pipeline's memory-safety policy: a slow database must
    not be able to exhaust the process.
    """
    if not docs:
        return 0
    if isinstance(docs, dict):
        docs = [docs]
    accepted = 0
    dropped = 0
    global _total_received
    with _lock:
        buf = _buffers.get(collection)
        if buf is None:
            # Unknown collection: ignore rather than create collections at random.
            logger.warning("[MW-DOCS] add to unknown collection %s ignored", collection)
            return 0
        if not _enabled.get(collection, True):
            # Switched off: refuse the document instead of buffering it.
            return 0
        cap = COLLECTIONS[collection][1]
        for doc in docs:
            if not isinstance(doc, dict):
                continue
            buf.append(doc)
            accepted += 1
            if len(buf) > cap:
                buf.popleft()
                dropped += 1
        _counts[collection] += accepted
        _total_received += accepted
    if dropped:
        logger.warning(
            "[MW-DOCS] %s buffer cap reached, dropped %d oldest documents", collection, dropped,
        )
    return accepted


def pending(collection: Optional[str] = None) -> int:
    with _lock:
        if collection:
            return len(_buffers.get(collection, ()))
        return sum(len(b) for b in _buffers.values())


def stats() -> dict[str, Any]:
    with _lock:
        return {
            "pipelineRunning": _pipeline_running,
            "pipelineStartedAt": _pipeline_started_at,
            "pipelineStoppedAt": _pipeline_stopped_at,
            "pendingTotal": sum(len(b) for b in _buffers.values()),
            "hardCap": _capped(),
            "totalReceived": _total_received,
            "totalWritten": _total_written,
            "totalWriteErrors": _total_errors,
            "totalGatedDrops": _total_gated_drops,
            "totalDuplicateSkips": _total_duplicate_skips,
            # Real loss: a document an idempotent collection could not store
            # because it carried no ``_id``. Must be 0 in a healthy engine.
            "totalUnidentifiableDrops": _total_unidentifiable_drops,
            "lastFlushAt": _last_flush_at,
            "lastWriteAt": _last_write_at,
            "lastError": _last_error,
            "byCollection": {
                name: {"pending": len(buf), "received": _counts[name], "enabled": _enabled[name]}
                for name, buf in _buffers.items()
            },
        }


# --------------------------------------------------------------------------- #
# Flush
# --------------------------------------------------------------------------- #
def _pop(collection: str, max_size: int) -> list[dict[str, Any]]:
    with _lock:
        buf = _buffers[collection]
        batch: list[dict[str, Any]] = []
        while buf and len(batch) < max_size:
            batch.append(buf.popleft())
        return batch


async def _write(collection: str, batch: list[dict[str, Any]]) -> int:
    """Write one batch. Idempotent collections upsert on ``_id``."""
    if not batch:
        return 0
    from pymongo import InsertOne, ReplaceOne
    from pymongo.errors import BulkWriteError

    from database.connection import get_db

    idempotent = COLLECTIONS[collection][0]
    if idempotent:
        ops: list[Any] = []
        for doc in batch:
            doc_id = doc.get("_id")
            if doc_id is None:
                # An idempotent collection has no safe write without a key, so
                # the document cannot be stored. Dropping it quietly is how the
                # whole review-decision audit trail went missing: count it and
                # say so instead, so the producer can be fixed rather than the
                # loss being discovered later (doc §21/§32).
                _note_unidentifiable(collection)
                continue
            ops.append(ReplaceOne({"_id": doc_id}, doc, upsert=True))
    else:
        ops = [InsertOne(dict(d)) for d in batch]

    if not ops:
        return 0

    db = get_db()
    if db is None:
        raise RuntimeError("database unavailable")
    try:
        result = await db[collection].bulk_write(ops, ordered=False)
    except BulkWriteError as exc:
        # ``market_ticks`` is append-only but every document carries a
        # deterministic ``_id`` of "<symbol>:<epoch_ms>". Two ticks for the
        # same symbol inside one millisecond collide, and with ordered=False
        # pymongo still RAISES the whole BulkWriteError - which used to mark
        # the entire 500-doc batch as failed and abandon the buffer even though
        # Mongo had already inserted the other ~470. A duplicate _id means an
        # identical tick is already stored, so it is a benign skip, not an
        # error: report the real inserted count and only surface non-dup keys.
        details = getattr(exc, "details", None) or {}
        write_errors = details.get("writeErrors") or []
        dupes = [e for e in write_errors if e.get("code") == 11000]
        other = [e for e in write_errors if e.get("code") != 11000]
        inserted = int(details.get("nInserted", 0) or 0)
        if other:
            # A genuine write failure (bad doc, validation, etc.) still counts.
            raise
        if dupes:
            _note_duplicate_skip(collection, len(dupes))
        return inserted
    matched = int(getattr(result, "matched_count", 0) or 0)  # noqa: F841 - diagnostics only
    upserted = int(getattr(result, "upserted_count", 0) or 0)
    modified = int(getattr(result, "modified_count", 0) or 0)
    inserted = int(getattr(result, "inserted_count", 0) or 0)
    if not idempotent:
        return inserted
    # A matched ReplaceOne reports BOTH ``matched`` and ``modified``/unchanged,
    # so counting ``matched`` here would double-count every existing document.
    return modified + upserted + inserted


async def _drain(max_size: int = _BULK_SIZE_DEFAULT) -> int:
    global _total_written, _last_write_at, _last_flush_at, _total_errors, _last_error
    written = 0
    for collection in list(COLLECTIONS.keys()):
        if not enabled(collection):
            # Switched off since the documents were buffered: they are dropped
            # by ``set_enabled``, so there is nothing legal left to write.
            continue
        while True:
            batch = _pop(collection, max_size)
            if not batch:
                break
            try:
                written += await _write(collection, batch)
            except Exception as exc:
                with _lock:
                    _total_errors += len(batch)
                    # A BulkWriteError embeds every offending document; storing
                    # or logging that verbatim floods the log (and the status
                    # payload) with thousands of lines per batch.
                    _last_error = f"{collection}: {type(exc).__name__}: {str(exc)[:300]}"
                logger.error(
                    "[MW-DOCS] write failed for %s (%d docs): %s: %s",
                    collection, len(batch), type(exc).__name__, str(exc)[:300],
                )
                break  # do not re-queue; counted as a write error
    if written:
        with _lock:
            _total_written += written
            _last_write_at = time.time()
            _last_flush_at = _last_write_at
    return written


async def flush(max_size: int = _BULK_SIZE_DEFAULT) -> int:
    """Drain every collection once (used on stop / manual flush / tests)."""
    return await _drain(max_size)


async def _flush_loop(interval: float) -> None:
    while not _stopping:
        try:
            await asyncio.sleep(interval)
            if pending() == 0:
                continue
            over_cap = pending() >= _capped() // 2
            await _drain(_BULK_SIZE_DEFAULT * 2 if over_cap else _BULK_SIZE_DEFAULT)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - defensive
            logger.error("[MW-DOCS] flush loop error: %s", exc)
            await asyncio.sleep(1.0)


async def start(interval: float = _FLUSH_INTERVAL_SEC, *, apply_config: bool = True) -> None:
    """Ensure the flush loop is running. Idempotent; never a second loop.

    ``apply_config=True`` (the DB Writer bootstrap path) reconciles the enable
    gates from the resolved config first, so the buffer is self-sufficient at
    boot. The caller passes ``apply_config=False`` when it has already applied
    authoritative gate values — re-resolving here would race the TTL cache and
    could undo the caller's change.
    """
    global _task, _pipeline_running, _pipeline_started_at, _pipeline_stopped_at, _stopping
    if _task is not None and not _task.done():
        return  # idempotent: never a second flush loop
    if apply_config:
        from services.market_watch_config import load as load_config

        try:
            apply_storage_config(load_config().storage)
        except Exception as exc:
            logger.warning("[MW-DOCS] start config check failed, continuing: %s", exc)
    if not is_enabled():
        logger.info("[MW-DOCS] start skipped: all Market Watch persistence is disabled")
        return
    _stopping = False
    _pipeline_started_at = time.time()
    _pipeline_stopped_at = None
    _pipeline_running = True
    _task = asyncio.create_task(_flush_loop(max(interval, 0.5)))
    logger.info("[MW-DOCS] document buffer started (flush every %.1fs)", max(interval, 0.5))


async def stop() -> None:
    global _task, _pipeline_running, _pipeline_stopped_at, _stopping
    _stopping = True
    if _task is not None:
        _task.cancel()
        try:
            await _task
        except (asyncio.CancelledError, Exception):
            pass
        _task = None
    try:
        await _drain()
    except Exception as exc:  # pragma: no cover - defensive
        logger.error("[MW-DOCS] final drain failed: %s", exc)
    _pipeline_running = False
    _pipeline_stopped_at = datetime.now(timezone.utc).isoformat()
    logger.info("[MW-DOCS] document buffer stopped (final drain done)")


def reset() -> None:
    """Test helper: clear buffers, counters and the enable gates."""
    global _total_received, _total_written, _total_errors, _last_error, _last_flush_at, _last_write_at
    global _total_duplicate_skips, _total_gated_drops
    with _lock:
        for buf in _buffers.values():
            buf.clear()
        for name in _counts:
            _counts[name] = 0
        for name in _enabled:
            _enabled[name] = True
        _total_received = 0
        _total_written = 0
        _total_errors = 0
        _total_gated_drops = 0
        _total_unidentifiable_drops = 0
        _last_error = None
        _last_flush_at = None
        _last_write_at = None


__all__ = [
    "COLLECTIONS", "add", "apply_storage_config", "enabled", "flush", "is_enabled",
    "pending", "reset", "set_enabled", "start", "stats", "stop",
]
