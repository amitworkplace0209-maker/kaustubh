"""Data Center API — consolidated observability endpoints for the Data SAVer.

All payloads are REAL measurements (no fabricated values). Expensive views are
cached + single-flighted so concurrent front-end polls never fan out to
duplicate MongoDB scans. Everything is serialized through the centralized
JSON-safe serializer before being returned to the Next.js proxy.

Endpoints
---------
GET  /api/system/data-center/snapshot           ONE authoritative snapshot (cached)
GET  /api/system/data-center/snapshot/schema    the snapshot contract
GET  /api/system/data-center/overview            consolidated snapshot (cached)
GET  /api/system/data-center/history             daily write history (cached)
GET  /api/system/data-center/ticks-history       tick volume series (cached)
GET  /api/system/data-center/storage-trend      DB growth from snapshots (cached)
GET  /api/system/data-center/snapshots           newest snapshot points
POST /api/system/data-center/snapshots/capture   manual snapshot capture
GET  /api/system/data-center/collections/{name}  one collection's detail (cached)
POST /api/system/data-center/deep-scan           bounded full DB scan (manual)
GET  /api/system/data-center/export              CSV/JSON export of a view
"""
from __future__ import annotations

import asyncio
import csv
import io
import json
import logging
import time
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from database.connection import get_db, is_mongo_connected
from services import data_center
from services import data_center_planes
from services import data_center_snapshot
from services.json_safe import sanitize_for_json

logger = logging.getLogger("app")

router = APIRouter(prefix="/api/system/data-center", tags=["data-center"])

TTL_OVERVIEW = 20.0  # >= the UI live-poll cadence (15s) so polls hit the cache
TTL_SNAPSHOT = 10.0  # the one aggregation the Data Center first paint waits on
TTL_HISTORY = 30.0
TTL_TICKS_HISTORY = 20.0
TTL_TREND = 30.0
TTL_COLLECTION = 15.0
TTL_API_TELEMETRY = 20.0
DEEP_SCAN_TIMEOUT = 30.0


# --------------------------------------------------------------------------- #
# Cache + single-flight helpers (real values, deduplicated work)
# --------------------------------------------------------------------------- #
_cache: dict[str, tuple[float, object]] = {}
_inflight: dict[str, asyncio.Future] = {}


def _cache_key(_prefix: str, **parts) -> str:
    return _prefix + "|" + "|".join(f"{k}={v}" for k, v in sorted(parts.items()))


async def _get_or_build(key: str, ttl: float, builder, *args):
    now = time.monotonic()
    cached = _cache.get(key)
    if cached is not None and now - cached[0] < ttl:
        return cached[1]

    fut = _inflight.get(key)
    if isinstance(fut, asyncio.Future):
        try:
            await fut
        except asyncio.CancelledError:
            raise
        except Exception:
            pass
        cached = _cache.get(key)
        return cached[1] if cached else None

    fut = asyncio.ensure_future(builder(*args))
    _inflight[key] = fut

    def _on_done(f):
        if _inflight.get(key) is f:
            _inflight.pop(key, None)

    fut.add_done_callback(_on_done)
    try:
        payload = await fut
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.exception("data-center build failed: %s", exc)
        payload = None
    if payload is not None:
        _cache[key] = (time.monotonic(), sanitize_for_json(payload))
    return _cache[key][1] if payload is not None else None


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@router.get("/snapshot")
async def data_center_snapshot_route():
    """THE authoritative Data Center snapshot, in ONE request.

    This is the endpoint the Data Center page loads first. It aggregates the
    engines that already own each fact (Session Manager, Scheduler Engine,
    WebSocket Engine, Connection Manager, DB Write Engine, Market Watch, the
    MongoDB connection) into a single read-only document with per-section
    failure isolation, so the frontend never has to know how any engine is
    implemented and never has to fan out into one request per engine.

    Cheap by construction: everything is an in-process snapshot except the
    storage totals, which reuse the already-cached ``mongo_stats()``. No
    collection scan, no deep scan, no historical aggregation.
    """
    payload = await _get_or_build("snapshot", TTL_SNAPSHOT, data_center_snapshot.build_snapshot)
    if payload is None:
        return Response(
            content=json.dumps({
                "ok": False,
                "error": "The data center snapshot is unavailable right now.",
                "generatedAt": datetime.now(timezone.utc).isoformat(),
            }),
            media_type="application/json",
            status_code=503,
        )
    return {"ok": True, "generatedAt": datetime.now(timezone.utc).isoformat(), "data": payload}


