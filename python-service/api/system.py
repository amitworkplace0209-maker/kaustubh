"""System dashboard â€” health, resources, MongoDB stats, trading stats."""
from __future__ import annotations

from scheduler import get_scheduler_info, get_scheduler_state, get_schedule
import asyncio
import json
import logging
from services.status.status_manager import set_status, get_status
from services.event_history import recent_events
from services import market_calendar
from services.json_safe import sanitize_for_json
from services.session.session_manager import session_manager
import os
import platform
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

from fastapi import APIRouter, Request
from pydantic import BaseModel

from database.connection import get_db, is_mongo_connected
from services import pipeline_latency
from services import tick_buffer
from services.settings_service import get_setting
from auth.kotak_client import ( kotak_session, SDK_AVAILABLE, SDK_VERSION,)
from ws_socket.ws_manager import ws_manager
from services.broker_cache import broker_cache
from services.instrument_cache import instrument_cache

router = APIRouter(prefix="/api/system", tags=["system"])
logger = logging.getLogger("app")

from core.timezones import IST


def _serialize_tick_ts(tick: dict | None) -> str | None:
    """Return the tick's ts as an ISO string with explicit IST offset.

    Kotak SDK sends ts representing IST market time.  The raw value may be
    a naive datetime (no tzinfo), an epoch-ms int/float, or an ISO string.
    We normalize everything to an IST-aware ISO string so the frontend can
    display it directly without any further timezone math.
    """
    if tick is None:
        return None
    raw = tick.get("ts")
    if raw is None:
        return None

    dt: datetime | None = None
    if isinstance(raw, datetime):
        dt = raw
    elif isinstance(raw, (int, float)):
        # Epoch milliseconds from Kotak SDK
        dt = datetime.fromtimestamp(raw / 1000.0, tz=timezone.utc)
    elif isinstance(raw, str):
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            pass

    if dt is None:
        return str(raw)

    # If naive, the value represents IST market time
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=IST)

    # Convert to IST for display
    dt_ist = dt.astimezone(IST)
    return dt_ist.isoformat()


class ClearLogsRequest(BaseModel):
    category: str | None = None





@router.get("")
async def system_status(request: Request):
    # This is the topbar poll hit on EVERY page mount (Next proxies
    # /api/phase2/system straight to it per request with no cache). Building
    # _system_snapshot() inline per call took 11-14s under live-feed load
    # (broker gate + Mongo round-trips over a busy cluster) and made every
    # page navigation crawl. Serve the latest snapshot immediately and refresh
    # it in the background — a status view polled per page is expected to be
    # at most a couple of seconds old.
    global _SYSTEM_SNAPSHOT_CACHE, _SYSTEM_SNAPSHOT_AT
    now = time.monotonic()
    if (
        _SYSTEM_SNAPSHOT_CACHE is not None
        and now - _SYSTEM_SNAPSHOT_AT < _SYSTEM_SNAPSHOT_TTL_S
    ):
        return _SYSTEM_SNAPSHOT_CACHE
    if _SYSTEM_SNAPSHOT_CACHE is not None:
        _schedule_system_snapshot_rebuild()
        return _SYSTEM_SNAPSHOT_CACHE
    snapshot = await _system_snapshot()
    _SYSTEM_SNAPSHOT_CACHE = snapshot
    _SYSTEM_SNAPSHOT_AT = time.monotonic()
    return snapshot


_SYSTEM_SNAPSHOT_TTL_S = 2.0
_SYSTEM_SNAPSHOT_CACHE: dict | None = None
_SYSTEM_SNAPSHOT_AT = 0.0
_SYSTEM_SNAPSHOT_REBUILD_TASK: asyncio.Task | None = None


def _schedule_system_snapshot_rebuild() -> None:
    """Refresh the /api/system snapshot in the background (single-flight).

    Concurrent polls share one rebuild; the result replaces the cache as soon
    as it is ready. Guarded so a burst of page mounts cannot stack several
    10s+ builds on a slow broker network.
    """
    global _SYSTEM_SNAPSHOT_REBUILD_TASK
    task = _SYSTEM_SNAPSHOT_REBUILD_TASK
    if task is not None and not task.done():
        return
    try:
        _SYSTEM_SNAPSHOT_REBUILD_TASK = asyncio.ensure_future(_rebuild_system_snapshot_bg())
    except RuntimeError:
        pass


async def _rebuild_system_snapshot_bg() -> None:
    global _SYSTEM_SNAPSHOT_CACHE, _SYSTEM_SNAPSHOT_AT
    try:
        snapshot = await _system_snapshot()
    except Exception as exc:
        logger.warning("background /api/system snapshot rebuild failed: %s", exc)
        return
    _SYSTEM_SNAPSHOT_CACHE = snapshot
    _SYSTEM_SNAPSHOT_AT = time.monotonic()


def _runtime_snapshot() -> dict:
    """Realtime single-instance runtime state (READY/STARTING/STOPPING/...).

    Read from the runtime state file so monitoring/dashboards can confirm this
    process is the authoritative backend instance and its advertised state.
    """
    runtime_dir = Path(__file__).resolve().parent.parent / "runtime"
    snapshot = {
        "state": "UNKNOWN",
        "pid": None,
        "instance_id": None,
        "port": None,
        "host": None,
        "updated_at_utc": None,
    }
    try:
        raw = (runtime_dir / "backend.state").read_text(encoding="utf-8").strip()
        if raw:
            data = json.loads(raw)
            snapshot.update({k: data.get(k) for k in snapshot})
    except Exception:
        pass
    return snapshot


@router.get("/health")
async def system_health():
    """GET /api/system/health — real component health (no fabricated values).

    MongoDB Atlas is pinged live AND probed for query capability; when it is
    unreachable the endpoint reports ``degraded`` and returns HTTP 503 — never
    a false 200. Every component flag (database / backend / websocket /
    scheduler / session / pipeline) reflects real backend state.
    """
    import time as _t
    from fastapi import Response

    from database.connection import get_mongo_info, ping_mongo

    # A real round-trip against MongoDB. `configured` is reported separately so a
    # missing MONGODB_URI is distinguishable from an unreachable server.
    mongo_probe = await ping_mongo(timeout_s=3.0)
    info = get_mongo_info()
    mongo_ok = bool(mongo_probe.get("ok") and mongo_probe.get("queryOk"))
    mongo_ping_ms = mongo_probe.get("pingMs")
    mongo_error = mongo_probe.get("error") or (None if mongo_ok else info.get("error"))
    if not info.get("configured"):
        mongo_error = info.get("error") or "MONGODB_URI is not configured"

    ws = ws_manager.status()
    snap = session_manager.snapshot()
    sched_state = get_scheduler_state()["state"]
    sched_running = bool(get_scheduler_info()["running"])
    pipeline = tick_buffer.stats()

    runtime = _runtime_snapshot()

    # The session component must describe the REAL broker session, not the
    # managed dummy paper session. session_manager.snapshot() returns whichever
    # terminal session was last written, so with the Dummy paper engine active
    # it reported "active: true / SESSION_ACTIVE" while no Kotak session existed.
    # Report the live Kotak session explicitly and keep the trading context
    # separate, so a parked or logged-out broker can never look healthy.
    try:
        from auth.kotak_client import kotak_session
        broker_session_active = bool(kotak_session.session_active)
    except Exception:
        broker_session_active = False
    _snap_is_dummy = str(snap.get("mode") or "").lower() == "dummy"
    # When the real broker session is down, echoing snap["status"] let the
    # Dummy paper snapshot report SESSION_ACTIVE and turn the component green.
    # Report the broker's own truth instead.
    if broker_session_active:
        broker_status = "SESSION_ACTIVE"
    else:
        broker_status = "SESSION_INACTIVE"

    components = {
        "database": {
            "connected": bool(mongo_ok),
            "provider": f"mongodb-{info.get('source') or 'unknown'}",
            "source": info.get("source") or "unknown",
            "host": info.get("host") or None,
            "database": info.get("database"),
            "configured": bool(info.get("configured")),
            "pingOk": bool(mongo_probe.get("ok")),
            "queryOk": bool(mongo_probe.get("queryOk")),
            "collections": mongo_probe.get("collections"),
            "pingMs": mongo_ping_ms,
            "serverVersion": info.get("serverVersion"),
            "connectedAt": info.get("connectedAt"),
            "pool": info.get("pool"),
            "error": mongo_error,
        },
        "backend": {
            "ready": bool(mongo_ok or SDK_AVAILABLE),
            "sdk_loaded": bool(SDK_AVAILABLE),
            "sdk_version": SDK_VERSION,
        },
        "websocket": {
            "connected": bool(ws.get("connected")),
            "state": ws.get("lifecycle_state") or ws.get("state"),
        },
        "scheduler": {
            "running": bool(sched_running),
            "state": sched_state,
            "tick_collection_time": get_scheduler_info().get("tick_collection_time"),
        },
        "session": {
            # "active" now tracks the real broker session (never the paper engine).
            "active": broker_session_active,
            "status": broker_status,
            "mode": snap.get("mode"),
            "brokerSessionActive": broker_session_active,
            # "tradingContext" is the terminal that receives ORDERS (may be dummy).
            "tradingContext": snap.get("mode"),
            "paperSessionActive": bool(snap.get("active")) and _snap_is_dummy,
        },
        "pipeline": {
            "running": bool(pipeline.get("pipelineRunning")),
            "ticksPerSecond": pipeline.get("ticksPerSecond"),
        },
        "runtime": runtime,
    }
    healthy = bool(mongo_ok)
    status = "ok" if healthy else "degraded"
    code = 200 if healthy else 503
    return Response(
        content=__import__("json").dumps({
            "ok": healthy,
            "status": status,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "components": components,
        }, default=str),
        media_type="application/json",
        status_code=code,
    )


