"""
In-memory tick buffer with periodic bulk-write to MongoDB.

Replaces the Node.js tickBuffer.js â€” receives ticks directly from the
WebSocket manager (no HTTP hop), batches them, and flushes to MongoDB
via Motor's bulk_write with ordered=False for partial-success tolerance.

Tick-rate accounting uses a TRUE rolling window maintained on ingest
(not reset on read), so every consumer sees the same stable ticks/sec
regardless of polling frequency.
"""
from __future__ import annotations

import asyncio
import logging
import math
import os
import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Sequence
from pymongo import InsertOne

from config.settings import settings
from core.event_loop import get_loop
from database.connection import get_db
from services import pipeline_latency
from services.runtime_settings import rt_bool, rt_int, get_runtime_setting

logger = logging.getLogger("app")

# Ticks arrive from the Kotak SDK callback thread while the flush loop and
# SSE endpoints run on the app loop â€” every shared structure is guarded.
_buffer_lock = threading.Lock()

_buffer: deque[dict] = deque()
_recent: deque[dict] = deque(maxlen=200)
_listeners: list[asyncio.Queue] = []

# ---- Rolling rate window (maintained on add(), never mutated by readers) ----
ROLLING_WINDOW_SEC = max(1.0, float(os.getenv("TICK_RATE_WINDOW_SEC", "10")))
_tick_times: deque[float] = deque()          # monotonic ts per received tick
_write_events: deque[tuple[float, int]] = deque()  # (monotonic ts, inserted count)

# ---- Lifecycle event recording (throttled so steady-state ticks don't
# flood the audit trail, failures are always meaningful) ----
_EVENT_THROTTLE_SEC = 60.0
_event_last_at: dict[str, float] = {}

# ---- Realtime persistence publish (real Mongo write events to the frontend).
# Flush happens at most once a second in steady state, so publishing one frame
# per write batch keeps the analytics WebSocket page feeding live without
# flooding the system stream. Realtime frames carry the REAL wall-clock write
# timestamp — never a client-computed time.
_PUBLISH_THROTTLE_SEC = 1.2
_publish_last_at: dict[str, float] = {}

def _publish_pipeline_event(event: str, status: str, message: str, meta: dict, *, force: bool = False) -> None:
    """Broadcast a real tick-pipeline event onto the system SSE stream.

    The frame's ``timestamp`` is the backend's own wall-clock time of the Mongo
    write (or failure), so the frontend Mongo-ingestion card can show genuine
    persistence rows instead of guessing from the browser clock.
    """
    now = time.time()
    if not force and (now - _publish_last_at.get(event, 0.0)) < _PUBLISH_THROTTLE_SEC:
        return
    _publish_last_at[event] = now
    try:
        from datetime import datetime, timezone as _tz
        from services.state_store import get_state_store
        import asyncio as _aio
        frame = {
            "type": "pipeline_saved" if event == "TICK_SAVE_SUCCESS" else "pipeline_error",
            "event_type": event,
            "status": status,
            "message": message,
            "timestamp": datetime.now(_tz.utc).isoformat(),
            "meta": meta,
        }
        loop = get_loop()
        if loop is not None and loop.is_running():
            loop.call_soon_threadsafe(
                _aio.create_task, get_state_store().publish(frame)
            )
    except Exception:
        logger.debug("pipeline publish failed (non-fatal) for %s", event)


def _record_event(event: str, status: str, message: str, meta: dict, *, force: bool = False) -> None:
    now = time.time()
    if not force and (now - _event_last_at.get(event, 0.0)) < _EVENT_THROTTLE_SEC:
        return
    _event_last_at[event] = now
    try:
        from services.notification_center import emit_event as record_event
        record_event("pipeline", event, status, message, meta)
    except Exception:
        logger.debug("pipeline event not recorded: %s", event)
_symbol_last_seen: dict[str, float] = {}
_process_started_at = time.monotonic()

# ---- Per-IST-day subscribed-symbol set (feeds daily_summaries) ----
# Tracks every distinct symbol seen since the IST midnight rollover so the
# daily tick-storage history records the REAL subscribed-stock count without
# an extra MongoDB query on every flush (hot path stays allocation-cheap).
from core.timezones import IST
_day_key_ist: str | None = None
_day_symbols_ist: set[str] = set()


def _ist_today() -> str:
    """Current business date in Asia/Kolkata (YYYY-MM-DD)."""
    return datetime.now(IST).strftime("%Y-%m-%d")