@router.get("/snapshot/schema")
async def data_center_snapshot_schema():
    """The snapshot contract (section names + provenance), for drift detection."""
    return {"ok": True, "data": data_center_snapshot.get_snapshot_schema()}


@router.get("/overview")
async def data_center_overview(days: str | None = None):
    """Consolidated Data Center snapshot (real measurements only)."""
    _d = min(max(int(days) if days else data_center.TREND_DAYS, 1), 365)

    async def _build(days: int = _d):
        return await data_center.build_snapshot(days=days)

    payload = await _get_or_build(_cache_key("overview", days=_d), TTL_OVERVIEW, _build, _d)
    if payload is None:
        return Response(
            content=json.dumps({
                "ok": False,
                "error": "Could not build the data center snapshot. "
                         "Is MongoDB reachable?",
                "generatedAt": datetime.now(timezone.utc).isoformat(),
            }),
            media_type="application/json",
            status_code=503,
        )
    return {"ok": True, "generatedAt": datetime.now(timezone.utc).isoformat(), "data": payload}


@router.get("/history")
async def data_center_history(days: str | None = None):
    """Daily write history (real per-day counts, oldest -> newest)."""
    _d = min(max(int(days) if days else 14, 1), 365)

    async def _build():
        rows = await data_center.daily_write_history(days=_d)
        symbols = await data_center.daily_symbols(days=_d)
        for r in rows:
            r["uniqueSymbols"] = symbols.get(r["date"], 0)
        return {"days": _d, "rows": rows}

    payload = await _get_or_build(_cache_key("history", days=_d), TTL_HISTORY, _build)
    return _ok(payload)


@router.get("/ticks-history")
async def data_center_ticks_history(hours: str | None = None, resolution_min: str | None = None):
    """Real tick volume series from telemetry buckets (bounded window)."""
    _h = min(max(int(hours) if hours else 24, 1), 30 * 24)
    _r = min(max(int(resolution_min) if resolution_min else 5, 1), 60)

    async def _build():
        from services.ds_insights import get_telemetry_series
        return {
            "hours": _h,
            "resolutionMin": _r,
            "points": await get_telemetry_series(hours=_h, resolution_min=_r),
        }

    payload = await _get_or_build(_cache_key("ticks", hours=_h, res=_r), TTL_TICKS_HISTORY, _build)
    return _ok(payload)


@router.get("/api-telemetry")
async def data_center_api_telemetry(hours: str | None = None, limit: str | None = None):
    """Real FastAPI request telemetry — totals, histogram-derived percentiles,
    per-endpoint breakdown and recent failing buckets (no fabricated p95).

    Percentiles are computed by the backend from actual ``latency_bucket``
    histogram rows; a missing value means no latency samples — never a guess.
    """
    _h = min(max(int(hours) if hours else 24, 1), 30 * 24)
    _l = min(max(int(limit) if limit else 20, 1), 100)

    async def _build():
        from services.ds_insights import api_telemetry_summary
        summary = await api_telemetry_summary(range_hours=_h)
        summary["hours"] = _h
        summary["recentErrors"] = await _recent_telemetry_errors(limit=_l)
        return summary

    payload = await _get_or_build(_cache_key("api-telemetry", hours=_h), TTL_API_TELEMETRY, _build)
    return _ok(payload)


