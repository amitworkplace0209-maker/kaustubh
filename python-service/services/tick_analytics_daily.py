"""Daily tick-analytics rollup + authoritative Tick Analytics reports.

OWNERSHIP
---------
This module belongs to the TICK ANALYTICS domain. It is an **analytics /
observability consumer** only. It never owns the broker feed, the WebSocket
Engine, the MongoDB write path, orders, sessions or subscriptions.

Its inputs are other engines' authoritative outputs:

  * ``db.ticks``                       -- persisted ticks (DB Write Engine output)
  * ``db.daily_summaries``             -- per-day writer counters (tick_buffer)
  * ``db.data_saver_telemetry``        -- per-minute writer/Feed deltas (ds_insights)
  * ``services.db_writer_engine``      -- source classification + drop/skip counters
  * ``services.data_quality``          -- quality dimensions for the day
  * ``services.market_calendar``       -- trading-day / session boundaries
  * ``services.pipeline_latency``      -- measured hop-to-hop latency

WHAT IT PRODUCES
----------------
One document per IST business day in the ``tick_analytics_daily`` collection.
The document is the single authoritative source behind:

  * the DAILY TICK ANALYTICS table
  * the DAILY TICK VOLUME chart
  * the TIME-PERIOD TICK ACTIVITY table
  * the TOP SYMBOLS BY TICK ACTIVITY table
  * the TICK ANALYTICS REPORT and its REPORT HISTORY

BUILD STRATEGY (performance contract)
-------------------------------------
  * Past days are built **once**, persisted, and then only ever read.
  * The current day is rebuilt at most ``TODAY_TTL_SEC`` seconds apart and the
    result is cached in-process, so page loads never trigger a fresh scan.
  * Every Mongo read is an **indexed, bounded, time-boxed** aggregation over a
    single IST day -- never a full-collection scan.
  * ``list_days()`` NEVER backfills synchronously. Missing days are queued and
    built by the background ``_tick_analytics_backfill_loop`` registered in
    ``app.py``, so the initial page load stays one lightweight snapshot read.

HONESTY CONTRACT
----------------
A metric that cannot be measured for a day is returned as ``None`` with its
reason recorded in ``missing``. Nothing is ever defaulted to 0. Every metric
carries its provenance in ``sources`` so a reader can tell writer telemetry
apart from a derived value.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from core.timezones import IST, business_date_str, iso_ist, now_ist
from database.connection import get_db, is_mongo_connected
from services import market_calendar

logger = logging.getLogger("tick_analytics_daily")

COLL = "tick_analytics_daily"
SCHEMA = 1

#: In-process cache TTL for the CURRENT day (seconds). Past days are cached
#: indefinitely once built -- they never change.
TODAY_TTL_SEC = 45.0

#: Hard time-box for the per-day aggregation. A day that cannot be aggregated
#: inside this budget is stored as PARTIAL rather than hanging the request.
AGG_TIMEOUT_SEC = 20.0
AGG_MAXTIMEMS_MS = 18_000

#: Above this many documents in one IST day we skip the expensive facets and
#: only compute the cheap totals, marking rate metrics unavailable.
EXPENSIVE_DAY_DOC_LIMIT = 1_500_000

#: Cap on per-symbol rows persisted per day (protects the document size).
MAX_SYMBOL_STATS = 2000

#: Default history window for the daily table / chart.
DEFAULT_DAYS = 30
MAX_DAYS = 366

#: Per-process caches.
_index_lock = asyncio.Lock()
_indexes_ensured = False
_index_last_attempt = 0.0
INDEX_RETRY_COOLDOWN_SEC = 60.0

#: date -> (monotonic_at, doc)
_day_cache: dict[str, tuple[float, dict]] = {}
#: date -> (monotonic_at, summary-projection list) keyed by days
_list_cache: dict[tuple[int], tuple[float, list[dict]]] = {}
_backfill_queue: list[str] = []
_backfill_done: set[str] = set()
_backfill_running = False


# --------------------------------------------------------------------------- #
# Time helpers (IST business day -> UTC instant window)
# --------------------------------------------------------------------------- #

def day_window(date_str: str) -> tuple[datetime, datetime]:
    """UTC ``[start, end)`` window for an IST ``YYYY-MM-DD`` business day."""
    start_ist = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=IST)
    start = start_ist.astimezone(timezone.utc)
    return start, start + timedelta(days=1)


def recent_days(n: int) -> list[str]:
    """Newest-first IST day strings ending today."""
    today = now_ist().date()
    return [(today - timedelta(days=i)).isoformat() for i in range(n)]


def is_today(date_str: str) -> bool:
    return date_str == business_date_str()


def _iso(v: Any) -> Optional[str]:
    if isinstance(v, datetime):
        return iso_ist(v)
    return str(v) if v is not None else None


def _fnum(v: Any) -> Optional[float]:
    if v is None:
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


def _int(v: Any) -> Optional[int]:
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _safe_div(num: Optional[float], den: Optional[float]) -> Optional[float]:
    if num is None or den is None:
        return None
    try:
        if den <= 0:
            return None
        return round(float(num) / float(den), 4)
    except (TypeError, ValueError):
        return None


def _pct(num: Optional[float], den: Optional[float]) -> Optional[float]:
    if num is None or den is None:
        return None
    try:
        if den <= 0:
            return None
        return round((float(num) / float(den)) * 100.0, 2)
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------- #
# Indexes
# --------------------------------------------------------------------------- #

async def ensure_indexes() -> None:
    global _indexes_ensured, _index_last_attempt
    if _indexes_ensured:
        return
    now = time.monotonic()
    if now - _index_last_attempt < INDEX_RETRY_COOLDOWN_SEC:
        return
    async with _index_lock:
        if _indexes_ensured:
            return
        _index_last_attempt = now
        if not is_mongo_connected():
            return
        try:
            db = get_db()

            async def _build() -> None:
                await db[COLL].create_index([("date", 1)], unique=True, background=True)
                await db[COLL].create_index([("updatedAt", -1)], background=True)

            await asyncio.wait_for(_build(), timeout=5.0)
            _indexes_ensured = True
        except Exception:
            logger.debug("tick_analytics_daily index setup deferred (non-fatal)", exc_info=True)


# --------------------------------------------------------------------------- #
# Session boundaries (Scheduler / market calendar -- never hard-coded)
# --------------------------------------------------------------------------- #

def session_boundaries(date_str: str) -> dict:
    """Market open/close for the IST day straight from ``market_calendar``."""
    try:
        d = datetime.strptime(date_str, "%Y-%m-%d").date()
    except ValueError:
        d = now_ist().date()
    cls = market_calendar.day_class(d)
    trading = cls == market_calendar.NORMAL_MARKET_DAY
    open_dt = datetime.combine(d, market_calendar.OPEN_TIME, tzinfo=IST)
    close_dt = datetime.combine(d, market_calendar.CLOSE_TIME, tzinfo=IST)
    return {
        "tradingDay": trading,
        "dayClass": cls,
        "closureReason": market_calendar.closure_reason(d),
        "marketOpenAt": iso_ist(open_dt) if trading else None,
        "marketCloseAt": iso_ist(close_dt) if trading else None,
        "sessionOpenMinute": open_dt.hour * 60 + open_dt.minute if trading else None,
        "sessionCloseMinute": close_dt.hour * 60 + close_dt.minute if trading else None,
    }


def build_periods(date_str: str) -> list[dict]:
    """Configured activity periods for the day.

    Derived from the real market session (``market_calendar``): a first partial
    bucket from open to the next whole hour, then whole hours to close. Never a
    hard-coded table -- if the exchange session changes, these follow.
    """
    b = session_boundaries(date_str)
    start_m = b.get("sessionOpenMinute")
    end_m = b.get("sessionCloseMinute")
    if start_m is None or end_m is None or end_m <= start_m:
        return []
    periods: list[dict] = []

    def _label(m0: int, m1: int) -> str:
        return f"{m0 // 60:02d}:{m0 % 60:02d}-{m1 // 60:02d}:{m1 % 60:02d}"

    cur = start_m
    next_hour = ((start_m // 60) + 1) * 60
    if next_hour > end_m:
        periods.append({"startMinute": start_m, "endMinute": end_m, "label": _label(start_m, end_m)})
        return periods
    if next_hour > start_m:
        periods.append({"startMinute": start_m, "endMinute": next_hour, "label": _label(start_m, next_hour)})
        cur = next_hour
    while cur < end_m:
        nxt = min(cur + 60, end_m)
        periods.append({"startMinute": cur, "endMinute": nxt, "label": _label(cur, nxt)})
        cur = nxt
    return periods


def _minute_index(date_str: str, hhmm: str) -> Optional[int]:
    try:
        base = datetime.strptime(date_str, "%Y-%m-%d").date()
    except ValueError:
        return None
    try:
        hh, mm = hhmm.split(":")
        return int(hh) * 60 + int(mm)
    except (ValueError, AttributeError):
        return None


# --------------------------------------------------------------------------- #
# Pure reducers (unit-tested)
# --------------------------------------------------------------------------- #

def reduce_seconds(rows: list[dict]) -> dict:
    """Reduce ``[{_id: epoch_ms, n: count}]`` into rate statistics."""
    if not rows:
        return {
            "count": 0, "activeSeconds": 0, "peakPerSec": None, "avgPerSec": None,
            "minPerSec": None, "p50PerSec": None, "firstMs": None, "lastMs": None,
            "series": [],
        }
    series: list[tuple[int, int]] = []
    for r in rows:
        ms = _int(r.get("_id"))
        n = _int(r.get("n")) or 0
        if ms is None:
            continue
        series.append((ms, n))
    series.sort(key=lambda x: x[0])
    counts = [c for _, c in series]
    total = sum(counts)
    return {
        "count": total,
        "activeSeconds": len(counts),
        "peakPerSec": max(counts) if counts else None,
        "avgPerSec": round(total / len(counts), 4) if counts else None,
        "minPerSec": min(counts) if counts else None,
        "p50PerSec": _sorted_percentile(counts, 0.5),
        "firstMs": series[0][0] if series else None,
        "lastMs": series[-1][0] if series else None,
        "series": series,
    }


def _sorted_percentile(values: list[int], p: float) -> Optional[float]:
    if not values:
        return None
    s = sorted(values)
    k = (len(s) - 1) * p
    lo, hi = int(math.floor(k)), int(math.ceil(k))
    if lo == hi:
        return float(s[lo])
    return round(s[lo] * (hi - k) + s[hi] * (k - lo), 4)


def minute_rollup(series: list[tuple[int, int]], date_str: str) -> list[dict]:
    """Fold a second series into per-minute buckets (minute-of-IST-day)."""
    out: dict[int, dict] = {}
    for ms, n in series:
        try:
            dt = datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).astimezone(IST)
        except (OverflowError, OSError, ValueError):
            continue
        if dt.strftime("%Y-%m-%d") != date_str:
            continue
        m = dt.hour * 60 + dt.minute
        b = out.get(m)
        if b is None:
            b = {"m": m, "n": 0, "peak": 0}
            out[m] = b
        b["n"] += n
        if n > b["peak"]:
            b["peak"] = n
    return [out[k] for k in sorted(out)]


def fold_periods(periods: list[dict], minute_buckets: list[dict],
                 period_symbols: dict[tuple[int, int], set]) -> list[dict]:
    """Fill the configured session periods from minute buckets."""
    by_minute = {b["m"]: b for b in minute_buckets}
    out: list[dict] = []
    for p in periods:
        m0, m1 = p["startMinute"], p["endMinute"]
        ticks = 0
        peak = 0
        active_minutes = 0
        for m in range(m0, m1):
            b = by_minute.get(m)
            if not b:
                continue
            ticks += b["n"]
            peak = max(peak, b["peak"])
            active_minutes += 1
        seconds = max(1, (m1 - m0) * 60)
        symbols = period_symbols.get((m0, m1))
        out.append({
            "label": p["label"],
            "startMinute": m0,
            "endMinute": m1,
            "ticks": ticks,
            "avgRatePerSec": round(ticks / seconds, 4) if ticks else 0.0,
            "peakRatePerSec": peak if peak else None,
            "activeMinutes": active_minutes,
            "symbols": len(symbols) if symbols is not None else None,
        })
    return out


def fold_minute_symbols(rows: list[dict], date_str: str) -> dict[tuple[int, int], set]:
    """Fold ``{_id: {m: "%H:%M", s: symbol}}`` rows into per-period symbol sets."""
    periods = build_periods(date_str)
    out: dict[tuple[int, int], set] = {(p["startMinute"], p["endMinute"]): set()
                                       for p in periods}
    for row in rows:
        ident = row.get("_id") or {}
        minute = _minute_index(date_str, str(ident.get("m") or ""))
        symbol = str(ident.get("s") or "").strip()
        if minute is None or not symbol:
            continue
        for p in periods:
            if p["startMinute"] <= minute < p["endMinute"]:
                out[(p["startMinute"], p["endMinute"])].add(symbol)
                break
    return out


def build_report(date_str: str, doc: Optional[dict]) -> dict:
    """Turn a daily document into the Tick Analytics Report contract.

    The report is marked COMPLETE only when every required field is present;
    otherwise it lists exactly which metrics are missing. It never claims
    completeness it cannot prove.
    """
    generated_at = iso_ist(now_ist())
    if not doc:
        return {
            "date": date_str,
            "status": "NO_DATA",
            "complete": False,
            "generatedAt": generated_at,
            "missing": ["daily_document"],
            "reason": "NO_TICK_DATA",
            "sections": None,
        }

    counts = doc.get("counts") or {}
    ticks = doc.get("ticks") or {}
    persistence = doc.get("persistence") or {}
    storage = doc.get("storage") or {}
    session = doc.get("session") or {}

    required = [
        ("ticksReceived", counts.get("received")),
        ("ticksPersisted", counts.get("persisted")),
        ("activeSymbols", counts.get("symbols")),
        ("firstTick", ticks.get("firstTickAt")),
        ("lastTick", ticks.get("lastTickAt")),
        ("avgTickRate", ticks.get("avgTickRate")),
        ("peakTickRate", ticks.get("peakTickRate")),
        ("persistenceSuccessRate", persistence.get("successPct")),
    ]
    missing = [name for name, value in required if value is None]
    for name in (doc.get("missing") or []):
        if name not in missing:
            missing.append(name)

    writer_seen = any(
        (_fnum(counts.get(key)) or 0) > 0
        for key in ("received", "persisted", "failed")
    )
    # A day can have writer activity with no retained documents. That is not
    # "no data" — it is a partial report that must name the gap.
    if writer_seen and not _fnum(ticks.get("count")) \
            and "storedTickDocuments" not in missing:
        missing.append("storedTickDocuments")
    has_any_tick = bool(_fnum(ticks.get("count"))) or writer_seen
    reason: Optional[str] = None
    if not has_any_tick:
        status = "NO_DATA"
        reason = "NO_TICK_DATA"
    elif missing:
        status = "PARTIAL"
    else:
        status = "COMPLETE"

    return {
        "date": date_str,
        "status": status,
        "complete": status == "COMPLETE",
        "generatedAt": generated_at,
        "builtAt": doc.get("builtAt"),
        "missing": missing,
        "reason": reason,
        "tradingDay": doc.get("tradingDay"),
        "dayClass": doc.get("dayClass"),
        "closureReason": doc.get("closureReason"),
        "sections": {
            "session": session,
            "counts": counts,
            "ticks": {k: v for k, v in ticks.items() if k != "series"},
            "rate": doc.get("rate"),
            "persistence": persistence,
            "storage": storage,
            "quality": doc.get("quality"),
            "latency": doc.get("latency"),
            "sources": doc.get("sources"),
            "topSymbols": (doc.get("symbolStats") or [])[:10],
            "periods": doc.get("periods"),
            "anomalies": doc.get("anomalies"),
        },
        "source": doc.get("sources"),
        "schema": doc.get("schema"),
    }


# --------------------------------------------------------------------------- #
# Writer / telemetry counters for a day
# --------------------------------------------------------------------------- #

async def _writer_counters(db, date_str: str) -> dict:
    """Per-day writer counters from the authoritative writer-owned stores.

    * ``daily_summaries`` -- upserted by the tick buffer flush path, cumulative
      for the IST day, restart-safe.
    * ``data_saver_telemetry`` -- per-minute deltas of the same counters.

    Returns ``None`` for any metric whose source does not cover the day.
    """
    out: dict[str, Any] = {
        "received": None, "persisted": None, "failed": None,
        "subscribedStocks": None,
        "receivedSource": None, "persistedSource": None, "failedSource": None,
        "telemetryBuckets": 0,
    }
    if not is_mongo_connected():
        return out

    try:
        summary = await db.daily_summaries.find_one({"date": date_str})
    except Exception:
        summary = None
        logger.debug("daily_summaries read failed", exc_info=True)
    if summary:
        total_ticks = _int(summary.get("totalTicks"))
        total_writes = _int(summary.get("totalWrites"))
        if total_ticks is not None:
            out["received"] = total_ticks
            out["receivedSource"] = "daily_summaries.totalTicks"
        if total_writes is not None:
            out["persisted"] = total_writes
            out["persistedSource"] = "daily_summaries.totalWrites"
        if summary.get("subscribedStocks") is not None:
            out["subscribedStocks"] = _int(summary.get("subscribedStocks"))
        err = _int(summary.get("errorCount"))
        if err is not None:
            out["failed"] = err
            out["failedSource"] = "daily_summaries.errorCount"

    try:
        start, end = day_window(date_str)
        cur = db.data_saver_telemetry.find({"ts": {"$gte": start, "$lt": end}})
        tel_received = tel_written = tel_errors = 0
        buckets = 0
        async for d in cur:
            buckets += 1
            tel_received += _int(d.get("received")) or 0
            tel_written += _int(d.get("written")) or 0
            tel_errors += _int(d.get("errors")) or 0
        out["telemetryBuckets"] = buckets
        if buckets and out["received"] is None:
            out["received"] = tel_received
            out["receivedSource"] = "data_saver_telemetry.received(sum)"
        if buckets and out["persisted"] is None:
            out["persisted"] = tel_written
            out["persistedSource"] = "data_saver_telemetry.written(sum)"
        if buckets and out["failed"] is None:
            out["failed"] = tel_errors
            out["failedSource"] = "data_saver_telemetry.errors(sum)"
    except Exception:
        logger.debug("telemetry day read failed", exc_info=True)
    return out


def db_writer_session_counters() -> dict:
    """Process-lifetime DB Write Engine counters (source split + skips).

    These are session-scoped, never day-scoped -- callers must label them.
    """
    try:
        from services.db_writer_engine import db_writer_engine

        snap = db_writer_engine.status_snapshot()
        custom = ((snap.get("metrics") or {}).get("custom")) or {}
        accounting = snap.get("dataLossAccounting") or {}
        started = ((snap.get("pipeline") or {}).get("pipelineStartedAt"))
    except Exception:
        logger.debug("db_writer_engine snapshot failed", exc_info=True)
        return {}

    source_keys = (
        ("personalNoExpiry", "personalNoExpiryAccepted", "personalNoExpirySkipped"),
        ("personalOneDay", "personalExpiryAccepted", "personalExpirySkipped"),
        ("marketWatchOneDay", "marketWatchAccepted", "marketWatchSkipped"),
    )
    sources = []
    for name, acc_key, skip_key in source_keys:
        accepted = _int(custom.get(acc_key))
        skipped = _int(custom.get(skip_key))
        if accepted is None and skipped is None:
            continue
        sources.append({
            "source": name,
            "received": None,
            "persisted": None,
            "skipped": skipped,
            "accepted": accepted,
        })
    unknown_skipped = _int(custom.get("unknownSourceSkipped")) or 0
    deduped = _int(custom.get("overlappingSourcesDeduped")) or 0
    drop_reasons = custom.get("dropReasons") or {}
    if isinstance(drop_reasons, dict):
        total_dropped = sum(_int(v) or 0 for v in drop_reasons.values())
    else:
        total_dropped = 0

    total_skipped = 0
    for s in sources:
        total_skipped += s.get("skipped") or 0
    total_skipped += unknown_skipped + total_dropped

    return {
        "received": _int(custom.get("ingestedFromRouter")),
        "validated": _int(custom.get("acceptedForPersistence")),
        "rejectedByValidation": _int(custom.get("rejectedByValidation")),
        "duplicatesRejected": _int(custom.get("duplicatesRejected")),
        "buffered": _int(custom.get("bufferLength")),
        "persisted": _int(custom.get("totalWritten")),
        "failed": _int(custom.get("totalWriteErrors")),
        "skipped": total_skipped,
        "unknownSourceSkipped": unknown_skipped,
        "overlappingSourcesDeduped": deduped,
        "dropReasons": drop_reasons if isinstance(drop_reasons, dict) else {},
        "sources": sources,
        "dataLossAccounting": accounting,
        "startedAt": started,
        "scope": "session",
    }


# --------------------------------------------------------------------------- #
# Quality / latency / storage slices for a day
# --------------------------------------------------------------------------- #

async def quality_slice(db, date_str: str, doc_count: int) -> Optional[dict]:
    """Compact quality dimensions for the day (Data Quality owns the engine)."""
    try:
        from services import data_quality
    except Exception:
        return None
    try:
        start, end = day_window(date_str)
        # Pass the window as ``extra_match`` as well as the overrides: the
        # Data Quality cache key is built from (hours, symbol, extra_match)
        # only, so without it two different days built within the 60 s TTL
        # would silently share one cached result (020-style cache collision).
        metrics = await data_quality._compute_metrics(
            hours=24,
            use_cache=True,
            extra_match={"ts": {"$gte": start, "$lt": end}},
            start_override=start,
            end_override=end,
        )
    except Exception:
        logger.debug("quality slice failed", exc_info=True)
        return None
    if not isinstance(metrics, dict):
        return None
    totals = metrics.get("totals") or {}
    errors = metrics.get("errors") or {}
    rates = metrics.get("rates") or {}
    freshness = metrics.get("freshness") or {}
    total = _int(totals.get("totalTicks"))
    if total is None:
        total = doc_count
    return {
        "total": total,
        "valid": _int(totals.get("validTicks")),
        "invalid": _int(errors.get("invalidTicks")),
        "duplicate": _int(errors.get("duplicates")),
        "outOfOrder": _int(errors.get("outOfOrder")),
        "missing": _int(errors.get("missingTicks")),
        "invalidTimestamps": _int(errors.get("invalidTimestamps")),
        "malformed": _int(errors.get("malformedPayloads")),
        "duplicateRate": _fnum(rates.get("duplicateRate")),
        "outOfOrderRate": _fnum(rates.get("outOfOrderRate")),
        "missingRate": _fnum(rates.get("missingRate")),
        "score": _fnum(metrics.get("score")),
        "freshness": {
            "status": freshness.get("status"),
            "ageSec": _fnum(freshness.get("ageSec")),
            "thresholdSec": _fnum(freshness.get("thresholdSec")),
        } if freshness else None,
        "source": "DATA_QUALITY_ENGINE",
    }


def latency_slice() -> Optional[dict]:
    """Measured hop-to-hop latency from the pipeline latency instrumentation."""
    try:
        from services import pipeline_latency
    except Exception:
        return None
    try:
        stats = pipeline_latency.stats()
    except Exception:
        return None
    stages = stats.get("stages") or {}
    agenda = stats.get("agenda") or {}
    if not stages:
        return None

    def _stage(name: str) -> Optional[dict]:
        block = stages.get(name)
        if not block:
            return None
        return {
            "label": block.get("label"),
            "avgMs": block.get("avg_ms"),
            "p95Ms": block.get("p95_ms"),
            "maxMs": block.get("max_ms"),
            "samples": block.get("samples"),
        }

    hops = {
        "feedToBackend": _stage("broker_to_ws") or _stage("ws_recv_to_feature_done"),
        "backendToAnalytics": _stage("ws_recv_to_cm_recv") or _stage("ws_recv_to_ui_send"),
        "backendToDbWriter": _stage("ws_recv_to_db_writer"),
        "dbWriterToMongo": _stage("ws_recv_to_mongo"),
    }
    return {
        "hops": hops,
        "available": any(v is not None for v in hops.values()),
        "scope": "process",
        "semantics": stats.get("semantics"),
        "source": "PIPELINE_LATENCY",
    }


async def storage_slice(db, doc_count: int) -> dict:
    """Storage attribution for the tick collection (real collstats)."""
    out: dict[str, Any] = {
        "collection": "ticks",
        "bytes": None,
        "avgBytesPerTick": None,
        "estimated": True,
        "reason": None,
    }
    if not is_mongo_connected():
        out["reason"] = "MONGO_NOT_CONNECTED"
        return out
    try:
        stats = await db.command("collstats", "ticks")
    except Exception as exc:
        out["reason"] = f"COLLSTATS_UNAVAILABLE: {type(exc).__name__}"
        return out
    avg = stats.get("avgObjSize")
    if isinstance(avg, (int, float)) and avg > 0:
        out["avgBytesPerTick"] = int(avg)
        if doc_count:
            out["bytes"] = int(avg * doc_count)
    out["collectionStorageBytes"] = _int(stats.get("size"))
    out["collectionCount"] = _int(stats.get("count"))
    out["indexBytes"] = _int(stats.get("totalIndexSize"))
    if out["bytes"] is None:
        out["reason"] = "AVG_OBJ_SIZE_UNAVAILABLE"
    return out


# --------------------------------------------------------------------------- #
# The per-day aggregation
# --------------------------------------------------------------------------- #

async def _aggregate_day(db, date_str: str) -> dict:
    """Indexed, bounded, time-boxed aggregation over ONE IST day of ticks."""
    start, end = day_window(date_str)
    match = {"ts": {"$gte": start, "$lt": end}}

    try:
        doc_count = int(await asyncio.wait_for(db.ticks.count_documents(match), timeout=8.0))
    except Exception:
        logger.debug("day doc count failed", exc_info=True)
        doc_count = 0

    result = {
        "docCount": doc_count,
        "seconds": [],
        "symbols": [],
        "minuteSymbol": [],
        "aggregated": False,
        "reason": None,
    }
    if doc_count <= 0:
        result["reason"] = "NO_TICKS_FOR_DAY"
        return result

    ist_fmt = "%H:%M"
    seconds_pipe = [
        {"$match": match},
        {"$group": {
            "_id": {"$subtract": [{"$toLong": "$ts"}, {"$mod": [{"$toLong": "$ts"}, 1000]}]},
            "n": {"$sum": 1},
        }},
        {"$sort": {"_id": 1}},
    ]
    symbols_pipe = [
        {"$match": match},
        {"$group": {
            "_id": "$symbol",
            "n": {"$sum": 1},
            "first": {"$min": "$ts"},
            "last": {"$max": "$ts"},
        }},
        {"$sort": {"n": -1}},
        {"$limit": MAX_SYMBOL_STATS},
    ]

    heavy = doc_count <= EXPENSIVE_DAY_DOC_LIMIT
    pipeline = [
        {"$match": match},
        {"$facet": {
            "seconds": seconds_pipe,
            "symbols": symbols_pipe,
            **(
                {"minuteSymbol": [
                    {"$match": match},
                    {"$group": {
                        "_id": {
                            "m": {"$dateToString": {"date": "$ts", "timezone": "Asia/Kolkata", "format": ist_fmt}},
                            "s": "$symbol",
                        },
                    }},
                ]} if heavy else {}
            ),
        }},
    ]

    try:
        cursor = db.ticks.aggregate(pipeline, allowDiskUse=True, maxTimeMS=AGG_MAXTIMEMS_MS)
        facets = await asyncio.wait_for(cursor.to_list(length=4), timeout=AGG_TIMEOUT_SEC)
    except Exception as exc:
        logger.warning("tick analytics day aggregation failed for %s: %s", date_str, exc)
        result["reason"] = f"AGGREGATION_FAILED: {type(exc).__name__}"
        return result

    facet = facets[0] if facets else {}
    result["seconds"] = facet.get("seconds") or []
    result["symbols"] = facet.get("symbols") or []
    result["minuteSymbol"] = facet.get("minuteSymbol") or []
    result["aggregated"] = True
    if not heavy:
        result["reason"] = "RATE_METRICS_SKIPPED_DAY_TOO_LARGE"
    return result


# --------------------------------------------------------------------------- #
# Build / read a day document
# --------------------------------------------------------------------------- #

def _empty_doc(date_str: str, reason: str) -> dict:
    b = session_boundaries(date_str)
    now = iso_ist(now_ist())
    return {
        "schema": SCHEMA,
        "date": date_str,
        "tradingDay": b["tradingDay"],
        "dayClass": b["dayClass"],
        "closureReason": b["closureReason"],
        "status": "NO_DATA",
        "counts": {
            "received": None, "persisted": None, "failed": None, "skipped": None,
            "symbols": 0, "storedDocs": 0,
        },
        "sources": {},
        "ticks": {
            "count": 0, "firstTickAt": None, "lastTickAt": None,
            "activeDurationSec": 0.0, "avgTickRate": None, "peakTickRate": None,
        },
        "rate": {"avg": None, "peak": None, "min": None, "p50": None, "activeSeconds": 0},
        "storage": {"collection": "ticks", "bytes": None, "avgBytesPerTick": None, "estimated": True},
        "persistence": {"received": None, "persisted": None, "failed": None, "skipped": None, "successPct": None},
        "session": {
            "marketOpenAt": b["marketOpenAt"], "marketCloseAt": b["marketCloseAt"],
            "firstTickAt": None, "peakActivityAt": None, "lowestActivityAt": None,
            "lastTickAt": None, "activeDurationSec": 0.0,
        },
        "periods": [],
        "minuteBuckets": [],
        "symbolStats": [],
        "symbolStatsTruncated": False,
        "quality": None,
        "latency": None,
        "anomalies": [],
        "missing": [reason],
        "builtAt": now,
        "updatedAt": now,
    }


async def build_day(date_str: str, *, persist: bool = True) -> dict:
    """Build (and optionally persist) the authoritative document for a day."""
    await ensure_indexes()
    b = session_boundaries(date_str)
    doc = _empty_doc(date_str, "PENDING_BUILD")

    if not is_mongo_connected():
        doc["missing"] = ["MONGO_NOT_CONNECTED"]
        doc["status"] = "UNAVAILABLE"
        return doc

    db = get_db()
    agg = await _aggregate_day(db, date_str)
    writer = await _writer_counters(db, date_str)

    doc["counts"]["storedDocs"] = agg["docCount"]
    doc["counts"]["received"] = writer.get("received")
    doc["counts"]["persisted"] = writer.get("persisted")
    doc["counts"]["failed"] = writer.get("failed")

    sources: dict[str, Optional[str]] = {
        "received": writer.get("receivedSource"),
        "persisted": writer.get("persistedSource"),
        "failed": writer.get("failedSource"),
        "storedDocs": "mongodb:ticks.count(ts-in-day)" if agg["docCount"] else None,
        "symbols": "mongodb:ticks.distinct(symbol-in-day)" if agg["symbols"] else None,
    }

    # --- structural tick facts ------------------------------------------------
    seconds = reduce_seconds(agg["seconds"])
    first_ms, last_ms = seconds.get("firstMs"), seconds.get("lastMs")

    symbol_stats: list[dict] = []
    for row in agg["symbols"]:
        sym = str(row.get("_id") or "").strip()
        if not sym:
            continue
        n = _int(row.get("n")) or 0
        f = row.get("first")
        l = row.get("last")
        f_ms = int(f.timestamp() * 1000) if isinstance(f, datetime) else None
        l_ms = int(l.timestamp() * 1000) if isinstance(l, datetime) else None
        dur = None
        if f_ms is not None and l_ms is not None and l_ms > f_ms:
            dur = (l_ms - f_ms) / 1000.0
        symbol_stats.append({
            "symbol": sym,
            "ticks": n,
            "firstTickAt": _iso(f),
            "lastTickAt": _iso(l),
            "activeDurationSec": round(dur, 3) if dur else None,
            "avgRate": _safe_div(n, dur) if dur else None,
            "sharePct": _pct(n, agg["docCount"]),
        })
    doc["symbolStats"] = symbol_stats
    doc["symbolStatsTruncated"] = len(symbol_stats) >= MAX_SYMBOL_STATS

    if agg["seconds"]:
        active_dur = None
        if first_ms is not None and last_ms is not None and last_ms > first_ms:
            active_dur = (last_ms - first_ms) / 1000.0
        doc["ticks"] = {
            "count": seconds["count"],
            "firstTickAt": _ms_iso(first_ms),
            "lastTickAt": _ms_iso(last_ms),
            "activeDurationSec": round(active_dur, 3) if active_dur is not None else None,
            "avgTickRate": _safe_div(seconds["count"], active_dur),
            "peakTickRate": seconds.get("peakPerSec"),
            "activeSeconds": seconds.get("activeSeconds"),
        }
        doc["rate"] = {
            "avg": seconds.get("avgPerSec"),
            "peak": seconds.get("peakPerSec"),
            "min": seconds.get("minPerSec"),
            "p50": seconds.get("p50PerSec"),
            "activeSeconds": seconds.get("activeSeconds"),
        }
        minute_buckets = minute_rollup(seconds["series"], date_str)
        period_symbols = fold_minute_symbols(agg["minuteSymbol"], date_str)
        doc["minuteBuckets"] = minute_buckets
        doc["periods"] = fold_periods(build_periods(date_str), minute_buckets, period_symbols)
    else:
        doc["minuteBuckets"] = []
        doc["periods"] = []

    # --- persistence ---------------------------------------------------------
    received = doc["counts"]["received"]
    persisted = doc["counts"]["persisted"]
    failed = doc["counts"]["failed"]
    writer_activity = any((_fnum(v) or 0) > 0 for v in (received, persisted, failed))
    session_counters = db_writer_session_counters()
    skipped = session_counters.get("skipped")
    doc["persistence"] = {
        "received": received,
        "persisted": persisted,
        "failed": failed,
        "skipped": skipped,
        "successPct": _pct(persisted, received),
        "skippedScope": "session" if skipped is not None else None,
        "session": session_counters or None,
    }
    if skipped is not None:
        sources["skipped"] = "db_writer_engine.session(drop+source-skips)"

    # --- session -------------------------------------------------------------
    peak_at = None
    lowest_at = None
    if agg["seconds"]:
        peak_row = max(agg["seconds"], key=lambda r: (_int(r.get("n")) or 0))
        non_zero = [r for r in agg["seconds"] if (_int(r.get("n")) or 0) > 0]
        low_row = min(non_zero, key=lambda r: (_int(r.get("n")) or 0)) if non_zero else None
        peak_at = _ms_iso(_int(peak_row.get("_id")))
        lowest_at = _ms_iso(_int(low_row.get("_id"))) if low_row else None

    doc["session"] = {
        "marketOpenAt": b["marketOpenAt"],
        "marketCloseAt": b["marketCloseAt"],
        "firstTickAt": doc["ticks"].get("firstTickAt"),
        "peakActivityAt": peak_at,
        "lowestActivityAt": lowest_at,
        "lastTickAt": doc["ticks"].get("lastTickAt"),
        "activeDurationSec": doc["ticks"].get("activeDurationSec"),
    }

    # --- storage / quality / latency ----------------------------------------
    doc["storage"] = await storage_slice(db, agg["docCount"])
    sources["storage"] = "mongodb:collstats(ticks).avgObjSize * day-doc-count"
    doc["quality"] = (await quality_slice(db, date_str, agg["docCount"])) if agg["docCount"] else None
    doc["latency"] = latency_slice()

    # --- anomalies (only real, derived observations) --------------------------
    anomalies: list[dict] = []
    if doc["ticks"].get("count") and not agg["aggregated"]:
        anomalies.append({
            "code": "DAY_AGGREGATION_DEGRADED",
            "severity": "warning",
            "message": agg.get("reason") or "day aggregation incomplete",
        })
    if received is not None and persisted is not None and persisted > received:
        anomalies.append({
            "code": "PERSISTED_EXCEEDS_RECEIVED",
            "severity": "warning",
            "message": "persisted count exceeds received count for the day",
        })
    if b["tradingDay"] and agg["docCount"] == 0:
        anomalies.append({
            "code": "NO_TICKS_ON_TRADING_DAY",
            "severity": "warning",
            "message": "trading day recorded with zero persisted ticks",
        })
    if doc["quality"] and (doc["quality"].get("duplicateRate") or 0) > 5.0:
        anomalies.append({
            "code": "HIGH_DUPLICATE_RATE",
            "severity": "warning",
            "message": f"duplicate rate {doc['quality']['duplicateRate']}% for the day",
        })
    doc["anomalies"] = anomalies

    # --- completeness --------------------------------------------------------
    missing: list[str] = []
    if received is None:
        missing.append("ticksReceived")
    if persisted is None:
        missing.append("ticksPersisted")
    if not agg["seconds"]:
        missing.append("tickTimeline")
    if agg["docCount"] and not agg["aggregated"]:
        missing.append("rateMetrics")
    if agg["docCount"] == 0 and writer_activity:
        # The writer recorded activity for this day but no tick documents were
        # retained. Reporting NO_DATA here would hide that fact, so report
        # PARTIAL and name exactly what is absent instead.
        if "storedTickDocuments" not in missing:
            missing.append("storedTickDocuments")
        anomalies.append({
            "code": "NO_STORED_DOCUMENTS_FOR_DAY",
            "severity": "warning",
            "message": (
                f"writer recorded {received} tick(s) for {date_str} but the ticks "
                "collection holds no documents for the day"
            ),
        })
        doc["anomalies"] = anomalies

    doc["missing"] = missing
    doc["tradingDay"] = b["tradingDay"]
    doc["dayClass"] = b["dayClass"]
    doc["closureReason"] = b["closureReason"]
    doc["sources"] = sources
    if agg["docCount"] == 0 and not writer_activity:
        doc["status"] = "NO_DATA"
    else:
        doc["status"] = "PARTIAL" if missing else "COMPLETE"
    doc["builtAt"] = iso_ist(now_ist())
    doc["updatedAt"] = doc["builtAt"]

    if persist:
        try:
            await _persist(doc)
        except Exception:
            logger.debug("daily doc persist failed", exc_info=True)
    return doc


def _ms_iso(ms: Optional[int]) -> Optional[str]:
    if ms is None:
        return None
    try:
        return iso_ist(datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc))
    except (OverflowError, OSError, ValueError):
        return None


async def _persist(doc: dict) -> None:
    db = get_db()
    payload = dict(doc)
    payload.pop("_id", None)
    await db[COLL].update_one(
        {"date": doc["date"]},
        {"$set": payload},
        upsert=True,
    )
    _day_cache[doc["date"]] = (time.monotonic(), doc)


# --------------------------------------------------------------------------- #
# Public read API
# --------------------------------------------------------------------------- #

async def get_day(date_str: str, *, refresh: bool = False) -> dict:
    """Read (or build) the daily document. Cached; past days never rebuild."""
    try:
        datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        return _empty_doc(date_str, "INVALID_DATE")

    today = is_today(date_str)
    ttl = TODAY_TTL_SEC if today else None

    if not refresh:
        cached = _day_cache.get(date_str)
        if cached is not None:
            at, doc = cached
            if ttl is None or time.monotonic() - at < ttl:
                return doc

    if is_mongo_connected():
        await ensure_indexes()
        # refresh=True means "recompute now" -- it must never be short-circuited
        # by a stored document, otherwise a queued backfill day would silently
        # re-serve the stale document it was queued to rebuild.
        if not refresh:
            try:
                db = get_db()
                stored = await db[COLL].find_one({"date": date_str})
            except Exception:
                stored = None
                logger.debug("daily doc read failed", exc_info=True)
            if stored is not None:
                fresh_enough = True
                if today:
                    updated = stored.get("updatedAt")
                    age = None
                    if isinstance(updated, datetime):
                        age = (now_ist() - updated.astimezone(IST)).total_seconds()
                    fresh_enough = age is None or age < TODAY_TTL_SEC
                if fresh_enough or not today:
                    _day_cache[date_str] = (time.monotonic(), stored)
                    if fresh_enough:
                        return stored

    doc = await build_day(date_str, persist=True)
    return doc


SUMMARY_FIELDS = {
    "_id": 0,
    "date": 1, "tradingDay": 1, "dayClass": 1, "closureReason": 1,
    "status": 1, "counts": 1, "ticks": 1, "rate": 1, "persistence": 1,
    "storage": 1, "session": 1, "missing": 1, "builtAt": 1, "updatedAt": 1,
    "schema": 1, "sources": 1, "anomalies": 1,
}


async def list_days(days: int = DEFAULT_DAYS, *, build_missing: bool = True) -> dict:
    """Summary rows for the daily table + chart.

    NEVER aggregates on the call path: it reads stored documents only and
    queues missing days for the background backfill loop.
    """
    days = max(1, min(int(days), MAX_DAYS))
    key = (days,)
    cached = _list_cache.get(key)
    if cached is not None and time.monotonic() - cached[0] < TODAY_TTL_SEC:
        rows = cached[1]
    else:
        rows = await _list_days_impl(days)
        _list_cache[key] = (time.monotonic(), rows)

    present = {r.get("date") for r in rows}
    wanted = recent_days(days)
    missing = [d for d in wanted if d not in present]
    if missing and build_missing:
        queue_backfill(missing)
    return {
        "days": days,
        "count": len(rows),
        "rows": rows,
        "missingDates": missing,
        "pendingBackfill": len([d for d in missing if d not in _backfill_done]),
        "backfill": backfill_state(),
        "generatedAt": iso_ist(now_ist()),
    }


async def _list_days_impl(days: int) -> list[dict]:
    if not is_mongo_connected():
        return []
    await ensure_indexes()
    db = get_db()
    wanted = recent_days(days)
    try:
        cur = db[COLL].find({"date": {"$in": wanted}}, SUMMARY_FIELDS).sort("date", -1)
        docs = await cur.to_list(length=MAX_DAYS)
    except Exception:
        logger.debug("daily list read failed", exc_info=True)
        return []
    out = []
    for d in docs:
        row = dict(d)
        row.pop("_id", None)
        out.append(row)
    return out


async def top_symbols(date_str: str, *, limit: int = 10, offset: int = 0) -> dict:
    """Ranked per-symbol activity for a day (backend-bounded)."""
    limit = max(1, min(int(limit), 50))
    offset = max(0, int(offset))
    doc = await get_day(date_str)
    stats = list(doc.get("symbolStats") or [])
    stats.sort(key=lambda r: -(r.get("ticks") or 0))
    total = len(stats)
    return {
        "date": date_str,
        "total": total,
        "limit": limit,
        "offset": offset,
        "truncated": bool(doc.get("symbolStatsTruncated")),
        "rows": stats[offset:offset + limit],
        "source": (doc.get("sources") or {}).get("symbols"),
        "status": doc.get("status"),
    }


async def symbol_day(date_str: str, symbol: str) -> dict:
    """One symbol's statistics for one day (None when it did not tick)."""
    symbol = str(symbol or "").strip().upper()
    doc = await get_day(date_str)
    for row in doc.get("symbolStats") or []:
        if str(row.get("symbol") or "").upper() == symbol:
            return {"date": date_str, "symbol": symbol, "found": True, "row": row}
    return {"date": date_str, "symbol": symbol, "found": False, "row": None}


