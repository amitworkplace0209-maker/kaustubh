"""Real-time tick analytics engine for the Data Saver Tick Analytics center.

This module is a PURE computation layer over the already-real, already-verified
state of the running system:

  * ``tick_buffer``  — in-memory rolling ticks, latest-tick store, per-token
                       price history, persistence counters.
  * ``ws_manager``   — broker SFeed lifecycle + message/tick diagnostics.
  * ``market_state_service`` + ``market_calendar`` — authoritative live/closed
                       decision.
  * MongoDB ``ticks`` collection — persisted tick history (clearly labelled
                       HISTORICAL when used for deep windows).

Nothing here fabricates data. Every metric is derived from actual observed
ticks / broker state; anything that cannot be measured is returned as ``null``
or flagged ``available: false`` with a reason. No random numbers, no seeds.

Timestamp semantics (canonical, UTC-based):
  * broker/exchange timestamp stored on the tick as ``ts`` (datetime, UTC).
  * backend arrival stored as ``receivedAt`` (datetime, UTC).
  * latency = receivedAt - ts (>=0 only).
  * API values are returned as epoch milliseconds + ISO UTC strings; the UI
    renders IST using Asia/Kolkata. Never "IST" appended to a UTC clock value.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Optional

from database.connection import get_db
from services import market_calendar
from services import tick_buffer

logger = logging.getLogger("tick_analytics")

# ── Live-vs-stale thresholds (real tick cadence on this feed is ~400ms) ──
FRESH_TICK_SEC = float(5.0)          # healthy LIVE feed
STALE_TICK_SEC = float(30.0)         # connected but no fresh ticks

# ── Indicator defaults (configurable via query param on symbol endpoint) ──
RSI_PERIOD = 14
ATR_PERIOD = 14
SMA_PERIODS = (5, 20)
EMA_PERIODS = (9, 21)

# ── Anomaly thresholds (all compared against REAL observed data) ──
RATE_SPIKE_RATIO = 2.0               # current 1m rate vs current 5s rate... (see code)
RATE_DROP_RATIO = 0.5
PRICE_JUMP_PCT = 0.5                 # single-tick |move| %
SPREAD_WIDEN_MULT = 3.0              # vs observed median spread
LATENCY_SPIKE_MS = 500.0
VOLUME_SPIKE_MULT = 3.0              # vs observed mean bucket volume
DUPLICATE_BURST_COUNT = 25

# ── Mongo index guard (idempotent) ───────────────────────────────────────────
# WARNING: this lock MUST be an asyncio.Lock. A threading.Lock held across an
# await (as historically) blocks the ENTIRE event loop while index creation is
# slow/unavailable, and the sync `with` acquire on the lock by every waiting
# coroutine wedges the whole server (requests hang -> frontend fetch aborts ->
# the status=0 / "This operation was aborted" cascade).
# The cooldown means a Mongo outage can never trigger a per-request retry storm.
_INDEX_LOCK = asyncio.Lock()
_indexes_ensured = False
_index_last_attempt = 0.0
INDEX_RETRY_COOLDOWN_SEC = 60.0
INDEX_CREATE_TIMEOUT_SEC = 5.0


async def ensure_tick_indexes() -> None:
    """Ensure the queries used by the analytics engine are indexed.

    (symbol, ts) covers the history/timeseries aggregation; called lazily and
    only once per process. The connection bootstrap already creates these
    indexes, so this is defensive only and is a fast no-op once ensured.

    Failure is non-fatal and rate-limited: on a Mongo outage we back off for
    INDEX_RETRY_COOLDOWN_SEC instead of hammering the DB on every request.
    """
    global _indexes_ensured, _index_last_attempt
    if _indexes_ensured:
        return
    now = time.monotonic()
    if now - _index_last_attempt < INDEX_RETRY_COOLDOWN_SEC:
        return
    async with _INDEX_LOCK:
        if _indexes_ensured:
            return
        _index_last_attempt = now
        try:
            db = get_db()
            async def _build():
                await db.ticks.create_index([("symbol", 1), ("ts", -1)], background=True)
                await db.ticks.create_index([("ts", -1)], background=True)
            await asyncio.wait_for(_build(), timeout=INDEX_CREATE_TIMEOUT_SEC)
            _indexes_ensured = True
        except Exception:
            logger.debug("tick index setup deferred/failed (non-fatal)", exc_info=True)


# --------------------------------------------------------------------------- #
# Numeric helpers
# --------------------------------------------------------------------------- #

def _fnum(v) -> Optional[float]:
    if v is None:
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


def _ts_ms(v) -> Optional[int]:
    """Normalize a broker/DB timestamp to epoch milliseconds."""
    if isinstance(v, datetime):
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        return int(v.timestamp() * 1000)
    if isinstance(v, (int, float)):
        return int(v)
    if isinstance(v, str):
        try:
            return int(datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            try:
                return int(float(v))
            except (TypeError, ValueError):
                return None
    return None


def _mean(vals) -> Optional[float]:
    if not vals:
        return None
    return sum(vals) / len(vals)


def _stdev(vals) -> Optional[float]:
    n = len(vals)
    if n < 2:
        return None
    m = sum(vals) / n
    return math.sqrt(sum((x - m) ** 2 for x in vals) / (n - 1))


def _percentile(vals, p: float) -> Optional[float]:
    if not vals:
        return None
    s = sorted(vals)
    k = (len(s) - 1) * p
    lo = int(math.floor(k))
    hi = int(math.ceil(k))
    if lo == hi:
        return s[lo]
    return s[lo] * (hi - k) + s[hi] * (k - lo)


def _log_returns(ltps: list[float]) -> list[float]:
    out: list[float] = []
    prev = None
    for p in ltps:
        if prev is not None and prev > 0 and p > 0 and p != prev:
            out.append(math.log(p / prev))
        prev = p
    return out


def _sma(vals: list[float], n: int) -> list[Optional[float]]:
    out: list[Optional[float]] = []
    run = 0.0
    for i, v in enumerate(vals):
        run += v
        if i >= n:
            run -= vals[i - n]
        out.append(run / n if i >= n - 1 else None)
    return out


def _ema(vals: list[float], n: int) -> list[Optional[float]]:
    out: list[Optional[float]] = []
    if n <= 0 or not vals:
        return out
    k = 2.0 / (n + 1.0)
    prev = None
    for v in vals:
        if prev is None:
            prev = v
        else:
            prev = v * k + prev * (1 - k)
        out.append(prev)
    return out


def _rsi(closes: list[float], period: int = RSI_PERIOD) -> Optional[float]:
    """Standard Wilder RSI. None when the sample is too small."""
    if len(closes) < period + 1:
        return None
    gains: deque[float] = deque()
    losses: deque[float] = deque()
    for i in range(1, len(closes)):
        diff = closes[i] - closes[i - 1]
        if diff >= 0:
            gains.append(diff)
            losses.append(0.0)
        else:
            gains.append(0.0)
            losses.append(-diff)
    if len(gains) < period:
        return None
    avg_g = sum(list(gains)[-period:]) / period
    avg_l = sum(list(losses)[-period:]) / period
    if avg_l == 0:
        return 100.0 if avg_g > 0 else 50.0
    rs = avg_g / avg_l
    return round(100.0 - 100.0 / (1.0 + rs), 2)


def _true_ranges(candles: list[dict]) -> list[float]:
    out: list[float] = []
    prev_close = None
    for c in candles:
        high = _fnum(c.get("high"))
        low = _fnum(c.get("low"))
        close = _fnum(c.get("close"))
        if high is None or low is None or close is None:
            continue
        tr = high - low
        if prev_close is not None:
            tr = max(tr, abs(high - prev_close), abs(low - prev_close))
        out.append(tr)
        prev_close = close
    return out


def _atr(candles: list[dict], period: int = ATR_PERIOD) -> Optional[float]:
    trs = _true_ranges(candles)
    if len(trs) < period:
        return None
    atr = sum(trs[:period]) / period
    for t in trs[period:]:
        atr = (atr * (period - 1) + t) / period
    return round(atr, 4)


# --------------------------------------------------------------------------- #
# Tick sources (REAL only)
# --------------------------------------------------------------------------- #

async def _recent_symbol_ticks(symbol: str, limit: int = 600) -> list[dict]:
    """Merge the in-memory recent buffer + most recent persisted ticks for a
    symbol into one time-ordered list (oldest first). Only real ticks."""
    symbol = str(symbol or "").strip().upper()
    if not symbol:
        return []
    seen: set[tuple] = set()
    merged: list[dict] = []

    for t in reversed(tick_buffer.get_recent(400)):
        if str(t.get("symbol") or "").upper() != symbol:
            continue
        _prune_fields(t)
        merged.append(t)

    try:
        db = get_db()
        cur = db.ticks.find({"symbol": symbol}).sort("ts", -1).limit(limit)
        docs = [d async for d in cur]
        for d in reversed(docs):
            d.pop("_id", None)
            _prune_fields(d)
            merged.append(d)
    except Exception:
        logger.debug("Mongo recent-tick fetch failed (falling back to buffer)", exc_info=True)

    unique: list[dict] = []
    for t in sorted(merged, key=lambda x: _ts_ms(x.get("ts")) or 0):
        from services.tick_field_resolver import get_quote_slice

        t = get_quote_slice(t)
        key = (str(t.get("instrumentToken") or ""), _ts_ms(t.get("ts")), t.get("ltp"), t.get("volume"))
        if key in seen:
            continue
        seen.add(key)
        unique.append(t)
    return unique[-(limit*2):]


def _prune_fields(t: dict) -> None:
    """Keep only JSON-safe serializable values for API transport."""
    for k, v in list(t.items()):
        if isinstance(v, datetime):
            t[k] = v.isoformat()


# --------------------------------------------------------------------------- #
# Live / freshness state — the ONLY source of truth for LIVE/STALE/OFFLINE
# --------------------------------------------------------------------------- #

def live_state() -> dict:
    from ws_socket.ws_manager import ws_manager

    now = time.time()
    now_ms = int(now * 1000)

    try:
        market_snap = market_state_service_get()
    except Exception:
        market_snap = {}

    try:
        cal = market_calendar.snapshot()
    except Exception:
        cal = {}

    ws = {}
    try:
        ws = ws_manager.status()
    except Exception:
        logger.debug("ws_manager.status failed", exc_info=True)

    buf = {}
    try:
        buf = tick_buffer.stats()
    except Exception:
        logger.debug("tick_buffer.stats failed", exc_info=True)

    connected = bool(ws.get("connected"))
    feed_state = str(ws.get("feed_state") or "NO_FEED")
    internet_ok = ws.get("internet_ok")
    network_ok = market_snap.get("network_ok", True)
    market_state_str = str(market_snap.get("market_state") or cal.get("market_status") or "UNKNOWN")

    # Real last-tick sources, canonical ISO (both IST & UTC offsets parse).
    ws_last_iso = ws.get("last_tick_at")                    # ISO UTC
    market_last_iso = market_snap.get("last_tick_at")       # ISO IST
    buffer_last_epoch = buf.get("lastTickAt")               # epoch SECONDS
    buffer_age = max(0.0, now - buffer_last_epoch) if buffer_last_epoch else None
    ws_age = ws.get("diagnostics", {}).get("seconds_since_last_tick")

    last_tick_iso = market_last_iso or ws_last_iso or (datetime.fromtimestamp(buffer_last_epoch, tz=timezone.utc).isoformat() if buffer_last_epoch else None)
    last_tick_age = ws_age if ws_age is not None else buffer_age
    if last_tick_age is None and market_last_iso:
        lt = _ts_ms(market_last_iso)
        last_tick_age = round((now_ms - lt) / 1000.0, 1) if lt else None

    closed_states = {
        "EXCHANGE_HOLIDAY", "WEEKEND", "SPECIAL_CLOSURE",
        "MARKET_CLOSED", "NO_TICKS_AFTER_CONFIRMATION",
    }
    closed = (
        market_state_str in closed_states
        or bool(cal.get("is_weekend") or cal.get("is_exchange_holiday") or cal.get("is_special_closure"))
        or (cal.get("market_status") == "CLOSED" and market_state_str in {"UNKNOWN", "MARKET_CLOSED"})
    )

    # Feed status — decided ONLY from the real sources above.
    if market_state_str == "NETWORK_OFFLINE":
        status = "OFFLINE"
    elif connected and not network_ok:
        status = "OFFLINE"
    elif not connected:
        status = "DISCONNECTED"
    elif closed:
        status = "MARKET_CLOSED"
    elif feed_state == "NO_FEED":
        status = "NO_LIVE_DATA"
    elif feed_state == "STALE" or (last_tick_age is not None and last_tick_age > STALE_TICK_SEC):
        status = "STALE"
    elif feed_state == "DEGRADED" or (last_tick_age is not None and last_tick_age > FRESH_TICK_SEC):
        status = "DEGRADED"
    else:
        status = "LIVE"

    live = status == "LIVE"

    ws_rates = ws.get("rates") or {}
    diagnostics = ws.get("diagnostics") or {}

    return {
        "feedStatus": status,
        "live": live,
        "marketState": market_state_str,
        "marketStatus": str(cal.get("market_status") or "UNKNOWN"),
        "marketSession": str(cal.get("market_session") or market_snap.get("market_session") or ""),
        "marketDate": (cal.get("market_date") or "")[:10],
        "dayClass": str(cal.get("day_class") or ""),
        "reasonCode": str(market_snap.get("reason_code") or ""),
        "reasonMessage": str(market_snap.get("reason_message") or ""),
        "isTradingDay": bool(cal.get("trading_day", market_snap.get("trading_day"))),
        "nextMarketOpen": cal.get("next_market_open"),
        "nextMarketClose": cal.get("next_market_close"),
        "confirmationWindowActive": bool(market_snap.get("confirmation_window_active")),
        "ticksReceivedInWindow": int(market_snap.get("ticks_received_in_window") or 0),
        "uniqueInstrumentsInWindow": int(market_snap.get("unique_instruments_with_ticks") or 0),
        "ws": {
            "connected": connected,
            "state": ws.get("state"),
            "lifecycle": ws.get("lifecycle_state"),
            "supervisor": ws.get("supervisor_state"),
            "feedState": feed_state,
            "subscribedCount": int(ws.get("subscription_count") or 0),
            "reconnectCount": int(ws.get("reconnect_count") or 0),
            "disconnectReason": ws.get("disconnect_reason"),
            "internetOk": internet_ok,
        },
        "tick": {
            "lastTickAt": last_tick_iso,
            "lastTickAtEpochMs": last_tick_iso and _ts_ms(last_tick_iso),
            "ageSec": round(last_tick_age, 1) if last_tick_age is not None else None,
            "freshThresholdSec": FRESH_TICK_SEC,
            "staleThresholdSec": STALE_TICK_SEC,
        },
        "rate": {
            "ticksPerSecond": _fnum(buf.get("ticksPerSecond")),
            "ticksPerSecondWs": _fnum(ws_rates.get("ticks_per_second")),
            "ticks5sAvg": _fnum(ws_rates.get("ticks_5s_average")),
            "ticks60sAvg": _fnum(ws_rates.get("ticks_60s_average")),
            "messagesPerSecond": _fnum(ws_rates.get("messages_per_second")),
            "messages60sAvg": _fnum(ws_rates.get("messages_60s_average")),
            "trend": buf.get("tickRateTrend"),
            "rollingWindowSec": buf.get("rollingWindowSec"),
        },
        "session": {
            "pipelineRunning": bool(buf.get("pipelineRunning")),
            "pipelineStartedAt": buf.get("pipelineStartedAt"),
            "totalReceived": int(buf.get("totalReceived") or 0),
            "totalWritten": int(buf.get("totalWritten") or 0),
            "activeInstruments": int(buf.get("activeTickStocks") or 0),
            "windowTickCount": int(buf.get("windowTickCount") or 0),
        },
        "qualityOverlay": _session_quality_overlay(ws, buf),
        "nowIsoUtc": datetime.now(timezone.utc).isoformat(),
        "source": "LIVE_BACKEND_STATE",
    }


def market_state_service_get() -> dict:
    from services.market_state import market_state_service
    return market_state_service.get_snapshot()


def _session_quality_overlay(ws: dict, buf: dict) -> dict:
    """Monitoring-style quality counters — real session diagnostics only."""
    diag = ws.get("diagnostics") or {}
    attempted = int(buf.get("totalWritten") or 0) + int(buf.get("totalWriteErrors") or 0)
    return {
        "messagesReceived": int(diag.get("total_messages_received") or 0),
        "validTicks": int(diag.get("total_ticks_valid") or 0),
        "rejectedTicks": int(diag.get("total_ticks_rejected") or 0),
        "malformed": int(diag.get("total_malformed") or 0),
        "heartbeats": int(diag.get("total_heartbeat") or 0),
        "marketStatusMessages": int(diag.get("total_market_status") or 0),
        "indexMessages": int(diag.get("total_index_messages") or 0),
        "subscriptionAcks": int(diag.get("total_subscription_acks") or 0),
        "parsingFailures": int(diag.get("total_ticks_rejected") or 0),
        "lastMessageType": str(diag.get("last_message_type") or ""),
        "secondsSinceLastMessage": diag.get("seconds_since_last_message"),
        "payloadLatencyMs": _latency_stats(buf.get("feedLatencyMs")),
        "persistenceSuccessRate": (
            round((int(buf.get("totalWritten") or 0) / attempted) * 100, 2) if attempted > 0 else None
        ),
        "persistenceAttempts": attempted,
        "persistenceFailures": int(buf.get("totalWriteErrors") or 0),
        "lastFlushAt": buf.get("lastFlushAt"),
        "lastError": buf.get("lastError"),
    }


def _latency_stats(lat: dict) -> Optional[dict]:
    if not lat:
        return None
    return {
        "currentMs": lat.get("currentMs"),
        "avgMs": lat.get("avgMs"),
        "minMs": lat.get("minMs"),
        "maxMs": lat.get("maxMs"),
        "samples": lat.get("samples"),
    }


# --------------------------------------------------------------------------- #
# Session / lifetime metrics
# --------------------------------------------------------------------------- #

def metrics() -> dict:
    from ws_socket.ws_manager import ws_manager
    st = {}
    ws = {}
    try:
        st = tick_buffer.stats()
    except Exception:
        logger.debug("tick_buffer.stats failed", exc_info=True)
    try:
        ws = ws_manager.status()
    except Exception:
        logger.debug("ws_manager.status failed", exc_info=True)

    attempted = int(st.get("totalWritten") or 0) + int(st.get("totalWriteErrors") or 0)
    latency = st.get("latency")
    return {
        "process": {
            "startedAt": st.get("pipelineStartedAt"),
            "uptimeSec": st.get("pipelineUptimeSeconds"),
            "pipelineRunning": bool(st.get("pipelineRunning")),
            "lastFlushAt": st.get("lastFlushAt"),
            "lastFlushDurationMs": st.get("lastFlushDurationMs"),
            "lastError": st.get("lastError"),
            "bufferLength": int(st.get("bufferLength") or 0),
            "bufferMaxSize": int(st.get("bufferMaxSize") or 0),
        },
        "ticks": {
            "received": int(st.get("totalReceived") or 0),
            "persisted": int(st.get("totalWritten") or 0),
            "persistFailures": int(st.get("totalWriteErrors") or 0),
            "successRate": round((int(st.get("totalWritten") or 0) / attempted) * 100, 2) if attempted > 0 else None,
            "attempted": attempted,
        },
        "throughput": {
            "ticksPerSecond": _fnum(st.get("ticksPerSecond")),
            "writesPerSecond": _fnum(st.get("writesPerSecond")),
            "trend": st.get("tickRateTrend"),
            "windowSec": st.get("rollingWindowSec"),
            "windowTickCount": int(st.get("windowTickCount") or 0),
            "activeInstruments": int(st.get("activeTickStocks") or 0),
        },
        "latency": latency,
        "ws": {
            "messagesReceived": int(ws.get("total_messages") or 0),
            "tickCount": int(ws.get("tick_count") or 0),
            "reconnects": int(ws.get("reconnect_count") or 0),
            "rates": ws.get("rates") or {},
            "diagnostics": ws.get("diagnostics") or {},
            "connectedAt": ws.get("connected_at"),
            "lastMessageAt": ws.get("last_message_at"),
        },
        "source": "LIVE_BACKEND_STATE",
    }


# --------------------------------------------------------------------------- #
# Per-second / rolling timeseries (short windows → real recent ticks)
# --------------------------------------------------------------------------- #

async def timeseries(symbol: str, range_sec: int = 300) -> dict:
    """Per-second buckets over the requested window from REAL ticks only."""
    await ensure_tick_indexes()
    range_sec = max(30, min(int(range_sec), 30 * 60))
    now_ms = int(time.time() * 1000)
    start = now_ms - range_sec * 1000

    ticks = [t for t in await __recent(symbol, 1500) if (_ts_ms(t.get("ts")) or 0) >= start]
    series = bucketize(ticks, step_sec=1, start=start, end=now_ms)

    counts = [b.get("tickCount", 0) for b in series]
    vols = [b.get("volumeDelta", 0) for b in series]
    rate_vals = [c / 1.0 for c in counts]

    return {
        "symbol": symbol.upper(),
        "rangeSec": range_sec,
        "startMs": start,
        "endMs": now_ms,
        "bucketStepSec": 1,
        "source": "MONGODB_LIVE_WINDOW" if _uses_persisted(symbol) else "LIVE_WINDOW",
        "buckets": series,
        "throughput": {
            "currentPerSec": _fnum(last(rate_vals)),
            "avg1m": _mean(rate_vals[-60:]) if len(rate_vals) >= 5 else None,
            "avg5m": _mean(rate_vals) if len(rate_vals) >= 5 else None,
            "sessionAvg": _mean(rate_vals) if len(rate_vals) >= 1 else None,
            "peak": max(rate_vals) if rate_vals else None,
            "peakAtMs": _peak_ts(series),
            "min": min(rate_vals) if rate_vals else None,
            "currentVsAvgPct": (
                round(((last(rate_vals) - _mean(rate_vals)) / _mean(rate_vals)) * 100, 2)
                if rate_vals and _mean(rate_vals) else None
            ),
            "trend": _rate_trend(rate_vals),
            "observations": len(rate_vals),
        },
        "volume": {
            "perMin": _mean(vols) * 60 if vols and _mean(vols) is not None else None,
            "per5m": sum(vols),
            "total": sum(vols),
            "observations": len([v for v in vols if v]),
        },
    }


def bucketize(ticks: list[dict], step_sec: float, start: int, end: int) -> list[dict]:
    """Group REAL ticks into seconds; volume = cumulative-volume DELTAS (the
    Kotak quote payload carries cumulative today-volume, so positive deltas
    approximate traded volume). Non-positive deltas never subtract."""
    step_ms = int(step_sec * 1000)
    buckets: dict[int, dict] = {}
    prev_vol: Optional[float] = None
    prev_sym: Optional[str] = None
    for t in ticks:
        ts = _ts_ms(t.get("ts"))
        if not ts:
            continue
        idx = int(ts // step_ms) * step_ms
        if idx < start or idx >= end:
            continue
        b = buckets.get(idx)
        if not b:
            b = {"startMs": idx, "tickCount": 0, "volume": 0.0, "volumeDelta": 0.0,
                 "sumLtp": 0.0, "firstLtp": None, "lastLtp": None, "high": None, "low": None,
                 "sumSpread": 0.0, "spreadN": 0, "sumBq": 0.0, "sumBs": 0.0,
                 "up": 0, "down": 0, "unchanged": 0, "dupCandidates": 0}
            buckets[idx] = b
        sym = str(t.get("symbol") or "")
        vol = _fnum(t.get("volume"))
        if prev_vol is not None and sym == prev_sym and vol is not None and vol >= prev_vol:
            d = vol - prev_vol
            if d > 0:
                b["volumeDelta"] += d
        prev_vol = vol if vol is not None else prev_vol
        prev_sym = sym if sym else prev_sym

        b["tickCount"] += 1
        ltp = _fnum(t.get("ltp"))
        if ltp is not None:
            b["sumLtp"] += ltp
            if b["firstLtp"] is None:
                b["firstLtp"] = ltp
            b["lastLtp"] = ltp
            b["high"] = ltp if b["high"] is None else max(b["high"], ltp)
            b["low"] = ltp if b["low"] is None else min(b["low"], ltp)
        bp = _fnum(t.get("bp")); sp = _fnum(t.get("sp"))
        if bp is not None and sp is not None and sp >= bp and bp >= 0:
            b["sumSpread"] += sp - bp
            b["spreadN"] += 1
        bq = _fnum(t.get("bq")); bs = _fnum(t.get("bs"))
        if bq is not None:
            b["sumBq"] += bq
        if bs is not None:
            b["sumBs"] += bs

    out = []
    prev_ltp = None
    for idx in sorted(buckets):
        b = buckets[idx]
        if b["lastLtp"] is not None:
            n = b["tickCount"]
            if prev_ltp is not None:
                if b["lastLtp"] > prev_ltp:
                    b["up"] = 1
                elif b["lastLtp"] < prev_ltp:
                    b["down"] = 1
                else:
                    b["unchanged"] = 1
            prev_ltp = b["lastLtp"]
        out.append({
            "startMs": idx,
            "tickCount": b["tickCount"],
            "volumeDelta": round(b["volumeDelta"], 4),
            "avgLtp": round(b["sumLtp"] / n, 4) if n else None,
            "firstLtp": _r4(b["firstLtp"]),
            "lastLtp": _r4(b["lastLtp"]),
            "high": _r4(b["high"]),
            "low": _r4(b["low"]),
            "spread": round(b["sumSpread"] / b["spreadN"], 4) if b["spreadN"] else None,
            "bidAskImbalance": round(b["sumBq"] / b["sumBs"], 4) if b["sumBs"] > 0 else None,
            "up": b["up"],
            "down": b["down"],
            "unchanged": b["unchanged"],
        })
    return out


def _r4(v) -> Optional[float]:
    return round(v, 4) if v is not None else None


def _uses_persisted(symbol: str) -> bool:
    """Whether the live window included Mongo rows (True) or only the in-memory
    recency buffer (False) — used for honest source labelling."""
    try:
        in_mem = [t for t in tick_buffer.get_recent(400) if str(t.get("symbol") or "").upper() == str(symbol or "").upper()]
        return len(in_mem) < 1
    except Exception:
        return True


async def __recent(symbol: str, limit: int) -> list[dict]:
    return await _recent_symbol_ticks(symbol, limit)


def last(vals):
    return vals[-1] if vals else None


def _peak_ts(buckets: list[dict]) -> Optional[int]:
    if not buckets:
        return None
    return max(buckets, key=lambda b: b.get("tickCount", 0)).get("startMs")


def _rate_trend(rate_vals: list[float]) -> Optional[str]:
    if len(rate_vals) < 2:
        return None
    half = len(rate_vals) // 2
    recent = rate_vals[half:]
    older = rate_vals[:half]
    ro = sum(older) / len(older) if older else 0
    rr = sum(recent) / len(recent) if recent else 0
    if ro <= 0:
        return "rising" if rr > 0 else "stable"
    ratio = rr / ro
    if ratio >= 1.25:
        return "rising"
    if ratio <= 0.8:
        return "falling"
    return "stable"


# --------------------------------------------------------------------------- #
# Deep history aggregation (persisted candles, clearly HISTORICAL)
# --------------------------------------------------------------------------- #

async def history(symbol: str, interval_sec: int = 300, from_ts: Optional[int] = None, to_ts: Optional[int] = None) -> dict:
    """Mongo aggregated OHLC candles for a past window. Every candle is built
    from REAL persisted ticks; empty buckets are simply absent."""
    await ensure_tick_indexes()
    symbol = str(symbol or "").strip().upper()
    if not symbol:
        return {"available": False, "reason": "SYMBOL_REQUIRED", "candles": []}
    interval_sec = max(1, min(int(interval_sec), 3600))
    to_ts = to_ts or int(time.time() * 1000)
    from_ts = from_ts or (to_ts - 86400 * 1000)
    step_ms = interval_sec * 1000

    dt_from = datetime.fromtimestamp(from_ts / 1000, tz=timezone.utc)
    dt_to = datetime.fromtimestamp(to_ts / 1000, tz=timezone.utc)

    try:
        db = get_db()
        pipe = [
            {"$match": {"symbol": symbol, "ts": {"$gte": dt_from, "$lt": dt_to}}},
            {"$sort": {"ts": 1}},
            {"$group": {
                "_id": {"$trunc": {"$divide": [{"$toLong": "$ts"}, step_ms]}},
                "open": {"$first": "$ltp"},
                "high": {"$max": "$ltp"},
                "low": {"$min": "$ltp"},
                "close": {"$last": "$ltp"},
                "tickCount": {"$sum": 1},
            }},
            {"$sort": {"_id": 1}},
        ]
        rows = [r async for r in db.ticks.aggregate(pipe, allowDiskUse=False)]
    except Exception:
        logger.exception("history aggregation failed")
        return {"available": False, "reason": "DB_ERROR", "candles": []}

    candles = []
    prev_close = None
    prev_vol = None
    prev_sym = None
    # volume deltas need per-candle cumulative first/last records → run a
    # second projection-based pass, bounded to the same filtered window.
    try:
        db2 = get_db()
        cur = db2.ticks.find(
            {"symbol": symbol, "ts": {"$gte": dt_from, "$lt": dt_to}},
            {"ts": 1, "volume": 1, "ltp": 1},
        ).sort("ts", 1)
        idx_to_vol = {}
        async for d in cur:
            ts_ms = _ts_ms(d.get("ts"))
            if not ts_ms:
                continue
            b = int(ts_ms // step_ms)
            v = _fnum(d.get("volume"))
            if v is not None:
                idx_to_vol[b] = v  # last cumulative wins
    except Exception:
        idx_to_vol = {}

    for r in rows:
        start_ms = int(r["_id"]) * step_ms
        o = _fnum(r.get("open")); h = _fnum(r.get("high")); l = _fnum(r.get("low")); c = _fnum(r.get("close"))
        if o is None or c is None:
            continue
        vol = idx_to_vol.get(int(r["_id"]))
        candles.append({
            "startMs": start_ms,
            "open": round(o, 4), "high": round(h, 4) if h else None,
            "low": round(l, 4) if l else None, "close": round(c, 4),
            "tickCount": int(r.get("tickCount") or 0),
            "volume": round(vol, 4) if vol is not None else None,
        })
        prev_close = c

    return {
        "symbol": symbol,
        "intervalSec": interval_sec,
        "fromMs": from_ts,
        "toMs": to_ts,
        "source": "MONGODB_HISTORICAL",
        "candles": candles,
        "available": True,
    }


# --------------------------------------------------------------------------- #
# Per-symbol analytics block
# --------------------------------------------------------------------------- #

async def symbol_analytics(symbol: str, rsi_period: int = RSI_PERIOD, atr_period: int = ATR_PERIOD) -> dict:
    await ensure_tick_indexes()
    symbol = str(symbol or "").strip().upper()
    if not symbol:
        return {"available": False, "reason": "SYMBOL_REQUIRED", "symbol": ""}
    ticks = await _recent_symbol_ticks(symbol, 800)
    if not ticks:
        return {
            "available": False, "reason": "NO_TICKS",
            "message": "No real ticks on record for this symbol in the recent window.",
            "symbol": symbol,
        }

    latest = ticks[-1]
    ltps = [ _fnum(t.get("ltp")) for t in ticks ]
    ltps = [x for x in ltps if x is not None and x > 0]
    closes = [ _fnum(t.get("close")) for t in ticks ]
    closes = [x for x in closes if x is not None and x > 0]
    if not ltps:
        return {"available": False, "reason": "NO_VALID_LTP", "symbol": symbol}

    ltp = ltps[-1]
    day_high = latest.get("high")
    day_low = latest.get("low")
    prev_close = latest.get("close")
    change = latest.get("change")
    change_pct = latest.get("changePercent")
    if change is None and prev_close and ltp:
        change = round(ltp - prev_close, 4)
    if change_pct is None and change is not None and prev_close:
        try:
            change_pct = round((change / prev_close) * 100, 4) if prev_close else None
        except ZeroDivisionError:
            change_pct = None

    # Depth (real quote fields)
    depth = _depth_from_tick(latest)

    # Tick direction from sequential real prices
    direction = _direction(ltps)

    # Duplicate candidates + out-of-order + timestamp anomalies (data-quality
    # identity rule: (instrumentToken, ts, ltp, volume, bp, sp))
    quality = _tick_quality(ticks)

    # Latency (exchange ts → receivedAt)
    latency = _latency_from_ticks(ticks)

    # Returns-based volatility
    rets = _log_returns(ltps)
    vol = _volatility(rets)

    # RSI / SMA / EMA on real close prices
    rsi = _rsi(closes, rsi_period)
    sma5 = None; sma20 = None; ema9 = None; ema21 = None
    if len(closes) >= 5:
        sma5 = _last_non_null(_sma(closes, 5))
    if len(closes) >= 20:
        sma20 = _last_non_null(_sma(closes, 20))
    if len(closes) >= 9:
        ema9 = _last_non_null(_ema(closes, 9))
    if len(closes) >= 21:
        ema21 = _last_non_null(_ema(closes, 21))

    # Candles → ATR (5m) if enough bars
    candles5m = build_candles(ticks, step_sec=300)
    atr = _atr(candles5m, atr_period) if len(candles5m) >= atr_period + 1 else None
    candles1m = build_candles(ticks, step_sec=60)

    # VWAP from cumulative-volume deltas (real, labelled)
    vwap, vol_delta_total = _vwap_from_ticks(ticks)

    # Momentum windows from the central live price history (real WS ticks)
    momentum = {}
    token = str(latest.get("instrumentToken") or "")
    try:
        momentum = tick_buffer.momentum_windows(token, ltp) if token else {}
    except Exception:
        momentum = {}

    # Trend — a DERIVED analytical state, never a recommendation.
    trend = _derive_trend(ltp, ema21, vwap, momentum, vol)

    # instrument identity (real cache; None when unavailable)
    identity = _instrument_identity(token, symbol, latest)

    return {
        "available": True,
        "symbol": symbol,
        "identity": identity,
        "source": "LIVE_STREAM" if _uses_persisted(symbol) == False else "PERSISTED_RECENT",
        "observations": len(ticks),
        "price": {
            "ltp": round(ltp, 4),
            "open": _fnum(day_open(latest)),
            "high": _fnum(day_high),
            "low": _fnum(day_low),
            "previousClose": _fnum(prev_close),
            "change": _fnum(change),
            "changePercent": _fnum(change_pct),
            "averagePrice": _fnum(latest.get("averagePrice")),
            "sampleHigh": _maxv(ltps),
            "sampleLow": _minv(ltps),
            "dayRangePct": round((_fnum(day_high) / _fnum(day_low) - 1) * 100, 4) if day_high and day_low and float(day_high) > 0 and float(day_low) > 0 else None,
            "distanceFromDayHighPct": round(((day_high - ltp) / day_high) * 100, 4) if day_high and float(day_high) > 0 else None,
            "distanceFromDayLowPct": round(((ltp - day_low) / day_low) * 100, 4) if day_low and float(day_low) > 0 else None,
        },
        "vwap": {
            "value": round(vwap, 4) if vwap is not None else None,
            "volumeSum": round(vol_delta_total, 4) if vol_delta_total else None,
            "methodology": "Σ(ltp × ΔcumulativeVolume) / ΣΔcumulativeVolume over the real sample; null when no positive volume deltas exist.",
        },
        "depth": depth,
        "direction": direction,
        "quality": quality,
        "latency": latency,
        "volatility": vol,
        "indicators": {
            "rsi": {"value": rsi, "period": rsi_period, "required": rsi_period + 1, "methodology": "Wilder RSI on real close-price sequence."},
            "sma5": _ind_with(sma5, 5), "sma20": _ind_with(sma20, 20),
            "ema9": _ind_with(ema9, 9), "ema21": _ind_with(ema21, 21),
            "atr": {"value": atr, "period": atr_period, "required": atr_period + 1, "methodology": "Wilder-smoothed True Range on 5m real candles."},
        },
        "momentum": {k: _fnum(v) for k, v in momentum.items()},
        "trend": trend,
        "candles": {
            "1m": candles1m[-180:],
            "5m": candles5m[-96:],
        },
        "lastTickAt": _iso_utc(latest.get("ts")),
        "tickAgeSec": _tick_age(latest),
    }


def _ind_with(v, n):
    return {"value": round(v, 4) if v is not None else None, "period": n, "required": n}


def _last_non_null(vals):
    for v in reversed(vals):
        if v is not None:
            return v
    return None


def _maxv(vals): return max(vals) if vals else None
def _minv(vals): return min(vals) if vals else None


def day_open(latest: dict) -> Optional[float]:
    return latest.get("open")


def _iso_utc(v) -> Optional[str]:
    ts = _ts_ms(v)
    if ts is None:
        return None
    return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isoformat()


def _tick_age(t: dict) -> Optional[float]:
    ts = _ts_ms(t.get("ts"))
    if not ts:
        return None
    return round(max(0.0, (time.time() * 1000 - ts) / 1000.0), 1)


def _depth_from_tick(t: dict) -> dict:
    bp = _fnum(t.get("bp")); sp = _fnum(t.get("sp"))
    bq = _fnum(t.get("bq")); sq_ = _fnum(t.get("sq")); bs = _fnum(t.get("bs"))
    ask_qty = sq_ if sq_ is not None else bs
    if bp is None or sp is None or bp < 0 or sp <= bp:
        return {"available": False, "reason": "DEPTH_UNAVAILABLE",
                "message": "Current feed does not provide valid bid/ask depth for this instrument."}
    spread = sp - bp
    mid = (sp + bp) / 2.0
    spread_pct = round(spread / mid * 100.0, 4) if mid > 0 else None
    bqd = bq; aqd = ask_qty
    imbalance = round((bqd - aqd) / (bqd + aqd), 4) if bqd is not None and aqd is not None and (bqd + aqd) > 0 else None
    pressure = None
    if bqd is not None and aqd is not None:
        if bqd > aqd:
            pressure = "BUY"
        elif aqd > bqd:
            pressure = "SELL"
        else:
            pressure = "NEUTRAL"
    return {
        "available": True,
        "bestBid": round(bp, 4), "bestAsk": round(sp, 4),
        "bidQty": bqd, "askQty": aqd,
        "spread": round(spread, 4),
        "spreadPercent": spread_pct,
        "imbalance": imbalance,
        "pressure": pressure,
        "methodology": "spread = ask − bid; imbalance = (bidQty − askQty)/(bidQty + askQty), null when either side missing or denominator < 0.",
    }


def _direction(ltps: list[float]) -> dict:
    up = down = unchanged = 0
    prev = None
    for p in ltps:
        if prev is not None:
            if p > prev:
                up += 1
            elif p < prev:
                down += 1
            else:
                unchanged += 1
        prev = p
    total = up + down + unchanged
    return {
        "up": up, "down": down, "unchanged": unchanged,
        "upDownRatio": round(up / down, 4) if down > 0 else (None if total == 0 else float("inf")),
        "pressure": round((up - down) / total, 4) if total > 0 else None,
        "observations": total,
        "methodology": "Classified by consecutive real LTP ticks; NOT buy/sell volume.",
    }


def _tick_quality(ticks: list[dict]) -> dict:
    dups = 0
    seen: set[tuple] = set()
    ooo = 0
    ts_anomalies = 0
    missing_ltp = 0
    prev_ts = None
    for t in ticks:
        ts_ms = _ts_ms(t.get("ts"))
        ltp = _fnum(t.get("ltp"))
        if ltp is None:
            missing_ltp += 1
        fp = (str(t.get("instrumentToken") or ""), ts_ms, t.get("ltp"), t.get("volume"), t.get("bp"), t.get("sp"))
        if fp in seen:
            dups += 1
        seen.add(fp) if fp[1] is not None else None
        if prev_ts is not None and ts_ms is not None and ts_ms < prev_ts:
            ooo += 1
        if ts_ms is not None:
            # broker ts within ±5min of receive time is expected on a live feed
            recv = _ts_ms(t.get("receivedAt"))
            if recv is not None and abs(recv - ts_ms) > 5 * 60 * 1000:
                ts_anomalies += 1
        prev_ts = ts_ms if ts_ms is not None else prev_ts
    n = len(ticks)
    return {
        "duplicateCandidates": dups,
        "duplicateRate": round(dups / n * 100, 2) if n else None,
        "outOfOrder": ooo,
        "timestampAnomalies": ts_anomalies,
        "missingLtp": missing_ltp,
        "sample": n,
        "duplicateKey": "(instrumentToken, ts, ltp, volume, bp, sp) — identical to Data Quality identity rule.",
    }


def _latency_from_ticks(ticks: list[dict]) -> dict:
    samples: list[float] = []
    for t in ticks:
        ts = _ts_ms(t.get("ts")); recv = _ts_ms(t.get("receivedAt"))
        if ts and recv and recv >= ts:
            samples.append(recv - ts)
    if not samples:
        return {"available": False, "samples": 0, "message": "No exchange↔backend latency samples on record."}
    return {
        "available": True,
        "avgMs": round(_mean(samples), 2),
        "medianMs": round(_percentile(samples, 0.5), 2) if samples else None,
        "p95Ms": round(_percentile(samples, 0.95), 2),
        "maxMs": round(max(samples), 2),
        "minMs": round(min(samples), 2),
        "samples": len(samples),
    }


def _volatility(rets: list[float]) -> dict:
    if len(rets) < 2:
        return {"available": False, "observations": len(rets),
                "message": "Insufficient real observations for volatility (need ≥2 tick-returns)."}
    sd = _stdev(rets)
    mu = _mean(rets)
    return {
        "available": True,
        "observations": len(rets),
        "meanReturn": round(mu, 6),
        "stdev": round(sd, 6),
        "realizedVolTick": round(sd * math.sqrt(len(rets)) * 100, 4),
        "methodology": "Log returns r=ln(Pt/Pt-1) over the real sample; realizedVolTick = stdev×√n (diagnostic only, not annualized).",
    }


def _vwap_from_ticks(ticks: list[dict]) -> tuple[Optional[float], float]:
    num = 0.0
    den = 0.0
    prev_vol = None
    for t in ticks:
        ltp = _fnum(t.get("ltp")); vol = _fnum(t.get("volume"))
        if ltp is None or vol is None or vol <= 0:
            prev_vol = vol if vol is not None and vol > 0 else prev_vol
            continue
        if prev_vol is not None and vol >= prev_vol:
            d = vol - prev_vol
            if d > 0:
                num += ltp * d
                den += d
        prev_vol = vol
    if den <= 0:
        return None, den
    return num / den, den


def build_candles(ticks: list[dict], step_sec: float) -> list[dict]:
    step_ms = int(step_sec * 1000)
    buckets: dict[int, list] = {}
    for t in ticks:
        ts = _ts_ms(t.get("ts"))
        if not ts:
            continue
        idx = int(ts // step_ms) * step_ms
        buckets.setdefault(idx, []).append(t)
    candles = []
    prev_vol_map: dict[str, Optional[float]] = {}
    for idx in sorted(buckets):
        grp = buckets[idx]
        grp.sort(key=lambda x: _ts_ms(x.get("ts")) or 0)
        ltps = [ _fnum(t.get("ltp")) for t in grp ]
        ltps = [x for x in ltps if x is not None]
        if not ltps:
            continue
        vol = grp[-1].get("volume")
        prev = prev_vol_map.get(str(grp[-1].get("symbol") or ""))
        vol_delta = None
        if vol is not None and prev is not None:
            dv = _fnum(vol) - prev
            if dv > 0:
                vol_delta = dv
        prev_vol_map[str(grp[-1].get("symbol") or "")] = _fnum(vol) if vol is not None else prev
        candles.append({
            "startMs": idx,
            "open": round(ltps[0], 4),
            "high": round(max(ltps), 4),
            "low": round(min(ltps), 4),
            "close": round(ltps[-1], 4),
            "tickCount": len(grp),
            "volume": round(vol_delta, 4) if vol_delta is not None else None,
        })
    return candles


def _derive_trend(ltp, ema21, vwap, momentum, vol) -> dict:
    reasons: list[str] = []
    if ema21 is not None:
        if ltp > ema21:
            reasons.append("Price above EMA21")
        elif ltp < ema21:
            reasons.append("Price below EMA21")
        else:
            reasons.append("Price at EMA21")
    m5 = momentum.get("5m")
    if m5 is not None:
        reasons.append(f"5m return {m5:+.2f}%")
    if momentum.get("1m") is not None:
        reasons.append(f"1m return {momentum['1m']:+.2f}%")
    if vol and vol.get("available") and vol.get("observations"):
        reasons.append(f"Volatility σ={vol['stdev']:.5f} over {vol['observations']} tick-returns")
    if vwap is not None:
        reasons.append(f"LTP {'above' if ltp > vwap else 'below'} VWAP")

    score = 0
    if ema21 is not None:
        score += 1 if ltp > ema21 else (-1 if ltp < ema21 else 0)
    m1 = momentum.get("1m")
    if m1 is not None:
        score += 1 if m1 > 0 else (-1 if m1 < 0 else 0)
    m5f = momentum.get("5m")
    if m5f is not None:
        score += 1 if m5f > 0 else (-1 if m5f < 0 else 0)
    label = "BULLISH" if score > 0 else "BEARISH" if score < 0 else "NEUTRAL"
    return {
        "label": label,
        "score": score,
        "reasons": reasons if reasons else ["Insufficient real indicators to derive a trend."],
        "disclaimer": "Derived analytical state from real metrics — not a trading recommendation.",
    }


def _instrument_identity(token: str, symbol: str, latest: dict) -> dict:
    name = None
    segment = str(latest.get("exchangeSegment") or "nse_cm")
    try:
        from services.instrument_cache import instrument_cache
        rec = instrument_cache.lookup_by_token(token)
        if rec:
            name = rec.get("name") or rec.get("companyName")
    except Exception:
        rec = None
    return {
        "token": token,
        "symbol": symbol,
        "tradingSymbol": str(latest.get("tradingSymbol") or ""),
        "exchangeSegment": segment,
        "name": name,
        "exchange": "NSE" if str(segment).lower().startswith("nse") else str(segment).upper(),
    }


# --------------------------------------------------------------------------- #
# Market-wide analytics (memory only — no collection scans)
# --------------------------------------------------------------------------- #

def market_wide() -> dict:
    latest_map = tick_buffer.get_latest_ticks()
    entries = []
    for token, t in latest_map.items():
        ltp = _fnum(t.get("ltp"))
        if ltp is None:
            continue
        sym = str(t.get("symbol") or t.get("tradingSymbol") or token)
        prev_close = _fnum(t.get("close"))
        change_pct = _fnum(t.get("changePercent"))
        if change_pct is None and prev_close and prev_close > 0:
            change_pct = round((ltp - prev_close) / prev_close * 100, 4)
        bp = _fnum(t.get("bp")); sp = _fnum(t.get("sp"))
        spread = None
        if bp is not None and sp is not None and sp > bp:
            spread = sp - bp
        age = None
        recv = t.get("receivedAt")
        if isinstance(recv, str):
            ts = _ts_ms(recv)
            age = round(max(0.0, time.time() - ts / 1000), 1) if ts else None
        entries.append({
            "token": str(token), "symbol": sym,
            "ltp": ltp, "changePercent": change_pct,
            "spread": spread, "tickAgeSec": age,
        })
    entries.sort(key=lambda e: e["tickAgeSec"] or 0)

    active = sum(1 for e in entries if (e["tickAgeSec"] or 9999) <= STALE_TICK_SEC)
    movers = []
    for e in entries:
        try:
            mw = tick_buffer.momentum_windows(e["token"], e["ltp"])
            e["m5"] = _fnum(mw.get("5m"))
        except Exception:
            e["m5"] = None
        if e["m5"] is not None:
            movers.append(e)
    movers.sort(key=lambda x: x["m5"] or 0, reverse=True)
    widest = [e for e in entries if e["spread"] is not None]
    widest.sort(key=lambda x: x["spread"], reverse=True)
    most_stale = sorted(entries, key=lambda x: x["tickAgeSec"] or 0, reverse=True)[:10]

    return {
        "activeInstruments": active,
        "instrumentsInMemory": len(entries),
        "priceHistory": tick_buffer.latest_history_summary(),
        "gainers": [{"symbol": m["symbol"], "changePercent": m["m5"], "ltp": m["ltp"]} for m in movers[:10] if (m["m5"] or 0) >= 0.0001],
        "losers": [{"symbol": m["symbol"], "changePercent": m["m5"], "ltp": m["ltp"]} for m in movers[-10:][::-1] if (m["m5"] or 0) <= -0.0001],
        "widestSpread": [{"symbol": w["symbol"], "spread": w["spread"]} for w in widest[:10]],
        "mostStale": [{"symbol": s["symbol"], "tickAgeSec": s["tickAgeSec"]} for s in most_stale],
        "source": "LIVE_MEMORY_STATE",
    }


# --------------------------------------------------------------------------- #
# Anomaly detection (real observations only)
# --------------------------------------------------------------------------- #

async def anomalies(symbol: str, range_sec: int = 300) -> dict:
    range_sec = max(30, min(int(range_sec), 3600))
    now_ms = int(time.time() * 1000)
    start = now_ms - range_sec * 1000
    ticks = [t for t in await _recent_symbol_ticks(symbol, 1200) if (_ts_ms(t.get("ts")) or 0) >= start]
    if not ticks:
        return {"symbol": symbol.upper(), "available": False, "reason": "NO_TICKS_IN_WINDOW", "anomalies": []}

    out: list[dict] = []
    ltps_n = [ (_ts_ms(t.get("ts")), _fnum(t.get("ltp"))) for t in ticks ]
    ltps_n = [(ts, p) for ts, p in ltps_n if ts and p is not None]

    # Rate spike / drop — compare recent 5s rate vs 60s average.
    now = now_ms / 1000.0
    recent5 = [ts for ts, _ in ltps_n if ts / 1000.0 >= now - 5]
    span60 = [ts for ts, _ in ltps_n if ts / 1000.0 >= now - 60]
    r5 = len(recent5) / 5.0
    r60 = len(span60) / 60.0
    if r60 > 0 and r5 >= r60 * RATE_SPIKE_RATIO:
        out.append({"type": "TICK_RATE_SPIKE", "severity": "warning",
                    "observed": round(r5, 2), "threshold": round(r60 * RATE_SPIKE_RATIO, 2),
                    "atMs": now_ms,
                    "message": f"Recent 5s tick rate {r5:.1f}/s is {r5 / r60:.1f}× the 60s average {r60:.1f}/s."})
    if r60 > 0 and r5 < RATE_DROP_RATIO * r60 and r60 > 0.2:
        out.append({"type": "TICK_RATE_DROP", "severity": "info",
                    "observed": round(r5, 2), "threshold": round(r60 * RATE_DROP_RATIO, 2),
                    "atMs": now_ms,
                    "message": f"Recent 5s tick rate {r5:.1f}/s dropped below 0.5× the 60s average {r60:.1f}/s."})

    # Price jump on a single real tick.
    prev = None
    jmp_at, jmp_pct = None, None
    for ts, p in ltps_n:
        if prev is not None and prev > 0:
            move = abs((p - prev) / prev) * 100.0
            if move >= PRICE_JUMP_PCT and (jmp_pct is None or move > jmp_pct):
                jmp_pct, jmp_at = move, ts
        prev = p
    if jmp_pct is not None:
        out.append({"type": "PRICE_JUMP", "severity": "warning",
                    "observed": round(jmp_pct, 3), "threshold": PRICE_JUMP_PCT,
                    "atMs": jmp_at,
                    "message": f"Single-tick move of {jmp_pct:.3f}% exceeded threshold."})

    # Spread widening vs observed median.
    spreads = []
    for t in ticks:
        bp = _fnum(t.get("bp")); sp = _fnum(t.get("sp"))
        if bp is not None and sp is not None and sp > bp:
            spreads.append(sp - bp)
    med = _percentile(spreads, 0.5) if spreads else None
    if med and spreads:
        mx = max(spreads)
        if mx >= med * SPREAD_WIDEN_MULT:
            out.append({"type": "SPREAD_WIDENING", "severity": "info",
                        "observed": round(mx, 4), "threshold": round(med * SPREAD_WIDEN_MULT, 4),
                        "atMs": now_ms,
                        "message": f"Max spread {mx:.4f} is ≥{SPREAD_WIDEN_MULT}× the median {med:.4f}."})

    # Latency spike — max observed backend latency.
    lat = _latency_from_ticks(ticks)
    if lat.get("available") and lat.get("maxMs") is not None and lat["maxMs"] >= LATENCY_SPIKE_MS:
        out.append({"type": "LATENCY_SPIKE", "severity": "info",
                    "observed": lat["maxMs"], "threshold": LATENCY_SPIKE_MS,
                    "atMs": now_ms,
                    "message": f"Max exchange→backend latency {lat['maxMs']:.0f}ms exceeded threshold."})

    # Stale instrument — latest tick older than stale threshold.
    last_ts = _ts_ms(ticks[-1].get("ts"))
    age = (now_ms - last_ts) / 1000.0 if last_ts else None
    if age is not None and age > STALE_TICK_SEC:
        out.append({"type": "STALE_INSTRUMENT", "severity": "warning",
                    "observed": round(age, 1), "threshold": STALE_TICK_SEC,
                    "atMs": now_ms,
                    "message": f"Latest real tick is {age:.0f}s old (> {STALE_TICK_SEC}s)."})

    # Duplicate burst.
    q = _tick_quality(ticks)
    if q["duplicateCandidates"] >= DUPLICATE_BURST_COUNT:
        out.append({"type": "DUPLICATE_BURST", "severity": "info",
                    "observed": q["duplicateCandidates"], "threshold": DUPLICATE_BURST_COUNT,
                    "atMs": now_ms,
                    "message": f"{q['duplicateCandidates']} duplicate-candidate ticks in window."})

    # Volume spike vs mean bucket volume.
    vols = [b.get("volumeDelta", 0) for b in bucketize(ticks, 1, start, now_ms)]
    mean_v = _mean([v for v in vols if v > 0])
    mx_v = max(vols) if vols else 0
    if mean_v and mx_v >= mean_v * VOLUME_SPIKE_MULT:
        out.append({"type": "VOLUME_SPIKE", "severity": "info",
                    "observed": round(mx_v, 0), "threshold": round(mean_v * VOLUME_SPIKE_MULT, 0),
                    "atMs": now_ms,
                    "message": f"One-second volume delta {mx_v:.0f} is ≥{VOLUME_SPIKE_MULT}× the mean {mean_v:.0f}."})

    out.sort(key=lambda a: a["atMs"], reverse=True)
    return {"symbol": symbol.upper(), "available": True, "anomalies": out,

            "thresholds": {
                "rateSpikeRatio": RATE_SPIKE_RATIO, "rateDropRatio": RATE_DROP_RATIO,
                "priceJumpPct": PRICE_JUMP_PCT, "spreadWidenMult": SPREAD_WIDEN_MULT,
                "latencySpikeMs": LATENCY_SPIKE_MS, "volumeSpikeMult": VOLUME_SPIKE_MULT,
                "duplicateBurstCount": DUPLICATE_BURST_COUNT,
            }}


# =========================================================================== #
# TICK ANALYTICS COMPOSITION LAYER
# =========================================================================== #
# The functions below assemble the ONE lightweight snapshot the Tick Analytics
# page loads plus the focused sections it refreshes. Every input is another
# engine's authoritative telemetry -- Tick Analytics owns none of it and never
# re-derives "persistence" by counting MongoDB documents.
#
#   tick_buffer            -> live rate / session counters / last flush
#   db_writer_engine       -> received, validated, buffered, skipped, source split
#   tick_analytics_daily   -> per-IST-day pre-aggregated facts + report
#   data_quality           -> quality dimensions
#   pipeline_latency       -> measured hop-to-hop latency
#   market_calendar        -> session boundaries
# =========================================================================== #

SUMMARY_TTL_SEC = 5.0
_summary_cache: dict = {"at": 0.0, "value": None}


def _buf_stats() -> dict:
    try:
        return tick_buffer.stats()
    except Exception:
        logger.debug("tick_buffer.stats failed", exc_info=True)
        return {}


def _ws_status() -> dict:
    try:
        from ws_socket.ws_manager import ws_manager
        return ws_manager.status()
    except Exception:
        logger.debug("ws_manager.status failed", exc_info=True)
        return {}


def _telemetry_minutes() -> int:
    """Minute buckets to read when deriving average rates from telemetry."""
    return 6


async def _telemetry_rate(window_sec: int) -> dict:
    """Average ingest rate over ``window_sec`` from the persisted per-minute
    writer telemetry (``data_saver_telemetry``). Returns ``None``-fields when
    the telemetry does not cover the window -- never a fabricated 0.
    """
    out = {"avgPerSec": None, "received": None, "buckets": 0, "coveragePct": None,
           "source": None}
    if window_sec <= 0:
        return out
    try:
        from database.connection import is_mongo_connected
        if not is_mongo_connected():
            return out
        db = get_db()
        start = datetime.now(timezone.utc) - timedelta(seconds=window_sec)
        cur = db.data_saver_telemetry.find({"ts": {"$gte": start}}, {"received": 1, "_id": 0})
        total = 0
        buckets = 0
        async for d in cur:
            buckets += 1
            try:
                total += int(d.get("received") or 0)
            except (TypeError, ValueError):
                continue
        if buckets:
            out.update({
                "avgPerSec": round(total / float(window_sec), 4),
                "received": total,
                "buckets": buckets,
                "coveragePct": round(min(buckets, window_sec / 60.0) / (window_sec / 60.0) * 100.0, 1),
                "source": "data_saver_telemetry.received(sum)",
            })
    except Exception:
        logger.debug("telemetry rate read failed", exc_info=True)
    return out


async def rate_analytics() -> dict:
    """TICK RATE section -- real tick-event timestamps only.

    * ``current``  -- tick_buffer rolling window (backend clock)
    * ``avg1m``    -- WS-engine 60s average, telemetry fallback
    * ``avg5m``    -- persisted per-minute writer telemetry (5 min)
    * ``peak`` / ``min`` / ``sessionAvg`` -- today's pre-aggregated day doc
    """
    buf = _buf_stats()
    ws = _ws_status()
    ws_rates = ws.get("rates") or {}

    from core.timezones import business_date_str
    from services import tick_analytics_daily as daily

    today = business_date_str()
    day = await daily.get_day(today)

    tel5 = await _telemetry_rate(300)
    tel1 = await _telemetry_rate(60)

    avg1m = _fnum(ws_rates.get("ticks_60s_average"))
    avg1m_src = "ws_manager.rates.ticks_60s_average"
    if avg1m is None:
        avg1m = tel1.get("avgPerSec")
        avg1m_src = tel1.get("source")

    day_rate = (day.get("rate") or {}) if day else {}
    day_ticks = (day.get("ticks") or {}) if day else {}

    return {
        "current": _fnum(buf.get("ticksPerSecond")),
        "currentWindowSec": _fnum(buf.get("rollingWindowSec")),
        "trend": buf.get("tickRateTrend"),
        "avg1m": avg1m,
        "avg1mSource": avg1m_src,
        "avg5m": tel5.get("avgPerSec"),
        "avg5mSource": tel5.get("source"),
        "avg5mCoveragePct": tel5.get("coveragePct"),
        "peak": day_rate.get("peak"),
        "min": day_rate.get("min"),
        "p50": day_rate.get("p50"),
        "sessionAvg": day_ticks.get("avgTickRate"),
        "sessionActiveSec": day_ticks.get("activeDurationSec"),
        "dayStatus": (day or {}).get("status"),
        "date": today,
        "sources": {
            "current": "tick_buffer.rolling_window",
            "peak": "tick_analytics_daily.peakTickRate",
            "sessionAvg": "tick_analytics_daily.avgTickRate",
        },
        "measured": any(v is not None for v in (
            _fnum(buf.get("ticksPerSecond")), avg1m, tel5.get("avgPerSec"),
            day_rate.get("peak"),
        )),
    }


async def persistence_analytics() -> dict:
    """TICK PERSISTENCE section -- canonical DB Write Engine telemetry.

    Received / validated / buffered / persisted / skipped / failed all come
    from the DB Write Engine's own counters (session scope) cross-checked with
    the day's writer-owned ``daily_summaries`` counters (day scope).
    """
    from services.tick_analytics_daily import db_writer_session_counters, get_day
    from core.timezones import business_date_str

    session = db_writer_session_counters() or {}
    today = business_date_str()
    day = await get_day(today)
    day_persist = (day.get("persistence") or {}) if day else {}
    buf = _buf_stats()

    received = session.get("received")
    persisted = session.get("persisted")
    failed = session.get("failed")
    skipped = session.get("skipped")
    validated = session.get("validated")

    success = None
    if persisted is not None and received:
        try:
            success = round((persisted / received) * 100.0, 2)
        except (TypeError, ZeroDivisionError):
            success = None
    if success is None:
        success = day_persist.get("successPct")

    latency = await _write_latency()

    return {
        "scope": "session",
        "received": received,
        "validated": validated,
        "rejectedByValidation": session.get("rejectedByValidation"),
        "duplicatesRejected": session.get("duplicatesRejected"),
        "buffered": session.get("buffered") if session.get("buffered") is not None
        else int(buf.get("bufferLength") or 0),
        "persisted": persisted if persisted is not None else int(buf.get("totalWritten") or 0),
        "skipped": skipped,
        "failed": failed if failed is not None else int(buf.get("totalWriteErrors") or 0),
        "successRatePct": success,
        "avgWriteLatencyMs": latency.get("avgMs"),
        "maxWriteLatencyMs": latency.get("maxMs"),
        "p95WriteLatencyMs": latency.get("p95Ms"),
        "lastFlushAt": buf.get("lastFlushAt"),
        "lastFlushDurationMs": buf.get("lastFlushDurationMs"),
        "lastError": buf.get("lastError"),
        "pipelineRunning": bool(buf.get("pipelineRunning")),
        "dropReasons": session.get("dropReasons") or {},
        "dataLossAccounting": session.get("dataLossAccounting") or None,
        "day": {
            "date": today,
            "received": day_persist.get("received"),
            "persisted": day_persist.get("persisted"),
            "failed": day_persist.get("failed"),
            "successPct": day_persist.get("successPct"),
            "status": (day or {}).get("status"),
        },
        "sources": {
            "session": "db_writer_engine.status_snapshot.metrics.custom",
            "day": "daily_summaries / data_saver_telemetry",
            "latency": "pipeline_latency(ws_recv_to_mongo)",
        },
    }


async def _write_latency() -> dict:
    try:
        from services import pipeline_latency
        stats = pipeline_latency.stats()
    except Exception:
        return {}
    stage = (stats.get("stages") or {}).get("ws_recv_to_mongo") or {}
    return {
        "avgMs": stage.get("avg_ms"),
        "maxMs": stage.get("max_ms"),
        "p95Ms": stage.get("p95_ms"),
        "samples": stage.get("samples"),
        "available": bool(stage),
    }


async def source_analytics() -> dict:
    """SOURCE ANALYTICS -- DB Write Engine's own source classification only."""
    from services.tick_analytics_daily import db_writer_session_counters
    session = db_writer_session_counters() or {}
    rows = session.get("sources") or []
    if not rows:
        return {"available": False, "reason": "NO_SOURCE_TELEMETRY", "rows": []}
    return {
        "available": True,
        "scope": "session",
        "rows": rows,
        "unknownSourceSkipped": session.get("unknownSourceSkipped"),
        "overlappingSourcesDeduped": session.get("overlappingSourcesDeduped"),
        "source": "db_writer_engine.metrics.custom",
    }