async def _recent_telemetry_errors(limit: int = 20) -> list[dict]:
    """Newest telemetry buckets that recorded real request errors (bounded)."""
    if not is_mongo_connected():
        return []
    try:
        db = get_db()
        cursor = db.api_telemetry.find(
            {"errors": {"$gt": 0}},
            {"ts": 1, "route": 1, "errors": 1, "clientErrors": 1, "serverErrors": 1,
             "avg_latency_ms": 1, "db_related": 1, "_id": 0},
        ).sort("ts", -1).limit(limit)
        docs = await cursor.to_list(length=limit)
        out = []
        for d in docs:
            ts = d.get("ts")
            out.append({
                "ts": _ts_iso(ts),
                "route": d.get("route"),
                "errors": d.get("errors"),
                "clientErrors": d.get("clientErrors"),
                "serverErrors": d.get("serverErrors"),
                "avgLatencyMs": d.get("avg_latency_ms"),
                "dbRelated": bool(d.get("db_related")),
            })
        return out
    except Exception as exc:
        logger.debug("recent telemetry errors failed: %s", exc)
        return []


def _ts_iso(v) -> str | None:
    if isinstance(v, datetime):
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        return v.astimezone(timezone.utc).isoformat()
    return str(v) if v is not None else None


@router.get("/storage-trend")
async def data_center_storage_trend(days: str | None = None):
    """DB growth trend from persisted snapshots (empty = still collecting)."""
    _d = min(max(int(days) if days else 14, 1), 90)

    async def _build():
        return {"days": _d, "points": await data_center.storage_trend(days=_d)}

    payload = await _get_or_build(_cache_key("trend", days=_d), TTL_TREND, _build)
    return _ok(payload)


@router.get("/snapshots")
async def data_center_snapshots(limit: str | None = None):
    """Newest-first persisted snapshot points (DB growth table + export)."""
    _l = min(max(int(limit) if limit else 60, 1), 500)
    points = await data_center.recent_snapshots(limit=_l)
    return {"ok": True, "points": sanitize_for_json(points), "count": len(points)}


@router.post("/snapshots/capture")
async def data_center_capture():
    """Manually persist one snapshot point (idempotent per timestamp)."""
    if not is_mongo_connected():
        raise HTTPException(status_code=503, detail="MongoDB is not connected")
    result = await data_center.capture_snapshot(manual=True)
    return {"ok": bool(result.get("ok")), "point": sanitize_for_json(result)}


@router.get("/collections/all")
async def data_center_collections_all():
    """Real collection inventory + per-collection health (from mongo-stats)."""
    from api.system import mongo_stats
    mongo = await mongo_stats()
    return {"ok": bool(mongo.get("connected")), "data": sanitize_for_json(mongo)}


@router.get("/collections/{name}")
async def data_center_collection(name: str):
    """One collection's real detail — stats, indexes, schema + sample rows."""
    if not is_mongo_connected():
        raise HTTPException(status_code=503, detail="MongoDB is not connected")
    key = _cache_key("collection", collection=name)
    payload = await _get_or_build(key, TTL_COLLECTION, _collection_detail, name)
    if payload is None:
        raise HTTPException(status_code=404, detail="Collection statistics unavailable")
    return {"ok": True, "data": sanitize_for_json(payload)}


async def _collection_detail(name: str) -> dict | None:
    db = get_db()
    if name not in await db.list_collection_names():
        raise ValueError(f"collection not found: {name}")
    coll = db[name]
    try:
        collstats = sanitize_for_json(await db.command("collstats", name))
    except Exception as exc:
        raise ValueError(f"collstats failed for {name}: {exc}") from exc

    index_list = await coll.index_information()

    sample = []
    try:
        cursor = coll.find({}).sort("_id", -1).limit(20)
        sample = sanitize_for_json(await cursor.to_list(length=20))
    except Exception:
        pass

    first_ts, last_ts, has_ts = await _collection_bounds(coll, name)

    return {
        "name": name,
        "ns": collstats.get("ns"),
        "count": collstats.get("count"),
        "sizeBytes": collstats.get("size"),
        "storageBytes": collstats.get("storageSize"),
        "indexSizeBytes": collstats.get("totalIndexSize"),
        "indexes": len(index_list),
        "avgObjSizeBytes": collstats.get("avgObjSize"),
        "capped": bool(collstats.get("capped")),
        "maxSizeBytes": collstats.get("maxSize"),
        "freeStorageBytes": collstats.get("freeStorageSize"),
        "wiredTiger": (collstats.get("wiredTiger") or {}).get("cache"),
        "indexNames": sorted(index_list.keys()),
        "hasTimeField": has_ts,
        "firstRecord": first_ts,
        "lastRecord": last_ts,
        "sample": sample,
    }