def queue_backfill(dates: list[str]) -> None:
    for d in dates:
        if d in _backfill_done or d in _backfill_queue:
            continue
        _backfill_queue.append(d)


async def backfill_once(limit: int = 3) -> int:
    """Build at most ``limit`` queued days. Called by the background loop."""
    global _backfill_running
    if _backfill_running or not _backfill_queue:
        return 0
    _backfill_running = True
    built = 0
    try:
        while built < limit and _backfill_queue:
            date_str = _backfill_queue.pop(0)
            if date_str in _backfill_done:
                continue
            if is_today(date_str):
                # The current day is served by the normal refresh path; do not
                # pin it in the backfill set.
                continue
            try:
                doc = await get_day(date_str, refresh=True)
                if (doc or {}).get("status") == "UNAVAILABLE":
                    # Mongo was down -- keep the date queued so the next pass
                    # retries instead of silently marking the day complete.
                    _backfill_queue.append(date_str)
                    break
                _backfill_done.add(date_str)
                built += 1
            except Exception:
                logger.debug("backfill failed for %s", date_str, exc_info=True)
                _backfill_queue.append(date_str)
                break
    finally:
        _backfill_running = False
    return built


def backfill_state() -> dict:
    return {
        "queued": len(_backfill_queue),
        "completed": len(_backfill_done),
        "running": _backfill_running,
    }


def reset_state() -> None:
    """Test helper: clear caches and backfill bookkeeping."""
    global _indexes_ensured, _index_last_attempt, _backfill_running
    _indexes_ensured = False
    _index_last_attempt = 0.0
    _day_cache.clear()
    _list_cache.clear()
    _backfill_queue.clear()
    _backfill_done.clear()
    _backfill_running = False
