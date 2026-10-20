"""
DataQualityService — the authoritative, single source of truth for Data
Quality in the KAUSTUBH trading platform.

Every metric, issue and score in this module is derived from REAL pipeline /
database state. Nothing is fabricated:

  • ticks collection  → completeness, uniqueness, validity, ordering,
                         timestamp / price / volume integrity
  • tick_buffer       → persistence reliability (received/written/errors,
                         queue backlog, flush latency)
  • ws_manager        → live feed freshness (last tick, age, feed state)

The service owns the deterministic Quality Score (a weighted sum of the eight
dimension scores, configured weights persisted in MongoDB) and the complete
issue lifecycle (OPEN → ACKNOWLEDGED → RESOLVED / SUPPRESSED), co-ordinated
with the notification system via ``services.notification_service.notify``.

It is the ONLY place that:
  • computes authoritative metrics (frontend never derives them)
  • defines the quality dimension set and the scoring formula
  • emits ``quality_*`` realtime events to the SSE event bus
  • creates / dedups / resolves persistent issues

The FastAPI router (``api/quality.py``) is a thin HTTP facade over this
service.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from database.connection import get_db, is_mongo_connected
from services import tick_buffer
from ws_socket.ws_manager import ws_manager
from services.instrument_cache import instrument_cache

logger = logging.getLogger("app")

IST_TZ = "Asia/Kolkata"

# --------------------------------------------------------------------------- #
# Simple TTL cache for expensive metric computations
# --------------------------------------------------------------------------- #
_METRIC_CACHE: dict[str, tuple[float, dict]] = {}
_METRIC_CACHE_TTL = 60  # seconds


def _cache_key(hours: int, symbol: str, extra_match: dict | None = None) -> str:
    """Cache key over the FULL filter set.

    The key must include every filter that changes the result, otherwise two
    different filtered views share one cached payload (020 fix: exchange /
    segment / intraday filters previously collided with the unfiltered view).
    """
    if not extra_match:
        return f"{hours}:{symbol}"
    parts = [f"{hours}:{symbol}"]
    for k in sorted(extra_match):
        v = extra_match[k]
        try:
            import json as _json

            parts.append(f"{k}={_json.dumps(v, sort_keys=True, default=str)}")
        except Exception:
            parts.append(f"{k}={v!r}")
    return "|".join(parts)


def _cache_get(key: str) -> dict | None:
    entry = _METRIC_CACHE.get(key)
    if entry and (time.monotonic() - entry[0]) < _METRIC_CACHE_TTL:
        return entry[1]
    _METRIC_CACHE.pop(key, None)
    return None


def _cache_put(key: str, value: dict) -> None:
    _METRIC_CACHE[key] = (time.monotonic(), value)
    if len(_METRIC_CACHE) > 20:
        expired = [k for k, v in _METRIC_CACHE.items() if (time.monotonic() - v[0]) >= _METRIC_CACHE_TTL]
        for k in expired:
            _METRIC_CACHE.pop(k, None)


# --------------------------------------------------------------------------- #
# Persisted collections
# --------------------------------------------------------------------------- #
CONFIG_COLL = "quality_config"
SNAPSHOT_COLL = "quality_snapshot"
ISSUES_COLL = "quality_issues"
SCANS_COLL = "quality_scans"

DEFAULT_CONFIG: dict[str, Any] = {
    "weights": {
        "Completeness": 0.20,
        "Validity": 0.20,
        "Uniqueness": 0.15,
        "Ordering": 0.10,
        "Timestamp": 0.10,
        "Price": 0.10,
        "Volume": 0.05,
        "Persistence": 0.10,
    },
    "thresholds": {
        "qualityWarn": 80,
        "qualityCritical": 60,
        "duplicateRateWarn": 2.0,
        "missingRateWarn": 1.0,
        "staleSeconds": 30,
        "dbFailuresCritical": 0,
        "circuitMissingWarnPercent": 5.0,
    },
    "refreshIntervalSeconds": 30,
    "snapshotRetentionDays": 30,
    "scanIntervalSeconds": 60,
    "issueCooldownSeconds": 300,
    "priceJumpPercent": 15.0,
}

DIMENSIONS = [
    "Completeness",
    "Uniqueness",
    "Validity",
    "Ordering",
    "Timestamp Integrity",
    "Price Integrity",
    "Volume Integrity",
    "Persistence Reliability",
]

# Map the short keys used in snapshots/issues to the displayable dimension names.
DIM_KEY = {
    "Completeness": "Completeness",
    "Uniqueness": "Uniqueness",
    "Validity": "Validity",
    "Ordering": "Ordering",
    "Timestamp": "Timestamp Integrity",
    "Price": "Price Integrity",
    "Volume": "Volume Integrity",
    "Persistence": "Persistence Reliability",
}
# Reverse map: display name → config key
DIM_KEY_REV = {v: k for k, v in DIM_KEY.items()}


# --------------------------------------------------------------------------- #
# Scan state (in-memory, mirrors the last scan run)
# --------------------------------------------------------------------------- #
_SCAN = {
    "status": "idle",          # idle | running | completed | error
    "started_at": None,
    "completed_at": None,
    "expires_at": None,        # next scheduled scan
    "duration_ms": None,
    "records_scanned": 0,
    "issues_found": 0,
    "error": None,
    "trigger": None,           # startup | periodic | manual
    "last_run_id": None,
}
_SCAN_LOCK = asyncio.Lock()


def scan_state() -> dict:
    """Read-only snapshot of the most recent quality scan."""
    now = datetime.now(timezone.utc)
    out = dict(_SCAN)
    st = out.get("started_at")
    out["started_at_iso"] = st.isoformat() if isinstance(st, datetime) else st
    et = out.get("expires_at")
    out["next_scan_at"] = et.isoformat() if isinstance(et, datetime) else et
    out["running"] = out.get("status") == "running"
    return out


# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #
async def load_config() -> dict:
    db = get_db()
    try:
        doc = await db[CONFIG_COLL].find_one({"_id": "default"})
        if doc and isinstance(doc.get("config"), dict):
            saved = doc["config"]
            merged = dict(DEFAULT_CONFIG)
            for k, v in saved.items():
                if isinstance(v, dict) and isinstance(DEFAULT_CONFIG.get(k), dict):
                    merged[k] = {**DEFAULT_CONFIG[k], **v}
                else:
                    merged[k] = v
            return merged
    except Exception as exc:
        logger.warning("quality config load failed: %s", exc)
    return dict(DEFAULT_CONFIG)


async def save_config(config: dict) -> dict:
    db = get_db()
    await db[CONFIG_COLL].replace_one(
        {"_id": "default"}, {"config": config, "updatedAt": datetime.now(timezone.utc)},
        upsert=True,
    )
    return config


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _utc(v: Any) -> str | None:
    if isinstance(v, datetime):
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        return v.astimezone(timezone.utc).isoformat()
    return v


def _pct(part: int, total: int) -> float | None:
    return round((part / total) * 100, 4) if total and total > 0 else None


def _posrate(part: int, total: int) -> float | None:
    """A 'positive rate' (0-100). Returns 100.0 when total is 0 (nothing bad)."""
    if total and total > 0:
        return 100.0 * max(0.0, 1.0 - part / total)
    return 100.0


def _dim_name(key: str) -> str:
    """Resolve a dimension name to its config weight key.

    Accepts both short keys (``Timestamp``) and display names
    (``Timestamp Integrity``) and always returns the short key used
    in the config ``weights`` dict.
    """
    if key in DIM_KEY:
        return key
    return DIM_KEY_REV.get(key, key)


# --------------------------------------------------------------------------- #
# Core metric computation — REAL, bounded, indexed
# --------------------------------------------------------------------------- #
# Bound for the out-of-order walk: the walk is O(window) in Python, so it is
# capped at this many documents and wrapped in a timeout (same contract as
# api.system._compute_quality_metrics). Partial walks keep their partial
# count and set `orderingTruncated: True` so callers never mistake a capped
# scan for a complete one.
_OOO_SCAN_LIMIT = 200_000
_OOO_SCAN_TIMEOUT_S = 8.0
_DUP_AGG_TIMEOUT_S = 8.0


async def _compute_metrics(
    hours: int,
    symbol: str = "",
    use_cache=True,
    extra_match: dict | None = None,
    start_override: datetime | None = None,
    end_override: datetime | None = None,
) -> dict:
    """Compute the real quality dimensions for the inspected window.

    ``extra_match`` carries caller-supplied Mongo filters (exchange, segment,
    intraday ``ts`` range, explicit date window) that are merged into every
    scoped aggregation, so filtered views measure their own slice instead of
    the unfiltered (hours, symbol) scope (020 fix).
    """
    cache_key = _cache_key(hours, symbol, extra_match)
    if use_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached
    db = get_db()
    start = start_override or (
        datetime.now(timezone.utc) - timedelta(hours=min(max(hours, 1), 720))
    )
    match: dict = {"ts": {"$gte": start}}
    if end_override is not None:
        match["ts"] = {"$gte": start, "$lt": end_override}
    if symbol:
        match["symbol"] = symbol
    if extra_match:
        for k, v in extra_match.items():
            if k == "ts" and isinstance(v, dict) and isinstance(match.get("ts"), dict):
                merged_ts = dict(match["ts"])
                merged_ts.update(v)
                match["ts"] = merged_ts
            else:
                match[k] = v
    sym_scope = {"symbol": match["symbol"]} if match.get("symbol") else {}
    if extra_match:
        for fk in ("exchange", "segment"):
            if extra_match.get(fk) and fk not in sym_scope:
                sym_scope[fk] = extra_match[fk]

    try:
        total = await asyncio.wait_for(db.ticks.count_documents(match), timeout=5.0)
    except asyncio.TimeoutError:
        logger.warning("quality total count timed out, reporting 0 with truncated flag")
        total = 0
    except Exception as exc:
        logger.warning("quality total count failed: %s", exc)
        total = 0

    # ---- Uniqueness: duplicates with a deterministic observation identity ----
    # Identity = (instrumentToken, ts, ltp, volume, bp, sp). Repeated live
    # snapshots that are byte-identical (same token, same broker timestamp,
    # same price/volume) are true redundant rows; a same-timestamp but
    # different-price tick is NOT a duplicate. This avoids flagging legitimate
    # repeated ticks solely because they share a price or a timestamp.
    duplicates = 0
    if total > 0:
        # Only groups with n > 1 carry redundant rows. `duplicates` = the number
        # of redundant rows (sum of n-1 over duplicate groups) — the true share
        # of persisted rows that are exact repeats of an earlier observation.
        dup_pipeline = [
            {"$match": match},
            {"$group": {
                "_id": {
                    "token": "$instrumentToken",
                    "ts": "$ts",
                    "ltp": {"$ifNull": [{"$cond": [
                        {"$ne": [{"$ifNull": ["$master_canonical", None]}, None]},
                        "$master_canonical.price.last_traded_price",
                        "$ltp",
                    ]}, None]},
                    "volume": {"$ifNull": [{"$cond": [
                        {"$ne": [{"$ifNull": ["$master_canonical", None]}, None]},
                        "$master_canonical.volume.volume_traded_today",
                        "$volume",
                    ]}, None]},
                    "bp": {"$ifNull": [{"$cond": [
                        {"$eq": [{"$ifNull": ["$master_canonical.depth.buy", None]}, None]},
                        "$bp",
                        {"$getField": {"field": "price", "input": {"$arrayElemAt": ["$master_canonical.depth.buy", 0]}}},
                    ]}, None]},
                    "sp": {"$ifNull": [{"$cond": [
                        {"$eq": [{"$ifNull": ["$master_canonical.depth.sell", None]}, None]},
                        "$sp",
                        {"$getField": {"field": "price", "input": {"$arrayElemAt": ["$master_canonical.depth.sell", 0]}}},
                    ]}, None]},
                },
                "n": {"$sum": 1},
            }},
            {"$match": {"n": {"$gt": 1}}},
            {"$group": {"_id": None, "excess": {"$sum": {"$subtract": ["$n", 1]}}}},
        ]
        try:
            async def _dup_agg():
                return await db.ticks.aggregate(
                    dup_pipeline, maxTimeMS=15000
                ).to_list(1)

            res = await asyncio.wait_for(_dup_agg(), timeout=_DUP_AGG_TIMEOUT_S)
            duplicates = int(res[0]["excess"]) if res else 0
        except asyncio.TimeoutError:
            logger.warning("duplicate aggregation timed out; reporting 0 (truncated)")
        except Exception as exc:
            logger.warning("duplicate aggregation failed: %s", exc)

    # ---- Timestamp integrity ----
    ts_errors_filter = {
        "$or": [
            {"ts": {"$exists": False}},
            {"ts": None},
            {"ts": {"$type": "string"}},
        ]
    }
    try:
        timestamp_errors = await db.ticks.count_documents({**sym_scope, **ts_errors_filter})
    except Exception:
        timestamp_errors = 0

    # ---- Price integrity (missing / non-numeric LTP) ----
    invalid_ltp = 0
    try:
        invalid_ltp = await db.ticks.count_documents({
            **match,
            "$or": [
                {"ltp": {"$exists": False}},
                {"ltp": None},
                {"ltp": {"$type": "string"}},
                {"master_canonical": {"$exists": True}, "master_canonical.price.last_traded_price": {"$exists": False}},
                {"master_canonical": {"$exists": True}, "master_canonical.price.last_traded_price": None},
                {"master_canonical": {"$exists": True}, "master_canonical.price.last_traded_price": {"$type": "string"}},
            ],
        })
    except Exception:
        invalid_ltp = 0

    # ---- Volume integrity (missing / non-numeric / negative) ----
    invalid_volume = 0
    try:
        invalid_volume = await db.ticks.count_documents({
            **match,
            "$or": [
                {"volume": {"$exists": False}},
                {"volume": None},
                {"volume": {"$type": "string"}},
                {"volume": {"$lt": 0}},
                {"master_canonical": {"$exists": True}, "master_canonical.volume.volume_traded_today": {"$exists": False}},
                {"master_canonical": {"$exists": True}, "master_canonical.volume.volume_traded_today": None},
                {"master_canonical": {"$exists": True}, "master_canonical.volume.volume_traded_today": {"$type": "string"}},
                {"master_canonical": {"$exists": True}, "master_canonical.volume.volume_traded_today": {"$lt": 0}},
            ],
        })
    except Exception:
        invalid_volume = 0

    # ---- Validity (schema: required fields present + numeric) ----
    try:
        schema_errors = await db.ticks.count_documents({
            **match,
            "$or": [
                {"symbol": {"$in": [None, ""]}},
                {"instrumentToken": {"$in": [None, ""]}},
                {"ltp": {"$in": [None, ""]}},
                {"master_canonical": {"$exists": True}, "master_canonical.price.last_traded_price": {"$in": [None, ""]}},
            ],
        })
    except Exception:
        schema_errors = 0

    # ---- Ordering (ts older than previous for the same symbol) ----
    # Bounded walk: capped document count + hard timeout (same contract as
    # api.system._compute_quality_metrics). A capped walk keeps its partial
    # count and reports `orderingTruncated: True` — never a silent undercount.
    out_of_order = 0
    scanned_ooo = 0
    ordering_truncated = False
    if total > 0:
        last_ts: dict[str, datetime] = {}

        async def _ooo_walk():
            nonlocal out_of_order, scanned_ooo, ordering_truncated
            cursor = (
                db.ticks.find(match, {"symbol": 1, "ts": 1})
                .sort("ts", 1)
                .limit(_OOO_SCAN_LIMIT)
            )
            try:
                cursor = cursor.max_time_ms(15000)
            except Exception:
                pass
            async for doc in cursor:
                sym = doc.get("symbol")
                ts = doc.get("ts")
                if not sym or not isinstance(ts, datetime):
                    continue
                seen = last_ts.get(sym)
                if seen is not None and ts < seen:
                    out_of_order += 1
                last_ts[sym] = ts
                scanned_ooo += 1
                if scanned_ooo >= _OOO_SCAN_LIMIT:
                    ordering_truncated = True
                    break

        try:
            await asyncio.wait_for(_ooo_walk(), timeout=_OOO_SCAN_TIMEOUT_S)
        except asyncio.TimeoutError:
            ordering_truncated = True
            logger.warning(
                "out-of-order scan timed out after %ss rows; partial count kept",
                scanned_ooo,
            )
        except Exception as exc:
            logger.warning("out-of-order scan failed: %s", exc)

    # ---- Persistence reliability (real buffer + daily summary) ----
    stats = tick_buffer.stats()
    received = int(stats.get("totalReceived") or 0)
    written = int(stats.get("totalWritten") or 0)
    write_errors = int(stats.get("totalWriteErrors") or 0)
    save_failures = write_errors
    attempted_saves = written
    try:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        summary = await db.daily_summaries.find_one({"date": today})
        if summary:
            save_failures += int(summary.get("errorCount", 0) or 0)
            attempted_saves += int(summary.get("totalWrites", 0) or 0)
    except Exception:
        pass

    # ---- Freshness (from real ws manager last tick) ----
    ws = ws_manager.status()
    last_tick_raw = ws.get("last_tick_at")
    last_tick_iso = None
    age_seconds = None
    if last_tick_raw:
        try:
            last_dt = datetime.fromisoformat(str(last_tick_raw))
            if last_dt.tzinfo is None:
                last_dt = last_dt.replace(tzinfo=timezone.utc)
            age_seconds = max(0.0, (datetime.now(timezone.utc) - last_dt).total_seconds())
            last_tick_iso = last_dt.isoformat()
        except Exception:
            pass
    # Also consider the freshest tick actually in the DB for the window.
    db_last = None
    try:
        latest = await db.ticks.find_one(match, {"ts": 1}, sort=[("ts", -1)])
        if latest and isinstance(latest.get("ts"), datetime):
            lt = latest["ts"]
            if lt.tzinfo is None:
                lt = lt.replace(tzinfo=timezone.utc)
            db_last = lt.isoformat()
    except Exception:
        pass

    window_to = end_override or datetime.now(timezone.utc)
    result = {
        "window": {
            "hours": hours,
            "symbol": symbol or "all",
            "from": start.isoformat(),
            "to": window_to.isoformat(),
            "filtered": bool(extra_match),
            "filters": dict(extra_match or {}),
            "orderingTruncated": ordering_truncated,
            "orderingScanned": scanned_ooo,
            "orderingScanLimit": _OOO_SCAN_LIMIT,
        },
        "totals": {
            "totalTicks": total,
            "uniqueSymbols": len(
                await _distinct_symbols(start, symbol, extra_match, end_override)
            ),
            "attemptedSaves": attempted_saves,
            "received": received,
            "written": written,
        },
        "errors": {
            "missing": None,
            "duplicates": duplicates,
            "outOfOrder": out_of_order,
            "timestampErrors": timestamp_errors,
            "invalidLtp": invalid_ltp,
            "invalidVolume": invalid_volume,
            "schemaErrors": schema_errors,
            "saveFailures": save_failures,
        },
        "rates": {
            "duplicateRate": _pct(duplicates, total),
            "outOfOrderRate": _pct(out_of_order, total),
            "timestampErrorRate": _pct(timestamp_errors, total),
            "ltpErrorRate": _pct(invalid_ltp, total),
            "volumeErrorRate": _pct(invalid_volume, total),
            "schemaErrorRate": _pct(schema_errors, total),
            "saveFailureRate": _pct(save_failures, attempted_saves) if attempted_saves else None,
        },
        "freshness": {
            "latestTick": last_tick_iso or db_last,
            "ageSeconds": round(age_seconds, 1) if age_seconds is not None else None,
            "dbLatestTick": db_last,
        },
        "pipeline": {
            "received": received,
            "written": written,
            "writeErrors": write_errors,
            "bufferLength": stats.get("bufferLength"),
            "bufferMaxSize": stats.get("bufferMaxSize"),
            "pipelineRunning": stats.get("pipelineRunning"),
            "lastFlushAt": stats.get("lastFlushAt"),
            "flushDurationMs": stats.get("lastFlushDurationMs"),
            "latency": stats.get("feedLatencyMs"),
        },
        "websocket": ws,
    }
    if use_cache:
        _cache_put(cache_key, result)
    return result


async def _distinct_symbols(
    start: datetime,
    symbol: str,
    extra_match: dict | None = None,
    end_override: datetime | None = None,
) -> list[str]:
    db = get_db()
    match: dict = {"ts": {"$gte": start}}
    if end_override is not None:
        match["ts"] = {"$gte": start, "$lt": end_override}
    if symbol:
        match["symbol"] = symbol
    if extra_match:
        for k, v in extra_match.items():
            if k == "ts" and isinstance(v, dict) and isinstance(match.get("ts"), dict):
                merged = dict(match["ts"])
                merged.update(v)
                match["ts"] = merged
            else:
                match[k] = v
    try:
        return await asyncio.wait_for(
            db.ticks.distinct("symbol", match), timeout=5.0
        )
    except Exception:
        return []


# --------------------------------------------------------------------------- #
# Quality Score — deterministic weighted sum (0-100)
# --------------------------------------------------------------------------- #
def _rate_status(rate: float | None, warn: float, crit: float) -> str:
    if rate is None:
        return "not_measured"
    if rate >= crit:
        return "critical"
    if rate >= warn:
        return "warning"
    return "healthy"


def _dim_detail(name: str, rate: float | None, weight: float, total: int,
                error_count: int, explanation: str,
                warn: float = 1.0, crit: float = 5.0) -> dict:
    score = None
    status = "not_measured"
    if rate is not None:
        status = _rate_status(rate, warn, crit)
    return {
        "name": name,
        "score": None if rate is None else round(max(0.0, min(100.0, 100.0 - rate)), 2),
        "rate": rate,
        "weight": weight,
        "status": status,
        "warn_threshold": warn,
        "crit_threshold": crit,
        "pass_count": total - error_count if rate is not None else None,
        "warning_count": 0,
        "fail_count": error_count if rate is not None else None,
        "affected_records": error_count,
        "explanation": explanation,
        "last_calculated_at": datetime.now(timezone.utc).isoformat(),
    }


def _score_dimensions(metrics: dict, config: dict) -> dict:
    t = int(metrics["totals"]["totalTicks"] or 0)
    e = metrics["errors"]
    r = metrics["rates"]
    p = metrics["pipeline"]
    w = config["weights"]
    now = datetime.now(timezone.utc).isoformat()
    attempted = int(metrics["totals"].get("attemptedSaves") or 0)

    def _d(name, rate, total, err, explanation, warn=None, crit=None):
        wkey = _dim_name(name)
        weight = float(w.get(wkey, 0.0))
        if warn is None:
            warn = float(config["thresholds"].get("duplicateRateWarn", 2.0))
        if crit is None:
            crit = warn * 2.0
        return _dim_detail(name, rate, weight, total, err, explanation, warn=warn, crit=crit)

    # Completeness: ticks received vs expected (t + previously-seen tokens).
    missing = e.get("missing")
    completeness_rate = None
    if t > 0:
        completeness_rate = 0.0  # all received are present
    comp_detail = _d("Completeness", completeness_rate, t, 0,
                      "All tick documents present in window; rows = received observations.")

    dup_rate = r.get("duplicateRate")
    uniq_detail = _d("Uniqueness", dup_rate, t, e.get("duplicates", 0),
                     "Duplicates = identical observations (token+ts+ltp+volume+bp+sp).",
                     warn=float(config["thresholds"].get("duplicateRateWarn", 2.0)),
                     crit=float(config["thresholds"].get("duplicateRateWarn", 2.0)) * 2)

    validity_rate = r.get("schemaErrorRate")
    val_detail = _d("Validity", validity_rate, t, e.get("schemaErrors", 0),
                    "Schema validity: symbol/token/ltp present and non-empty.")

    ooo_rate = r.get("outOfOrderRate")
    order_detail = _d("Ordering", ooo_rate, t, e.get("outOfOrder", 0),
                      "Ordering: incoming ts >= previous ts for the same symbol.")

    ts_rate = r.get("timestampErrorRate")
    ts_detail = _d("Timestamp Integrity", ts_rate, t, e.get("timestampErrors", 0),
                   "Timestamp integrity: ts present, valid, UTC-consistent.")

    price_rate = r.get("ltpErrorRate")
    price_detail = _d("Price Integrity", price_rate, t, e.get("invalidLtp", 0),
                      "Price integrity: LTP numeric and non-negative.")

    vol_rate = r.get("volumeErrorRate")
    vol_detail = _d("Volume Integrity", vol_rate, t, e.get("invalidVolume", 0),
                    "Volume integrity: volume numeric and non-negative.")

    per_rate = r.get("saveFailureRate")
    per_err = e.get("saveFailures", 0)
    if per_rate is None and (t > 0 or attempted > 0):
        per_rate = 0.0
    per_detail = _d("Persistence Reliability", per_rate, attempted, per_err,
                    "Persistence: successful bulk-writes / attempted writes.",
                    warn=1.0, crit=5.0)

    dims: dict[str, dict] = {
        "Completeness": comp_detail,
        "Uniqueness": uniq_detail,
        "Validity": val_detail,
        "Ordering": order_detail,
        "Timestamp": ts_detail,
        "Price": price_detail,
        "Volume": vol_detail,
        "Persistence": per_detail,
    }

    # Deterministic weighted score.
    total_w = 0.0
    acc = 0.0
    unmeasured = []
    for key, val in dims.items():
        s = val["score"]
        if s is None:
            unmeasured.append(val["name"])
            continue
        weight = float(w.get(_dim_name(key), 0.0)) or float(w.get(key, 0.0)) or 0.0
        acc += (s / 100.0) * weight
        total_w += weight

    score: float | None = None
    if total_w > 0 and (t > 0 or attempted > 0):
        score = round(min(100.0, max(0.0, (acc / total_w) * 100.0)), 1)

    return {
        "score": score,
        "grade": _grade(score),
        "dimensions": dims,
        "unmeasured": unmeasured,
        "weights": {k: float(v) for k, v in w.items()},
        "weightedCoveragePct": round(total_w * 100.0, 1),
        "computedAt": now,
    }


def _grade(score: float | None) -> str:
    if score is None:
        return "Not measured"
    if score >= 95:
        return "Excellent"
    if score >= 80:
        return "Good"
    if score >= 60:
        return "Needs Attention"
    return "Critical"


def _freshness_state(metrics: dict, config: dict) -> dict:
    f = metrics["freshness"]
    stale_sec = int(config["thresholds"].get("staleSeconds", 30))
    age = f.get("ageSeconds")
    if f.get("latestTick") is None and f.get("dbLatestTick") is None:
        status = "NO_DATA"
    elif age is None:
        status = "NO_DATA"
    elif age < 5:
        status = "LIVE"
    elif age <= stale_sec:
        status = "DEGRADED"
    else:
        status = "STALE"
    return {
        "latestTick": f.get("latestTick"),
        "ageSeconds": age,
        "status": status,
        "staleThresholdSeconds": stale_sec,
        "freshThresholdSeconds": 5,
    }


# --------------------------------------------------------------------------- #
# Issue lifecycle (persistent, deduplicated)
# --------------------------------------------------------------------------- #
async def _open_issue_key(key: str) -> dict | None:
    db = get_db()
    try:
        return await db[ISSUES_COLL].find_one({"key": key, "status": {"$in": ["open", "acked", "new"]}})
    except Exception:
        return None


async def upsert_issue(
    *,
    key: str,
    severity: str,
    title: str,
    message: str,
    dimension: str,
    symbol: str = "",
    token: str = "",
    exchange: str = "",
    segment: str = "",
    observed: str = "",
    expected: str = "",
    source: str = "quality_scan",
    metadata: dict | None = None,
) -> dict:
    """Create or increment a persistent quality issue (dedup via `key`)."""
    db = get_db()
    now = datetime.now(timezone.utc)
    existing = await _open_issue_key(key)
    if existing:
        oid = existing["_id"]
        await db[ISSUES_COLL].update_one(
            {"_id": oid},
            {"$set": {
                "severity": severity,
                "title": title,
                "message": message,
                "observed": observed,
                "expected": expected,
                "last_seen": now,
                "metadata": metadata or existing.get("metadata") or {},
            },
                "$inc": {"occurrence_count": 1, "count": 1}},
        )
        updated = await db[ISSUES_COLL].find_one({"_id": oid})
        if updated:
            updated["id"] = str(updated["_id"])
            updated.pop("_id", None)
            return updated
    # New issue
    doc = {
        "key": key,
        "severity": severity,
        "title": title,
        "message": message,
        "dimension": dimension,
        "symbol": symbol,
        "token": token,
        "exchange": exchange or "NSE",
        "segment": segment or "EQ",
        "exchangeSegment": segment or "nse_cm",
        "observed": observed,
        "expected": expected,
        "source": source,
        "metadata": metadata or {},
        "count": 1,
        "occurrence_count": 1,
        "status": "open",
        "statusUpdatedAt": now,
        "ts": now,
        "created_at": now,
        "first_seen": now,
        "last_seen": now,
    }
    try:
        res = await db[ISSUES_COLL].insert_one(doc)
        doc["id"] = str(res.inserted_id)
        doc.pop("_id", None)
        _record_quality_event("QUALITY_ISSUE_CREATED", severity, title, doc)
        return doc
    except Exception as exc:
        logger.warning("failed to insert quality issue: %s", exc)
        return doc


def _record_quality_event(event: str, severity: str, title: str, issue: dict) -> None:
    """Mirror a quality issue create/resolve onto the canonical event ledger."""
    try:
        from services.notification_center import emit_event as record_event
        record_event(
            "quality", event, severity if severity in ("warning", "error", "critical") else "warning",
            str(title) or "",
            {"severity": severity, "dimension": issue.get("dimension"),
             "key": issue.get("key"), "symbol": issue.get("symbol"),
             "token": issue.get("token"), "exchange": issue.get("exchange"),
             "segment": issue.get("segment"),
             "component": "data_quality",
             "details": str(issue.get("message") or "")[:500],
             "issue_id": issue.get("id") or issue.get("key")},
        )
    except Exception:
        pass


async def resolve_issue(key: str, resolution: str = "auto") -> bool:
    """Resolve an open issue (e.g. the data condition recovered)."""
    db = get_db()
    res = await db[ISSUES_COLL].update_many(
        {"key": key, "status": {"$in": ["open", "acked", "new"]}},
        {"$set": {"status": "resolved", "statusUpdatedAt": datetime.now(timezone.utc),
                  "resolution": resolution}},
    )
    changed = res.modified_count > 0
    if changed:
        _record_quality_event(
            "QUALITY_ISSUE_RESOLVED", "info", f"Quality issue resolved: {key}",
            {"key": key, "resolution": resolution, "message": f"resolved ({resolution})"})
    return changed


async def count_active_issues() -> tuple[int, int]:
    """Return (total active, critical active)."""
    db = get_db()
    try:
        pipeline = [
            {"$match": {"status": {"$in": ["open", "acked", "new"]}}},
            {"$group": {"_id": "$severity", "n": {"$sum": 1}}},
        ]
        rows = await db[ISSUES_COLL].aggregate(pipeline).to_list(50)
        active = sum(r["n"] for r in rows)
        crit = sum(r["n"] for r in rows if r["_id"] in ("critical", "error"))
        return active, crit
    except Exception:
        return 0, 0


# --------------------------------------------------------------------------- #
# Signal evaluation → issues + notifications (coordinated alert/notification)
# --------------------------------------------------------------------------- #
async def evaluate_signals(metrics: dict, score: dict, config: dict, *, trigger: str) -> int:
    """Evaluate real metrics against configured thresholds; create/dedup issues
    and publish coordinated notifications. Returns number of new issues."""
    db = get_db()
    t = int(metrics["totals"]["totalTicks"] or 0)
    rates = metrics["rates"]
    errors = metrics["errors"]
    freshness = _freshness_state(metrics, config)
    th = config["thresholds"]
    created = 0
    now = datetime.now(timezone.utc)

    async def _emit_issue(sev: str, title: str, msg: str, dim: str, **extra):
        nonlocal created
        issue = await upsert_issue(key=extra.pop("key"), severity=sev, title=title,
                                   message=msg, dimension=dim, **extra)
        # Push a realtime event.
        try:
            from services.event_bus import publish_event
            await publish_event({
                "type": "quality_issue_" + ("created" if issue.get("occurrence_count", 0) <= 1 else "updated"),
                "severity": sev,
                "dimension": dim,
                "title": title,
                "message": msg,
                "id": issue.get("id"),
                "status": issue.get("status"),
                "count": issue.get("occurrence_count"),
                "ts": now.isoformat(),
            })
        except Exception:
            pass
        created += 1

    # Threshold checks only meaningful when there is data.
    if t > 0:
        dup_rate = rates.get("duplicateRate") or 0.0
        if dup_rate >= float(th.get("duplicateRateWarn", 2.0)):
            await _emit_issue(
                "warning", "High duplicate rate detected",
                f"Duplicate rate {dup_rate:.2f}% exceeds threshold {th.get('duplicateRateWarn')}%.",
                "Uniqueness", key=f"dup-rate", symbol="", token="",
                observed=f"{dup_rate:.2f}%", expected=f"< {th.get('duplicateRateWarn')}%",
            )
        for dim, rate_key, label, warn_key in [
            ("Timestamp", "timestampErrorRate", "Invalid timestamps", "missingRateWarn"),
            ("Price Integrity", "ltpErrorRate", "Invalid prices", "missingRateWarn"),
            ("Volume Integrity", "volumeErrorRate", "Invalid volumes", "missingRateWarn"),
            ("Validity", "schemaErrorRate", "Schema validity", "missingRateWarn"),
        ]:
            rate = rates.get(rate_key) or 0.0
            if rate >= float(th.get(warn_key, 1.0)):
                await _emit_issue(
                    "warning", f"{label} above threshold",
                    f"{label} rate {rate:.2f}% exceeds configured threshold.",
                    dim, key=f"{dim.lower().replace(' ', '-')}-rate",
                    observed=f"{rate:.2f}%", expected=f"< {th.get(warn_key, 1.0)}%",
                )

    # Staleness / no data.
    if freshness["status"] in ("STALE", "NO_DATA"):
        await _emit_issue(
            "warning", "Data freshness degraded",
            f"Feed freshness is {freshness['status']}; last tick age " +
            (f"{freshness['ageSeconds']:.0f}s (threshold {th.get('staleSeconds')}s)." if freshness["ageSeconds"] is not None else "unknown."),
            "Timestamp Integrity", key="freshness-stale",
            observed=freshness["status"], expected="LIVE/DEGRADED",
        )

    # Persistence failures.
    if errors.get("saveFailures") is not None and int(errors.get("saveFailures") or 0) > 0:
        await _emit_issue(
            "error", "Persistence failures detected",
            f"{errors['saveFailures']} tick write(s) failed to persist.",
            "Persistence Reliability", key="persistence-failures",
            observed=str(errors["saveFailures"]), expected="0",
        )

    # Quality score below thresholds.
    if score.get("score") is not None and score["score"] < float(th.get("qualityWarn", 80)):
        await _emit_issue(
            "error" if score["score"] < float(th.get("qualityCritical", 60)) else "warning",
            f"Quality score {score['score']}",
            f"Overall quality score {score['score']} is below threshold " +
            (f"{th.get('qualityCritical')} (critical)." if score["score"] < float(th.get("qualityCritical", 60)) else f"{th.get('qualityWarn')} (warn)."),
            "Validity", key="quality-score-low",
            observed=str(score["score"]), expected=f">= {th.get('qualityWarn')}",
        )

    # Notify once per signal batch (coordinated alert + notification). Use the
    # notification service so unread count, dropdown, top bar and notification
    # page all update from ONE MongoDB source.
    if created > 0:
        try:
            from services.notification_service import notify
            await notify(
                category="quality",
                severity="warning",
                title=f"{created} data quality issue(s) found",
                message=f"Quality scan ({trigger}) found {created} issue(s). See Data Quality.",
                source="data-quality",
                event_type="quality_scan_found_issues",
                metadata={"trigger": trigger, "issues": created},
            )
        except Exception as exc:
            logger.debug("quality notification skipped: %s", exc)

    return created


# --------------------------------------------------------------------------- #
# Scan runner — real, bounded, persisted, one-at-a-time
# --------------------------------------------------------------------------- #
async def run_scan(hours: int = 24, *, trigger: str = "manual") -> dict:
    """Run a quality scan: compute metrics, persist a snapshot, evaluate
    signals, create issues + notifications, and record the scan run."""
    global _SCAN
    db = get_db()
    async with _SCAN_LOCK:
        if _SCAN["status"] == "running":
            return {**scan_state(), "skipped": True, "reason": "scan already running"}
        config = await load_config()
        t0 = time.monotonic()
        _SCAN.update({
            "status": "running",
            "started_at": datetime.now(timezone.utc),
            "completed_at": None,
            "duration_ms": None,
            "error": None,
            "trigger": trigger,
            "last_run_id": None,
        })
        try:
            # Signal scan start.
            try:
                from services.event_bus import publish_event
                await publish_event({"type": "quality_scan_started", "trigger": trigger,
                                     "ts": datetime.now(timezone.utc).isoformat()})
            except Exception:
                pass

            metrics = await _compute_metrics(hours)
            score = _score_dimensions(metrics, config)
            freshness = _freshness_state(metrics, config)

            # Persist a snapshot for the trend chart (single authoritative series).
            now = datetime.now(timezone.utc)
            snap = {
                "ts": now,
                "session": now.strftime("%Y-%m-%d"),
                "symbol": None,
                "qualityScore": score["score"],
                "grade": score["grade"],
                "completeness": score["dimensions"].get("Completeness", {}).get("score"),
                "uniqueness": score["dimensions"].get("Uniqueness", {}).get("score"),
                "validity": score["dimensions"].get("Validity", {}).get("score"),
                "ordering": score["dimensions"].get("Ordering", {}).get("score"),
                "timestamp": score["dimensions"].get("Timestamp", {}).get("score"),
                "price": score["dimensions"].get("Price", {}).get("score"),
                "volume": score["dimensions"].get("Volume", {}).get("score"),
                "persistence": score["dimensions"].get("Persistence", {}).get("score"),
                "freshness": freshness["status"],
                "totalTicks": metrics["totals"]["totalTicks"],
                "duplicates": metrics["errors"]["duplicates"],
                "missing": metrics["errors"]["missing"] or 0,
                "invalidLtp": metrics["errors"]["invalidLtp"],
                "invalidTimestamps": metrics["errors"]["timestampErrors"],
                "invalidVolume": metrics["errors"]["invalidVolume"],
                "dbWriteFailures": metrics["errors"]["saveFailures"],
                "pipelineErrors": metrics["pipeline"].get("writeErrors"),
                "trigger": trigger,
            }
            await db[SNAPSHOT_COLL].insert_one(snap)

            issues_new = await evaluate_signals(metrics, score, config, trigger=trigger)
            active_issues, critical_issues = await count_active_issues()

            # Retention.
            retention_days = int(config.get("snapshotRetentionDays", 30))
            try:
                cutoff = now - timedelta(days=retention_days)
                await db[SNAPSHOT_COLL].delete_many({"ts": {"$lt": cutoff}})
            except Exception:
                pass

            elapsed_ms = round((time.monotonic() - t0) * 1000, 2)
            scan_doc = {
                "trigger": trigger,
                "status": "completed",
                "started_at": _SCAN["started_at"],
                "completed_at": now,
                "duration_ms": elapsed_ms,
                "records_scanned": metrics["totals"]["totalTicks"],
                "issues_found": issues_new,
                "active_issues": active_issues,
                "score": score["score"],
                "hours": hours,
            }
            res = await db[SCANS_COLL].insert_one(scan_doc)
            _SCAN.update({
                "status": "completed",
                "completed_at": now,
                "duration_ms": elapsed_ms,
                "records_scanned": metrics["totals"]["totalTicks"],
                "issues_found": issues_new,
                "error": None,
                "last_run_id": str(res.inserted_id),
                "expires_at": now + timedelta(seconds=int(config.get("scanIntervalSeconds", 60))),
            })

            try:
                from services.event_bus import publish_event
                await publish_event({
                    "type": "quality_scan_completed",
                    "score": score["score"],
                    "issues": issues_new,
                    "duration_ms": elapsed_ms,
                    "ts": now.isoformat(),
                })
            except Exception:
                pass

            return {"status": "completed", "score": score["score"], "issues": issues_new,
                    "duration_ms": elapsed_ms, "records": metrics["totals"]["totalTicks"],
                    "activeIssues": active_issues, "criticalIssues": critical_issues}
        except Exception as exc:
            logger.exception("quality scan failed")
            _SCAN.update({"status": "error", "completed_at": datetime.now(timezone.utc), "error": str(exc)})
            return {"status": "error", "error": str(exc)}


async def periodic_scan_if_due() -> bool:
    """Scheduler hook: run a scan if the interval has elapsed and no scan is
    running. Returns True if a scan was started."""
    global _SCAN
    if _SCAN["status"] == "running":
        return False
    now = datetime.now(timezone.utc)
    expires = _SCAN.get("expires_at")
    if expires is not None and now < expires:
        return False
    config = await load_config()
    interval = int(config.get("scanIntervalSeconds", 60))
    if expires is None:
        # First run — defer until the interval has passed since process start.
        if _first_scan_at is not None and now < _first_scan_at + timedelta(seconds=interval):
            return False
    asyncio.create_task(run_scan(24, trigger="periodic"))
    return True


_first_scan_at: datetime | None = None


def mark_process_started() -> None:
    """Record process start so the periodic scan defers its first run."""
    global _first_scan_at
    _first_scan_at = datetime.now(timezone.utc)