async def _system_snapshot():
    import psutil
    import asyncio

    process = psutil.Process()
    mem = process.memory_info()
    cpu_percent = await asyncio.to_thread(process.cpu_percent, 0.1)
    uptime_sec = time.time() - process.create_time()

    cpu_load = os.getloadavg() if hasattr(os, "getloadavg") else (0, 0, 0)
    ram = psutil.virtual_memory()
    disk = psutil.disk_usage(".")

    # Python status
    python_status = kotak_session.session_info()
    python_status.update(kotak_session.session_detail())

    # WebSocket status
    ws_status = ws_manager.status()
    python_status["subscribed_symbols"] = ws_status.get("subscribed_symbols", 0)
    python_status["reconnect_count"] = ws_status.get("reconnect_count", 0)
    python_status["ws_state"] = ws_status.get("state")

    await set_status(
        "websocket",
        "online" if ws_status.get("connected", False) else "offline",
    )

    # Internet — non-blocking, bounded (6s) and cached (60s) so the dashboard
    # is never blocked for long on a degraded network.
    internet = await broker_cache.get("internet", _check_internet_async, ttl=60.0, fail_cooldown=60.0, timeout=6.0)

    active_stocks = 0
    total_stocks = 0
    today_records = 0
    today_downloads = 0
    summary = None
    last_tick = None
    mongo_ok = is_mongo_connected()
    if mongo_ok:
        try:
            db = get_db()
            active_stocks = await db.stocks.count_documents({"active": True})
            total_stocks = await db.stocks.count_documents({})

            today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
            today_records = await db.ticks.count_documents({"ts": {"$gte": today_start}})
            summary = await db.daily_summaries.find_one({"date": today})
            last_tick = await db.ticks.find_one({}, projection={"symbol": 1, "ts": 1, "_id": 0}, sort=[("ts", -1)])
            today_downloads = await db.download_history.count_documents({"ts": {"$gte": today_start}})
        except Exception as exc:
            logger.warning("system_status: MongoDB queries failed: %s", exc)

    # Live tick / MongoDB saving metrics
    tick_stats = tick_buffer.stats() \
    
    # Trading stats — real values only when a session is live; broker calls are
    # bounded + cached via broker_cache. Use a short overall budget so the
    # dashboard never blocks for a degenerate broker network path.
    # The four reads used to run back-to-back; on a slow broker endpoint each
    # burned its full 3s budget (12s+ wall) and dominated the dashboard's cold
    # build (the mount ~15-25s before timing out on the frontend proxy). They
    # are independent cached reads, so they run concurrently now (worst wall ≈
    # one budget, not four).
    total_orders = None
    total_positions = None
    holdings_count = None
    funds = None

    if kotak_session.session_active:
        async def _bounded(fn, *args, **kwargs):
            try:
                return await asyncio.wait_for(fn(*args, **kwargs), timeout=3.0)
            except (asyncio.TimeoutError, Exception):
                return None
        async def _broker_read():
            return await asyncio.gather(
                broker_cache.get("order_book", lambda: _bounded(kotak_session.async_order_book), ttl=15.0, fail_cooldown=20.0, timeout=3.0),
                broker_cache.get("positions", lambda: _bounded(kotak_session.async_positions), ttl=15.0, fail_cooldown=20.0, timeout=3.0),
                broker_cache.get("holdings", lambda: _bounded(kotak_session.async_holdings), ttl=20.0, fail_cooldown=20.0, timeout=3.0),
                broker_cache.get("limits", lambda: _bounded(kotak_session.async_limits), ttl=30.0, fail_cooldown=20.0, timeout=3.0),
                return_exceptions=True,
            )
        try:
            broker_read = await asyncio.wait_for(_broker_read(), timeout=6.0)
        except asyncio.TimeoutError:
            # Serialized behind broker_cache's gate, four cold reads can queue
            # longer than the sum of their own budgets. The dashboard ships
            # honest nulls for the one cycle (the reads keep filling the
            # cache in the background — the asks were already issued).
            broker_read = (None, None, None, None)
        order_book, positions, holdings, limits = broker_read
        if isinstance(order_book, dict):
            data = order_book.get("data", order_book)
            if isinstance(data, list):
                total_orders = len(data)
        if isinstance(positions, dict):
            data = positions.get("data", positions)
            if isinstance(data, list):
                total_positions = len(data)
        if isinstance(holdings, dict):
            data = holdings.get("data", holdings)
            if isinstance(data, list):
                holdings_count = len(data)
        if isinstance(limits, dict):
            data = limits.get("data", limits)
            if isinstance(data, list):
                funds = {"nets": data, "stat": "Ok"}

   
    # Settings store may hold None (unset) — treat unset as enabled instead
    # of forcing True on every read (`x or True` was always truthy).
    scheduler_enabled = True
    try:
        scheduler_enabled = await get_setting("scheduler_enabled")
        if scheduler_enabled is None:
            scheduler_enabled = True
    except Exception as exc:
        logger.warning("system_status: scheduler_enabled read failed: %s", exc)

    return {
        "node": {
            "status": "ok",
            "uptimeSeconds": round(uptime_sec),
            "memory": {
                "rssMb": round(mem.rss / 1024 / 1024, 2),
                "heapUsedMb": round(mem.rss / 1024 / 1024, 2),
                "heapTotalMb": round(mem.rss / 1024 / 1024, 2),
            },
            "cpuLoad1m": cpu_load[0],
            "cpuLoad5m": cpu_load[1],
            "cpuLoad15m": cpu_load[2],
            "cpuPercent": cpu_percent,
            "ramPercent": ram.percent,
            "ramTotalBytes": ram.total,
            "ramUsedBytes": ram.used,
            "ramFreeBytes": ram.free,
            "diskTotalBytes": disk.total,
            "diskUsedBytes": disk.used,
            "diskPercent": disk.percent,
        },
        "python": {
            "status": "ok" if SDK_AVAILABLE else "degraded",
            "sdk_loaded": SDK_AVAILABLE,
            "version": platform.python_version(),
        },
        "pythonStatus": python_status,
        "mongo": {"connected": is_mongo_connected()},
        "buffer": tick_stats,
        "instrumentCache": instrument_cache.get_status() if instrument_cache else None,
        "instrumentMasterState": (instrument_cache.state() if instrument_cache else None),
        "instrumentCacheLoaded": bool(instrument_cache and instrument_cache.loaded),
        "instrumentCount": (instrument_cache.instrument_count if instrument_cache else 0),
        # Detailed per-service health tracked by the status manager
        # (status / lastChecked / latencyMs / error per service).
        "services": await get_status(),
        # Scheduler schedule details (login/logout windows, next runs).
        "schedulerInfo": get_scheduler_info(),
        # WebSocket connection detail (subscribed symbols, tick count, last tick).
        "websocketDetail": ws_status,
        "activeStocks": active_stocks,
        "totalStocks": total_stocks,
        "todayRecords": today_records,
        "todayInserts": summary.get("totalWrites", 0) if summary else 0,
        "todayDownloads": today_downloads,
        "errorCount": (
                        (summary.get("errorCount", 0) if summary else 0)
                          + tick_stats["totalWriteErrors"]
                        ),
        "lastTickTime": _serialize_tick_ts(last_tick),
        "lastTickSymbol": (last_tick.get("symbol") if last_tick else None),
         
        "lastLogin": python_status.get("last_login_at"),
        "lastLogout": python_status.get("last_logout_at"),
        "lastWebSocketConnection": python_status.get("websocket_connected_at"),
        "websocketConnected": ws_status.get("connected", False),
        "wsConnectedAt": ws_status.get("connected_at"),
        "wsDisconnectedAt": ws_status.get("disconnected_at"),
        "wsLastConnectionAt": ws_status.get("last_connection_at"),
        "wsDisconnectReason": ws_status.get("disconnect_reason"),
        "wsProcessStartedAt": ws_status.get("process_started_at"),
        "wsConnectionHistory": ws_status.get("connection_history", []),
        "wsConnectionHistoryCount": ws_status.get("connection_history_count", 0),
        "schedulerRunning": scheduler_enabled and get_scheduler_info()["running"],
        "schedulerEnabled": scheduler_enabled,
        "schedulerState": get_scheduler_state(),
        "sdkLoaded": SDK_AVAILABLE,
        "sdkVersion": SDK_VERSION,
        "internetConnected": internet,
        "totalOrders": total_orders,
        "totalPositions": total_positions,
        "holdingsCount": holdings_count,
        "funds": funds,
        "liveData": {
        "ticksPerSecond": tick_stats["ticksPerSecond"],
        "writesPerSecond": tick_stats["writesPerSecond"],
        "activeTickStocks": tick_stats["activeTickStocks"],
        "lastTickAt": tick_stats["lastTickAt"],
        "lastWriteAt": tick_stats["lastWriteAt"],
         },
        "feedLatencyMs": tick_stats.get("feedLatencyMs"),
        # Real hop-to-hop transport latency (A-G). Distinct from feedLatencyMs,
        # which is the time since the broker's last trade (feed age).
        "pipelineLatency": pipeline_latency.stats(),
    }


_QUALITY_CACHE: dict[tuple, tuple] = {}
_QUALITY_INFLIGHT: dict[tuple, asyncio.Future] = {}
# Quality metrics recount scans the whole ticks window (distinct + counts) and
# is the slowest component of the dashboard build (~9s worst case). A longer TTL
# keeps the dashboard response fast and stable (STATE A) without changing the
# values themselves — it only controls how often the expensive recount runs.
_QUALITY_TTL = 120.0