def _track_day_symbol(symbol: str) -> None:
    """Record a symbol against today's IST date (call with _buffer_lock held)."""
    global _day_key_ist
    today = _ist_today()
    if _day_key_ist != today:
        _day_key_ist = today
        _day_symbols_ist.clear()
    _day_symbols_ist.add(symbol)


def today_symbol_count() -> int:
    """Distinct symbols seen since IST midnight (real subscribed count)."""
    with _buffer_lock:
        return len(_day_symbols_ist)

# Feed latency (ms): exchange `ts` inside each tick -> backend `receivedAt`.
# Real measurement from the live stream â€” never fabricated.
_latency_samples: deque[float] = deque(maxlen=500)

_total_received = 0
_total_written = 0
_total_errors = 0
# Ticks published to the live in-memory store. Tracked separately from
# ``_total_received`` (which counts ticks queued for MongoDB) so a disabled
# persistence category can never be mistaken for "no live market data".
_live_recorded = 0
_last_flush_at: float | None = None
_last_flush_duration_ms: float | None = None
_last_error: str | None = None

_last_tick_at: float | None = None
_last_write_at: float | None = None

_flush_task: asyncio.Task | None = None
_stopping = False
_latest_ticks: dict[str, dict] = {}

# --------------------------------------------------------------------------- #
# Real per-token timestamped price history (fed ONLY by incoming WS ticks).
# --------------------------------------------------------------------------- #
# token -> deque[(monotonic_ts, wall_ts, ltp)]  (oldest first)
# The single central history used by momentum scanners (1m..60m). It is backed
# solely by real WebSocket ticks — never fabricated, never rounded guesses.
_PRICE_HISTORY_LOCK = threading.Lock()
_PRICE_HISTORY_MAX = 1200            # ~60min at a tick/sec, bounded per token
_PRICE_HISTORY_MIN_SPACING = 2.0     # seconds; >=1 snapshot per ~2s is plenty
_price_history: dict[str, deque[tuple[float, float, float]]] = {}

# ---- Pipeline lifecycle (REAL start/stop of the flush loop) ----
_pipeline_started_at: float | None = None
_pipeline_stopped_at: float | None = None
_pipeline_last_failed_write_at: float | None = None

# Hard cap on buffered ticks. Guards memory when MongoDB is down for a long
# stretch: once the soft flush trigger (buffer_max_size) alone is not enough,
# the OLDEST ticks are dropped (that is data never written â€” Mongo has been
# unavailable) and accounted as write errors, so the process cannot grow
# without bound. Historical on-disk tick data is never affected.
_BUFFER_HARD_CAP = max(50000, int(os.getenv("TICK_BUFFER_HARD_CAP", "100000")))

# Bounded REAL flush ledger: every actual MongoDB bulk write lands here with
# its own outcome (written / failed / duration), so the DB Writer surface can
# show per-flush history instead of lifetime totals alone. Bounded so a busy
# feed can never grow it; nothing is fabricated and an idle pipeline simply
# stays empty.
_FLUSH_HISTORY_MAXLEN = 25
_flush_history: deque[dict] = deque(maxlen=_FLUSH_HISTORY_MAXLEN)


def _record_flush_history(written: int, failed: int, batch: int, duration_ms: float, error: str | None = None) -> None:
    """Append one real flush outcome (called from the actual write path)."""
    try:
        _flush_history.append({
            "at": time.time(),
            "written": int(written),
            "failed": int(failed),
            "batch": int(batch),
            "durationMs": round(float(duration_ms), 2),
            "error": (str(error)[:300] if error else None),
            "bufferAfter": len(_buffer),
        })
    except Exception:
        pass


def flush_history() -> list[dict]:
    """Read the bounded flush ledger, most recent first (API/UI contract)."""
    with _buffer_lock:
        rows = list(_flush_history)
    return rows[::-1]


def _prune_window(now: float) -> None:
    cutoff = now - ROLLING_WINDOW_SEC
    while _tick_times and _tick_times[0] < cutoff:
        _tick_times.popleft()
    while _write_events and _write_events[0][0] < cutoff:
        _write_events.popleft()
    # Hard cap for the symbol map in case of pathological token churn.
    if len(_symbol_last_seen) > 4096:
        fresh = {k: v for k, v in _symbol_last_seen.items() if v > cutoff}
        _symbol_last_seen.clear()
        _symbol_last_seen.update(fresh)