async def _collection_bounds(coll, name: str):
    try:
        sample = await coll.find_one({}, {"ts": 1})
        if not sample or "ts" not in sample:
            return None, None, False
        first = await coll.find({}, {"ts": 1, "_id": 0}).sort("ts", 1).limit(1).to_list(1)
        last = await coll.find({}, {"ts": 1, "_id": 0}).sort("ts", -1).limit(1).to_list(1)
        from api.system import _iso_dt
        return _iso_dt(first[0].get("ts")) if first else None, \
               _iso_dt(last[0].get("ts")) if last else None, True
    except Exception:
        return None, None, False


# --------------------------------------------------------------------------- #
# Deep scan - an explicit, asynchronous, bounded job.
#
# Contract (why it is a job and not a request):
#   * A full-database scan is O(collections) round-trips. Holding an HTTP
#     request open for it is what made the old button feel like a hang, and it
#     gave the caller no way to see progress.
#   * It must never run on page load. It only starts when a human presses the
#     button.
#   * Progress, completion and failure are all observable states.
#
# The registry is a small bounded in-process map - the scan is a read-only
# measurement with no reason to outlive the process, and keeping it in memory is
# what guarantees it cannot accumulate.
# --------------------------------------------------------------------------- #
DEEP_SCAN_MAX_JOBS = 4
_DEEP_SCAN_JOBS: dict[str, dict] = {}
_DEEP_SCAN_ORDER: list[str] = []


def _deep_scan_job_public(job: dict) -> dict:
    """Public shape of a job - progress only, never the raw internal record."""
    return {
        "jobId": job["jobId"],
        "status": job["status"],
        "startedAt": job["startedAt"],
        "finishedAt": job.get("finishedAt"),
        "durationMs": job.get("durationMs"),
        "progress": job.get("progress"),
        "error": job.get("error"),
        "result": job.get("result"),
    }


def _register_job(job: dict) -> None:
    _DEEP_SCAN_JOBS[job["jobId"]] = job
    _DEEP_SCAN_ORDER.append(job["jobId"])
    # Bounded: drop the oldest finished job so the map can never grow.
    while len(_DEEP_SCAN_ORDER) > DEEP_SCAN_MAX_JOBS:
        _DEEP_SCAN_JOBS.pop(_DEEP_SCAN_ORDER.pop(0), None)


async def _run_deep_scan(job: dict) -> None:
    """Bounded full-DB scan with observable progress. Never touches writes."""
    db = get_db()
    total_started = time.perf_counter()

    async def _scan() -> dict:
        names = await db.list_collection_names()
        job["progress"] = {"phase": "listing", "collectionsTotal": len(names), "collectionsDone": 0}
        collections = []
        for name in sorted(names):
            coll = db[name]
            estimate = await coll.estimated_document_count()
            exact: int | None = None
            try:
                exact = await asyncio.wait_for(coll.count_documents({}), timeout=4.0)
            except asyncio.TimeoutError:
                exact = None
            totals = {
                "count": exact if exact is not None else estimate,
                "countIsApproximate": exact is None,
            }
            stat = await _coll_stat(coll)
            if stat is not None:
                totals.update(stat)
                totals["health"] = data_center.collection_health(totals).get("status")
            collections.append({"name": name, **totals})
            job["progress"] = {
                "phase": "counting",
                "collectionsTotal": len(names),
                "collectionsDone": len(collections),
                "currentCollection": name,
            }
        job["progress"] = {"phase": "totals", "collectionsTotal": len(names), "collectionsDone": len(names)}
        db_stats = sanitize_for_json(await db.command("dbStats"))
        return {
            "db": db.name,
            "collections": collections,
            "totals": {
                "collectionsCount": len(collections),
                "totalObjects": sum(c["count"] for c in collections),
                "totalStorageBytes": db_stats.get("storageSize"),
                "totalIndexSizeBytes": db_stats.get("indexSize"),
            },
        }

    try:
        result = await asyncio.wait_for(_scan(), timeout=DEEP_SCAN_TIMEOUT)
    except asyncio.TimeoutError:
        job["status"] = "failed"
        job["error"] = "Deep scan timed out — the database is larger than the scan budget."
    except asyncio.CancelledError:  # pragma: no cover - shutdown path
        job["status"] = "failed"
        job["error"] = "Deep scan cancelled."
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning("deep scan failed: %s", exc)
        job["status"] = "failed"
        job["error"] = f"{type(exc).__name__}: {exc}"
    else:
        job["status"] = "completed"
        job["result"] = sanitize_for_json(result)
    finally:
        job["finishedAt"] = datetime.now(timezone.utc).isoformat()
        job["durationMs"] = int((time.perf_counter() - total_started) * 1000)
        job["progress"] = None