async def _compute_quality_metrics(hours: int, limit: int, symbol: str) -> dict:
    """Real data-quality metrics computed from the ticks collection.

    Bounded by a time range (hours) and a row cap (limit) so it stays cheap.
    Every number here is a real aggregation over stored tick documents:
    - total          : ticks in the inspected window
    - duplicates     : same (symbol, ts) recorded more than once
    - timestampErrors: docs whose `ts` is missing or not a timestamp
    - schemaErrors   : docs missing a required field (symbol / ltp / token)
    - outOfOrder     : ticks whose ts is older than the previous tick of the
                       same symbol while scanning the window in ts order
    - saveFailures   : real failed bulk-writes (buffer + daily summary)

    Pass `symbol=<sym>` to scope every metric to one instrument.
    """
    db = get_db()
    # Large windows (168h = 7d) scanning 4M+ ticks with group-by + distinct is >30s
    # and caused the dashboard 502 storm. Cap heavy aggregations: for windows
    # >12h we use a lightweight path (total + timestampErrors only) and skip
    # the expensive duplicate/missing/out-of-order scans. Dashboard will cap its
    # quality window to 6h via _build_dashboard's timeout wrapper.
    effective_hours = min(max(hours, 1), 720)
    # Fast-path flag for very large windows
    is_large = effective_hours > 12 and not symbol
    start = datetime.now(timezone.utc) - timedelta(hours=effective_hours)
    match: dict = {"ts": {"$gte": start}}
    if symbol:
        match["symbol"] = symbol

    async def _safe_count(pipeline: list) -> int:
        try:
            result = await db.ticks.aggregate(pipeline).to_list(length=1)
            return result[0].get("n", 0) if result else 0
        except Exception as exc:
            logger.warning("quality aggregation failed: %s", exc)
            return 0

    # Use bounded count with maxTimeMS to avoid 30s lock on large windows
    try:
        total = await asyncio.wait_for(db.ticks.count_documents(match), timeout=5.0)
    except asyncio.TimeoutError:
        logger.warning("quality total count timed out for hours=%s, using estimated", hours)
        try:
            total = await db.ticks.estimated_document_count()
        except Exception:
            total = 0
    except Exception as exc:
        logger.warning("quality total count failed: %s", exc)
        total = 0

    duplicates = 0
    # Errors of shape/type are counted without the ts>=start clause (a doc
    # with a missing/invalid `ts` can obviously never satisfy ts>=start).
    symbol_scope: dict = {"symbol": match["symbol"]} if match.get("symbol") else {}
    ts_errors_filter: dict = {
        "$or": [
            {"ts": {"$exists": False}},
            {"ts": None},
            {"ts": {"$type": "string"}},
        ]
    }
    # Large windows skip heavy per-window aggregations — they are the 30s
    # timeout root cause. Return lightweight metrics fast; dashboard caps its
    # quality window to 6h separately.
    if is_large:
        # Lightweight: only global timestampErrors + saveFailures, skip
        # window-scoped ltp/schema/missing/duplicates/outOfOrder which each
        # scan millions of docs. Keeps response <3s even at 4M ticks.
        try:
            timestamp_errors = await asyncio.wait_for(
                db.ticks.count_documents({**symbol_scope, **ts_errors_filter}), timeout=4.0
            )
        except asyncio.TimeoutError:
            logger.warning("quality timestampErrors timed out for large window, using 0")
            timestamp_errors = 0
        ltp_errors = 0
        schema_errors = 0
        missing = None
        duplicates = 0
        out_of_order = 0
        scanned = 0
    else:
        try:
            timestamp_errors = await asyncio.wait_for(
                db.ticks.count_documents({**symbol_scope, **ts_errors_filter}), timeout=4.0
            )
        except asyncio.TimeoutError:
            timestamp_errors = 0
        try:
            ltp_errors = await asyncio.wait_for(
                db.ticks.count_documents({
                    **match,
                    "$or": [
                        {"ltp": {"$exists": False}},
                        {"ltp": None},
                        {"master_canonical": {"$exists": True}, "master_canonical.price.last_traded_price": {"$exists": False}},
                        {"master_canonical": {"$exists": True}, "master_canonical.price.last_traded_price": None},
                    ],
                }), timeout=4.0
            )
        except asyncio.TimeoutError:
            ltp_errors = 0
        try:
            schema_errors = await asyncio.wait_for(
                db.ticks.count_documents({
                    **match,
                    "$or": [
                        {"symbol": {"$in": [None, ""]}},
                        {"instrumentToken": {"$in": [None, ""]}},
                        {"ltp": {"$in": [None, ""]}},
                        {"master_canonical": {"$exists": True}, "master_canonical.price.last_traded_price": None},
                    ],
                }), timeout=4.0
            )
        except asyncio.TimeoutError:
            schema_errors = 0

        # "missing": instruments that emitted ticks in the previous window (the
        # same length as the inspected window) but went completely silent in the
        # inspected window. A real, cheap per-day staleness signal.
        missing = 0
        inspected_hours = min(max(hours, 1), 720)
        prev_start = start - timedelta(hours=inspected_hours)
        try:
            prev_filter = {"ts": {"$gte": prev_start, "$lt": start}}
            if match.get("symbol"):
                prev_filter["symbol"] = match["symbol"]
            now_tokens = set(await asyncio.wait_for(db.ticks.distinct("symbol", match), timeout=5.0))
            prev_tokens = set(await asyncio.wait_for(db.ticks.distinct("symbol", prev_filter), timeout=5.0))
            missing = len(prev_tokens - now_tokens)
        except asyncio.TimeoutError:
            logger.warning("missing-metric distinct timed out for hours=%s", hours)
            missing = None
        except Exception as exc:
            logger.warning("missing-metric aggregation failed: %s", exc)
            missing = None

        if total > 0:
            dup_pipeline = [
                {"$match": match},
                {"$group": {"_id": {"symbol": "$symbol", "ts": "$ts"}, "n": {"$sum": 1}}},
                {"$match": {"n": {"$gt": 1}}},
                {"$count": "n"},
            ]
            try:
                duplicates = await asyncio.wait_for(_safe_count(dup_pipeline), timeout=5.0)
            except asyncio.TimeoutError:
                logger.warning("duplicate aggregation timed out for hours=%s", hours)
                duplicates = 0

        # Out-of-order scan: bounded by `limit` sorted rows.
        out_of_order = 0
        scanned = 0
        if total > 0:
            last_ts: dict[str, datetime] = {}
            try:
                cursor = db.ticks.find(
                    match,
                    {"symbol": 1, "ts": 1},
                ).sort("ts", 1).limit(min(max(limit, 100), 500000))
                # Bound the entire scan to 5s so large windows don't hang the dashboard
                async def _scan():
                    nonlocal out_of_order, scanned
                    async for doc in cursor:
                        sym = doc.get("symbol")
                        ts = doc.get("ts")
                        if not sym or not isinstance(ts, datetime):
                            continue
                        seen = last_ts.get(sym)
                        if seen is not None and ts < seen:
                            out_of_order += 1
                        last_ts[sym] = ts
                        scanned += 1
                await asyncio.wait_for(_scan(), timeout=5.0)
            except asyncio.TimeoutError:
                logger.warning("out-of-order scan timed out for hours=%s, scanned %s rows", hours, scanned)
            except Exception as exc:
                logger.warning("out-of-order scan failed: %s", exc)

    # Save failures from the real buffer counters and today's summary.
    tick_stats = tick_buffer.stats()
    save_failures = int(tick_stats.get("totalWriteErrors", 0) or 0)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    summary = await db.daily_summaries.find_one({"date": today})
    attempted_saves = int(tick_stats.get("totalWritten", 0) or 0)
    if summary:
        save_failures += int(summary.get("errorCount", 0) or 0)
        attempted_saves += int(summary.get("totalWrites", 0) or 0)

    # Real quality score from the real rates, clamped 0-100. Only scored when
    # real tick data exists — never a fabricated 100 on an empty pipeline.
    quality_score: int | None = None
    if total > 0 or attempted_saves > 0:
        dup_pct = (duplicates / total * 100) if total else 0.0
        ooo_pct = (out_of_order / total * 100) if total else 0.0
        ts_err_pct = (timestamp_errors / total * 100) if total else 0.0
        sf_pct = (save_failures / attempted_saves * 100) if attempted_saves else 0.0
        raw_score = (
            100
            - dup_pct * 2
            - ooo_pct * 3
            - ts_err_pct * 2
            - sf_pct * 5
        )
        quality_score = int(max(0.0, min(100.0, round(raw_score))))

    return {
        "range": {"from": start.isoformat(), "to": datetime.now(timezone.utc).isoformat()},
        "total": total,
        "duplicates": duplicates,
        "missing": missing,
        "outOfOrder": out_of_order,
        "timestampErrors": timestamp_errors,
        "schemaErrors": schema_errors,
        "invalidLtp": ltp_errors,
        "saveFailures": save_failures,
        "attemptedSaves": attempted_saves,
        "scannedForOutOfOrder": scanned,
        "duplicateRate": round(duplicates / total * 100, 4) if total else None,
        "outOfOrderRate": round(out_of_order / total * 100, 4) if total else None,
        "timestampErrorRate": round(timestamp_errors / total * 100, 4) if total else None,
        "saveFailureRate": round(save_failures / attempted_saves * 100, 4) if attempted_saves else None,
        "qualityScore": quality_score,
        "qualityScoreFormula": (
            "score = 100 − (duplicateRate×2 + outOfOrderRate×3 + timestampErrorRate×2 +"
            " saveFailureRate×5), clamped 0–100. Scored only when real data exists."
        ),
    }


@router.get("/quality-metrics")
async def quality_metrics(hours: str | None = None, limit: str | None = None, symbol: str = ""):
    """Quality metrics are cached for 30s and single-flighted per key so that
    concurrent front-end polls never re-run the same aggregation repeatedly."""
    _h = int(hours) if hours else 24
    _l = int(limit) if limit else 100000
    hours = min(max(_h, 1), 720)
    limit = _l
    key = (hours, limit, symbol)
    now = time.monotonic()
    cached = _QUALITY_CACHE.get(key)
    if cached is not None and now - cached[0] < _QUALITY_TTL:
        return cached[1]

    fut = _QUALITY_INFLIGHT.get(key)
    if isinstance(fut, asyncio.Future):
        try:
            await fut
        except asyncio.CancelledError:
            raise
        except Exception:
            pass
        cached = _QUALITY_CACHE.get(key)
        return cached[1] if cached else None

    fut = asyncio.ensure_future(_compute_quality_metrics(hours, limit, symbol))
    _QUALITY_INFLIGHT[key] = fut

    def _on_done(f):
        if _QUALITY_INFLIGHT.get(key) is f:
            _QUALITY_INFLIGHT.pop(key, None)

    fut.add_done_callback(_on_done)
    try:
        payload = await fut
    except asyncio.CancelledError:
        raise
    except Exception:
        payload = None
    if payload is not None:
        _QUALITY_CACHE[key] = (time.monotonic(), payload)
    return payload


async def _system_events_rows(limit: int) -> list[dict]:
    """Newest-first events from the restart-safe MongoDB history merged with
    the live in-memory ring (which may hold events not yet flushed). Unique
    rows are de-duplicated by (source, event, status, message, ts)."""
    from services.event_history import recent_events, mongo_events, _event_iso

    persisted = await mongo_events(limit=limit)
    ring = recent_events(limit=limit)

    seen = set()
    rows: list[dict] = []
    for row in list(persisted) + ring:
        serialized = dict(row)
        if isinstance(serialized.get("ts"), datetime):
            serialized["ts"] = _event_iso(serialized["ts"])
        key = (
            serialized.get("source"),
            serialized.get("event"),
            serialized.get("status"),
            serialized.get("message"),
            str(serialized.get("ts")),
        )
        if key in seen:
            continue
        seen.add(key)
        rows.append(serialized)

    rows.sort(key=lambda r: str(r.get("ts") or ""), reverse=True)
    return rows[: max(1, min(int(limit), 1000))]


@router.get("/events")
async def system_events(limit: str | None = None, source: str = ""):
    """Append-only lifecycle events (MongoDB-persisted history + live ring)."""
    rows = await _system_events_rows(int(limit) if limit else 100)
    if source:
        rows = [r for r in rows if r.get("source") == source]
    return {"events": rows, "count": len(rows)}


@router.get("/scheduler")
async def system_scheduler():
    """Scheduler state + schedule + next event (backend is source of truth)."""
    return {
        "scheduler": get_scheduler_info(),
        "state": get_scheduler_state(),
        "schedule": get_schedule(),
    }


@router.get("/session")
async def system_session():
    """Central broker session snapshot for every phase."""
    snap = session_manager.snapshot()
    ws = ws_manager.status()
    snap["websocket"]["connected"] = ws["connected"]
    snap["websocket"]["subscribedSymbols"] = ws["subscribed_symbols"]
    snap["websocket"]["subscriptionCount"] = ws["subscription_count"]
    snap["websocket"]["lifecycleState"] = ws["lifecycle_state"]
    snap["websocket"]["websocketId"] = ws["websocket_id"]
    snap["websocket"]["wsSessionId"] = ws["session_id"]
    snap["websocket"]["disconnectReason"] = ws["disconnect_reason"]
    snap["websocket"]["disconnectReasonCode"] = ws["disconnect_reason_code"]
    return {"session": snap}


@router.get("/websocket")
async def system_websocket():
    """Single central broker WebSocket lifecycle detail."""
    return {
        "websocket": ws_manager.status(),
        "expected": {
            "connect": f"{get_scheduler_info()['ws_start_time']} IST",
            "disconnect": f"{get_scheduler_info()['ws_stop_time']} IST",
        },
    }


