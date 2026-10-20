"""
Data Quality engine — production-grade real-time quality monitoring.

Every metric is derived from REAL pipeline/database state:

  • quality-metrics aggregation (ticks collection)
  • tick_buffer live counters (received / written / write-errors / latency)
  • websocket lifecycle status
  • Mongo collection / db stats
  • daily summary + statistics

Nothing here is fabricated. When a dimension cannot be measured it is
reported as null / "Not measured" with a reason, never a fake pass mark.

Deterministic score (documented, weights configurable & persisted):
  score = Σ(weight_i × dimension_i) − penalty_errors, then clamped 0–100.

Dimensions (0–100 each):
  Completeness   : ticks vs expected ticks in the window (100 when expected 0)
  Uniqueness     : 100 − duplicateRate × 100
  Validity       : 100 − (schema+ltp)ErrorRate × 100
  Ordering       : 100 − outOfOrderRate × 100
  Timestamp      : 100 − timestampErrorRate × 100
  Price          : 100 − invalidLtpRate × 100
  Volume         : 100 − invalidVolumeRate × 100
  Persistence    : 100 − saveFailureRate × 100

Default weights (sum to 1.0):
  Completeness 0.20, Validity 0.20, Uniqueness 0.15, Ordering 0.10,
  Timestamp 0.10, Price 0.10, Volume 0.05, Persistence 0.10
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from bson import ObjectId
from bson.errors import InvalidId

from core.timezones import IST
from database.connection import get_db, is_mongo_connected
from services import tick_buffer
from services.data_quality import (
    DIMENSIONS,
    SCANS_COLL,
    _compute_metrics as dq_compute_metrics,
    _score_dimensions as dq_score_dimensions,
    _freshness_state as dq_freshness_state,
    load_config as dq_load_config,
    save_config as dq_save_config,
    run_scan as dq_run_scan,
    scan_state as dq_scan_state,
    count_active_issues as dq_count_active_issues,
    upsert_issue as dq_upsert_issue,
    resolve_issue as dq_resolve_issue,
    evaluate_signals as dq_evaluate_signals,
)
from ws_socket.ws_manager import ws_manager
from services.instrument_cache import instrument_cache
from services.db_writer_engine import db_writer_engine
from services.event_history import record_event
from api.system import _compute_quality_metrics, _compute_mongo_stats

logger = logging.getLogger("app")

router = APIRouter(prefix="/api/data-quality", tags=["data-quality"])

IST_TZ = "Asia/Kolkata"


# --------------------------------------------------------------------------- #
# Configuration (persisted in MongoDB, overrides defaults)
# --------------------------------------------------------------------------- #
DEFAULT_CONFIG = {
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
}

CONFIG_COLL = "quality_config"
SNAPSHOT_COLL = "quality_snapshot"
ISSUES_COLL = "quality_issues"

_CACHE: dict = {}
_CACHE_AT = 0.0
_CACHE_TTL = 30.0


async def _load_config(_db) -> dict:
    return await dq_load_config()


async def _save_config(db, config: dict) -> None:
    await dq_save_config(config)


async def _get_cached(fn, **kw):
    """30s cache for expensive aggregate endpoints (single-flight via lock)."""
    global _CACHE, _CACHE_AT
    now = time.monotonic()
    if now - _CACHE_AT < _CACHE_TTL and _CACHE.get("payload") is not None and _CACHE.get("kind") == kw.get("kind"):
        return _CACHE["payload"]
    payload = await fn(**kw)
    if payload is not None:
        _CACHE = {"kind": kw.get("kind"), "payload": payload, "at": now}
        _CACHE_AT = now
    return payload


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _utc(v) -> str | None:
    if isinstance(v, datetime):
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        return v.astimezone(timezone.utc).isoformat()
    return v


def _pct(part: int, total: int) -> float | None:
    return round((part / total) * 100, 4) if total and total > 0 else None


def _per_mille(part: int, total: int) -> float | None:
    return round((part / max(total, 1)) * 1000, 2) if total and total > 0 else None


def _severity(rate: float | None, warn: float, crit: float) -> str:
    if rate is None:
        return "info"
    if rate >= crit:
        return "critical"
    if rate >= warn:
        return "warning"
    return "ok"


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


# --------------------------------------------------------------------------- #
# Core metrics
# --------------------------------------------------------------------------- #
async def _compute_all(hours: int, limit: int, symbol: str) -> dict:
    """Compose the full real metrics model for the inspected window.

    Delegates the actual measurement to the authoritative DataQualityService
    (real completeness/uniqueness/validity/ordering/timestamp/price/volume/
    persistence), then shapes it into the response model. The duplicate
    identity is the deterministic observation fingerprint (token + ts + ltp +
    volume + bid/ask), so repeated same-price ticks are never mis-flagged.
    """
    db = get_db()
    mm = await dq_compute_metrics(hours, symbol)
    stats = tick_buffer.stats()
    ws = ws_manager.status()

    total = int(mm["totals"]["totalTicks"] or 0)
    unique_symbols = int(mm["totals"]["uniqueSymbols"] or 0)
    e = mm["errors"]
    r = mm["rates"]

    missing = e.get("missing")
    missing_measured = missing is not None
    if not missing_measured:
        missing = 0

    return {
        "window": mm["window"],
        "totals": {
            "totalTicks": total,
            "uniqueSymbols": unique_symbols,
            "scanLimit": limit,
        },
        "errors": {
            "missingTicks": missing,
            "missingMeasured": missing_measured,
            "duplicates": e.get("duplicates", 0),
            "duplicateGroups": e.get("duplicates", 0),
            "outOfOrder": e.get("outOfOrder", 0),
            "invalidTimestamps": e.get("timestampErrors", 0),
            "invalidLtp": e.get("invalidLtp", 0),
            "invalidVolume": e.get("invalidVolume"),
            "malformedPayloads": e.get("schemaErrors", 0),
            "dbWriteFailures": e.get("saveFailures", 0),
            "schemaErrors": e.get("schemaErrors", 0),
        },
        "rates": {
            "duplicateRate": r.get("duplicateRate"),
            "duplicatePer1000": round((r.get("duplicateRate") or 0) * 10, 2) if r.get("duplicateRate") is not None else None,
            "outOfOrderRate": r.get("outOfOrderRate"),
            "timestampErrorRate": r.get("timestampErrorRate"),
            "ltpErrorRate": r.get("ltpErrorRate"),
            "volumeErrorRate": r.get("volumeErrorRate"),
            "schemaErrorRate": r.get("schemaErrorRate"),
            "missingRate": r.get("missingRate"),
            "saveFailureRate": r.get("saveFailureRate"),
        },
        "pipeline": mm["pipeline"],
        "websocket": ws,
        "db": await _db_health_payload(db),
    }


async def _compute_all_filtered(
    time_filter: dict,
    limit: int,
    symbol: str = "",
    exchange: str = "",
    segment: str = "",
    hours: int = 24,
) -> dict:
    """Compose the full real metrics model with exchange/segment filters.

    The filter slice is passed through to the service so error-rate
    aggregations measure the same slice as the totals (020 fix — previously
    the service always measured the unfiltered 24h scope while totals were
    filtered, so filtered views showed mismatched rates).
    """
    from services.data_quality import _compute_metrics as _svc_metrics

    db = get_db()
    match = dict(time_filter)
    if symbol:
        match["symbol"] = symbol.upper()
    if exchange and exchange != "ALL":
        match["exchange"] = exchange
    if segment and segment != "All":
        match["segment"] = segment

    # Service-side scope: everything except the ts range (the service derives
    # its own window start from `hours`; the explicit ts range is passed via
    # start/end overrides below so both layers agree).
    extra = {}
    if symbol:
        pass  # symbol travels as its own argument
    if exchange and exchange != "ALL":
        extra["exchange"] = exchange
    if segment and segment != "All":
        extra["segment"] = segment
    ts = time_filter.get("ts", {}) if isinstance(time_filter.get("ts"), dict) else {}
    start_ov = ts.get("$gte")
    end_ov = ts.get("$lt")
    if isinstance(start_ov, str):
        try:
            start_ov = datetime.fromisoformat(start_ov.replace("Z", "+00:00"))
        except ValueError:
            start_ov = None
    if isinstance(end_ov, str):
        try:
            end_ov = datetime.fromisoformat(end_ov.replace("Z", "+00:00"))
        except ValueError:
            end_ov = None

    total = await db.ticks.count_documents(match)
    try:
        unique_symbols = len(
            await asyncio.wait_for(db.ticks.distinct("symbol", match), timeout=5.0)
        )
    except Exception:
        unique_symbols = 0

    # Delegate detailed metric computation to the service WITH the same slice.
    mm = await _svc_metrics(
        hours,
        symbol.upper() if symbol else "",
        extra_match=extra or None,
        start_override=start_ov if isinstance(start_ov, datetime) else None,
        end_override=end_ov if isinstance(end_ov, datetime) else None,
    )

    stats = tick_buffer.stats()
    ws = ws_manager.status()

    e = mm["errors"]
    r = mm["rates"]

    missing = e.get("missing")
    missing_measured = missing is not None
    if not missing_measured:
        missing = 0

    return {
        "window": {
            "hours": hours,
            "symbol": symbol or "all",
            "from": time_filter.get("ts", {}).get("$gte") if isinstance(time_filter.get("ts"), dict) else None,
            "to": time_filter.get("ts", {}).get("$lt") if isinstance(time_filter.get("ts"), dict) else None,
            "exchange": exchange or "ALL",
            "segment": segment or "All",
            "filtered": bool(extra or symbol or start_ov or end_ov),
        },
        "totals": {
            "totalTicks": total,
            "uniqueSymbols": unique_symbols,
            "scanLimit": limit,
        },
        "errors": {
            "missingTicks": missing,
            "missingMeasured": missing_measured,
            "duplicates": e.get("duplicates", 0),
            "duplicateGroups": e.get("duplicates", 0),
            "outOfOrder": e.get("outOfOrder", 0),
            "invalidTimestamps": e.get("timestampErrors", 0),
            "invalidLtp": e.get("invalidLtp", 0),
            "invalidVolume": e.get("invalidVolume"),
            "malformedPayloads": e.get("schemaErrors", 0),
            "dbWriteFailures": e.get("saveFailures", 0),
            "schemaErrors": e.get("schemaErrors", 0),
        },
        "rates": {
            "duplicateRate": r.get("duplicateRate"),
            "duplicatePer1000": round((r.get("duplicateRate") or 0) * 10, 2) if r.get("duplicateRate") is not None else None,
            "outOfOrderRate": r.get("outOfOrderRate"),
            "timestampErrorRate": r.get("timestampErrorRate"),
            "ltpErrorRate": r.get("ltpErrorRate"),
            "volumeErrorRate": r.get("volumeErrorRate"),
            "schemaErrorRate": r.get("schemaErrorRate"),
            "missingRate": r.get("missingRate"),
            "saveFailureRate": r.get("saveFailureRate"),
        },
        "pipeline": mm["pipeline"],
        "websocket": ws,
        "db": await _db_health_payload(db),
    }


def _db_provider_label() -> dict:
    """Active database identity without ever exposing a URI or credential.

    Source: database.connection.get_mongo_info() — `source` is "atlas" while
    connected via a +srv URI, "local" for a local URI, else None/unknown.
    """
    try:
        from database.connection import get_mongo_info

        info = get_mongo_info() or {}
        source = info.get("source")
        provider = (
            "Atlas" if source == "atlas"
            else "Local MongoDB" if source == "local"
            else "Unknown" if not is_mongo_connected()
            else "MongoDB"
        )
        return {
            "provider": provider,
            "providerSource": source,
            "database": info.get("database"),
            "host": info.get("host"),
            "serverVersion": info.get("serverVersion"),
            "pool": info.get("pool"),
            "configured": info.get("configured"),
        }
    except Exception as exc:
        logger.warning("db provider lookup failed: %s", exc)
        return {"provider": "Unknown"}


async def _db_health_payload(db):
    if not is_mongo_connected():
        return {
            "connected": False,
            "writeLatencyMs": None,
            "readLatencyMs": None,
            **_db_provider_label(),
        }
    try:
        mongo = await _compute_mongo_stats()
        ticks_coll = None
        for c in (mongo.get("stats") or {}).get("collections", []):
            if c.get("name") == "ticks":
                ticks_coll = c
                break
        read_ms = None
        write_ms = None
        start = time.monotonic()
        await db.ticks.find_one({})
        read_ms = round((time.monotonic() - start) * 1000, 2)
        now = datetime.now(timezone.utc)
        today = now.strftime("%Y-%m-%d")
        summary = await db.daily_summaries.find_one({"date": today})
        return {
            "connected": True,
            **_db_provider_label(),
            "dbName": mongo.get("stats", {}).get("dbName"),
            "readLatencyMs": read_ms,
            "writeLatencyMs": None,
            "pingMs": mongo.get("stats", {}).get("pingMs"),
            "totalObjects": mongo.get("stats", {}).get("totalObjects"),
            "totalSizeBytes": mongo.get("stats", {}).get("totalSizeBytes"),
            "totalStorageBytes": mongo.get("stats", {}).get("totalStorageBytes"),
            "totalIndexSizeBytes": mongo.get("stats", {}).get("totalIndexSizeBytes"),
            "indexesCount": mongo.get("stats", {}).get("indexesCount"),
            "collectionsCount": mongo.get("stats", {}).get("collectionsCount"),
            "ticksCollection": ticks_coll,
            "todaySummary": summary,
            "lastUpdatedAt": mongo.get("stats", {}).get("lastUpdatedAt"),
        }
    except Exception as exc:
        logger.warning("db health payload failed: %s", exc)
        return {"connected": True, "error": str(exc)}


def _compute_score(all_data: dict, config: dict) -> dict:
    """Deterministic weighted quality score from real dimensions.

    Dimensions are measured by the DataQualityService. Returns numeric
    `dimensions` (percent score per dimension) for the legacy page model,
    plus `dimensionsDetail` (score, weight, status, pass/warn/fail counts,
    affected records, explanation, last_calculated_at) for the richer model.
    """
    mm = {
        "totals": {"totalTicks": all_data["totals"]["totalTicks"],
                   "attemptedSaves": all_data["pipeline"].get("written") or 0},
        "errors": {
            "missing": all_data["errors"].get("missingTicks"),
            "duplicates": all_data["errors"]["duplicates"],
            "outOfOrder": all_data["errors"]["outOfOrder"],
            "timestampErrors": all_data["errors"]["invalidTimestamps"],
            "invalidLtp": all_data["errors"]["invalidLtp"],
            "invalidVolume": all_data["errors"].get("invalidVolume"),
            "schemaErrors": all_data["errors"]["schemaErrors"],
            "saveFailures": all_data["errors"]["dbWriteFailures"],
        },
        "rates": dict(all_data["rates"]),
        "pipeline": all_data["pipeline"],
        "websocket": all_data["websocket"],
        "freshness": {},
    }
    detail = _dq_score_dict(mm, config)
    numeric = {}
    for k, v in detail.get("dimensions", {}).items():
        numeric[k] = v.get("score")
    return {
        "score": detail.get("score"),
        "grade": detail.get("grade"),
        "dimensions": numeric,
        "dimensionsDetail": detail.get("dimensions"),
        "unmeasured": detail.get("unmeasured", []),
        "weights": {k: float(v) for k, v in config["weights"].items()},
        "weightedCoveragePct": detail.get("weightedCoveragePct", 0.0),
    }


def _dq_score_dict(all_data: dict, config: dict) -> dict:
    """Bridge to the service scorer, tolerant of the legacy response shape."""
    from services.data_quality import _score_dimensions, _freshness_state
    try:
        return _score_dimensions(all_data, config)
    except Exception as exc:  # pragma: no cover
        logger.warning("service scorer failed: %s", exc)
        return {
            "score": None, "grade": "Not measured",
            "dimensions": {}, "unmeasured": list(DIMENSIONS),
            "weights": {k: float(v) for k, v in config["weights"].items()},
            "weightedCoveragePct": 0.0,
        }


def _freshness_payload(all_data: dict, config: dict) -> dict:
    ws = all_data.get("websocket") or {}
    last_tick_raw = ws.get("last_tick_at")
    stale_sec = int(config["thresholds"].get("staleSeconds", 30))
    latest_tick_iso = last_tick_raw
    age_sec = None
    status = "Not measured"
    if last_tick_raw:
        try:
            last_dt = datetime.fromisoformat(last_tick_raw)
            if last_dt.tzinfo is None:
                last_dt = last_dt.replace(tzinfo=timezone.utc)
            age_sec = max(0.0, (datetime.now(timezone.utc) - last_dt).total_seconds())
        except Exception:
            latest_tick_iso = None
    # Map the service freshness state into the legacy labels used by the UI.
    try:
        from services.data_quality import _freshness_state
        state = _freshness_state({
            "freshness": {"latestTick": latest_tick_iso, "ageSeconds": age_sec,
                          "dbLatestTick": None},
        }, config)
        m = {"LIVE": "Fresh", "DEGRADED": "Delayed", "STALE": "Stale", "NO_DATA": "Not measured"}
        status = m.get(state["status"], "Not measured")
        age_sec = state.get("ageSeconds")
    except Exception:
        pass
    return {
        "latestTick": latest_tick_iso,
        "ageSeconds": round(age_sec, 1) if age_sec is not None else None,
        "status": status,
        "staleThresholdSeconds": stale_sec,
        "freshThresholdSeconds": 5,
    }


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@router.get("/config")
async def get_config():
    db = get_db()
    return {"config": await _load_config(db)}


class ConfigUpdateRequest(BaseModel):
    weights: dict[str, float] | None = None
    thresholds: dict | None = None
    refreshIntervalSeconds: int | None = None
    snapshotRetentionDays: int | None = None


@router.post("/config")
async def update_config(req: ConfigUpdateRequest):
    db = get_db()
    cfg = await _load_config(db)
    if req.weights is not None:
        cfg["weights"] = req.weights
    if req.thresholds is not None:
        cfg["thresholds"] = {**cfg["thresholds"], **req.thresholds}
    if req.refreshIntervalSeconds is not None:
        cfg["refreshIntervalSeconds"] = max(5, min(600, req.refreshIntervalSeconds))
    if req.snapshotRetentionDays is not None:
        cfg["snapshotRetentionDays"] = max(1, min(90, req.snapshotRetentionDays))
    await _save_config(db, cfg)
    return {"config": cfg}


def _parse_window(hours: str | int | None, date: str | None = None) -> int:
    # "Today" → hours since midnight, "Current Session" → 24h, "All Data" → 720h (cap),
    # "7D"/"30D" → their day counts.
    if date:
        return 720
    try:
        h = int(hours) if hours is not None else 24
    except (TypeError, ValueError):
        h = 24
    return min(max(h, 1), 720)


def _build_time_filter(
    hours: int,
    date: str | None = None,
    time_from: str | None = None,
    time_to: str | None = None,
) -> dict:
    """Build MongoDB time filter from window + optional intraday range."""
    now = datetime.now(timezone.utc)
    if date:
        try:
            d = datetime.fromisoformat(date)
            if d.tzinfo is None:
                d = d.replace(tzinfo=timezone.utc)
            start = d.replace(hour=0, minute=0, second=0, microsecond=0)
            end = start + timedelta(days=1)
            return {"ts": {"$gte": start, "$lt": end}}
        except Exception:
            pass
    start = now - timedelta(hours=hours)
    match: dict = {"ts": {"$gte": start}}
    if time_from or time_to:
        try:
            day_start = now.astimezone(IST).replace(hour=0, minute=0, second=0, microsecond=0)
            if time_from:
                h, m = map(int, time_from.split(":"))
                match["ts"]["$gte"] = day_start + timedelta(hours=h, minutes=m)
            if time_to:
                h, m = map(int, time_to.split(":"))
                match["ts"]["$lt"] = day_start + timedelta(hours=h, minutes=m)
        except Exception:
            pass
    return match


@router.get("/summary")
async def summary(
    hours: int | None = None,
    symbol: str = "",
    limit: int = 200000,
    dataset: str = "",
    session: str = "",
    date: str = "",
    exchange: str = "",
    segment: str = "",
    time_from: str = "",
    time_to: str = "",
):
    db = get_db()
    config = await _load_config(db)
    h = _parse_window(hours)
    # Map dataset to hours if hours not explicitly provided
    if not hours and dataset:
        if dataset == "Today":
            h = 24
        elif dataset == "Current Session":
            h = 24
        elif dataset == "All Data":
            h = 720
    time_filter = _build_time_filter(h, date or None, time_from or None, time_to or None)
    all_data = await _compute_all_filtered(
        time_filter, limit, symbol, exchange, segment, hours=h
    )
    score = _compute_score(all_data, config)
    fresh = _freshness_payload(all_data, config)
    issues = await _issue_counts()
    active_issues = issues.get("active", 0)
    critical_issues = issues.get("critical", 0)

    # Live status derived from real pipeline + ws + score.
    ws = all_data.get("websocket") or {}
    pipeline = all_data.get("pipeline") or {}
    dbh = all_data.get("db") or {}

    status = "Offline"
    if not dbh.get("connected"):
        status = "Offline"
    elif (all_data.get("totals", {}).get("totalTicks") or 0) == 0:
        status = "Idle"
    elif ws.get("connected"):
        status = "LIVE"
    elif fresh.get("status") in ("Stale", "Delayed"):
        status = "Stale"
    else:
        status = "Current"

    st = dq_scan_state()
    last = None
    try:
        row = await db[SCANS_COLL].find_one(sort=[("started_at", -1)])
        if row:
            last = {
                "id": str(row["_id"]),
                "trigger": row.get("trigger"),
                "status": row.get("status"),
                "started_at": _utc(row.get("started_at")),
                "completed_at": _utc(row.get("completed_at")),
                "duration_ms": row.get("duration_ms"),
                "records_scanned": row.get("records_scanned"),
                "score": row.get("score"),
            }
    except Exception:
        last = None
    # STANDBY — no scheduled background scans. nextScanAt is only meaningful
    # while a scan is actively running (its completion), else None.
    next_scan = st.get("next_scan_at") if st.get("status") == "running" else None
    return {
        "status": status,
        "scanState": st.get("status", "idle"),
        "lastScan": last.get("started_at") if last else None,
        "lastScanCompletedAt": last.get("completed_at") if last else None,
        "nextScanAt": next_scan,
        "refreshIntervalSeconds": int(config["refreshIntervalSeconds"]),
        "dataSource": _data_source_label(
            dbh.get("connected"), bool(ws.get("connected")),
            pipeline.get("received"), config,
        ),
        "score": score,
        "freshness": fresh,
        "overview": {
            "totalTicks": all_data["totals"]["totalTicks"],
            "uniqueSymbols": all_data["totals"]["uniqueSymbols"],
            "completeness": score["dimensions"].get("Completeness"),
            "duplicateRate": all_data["rates"]["duplicateRate"],
            "activeIssues": active_issues,
            "criticalIssues": critical_issues,
        },
        "totals": all_data["totals"],
        "errors": all_data["errors"],
        "rates": all_data["rates"],
        "scan": dq_scan_state(),
    }


def _data_source_label(db_ok: bool, ws_ok: bool, received: int, config: dict) -> str:
    parts = []
    if db_ok:
        parts.append("DATABASE")
    if ws_ok:
        parts.append("WEBSOCKET")
    if received:
        parts.append("BROKER+WS")
    if not parts:
        parts.append("CACHE/SNAPSHOT")
    return " + ".join(dict.fromkeys(parts))


@router.get("/metrics")
async def metrics(
    hours: int | None = None,
    symbol: str = "",
    limit: int = 200000,
    dataset: str = "",
    session: str = "",
    date: str = "",
    exchange: str = "",
    segment: str = "",
    time_from: str = "",
    time_to: str = "",
):
    db = get_db()
    config = await _load_config(db)
    h = _parse_window(hours)
    if not hours and dataset:
        if dataset == "Today":
            h = 24
        elif dataset == "Current Session":
            h = 24
        elif dataset == "All Data":
            h = 720
    time_filter = _build_time_filter(h, date or None, time_from or None, time_to or None)
    all_data = await _compute_all_filtered(
        time_filter, limit, symbol, exchange, segment, hours=h
    )
    score = _compute_score(all_data, config)
    fresh = _freshness_payload(all_data, config)
    th = config["thresholds"]

    t = all_data["totals"]["totalTicks"]
    errors = all_data["errors"]
    rates = all_data["rates"]

    # Compared with previous scan (previous window of the same length).
    prev: dict = {}
    prev_h = h
    prev_start = datetime.now(timezone.utc) - timedelta(hours=prev_h * 2)
    match = {"ts": {"$gte": prev_start, "$lt": datetime.now(timezone.utc) - timedelta(hours=prev_h)}}
    if symbol:
        match["symbol"] = symbol
    prev_total = await db.ticks.count_documents(match)
    prev_dup = 0
    if prev_total > 0:
        try:
            res = await db.ticks.aggregate([
                {"$match": match},
                {"$group": {"_id": {"token": "$instrumentToken", "ts": "$ts", "ltp": "$ltp", "volume": "$volume", "bp": "$bp", "sp": "$sp"}, "n": {"$sum": 1}}},
                {"$match": {"n": {"$gt": 1}}},
                {"$group": {"_id": None, "excess": {"$sum": {"$subtract": ["$n", 1]}}}},
            ]).to_list(1)
            prev_dup = int(res[0]["excess"]) if res else 0
        except Exception:
            prev_dup = 0
    prev_dup_rate = _pct(prev_dup, prev_total)

    def _delta(current: float | None, previous: float | None, invert_ok: bool = False) -> float | None:
        if current is None or previous is None or previous == 0:
            return None
        return round(((current - previous) / previous) * 100.0, 2)

    dup_delta = _delta(rates["duplicateRate"] if rates["duplicateRate"] is not None else 0.0, prev_dup_rate if prev_dup_rate is not None else 0.0)

    metrics_rows = [
        _metric("Missing Ticks", errors["missingTicks"], rates.get("missingRate"), t, "expected tick observations not received in the inspected window", "Missing", errors.get("missingMeasured", True), th, dup_delta=None),
        _metric("Duplicate Ticks", errors["duplicates"], rates.get("duplicateRate"), t, "redundant tick rows that are exact repeats of an earlier observation (token+ts+ltp+volume+bp+sp)", "Duplicate", True, th, dup_delta),
        _metric("Out-of-Order Ticks", errors["outOfOrder"], rates.get("outOfOrderRate"), t, "ticks whose timestamp is older than the previous tick of the same symbol", "Out-of-order", True, th, None),
        _metric("Invalid Timestamps", errors["invalidTimestamps"], rates.get("timestampErrorRate"), t, "documents whose ts is missing or not a valid timestamp", "Invalid", True, th, None),
        _metric("Invalid LTP", errors["invalidLtp"], rates.get("ltpErrorRate"), t, "documents missing an LTP value", "Invalid", True, th, None),
        _metric("Invalid Volume", errors["invalidVolume"], rates.get("volumeErrorRate"), t, "documents with missing, non-numeric or negative volume (document-level check; LTQ vs cumulative semantics are not distinguished by the pipeline)", "Invalid", True, th, None),
        _metric("Malformed Payloads", errors["malformedPayloads"], rates.get("schemaErrorRate"), t, "documents missing required fields (symbol/token/ltp)", "Invalid", True, th, None),
        _metric("DB Write Failures", errors["dbWriteFailures"], rates.get("saveFailureRate"), all_data["pipeline"].get("written") or 0, "failed bulk-writes to the database", "Database", True, th, None),
        _metric("Stale Ticks", (all_data["totals"].get("uniqueSymbols") or 0) if fresh.get("status") == "Stale" else 0, None, t, "symbols whose latest tick exceeds the freshness threshold", "Stale", True, th, None),
    ]

    return {
        "window": all_data["window"],
        "score": score,
        "freshness": fresh,
        "totals": all_data["totals"],
        "rates": rates,
        "metrics": metrics_rows,
        "errors": errors,
        "config": config,
        "computedAt": datetime.now(timezone.utc).isoformat(),
    }


def _metric(name, count, rate=None, total=0, definition="", issue_type="", measured=True, th=None, dup_delta=None):
    count = int(count or 0)
    warn = None
    crit = None
    if th:
        if "duplicate" in name.lower():
            warn = th.get("duplicateRateWarn", 2.0)
            crit = warn * 2
        elif "missing" in name.lower():
            warn = th.get("missingRateWarn", 1.0)
            crit = warn * 2
        elif "failure" in name.lower():
            warn = 0.0
            crit = th.get("dbFailuresCritical", 0)
        elif "out-of-order" in name.lower() or "invalid" in name.lower():
            warn = 1.0
            crit = 10.0
        else:
            warn = 2.0
            crit = 10.0
    # 020 live fix: zero measured failures reported CRITICAL because the
    # failure band starts at warn=0/crit=0 (0.0 >= 0). A measured zero is the
    # healthy state and must read ok.
    if measured and (rate or 0) <= 0 and count == 0:
        severity = "ok"
    else:
        severity = _severity(rate if measured else None, warn or 2.0, crit if crit is not None else 10.0)
    return {
        "name": name,
        "count": count if measured else None,
        "measured": measured,
        "rate": rate if measured else None,
        "per1000": round((rate / 100) * 1000, 2) if rate is not None and measured else None,
        "total": total,
        "definition": definition,
        "type": issue_type,
        "deltaVsPrevious": dup_delta,
        "severity": severity,
    }


async def _issue_counts() -> dict:
    """Active + critical issue counts from the persistent quality_issues."""
    active, critical = await dq_count_active_issues()
    return {"active": active, "critical": critical}


@router.get("/issues")
async def issues(
    limit: int = Query(200, ge=1, le=500),
    severity: str = "",
    type: str = "",
    stock: str = "",
    status: str = "",
    dimension: str = "",
):
    db = get_db()
    query: dict = {}
    if severity:
        query["severity"] = severity
    if type:
        query["type"] = type
    if dimension:
        query["dimension"] = {"$regex": dimension, "$options": "i"}
    if status:
        query["status"] = status
    if stock:
        query["symbol"] = {"$regex": stock, "$options": "i"}
    total = await db[ISSUES_COLL].count_documents(query)
    cursor = db[ISSUES_COLL].find(query).sort("last_seen", -1).limit(min(max(limit, 1), 500))
    items = []
    async for row in cursor:
        row["id"] = str(row["_id"])
        row.pop("_id", None)
        for f in ("ts", "created_at", "first_seen", "last_seen", "statusUpdatedAt"):
            if f in row:
                row[f] = _utc(row.get(f))
        items.append(row)
    return {"total": total, "limit": limit, "items": items}


class IssueActionRequest(BaseModel):
    action: str  # acknowledge | resolve | ignore


@router.post("/issues/{issue_id}/{action}")
async def issue_action(issue_id: str, action: str):
    db = get_db()
    try:
        oid = ObjectId(issue_id)
    except (InvalidId, TypeError):
        raise HTTPException(400, "invalid issue id")
    if action not in ("acknowledge", "resolve", "ignore", "suppress"):
        raise HTTPException(400, "action must be acknowledge | resolve | ignore | suppress")
    status = {
        "acknowledge": "acked",
        "resolve": "resolved",
        "ignore": "ignored",
        "suppress": "suppressed",
    }[action]
    res = await db[ISSUES_COLL].update_one(
        {"_id": oid},
        {"$set": {"status": status, "statusUpdatedAt": datetime.now(timezone.utc)}},
    )
    if res.matched_count == 0:
        raise HTTPException(404, "issue not found")
    # Publish a realtime event so all open views update without reload.
    try:
        from services.event_bus import publish_event
        await publish_event({
            "type": "quality_issue_resolved" if status == "resolved" else "quality_issue_updated",
            "id": issue_id,
            "status": status,
            "action": action,
            "ts": datetime.now(timezone.utc).isoformat(),
        })
    except Exception:
        pass
    return {"ok": True, "status": status}


@router.get("/scan-state")
async def quality_scan_state():
    """Current (in-memory) + last persisted quality scan run."""
    db = get_db()
    s = dq_scan_state()
    last = None
    try:
        row = await db[SCANS_COLL].find_one(sort=[("started_at", -1)])
        if row:
            last = {
                "id": str(row["_id"]),
                "trigger": row.get("trigger"),
                "status": row.get("status"),
                "started_at": _utc(row.get("started_at")),
                "completed_at": _utc(row.get("completed_at")),
                "duration_ms": row.get("duration_ms"),
                "records_scanned": row.get("records_scanned"),
                "issues_found": row.get("issues_found"),
                "score": row.get("score"),
                "hours": row.get("hours"),
            }
    except Exception:
        last = None
    return {"state": s, "last": last}


@router.post("/scan")
async def quality_manual_scan(hours: int = 24):
    """Manually trigger a real quality scan. Returns immediately with the scan
    running in the background; status is available via /scan-state."""
    result = await dq_run_scan(hours, trigger="manual")
    return result


@router.post("/scan/if-due")
async def quality_scan_if_due():
    """Demand-driven scan trigger used when the Data Quality page is visited.

    Runs a real scan ONLY when it is genuinely needed: no completed scan on
    record yet, or the last completed scan is older than the configured
    interval. Returns the decision so the UI can show STANDBY → RUNNING.
    """
    db = get_db()
    try:
        config = await _load_config(db)
    except Exception:
        config = {}
    interval = max(int(config.get("refreshIntervalSeconds", 60)), 30)
    state = dq_scan_state()
    if state.get("status") == "running":
        return {"triggered": False, "state": state.get("status"), "reason": "already_running"}
    last = None
    try:
        row = await db[SCANS_COLL].find_one(sort=[("started_at", -1)])
        if row:
            last = row.get("started_at")
    except Exception:
        last = None
    if last is not None:
        try:
            age_s = (datetime.now(timezone.utc) - last).total_seconds()
        except Exception:
            age_s = 1e18
        if age_s < interval:
            return {"triggered": False, "state": state.get("status"), "reason": "recent_scan"}
    await dq_run_scan(24, trigger="on_demand")
    return {"triggered": True, "state": "running", "reason": "stale_or_missing"}


@router.get("/scan/history")
async def quality_scan_history(limit: int = Query(20, ge=1, le=100)):
    """Real run history from the persisted scans collection (newest first).

    Each row is a genuinely completed/attempted scan — not fabricated. Rows
    surface the actual duration, records scanned and issues found so the page
    can show an "Analysis History" without polling every scan tick.
    """
    db = get_db()
    rows = []
    try:
        cursor = db[SCANS_COLL].find().sort("started_at", -1).limit(limit)
        docs = await cursor.to_list(length=limit)
    except Exception as exc:
        logger.warning("scan-history read failed: %s", exc)
        docs = []
    for row in docs:
        rows.append({
            "id": str(row["_id"]),
            "trigger": row.get("trigger"),
            "status": row.get("status"),
            "started_at": _utc(row.get("started_at")),
            "completed_at": _utc(row.get("completed_at")),
            "duration_ms": row.get("duration_ms"),
            "records_scanned": row.get("records_scanned"),
            "issues_found": row.get("issues_found"),
            "active_issues": row.get("active_issues"),
            "score": row.get("score"),
            "hours": row.get("hours"),
        })
    return {"items": rows, "count": len(rows)}


# --------------------------------------------------------------------------- #
# Duplicate management (real tick rows, identity = scan engine Identity rule)
# --------------------------------------------------------------------------- #
def _dup_identity_key(doc: dict) -> dict:
    return {
        "token": doc.get("instrumentToken"),
        "ts": doc.get("ts"),
        "ltp": doc.get("ltp"),
        "volume": doc.get("volume"),
        "bp": doc.get("bp"),
        "sp": doc.get("sp"),
    }


_DUP_IDENTITY_FIELDS = ("instrumentToken", "ts", "ltp", "volume", "bp", "sp")


@router.get("/duplicates")
async def quality_duplicates(
    hours: int | None = None,
    limit: int = Query(100, ge=1, le=500),
    dataset: str = "",
    session: str = "",
    date: str = "",
    exchange: str = "",
    segment: str = "",
    time_from: str = "",
    time_to: str = "",
):
    """Real duplicate tick rows, grouped by the scan-engine Identity rule.

    Identity = instrumentToken + ts + ltp + volume + bp + sp (a repeated
    same-price tick with a distinct broker timestamp is NOT a duplicate).
    Returns the total redundant copies so the UI can show a true count.
    """
    db = get_db()
    h = _parse_window(hours)
    if not hours and dataset:
        if dataset == "Today":
            h = 24
        elif dataset == "Current Session":
            h = 24
        elif dataset == "All Data":
            h = 720
    time_filter = _build_time_filter(h, date or None, time_from or None, time_to or None)

    match = dict(time_filter)
    if exchange and exchange != "ALL":
        match["exchange"] = exchange
    if segment and segment != "All":
        match["segment"] = segment

    pipeline = [
        {"$match": match},
        {"$group": {"_id": {
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
        }, "n": {"$sum": 1}, "symbols": {"$addToSet": "$symbol"}}},
        {"$match": {"n": {"$gt": 1}}},
        {"$sort": {"n": -1}},
        {"$limit": limit},
    ]
    try:
        groups = await db.ticks.aggregate(pipeline, maxTimeMS=30000).to_list(length=limit)
    except Exception as exc:
        logger.warning("duplicates aggregation failed: %s", exc)
        groups = []

    total_extra = 0
    items = []
    for g in groups:
        key = g["_id"]
        n = g["n"]
        total_extra += max(0, n - 1)
        token = key.get("token")
        inst = None
        if token is not None:
            inst = instrument_cache.lookup_by_token(str(token)) if instrument_cache.loaded else None
        symbols = g.get("symbols") or []
        items.append({
            "id": _dup_group_id(key),
            "key": {
                "token": token,
                "ts": _utc(key.get("ts")),
                "ltp": key.get("ltp"),
                "volume": key.get("volume"),
                "bp": key.get("bp"),
                "sp": key.get("sp"),
            },
            "count": n,
            "extra": n - 1,
            "symbols": sorted(symbols),
            "symbol": symbols[0] if symbols else None,
            "companyName": inst.get("companyName") if inst else None,
            "firstTs": None,
            "lastTs": None,
        })
    # 020 live fix: `start` was undefined here (NameError → HTTP 500 on every
    # call), which is why the page permanently read "Duplicate scan
    # unavailable". Scope the window label to this request's own time filter.
    _ts = time_filter.get("ts") if isinstance(time_filter, dict) else None
    _gte = _ts.get("$gte") if isinstance(_ts, dict) else None
    _lt = _ts.get("$lt") if isinstance(_ts, dict) else None
    return {
        "count": len(items),
        "duplicateRecords": total_extra,
        "window": {"hours": h, "startedAt": _utc(_gte), "endedAt": _utc(_lt)},
        "identity": list(_DUP_IDENTITY_FIELDS),
        "groups": items,
    }


def _dup_group_id(key: dict) -> str:
    import hashlib

    raw = "|".join(str(key.get(f)) for f in ("token", "ts", "ltp", "volume", "bp", "sp"))
    return "dup_" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


class DupGroupKey(BaseModel):
    token: int | str | None = None
    ts: str | None = None
    ltp: float | int | None = None
    volume: float | int | None = None
    bp: float | int | None = None
    sp: float | int | None = None


class DuplicatesDeleteRequest(BaseModel):
    mode: str = "group"  # group | records | all
    groups: list[DupGroupKey] = []
    records: list[str] = []
    hours: int | None = None
    reason: str = ""


def _parse_dup_key(key: DupGroupKey) -> dict:
    """Rebuild the Mongo identity filter; ts ISO → aware UTC datetime."""
    q: dict = {}
    if key.token is not None:
        q["instrumentToken"] = key.token
    for field in ("ltp", "volume", "bp", "sp"):
        val = getattr(key, field)
        if val is not None:
            q[field] = val
    if key.ts:
        try:
            q["ts"] = datetime.fromisoformat(key.ts.replace("Z", "+00:00"))
        except ValueError:
            q["ts"] = key.ts
    if not q:
        raise HTTPException(status_code=422, detail="Duplicate key must include at least one field")
    return q


@router.post("/duplicates/delete")
async def quality_duplicates_delete(req: DuplicatesDeleteRequest):
    """Delete redundant duplicate tick rows.

    Modes:
      group   — for each supplied identity key, keep the earliest row and
                delete the exact copy/(ies) that follow.
      records — delete the exact tick rows identified by record id.
      all     — dedupe the whole window, keeping one row per identity.

    Deletion is real (Mongo) and never touches rows outside the duplicate
    groups. An audit trail entry is appended to the event ledger and a
    ``quality_duplicates_cleaned`` frame is broadcast so the Quality page
    live-refreshes.
    """
    db = get_db()
    h = _parse_window(req.hours)
    start = datetime.now(timezone.utc) - timedelta(hours=h)
    match: dict = {"ts": {"$gte": start}}

    deleted = 0
    kept = 0
    groups_handled = 0
    kept_ids: list[str] = []

    if req.mode == "records":
        ids: list[ObjectId] = []
        for rid in req.records:
            try:
                ids.append(ObjectId(rid))
            except InvalidId:
                raise HTTPException(status_code=422, detail=f"Invalid record id: {rid}")
        if not ids:
            raise HTTPException(status_code=422, detail="No record ids supplied for mode=records")
        # Report what was ACTUALLY removed, not what was asked for: a supplied
        # id may not exist or may not be a duplicate, and telling the operator
        # "deleted 5" when 3 were dropped is how a cleanup gets distrusted.
        deleted = await db_writer_engine.delete_duplicate_ticks(ids)
        groups_handled = 1
    elif req.mode == "all":
        pipeline = [
            {"$match": match},
            {"$group": {"_id": _dup_identity_group(), "ids": {"$push": "$_id"}}},
            {"$match": {"$expr": {"$gt": [{"$size": "$ids"}, 1]}}},
        ]
        try:
            groups = await db.ticks.aggregate(pipeline, maxTimeMS=60000).to_list(2000)
        except Exception as exc:
            logger.warning("duplicate group scan failed: %s", exc)
            groups = []
        for g in groups:
            ids = g.get("ids") or []
            if len(ids) < 2:
                continue
            ids.sort()
            keep_id, drop_ids = ids[0], ids[1:]
            deleted += await db_writer_engine.delete_duplicate_ticks(drop_ids)
            kept += 1
            kept_ids.append(str(keep_id))
            groups_handled += 1
    else:  # group
        for key in req.groups:
            q = _parse_dup_key(key)
            q.update(match)
            rows = await db.ticks.find(q, {"_id": 1}).sort("_id", 1).to_list(100000)
            if len(rows) < 2:
                if rows:
                    kept += 1
                    kept_ids.append(str(rows[0]["_id"]))
                continue
            ids = [r["_id"] for r in rows]
            keep_id, drop_ids = ids[0], ids[1:]
            deleted += await db_writer_engine.delete_duplicate_ticks(drop_ids)
            kept += 1
            kept_ids.append(str(keep_id))
            groups_handled += 1

    if deleted > 0:
        entry = record_event(
            "quality",
            "DUPLICATES_CLEANED",
            "info",
            f"Removed {deleted} duplicate tick record(s)",
            meta={
                "severity": "info",
                "component": "data_quality",
                "details": {
                    "mode": req.mode,
                    "removed": deleted,
                    "kept": kept,
                    "groups": groups_handled,
                    "reason": req.reason or "",
                },
                "reason": req.reason or "",
            },
        )
        from services.event_bus import publish_event

        await publish_event({
            "type": "quality_duplicates_cleaned",
            "removed": deleted,
            "kept": kept,
            "groups": groups_handled,
            "ts": entry["ts"].isoformat() if entry.get("ts") else None,
        })
    else:
        kept = None

    return {
        "deleted": deleted,
        "kept": kept,
        "groupsHandled": groups_handled,
        "auditEventId": entry["event_id"] if deleted else None,
        "keptIds": kept_ids[:50],
    }


def _dup_identity_group() -> dict:
    return {
        "token": "$instrumentToken",
        "ts": "$ts",
        "ltp": "$ltp",
        "volume": "$volume",
        "bp": "$bp",
        "sp": "$sp",
    }


@router.get("/dimensions")
async def quality_dimensions(hours: int | None = None, symbol: str = ""):
    """Full detailed quality dimensions (score, weight, status, pass/warn/fail,
    affected records, explanation, last_calculated_at)."""
    try:
        config = await _load_config(get_db())
        h = _parse_window(hours)
        all_data = await _compute_all(h, 200000, symbol)
        score = _compute_score(all_data, config)
        return {
            "dimensions": score.get("dimensionsDetail", {}),
            "unmeasured": score.get("unmeasured", []),
            "weights": score.get("weights", {}),
            "window": all_data["window"],
            "computedAt": datetime.now(timezone.utc).isoformat(),
        }
    except Exception as exc:
        logger.warning("dimensions endpoint failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"Dimensions calculation failed: {exc}")


@router.get("/symbols")
async def quality_symbols(
    hours: int | None = None,
    symbol: str = "",
    limit: int = Query(100, ge=1, le=500),
    search: str = "",
    dataset: str = "",
    session: str = "",
    date: str = "",
    exchange: str = "",
    segment: str = "",
    time_from: str = "",
    time_to: str = "",
):
    db = get_db()
    h = _parse_window(hours)
    if not hours and dataset:
        if dataset == "Today":
            h = 24
        elif dataset == "Current Session":
            h = 24
        elif dataset == "All Data":
            h = 720
    time_filter = _build_time_filter(h, date or None, time_from or None, time_to or None)

    match = dict(time_filter)
    if search:
        match["symbol"] = {"$regex": search, "$options": "i"}
    elif symbol:
        match["symbol"] = symbol.upper()
    if exchange and exchange != "ALL":
        match["exchange"] = exchange
    if segment and segment != "All":
        match["segment"] = segment

    pipeline = [
        {"$match": match},
        {"$group": {
            "_id": "$symbol",
            "ticks": {"$sum": 1},
            "duplicates": {"$sum": 0},
            "firstTs": {"$min": "$ts"},
            "lastTs": {"$max": "$ts"},
            "outOfOrder": {"$sum": 0},
            "invalidTs": {"$sum": 0},
        }},
        {"$sort": {"ticks": -1}},
        {"$limit": limit},
    ]
    try:
        rows = await db.ticks.aggregate(pipeline, maxTimeMS=30000).to_list(length=limit)
    except Exception as exc:
        logger.warning("per-symbol aggregation failed: %s", exc)
        rows = []

    # 020 fix: the per-symbol duplicate scope previously referenced an undefined
    # `start` (NameError, swallowed per-symbol → duplicates silently 0) and the
    # $count stage returned the number of duplicate GROUPS while the global
    # metric reports excess ROWS Σ(n−1). Both are fixed: scope to this endpoint's
    # own time_filter and sum excess rows, matching the service identity
    # (token + ts + ltp + volume + bp + sp). Out-of-order / invalid / missing
    # are NOT measured at per-symbol granularity (a per-symbol walk for up to
    # `limit` symbols would be `limit` full scans) — they are returned as null
    # with measured:false instead of a fabricated 0.
    ts_gte = None
    _ts = time_filter.get("ts")
    if isinstance(_ts, dict):
        ts_gte = _ts.get("$gte")
    out = []
    for row in rows:
        sym = row["_id"]
        ticks = row["ticks"]
        dup_for: int | None = None
        try:
            sym_match: dict = {"symbol": sym}
            if isinstance(ts_gte, datetime):
                sym_match["ts"] = {"$gte": ts_gte}
            _ts_lt = _ts.get("$lt") if isinstance(_ts, dict) else None
            if isinstance(_ts_lt, datetime):
                sym_match.setdefault("ts", {})["$lt"] = _ts_lt
            if exchange and exchange != "ALL":
                sym_match["exchange"] = exchange
            if segment and segment != "All":
                sym_match["segment"] = segment

            async def _sym_dup():
                return await db.ticks.aggregate(
                    [
                        {"$match": sym_match},
                        {"$group": {"_id": {
                            "token": "$instrumentToken",
                            "ts": "$ts",
                            "ltp": "$ltp",
                            "volume": "$volume",
                            "bp": "$bp",
                            "sp": "$sp",
                        }, "n": {"$sum": 1}}},
                        {"$match": {"n": {"$gt": 1}}},
                        {"$group": {"_id": None, "excess": {"$sum": {"$subtract": ["$n", 1]}}}},
                    ],
                    maxTimeMS=10000,
                ).to_list(1)

            res = await asyncio.wait_for(_sym_dup(), timeout=5.0)
            dup_for = int(res[0]["excess"]) if res else 0
        except asyncio.TimeoutError:
            logger.warning("per-symbol duplicate scan timed out for %s", sym)
            dup_for = None
        except Exception as exc:
            logger.warning("per-symbol duplicate scan failed for %s: %s", sym, exc)
            dup_for = None
        last_ts = row.get("lastTs")
        age = None
        if isinstance(last_ts, datetime):
            if last_ts.tzinfo is None:
                last_ts = last_ts.replace(tzinfo=timezone.utc)
            age = round(max(0.0, (datetime.now(timezone.utc) - last_ts).total_seconds()), 1)
        company = ""
        inst = instrument_cache.lookup_by_symbol(sym) if instrument_cache.loaded else None
        if inst:
            company = inst.get("companyName") or ""
        dup_rate = _pct(dup_for, ticks) if dup_for is not None else None
        score = round(min(100.0, max(0.0, 100 - (dup_rate or 0))), 1) if ticks > 0 and dup_rate is not None else None
        out.append({
            "symbol": sym,
            "companyName": company,
            "ticks": ticks,
            "duplicates": dup_for,
            "duplicatesMeasured": dup_for is not None,
            "duplicateRate": dup_rate,
            "outOfOrder": None,
            "outOfOrderMeasured": False,
            "invalid": None,
            "invalidMeasured": False,
            "missing": None,
            "missingMeasured": False,
            "freshnessSeconds": age,
            "score": score,
            "scoreMeasured": score is not None,
            "lastTs": _utc(last_ts),
        })
    return {
        "items": out,
        "count": len(out),
        "measured": True,
        "window": {
            "hours": h,
            "exchange": exchange or "ALL",
            "segment": segment or "All",
            "filtered": bool(exchange and exchange != "ALL" or segment and segment != "All" or search or symbol),
        },
    }


@router.get("/symbol/{sym}")
async def symbol_detail(sym: str):
    db = get_db()
    symbol = sym.upper()
    inst = instrument_cache.lookup_by_symbol(symbol) if instrument_cache.loaded else None
    qm = await _compute_quality_metrics(24, 200000, symbol)

    config = await _load_config(db)
    all_data = await _compute_all(24, 200000, symbol)
    score = _compute_score(all_data, config)

    latest = await db.ticks.find({"symbol": symbol}).sort("ts", -1).limit(1).to_list(1)
    tick = latest[0] if latest else None
    if tick:
        tick["_id"] = str(tick["_id"])
        for k in ("ts", "receivedAt", "last_update_time"):
            if k in tick and isinstance(tick[k], datetime):
                tick[k] = tick[k].isoformat()

    price_stats = {}
    if tick:
        from services.tick_field_resolver import get_depth, get_field

        buy = get_depth(tick, "buy")
        sell = get_depth(tick, "sell")
        price_stats = {
            "ltp": get_field(tick, "ltp"),
            "open": get_field(tick, "open"),
            "high": get_field(tick, "high"),
            "low": get_field(tick, "low"),
            "close": get_field(tick, "close"),
            "volume": get_field(tick, "volume"),
            "bid": buy[0].get("price") if buy else None,
            "ask": sell[0].get("price") if sell else None,
            "upperCircuit": get_field(tick, "upper_circuit_limit"),
            "lowerCircuit": get_field(tick, "lower_circuit_limit"),
        }

    return {
        "symbol": symbol,
        "instrument": {
            "symbol": symbol,
            "companyName": inst.get("companyName") if inst else None,
            "exchange": "NSE",
            "segment": "EQ",
            "token": inst.get("token") if inst else None,
            "isin": inst.get("isin") if inst else None,
        },
        "ticks": {
            "received": qm.get("total") or 0,
            "expected": (qm.get("total") or 0) + (qm.get("missing") or 0),
            "missing": qm.get("missing"),
            "duplicates": qm.get("duplicates") or 0,
            "outOfOrder": qm.get("outOfOrder") or 0,
            "invalid": qm.get("invalidLtp") or 0,
        },
        "price": price_stats,
        "circuit": {
            "upperCircuit": get_field(tick, "upper_circuit_limit") if tick else None,
            "lowerCircuit": get_field(tick, "lower_circuit_limit") if tick else None,
            "ltp": price_stats.get("ltp") if tick else None,
            "distanceToUpper": _circuit_distance(tick),
            "distanceToLower": _circuit_distance(tick, lower=True),
        },
        "score": score,
        "lastTick": latest[0] if latest else None,
    }


def _circuit_distance(tick, lower=False):
    if not tick:
        return None
    from services.tick_field_resolver import get_field

    ltp = get_field(tick, "ltp")
    if lower:
        circuit = get_field(tick, "lower_circuit_limit")
    else:
        circuit = get_field(tick, "upper_circuit_limit")
    if ltp is None or circuit is None or circuit == 0:
        return None
    return round(((ltp - circuit) / circuit) * 100.0, 4)


@router.get("/trend")
async def trend(range: str = "30d", limit: int = Query(500, ge=1, le=2000)):
    db = get_db()
    range = range.lower()
    if range == "today":
        start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    elif range == "7d":
        start = datetime.now(timezone.utc) - timedelta(days=7)
    else:
        start = datetime.now(timezone.utc) - timedelta(days=30)
    cursor = db[SNAPSHOT_COLL].find({"ts": {"$gte": start}}).sort("ts", 1).limit(limit)
    items = []
    async for row in cursor:
        items.append({
            "ts": _utc(row.get("ts")),
            "qualityScore": row.get("qualityScore"),
            "completeness": row.get("completeness"),
            "uniqueness": row.get("uniqueness"),
            "validity": row.get("validity"),
            "ordering": row.get("ordering"),
            "freshness": row.get("freshness"),
            "totalTicks": row.get("totalTicks"),
            "duplicates": row.get("duplicates"),
            "missing": row.get("missing"),
            "invalidLtp": row.get("invalidLtp"),
            "invalidTimestamps": row.get("invalidTimestamps"),
            "dbWriteFailures": row.get("dbWriteFailures"),
            "pipelineErrors": row.get("pipelineErrors"),
        })
    return {"range": range, "count": len(items), "items": items}


@router.post("/snapshot")
async def snapshot_refresh():
    """Compute the current metrics, persist a quality snapshot, evaluate
    signals, enforce retention — the authoritative single scan path."""
    result = await dq_run_scan(24, trigger="periodic")
    return {**result, "ok": result.get("status") == "completed"}


@router.get("/pipeline")
async def pipeline_health():
    """Pipeline stages with real hop-to-hop latency where measured.

    Stages follow the canonical flow: Broker Feed → WebSocket → Validation →
    Quality → DB Writer → MongoDB. Any stage that cannot be measured reports
    latencyMs: null with a reason instead of a fabricated number.
    """
    from services.json_safe import sanitize_for_json
    stats = tick_buffer.stats()
    ws = ws_manager.status()
    dbh = await _db_health_payload(get_db())
    db_ok = is_mongo_connected()
    try:
        from services import pipeline_latency as _pl

        latency = _pl.stats()
    except Exception:
        latency = None
    scan = dq_scan_state()

    def _stage_latency(*keys: str) -> float | None:
        try:
            stages = (latency or {}).get("stages") or {}
            for k in keys:
                blk = stages.get(k) or {}
                if blk.get("p50_ms") is not None:
                    return blk.get("p50_ms")
        except Exception:
            pass
        return None

    scan_status = (scan.get("status") or "idle").upper()
    quality_stage = {
        "name": "Quality",
        "status": "RUNNING" if scan_status == "RUNNING" else ("STANDBY" if scan_status == "IDLE" else scan_status),
        "detail": (
            "Scan running" if scan_status == "RUNNING"
            else "On-demand scans (page visit / manual)"
        ),
        "latencyMs": None,
        "latencyNote": "NOT MEASURED — quality scoring runs on demand, not per tick",
        "lastEvent": scan.get("completed_at") or scan.get("started_at"),
        "errorCount": None,
    }
    stages = [
        {
            "name": "Broker Feed",
            "status": "Online" if ws.get("connected") else ("Offline" if not ws.get("connected") else "Unknown"),
            "detail": "Broker market feed",
            "latencyMs": None,
            "latencyNote": "NOT MEASURED — broker clock is not a transport timer",
            "lastEvent": ws.get("last_message_at"),
            "errorCount": None,
        },
        {
            "name": "WebSocket",
            "status": "CONNECTED" if ws.get("connected") else "DISCONNECTED",
            "detail": f"{ws.get('subscription_count') or 0} subscribed",
            "latencyMs": _stage_latency("broker_to_ws"),
            "latencyNote": None if _stage_latency("broker_to_ws") is not None else "NOT MEASURED — no hop samples yet",
            "lastEvent": ws.get("last_tick_at"),
            "errorCount": ws.get("reconnect_count") or 0,
            "reconnectCount": ws.get("reconnect_count") or 0,
            "lastDisconnect": ws.get("disconnected_at"),
        },
        {
            "name": "Validation",
            "status": "Online" if (stats.get("received") or 0) or stats.get("pipelineRunning") else "Idle",
            "detail": f"{stats.get('ticksPerSecond') or 0} ticks/s",
            "latencyMs": _stage_latency("ws_recv_to_feature_done", "feature_calc"),
            "latencyNote": None if _stage_latency("ws_recv_to_feature_done", "feature_calc") is not None else "NOT MEASURED — no hop samples yet",
            "lastEvent": stats.get("lastTickAt"),
            "errorCount": None,
        },
        quality_stage,
        {
            "name": "DB Writer",
            "status": "Running" if stats.get("pipelineRunning") else "Idle",
            "detail": f"~{stats.get('totalWritten') or 0} written",
            "latencyMs": _stage_latency("ws_recv_to_db_writer", "broker_to_db_writer"),
            "latencyNote": None if _stage_latency("ws_recv_to_db_writer", "broker_to_db_writer") is not None else "NOT MEASURED — no hop samples yet",
            "lastEvent": stats.get("lastWriteAt") or stats.get("lastFlushAt"),
            "errorCount": stats.get("totalWriteErrors") or 0,
            "writeErrors": stats.get("totalWriteErrors") or 0,
        },
        {
            "name": "MongoDB",
            "status": "Connected" if db_ok else "Disconnected",
            "detail": dbh.get("provider") or ("connected" if db_ok else "disconnected"),
            "latencyMs": _stage_latency("ws_recv_to_mongo", "broker_to_mongo") or dbh.get("pingMs"),
            "latencyNote": None if (_stage_latency("ws_recv_to_mongo", "broker_to_mongo") is not None or dbh.get("pingMs") is not None) else "NOT MEASURED — no hop samples and no ping yet",
            "lastEvent": stats.get("lastWriteAt"),
            "errorCount": stats.get("totalWriteErrors") or 0,
        },
    ]
    return sanitize_for_json({
        "stages": stages,
        "overall": "Healthy" if (ws.get("connected") and db_ok) else "Degraded",
        "websocket": ws,
        "latency": latency,
        "buffer": {
            "received": stats.get("totalReceived"),
            "written": stats.get("totalWritten"),
            "writeErrors": stats.get("totalWriteErrors"),
            "bufferLength": stats.get("bufferLength"),
            "bufferMaxSize": stats.get("bufferMaxSize"),
            "ticksPerSecond": stats.get("ticksPerSecond"),
            "latency": stats.get("feedLatencyMs"),
            "pipelineRunning": stats.get("pipelineRunning"),
            "lastFlushAt": stats.get("lastFlushAt"),
        },
        "db": dbh,
    })


@router.get("/storage")
async def storage_health():
    dbh = await _db_health_payload(get_db())
    stats = tick_buffer.stats()
    total_ticks = None
    today_ticks = None
    try:
        db = get_db()
        total_ticks = await db.ticks.estimated_document_count()
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        summary = await db.daily_summaries.find_one({"date": today})
        if summary:
            today_ticks = int(summary.get("totalWrites") or sum(r.get("count", 0) for r in (summary.get("perSymbol") or [])))
    except Exception:
        pass
    try:
        config = await _load_config(get_db())
        snapshot_retention = int(config.get("snapshotRetentionDays", 30))
    except Exception:
        snapshot_retention = None
    return {
        "totalRecords": total_ticks,
        "todayRecords": today_ticks,
        "compressed": None,
        "compressedMeasured": False,
        "raw": total_ticks,
        "failedRecords": dbh.get("todaySummary", {}).get("errorCount") if isinstance(dbh.get("todaySummary"), dict) else None,
        "archivedRecords": None,
        "archivedMeasured": False,
        "retention": {
            # Real contract values only. Ticks carry NO MongoDB TTL by design
            # (application-managed session classification); issues are
            # append-only audit with no TTL; no archive pipeline exists.
            "tickRetention": "CONFIGURATION UNAVAILABLE — no TTL on ticks by design (application-managed)",
            "tickRetentionMeasured": False,
            "qualitySnapshotRetentionDays": snapshot_retention,
            "qualitySnapshotRetentionMeasured": snapshot_retention is not None,
            "issueRetention": "CONFIGURATION UNAVAILABLE — issues are append-only audit, no retention policy configured",
            "issueRetentionMeasured": False,
            "archiveStatus": "CONFIGURATION UNAVAILABLE — no archive pipeline configured",
            "archiveMeasured": False,
        },
        "database": {
            "dbName": dbh.get("dbName") or dbh.get("database"),
            "provider": dbh.get("provider") or "Unknown",
            "providerSource": dbh.get("providerSource"),
            "serverVersion": dbh.get("serverVersion"),
            "pool": dbh.get("pool"),
            "host": dbh.get("host"),
            "connected": dbh.get("connected"),
            "totalObjects": dbh.get("totalObjects"),
            "totalSizeBytes": dbh.get("totalSizeBytes"),
            "totalStorageBytes": dbh.get("totalStorageBytes"),
            "totalIndexSizeBytes": dbh.get("totalIndexSizeBytes"),
            "indexesCount": dbh.get("indexesCount"),
            "collectionsCount": dbh.get("collectionsCount"),
            "pingMs": dbh.get("pingMs"),
            "readLatencyMs": dbh.get("readLatencyMs"),
            "ticksCollection": dbh.get("ticksCollection"),
        },
        "buffer": {
            "received": stats.get("totalReceived"),
            "written": stats.get("totalWritten"),
            "writeErrors": stats.get("totalWriteErrors"),
            "bufferLength": stats.get("bufferLength"),
            "bufferMaxSize": stats.get("bufferMaxSize"),
        },
    }


@router.get("/live")
async def live_snapshot():
    """Lightweight real-time pipeline snapshot (no Mongo scans).

    Single snapshot for the redesigned Data Quality page: in-memory
    counters from WebSocket / Market Watch / DB Writer / Mongo connection
    state. Safe to call on page open; the live stream then takes over so
    the frontend never polls this endpoint.
    """
    from services.json_safe import sanitize_for_json
    from services.data_quality_live import build_snapshot_async

    snap = await build_snapshot_async()
    return sanitize_for_json(snap)


@router.get("/diagnostics")
async def diagnostics():
    stats = tick_buffer.stats()
    dbh = await _db_health_payload(get_db())
    metrics = await _compute_all(24, 200000, "")
    t0 = time.monotonic()
    return {
        "apiLatencyMs": None,
        "dbReadLatencyMs": dbh.get("readLatencyMs"),
        "dbPingMs": dbh.get("pingMs"),
        "wsLatencyMs": (stats.get("feedLatencyMs") or {}).get("currentMs"),
        "recordsProcessed": stats.get("totalReceived"),
        "recordsRejected": None,
        "recordsWritten": stats.get("totalWritten"),
        "writeErrors": stats.get("totalWriteErrors"),
        "validationDurationMs": None,
        "aggregationDurationMs": None,
        "lastUpdate": datetime.now(timezone.utc).isoformat(),
        "measurementMs": round((time.monotonic() - t0) * 1000, 2),
        "window": metrics.get("window"),
    }