@router.post("/deep-scan")
async def data_center_deep_scan_start():
    """START a deep scan and return immediately. Never blocks, never automatic.

    Returns a job id; poll ``GET /api/system/data-center/deep-scan/{jobId}`` for
    progress, completion and failure.
    """
    if not is_mongo_connected():
        raise HTTPException(status_code=503, detail="MongoDB is not connected")

    job_id = f"ds-{int(time.time() * 1000)}"
    job = {
        "jobId": job_id,
        "status": "running",
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "finishedAt": None,
        "durationMs": None,
        "progress": {"phase": "starting", "collectionsTotal": None, "collectionsDone": 0},
        "error": None,
        "result": None,
    }
    _register_job(job)
    asyncio.ensure_future(_run_deep_scan(job))
    return {"ok": True, "jobId": job_id, "status": job["status"], "startedAt": job["startedAt"]}


@router.get("/deep-scan/{job_id}")
async def data_center_deep_scan_status(job_id: str):
    """Progress / completion / failure for one deep-scan job."""
    job = _DEEP_SCAN_JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown deep scan job")
    return {"ok": True, "data": _deep_scan_job_public(job)}


async def _coll_stat(coll) -> dict | None:
    try:
        st = sanitize_for_json(await coll.database.command("collstats", coll.name))
        return {
            "sizeBytes": st.get("size"),
            "storageBytes": st.get("storageSize"),
            "avgObjSizeBytes": st.get("avgObjSize"),
            "indexSizeBytes": st.get("totalIndexSize"),
            "indexes": st.get("nindexes"),
            "capped": bool(st.get("capped")),
        }
    except Exception:
        return None


CHARTS_CSV_COLUMNS = {
    "daily": [
        ("date", "date"),
        ("ticksWritten", "ticks_written"),
        ("uniqueSymbols", "unique_symbols"),
        ("schedulerRuns", "scheduler_runs"),
        ("schedulerCompleted", "scheduler_completed"),
        ("schedulerFailed", "scheduler_failed"),
        ("apiRequests", "api_requests"),
        ("apiErrors", "api_errors"),
        ("apiAvgLatencyMs", "api_avg_latency_ms"),
        ("downloads", "downloads"),
        ("auditEntries", "audit_entries"),
        ("systemEvents", "system_events"),
        ("summaryTotalWrites", "summary_total_writes"),
        ("summaryTotalTicks", "summary_total_ticks"),
        ("summaryErrorCount", "summary_error_count"),
    ],
    "snapshots": [
        ("ts", "timestamp"),
        ("istDay", "ist_day"),
        ("mode", "mode"),
        ("db.totalStorageBytes", "db_storage_bytes"),
        ("db.totalIndexSizeBytes", "db_index_bytes"),
        ("db.totalObjects", "db_objects"),
        ("db.pingMs", "db_ping_ms"),
        ("storage.diskUsedBytes", "disk_used_bytes"),
        ("storage.diskPercent", "disk_percent"),
    ],
}