@router.get("/time")
async def system_time():
    """Canonical server clock — the ONLY time authority for the frontend.

    Financial/session math (countdowns, last-update age, broker session expiry)
    must derive from ``server_time_utc`` / ``now_ist``, never from the browser
    clock. The frontend computes one ``offset_ms`` from this and keeps a
    server-anchored clock for display purposes.
    """
    now_utc = datetime.now(timezone.utc)
    now_ist = now_utc.astimezone(IST)
    return {
        "ok": True,
        "server_time_utc": now_utc.isoformat(),
        "server_time_ist": now_ist.isoformat(),
        "now_ist": now_ist.isoformat(),
        "offset_ms": int((now_ist.utcoffset() or timedelta(0)).total_seconds() * 1000),
        "timezone": "Asia/Kolkata (IST, +05:30)",
        "generated_at": now_utc.isoformat(),
    }


@router.get("/market")
async def system_market():
    """Market calendar + market state service snapshot."""
    from services.market_state import market_state_service
    calendar_snap = market_calendar.snapshot()
    state_snap = market_state_service.get_snapshot()
    calendar_snap["server_time_utc"] = datetime.now(timezone.utc).isoformat()
    calendar_snap["server_time_ist"] = datetime.now(timezone.utc).astimezone(IST).isoformat()
    # Merge calendar snapshot with the richer market state service data
    calendar_snap["market_state"] = state_snap.get("market_state")
    calendar_snap["reason_code"] = state_snap.get("reason_code")
    calendar_snap["reason_message"] = state_snap.get("reason_message")
    calendar_snap["market_state_source"] = state_snap.get("source")
    calendar_snap["confirmation_window_active"] = state_snap.get("confirmation_window_active")
    calendar_snap["ticks_in_window"] = state_snap.get("ticks_received_in_window")
    calendar_snap["unique_instruments_in_window"] = state_snap.get("unique_instruments_with_ticks")
    calendar_snap["first_tick_at"] = state_snap.get("first_tick_at")
    calendar_snap["last_tick_at"] = state_snap.get("last_tick_at")
    calendar_snap["daily_decision"] = market_state_service.get_daily_decision()
    return calendar_snap


_MONGO_CACHE: dict = {}
_MONGO_CACHE_AT = 0.0
_MONGO_TTL = 10.0


@router.get("/mongo-stats")
def _schedule_mongo_stats_rebuild() -> None:
    """Refresh the Mongo stats cache in the background (single-flight).

    Callers keep the last-known stats immediately; the rebuild result replaces
    the cache as soon as it is ready. Guarded by an inflight flag so a burst of
    dashboard polls cannot stack several long builds on a slow cluster.
    """
    global _MONGO_BG_TASK
    task = _MONGO_BG_TASK
    if task is not None and not task.done():
        return
    try:
        _MONGO_BG_TASK = asyncio.ensure_future(_rebuild_mongo_stats_bg())
    except RuntimeError:
        pass


async def _rebuild_mongo_stats_bg() -> None:
    try:
        payload = await _compute_mongo_stats()
    except Exception as exc:
        logger.warning("background mongo stats rebuild failed: %s", exc)
        return
    _MONGO_CACHE.clear()
    _MONGO_CACHE.update(payload)
    _MONGO_CACHE_AT = time.monotonic()


async def prewarm_mongo_stats(delay_s: float = 12.0) -> None:
    """Build the Mongo collection-stats cache once at boot, off the request path.

    The first build walks every collection (collStats + bounds per collection)
    and can take tens of seconds on a remote cluster. Paying it in the
    background at startup means dashboards always find a warm cache instead of
    running the only-then-inline build against the frontend timeout.
    """
    try:
        if delay_s > 0:
            await asyncio.sleep(delay_s)
        await _rebuild_mongo_stats_bg()
        logger.info("mongo stats prewarming complete")
    except Exception as exc:  # never let observability prewarm break boot
        logger.warning("mongo stats prewarm failed (non-critical): %s", exc)


_MONGO_BG_TASK: asyncio.Task | None = None


async def mongo_stats():
    global _MONGO_CACHE_AT
    now = time.monotonic()
    if _MONGO_CACHE_AT and now - _MONGO_CACHE_AT < _MONGO_TTL:
        return _MONGO_CACHE
    if _MONGO_CACHE_AT:
        # A previous build exists but is STALE: serve it immediately and
        # refresh in the background. Rebuilding inline here blocked the ONLY
        # caller (the dashboard aggregation) for the whole cold build —
        # 12s+ on Atlas M0 — and turned into REST timeouts.
        _schedule_mongo_stats_rebuild()
        return _MONGO_CACHE
    try:
        payload = await _compute_mongo_stats()
    except Exception as exc:
        logger.warning("mongo_stats computation failed: %s", exc)
        return {"connected": False, "stats": None, "error": str(exc)}
    _MONGO_CACHE.clear()
    _MONGO_CACHE.update(payload)
    _MONGO_CACHE_AT = time.monotonic()
    return payload


async def _collection_bounds(client, db_name, collection: str):
    """Real first/last record timestamps for a collection when it has a `ts`
    field. Returns (firstIso, lastIso, hasTs) — never fabricated."""
    try:
        coll = client[db_name][collection]
        # Quick existence probe for a ts field using a single sample doc.
        # Each leg is individually bounded: a slow provider must not hold this
        # open-ended — the caller accumulates round-trips for every collection.
        sample = await asyncio.wait_for(coll.find_one({}).limit(1), 2.5)
        if not sample or "ts" not in sample:
            return None, None, False
        first = await asyncio.wait_for(
            coll.find({}, {"ts": 1, "_id": 0}).sort("ts", 1).limit(1).to_list(1), 2.5)
        last = await asyncio.wait_for(
            coll.find({}, {"ts": 1, "_id": 0}).sort("ts", -1).limit(1).to_list(1), 2.5)
        first_iso = _iso_dt(first[0].get("ts")) if first else None
        last_iso = _iso_dt(last[0].get("ts")) if last else None
        return first_iso, last_iso, True
    except Exception:
        return None, None, False


def _iso_dt(v) -> str | None:
    """Normalize a Mongo datetime (naive = UTC) to an ISO string; else None."""
    from datetime import datetime, timezone
    if isinstance(v, datetime):
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        return v.astimezone(timezone.utc).isoformat()
    return None


async def _compute_mongo_stats():
    from services.json_safe import sanitize_for_json
    from database.connection import get_mongo_info

    info = get_mongo_info()
    source = info.get("source") or "unknown"
    disconnected = {
        "connected": False,
        "source": source,
        "provider": f"mongodb-{source}",
        "error": info.get("error") or "not connected",
        "stats": None,
    }
    try:
        db = get_db()
    except Exception as exc:
        return {**disconnected, "error": info.get("error") or str(exc)}

    if not is_mongo_connected():
        return disconnected

    client = db.client
    db_name = db.name
    collections = []

    try:
        collections_info = await client[db_name].list_collection_names()
    except Exception as exc:
        logger.warning("list_collection_names failed: %s", exc)
        collections_info = []

    # Per-command bounds + an overall loop budget: this build walks EVERY
    # collection with several round-trips each (collStats + bounds) and, on a
    # slow provider (Atlas M0 over TLS), a single unbounded build could block
    # its ONLY caller (the dashboard aggregation) for minutes — the observable
    # symptom was "/api/system/dashboard never returns". Partial stats with a
    # `statsComplete: False` marker are strictly better than a hung request.
    _STATS_CMD_TIMEOUT_S = 5.0
    _BOUNDS_TIMEOUT_S = 2.5
    _COLLECTIONS_LOOP_BUDGET_S = 25.0
    loop_started = time.monotonic()
    stats_complete = True

    for name in collections_info:
        try:
            if time.monotonic() - loop_started > _COLLECTIONS_LOOP_BUDGET_S:
                logger.warning(
                    "mongo collection stats budget exceeded after %d/%d collections — returning partial stats",
                    len(collections), len(collections_info),
                )
                stats_complete = False
                break
            count = await asyncio.wait_for(
                client[db_name][name].estimated_document_count(), _STATS_CMD_TIMEOUT_S)
            stats = sanitize_for_json(await asyncio.wait_for(
                client[db_name].command("collstats", name), _STATS_CMD_TIMEOUT_S))
            # Empty collections have no first/last record (skipping the three
            # sorted-find round-trips is honest, not fabricated — nothing exists).
            if count:
                first_iso, last_iso, has_ts = await _collection_bounds(client, db_name, name)
            else:
                first_iso, last_iso, has_ts = None, None, False
            wt = stats.get("wiredTiger") or {}
            collections.append({
                "name": name,
                "count": count,
                "sizeBytes": stats.get("size", 0),
                "dataSizeBytes": stats.get("size", 0),
                "storageBytes": stats.get("storageSize", 0),
                "indexSizeBytes": stats.get("totalIndexSize", 0),
                "indexes": stats.get("nindexes", 0),
                "ns": stats.get("ns", f"{db_name}.{name}"),
                "avgObjSizeBytes": stats.get("avgObjSize", 0),
                "capped": bool(stats.get("capped", False)),
                "max": stats.get("max", None),
                "maxSizeBytes": stats.get("maxSize", None),
                "freeStorageBytes": stats.get("freeStorageSize", None),
                "firstRecord": first_iso,
                "lastRecord": last_iso,
                "hasTimeField": has_ts,
                "wiredTigerStorageBytes": (
                    (wt.get("cache", {}) or {}).get("bytes_in_use") or None
                ),
            })
        except Exception as exc:
            logger.warning("Mongo collection stats failed for %s: %s", name, exc)

    try:
        db_stats = sanitize_for_json(await client[db_name].command("dbStats"))
    except Exception as exc:
        logger.warning("dbStats command failed: %s", exc)
        db_stats = {}

    ping_start = time.monotonic()
    try:
        await client[db_name].command("ping")
        ping_ms = round((time.monotonic() - ping_start) * 1000, 2)
    except Exception as exc:
        logger.warning("ping command failed: %s", exc)
        ping_ms = None

    from datetime import datetime, timezone
    source = info.get("source") or "unknown"
    return {
        "connected": True,
        "source": source,
        "provider": f"mongodb-{source}",
        "host": info.get("host") or None,
        "serverVersion": info.get("serverVersion"),
        "error": None,
        "statsComplete": stats_complete,
        "stats": {
            "dbName": db_name,
            "collections": collections,
            "collectionsCount": len(collections),
            "indexesCount": sum(c["indexes"] for c in collections),
            "totalSizeBytes": db_stats.get("dataSize", 0),
            "totalStorageBytes": db_stats.get("storageSize", 0),
            "totalIndexSizeBytes": db_stats.get("indexSize", 0),
            "totalObjects": db_stats.get("objects", 0),
            "pingMs": ping_ms,
            "lastUpdatedAt": datetime.now(timezone.utc).isoformat(),
        },
    }


@router.post("/logs/clear")
async def clear_logs(req: ClearLogsRequest):
    db = get_db()
    filter = {"category": req.category} if req.category else {}
    result = await db.app_logs.delete_many(filter)
    return {"deleted": result.deleted_count}