def enqueue_for_storage(tick: dict) -> None:
    """Queue an accepted tick for the MongoDB write-behind flush.

    This is the PERSISTENCE half of :func:`add` and is the only part gated by a
    storage permission. Keeping it separate from :func:`record_latest` is what
    lets live quotes stay available while a persistence category is disabled.
    """
    global _total_received
    global _total_errors

    # Defensive memory bound: with MongoDB down, the flush loop cannot drain
    # the buffer. Drop the oldest ticks (never written anywhere) rather than
    # let memory grow for the whole session.
    with _buffer_lock:
        if len(_buffer) + 1 > _BUFFER_HARD_CAP:
            while _buffer and len(_buffer) > _BUFFER_HARD_CAP - r_bulk_insert():
                _buffer.popleft()
                _total_errors += 1
        _buffer.append(tick)
        _total_received += 1


def record_latest(tick: dict) -> dict:
    """Publish a live tick to the central in-memory latest-value store.

    This is the LIVE QUOTE path and is deliberately independent of every
    storage decision: a tick that is not persisted to MongoDB is still real,
    live market data and must stay visible to the UI. It merges into
    ``_latest_ticks``, feeds the real price history, the day-symbol set, the
    rolling-window metrics and the listener queues, and it NEVER enqueues a
    MongoDB write.

    Returns the merged document that was stored, so a caller that does go on to
    persist can enqueue exactly what was published.
    """
    global _last_tick_at
    global _live_recorded

    cache_key = str(
        tick.get("instrumentToken")
        or tick.get("instrument_token")
        or tick.get("token")
        or tick.get("tk")
        or tick.get("symbol")
        or tick.get("sym")
        or ""
    )

    with _buffer_lock:
        if cache_key:
            previous = _latest_ticks.get(cache_key, {})
            merged = previous.copy()
            for key, value in tick.items():
                if value is not None and value != "":
                    merged[key] = value
            _latest_ticks[cache_key] = merged
            tick = merged

        if "symbol" not in tick:
            sym_raw = tick.get("sym") or tick.get("symbol") or tick.get("trdSym") or ""
            if sym_raw:
                tick["symbol"] = sym_raw.split("-")[0] if "-" in str(sym_raw) else str(sym_raw)

        if "instrumentToken" not in tick:
            tok_raw = tick.get("tk") or tick.get("token") or tick.get("instrument_token") or ""
            if tok_raw:
                tick["instrumentToken"] = str(tok_raw)

        if "tradingSymbol" not in tick:
            trd = tick.get("trdSym") or tick.get("trading_symbol") or tick.get("tradingSymbol") or tick.get("sym") or ""
            if trd:
                tick["tradingSymbol"] = str(trd)

        _record_price_history(cache_key, tick)
        _live_recorded += 1

        # Feed latency: how long after the exchange timestamp the backend
        # actually received this tick (exchange -> backend delivery delay).
        ts_dt = tick.get("ts")
        received_at = tick.get("receivedAt")
        if isinstance(ts_dt, datetime) and ts_dt.tzinfo is not None and isinstance(received_at, datetime):
            try:
                latency_ms = (received_at - ts_dt).total_seconds() * 1000.0
                if latency_ms >= 0:
                    _latency_samples.append(latency_ms)
            except Exception:
                pass

        # Rolling-window bookkeeping
        now_mono = time.monotonic()
        _tick_times.append(now_mono)
        symbol = (
            tick.get("symbol")
            or tick.get("tradingSymbol")
            or tick.get("trading_symbol")
        )
        if symbol:
            _symbol_last_seen[str(symbol)] = now_mono
            _track_day_symbol(str(symbol))
        _last_tick_at = time.time()

        _recent.append(tick)

    _deliver_to_listeners(tick)
    return tick


def add(tick: dict) -> None:
    """Publish a tick live AND queue it for MongoDB persistence.

    Convenience wrapper for callers that want both halves. The DB Writer uses
    :func:`record_latest` + :func:`enqueue_for_storage` separately so the live
    store is updated even when the persistence decision is a drop.
    """
    enqueue_for_storage(record_latest(tick))