async def storage_analytics() -> dict:
    """STORAGE ANALYTICS -- real collstats, never "1 tick = 1 document"."""
    from services.tick_analytics_daily import get_day, storage_slice
    from core.timezones import business_date_str
    today = business_date_str()
    day = await get_day(today)
    day_storage = (day.get("storage") or {}) if day else {}
    live = {}
    try:
        from database.connection import is_mongo_connected
        if is_mongo_connected():
            live = await storage_slice(get_db(), int((day.get("counts") or {}).get("storedDocs") or 0))
    except Exception:
        logger.debug("live storage slice failed", exc_info=True)
    return {
        "collection": day_storage.get("collection") or "ticks",
        "bytesToday": day_storage.get("bytes"),
        "avgBytesPerTick": day_storage.get("avgBytesPerTick"),
        "estimated": bool(day_storage.get("estimated", True)),
        "reason": day_storage.get("reason"),
        "collectionStorageBytes": live.get("collectionStorageBytes") or day_storage.get("collectionStorageBytes"),
        "collectionCount": live.get("collectionCount") or day_storage.get("collectionCount"),
        "indexBytes": live.get("indexBytes") or day_storage.get("indexBytes"),
        "source": "mongodb:collstats(ticks)",
    }


async def quality_analytics(date_str: Optional[str] = None) -> dict:
    """Compact QUALITY slice -- Data Quality owns the engine, we only surface
    the analytics-relevant dimensions for the requested day."""
    from services.tick_analytics_daily import get_day
    from core.timezones import business_date_str
    date_str = date_str or business_date_str()
    day = await get_day(date_str)
    q = (day or {}).get("quality")
    if not q:
        return {
            "available": False,
            "reason": "NO_QUALITY_TELEMETRY",
            "date": date_str,
            "status": (day or {}).get("status"),
        }
    return {"available": True, "date": date_str, **q}