@router.get("/download-history")
async def download_history():
    db = get_db()
    cursor = db.download_history.find({}).sort("ts", -1).limit(50)
    items = await cursor.to_list(length=50)
    return {"count": len(items), "downloads": sanitize_for_json(items)}


@router.get("/trading-day-stats")
async def trading_day_stats(date: str = ""):
    target_date = date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    db = get_db()
    summary = await db.daily_summaries.find_one({"date": target_date})

    orders = 0
    pnl = 0
    wins = 0
    losses = 0
    charges = 0

    if kotak_session.session_active:
        order_book = await broker_cache.get("order_book", kotak_session.async_order_book, ttl=5.0, fail_cooldown=10.0, timeout=4.0)
        if isinstance(order_book, dict):
            data = order_book.get("data", order_book)
            if isinstance(data, list):
                orders = len(data)
                completed = [o for o in data if isinstance(o, dict) and o.get("status") in ("complete", "filled")]
                wins = sum(1 for o in completed if float(o.get("pnl", o.get("realised", 0)) or 0) >= 0)
                losses = sum(1 for o in completed if float(o.get("pnl", o.get("realised", 0)) or 0) < 0)

        positions = await broker_cache.get("positions", kotak_session.async_positions, ttl=5.0, fail_cooldown=10.0, timeout=4.0)
        if isinstance(positions, dict):
            data = positions.get("data", positions)
            if isinstance(data, list):
                pnl = sum(float(p.get("realised", 0) or 0) + float(p.get("unrealised", 0) or 0) for p in data if isinstance(p, dict))
                charges = sum(float(p.get("estimated_charges", p.get("charges", 0)) or 0) for p in data if isinstance(p, dict))

    win_rate = round((wins / orders) * 100) if orders > 0 else 0
    loss_rate = round((losses / orders) * 100) if orders > 0 else 0
    net_profit = pnl - charges

    return {
        "date": target_date,
        "todayPnl": pnl,
        "todayTrades": orders,
        "todayWins": wins,
        "todayLosses": losses,
        "todayWinRate": win_rate,
        "todayLossRate": loss_rate,
        "todayCharges": charges,
        "todayNetProfit": net_profit,
        "summary": sanitize_for_json(summary),
    }


@router.get("/trading-history")
async def trading_history(range: str = "daily", limit: str | None = None):
    max_limit = min(max(int(limit) if limit else 30, 1), 365)
    db = get_db()

    if range == "weekly":
        pipeline = [
            {"$group": {"_id": {"year": {"$year": "$date"}, "week": {"$week": "$date"}},
                        "count": {"$sum": 1}, "totalTicks": {"$sum": "$totalTicks"},
                        "totalWrites": {"$sum": "$totalWrites"}, "errorCount": {"$sum": "$errorCount"}}},
            {"$sort": {"_id": 1}},
            {"$limit": max_limit},
        ]
    elif range == "monthly":
        pipeline = [
            {"$group": {"_id": {"year": {"$year": "$date"}, "month": {"$month": "$date"}},
                        "count": {"$sum": 1}, "totalTicks": {"$sum": "$totalTicks"},
                        "totalWrites": {"$sum": "$totalWrites"}, "errorCount": {"$sum": "$errorCount"}}},
            {"$sort": {"_id": 1}},
            {"$limit": max_limit},
        ]
    elif range == "yearly":
        pipeline = [
            {"$group": {"_id": {"year": {"$year": "$date"}},
                        "count": {"$sum": 1}, "totalTicks": {"$sum": "$totalTicks"},
                        "totalWrites": {"$sum": "$totalWrites"}, "errorCount": {"$sum": "$errorCount"}}},
            {"$sort": {"_id": 1}},
            {"$limit": max_limit},
        ]
    else:
        cursor = db.daily_summaries.find({}).sort("date", -1).limit(max_limit)
        results = await cursor.to_list(length=max_limit)
        results.reverse()
        return {"range": range, "count": len(results), "data": sanitize_for_json(results)}

    results = await db.daily_summaries.aggregate(pipeline).to_list(length=max_limit)
    return {"range": range, "count": len(results), "data": sanitize_for_json(results)}


async def _check_internet_async() -> bool:
    """Non-blocking internet probe (blocking probe runs off the event loop)."""
    return await asyncio.to_thread(_probe_internet_blocking)


def _probe_internet_blocking() -> bool:
    try:
        import urllib.request
        req = urllib.request.Request("https://www.google.com", method="HEAD")
        with urllib.request.urlopen(req, timeout=6) as resp:
            return resp.status < 500
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Real per-directory storage usage (export artifacts + logs).
# ---------------------------------------------------------------------------
_STORAGE_DIRS_CACHE: dict = {}
_STORAGE_DIRS_AT = 0.0
_STORAGE_DIRS_TTL = 60.0


async def _dir_size_on_disk(path: Path) -> int:
    """Real bytes on disk for a directory tree (off the event loop)."""
    def _walk() -> int:
        total = 0
        try:
            for root, _dirs, files in os.walk(path):
                for name in files:
                    try:
                        total += os.path.getsize(os.path.join(root, name))
                    except OSError:
                        pass
        except Exception:
            return 0
        return total
    try:
        return await asyncio.to_thread(_walk)
    except Exception:
        return 0


async def _storage_dir_sizes() -> dict:
    """Cached real on-disk sizes for the export dir and the log dir."""
    global _STORAGE_DIRS_AT
    now = time.monotonic()
    if _STORAGE_DIRS_AT and now - _STORAGE_DIRS_AT < _STORAGE_DIRS_TTL:
        return _STORAGE_DIRS_CACHE

    try:
        from services.exporter import EXPORT_DIR
    except Exception:
        EXPORT_DIR = None
    try:
        from logger import LOG_DIR
    except Exception:
        LOG_DIR = None

    dirs = []
    for name, path in (("exports", EXPORT_DIR), ("logs", LOG_DIR)):
        exists = path is not None and Path(path).is_dir()
        size = await _dir_size_on_disk(Path(path)) if exists else None
        dirs.append({"name": name, "bytes": size, "present": bool(exists)})

    payload = {"dirs": dirs}
    _STORAGE_DIRS_CACHE.clear()
    _STORAGE_DIRS_CACHE.update(payload)
    _STORAGE_DIRS_AT = time.monotonic()
    return payload


# ---------------------------------------------------------------------------
# Aggregated Data Saver dashboard payload — ONE endpoint for the dashboard.
# Cached (5s) + single-flighted so N polling clients never fan out to N
# MongoDB scans. Contains only REAL backend data; NEVER any credentials.
# ---------------------------------------------------------------------------
_DASHBOARD_CACHE: dict = {}
_DASHBOARD_INFLIGHT: dict = {}
_DASHBOARD_TTL = 15.0  # increased from 5s to reduce Mongo pressure + 502 spam under 95% RAM

# ---------------------------------------------------------------------------
# Alert lifecycle — real ALERT_CREATED / ALERT_RESOLVED events derived from
# actual backend conditions. Alerts reference the underlying event (event_id)
# so the audit trail is traceable end-to-end. State is process-lifetime; a
# restart re-baselines to the current conditions (no fabricated history).
# ---------------------------------------------------------------------------
_ALERT_SINCE: dict[str, dict] = {}
_QUALITY_BREACH_RECORDED_AT = 0.0
_QUALITY_BREACH_COOLDOWN = 1800.0  # 30 min


def _trigger_event(events: list[dict], *, source: str | None = None,
                   event: str | None = None, reason_code: str | None = None) -> dict | None:
    """Newest-first scan for the event that triggered/recently caused a condition.

    Used to bind every derived alert to a real underlying lifecycle event.
    Returns None (no fabricated reference) when nothing matches yet.
    """
    for e in events:
        if source is not None and e.get("source") != source:
            continue
        if event is not None and e.get("event") != event:
            continue
        if reason_code is not None and (e.get("reason_code") or "") != reason_code:
            continue
        return e
    return None


def _record_pipeline_event(event: str, message: str, meta: dict) -> None:
    try:
        from services.notification_center import emit_event as record_event
        record_event("pipeline", event, meta.get("status", "info"), message, meta)
    except Exception:
        logger.debug("pipeline event not recorded: %s", event)


def _sync_alert_events(active: dict[str, dict], now_mono: float) -> None:
    """Record ALERT_CREATED for newly-seen conditions and ALERT_RESOLVED for
    conditions that cleared — each referencing the alert id + reason_code."""
    for alert_id, info in active.items():
        if alert_id not in _ALERT_SINCE:
            ev = _record_pipeline_event(
                "ALERT_CREATED",
                f"{info.get('title', alert_id)}",
                {"status": info.get("severity", "warning"), "reason": info.get("reason", ""),
                 "reason_code": info.get("reason_code", "system"), "component": info.get("component", "system"),
                 "details": info.get("message", ""), "related_event_id": info.get("eventId") or "",
                 "alert_id": alert_id},
            )
            _ALERT_SINCE[alert_id] = {"at": now_mono,
                                      "eventId": (ev or {}).get("event_id") or info.get("eventId"),
                                      "reason_code": info.get("reason_code", "system")}
    for alert_id, since in list(_ALERT_SINCE.items()):
        if alert_id not in active:
            info = since
            duration = round(now_mono - info["at"], 1)
            _record_pipeline_event(
                "ALERT_RESOLVED",
                f"{alert_id} cleared",
                {"status": "info", "reason": "resolved", "reason_code": info.get("reason_code", "system"),
                 "component": "system", "details": f"alert_id={alert_id}",
                 "duration": duration,
                 "resolved_at": datetime.now(timezone.utc).isoformat(),
                 "related_event_id": info.get("eventId") or ""},
            )
            _ALERT_SINCE.pop(alert_id, None)


@router.get("/dashboard")
async def system_dashboard(hours: str | None = None):
    """Aggregated Data Saver dashboard block (cached + request-deduped).

    Serve-stale: once a keyed build exists, expired caches return the last
    payload instantly and refresh in the background. The previous inline
    rebuild-on-expiry blocked the ONLY first hit after each idle window for
    the full ~16s build (the dashboard mount's 25s proxy budget — user-visible
    as a "rendering" stall on the page after every break).
    """
    _h = int(hours) if hours else 168
    key = min(max(_h, 1), 720)
    now = time.monotonic()
    cached = _DASHBOARD_CACHE.get(key)
    if cached is not None and now - cached[0] < _DASHBOARD_TTL:
        return cached[1]
    if cached is not None:
        fut = _DASHBOARD_INFLIGHT.get(key)
        if not isinstance(fut, asyncio.Future) or fut.done():
            _schedule_dashboard_rebuild(key)
        return cached[1]

    fut = asyncio.ensure_future(_build_dashboard(hours))
    _DASHBOARD_INFLIGHT[key] = fut

    def _done(f):
        if _DASHBOARD_INFLIGHT.get(key) is f:
            _DASHBOARD_INFLIGHT.pop(key, None)

    fut.add_done_callback(_done)
    try:
        payload = await fut
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        payload = None
        logger.exception("dashboard build failed: %s", exc)
    if payload is not None:
        _DASHBOARD_CACHE[key] = (time.monotonic(), payload)
    return payload