def _record_price_history(cache_key: str, tick: dict) -> None:
    """Append a real LTP snapshot to the token's central price history.

    Fed only from incoming WebSocket ticks, under its own lock. Does nothing
    when the tick has no usable LTP or no resolvable token.
    """
    ltp = tick.get("ltp")
    if ltp is None:
        return
    # CAS-imbalance and market-status messages are not price ticks; when they
    # are merged over a token's last-price state their (stale) ltp must not
    # pollute the momentum/price history.
    if tick.get("message_type") in ("cas_change", "market_status"):
        return
    try:
        ltp_f = float(ltp)
    except (TypeError, ValueError):
        return
    if not math.isfinite(ltp_f) or ltp_f <= 0:
        return
    key = str(cache_key)
    if not key:
        return
    now_mono = time.monotonic()
    now_wall = time.time()
    with _PRICE_HISTORY_LOCK:
        dq = _price_history.get(key)
        if dq is None:
            dq = _price_history[key] = deque()
        if dq and (now_mono - dq[-1][0]) < _PRICE_HISTORY_MIN_SPACING:
            dq[-1] = (now_mono, now_wall, ltp_f)
            return
        dq.append((now_mono, now_wall, ltp_f))
        cutoff = now_mono - 3600.0
        while dq and dq[0][0] < cutoff:
            dq.popleft()
        while len(dq) > _PRICE_HISTORY_MAX:
            dq.popleft()


def price_history_count() -> int:
    """Number of tokens currently holding a real WS-fed price history."""
    with _PRICE_HISTORY_LOCK:
        return sum(1 for dq in _price_history.values() if len(dq) >= 2)


def momentum_change_pct(token: str, current_ltp: float | None, window_sec: float) -> float | None:
    """% move between the first in-window WS price and the current LTP.

    A REAL measured move over ``window_sec`` from actual WebSocket ticks.
    Returns ``None`` (never a fabricated value) when the window is not full —
    i.e. no real tick is at least ``window_sec`` old.
    """
    if current_ltp is None:
        return None
    base = momentum_base_price(token, window_sec)
    if base is None:
        return None
    try:
        pct = ((current_ltp - base) / base) * 100.0
    except ZeroDivisionError:
        return None
    return round(pct, 4)


def momentum_base_price(token: str, window_sec: float) -> float | None:
    """First in-window WS price at least ``window_sec`` old, or ``None``.

    Only returns a value when the buffer truly holds a real tick at least
    ``window_sec`` old — a freshly running scanner is never falsely reported
    as a near-zero move.
    """
    now = time.monotonic()
    with _PRICE_HISTORY_LOCK:
        dq = _price_history.get(str(token))
        if not dq or len(dq) < 2:
            return None
        for ts, _wall, ltp in dq:
            if now - ts >= max(window_sec, 1.0):
                return ltp
    return None


MOMENTUM_WINDOWS_MIN: tuple[int, ...] = (1, 3, 5, 10, 15, 30, 60)


def momentum_windows(token: str, current_ltp: float | None) -> dict[str, float | None]:
    """All supported windowed % moves (1m/3m/5m/10m/15m/30m/60m) from real WS history.

    Equivalent to calling :func:`momentum_change_pct` per window, but resolves
    every window from a single lock acquisition. ``_price_history`` is ordered
    oldest\u2192newest, so the oldest tick always carries the largest age; a window
    is therefore measured against that tick when it is at least the window age,
    and is ``None`` otherwise. This is exactly what the per-window scan returned
    — it is O(1) instead of scanning the up-to-1200-point deque up to seven
    times on every tick.
    """
    out: dict[str, float | None] = {f"{m}m": None for m in MOMENTUM_WINDOWS_MIN}
    if current_ltp is None:
        return out
    now = time.monotonic()
    with _PRICE_HISTORY_LOCK:
        dq = _price_history.get(str(token))
        if not dq or len(dq) < 2:
            return out
        oldest_ts, _wall, base = dq[0]
        if not base or base <= 0:
            return out
        age = now - oldest_ts
        for mins in MOMENTUM_WINDOWS_MIN:
            if age >= max(float(mins) * 60.0, 1.0):
                out[f"{mins}m"] = round(((current_ltp - base) / base) * 100.0, 4)
    return out


def latest_history_summary() -> dict:
    """Debugging counts for the central price-history buffer."""
    with _PRICE_HISTORY_LOCK:
        tokens = len(_price_history)
        warm = sum(1 for dq in _price_history.values() if len(dq) >= 2)
        total_points = sum(len(dq) for dq in _price_history.values())
    return {"tokens": tokens, "warm": warm, "totalPoints": total_points}


#: Windows (seconds) the bulk windowed-move scanner exposes to scans.
SCAN_MOMENTUM_WINDOWS: tuple[float, ...] = (60.0, 300.0, 600.0)
_SCAN_WINDOW_LABELS: tuple[str, ...] = ("1m", "5m", "10m")