async def symbol_tick_stats(symbol: str, date_str: Optional[str] = None) -> dict:
    """SELECTED SYMBOL analytics: day facts + live window + latest quote.

    Live windows use the indexed ``(symbol, ts)`` index -- two bounded counts,
    never a collection scan. Live quote fields come from the canonical live
    store; anything unmeasured stays ``None``.
    """
    from core.timezones import business_date_str
    from services.tick_analytics_daily import get_day, symbol_day

    symbol = str(symbol or "").strip().upper()
    if not symbol:
        return {"available": False, "reason": "SYMBOL_REQUIRED"}
    date_str = date_str or business_date_str()
    await ensure_tick_indexes()

    day_info = await symbol_day(date_str, symbol)
    row = day_info.get("row")

    live_1m = live_5m = None
    window_sources = {}
    try:
        from database.connection import is_mongo_connected
        if is_mongo_connected():
            db = get_db()
            now = datetime.now(timezone.utc)
            for label, seconds in (("last1m", 60), ("last5m", 300)):
                start = now - timedelta(seconds=seconds)
                n = await asyncio.wait_for(
                    db.ticks.count_documents({"symbol": symbol, "ts": {"$gte": start}}),
                    timeout=5.0,
                )
                if label == "last1m":
                    live_1m = int(n)
                else:
                    live_5m = int(n)
                window_sources[label] = "mongodb:ticks.count(symbol,ts-window)"
    except Exception:
        logger.debug("symbol window counts failed", exc_info=True)

    latest = None
    try:
        from services.tick_field_resolver import get_quote_slice
        for t in reversed(tick_buffer.get_recent(200)):
            if str(t.get("symbol") or "").upper() == symbol:
                latest = get_quote_slice(dict(t))
                break
    except Exception:
        logger.debug("live symbol quote lookup failed", exc_info=True)

    if latest is None:
        try:
            from database.connection import is_mongo_connected
            if is_mongo_connected():
                db = get_db()
                doc = await db.ticks.find_one(
                    {"symbol": symbol}, sort=[("ts", -1)]
                )
                if doc:
                    doc.pop("_id", None)
                    from services.tick_field_resolver import get_quote_slice
                    latest = get_quote_slice(doc)
        except Exception:
            logger.debug("mongo symbol latest failed", exc_info=True)

    latest_ltp = _fnum((latest or {}).get("ltp"))
    latest_vol = _fnum((latest or {}).get("volume"))
    latest_ts = _ts_ms((latest or {}).get("ts")) if latest else None

    day = await get_day(date_str)
    return {
        "available": bool(row) or latest is not None,
        "symbol": symbol,
        "date": date_str,
        "instrumentToken": (latest or {}).get("instrumentToken"),
        "exchange": (latest or {}).get("exchange") or (latest or {}).get("segment"),
        "tradingSymbol": (latest or {}).get("tradingSymbol"),
        "day": row,
        "dayStatus": (day or {}).get("status"),
        "ticksLast1m": live_1m,
        "ticksLast5m": live_5m,
        "windowSources": window_sources,
        "latest": {
            "ltp": latest_ltp,
            "volume": latest_vol,
            "tickAtMs": latest_ts,
            "tickAt": datetime.fromtimestamp(latest_ts / 1000, tz=timezone.utc).isoformat()
            if latest_ts else None,
            "ageSec": round((time.time() * 1000 - latest_ts) / 1000.0, 1) if latest_ts else None,
            "source": "tick_buffer.live_store" if latest and latest_ts and
            (time.time() * 1000 - latest_ts) < 60_000 else "mongodb:ticks(latest)",
        },
        "reason": None if (row or latest) else "NO_TICKS_FOR_SYMBOL",
    }