@router.get("/export")
async def data_center_export(kind: str = "daily", days: str | None = None,
                             format: str = "csv"):
    """Download a real Data Center view as CSV or JSON (no fabricated rows)."""
    _fmt = format.lower()
    if _fmt not in ("csv", "json"):
        raise HTTPException(status_code=400, detail="format must be csv or json")
    _d = min(max(int(days) if days else 14, 1), 365)

    if kind == "snapshots":
        rows = await data_center.recent_snapshots(limit=500)
    else:
        kind = "daily"
        rows = await data_center.daily_write_history(days=_d)
        symbols = await data_center.daily_symbols(days=_d)
        for r in rows:
            r["uniqueSymbols"] = symbols.get(r["date"], 0)

    columns = CHARTS_CSV_COLUMNS.get(kind, CHARTS_CSV_COLUMNS["daily"])

    def _get(path: str, row: dict):
        cur = row
        for part in path.split("."):
            if not isinstance(cur, dict):
                return ""
            cur = cur.get(part)
        if cur is None:
            return ""
        return cur

    if _fmt == "json":
        body = json.dumps(sanitize_for_json(rows), indent=2, default=str)
        content_type = "application/json"
    else:
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow([h for _, h in columns])
        for row in rows:
            writer.writerow([_get(p, row) for p, _ in columns])
        body = buf.getvalue()
        content_type = "text/csv"

    filename = f"data-center-{kind}-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.{_fmt}"
    return Response(
        content=body,
        media_type=content_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# --------------------------------------------------------------------------- #
# Observability planes (read-only) — see services/data_center_planes.py
#
# Each plane is an independent GET so a failure in one plane never blanks the
# others. They are pure reads: no MongoDB writes, no engine mutation, no
# credentials. TTLs match the UI's live/slow poll split.
# --------------------------------------------------------------------------- #
TTL_PLANE_LIVE = 10.0    # database / dbwriter — cheap in-process snapshots
TTL_PLANE_SLOW = 30.0    # engines / topology / ownership / retention


async def _plane(name: str, ttl: float, *args, **key_parts):
    """Build a read-only plane behind its own TTL/single-flight entry.

    ``key_parts`` must carry every argument the builder actually uses, so two
    different requests (e.g. retention ``limit=50`` vs ``limit=400``) can never
    share one cached entry.
    """
    builder = data_center_planes.PLANES[name]
    return await _get_or_build(_cache_key("plane", name=name, **key_parts), ttl, builder, *args)


@router.get("/database")
async def data_center_database_plane():
    """Active MongoDB identity + server facts + storage totals (read-only)."""
    return _ok(await _plane("database", TTL_PLANE_LIVE))


@router.get("/engines")
async def data_center_engines_plane():
    """Engine Registry status for the Data Center's documented engine set."""
    return _ok(await _plane("engines", TTL_PLANE_SLOW))


@router.get("/topology")
async def data_center_topology_plane():
    """Real engine dependency graph (nodes, edges, orphans)."""
    return _ok(await _plane("topology", TTL_PLANE_SLOW))


@router.get("/db-writer")
async def data_center_db_writer_plane():
    """DB Writer authoritative tick pipeline / permissions / data-loss view."""
    return _ok(await _plane("dbwriter", TTL_PLANE_LIVE))


@router.get("/ownership")
async def data_center_ownership_plane():
    """Live collection inventory joined to the code-derived owner map."""
    return _ok(await _plane("ownership", TTL_PLANE_SLOW))


@router.get("/retention")
async def data_center_retention_plane(limit: str | None = None):
    """Real TTL indexes + 06:00 IST cleanup contract + snapshot retention."""
    _n = min(max(int(limit) if limit else 400, 1), 2000)
    return _ok(await _plane("retention", TTL_PLANE_SLOW, _n, limit=_n))


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #
def _ok(payload):
    if payload is None:
        return Response(
            content=json.dumps({"ok": False, "error": "View unavailable right now."}),
            media_type="application/json",
            status_code=503,
        )
    return {"ok": True, "data": payload}