def seed_price_history(token: str, points: list[tuple[float, float]]) -> None:
    """Seed ``token``'s price history with ``(age_seconds, ltp)`` points.

    A TESTING and RECOVERY helper: ages are measured backwards from *now*
    (largest age = oldest point). Never called by the live tick path, so it
    cannot corrupt normal ingest; unit tests use it to pin the window maths
    without sleeping real time.
    """
    now_mono = time.monotonic()
    rows = sorted(((now_mono - age, time.time() - age, ltp) for age, ltp in points),
                  key=lambda r: r[0])
    with _PRICE_HISTORY_LOCK:
        deque_obj = _price_history.get(str(token))
        if deque_obj is None:
            deque_obj = deque(maxlen=_PRICE_HISTORY_MAX)
            _price_history[str(token)] = deque_obj
        else:
            deque_obj.clear()
        for row in rows:
            deque_obj.append(row)


def history_depth_seconds() -> float | None:
    """Oldest recorded WS-price age across warm tokens, or ``None``.

    Tells a scan how much real history exists — a fresh backend boot has
    ``None`` until the first two ticks of some instrument land, and windows
    longer than this depth honestly report no measurement yet.
    """
    now_mono = time.monotonic()
    with _PRICE_HISTORY_LOCK:
        deepest = None
        for pts in _price_history.values():
            if len(pts) < 2:
                continue
            age = now_mono - pts[0][0]
            if deepest is None or age > deepest:
                deepest = age
        return deepest


def window_moves(windows: Sequence[float] = SCAN_MOMENTUM_WINDOWS,
                 tokens: Sequence[str] | None = None) -> dict[str, dict[str, dict]]:
    """Bulk real windowed price moves for many tokens in ONE locking pass.

    Semantics are the honest "change over the last ``w`` seconds": the base
    price is the NEWEST recorded tick whose age is at least ``w`` (walking
    back from the newest point, the first point crossing the window's
    boundary). This is the true "price ``w`` ago" — unlike a naive scan of
    the oldest point, which would report a since-boot drift for every short
    window once history exceeds the window.

    Returns ``{token: {label: {pct, chg, base, baseAgeSec}}}`` where every
    absent window key means "not measurable yet" (history shorter than the
    window — never a fabricated near-zero move). Percentages round to 4dp;
    when the current LTP is unparseable the token is left out entirely.
    """
    out: dict[str, dict[str, dict]] = {}
    now_mono = time.monotonic()
    limits = [max(float(w), 1.0) for w in windows]
    # UI contract labels for the standard scan windows (1m/5m/10m); for any
    # non-standard window count fall back to a generic index label.
    labels: list[str] = []
    for idx, _lim in enumerate(limits):
        labels.append(("1m", "5m", "10m")[idx] if idx < 3 else f"w{idx}")
    wanted = {str(t) for t in tokens} if tokens else None
    with _PRICE_HISTORY_LOCK:
        for token, pts in _price_history.items():
            if wanted is not None and token not in wanted:
                continue
            if len(pts) < 2:
                continue
            current = pts[-1][2]
            try:
                cur = float(current)
            except (TypeError, ValueError):
                continue
            if not math.isfinite(cur) or cur <= 0:
                continue
            found: dict[str, dict] = {}
            missing = len(limits)
            # Walk backwards (newest → oldest): ages grow, so the FIRST point
            # whose age crosses each window boundary is exactly "price w ago".
            for ts, _wall, ltp in reversed(pts):
                if missing == 0:
                    break
                age = now_mono - ts
                for idx, lim in enumerate(limits):
                    key = labels[idx]
                    if key in found:
                        continue
                    if age >= lim:
                        try:
                            base = float(ltp)
                        except (TypeError, ValueError):
                            base = None  # type: ignore[assignment]
                        if base is None or not math.isfinite(base) or base <= 0:
                            continue
                        pct = round(((cur - base) / base) * 100.0, 4)
                        found[key] = {
                            "pct": pct,
                            "chgRaw": round(cur - base, 4),
                            "base": base,
                            "baseAgeSec": round(age, 1),
                        }
                        missing -= 1
            if found:
                out[token] = found
    return out


def _deliver_to_listeners(tick: dict) -> None:
    """Push a tick to every SSE listener on the event loop (thread-safe)."""
    try:
        loop = get_loop()
    except Exception:
        loop = None
    if loop is None or not loop.is_running():
        return
    try:
        loop.call_soon_threadsafe(_dispatch, tick)
    except Exception:
        pass