async def summary() -> dict:
    """THE one lightweight snapshot the Tick Analytics page loads.

    Cost: one cached daily-document read + engine telemetry reads. No
    collection scan, no 30-day aggregation, no report generation on load.
    """
    now = time.monotonic()
    cached = _summary_cache.get("value")
    if cached is not None and now - float(_summary_cache.get("at") or 0) < SUMMARY_TTL_SEC:
        return cached

    from core.timezones import business_date_str
    from services.tick_analytics_daily import (
        backfill_state, get_day, list_days,
    )

    state = live_state()
    today = business_date_str()
    day = await get_day(today)
    counts = (day or {}).get("counts") or {}
    ticks = (day or {}).get("ticks") or {}
    persistence = (day or {}).get("persistence") or {}
    storage = (day or {}).get("storage") or {}
    session_day = (day or {}).get("session") or {}
    buf = _buf_stats()

    rates = await rate_analytics()
    persist = await persistence_analytics()
    sources = await source_analytics()
    quality = await quality_analytics(today)
    latency = await latency_block()

    feed_received = int(buf.get("liveTicksRecorded") or 0)
    day_received = counts.get("received")

    has_data = bool(ticks.get("count")) or bool(day_received)
    feed_status = state.get("feedStatus")

    if feed_status in {"DISCONNECTED", "OFFLINE"} and not has_data:
        status_code = "DISCONNECTED"
    elif feed_status == "MARKET_CLOSED":
        status_code = "MARKET_CLOSED"
    elif not has_data:
        status_code = "NO_DATA"
    elif feed_status in {"LIVE", "DEGRADED", "STALE", "NO_LIVE_DATA"}:
        status_code = "LIVE" if feed_status == "LIVE" else feed_status
    else:
        status_code = str(feed_status or "UNKNOWN")

    value = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": "TICK_ANALYTICS_ENGINE",
        "status": {
            "code": status_code,
            "feedStatus": feed_status,
            "live": bool(state.get("live")),
            "marketStatus": state.get("marketStatus"),
            "marketState": state.get("marketState"),
            "marketSession": state.get("marketSession"),
            "marketDate": state.get("marketDate") or today,
            "tradingDay": state.get("isTradingDay"),
            "dayClass": state.get("dayClass"),
            "reasonMessage": state.get("reasonMessage"),
            "nextMarketOpen": state.get("nextMarketOpen"),
            "connected": bool((state.get("ws") or {}).get("connected")),
            "feedState": (state.get("ws") or {}).get("feedState"),
        },
        "today": {
            "date": today,
            "ticksReceived": day_received,
            "feedReceivedSession": feed_received,
            "ticksPersisted": counts.get("persisted"),
            "ticksFailed": counts.get("failed"),
            "ticksSkipped": persistence.get("skipped"),
            "skippedScope": persistence.get("skippedScope"),
            "symbols": counts.get("symbols"),
            "storedDocs": counts.get("storedDocs"),
            "firstTickAt": ticks.get("firstTickAt"),
            "lastTickAt": ticks.get("lastTickAt"),
            "activeDurationSec": ticks.get("activeDurationSec"),
            "avgTickRate": ticks.get("avgTickRate"),
            "peakTickRate": ticks.get("peakTickRate"),
            "persistenceSuccessPct": persistence.get("successPct"),
            "storageBytes": storage.get("bytes"),
            "status": (day or {}).get("status"),
            "missing": (day or {}).get("missing") or [],
            "tradingDay": (day or {}).get("tradingDay"),
        },
        "lastTick": {
            "at": (state.get("tick") or {}).get("lastTickAt"),
            "atMs": (state.get("tick") or {}).get("lastTickAtEpochMs"),
            "ageSec": (state.get("tick") or {}).get("ageSec"),
        },
        "rate": rates,
        "persistence": persist,
        "quality": quality,
        "storage": await storage_analytics(),
        "latency": latency,
        "sources": sources,
        "session": {
            "marketOpenAt": session_day.get("marketOpenAt"),
            "marketCloseAt": session_day.get("marketCloseAt"),
            "firstTickAt": session_day.get("firstTickAt"),
            "peakActivityAt": session_day.get("peakActivityAt"),
            "lowestActivityAt": session_day.get("lowestActivityAt"),
            "lastTickAt": session_day.get("lastTickAt"),
            "activeDurationSec": session_day.get("activeDurationSec"),
            "pipelineRunning": bool(buf.get("pipelineRunning")),
            "activeInstruments": int(buf.get("activeTickStocks") or 0),
            "dayStatus": (day or {}).get("status"),
        },
        "feed": {
            "connected": bool((state.get("ws") or {}).get("connected")),
            "feedState": (state.get("ws") or {}).get("feedState"),
            "subscribedCount": (state.get("ws") or {}).get("subscribedCount"),
            "reconnectCount": (state.get("ws") or {}).get("reconnectCount"),
            "sse": {"available": True, "channel": "/api/ticks/stream"},
        },
        "anomalies": (day or {}).get("anomalies") or [],
        "backfill": backfill_state(),
        "generatedInMs": None,
    }
    value["generatedInMs"] = round((time.monotonic() - now) * 1000.0, 1)

    _summary_cache["at"] = time.monotonic()
    _summary_cache["value"] = value
    return value