_DASHBOARD_REBUILD_TASK: dict[int, asyncio.Task] = {}


def _schedule_dashboard_rebuild(key: int) -> None:
    """Refresh one dashboard build in the background (single-flight per key)."""
    global _DASHBOARD_REBUILD_TASK
    task = _DASHBOARD_REBUILD_TASK.get(key)
    if task is not None and not task.done():
        return
    try:
        _DASHBOARD_REBUILD_TASK[key] = asyncio.ensure_future(_rebuild_dashboard_bg(key))
    except RuntimeError:
        pass


async def _rebuild_dashboard_bg(key: int) -> None:
    try:
        payload = await _build_dashboard(str(key))
    except Exception as exc:
        logger.warning("background dashboard rebuild failed for %sh: %s", key, exc)
        return
    if payload is not None:
        _DASHBOARD_CACHE[key] = (time.monotonic(), payload)


async def prewarm_system_dashboard(delay_s: float = 20.0) -> None:
    """Build the default-hours dashboard once at boot, off the request path.

    The first build aggregates system + quality + mongo + events and can take
    tens of seconds under live-feed load; paying it in the background at
    startup means the first page that mounts the dashboard finds a warm cache
    instead of running the only-then-inline build against the proxy timeout.
    """
    try:
        if delay_s > 0:
            await asyncio.sleep(delay_s)
        await _rebuild_dashboard_bg(168)
        logger.info("system dashboard prewarming complete (168h)")
    except Exception as exc:  # never let observability prewarm break boot
        logger.warning("system dashboard prewarm failed (non-critical): %s", exc)


# ---------------------------------------------------------------------------
# Scheduler event lifecycle — real per-event detail for the dashboard.
#
# For each of the four lifecycle transitions (login / ws_connect /
# ws_disconnect / logout) we derive a status from REAL data only:
#   - the scheduled window time (from the backend's daily schedule)
#   - the actual occurrence time (from the append-only event history trail)
#   - the persisted scheduler-run ledger (status + reason per job)
#   - the scheduler state machine + live session/feed state
#   - the market calendar + current IST clock
#
# Status vocabulary (never fabricated): NOT_APPLICABLE, UPCOMING, DUE, ACTIVE,
# RUNNING, CATCHING_UP, RETRYING, WAITING, COMPLETED, FAILED, SKIPPED.
# ``SKIPPED`` is emitted ONLY when the outcome was genuinely unnecessary
# (disabled in settings / expired window / subsumed) — never merely because the
# loop missed the exact scheduled instant. Every entry also carries the real
# scheduled / actual timestamps, the ledger status + reason when known, and the
# source when known.
# ---------------------------------------------------------------------------
_SCHEDULER_EVENT_SPECS = [
    {
        "code": "login",
        "label": "LOGIN",
        "ledger_job": "login",
        "schedule_name": "today_login_time",
        "scheduled_time": "login_time",
        # Actual execution is the latest login_ok from the scheduler trail.
        "actual_events": ("login_ok",),
        "failure_events": ("login_failed", "ws_auth_failure"),
        "active_states": ("SESSION_ACTIVE", "LOGGING_IN", "WAITING_FOR_LOGIN",
                          "LOGIN_FAILED", "SESSION_EXPIRED", "STARTING"),
        "running_states": ("LOGGING_IN",),
        "retry_states": ("LOGIN_FAILED",),
        "waiting_states": ("WAITING_FOR_LOGIN",),
        "satisfied_check": "session_active",
        "source_fallback": "scheduler",
    },
    {
        "code": "ws_connect",
        "label": "WS CONNECT",
        "ledger_job": "ws_start",
        "schedule_name": "today_ws_connect_time",
        "scheduled_time": "ws_start_time",
        "actual_events": ("state:WS_ACTIVE",),
        "failure_events": ("ws_connect_failed",),
        "active_states": ("WS_ACTIVE", "WS_CONNECTING", "WS_RECONNECTING",
                          "WAITING_FOR_WS"),
        "running_states": ("WS_CONNECTING",),
        "retry_states": ("WS_RECONNECTING",),
        "waiting_states": ("WAITING_FOR_WS",),
        "satisfied_check": "ws_connected",
        "source_fallback": "scheduler",
    },
    {
        "code": "ws_disconnect",
        "label": "WS DISCONNECT",
        "ledger_job": "ws_stop",
        "schedule_name": "today_ws_disconnect_time",
        "scheduled_time": "ws_stop_time",
        "actual_events": ("ws_stop",),
        "failure_events": (),
        "active_states": ("WS_DISCONNECTING", "LOGGING_OUT", "LOGGED_OUT",
                          "MARKET_CLOSED"),
        "running_states": ("WS_DISCONNECTING", "LOGGING_OUT"),
        "retry_states": (),
        "waiting_states": (),
        "satisfied_check": None,
        "source_fallback": "scheduler",
    },
    {
        "code": "logout",
        "label": "LOGOUT",
        "ledger_job": "logout",
        "schedule_name": "today_logout_time",
        "scheduled_time": "logout_time",
        "actual_events": ("logout_ok",),
        "failure_events": (),
        "active_states": ("LOGGING_OUT", "LOGGED_OUT", "MARKET_CLOSED",
                          "SESSION_EXPIRED"),
        "running_states": ("LOGGING_OUT",),
        "retry_states": (),
        "waiting_states": (),
        "satisfied_check": None,
        "source_fallback": "scheduler",
    },
]


def _parse_iso(iso) -> datetime | None:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(str(iso))
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=IST)
    else:
        dt = dt.astimezone(IST)
    return dt


_LEDGER_DONE = {"COMPLETED", "ALREADY_SATISFIED"}
_LEDGER_SKIP = {"MISSED_EXPIRED", "SKIPPED"}
_LEDGER_WORKING = {"CATCHING_UP", "RUNNING", "MISSED"}


def _runtime_ws_enabled() -> bool:
    try:
        from services.runtime_settings import rt_bool
        return bool(rt_bool("ws_enabled", True))
    except Exception:
        return True


def _active_terminal_mode() -> str | None:
    try:
        from brokers.manager import active_terminal, is_dummy_mode
        if is_dummy_mode():
            return "dummy"
        term = active_terminal()
        return str(term) if term else None
    except Exception:
        return None


def _scheduler_event_lifecycle(
    events: list[dict],
    schedule: dict,
    windows: dict,
    is_trading_day: bool,
    scheduler_state: str | None,
    now: datetime | None = None,
    ledger_jobs: dict | None = None,
    session_active: bool = False,
    ws_connected: bool = False,
    ws_enabled: bool = True,
    sched_enabled: bool = True,
    terminal_mode: str | None = None,
) -> list[dict]:
    """Build the four lifecycle events from real backend data + event trail.

    Status is derived from REAL data only (scheduled time, actual execution
    events, the persisted scheduler-run ledger, the scheduler state machine and
    the live session/feed). ``SKIPPED`` is only emitted when the outcome was
    genuinely unnecessary (disabled / expired / already satisfied) — never
    merely because the loop missed the exact scheduled instant.
    """
    now = now or datetime.now(IST)
    today = now.date()
    ledger_jobs = ledger_jobs or {}

    def _latest_actual(names: tuple) -> dict | None:
        for evt in events:
            ev = str(evt.get("event") or "")
            if ev in names:
                ts = _parse_iso(evt.get("ts"))
                if ts is None:
                    continue
                if ts.astimezone(IST).date() == today:
                    return {
                        "at": ts.astimezone(IST).isoformat(),
                        "source": str((evt.get("meta") or {}).get("source") or evt.get("source") or ""),
                        "reason": str(evt.get("reason") or evt.get("details") or ""),
                        "message": str(evt.get("message") or ""),
                        "status": str(evt.get("status") or evt.get("severity") or ""),
                    }
        return None

    def _latest_failure(names: tuple) -> dict | None:
        for evt in events:
            ev = str(evt.get("event") or "")
            if ev in names:
                ts = _parse_iso(evt.get("ts"))
                if ts is None:
                    continue
                if ts.astimezone(IST).date() == today:
                    return {
                        "at": ts.astimezone(IST).isoformat(),
                        "reason": str(evt.get("reason") or evt.get("message") or ""),
                    }
        return None

    out: list[dict] = []
    for spec in _SCHEDULER_EVENT_SPECS:
        code = spec["code"]
        ledger_job = spec.get("ledger_job", code)
        scheduled_iso = schedule.get(spec["schedule_name"]) if is_trading_day else None
        scheduled_at = _parse_iso(scheduled_iso)
        # "wall time" label from the schedule.timezone block (e.g. "09:00").
        wt = str((windows or {}).get(spec["scheduled_time"]) or "")
        scheduled_clock = wt or (scheduled_at.strftime("%H:%M") if scheduled_at else "")

        actual = _latest_actual(spec["actual_events"])
        failure = _latest_failure(spec["failure_events"])
        run = ledger_jobs.get(ledger_job) or {}
        ledger_status = str(run.get("status") or "").upper()
        ledger_reason = str(run.get("reason") or "")
        ledger_reason_code = str(run.get("reason_code") or "") or None
        attempt = run.get("attempt")

        # ---- status derivation (real data only) -------------------------
        status: str | None = None
        explanation: str | None = None

        if not is_trading_day or scheduled_at is None:
            status = "NOT_APPLICABLE"
            explanation = (
                "Not a trading day — this scheduled transition does not apply today."
                if is_trading_day is False
                else "No scheduled time for today."
            )
        elif actual is not None and (failure is None
                                     or _parse_iso(failure["at"]) <= _parse_iso(actual["at"])):
            status = "COMPLETED"
            executed = _parse_iso(actual["at"])
            explanation = (
                f"Executed at {executed.strftime('%H:%M:%S')} IST."
                + (f" Source: {actual.get('source') or 'scheduler'}."
                   if actual.get("source") else "")
            )
        elif failure is not None and spec["failure_events"]:
            status = "FAILED"
            explanation = f"Failed: {failure.get('reason') or 'see event trail'}."
        else:
            # No terminal outcome yet — read the real scheduler + ledger state.
            if ledger_status in _LEDGER_DONE:
                status = "COMPLETED"
                explanation = (
                    f"Outcome already satisfied — {ledger_reason}."
                    if ledger_reason
                    else "Outcome already satisfied — no action needed."
                )
            elif ledger_status in _LEDGER_SKIP:
                status = "SKIPPED"
                explanation = (
                    f"Skipped — {ledger_reason}."
                    if ledger_reason
                    else "Skipped — this action is not applicable today."
                )
            elif ledger_status in {"WAITING_NETWORK", "MISSED_WAITING_NETWORK"}:
                status = "WAITING"
                explanation = (
                    "Waiting for the network — execution resumes automatically "
                    "when connectivity is back."
                )
            elif ledger_status in _LEDGER_WORKING:
                status = "CATCHING_UP"
                explanation = (
                    "Scheduled execution is being caught up"
                    + (f" ({ledger_reason})" if ledger_reason else "")
                    + "."
                )
            elif scheduler_state in spec["retry_states"]:
                status = "RETRYING"
                explanation = (
                    f"Automatic {code} attempt failed earlier; retrying"
                    + (f" ({ledger_reason})" if ledger_reason else "")
                    + "."
                )
            elif scheduler_state in spec["running_states"]:
                status = "RUNNING"
                explanation = f"Executing now (scheduler state {scheduler_state})."
            elif scheduler_state in spec["waiting_states"]:
                status = "WAITING"
                explanation = (
                    f"Waiting for its {scheduled_clock or 'scheduled'} IST slot to open."
                )
            elif spec.get("satisfied_check") == "session_active" and session_active:
                status = "COMPLETED"
                explanation = "Already satisfied — a valid broker session is active."
            elif spec.get("satisfied_check") == "ws_connected" and ws_connected:
                status = "COMPLETED"
                explanation = "Already satisfied — the WebSocket feed is connected."
            elif scheduled_at > now:
                if scheduler_state and scheduler_state in spec["active_states"]:
                    status = "ACTIVE"
                    explanation = (
                        f"Currently the active scheduler stage (state {scheduler_state})."
                    )
                else:
                    status = "UPCOMING"
                    explanation = (
                        f"Scheduled at {scheduled_clock or scheduled_at.strftime('%H:%M')} IST."
                    )
            else:
                # Past due with no execution — never a silent SKIPPED. Show the
                # real reason it was not performed, or the honest DUE state.
                disabled_reason = None
                if not sched_enabled and code in {"login", "ws_connect"}:
                    disabled_reason = f"{code} disabled in settings (sched_enabled=false)"
                elif terminal_mode == "dummy" and code in {"login", "ws_connect"}:
                    disabled_reason = (
                        "dummy mode active — no broker session "
                        + ("(login disabled)" if code == "login" else "(feed not started)")
                    )
                elif code == "ws_connect" and not ws_enabled:
                    disabled_reason = "WebSocket feed disabled in settings"
                if disabled_reason:
                    status = "SKIPPED"
                    explanation = f"Skipped — {disabled_reason}."
                else:
                    status = "DUE"
                    explanation = (
                        f"Scheduled at {scheduled_clock} IST; execution pending/in progress."
                    )

        # Duration = actual_start .. actual_end for the paired stage. For the
        # scheduler lifecycle we only have a single marker per transition, so
        # expose the raw event when present and leave duration to the segment
        # pairing on the frontend when both endpoints are known.
        source = None
        if actual:
            src = actual.get("source")
            if src and src.lower() in {"manual", "scheduler", "system"}:
                source = src.lower()
        if source is None and spec["code"] == "login" and actual:
            # login_ok carries the true source in meta.source (manual vs
            # scheduler) — already surfaced via actual['source'].
            source = spec["source_fallback"]

        out.append({
            "code": code,
            "label": spec["label"],
            "status": status,
            "explanation": explanation,
            "scheduled": scheduled_iso,
            "scheduledWallTime": wt or None,
            "actual": actual["at"] if actual else None,
            "actualSource": source,
            "actualReason": (actual.get("reason") if actual and failure is None
                             else (failure.get("reason") if failure else None)) or None,
            "ledgerStatus": ledger_status or None,
            "ledgerReason": ledger_reason or None,
            "ledgerReasonCode": ledger_reason_code,
            "attempt": attempt,
            "durationSeconds": None,
        })
    return out