def _dispatch(tick: dict) -> None:
    with _buffer_lock:
        listeners = list(_listeners)
    for q in listeners:
        try:
            q.put_nowait(tick)
        except asyncio.QueueFull:
            pass


def add_listener() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=500)
    with _buffer_lock:
        _listeners.append(q)
    return q


def remove_listener(q: asyncio.Queue) -> None:
    with _buffer_lock:
        if q in _listeners:
            _listeners.remove(q)


def get_recent(limit: int = 200) -> list[dict]:
    with _buffer_lock:
        return list(_recent)[-limit:]


def get_latest_ticks() -> dict[str, dict]:
    """Snapshot of the central per-token latest-tick store (merged WS ticks)."""
    with _buffer_lock:
        return dict(_latest_ticks)


def latest_ltp(token: str) -> float | None:
    """Most recent real LTP for ``token`` from the central latest-tick store.

    Returns ``None`` when no live tick has been received for the token, letting
    callers (e.g. the market-watch price-eligibility pre-filter) decide how to
    treat unknown-price instruments rather than guessing.
    """
    with _buffer_lock:
        latest = _latest_ticks.get(str(token))
    if not latest:
        return None
    try:
        ltp = float(latest.get("ltp"))
    except (TypeError, ValueError):
        return None
    return ltp if math.isfinite(ltp) and ltp > 0 else None


def latest_tick_age_seconds(token: str) -> float | None:
    """Age (sec) of the most recent real WS tick for ``token``, or ``None``."""
    with _buffer_lock:
        latest = _latest_ticks.get(str(token))
    if not latest:
        return None
    received = latest.get("receivedAt")
    if isinstance(received, int) or isinstance(received, float):
        return max(0.0, time.time() - received)
    if received is not None:
        try:
            delta = (datetime.now(timezone.utc) - received).total_seconds()
            return max(0.0, delta)
        except Exception:
            pass
    return None


def stats() -> dict:
    """Read-only snapshot of buffer + rolling-rate metrics.

    Never mutates the rate window, so concurrent consumers (dashboard,
    data center, monitoring) all observe the same ticks/sec figure.
    """
    now = time.monotonic()
    with _buffer_lock:
        _prune_window(now)

        elapsed = min(max(now - _process_started_at, 0.001), ROLLING_WINDOW_SEC)
        window_ticks = len(_tick_times)
        window_written = sum(count for _, count in _write_events)

        ticks_per_second = window_ticks / elapsed
        writes_per_second = window_written / elapsed

        # Trend: compare the recent half of the window against the older half.
        mid = now - (ROLLING_WINDOW_SEC / 2.0)
        recent_half = sum(1 for t in _tick_times if t >= mid)
        older_half = window_ticks - recent_half
        if older_half == 0:
            trend = "rising" if recent_half > 0 else "stable"
        else:
            ratio = recent_half / older_half
            if ratio >= 1.25:
                trend = "rising"
            elif ratio <= 0.8:
                trend = "falling"
            else:
                trend = "stable"

        cutoff = now - ROLLING_WINDOW_SEC
        active_symbols = sum(1 for ts in _symbol_last_seen.values() if ts > cutoff)

        # Feed latency aggregates for the current process/session.
        latency = None
        if _latency_samples:
            latency = {
                "currentMs": round(_latency_samples[-1], 2),
                "avgMs": round(sum(_latency_samples) / len(_latency_samples), 2),
                "minMs": round(min(_latency_samples), 2),
                "maxMs": round(max(_latency_samples), 2),
                "samples": len(_latency_samples),
            }

        snapshot = {
            "bufferLength": len(_buffer),

            # Lifetime totals
            "totalReceived": _total_received,
            "totalWritten": _total_written,
            "totalWriteErrors": _total_errors,

            # Live store (independent of the MongoDB persistence categories):
            # how many ticks were published to memory and how many distinct
            # instruments are currently held.
            "liveTicksRecorded": _live_recorded,
            "latestTickCount": len(_latest_ticks),

            # Rolling live activity (true window, stable across readers)
            "ticksPerSecond": round(ticks_per_second, 2),
            "writesPerSecond": round(writes_per_second, 2),
            "tickRateTrend": trend,
            "rollingWindowSec": ROLLING_WINDOW_SEC,
            "windowTickCount": window_ticks,
            "activeTickStocks": active_symbols,

            # Buffer capacity from server config (no client-side hard-coding).
            # Reads live from the settings bridge so the UI reflects the real
            # configured capacity, including in-session edits.
            "bufferMaxSize": r_buffer_max(),
            "bulkInsertSize": r_bulk_insert(),

            "lastTickAt": _last_tick_at,
            "lastWriteAt": _last_write_at,

            "lastFlushAt": _last_flush_at,
            "lastFlushDurationMs": _last_flush_duration_ms,
            "lastError": _last_error,

            # Pipeline lifecycle (real flush-loop start/stop).
            "pipelineRunning": _flush_task is not None and not _flush_task.done(),
            "pipelineStartedAt": _pipeline_started_at,
            "pipelineStoppedAt": _pipeline_stopped_at,
            "pipelineUptimeSeconds": (
                round(time.time() - _pipeline_started_at, 1)
                if _pipeline_started_at is not None and (_flush_task is not None and not _flush_task.done())
                else None
            ),
            "lastFailedWriteAt": _pipeline_last_failed_write_at,

            # Real feed latency measurement (only when ticks actually flowed).
            "feedLatencyMs": latency,
        }
    return snapshot