async def latency_block() -> dict:
    from services.tick_analytics_daily import latency_slice
    block = latency_slice()
    feed = _buf_stats().get("feedLatencyMs")
    if not block:
        block = {"hops": {}, "available": False, "scope": "process"}
    block["feedLatencyMs"] = _latency_stats(feed)
    block["measured"] = bool(block.get("available")) or bool(feed)
    if not block.get("measured"):
        block["reason"] = "NOT_MEASURED"
    return block


def invalidate_summary_cache() -> None:
    _summary_cache["at"] = 0.0
    _summary_cache["value"] = None


def live_event() -> dict:
    """Compact, coalesced realtime payload published ~1 Hz on the existing
    system SSE channel. Deliberately small: live summary, rate, persistence,
    selected-symbol-independent fields only. Never every raw tick.
    """
    buf = _buf_stats()
    ws = _ws_status()
    from core.timezones import business_date_str
    today = business_date_str()
    day = None
    try:
        from services.tick_analytics_daily import _day_cache
        cached = _day_cache.get(today)
        day = cached[1] if cached else None
    except Exception:
        day = None
    counts = (day or {}).get("counts") or {}
    ticks = (day or {}).get("ticks") or {}
    persistence = (day or {}).get("persistence") or {}
    storage = (day or {}).get("storage") or {}

    attempted = int(buf.get("totalWritten") or 0) + int(buf.get("totalWriteErrors") or 0)
    success = round((int(buf.get("totalWritten") or 0) / attempted) * 100, 2) if attempted else None

    return {
        "date": today,
        "ticksReceived": counts.get("received"),
        "ticksPersisted": counts.get("persisted") if counts.get("persisted") is not None
        else int(buf.get("totalWritten") or 0),
        "ticksFailed": counts.get("failed") if counts.get("failed") is not None
        else int(buf.get("totalWriteErrors") or 0),
        "symbols": counts.get("symbols") or int(buf.get("activeTickStocks") or 0),
        "tickRate": _fnum(buf.get("ticksPerSecond")),
        "tickRateTrend": buf.get("tickRateTrend"),
        "peakTickRate": ticks.get("peakTickRate"),
        "firstTickAt": ticks.get("firstTickAt"),
        "lastTickAt": ticks.get("lastTickAt"),
        "activeDurationSec": ticks.get("activeDurationSec"),
        "persistenceSuccessPct": persistence.get("successPct") if persistence.get("successPct") is not None else success,
        "storageBytes": storage.get("bytes"),
        "feedConnected": bool(ws.get("connected")),
        "feedState": str(ws.get("feed_state") or ""),
        "pipelineRunning": bool(buf.get("pipelineRunning")),
        "dayStatus": (day or {}).get("status"),
        "sessionPersisted": int(buf.get("totalWritten") or 0),
        "sessionReceived": int(buf.get("totalReceived") or 0),
        "sessionFailed": int(buf.get("totalWriteErrors") or 0),
        "buffered": int(buf.get("bufferLength") or 0),
        "lastFlushAt": buf.get("lastFlushAt"),
        "scope": "today",
    }