async def _build_dashboard(hours: int) -> dict:
    # Run independent I/O-bound aggregations in parallel — sequential awaits
    # summed to >15s under load (quality 10s + mongo 2s + system 2s + events 1s),
    # causing the Next.js proxy (15s timeout) to 502. Parallelism cuts p95
    # from ~15s to ~6-8s even at 95% RAM.
    async def _quality_capped(h: int):
        # Large windows (168h = 7d) were the 502 root cause (30s+ on 4M ticks).
        # quality_metrics now has a lightweight path for >12h (skips duplicate/
        # missing/outOfOrder scans) so 168h completes <3s. Bound with wait_for
        # so a hung quality never blocks the whole dashboard (Next timeout 25s).
        try:
            return await asyncio.wait_for(quality_metrics(hours=h), timeout=10.0)
        except asyncio.TimeoutError:
            logger.warning("quality_metrics hours=%s timed out, returning lightweight fallback", h)
            return {"qualityScore": None, "total": 0, "duplicates": 0, "missing": None, "outOfOrder": 0, "saveFailures": 0, "timestampErrors": 0, "schemaErrors": 0, "invalidLtp": 0, "range": None}
        except Exception as exc:
            logger.warning("quality_metrics hours=%s failed: %s", h, exc)
            return {"qualityScore": None, "total": 0, "duplicates": 0, "missing": None, "outOfOrder": 0, "saveFailures": 0, "timestampErrors": 0, "schemaErrors": 0, "invalidLtp": 0, "range": None}

    async def _mongo_capped():
        # _compute_mongo_stats walks every collection (collStats + bounds per
        # collection). Even with per-command bounds a few slow round-trips can
        # stack up; the dashboard must never hang on the slowest branch while
        # system/quality/events are already done. A degraded-but-honest
        # payload (connected flag, no collection stats) keeps the Data Center
        # card alive and the endpoint within the frontend 25s budget.
        try:
            return await asyncio.wait_for(mongo_stats(), timeout=12.0)
        except asyncio.TimeoutError:
            logger.warning("mongo_stats timed out for the dashboard, returning connected-only fallback")
            return {
                "connected": bool(is_mongo_connected()),
                "stats": None,
                "statsNote": "collection stats build exceeded the dashboard budget — retrying next cycle",
            }
        except Exception as exc:
            logger.warning("mongo_stats failed: %s", exc)
            return {"connected": False, "stats": None, "error": str(exc)}

    try:
        system, quality, mongo, events, storage = await asyncio.gather(
            _system_snapshot(),
            _quality_capped(hours),
            _mongo_capped(),
            _system_events_rows(limit=500),
            _storage_dir_sizes(),
        )
    except Exception as exc:
        # If any gather branch fails, fall back to partial sequential with
        # per-call error handling — never crash the dashboard on one sub-failure.
        logger.warning("dashboard gather failed, falling back sequential: %s", exc)
        system = await _system_snapshot()
        try:
            quality = await _quality_capped(hours)
        except Exception:
            quality = {"qualityScore": None, "total": 0, "duplicates": 0, "missing": 0, "outOfOrder": 0, "saveFailures": 0}
        try:
            mongo = await _mongo_capped()
        except Exception:
            mongo = {"connected": False, "stats": None}
        try:
            events = await _system_events_rows(limit=500)
        except Exception:
            events = []
        try:
            storage = await _storage_dir_sizes()
        except Exception:
            storage = {"dirs": []}

    ticks_all_time = 0
    try:
        db = get_db()
        ticks_all_time = int(await db.ticks.estimated_document_count() or 0)
    except Exception as exc:
        logger.debug("dashboard totals: ticks count failed: %s", exc)

    snap = session_manager.snapshot()
    websocket = snap.get("websocket") or {}

    market = market_calendar.snapshot()
    sched_info = get_scheduler_info()
    schedule = get_schedule()
    ws_status = (system.get("websocketDetail") or {})

    # Enrich market snapshot with MarketStateService data
    from services.market_state import market_state_service
    ms_snap = market_state_service.get_snapshot()
    market["market_state"] = ms_snap.get("market_state")
    market["reason_code"] = ms_snap.get("reason_code")
    market["reason_message"] = ms_snap.get("reason_message")
    market["market_state_source"] = ms_snap.get("source")
    market["confirmation_window_active"] = ms_snap.get("confirmation_window_active")
    market["ticks_in_window"] = ms_snap.get("ticks_received_in_window")
    market["unique_instruments_in_window"] = ms_snap.get("unique_instruments_with_ticks")
    market["first_tick_at_ws"] = ms_snap.get("first_tick_at")
    market["last_tick_at_ws"] = ms_snap.get("last_tick_at")
    market["daily_decision"] = market_state_service.get_daily_decision()

    # Real scheduler event lifecycle (login / ws_connect / ws_disconnect /
    # logout) — derived from the event trail + schedule + market calendar +
    # the persisted scheduler-run ledger (status + reason per job).
    scheduler_state_now = sched_info.get("state") or (system.get("schedulerState") or {}).get("state")
    is_trading_day_now = bool(
        sched_info.get("is_trading_day", market.get("trading_day"))
    )
    windows = (schedule.get("schedule") or {})
    # Today's persisted ledger decisions (latest run per scheduled job) so the
    # cards reflect the real CATCHING_UP / COMPLETED / SKIPPED-with-reason
    # outcome instead of guessing from the event trail alone.
    try:
        from scheduler.persist import scheduler_ledger as _scheduler_ledger
        _today_iso = datetime.now(IST).date().isoformat()
        _ledger_by_job: dict = {}
        for _row in reversed(await _scheduler_ledger.executions(
                business_date=_today_iso, limit=50)):
            _ledger_by_job[_row.get("job_id")] = _row
    except Exception:
        logger.debug("dashboard: scheduler ledger unavailable", exc_info=True)
        _ledger_by_job = {}
    scheduler_events = _scheduler_event_lifecycle(
        events=events,
        schedule=schedule,
        windows=windows,
        is_trading_day=is_trading_day_now,
        scheduler_state=scheduler_state_now,
        ledger_jobs=_ledger_by_job,
        session_active=bool(snap.get("active")),
        ws_connected=bool(system.get("websocketConnected")),
        ws_enabled=_runtime_ws_enabled(),
        sched_enabled=bool(sched_info.get("enabled", True)),
        terminal_mode=_active_terminal_mode(),
    )
    schedule["scheduler_events"] = scheduler_events
    schedule["now_ist_ts"] = datetime.now(IST).isoformat()

    # Last login source (MANUAL vs SCHEDULED) from the real event trail.
    login_source: str | None = None
    for evt in events:
        if evt.get("source") == "scheduler" and evt.get("event") == "login_ok":
            src = (evt.get("meta") or {}).get("source") or (evt.get("meta") or {}).get("source") or ""
            login_source = str(src).upper() if src else None
            break

    session = {
        "active": bool(snap.get("active")),
        "state": snap.get("state"),
        "stateMessage": snap.get("stateMessage"),
        "userId": snap.get("userId"),
        "loginTime": snap.get("loginTime"),
        "expiresAt": snap.get("expiresAt"),
        "validatedAt": snap.get("validatedAt"),
        "remainingSeconds": snap.get("remainingSeconds"),
        "sessionDurationSeconds": snap.get("sessionDurationSeconds"),
        "lastAuthError": snap.get("lastAuthError"),
        "lastAuthErrorAt": snap.get("lastAuthErrorAt"),
        "lastSource": login_source or system.get("pythonStatus", {}).get("login_source"),
        "lastLogin": snap.get("loginTime"),
        "lastLogout": (snap.get("lastLogout") or {}),
        "lastLogoutReason": (snap.get("lastLogout") or {}).get("logoutReason"),
        "nextScheduledLogin": schedule.get("next_login_time"),
        "sessionExpiryApplicable": snap.get("expiresAt") is not None,
        "brokerFeedState": websocket.get("state"),
        "brokerFeedConnected": bool(websocket.get("connected")),
        "loginCount": snap.get("sessionHistory") and len(snap.get("sessionHistory") or []),
        "websocket": {
            "state": websocket.get("state"),
            "connected": bool(websocket.get("connected")),
            "connectedAt": websocket.get("connectedAt"),
            "disconnectedAt": websocket.get("disconnectedAt"),
            "lastMessageAt": websocket.get("lastMessageAt"),
            "disconnectReason": websocket.get("disconnectReason"),
            "reconnectCount": websocket.get("reconnectCount"),
        },
    }

    # ------------------------------------------------------------------
    # Real conditions → derived alerts. Every triggered alert is bound to
    # the newest matching lifecycle event (event_id + its timestamp), so the
    # CREATED timestamp is WHEN THE ALERT HAPPENED — never a market price.
    # ------------------------------------------------------------------
    buffer = system.get("buffer") or {}
    connected = bool(system.get("websocketConnected"))
    mongo_connected = bool(system.get("mongo", {}).get("connected"))
    total_write_errors = int(buffer.get("totalWriteErrors", 0) or 0)
    quality_score = quality.get("qualityScore")
    used_bytes = system.get("node", {}).get("diskUsedBytes")
    capacity_bytes = system.get("node", {}).get("diskTotalBytes")
    storage_pct = (used_bytes / capacity_bytes * 100) if (used_bytes and capacity_bytes) else None

    active_alerts: dict[str, dict] = {}
    now_mono = time.monotonic()

    if not connected:
        ev = _trigger_event(events, source="websocket")
        active_alerts["ws-offline"] = {
            "id": "ws-offline", "category": "websocket", "severity": "critical",
            "title": "Tick WebSocket disconnected",
            "message": "Market data feed is down — tick pipeline is not receiving data.",
            "reason": (ev or {}).get("reason") or system.get("wsDisconnectReason") or "Unknown",
            "reason_code": (ev or {}).get("reason_code") or "ws_disconnect",
            "component": "websocket", "source": "dashboard", "symbol": None,
            "status": "active", "eventId": (ev or {}).get("event_id") or None,
            "created_at": (ev or {}).get("ts") or None,
            "detail": f"Offline since {(system.get('lastWebSocketConnection') or system.get('wsLastConnectionAt') or 'unknown')}."
                      + (f" Cause: {(ev or {}).get('message') or system.get('wsDisconnectReason')}." if (ev or {}).get("message") or system.get("wsDisconnectReason") else " No disconnect event recorded in this backend process."),
        }
    if total_write_errors > 0:
        ev = _trigger_event(events, source="pipeline", event="TICK_SAVE_FAILURE")
        active_alerts["db-write-errors"] = {
            "id": "db-write-errors", "category": "storage", "severity": "warning",
            "title": "Database write failures",
            "message": f"{total_write_errors} tick(s) failed to persist to MongoDB.",
            "reason": (ev or {}).get("reason") or "Persistence error",
            "reason_code": "db_write_error",
            "component": "tick_buffer", "source": "dashboard", "symbol": None,
            "status": "active", "eventId": (ev or {}).get("event_id") or None,
            "created_at": (ev or {}).get("ts") or None,
            "detail": f"Buffer recorded {total_write_errors} failed bulk writes in the current backend process."
                      + (f" Last failure: {(ev or {}).get('details') or (ev or {}).get('message')}." if ev else " No TICK_SAVE_FAILURE event recorded yet."),
        }
    if not mongo_connected:
        ev = _trigger_event(events, source="database", event="DATABASE_DISCONNECTED")
        active_alerts["mongo-offline"] = {
            "id": "mongo-offline", "category": "database", "severity": "critical",
            "title": "Database unavailable",
            "message": "MongoDB connection lost — data cannot be saved.",
            "reason": (ev or {}).get("reason") or "Database connection",
            "reason_code": "db_write_error",
            "component": "mongodb", "source": "dashboard", "symbol": None,
            "status": "active", "eventId": (ev or {}).get("event_id") or None,
            "created_at": (ev or {}).get("ts") or None,
            "detail": "The backend cannot reach MongoDB. New ticks will be buffered only.",
        }
    if quality_score is not None and quality_score < 80:
        ev = _trigger_event(events, event="QUALITY_BREACH")
        active_alerts["quality-low"] = {
            "id": "quality-low", "category": "quality", "severity": "warning",
            "title": "Data quality degradation",
            "message": f"Quality score {quality_score}/100 in the inspected window.",
            "reason": (ev or {}).get("reason") or "Quality metric breach",
            "reason_code": "quality_bad",
            "component": "quality", "source": "dashboard", "symbol": None,
            "status": "active", "eventId": (ev or {}).get("event_id") or None,
            "created_at": (ev or {}).get("ts") or None,
            "detail": (f"Duplicates {quality.get('duplicates')} · out-of-order {quality.get('outOfOrder')} · "
                       f"timestamp errors {quality.get('timestampErrors')} · save failures {quality.get('saveFailures')}."),
        }
    if storage_pct is not None and storage_pct >= 90:
        active_alerts["storage-high"] = {
            "id": "storage-high", "category": "storage", "severity": "warning",
            "title": "Storage threshold reached",
            "message": f"Disk usage is at {round(storage_pct, 1)}% of capacity.",
            "reason": "Storage utilisation", "reason_code": "system",
            "component": "storage", "source": "dashboard", "symbol": None,
            "status": "active", "eventId": None, "created_at": None,
            "detail": f"Used {used_bytes} bytes of {capacity_bytes} bytes.",
        }
    if not bool(system.get("internetConnected")):
        active_alerts["internet-down"] = {
            "id": "internet-down", "category": "network", "severity": "warning",
            "title": "Internet connectivity lost",
            "message": "The backend cannot reach external endpoints (checked against google.com).",
            "reason": "Network check", "reason_code": "ws_internet_disconnect",
            "component": "network", "source": "dashboard", "symbol": None,
            "status": "active", "eventId": None, "created_at": None,
            "detail": "Backend /api/system internet probe failed.",
        }

    _sync_alert_events(active_alerts, now_mono)

    # QUALITY_BREACH lifecycle event (throttled) when real metrics breach.
    global _QUALITY_BREACH_RECORDED_AT
    if quality_score is not None and quality_score < 80 and quality.get("total"):
        if now_mono - _QUALITY_BREACH_RECORDED_AT >= _QUALITY_BREACH_COOLDOWN:
            _QUALITY_BREACH_RECORDED_AT = now_mono
            _record_pipeline_event(
                "QUALITY_BREACH", f"Quality score {quality_score}/100 below threshold",
                {"status": "warning", "reason": "quality breach", "reason_code": "quality_bad",
                 "component": "quality",
                 "details": f"duplicates={quality.get('duplicates')} out_of_order={quality.get('outOfOrder')} "
                            f"timestamp_errors={quality.get('timestampErrors')} save_failures={quality.get('saveFailures')}"},
            )

    # ------------------------------------------------------------------
    # Market + schedule (back-end source of truth; real values only) and a
    # compact stats block the Next route can hand straight to the UI.
    # ------------------------------------------------------------------
    try:
        db = get_db()
        today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        hour_start = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
        first_tick = await db.ticks.find({"ts": {"$gte": today_start}}, {"ts": 1}) \
            .sort("ts", 1).limit(1).to_list(length=1)
        first_tick_ts = _serialize_tick_ts(first_tick[0]) if first_tick else None
        unique_instruments_today = await db.ticks.distinct("symbol", {"ts": {"$gte": today_start}})
        records_this_hour = await db.ticks.count_documents({"ts": {"$gte": hour_start}})
        latest_doc = await db.ticks.find_one(sort=[("ts", -1)])
        db_name = db.name
    except Exception:
        first_tick_ts = None
        unique_instruments_today = []
        records_this_hour = None
        latest_doc = None
        db_name = None

    tick_stats = tick_buffer.stats()

    pipeline_running = bool(tick_stats.get("pipelineRunning"))
    stats = {
        "recordsInDb": ticks_all_time,
        "recordsToday": system.get("todayRecords"),
        "recordsThisHour": records_this_hour,
        "todayInserts": system.get("todayInserts"),
        "todayFailed": system.get("errorCount"),
        "lastWriteAt": _iso_from_epoch(buffer.get("lastWriteAt")),
        "lastTickAt": _iso_from_epoch(buffer.get("lastTickAt")) or system.get("lastTickTime"),
        "firstTickTodayAt": first_tick_ts,
        "latestRecordAt": _serialize_tick_ts(latest_doc),
        "uniqueInstrumentsToday": len(unique_instruments_today),
        "lastTickSymbol": system.get("lastTickSymbol"),
        "database": db_name,
        "collection": "ticks",
        "subscribed": {
            "total": system.get("totalStocks"),
            "active": system.get("activeStocks"),
            "byWs": ws_status.get("subscribed_symbols"),
        },
        "pipeline": {
            "running": pipeline_running,
            "live": bool(system.get("websocketConnected")),
            "state": "live" if (pipeline_running and bool(system.get("websocketConnected"))) else "stopped",
            "ticksPerSecond": tick_stats.get("ticksPerSecond"),
            "savedPerSecond": tick_stats.get("writesPerSecond"),
            "totalReceived": buffer.get("totalReceived"),
            "totalWrites": buffer.get("totalWritten"),
            "totalWriteErrors": buffer.get("totalWriteErrors"),
            "bufferLength": buffer.get("bufferLength"),
            "startedAt": _iso_from_epoch(tick_stats.get("pipelineStartedAt")),
            "stoppedAt": _iso_from_epoch(tick_stats.get("pipelineStoppedAt")),
            "uptimeSeconds": tick_stats.get("pipelineUptimeSeconds"),
            "lastTickAt": _iso_from_epoch(buffer.get("lastTickAt")) or system.get("lastTickTime"),
            "lastSavedAt": _iso_from_epoch(buffer.get("lastWriteAt")),
            "lastFailedWriteAt": _iso_from_epoch(tick_stats.get("lastFailedWriteAt")),
            "lastError": buffer.get("lastError"),
            "trend": buffer.get("tickRateTrend"),
            "disconnectReason": ws_status.get("disconnect_reason")
                              or system.get("wsDisconnectReason"),
            "feedLatencyMs": (tick_stats.get("feedLatencyMs") or {}).get("currentMs"),
        },
    }

    alerts = sorted(active_alerts.values(), key=lambda a: a.get("created_at") or "", reverse=False)

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "system": system,
        "quality": quality,
        "mongo": mongo,
        "events": events,
        "totals": {"ticksAllTime": ticks_all_time},
        "storage": storage,
        "session": session,
        "alerts": alerts,
        "market": market,
        "schedule": schedule,
        "stats": stats,
    }


def _iso_from_epoch(epoch_sec) -> str | None:
    try:
        v = float(epoch_sec)
        if v <= 0:
            return None
        return datetime.fromtimestamp(v, tz=IST).isoformat()
    except (TypeError, ValueError, OverflowError):
        return None



