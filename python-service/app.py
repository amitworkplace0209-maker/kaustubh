"""
KAUSTUBH Trading Platform — FastAPI backend.

Single Python backend that replaces the Node.js layer entirely.
Talks directly to MongoDB (Motor) and the Kotak Neo SDK.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import platform
from contextlib import asynccontextmanager

from pathlib import Path
import uvicorn
import fastapi
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from config.settings import settings
from database.connection import connect_mongo, disconnect_mongo, is_mongo_connected
from services import market_calendar
from services import tick_buffer
from services.market_state import market_state_service
from services.event_history import set_persist_enabled, record_event
from services.instrument_cache import load_instrument_cache, instrument_cache_state
from scheduler import start_scheduler, stop_scheduler, do_logout, get_schedule
from auth.kotak_client import kotak_session, SDK_AVAILABLE
from core.event_loop import set_loop
from core.timezones import IST, register_process_timezone

# Pin the process timezone to IST before anything reads the clock, so log
# timestamps, time.localtime() and any naive datetime.now() agree with the
# aware IST helpers used across the codebase.
register_process_timezone()

# Single-instance guard: when this process was NOT launched through
# start_backend.py (which already holds the mutex), claim the backend slot NOW
# and refuse to boot a duplicate before any heavy startup runs.
from runtime.singleton import (
    get_guard as _get_guard,
    acquire as _acquire_singleton,
    AlreadyRunning as _AlreadyRunning,
    mark_state as _mark_state,
    STATE_STARTING as _STATE_STARTING,
    STATE_STOPPING as _STATE_STOPPING,
)

_RUNTIME_DIR = Path(__file__).resolve().parent / "runtime"

if _get_guard() is None:
    import sys as _sys
    try:
        _acquire_singleton(_RUNTIME_DIR, settings.port, settings.host, strict_health=True)
    except _AlreadyRunning as exc:
        _sys.stderr.write(
            f"BACKEND ALREADY RUNNING pid={exc.pid} healthy={exc.healthy} on "
            f"port {settings.port} — refusing to start a duplicate instance.\n"
        )
        _sys.stderr.flush()
        raise SystemExit(0 if (exc.healthy or exc.kind != "conflict") else 2)

# Import all routers
from api.routes import router as session_router
from api.auth import router as auth_router
from api.stocks import router as stocks_router
from api.ticks import router as ticks_router
from api.downloads import router as downloads_router
from api.export_jobs import (
    router as export_jobs_router,
    start_export_worker,
    stop_export_worker,
)
from api.statistics import router as statistics_router
from api.logs import router as logs_router
from api.system import router as system_router
from api.settings import router as settings_router
from api.trading import router as trading_router
from api.trading_dashboard import router as trading_dashboard_router
from api.watchlist import router as watchlist_router
from api.watch_list import router as watch_list_router
from api.market_watch import router as market_watch_router
from api.search import router as search_router
from api.watchlist_engine import router as watchlist_engine_router
from api.notifications import router as notifications_router
from api.baskets import router as baskets_router
from api.demo import router as demo_router
from api.scheduled_downloads import (
    router as scheduled_downloads_router,
    start_scheduled_downloads_checker,
    stop_scheduled_downloads_checker,
)
from api.schedule_events import router as schedule_events_router
from api.quality import router as quality_router
from api.websocket import router as websocket_router
from api.insights import router as insights_router
from api.alerts import router as alerts_router
from api.tick_analytics import router as tick_analytics_router
from api.terminal import router as terminal_router, user_router, shoonya_router
from api.security import router as security_router
from api.data_center import router as data_center_router
from api.cleanup import router as cleanup_router
from api.trade_instruments import router as trade_instruments_router
from api.ws_engine import router as ws_engine_router
from api.ws_gateway import router as ws_gateway_router
from api.dummy import router as dummy_router
from api.engine_control import router as engine_control_router
from api.storage_engine import router as storage_engine_router
from api.database_monitoring import router as database_monitoring_router
from api.session_manager import router as session_manager_router
from api.risk_engine import router as risk_engine_router
from api.order_engine import router as order_engine_router

# Configure logging
logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("app")
logger.setLevel(getattr(logging, settings.log_level.upper(), logging.INFO))

# Prevent the 'app' logger from propagating to the root handler — without
# this, every record was printed twice (once by the root handler, once by
# the app-specific handler).  The app handler handles all levels directly.
logger.propagate = False

_console = logging.StreamHandler()
_console.setLevel(logging.INFO)
_console.setFormatter(
    logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
)
logger.addHandler(_console)

# Holds the running retention-cleanup asyncio task (cancel on shutdown).
_cleanup_task_holder: dict = {"task": None}

# Holds the notification-center retention asyncio task (cancel on shutdown).
_ncenter_task_holder: dict = {"task": None}

# Holds the engine self-reporting watcher (stops itself on shutdown).
_engine_alerts_task_holder: dict = {"reporter": None}

# Holds the Data Insights background tasks (cancel on shutdown).
_insights_task_holder: dict = {"telemetry": None, "api_telemetry": None,
                               "correlator": None, "daily_report": None}

# Holds the Dummy daily-session rollover task (cancel on shutdown).
_dummy_session_task_holder: dict = {"task": None}


async def _dummy_session_loop(interval_seconds: int = 30) -> None:
    """Idempotent Dummy daily-session rollover (12:00 AM IST reset).

    Runs on its own timer so the Dummy terminal's fresh-day lifecycle is fully
    independent of the broker scheduler (09:00 LOGIN / 09:13 WS / 15:31 WS /
    16:00 LOGOUT timings are NOT modified). At midnight IST the previous day
    is closed + archived (full book saved permanently) and the operational
    store resets clean to starting capital — automatically, with no traffic
    required. Because ``ensure_dummy_session`` is idempotent, restarts later
    the same day detect the existing session and never duplicate or wipe
    within-day state.
    """
    from services.dummy_session import ensure_dummy_session
    while True:
        try:
            await ensure_dummy_session()
        except Exception as exc:
            logger.warning("Dummy daily-session rollover pass failed (non-fatal): %s", exc)
        try:
            await asyncio.sleep(interval_seconds)
        except asyncio.CancelledError:
            raise


async def _retention_cleanup_loop(interval_seconds: int = 6 * 3600) -> None:
    """Periodically enforce the 7-day WebSocket history retention.

    Runs indefinitely until cancelled. Complements the MongoDB TTL index on
    `websocket_history.connected_at`; it is a reliable backend cleanup even if
    the TTL sweep hasn't fired. Never deletes current records (it only removes
    records strictly older than RETENTION_DAYS).
    """
    from services.websocket_history_service import run_cleanup_retention
    while True:
        try:
            await run_cleanup_retention()
        except Exception:
            logger.exception("WebSocket history retention cleanup failed (non-fatal)")
        try:
            await asyncio.sleep(interval_seconds)
        except asyncio.CancelledError:
            raise


async def _telemetry_sampler_loop(interval_seconds: int = 60) -> None:
    """Sample the tick pipeline + WebSocket into one aggregated telemetry
    bucket per minute (never one document per tick)."""
    from services.ds_insights import record_telemetry_bucket
    while True:
        try:
            await asyncio.sleep(interval_seconds)
            await record_telemetry_bucket()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("telemetry bucket sample skipped (non-fatal)", exc_info=True)


async def _incident_correlator_loop(interval_seconds: int = 5) -> None:
    """Turn related ledger events into incidents in near-real-time."""
    from services.ds_insights import run_incident_correlation
    while True:
        try:
            await asyncio.sleep(interval_seconds)
            await run_incident_correlation()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("incident correlation pass skipped (non-fatal)", exc_info=True)


async def _daily_report_loop(interval_seconds: int = 60) -> None:
    """Generate the canonical daily report once market close has passed.

    Uses the authoritative IST market calendar: past the scheduled WebSocket
    disconnect window on a trading day, with real events on record, the report
    is generated at most once per market date.
    """
    from datetime import timedelta, timezone
    from services.ds_insights import generate_daily_report, ist_today, get_daily_report
    from services import market_calendar
    generated: set[str] = set()
    while True:
        try:
            today = ist_today()
            if today not in generated:
                cal = market_calendar.snapshot()
                is_trading = bool(cal.get("is_trading_day", False))
                now_ist = datetime.now(IST)
                close_passed = now_ist.hour > 15 or (
                    now_ist.hour == 15 and now_ist.minute >= 45
                )
                existing = await get_daily_report(today)
                if existing is not None:
                    generated.add(today)
                elif is_trading and close_passed:
                    try:
                        report = await generate_daily_report(today)
                        if report and not report.get("error"):
                            generated.add(today)
                            logger.info("Daily Data SAVer report generated: %s", today)
                    except Exception as exc:
                        logger.warning("Daily report generation failed (retry later): %s", exc)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("daily report loop pass skipped (non-fatal)", exc_info=True)
        try:
            await asyncio.sleep(interval_seconds)
        except asyncio.CancelledError:
            raise


# Holds the realtime live-frame publisher task (cancel on shutdown).
_live_frame_task_holder: dict = {"task": None}

# Holds the Data Quality live publisher task (cancel on shutdown).
_dq_live_task_holder: dict = {"task": None}

# Holds the Tick Analytics background tasks (daily backfill + coalesced
# realtime publisher). Both are read-only observability workers.
_tick_analytics_task_holder: dict = {"backfill": None, "publish": None}

_DQ_LIVE_INTERVAL_SEC = 1.0

_LIVE_FRAME_INTERVAL_SEC = 3.0

#: Coalesced Tick Analytics realtime frame cadence. Deliberately ~1 Hz: the
#: frontend must never receive one frame per tick.
_TICK_ANALYTICS_INTERVAL_SEC = 1.0

#: Historical daily-document backfill cadence.
_TICK_ANALYTICS_BACKFILL_SEC = 8.0


async def _live_frame_loop(interval_seconds: float = _LIVE_FRAME_INTERVAL_SEC) -> None:
    """Push a compact ``ws_live`` frame onto the system SSE stream every ~3s.

    Without this the WebSocket monitor's Live Connection / Live Rates cards
    would only ever see the snapshot taken when the SSE stream opened. This
    loop publishes the CURRENT live supervisor frame + tick-pipeline stats so
    the frontend's single realtime channel is genuinely live (values keep
    ticking while connected), driven entirely by backend timestamps.
    """
    from services.state_store import get_state_store
    from datetime import datetime, timezone
    while True:
        try:
            from ws_socket.ws_manager import ws_manager
            from services import tick_buffer

            live = None
            try:
                live = ws_manager.live_snapshot() or {}
            except Exception:
                logger.debug("live snapshot unavailable in publish loop", exc_info=True)
            stats = None
            try:
                stats = tick_buffer.stats()
            except Exception:
                logger.debug("tick buffer stats unavailable in publish loop", exc_info=True)

            frame = {
                "type": "ws_live",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "live": live,
                "pipeline": stats,
            }
            try:
                await get_state_store().publish(frame)
            except Exception:
                logger.debug("ws_live publish failed (non-fatal)", exc_info=True)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("ws_live loop pass failed (non-fatal)", exc_info=True)
        try:
            await asyncio.sleep(interval_seconds)
        except asyncio.CancelledError:
            raise


async def _dq_live_loop(interval_seconds: float = _DQ_LIVE_INTERVAL_SEC) -> None:
    """Publish aggregated Data Quality metrics every ~1s (no per-tick spam).

    Read-only: aggregates in-memory counters from WebSocket / Market Watch /
    DB Writer / Mongo connection state via services.data_quality_live and
    fans out on the EXISTING shared event_bus (SSE
    /api/schedule-events/stream as ``quality_live``). The Data Quality page
    reuses its single SSE connection — no second socket, no REST polling.
    """
    from datetime import datetime, timezone
    while True:
        try:
            from services.data_quality_live import build_snapshot_async
            from services import event_bus

            try:
                snap = await build_snapshot_async()
            except Exception:
                logger.debug("dq live snapshot failed (non-fatal)", exc_info=True)
                snap = None
            if snap is not None:
                frame = {"type": "quality_live", **snap}
                # timestamp already in snap; ensure one exists.
                frame.setdefault("timestamp", datetime.now(timezone.utc).isoformat())
                try:
                    await event_bus.publish_event(frame)
                except Exception:
                    logger.debug("quality_live publish failed (non-fatal)", exc_info=True)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("dq live loop pass failed (non-fatal)", exc_info=True)
        try:
            await asyncio.sleep(interval_seconds)
        except asyncio.CancelledError:
            raise


async def _tick_analytics_publish_loop(interval_seconds: float = _TICK_ANALYTICS_INTERVAL_SEC) -> None:
    """Publish ONE coalesced ``tick_analytics`` frame per interval.

    This is the realtime half of the Tick Analytics page. It rides the EXISTING
    system SSE channel (``/api/websocket/system/stream``) -- no second socket,
    no broker socket, no per-tick fan-out. The payload is the compact live
    summary only; historical tables are served by REST and never pushed.

    Skipped entirely when no frontend is attached so a closed laptop cannot
    cause a background publish loop.
    """
    from datetime import datetime, timezone
    from services.state_store import get_state_store

    while True:
        try:
            store = get_state_store()
            if store.client_count() > 0:
                try:
                    from services import tick_analytics
                    payload = tick_analytics.live_event()
                except Exception:
                    logger.debug("tick analytics live payload failed (non-fatal)", exc_info=True)
                    payload = None
                if payload:
                    frame = {
                        "type": "tick_analytics",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "data": payload,
                    }
                    try:
                        await store.publish(frame)
                    except Exception:
                        logger.debug("tick_analytics publish failed (non-fatal)", exc_info=True)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("tick analytics publish pass failed (non-fatal)", exc_info=True)
        try:
            await asyncio.sleep(interval_seconds)
        except asyncio.CancelledError:
            raise


async def _tick_analytics_backfill_loop(interval_seconds: float = _TICK_ANALYTICS_BACKFILL_SEC) -> None:
    """Backfill missing historical daily-analytics documents in the background.

    The REST daily endpoint NEVER aggregates on the request path: it queues
    missing days here and this loop builds at most a couple per pass.
    """
    while True:
        try:
            from services import tick_analytics_daily
            await tick_analytics_daily.backfill_once(limit=2)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("tick analytics backfill pass failed (non-fatal)", exc_info=True)
        try:
            await asyncio.sleep(interval_seconds)
        except asyncio.CancelledError:
            raise


def _startup_report() -> None:
    """Bounded, useful startup report printed to the terminal (#12)."""
    import scheduler

    sched_running = scheduler.get_scheduler_info()["running"]
    sched = get_schedule()
    market = market_calendar.snapshot()

    ms_snap = market_state_service.get_snapshot()
    lines = [
        "==================================================",
        "KAUSTUBH BACKEND",
        "==================================================",
        "",
        "Backend:",
        "  Status: STARTING",
        f"  Host: {settings.host}",
        f"  Port: {settings.port}",
        "",
        f"Python: {platform.python_version()}",
        f"FastAPI: {getattr(fastapi, '__version__', 'unknown')}",
        f"Uvicorn: {getattr(uvicorn, '__version__', 'unknown')}",
        "",
        "MongoDB:",
        f"  Status: {'CONNECTED' if is_mongo_connected() else 'DISCONNECTED'}",
        f"  Provider: {settings.mongodb_source().upper()} (controlled by MONGODB_URI)",
        f"  Database: {settings.effective_mongodb_database()}",
        f"  Host: {settings.mongodb_host() or '(not configured)'}",
        "",
        "Scheduler:",
        f"  Status: {'STARTED' if sched_running else 'WAITING'}",
        "",
        "WebSocket:",
        f"  Status: {'CONNECTED' if market_state_service.get_snapshot().get('market_state') in ('MARKET_OPEN', 'PRE_MARKET') else 'WAITING'}",
        "Session:",
        f"  Status: {'ACTIVE' if kotak_session.session_active else 'INACTIVE'}",
        "",
        "Broker:",
        f"  Mode: {(settings.broker_mode or 'kotak').upper()}",
        f"  Session: {'LOGGED_OUT' if not kotak_session.session_active else 'ACTIVE'}",
        f"  SDK: {'LOADED' if SDK_AVAILABLE else 'MISSING'}",
        "",
        "Market:",
        f"  Today: {market['market_date']}",
        f"  Calendar: {market['market_status']} ({market['day_class']})",
        f"  State: {ms_snap.get('market_state', 'UNKNOWN')}",
        f"  Reason: {ms_snap.get('reason_message') or market['closure_reason'] or 'normal trading day'}",
        f"  Source: {ms_snap.get('source', 'not_set')}",
        f"  Confirmation window: {'active' if ms_snap.get('confirmation_window_active') else 'inactive'}",
        "",
        "Automatic Schedule (IST):",
        f"  Login: {sched['schedule']['login']}",
        f"  WebSocket Connect: {sched['schedule']['ws_connect']}",
        f"  Tick Collection: {sched['schedule'].get('tick_collection_start', '—')}",
        f"  WS Disconnect: {sched['schedule']['ws_disconnect']}",
        f"  Logout: {sched['schedule']['logout']}",

        "Today:",
        f"  Login: {sched['today_login_time'] or '(not a trading day)'}",
        f"  WebSocket Connect: {sched['today_ws_connect_time'] or '(not a trading day)'}",
        f"  Tick Collection: {sched['today_tick_collection_time'] or '(not a trading day)'}",
        f"  WS Disconnect: {sched['today_ws_disconnect_time'] or '(not a trading day)'}",
        f"  Logout: {sched['today_logout_time'] or '(not a trading day)'}",

        "Next:",
        f"  Login: {sched['next_login_time'] or '(none)'}",
        f"  WebSocket Connect: {sched['next_ws_connect_time'] or '(none)'}",
        f"  Tick Collection: {sched['next_tick_collection_time'] or '(none)'}",
        f"  WS Disconnect: {sched['next_ws_disconnect_time'] or '(none)'}",
        f"  Logout: {sched['next_logout_time'] or '(none)'}",
        f"  Next Event: {sched['next_event']} at {sched['next_event_at'] or '(none)'}"
        + (f" (in {round(sched['remaining_seconds'])}s)" if sched.get("remaining_seconds") is not None else ""),
        "",
        "==================================================",
    ]
    logger.info("\n" + "\n".join(lines))


@asynccontextmanager
async def lifespan(app: FastAPI):
    import asyncio
    logger.info("KAUSTUBH FastAPI backend starting up...")
    _mark_state(_STATE_STARTING)
    set_loop(asyncio.get_running_loop())

    # ------------------------------------------------------------------
    # MongoDB — the ONLY runtime database (controlled by MONGODB_URI).
    #
    # Two distinct failure modes, handled differently on purpose:
    #
    # 1. MONGODB_URI missing/malformed  -> HARD FAIL. The process must
    #    not start, and must never silently point at a default database.
    # 2. MongoDB configured but unreachable -> keep the HTTP server up so the
    #    frontend receives a real error state instead of a blank page, report
    #    the failure everywhere, and start no database-backed worker. The
    #    health endpoint answers 503 with the real reason.
    # ------------------------------------------------------------------
    from config.settings import MongoDbConfigurationError
    from database.connection import MongoConnectionError, get_mongo_info

    database_ready = False
    try:
        set_persist_enabled(True)
        await connect_mongo()
        database_ready = True
        logger.info("Event ledger: READY")
        record_event("process", "started", "info", "KAUSTUBH FastAPI backend started")
        logger.info("Backend: READY")
    except MongoDbConfigurationError:
        # Configuration is broken: refuse to start. No fallback, ever.
        logger.exception(
            "FATAL: MongoDB is not configured (MONGODB_URI). "
            "Set it in python-service/.env and restart."
        )
        raise
    except MongoConnectionError as exc:
        _info = get_mongo_info()
        logger.error(
            "\n%s\nFATAL: MongoDB is UNREACHABLE — the backend will serve API "
            "responses but every database-backed feature is disabled.\n"
            "  Reason: %s\n"
            "  Fix   : %s\n"
            "  Target: %s (db=%s)\n"
            "  NOTE  : there is deliberately NO fallback database.\n%s",
            "=" * 78, exc.reason, exc.remediation or "see the MongoDB server state",
            _info.get("host") or "unknown", _info.get("database"), "=" * 78,
        )
    except Exception as exc:
        logger.exception("Startup failed at MongoDB connection: %s", exc)
        raise

    if not database_ready:
        # DB-dependent bootstrap below is skipped deliberately: every one of
        # these paths needs a live MongoDB handle, and half-starting them would
        # produce a queue of noisy background errors. The scheduler and the
        # tick pipeline stay parked until MongoDB is reachable and the backend is
        # restarted.
        #
        # The HTTP server still serves: /api/system/health answers 503 with the
        # real MongoDB reason so the frontend can show a database error state
        # instead of a blank page. Nothing is torn down on exit because nothing
        # was started.
        logger.error(
            "Skipping database-backed startup (event ledger, notification center, "
            "tick buffer, export worker, downloads checker, scheduler). "
            "Fix MongoDB connectivity and restart the backend."
        )
        yield
        return

    # Load persisted settings into the live runtime bridge (scheduler, tick
    # buffer, WS supervisor) and overlay the read-once env `Settings` config
    # so every persisted knob genuinely applies — start or restart-time.
    try:
        from services.runtime_settings import (
            apply_env_overrides,
            refresh_runtime_settings,
            start_background_sync,
        )
        await refresh_runtime_settings()
        apply_env_overrides()
        start_background_sync()
    except Exception as exc:
        logger.warning("Runtime settings bootstrap failed (using env defaults): %s", exc)

    # Migrate legacy-default scheduler times to the 08:50 login /
    # 08:55 WS connect / 08:59 tick collection sequence (idempotent;
    # only exact legacy defaults are bumped).
    try:
        from services.settings_migrations import migrate_schedule_aliases, migrate_scheduler_times
        await migrate_scheduler_times()
        await migrate_schedule_aliases()
        await refresh_runtime_settings()
    except Exception as exc:
        logger.warning("Scheduler settings migration failed (using defaults): %s", exc)

    # Initialise the centralized notification center (indexes, legacy backfill).
    try:
        from services.notification_center import init_notification_center
        await init_notification_center()
        logger.info("Notification center: READY")
    except Exception as exc:
        logger.exception("Notification center init failed: %s", exc)

    # Dummy Mode — always-on managed paper connection. The paper engine needs no
    # broker credentials, so once the store is reachable the backend keeps a
    # Dummy session live for the whole run: the Broker Terminal engine then has
    # real paper data (balance / margins / P&L / positions / orders) in every
    # terminal card without anyone starting the mode manually. The central
    # session (e.g. Kotak) is NOT hijacked by this.
    try:
        from brokers.dummy import dummy_adapter
        await dummy_adapter.ensure_auto_ready()
        logger.info("Dummy Mode: managed paper connection READY")
    except Exception as exc:
        logger.warning("Dummy Mode managed start failed (cards report it honestly): %s", exc)

    for name, start in (
        ("tick buffer", tick_buffer.start),
        ("export worker", start_export_worker),
        ("downloads checker", start_scheduled_downloads_checker),
        ("scheduler", start_scheduler),
    ):
        try:
            result = start()
            if result is not None and hasattr(result, "__await__"):
                await result
        except Exception as exc:
            logger.exception("Startup failed at %s: %s", name, exc)

    # Wire the Central WebSocket Engine to the single Kotak WS owner. This is
    # additive: it only sets the publish hook + owner reference; the supervisor
    # lifecycle stays exactly as before. Best effort - never blocks startup.
    try:
        from api.ws_engine import get_wired_engine
        engine = get_wired_engine(record=True)
        # Start the TICK_RECEIVED / TICK_VALIDATED / TICK_REJECTED event-bus
        # bridge (drains the feed thread into the async Engine Event Bus).
        try:
            engine.start_event_bridge()
        except Exception as exc:
            logger.warning("WS engine event-bridge start failed: %s", exc)
    except Exception as exc:
        logger.warning("WebSocket Engine wiring failed (will retry lazily): %s", exc)

    # WS#2: Order & Position Feed (Broker → Backend). Session-driven supervisor;
    # starts immediately and waits for session_active — no market-window gate
    # so post-market order events are not silently dropped.
    try:
        from ws_socket.order_feed_manager import order_feed_manager
        order_feed_manager.start_supervisor()
        logger.info("Order Feed WS#2 supervisor: STARTED (waiting for session)")
    except Exception as exc:
        logger.warning("Order Feed WS#2 supervisor start failed (will retry on login): %s", exc)

    # WS#1: Market-data feed (Broker → Backend). Normally owned by the
    # scheduler's ws_start phase, but the scheduler is parked in Dummy mode
    # (no auto-login, no lifecycle drive), so a backend that boots directly
    # into Dummy mode never starts the market feed. Start it unconditionally:
    # the supervisor itself gates on the market window + an active Kotak
    # session, so Dummy can keep consuming live Kotak Neo market data while
    # the active terminal stays Dummy.
    try:
        from ws_socket.ws_manager import ws_manager
        ws_manager.start_supervisor()
        logger.info("WS market-data supervisor: STARTED (market window + session gated)")
    except Exception as exc:
        logger.warning("WS market-data supervisor start failed: %s", exc)

    # Session Manager Engine (Phase 3) — hydrate the canonical instrument
    # store into the in-memory manager (crash recovery; the store is the
    # durable record of desired/pinned/expiry/feed intent). Best effort.
    try:
        from services.session.session_manager import session_manager
        loaded = await session_manager.reload_instruments()
        logger.info("Session Manager canonical store hydrated: %d instruments", loaded)
    except Exception as exc:
        logger.warning("Session Manager canonical hydrate failed: %s", exc)

    # Session Manager configuration — load persisted knobs (lifetime / expiry
    # warning / tick window) into the in-process cache so live UI changes are
    # honoured after a restart. Honest default fallback when MongoDB is down.
    try:
        from services.session import session_manager_config
        cfg = await session_manager_config.refresh_config()
        logger.info(
            "Session Manager config cache: source=%s effective=%s",
            cfg.get("cacheSource"), cfg.get("effective"),
        )
    except Exception as exc:
        logger.warning("Session Manager config refresh failed: %s", exc)

    # -----------------------------------------------------------------------
    # Engine Registry — register all engines for Phase 3 Service Control
    # -----------------------------------------------------------------------
    try:
        from services.engine_registry import get_engine_registry
        registry = get_engine_registry()

        # Import engine singletons
        from core.engines.feature_engine import feature_engine
        from core.engines.search_engine import search_engine
        from core.engines.squareoff_engine import squareoff_engine
        from core.engines.risk_engine import risk_engine
        from services.watchlist_engine import watchlist_engine
        from services.market_watch_engine import market_watch_engine
        from services.market_coach import market_coach
        from services.storage_engine import storage_engine
        from services.db_writer_engine import db_writer_engine
        from services.notification_engine import notification_engine
        from services.audit_engine import audit_engine
        from services.session_manager_engine import session_manager_engine
        from services.connection_manager_engine import connection_manager_engine
        from services.websocket_engine import websocket_engine

        # Facade engines for pre-existing subsystems (observe + safe delegation)
        from services.legacy_engine_facades import FACADES

        # Register all engines
        for eng in [
            feature_engine,
            search_engine,
            squareoff_engine,
            # Risk Engine: a first-class EngineBase now, so the engine every
            # order passes through is visible and controllable from the Service
            # Control Center instead of only having a Settings page.
            risk_engine,
            watchlist_engine,
            market_watch_engine,
            market_coach,
            storage_engine,
            db_writer_engine,
            notification_engine,
            audit_engine,
            session_manager_engine,
            connection_manager_engine,
            websocket_engine,
            *FACADES,
        ]:
            registry.register(eng)

        # Start engines that should auto-start
        for eng in [feature_engine, search_engine, watchlist_engine, market_watch_engine, market_coach, storage_engine, db_writer_engine, notification_engine, audit_engine, session_manager_engine, connection_manager_engine, websocket_engine]:
            try:
                await eng.start()
            except Exception as exc:
                logger.warning("Engine %s auto-start failed: %s", eng.engine_id, exc)

        # Risk Engine is stateless per-request — it has nothing to spin up, but
        # it must still publish its limits so the Control Center is accurate.
        try:
            risk_engine.set_config_summary(risk_engine.config_summary())
            risk_engine.heartbeat()
        except Exception as exc:
            logger.warning("Engine risk_engine setup failed: %s", exc)

        # Facade engines: reflect the real state of the underlying system
        # (they don't own those systems — app.py's existing startup does).
        for eng in FACADES:
            try:
                eng._sync_status()
                eng.heartbeat()
            except Exception as exc:
                logger.warning("Facade %s setup failed: %s", eng.engine_id, exc)

        logger.info("Engine Registry: %d engines registered", len(registry.get_all_statuses()))
    except Exception as exc:
        logger.warning("Engine Registry setup failed: %s", exc)

    # Start the Connection Engine (backend -> frontend realtime WS #2):
    # subscribes to the backend state/event buses and fans engine tick
    # consumers out to connected frontend sessions. Non-fatal on failure.
    try:
        from connection_engine import connection_engine
        connection_engine.start()
        logger.info("Connection Engine: READY (WS #2 gateway)")
    except Exception as exc:
        logger.warning("Connection Engine start failed (will retry on next connect): %s", exc)

    # Dummy daily-session lifecycle. Startup runs the (idempotent) rollover
    # immediately so a backend coming up at 09:05/10:00 correctly detects the
    # existing session; the background loop then owns the 09:00 IST fresh-day
    # reset for the rest of the process lifetime. Safe on non-trading days.
    try:
        from services.dummy_session import ensure_dummy_session
        await ensure_dummy_session()
        _dummy_session_task_holder["task"] = asyncio.create_task(_dummy_session_loop())
        logger.info("Dummy daily session: READY")
    except Exception as exc:
        logger.warning("Dummy daily-session bootstrap failed (retrying in background): %s", exc)
        try:
            _dummy_session_task_holder["task"] = asyncio.create_task(_dummy_session_loop())
        except Exception:
            logger.exception("Dummy daily-session loop could not be started (non-fatal)")

    # Paper Market Feed: give the Dummy terminal its OWN real-time LTP source by
    # tapping the backend's WS#1 tick buffer. Without it the paper engine only
    # priced orders when a browser pushed ticks, so resting dummy orders could
    # sit forever — the opposite of broker behaviour. Non-fatal on failure.
    try:
        from services.paper_market_feed import paper_market_feed
        await paper_market_feed.start()
    except Exception as exc:
        logger.warning("Paper Market Feed start failed (non-fatal): %s", exc)

    # Preload the NSE instrument master. If a persisted copy exists it loads
    # from disk (session-independent) so search works immediately; otherwise
    # it stays NOT_AVAILABLE until the next login downloads it.
    try:
        _cache_ok = load_instrument_cache()
        _cache_state = instrument_cache_state()
        logger.info(
            "Instrument master preload: loaded=%s state=%s count=%s",
            _cache_ok, _cache_state.get("state"), _cache_state.get("instrumentCount"),
        )
    except Exception as exc:
        logger.warning("Instrument master preload failed (non-critical): %s", exc)

    _startup_report()

    # Start the 7-day WebSocket history retention cleanup (backend side).
    # It complements the MongoDB TTL index and guarantees old history is
    # removed even if the frontend is never opened.
    _cleanup_task = asyncio.create_task(_retention_cleanup_loop())
    _cleanup_task_holder["task"] = _cleanup_task

    # Start the notification-center retention loop (read notifications +
    # resolved alerts age out of MongoDB; active/open alerts are never deleted).
    try:
        from services.notification_center import retention_loop
        _ncenter_task = asyncio.create_task(retention_loop())
        _ncenter_task_holder["task"] = _ncenter_task
    except Exception as exc:
        logger.warning("Notification-center retention loop not started: %s", exc)

    # Start the engine self-reporting watcher. Engines are the ones that know
    # when they break, so they are the ones that raise the alert: this samples
    # the engine registry and creates ONE alert + ONE notification per genuine
    # state/health transition (plus one recovery), never one per poll. Started
    # after the engines are registered above so the first pass primes a baseline
    # instead of alerting about every engine at boot.
    try:
        from services.engine_alert_reporter import engine_alert_reporter
        await engine_alert_reporter.start()
        _engine_alerts_task_holder["reporter"] = engine_alert_reporter
    except Exception as exc:
        logger.warning("Engine alert reporter not started: %s", exc)

    # Start the Data Insights background tasks: API telemetry flusher,
    # per-minute telemetry sampler, incident correlator and the end-of-day
    # daily report generator. All four are non-fatal and self-healing.
    try:
        from services import api_telemetry
        _insights_task_holder["api_telemetry"] = api_telemetry.start_flusher()
    except Exception as exc:
        logger.warning("API telemetry flusher not started: %s", exc)
    _insights_task_holder["telemetry"] = asyncio.create_task(_telemetry_sampler_loop())
    _insights_task_holder["correlator"] = asyncio.create_task(_incident_correlator_loop())
    _insights_task_holder["daily_report"] = asyncio.create_task(_daily_report_loop())

    # Start the Data Center snapshot loop (persisted DB-growth history for the
    # storage / growth charts). Non-fatal and self-healing like its siblings.
    try:
        from services import data_center
        data_center.mark_process_started()
        _insights_task_holder["data_center_snapshot"] = data_center.start_snapshot_loop()
    except Exception as exc:
        logger.warning("Data center snapshot loop not started: %s", exc)

    # Start the realtime ws_live frame publisher (feeds the WebSocket monitor
    # + Mongo-ingestion live cards over the single system SSE channel).
    _live_frame_task_holder["task"] = asyncio.create_task(_live_frame_loop())

    # Start the Data Quality live publisher (aggregated pipeline metrics
    # every ~2s on the shared event bus as `quality_live`; read-only).
    _dq_live_task_holder["task"] = asyncio.create_task(_dq_live_loop())

    # Start the Tick Analytics background workers: the historical daily
    # document backfill and the coalesced ~1 Hz realtime summary publisher.
    # Both are read-only observability tasks and non-fatal if they fail.
    try:
        from services import tick_analytics_daily
        tick_analytics_daily.queue_backfill(tick_analytics_daily.recent_days(30))
        _tick_analytics_task_holder["backfill"] = asyncio.create_task(
            _tick_analytics_backfill_loop()
        )
        _tick_analytics_task_holder["publish"] = asyncio.create_task(
            _tick_analytics_publish_loop()
        )
        logger.info("Tick Analytics backfill + realtime publisher: STARTED")
    except Exception as exc:
        logger.warning("Tick Analytics background workers not started: %s", exc)

    # Start the Atlas daily cleanup scheduler (06:00 Asia/Kolkata wipe of
    # temporary market data). Backend-side half of the cleanup story; the
    # Atlas Scheduled Trigger covers the backend-offline case.
    try:
        from services import atlas_cleanup
        atlas_cleanup.start_cleanup_scheduler()
        logger.info("Atlas daily cleanup scheduler: ARMED (06:00 Asia/Kolkata)")
    except Exception as exc:
        logger.warning("Atlas cleanup scheduler not started: %s", exc)

    # Start the storage budget guard. The 06:00 wipe bounds storage across days
    # but cannot stop a single trading session from exhausting a small cluster
    # mid-session, which write-blocks every writer and takes the API down. The
    # guard trims the oldest regenerable market data whenever real usage crosses
    # the configured budget.
    try:
        from services import storage_guard
        storage_guard.start_storage_guard()
        logger.info(
            "Storage budget guard: ARMED (budget=%d MB, every %d s)",
            settings.storage_budget_mb, settings.storage_guard_interval_sec,
        )
    except Exception as exc:
        logger.warning("Storage budget guard not started: %s", exc)

    yield

    logger.info("KAUSTUBH FastAPI backend shutting down...")
    _mark_state(_STATE_STOPPING)
    record_event("process", "shutting_down", "info", "FastAPI lifespan shutdown started")

    # Stop the Data Insights background tasks (bound, never fatal).
    for _key, _task in list(_insights_task_holder.items()):
        if _task is not None:
            _task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await asyncio.wait_for(asyncio.shield(_task), timeout=3)
        _insights_task_holder[_key] = None

    # Stop the Dummy daily-session rollover loop (bound, never fatal).
    _task = _dummy_session_task_holder.get("task")
    if _task is not None:
        _task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.wait_for(asyncio.shield(_task), timeout=3)
    _dummy_session_task_holder["task"] = None

    # Stop the Paper Market Feed (detaches the WS#1 tick listener first so a
    # shutdown does not leave a dangling listener pushing into the paper engine).
    try:
        from services.paper_market_feed import paper_market_feed
        await paper_market_feed.stop()
    except Exception as exc:
        logger.warning("Paper Market Feed stop failed (bounded): %s", exc)

    # Stop the history retention cleanup loop.
    _task = _cleanup_task_holder.get("task")
    if _task is not None:
        _task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.wait_for(asyncio.shield(_task), timeout=3)
    _cleanup_task_holder["task"] = None

    # Stop the Atlas daily cleanup scheduler.
    try:
        from services import atlas_cleanup
        await atlas_cleanup.stop_cleanup_scheduler()
    except Exception as exc:
        logger.warning("Atlas cleanup scheduler stop failed (bounded): %s", exc)

    # Stop the storage budget guard.
    try:
        from services import storage_guard
        await storage_guard.stop_storage_guard()
    except Exception as exc:
        logger.warning("Storage budget guard stop failed (bounded): %s", exc)

    # Stop the notification-center retention loop.
    _ncenter_task = _ncenter_task_holder.get("task")
    if _ncenter_task is not None:
        _ncenter_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.wait_for(asyncio.shield(_ncenter_task), timeout=3)
    _ncenter_task_holder["task"] = None

    # Stop the engine self-reporting watcher.
    _engine_reporter = _engine_alerts_task_holder.get("reporter")
    if _engine_reporter is not None:
        with contextlib.suppress(Exception):
            await _engine_reporter.stop()
    _engine_alerts_task_holder["reporter"] = None

    # Stop the realtime ws_live frame publisher.
    _live_task = _live_frame_task_holder.get("task")
    if _live_task is not None:
        _live_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.wait_for(asyncio.shield(_live_task), timeout=3)
    _live_frame_task_holder["task"] = None

    # Stop the Data Quality live publisher.
    _dq_task = _dq_live_task_holder.get("task")
    if _dq_task is not None:
        _dq_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.wait_for(asyncio.shield(_dq_task), timeout=3)
    _dq_live_task_holder["task"] = None

    # Stop the Tick Analytics background workers (backfill + realtime publisher).
    for _key in list(_tick_analytics_task_holder.keys()):
        _ta_task = _tick_analytics_task_holder.get(_key)
        if _ta_task is not None:
            _ta_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await asyncio.wait_for(asyncio.shield(_ta_task), timeout=3)
        _tick_analytics_task_holder[_key] = None

    # Stop the Connection Engine (backend -> frontend realtime WS #2).
    try:
        from connection_engine import connection_engine
        await asyncio.wait_for(connection_engine.shutdown(), timeout=3)
    except Exception as exc:
        logger.warning("Connection Engine shutdown failed (bounded): %s", exc)

    # Stop the WS-engine event-bus bridge.
    try:
        from api.ws_engine import get_wired_engine
        await get_wired_engine().stop_event_bridge()
    except Exception as exc:
        logger.warning("WS engine event-bridge shutdown failed (bounded): %s", exc)

    # Teardown must never be halted because one component failed to stop.
    for name, stop in (
        ("downloads checker", stop_scheduled_downloads_checker),
        ("export worker", stop_export_worker),
        ("scheduler", stop_scheduler),
    ):
        try:
            result = stop()
            if result is not None and hasattr(result, "__await__"):
                await result
        except Exception as exc:
            logger.exception("Teardown step failed (%s): %s", name, exc)

    # Ensure the WebSocket supervisors are stopped before broker logout
    try:
        from ws_socket.ws_manager import ws_manager
        ws_manager.stop_supervisor()
    except Exception:
        pass
    try:
        from ws_socket.order_feed_manager import order_feed_manager
        order_feed_manager.stop_supervisor()
    except Exception:
        pass

    # Graceful broker logout on shutdown (reason: application_shutdown).
    # Bounded — never hang the process on a dead broker network path.
    if kotak_session.session_active:
        try:
            await asyncio.wait_for(do_logout(source="system"), timeout=10)
        except Exception as exc:
            logger.warning("Shutdown broker logout failed (bounded): %s", exc)

    for name, coro in (
        ("tick buffer", tick_buffer.stop()),
        ("MongoDB disconnect", disconnect_mongo()),
    ):
        try:
            await coro
        except Exception as exc:
            logger.exception("Teardown step failed (%s): %s", name, exc)

    # Small grace period lets in-flight SDK callbacks calm down before the
    # event loop closes (prevents teardown races on Windows).
    await asyncio.sleep(0.2)
    record_event("process", "stopped", "info", "FastAPI lifespan shutdown complete")


app = FastAPI(
    title="KAUSTUBH Trading Platform",
    description="Production Kotak Neo trading backend",
    version="2.0.0",
    lifespan=lifespan,
)


@app.get("/health")
async def root_health():
    """GET /health — alias of /api/system/health (real DB ping, 503 when down).

    Distinguishes database / backend / websocket / scheduler / session /
    pipeline and never reports healthy when MongoDB is unreachable.
    """
    from api.system import system_health
    return await system_health()

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins.split(",") if settings.cors_origins != "*" else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Timezone contract
# ---------------------------------------------------------------------------
# The whole product reports IST. Most routes already emit "+05:30" because
# ``sanitize_for_json`` renders every datetime through ``core.timezones.iso_ist``,
# but ~50 endpoints pre-serialize a timestamp with an explicit UTC designator
# before returning it. This middleware is the single choke point that guarantees
# nothing leaves the service advertising UTC.
#
# It is a raw ASGI middleware rather than ``@app.middleware("http")`` on
# purpose: BaseHTTPMiddleware re-wraps every downstream response in a
# StreamingResponse, which both hides the real response object and forces the
# body to be consumed. Patching ``http.response.body`` chunks as they are sent
# keeps SSE / chunked endpoints streaming and leaves Content-Length valid,
# because "+00:00" and "+05:30" are the same number of bytes. The patch also
# CONVERTS the instant (UTC -> IST), so a ``09:42:58+00:00`` written by a route
# reaches the UI as ``15:12:58+05:30`` instead of being relabelled as IST.
class IstTimestampMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_ist(message):
            if message.get("type") == "http.response.body":
                body = message.get("body")
                if body:
                    message = dict(message, body=rewrite_utc_offsets_inplace(body))
            await send(message)

        await self.app(scope, receive, send_with_ist)


app.add_middleware(IstTimestampMiddleware)


# ---------------------------------------------------------------------------
# Database-outage error contract
# ---------------------------------------------------------------------------
# When MongoDB Atlas is unreachable every database-backed route would otherwise
# surface FastAPI's default bare "Internal Server Error" text/plain body, which
# tells the browser nothing and hides the real cause. The handlers below turn
# those into a structured, credential-free 503 so the UI can show why the
# feature is unavailable instead of a blank page. HTTPException (explicit 4xx
# from a route) keeps its own status/detail untouched.
from fastapi import HTTPException
from fastapi.responses import JSONResponse
from services.json_safe import rewrite_utc_offsets_inplace
from pymongo.errors import PyMongoError


_SECRET_HINTS = ("password", "passwd", "pwd", "uri", "username", "user", "auth", "token", "secret")


def _safe_exc_detail(exc: Exception) -> str | None:
    """First line of a driver error with anything credential-ish removed.

    The generic "MongoDB is not reachable." told the UI nothing about *why* a
    route failed while ping/query probes passed (a bad index spec, an
    unsupported operator, a transaction on a standalone node). Keep the reason,
    drop anything that could carry a URI or password.
    """
    try:
        text = str(exc).strip().splitlines()[0] if str(exc).strip() else ""
    except Exception:
        return None
    if not text:
        return None
    for secret in settings.MONGO_URI, getattr(settings, "MONGO_PASSWORD", None):
        if secret and len(str(secret)) > 3:
            text = text.replace(str(secret), "***")
    try:
        import re as _re

        text = _re.sub(r"mongodb(\+srv)?://\S+", "mongodb://***", text)
    except Exception:
        pass
    lowered = text.lower()
    if any(hint in lowered for hint in _SECRET_HINTS) and "://" in text:
        return "database error (details redacted)"
    return text[:300]


def _atlas_outage_payload(exc: Exception) -> dict:
    """Credential-free description of a live Atlas connectivity failure."""
    from database.connection import get_mongo_info

    info = get_mongo_info()
    detail = info.get("error") or _safe_exc_detail(exc) or "MongoDB is not reachable."
    source = info.get("source") or "unknown"
    return {
        "ok": False,
        "status": "degraded",
        "error": "mongodb_unavailable",
        "detail": detail,
        "exception": type(exc).__name__,
        "provider": f"mongodb-{source}",
        "source": source,
        "host": info.get("host"),
        "database": info.get("database"),
        "connected": False,
    }


@app.exception_handler(HTTPException)
async def _http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"ok": False, "detail": exc.detail},
        headers=getattr(exc, "headers", None),
    )