async def start() -> None:
    global _flush_task, _stopping, _pipeline_started_at, _pipeline_stopped_at
    if _flush_task is not None and not _flush_task.done():
        return  # already running (no duplicate flush loops on re-login)
    if not rt_bool("ds_collection_enabled", True):
        logger.info("Tick buffer start skipped: data collection is disabled")
        return
    _stopping = False
    _pipeline_started_at = time.time()
    _pipeline_stopped_at = None
    interval = max(r_flush_interval_ms() / 1000.0, 0.2)
    _flush_task = asyncio.create_task(_flush_loop(interval))
    import os as _os
    logger.info("[TICK-BUFFER] instance=%s started (flush every %.1fs)", _os.getpid(), interval)
    _record_event(
        "PIPELINE_STARTED", "info", "Tick pipeline started",
        {"reason": "started", "reason_code": "pipeline_started", "component": "tick_buffer",
         "details": f"flush every {interval:.1f}s, max batch {r_bulk_insert()}"},
        force=True,
    )


async def stop() -> None:
    global _flush_task, _stopping, _pipeline_stopped_at
    _stopping = True
    if _flush_task:
        _flush_task.cancel()
        try:
            await _flush_task
        except asyncio.CancelledError:
            pass
        _flush_task = None
    await _flush_all()
    _pipeline_stopped_at = time.time()
    logger.info("Tick buffer stopped (final flush done)")
    _record_event(
        "PIPELINE_STOPPED", "info", "Tick pipeline stopped (final flush done)",
        {"reason": "stopped", "reason_code": "pipeline_stopped", "component": "tick_buffer"},
        force=True,
    )


async def flush() -> int:
    """Manually drain the buffered ticks into MongoDB (config/test use).

    Returns the number of ticks written by this flush. Refuses to run while
    the pipeline is stopping so an in-flight shutdown is never perturbed.
    """
    if _stopping:
        return 0
    before = _total_written
    await _flush_all()
    return _total_written - before


def r_flush_interval_ms() -> int:
    """Live flush interval from the settings bridge (fallback: env config)."""
    return rt_int("flush_interval_ms", settings.buffer_flush_interval_ms)


def r_buffer_max() -> int:
    """Live buffer capacity (fallback: env config)."""
    return rt_int("buffer_size", settings.buffer_max_size)


def r_bulk_insert() -> int:
    """Live bulk insert batch size (fallback: env config)."""
    return rt_int("bulk_insert_size", settings.bulk_insert_size)


async def _flush_loop(interval: float) -> None:
    while not _stopping:
        await asyncio.sleep(interval)
        # Re-read live knobs every iteration so in-session edits apply.
        current_interval = max(r_flush_interval_ms() / 1000.0, 0.2)
        if current_interval != interval:
            interval = current_interval
        if len(_buffer) >= r_buffer_max():
            await _flush_all()
        else:
            await _flush_batch(r_bulk_insert())


async def _flush_batch(max_size: int) -> None:
    batch = _pop_batch(max_size)
    if not batch:
        return
    await _write_batch(batch)


async def _flush_all() -> None:
    while True:
        batch = _pop_batch(r_bulk_insert())
        if not batch:
            return
        await _write_batch(batch)


def _pop_batch(max_size: int) -> list[dict]:
    with _buffer_lock:
        batch = []
        while _buffer and len(batch) < max_size:
            batch.append(_buffer.popleft())
        return batch