@app.exception_handler(PyMongoError)
async def _pymongo_error_handler(request: Request, exc: PyMongoError):
    """Any PyMongo/Motor failure -> 503 naming Atlas as the cause."""
    log = logging.getLogger("app")
    log.error(
        "Database-backed request failed while Atlas was unavailable: %s %s -> %s",
        request.method, request.url.path, type(exc).__name__,
    )
    return JSONResponse(status_code=503, content=_atlas_outage_payload(exc))


@app.exception_handler(AssertionError)
async def _assertion_error_handler(request: Request, exc: AssertionError):
    """Motor raises bare AssertionError for some unavailable-server paths."""
    log = logging.getLogger("app")
    log.error(
        "Database-backed request failed on an unavailable server: %s %s -> %s",
        request.method, request.url.path, str(exc)[:200],
    )
    return JSONResponse(status_code=503, content=_atlas_outage_payload(exc))

# Mount all routers
app.include_router(session_router)
app.include_router(auth_router)
app.include_router(stocks_router)
app.include_router(ticks_router)
app.include_router(downloads_router)
app.include_router(export_jobs_router)
app.include_router(statistics_router)
app.include_router(logs_router)
app.include_router(system_router)
app.include_router(settings_router)
app.include_router(trading_router)
app.include_router(trading_dashboard_router)
app.include_router(watchlist_router)
app.include_router(watch_list_router)
app.include_router(market_watch_router)
app.include_router(search_router)
app.include_router(watchlist_engine_router)
app.include_router(notifications_router)
app.include_router(alerts_router)
app.include_router(tick_analytics_router)
app.include_router(baskets_router)
app.include_router(demo_router)
app.include_router(scheduled_downloads_router)
app.include_router(schedule_events_router)
app.include_router(quality_router)
app.include_router(websocket_router)
app.include_router(insights_router)
app.include_router(terminal_router)
app.include_router(shoonya_router)
app.include_router(security_router)
app.include_router(user_router)
app.include_router(data_center_router)
app.include_router(cleanup_router)
app.include_router(ws_engine_router)
app.include_router(ws_gateway_router)
app.include_router(dummy_router)
app.include_router(engine_control_router)
app.include_router(storage_engine_router)
app.include_router(database_monitoring_router)
app.include_router(session_manager_router)
app.include_router(risk_engine_router)
app.include_router(order_engine_router)
app.include_router(trade_instruments_router)


if __name__ == "__main__":
    uvicorn.run(
        "app:app",
        host=settings.host,
        port=settings.port,
        reload=False,
    )


@app.middleware("http")
async def log_requests(request, call_next):
    import time
    from services.api_telemetry import record_request

    started = time.monotonic()
    route_path = None
    try:
        route = request.scope.get("route")
        route_path = getattr(route, "path", None)
    except Exception:
        route_path = None
    if not route_path:
        route_path = request.url.path

    try:
        response = await call_next(request)
    except Exception:
        try:
            record_request(
                request.method, route_path, 500,
                (time.monotonic() - started) * 1000, db_related=False)
        except Exception:
            logger.debug("api telemetry record failed (failed request)")
        logger.exception("REQUEST FAILED => %s %s", request.method, route_path)
        raise

    duration_ms = (time.monotonic() - started) * 1000
    try:
        record_request(request.method, route_path, response.status_code,
                       duration_ms, db_related=False)
    except Exception:
        logger.debug("api telemetry record failed")
    logger.info("REQUEST => %s %s", request.method, route_path)
    logger.info("RESPONSE <= %s", response.status_code)
    return response