async def _write_batch(batch: list[dict]) -> None:
    global _total_written
    global _total_errors
    global _last_flush_at
    global _last_flush_duration_ms
    global _last_error
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

        # True WS-receive -> MongoDB-write latency (G), measured on the backend
        # clock from each document's own receive stamp. Includes buffer queue
        # wait + flush interval, which is exactly what persistence costs.
        write_done = datetime.now(timezone.utc)
        for doc in docs:
            received = doc.get("receivedAt")
            if isinstance(received, datetime):
                try:
                    pipeline_latency.record(
                        "ws_recv_to_mongo", (write_done - received).total_seconds()
                    )
                except Exception:
                    pass

        with _buffer_lock:
            _total_written += written

        # Rolling-window MongoDB write metrics
        if written > 0:
            with _buffer_lock:
                _write_events.append((time.monotonic(), written))
            _last_write_at = time.time()

        errors = len(ops) - written
        if errors > 0:
            with _buffer_lock:
                _total_errors += errors
            _pipeline_last_failed_write_at = time.time()
        flush_ms = round((time.monotonic() - start_ms) * 1000, 2)
        if written > 0:
            _record_event(
                "TICK_SAVE_SUCCESS", "info", f"Saved {written} ticks",
                {"reason": "saved", "reason_code": "db_write", "component": "tick_buffer",
                 "details": f"written={written}, batch={len(batch)}, errors={errors}",
                 "duration": flush_ms},
            )
            _publish_pipeline_event(
                "TICK_SAVE_SUCCESS", "ok", f"Saved {written} ticks",
                {"written": written, "batch": len(batch), "errors": errors,
                 "durationMs": flush_ms, "totalWritten": _total_written,
                 "totalErrors": _total_errors},
            )
        if errors > 0:
            _record_event(
                "TICK_SAVE_FAILURE", "warning", f"Partial tick save failure ({errors} of {len(batch)})",
                {"reason": "partial_write", "reason_code": "db_write_error", "component": "tick_buffer",
                 "details": f"written={written}, failed={errors} of {len(batch)}",
                 "duration": flush_ms},
                force=True,
            )
            _publish_pipeline_event(
                "TICK_SAVE_FAILURE", "warning", f"Partial tick save failure ({errors} of {len(batch)})",
                {"written": written, "failed": errors, "batch": len(batch),
                 "durationMs": flush_ms, "totalWritten": _total_written,
                 "totalErrors": _total_errors},
                force=True,
            )
    except Exception as exc:
        with _buffer_lock:
            _total_errors += len(batch)
            _last_error = str(exc)
        _pipeline_last_failed_write_at = time.time()
        _record_event(
            "TICK_SAVE_FAILURE", "error", f"Tick bulk write failed ({len(batch)} ticks)",
            {"reason": "db_unavailable", "reason_code": "db_write_error", "component": "tick_buffer",
             "details": f"failed={len(batch)}, error={str(exc)[:400]}"},
            force=True,
        )
        _publish_pipeline_event(
            "TICK_SAVE_FAILURE", "error", f"Tick bulk write failed ({len(batch)} ticks)",
            {"failed": len(batch), "error": str(exc)[:400], "totalWritten": _total_written,
             "totalErrors": _total_errors},
            force=True,
        )
        # Do NOT re-queue the batch. Re-queuing here makes _flush_all()
        # retry the same batch forever while MongoDB is down (the batch is
        # popped again on the next loop iteration), which blocks the flush
        # task and grows memory without bound. The failed ticks are counted
        # as write errors; real historical data is never touched.
        logger.error("Tick bulk write failed (%d ticks): %s", len(batch), exc)
        _record_flush_history(0, len(batch), len(batch), (time.monotonic() - start_ms) * 1000.0, str(exc))
        return

    _last_flush_at = time.time()
    _last_flush_duration_ms = round((time.monotonic() - start_ms) * 1000, 2)
    _record_flush_history(written, errors, len(batch), _last_flush_duration_ms)

    # Business date is IST (Asia/Kolkata trading day), matching the Data Center
    # history windows. Legacy UTC-keyed docs stay readable; new writes are IST.
    today = _ist_today()
    try:
        subscribed = today_symbol_count()
        await db.daily_summaries.update_one(
            {"date": today},
            {
                "$inc": {"totalTicks": len(batch), "totalWrites": written},
                "$setOnInsert": {"date": today},
                "$set": {"updatedAt": datetime.now(timezone.utc),
                         "subscribedStocks": subscribed},
            },
            upsert=True,
        )
    except Exception as exc:
        logger.error("Daily summary update failed: %s", exc)

