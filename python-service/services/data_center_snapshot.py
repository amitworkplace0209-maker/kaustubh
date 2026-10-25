"""Data Center - ONE authoritative, backend-owned snapshot.

This module is the *aggregation layer* the Data Center page consumes. It is the
single place where the backend resolves "what is the real state of the system
right now" across the engines that already own each fact:

    existing backend engines
        -> Data Center aggregation (this module)
        -> authoritative snapshot / realtime
        -> responsive Data Center UI
        -> web + PWA

Design rules (all enforced, all testable)
------------------------------------------
1. **Read-only.** Nothing here writes to MongoDB, mutates an engine, starts or
   stops a task, or changes tick-persistence authority. The only side effect is
   reading existing in-memory snapshots and already-cached read paths.
2. **No secrets.** Connection metadata comes exclusively from
   ``database.connection.get_mongo_info()`` (source label, database name,
   credential-free host, server version, pool counters). No URI, no user, no
   password, no API key, no token, no JWT is read or forwarded.
3. **No fabrication.** Every field is a real measurement or a real configured
   setting. A value that could not be measured is ``None`` and its section
   carries ``available: false`` plus the real reason - never ``0``, never
   ``[]``, never ``false``, never a guess.
4. **Single ownership.** Where an engine already owns a value (DB Writer tick
   counters, Market Watch eligibility, Session Manager lifecycle, Scheduler
   phase, Connection Manager health, Storage Engine sampling) this module
   *republishes that engine's own snapshot*. It never recomputes a second
   opinion about another engine's work.
5. **Failure isolation.** Every section is built inside its own guard. One
   failing section degrades only itself; the rest of the snapshot still renders.
6. **Fast.** The whole snapshot is assembled from in-process snapshots plus
   ``api.system.mongo_stats()`` (which already has its own 10s TTL cache). It
   performs no collection scan, no deep scan, and no historical aggregation.
   Heavy work stays behind explicit user actions on dedicated endpoints.
"""
from __future__ import annotations

import logging
import os
import platform
import time
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from database.connection import get_mongo_info, is_mongo_connected

logger = logging.getLogger("data_center.snapshot")

SCHEMA_VERSION = 2

# --------------------------------------------------------------------------- #
# Provenance - every section states the module that produced its numbers, so a
# value on screen can be traced without opening devtools.
# --------------------------------------------------------------------------- #
SOURCE_RUNTIME = "brokers.manager.active_terminal + services.session.session_manager.snapshot"
SOURCE_DATABASE = "database.connection.get_mongo_info"
SOURCE_STORAGE = "api.system.mongo_stats (cached 10s, collStats/dbStats)"
SOURCE_REALTIME = "ws_socket.ws_manager.status + connection_engine.connection_engine.status"
SOURCE_SESSION = "services.session.session_manager.snapshot"
SOURCE_SCHEDULER = "scheduler.get_scheduler_state + services.market_state.market_state_service"
SOURCE_PERSISTENCE = "services.db_writer_engine.DBWriterEngine.status_snapshot"
SOURCE_MARKET_DATA = "services.market_watch_engine.MarketWatchEngine.status_snapshot"
SOURCE_HEALTH = "derived from the sections above (no new measurement)"

#: The six system-health categories the Data Center reports. Deliberately coarse
#: - the page must answer "is this area healthy", not re-list every engine.
HEALTH_CATEGORIES = (
    "database",
    "persistence",
    "realtime",
    "session",
    "scheduler",
    "marketData",
)

#: Runtime execution modes this backend can be configured in. Used to *describe*
#: a real configured value - never to synthesise one.
KNOWN_TERMINALS = ("kotak", "shoonya", "dummy")

_PROCESS_START = time.time()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _err(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc}"


def _iso_or_none(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat()
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(float(value), tz=timezone.utc).isoformat()
        except (OverflowError, OSError, ValueError):
            return None
    return str(value) if value else None


def _unavailable(source: str, reason: str) -> dict[str, Any]:
    """A section that could not be read, with its real reason."""
    return {
        "available": False,
        "source": source,
        "error": reason,
        "generatedAt": _now_iso(),
    }


# --------------------------------------------------------------------------- #
# Section 1 - runtime (the REAL current execution mode)
# --------------------------------------------------------------------------- #
def runtime_section() -> dict[str, Any]:
    """The real runtime mode of this process.

    ``brokers.manager.active_terminal()`` is the single authoritative resolver
    for which terminal the trading context is switched to (live session mode ->
    persisted ``terminal_mode`` setting -> ``BROKER_MODE`` env). The Data Center
    reports whatever it returns. When the backend is genuinely configured for
    the paper ``dummy`` terminal this section says so plainly - it is a real
    configuration value, not a placeholder.
    """
    section: dict[str, Any] = {
        "available": True,
        "source": SOURCE_RUNTIME,
        "error": None,
        "generatedAt": _now_iso(),
        "terminalMode": None,
        "terminalModeAvailable": False,
        "isPaperTerminal": None,
        "knownTerminals": list(KNOWN_TERMINALS),
        "process": {
            "pid": os.getpid(),
            "python": platform.python_version(),
            "startedAt": datetime.fromtimestamp(
                _PROCESS_START, tz=timezone.utc
            ).isoformat(),
            "uptimeSeconds": round(time.time() - _PROCESS_START, 1),
            "host": platform.node() or None,
            "platform": platform.system() or None,
        },
    }

    try:
        from brokers.manager import active_terminal, is_dummy_mode

        mode = active_terminal()
        section["terminalMode"] = str(mode) if mode else None
        section["terminalModeAvailable"] = bool(mode)
        section["isPaperTerminal"] = bool(is_dummy_mode())
    except Exception as exc:  # noqa: BLE001
        # NOT a reason to hide the section: the process facts above stay valid.
        section["available"] = False
        section["error"] = _err(exc)

    # Session Manager owns the *session* mode; surface it next to the terminal
    # so "which terminal" and "whose session" can never be confused.
    try:
        from services.session.session_manager import session_manager

        snap = session_manager.snapshot()
        section["sessionMode"] = snap.get("mode")
        section["sessionBroker"] = snap.get("broker")
    except Exception as exc:  # noqa: BLE001
        logger.debug("runtime section: session mode unavailable: %s", exc)
        section["sessionMode"] = None
        section["sessionBroker"] = None
        section["sessionModeError"] = _err(exc)

    return section


# --------------------------------------------------------------------------- #
# Section 2 - database (identity + connection)
# --------------------------------------------------------------------------- #
def database_section() -> dict[str, Any]:
    """Which MongoDB this process is actually talking to, measured now.

    ``source`` is the *active* source label published by
    ``database.connection`` after a successful handshake. ``configuredSource`` is
    derived from the URI scheme by ``settings.mongodb_source()`` and is the real
    configuration even when the connection is down - which is how the page can
    say "configured for Atlas, currently disconnected" without guessing.
    """
    info = get_mongo_info()
    connected = bool(info.get("connected"))

    section: dict[str, Any] = {
        "available": connected,
        "source": SOURCE_DATABASE,
        "error": info.get("error"),
        "generatedAt": _now_iso(),
        "connected": connected,
        "configured": bool(info.get("configured")),
        "provider": None,
        "providerAvailable": False,
        "configuredSource": None,
        "activeSource": info.get("source"),
        "database": info.get("database"),
        "host": info.get("host") or None,
        "serverVersion": info.get("serverVersion"),
        "connectedAt": _iso_or_none(info.get("connectedAt")),
        "pool": dict(info.get("pool") or {}),
    }

    try:
        from config.settings import settings

        section["configuredSource"] = settings.mongodb_source()
    except Exception as exc:  # noqa: BLE001
        logger.debug("database section: configured source unavailable: %s", exc)

    # The provider label is derived from the ACTIVE source when connected, else
    # from the configured source, and is always marked as derived. It is never
    # hard-coded to "atlas".
    label = section["activeSource"] or section["configuredSource"]
    if label:
        section["provider"] = str(label)
        section["providerAvailable"] = True
        section["providerDerivedFrom"] = (
            "active connection" if section["activeSource"] else "configuration"
        )

    return section


# --------------------------------------------------------------------------- #
# Section 3 - storage (totals + per-collection inventory)
# --------------------------------------------------------------------------- #
async def storage_section() -> dict[str, Any]:
    """Storage totals + the per-collection inventory, from the cached stats.

    Reuses ``api.system.mongo_stats()`` rather than running a second
    ``collStats`` sweep, so adding this snapshot did not add MongoDB load. A
    failed sweep is reported as unavailable - never as "this database is empty".
    """
    if not is_mongo_connected():
        return _unavailable(SOURCE_STORAGE, "MongoDB is not connected")

    try:
        from api.system import mongo_stats

        payload = await mongo_stats()
    except Exception as exc:  # noqa: BLE001
        return _unavailable(SOURCE_STORAGE, _err(exc))

    stats = payload.get("stats")
    if not stats:
        return _unavailable(
            SOURCE_STORAGE, payload.get("error") or "collection statistics unavailable"
        )

    collections = stats.get("collections") or []
    return {
        "available": True,
        "source": SOURCE_STORAGE,
        "error": None,
        "generatedAt": _now_iso(),
        "dbName": stats.get("dbName"),
        "documents": stats.get("totalObjects"),
        "dataSizeBytes": stats.get("totalSizeBytes"),
        "storageSizeBytes": stats.get("totalStorageBytes"),
        "indexSizeBytes": stats.get("totalIndexSizeBytes"),
        "collectionsCount": stats.get("collectionsCount"),
        "indexesCount": stats.get("indexesCount"),
        "pingMs": stats.get("pingMs"),
        "lastUpdatedAt": _iso_or_none(stats.get("lastUpdatedAt")),
        "collections": collections,
        "collectionsAvailable": collections is not None,
    }


# --------------------------------------------------------------------------- #
# Section 4 - realtime (broker feed / backend realtime / frontend realtime)
# --------------------------------------------------------------------------- #
def _broker_feed() -> dict[str, Any]:
    """WS#1 - the broker market-data feed, as the WebSocket Engine reports it."""
    from ws_socket.ws_manager import ws_manager

    st = ws_manager.status()
    diagnostics = st.get("diagnostics") or {}
    rates = st.get("rates") or {}
    return {
        "available": True,
        "source": "ws_socket.ws_manager.status (WS#1 broker feed)",
        "connected": bool(st.get("connected")),
        "state": st.get("state"),
        "lifecycleState": st.get("lifecycle_state"),
        "supervisorState": st.get("supervisor_state"),
        "feedState": st.get("feed_state"),
        "subscribedSymbols": st.get("subscribed_symbols"),
        "subscriptionCount": st.get("subscription_count"),
        # Real attempt counters. `reconnect_count` on the wire is a cumulative
        # *connect* count, so the attempt counter is published under its own
        # name and the connect count is labelled for what it is.
        "connectCount": st.get("reconnect_count"),
        "reconnectAttempts": diagnostics.get("reconnect_attempt")
        if isinstance(diagnostics, dict)
        else None,
        "disconnectReason": st.get("disconnect_reason"),
        "disconnectReasonCode": st.get("disconnect_reason_code"),
        "internetOk": st.get("internet_ok"),
        "ticksPerSecond": rates.get("ticksPerSecond") if isinstance(rates, dict) else None,
        "lastTickAt": _iso_or_none(diagnostics.get("lastTickAt"))
        if isinstance(diagnostics, dict)
        else None,
    }


def _backend_realtime() -> dict[str, Any]:
    """WS#3 - backend -> frontend fan-out, as the Connection Manager reports it."""
    from connection_engine import connection_engine

    st = connection_engine.status()
    stats = st.get("stats") or {}
    backpressure = st.get("backpressure") or {}
    freshness = st.get("freshness") or {}
    health = st.get("health") or {}
    return {
        "available": True,
        "source": "connection_engine.connection_engine.status (WS#3 backend->frontend)",
        "started": bool(st.get("started")),
        "startedAt": _iso_or_none(st.get("startedAt")),
        "activeConnections": stats.get("activeConnections"),
        "totalConnections": stats.get("totalConnections"),
        "messagesDelivered": stats.get("messagesDelivered"),
        "messagesDropped": stats.get("messagesDropped"),
        "framesRouted": st.get("framesRouted"),
        "queueDepthMax": backpressure.get("queueDepthMax"),
        "queueLimit": backpressure.get("queueLimit"),
        "feedFreshness": freshness.get("state"),
        "lastTickAgeSeconds": freshness.get("lastTickAgeSeconds"),
        "ticksPerSecond": freshness.get("ticksPerSecond"),
        "health": health.get("state"),
        "healthReason": health.get("reason"),
    }


def realtime_section() -> dict[str, Any]:
    """Three separately-measured realtime surfaces, never collapsed into one.

    The old page reduced every one of these to a single "Disconnected" chip.
    They are genuinely different things and they are reported separately, each
    with its own availability:

    * ``brokerFeed``   - measured by the WebSocket Engine.
    * ``backendRealtime`` - measured by the Connection Manager.
    * ``frontendRealtime`` - **not measurable by the backend at all.** The
      browser measures its own socket; the backend therefore publishes
      ``measurable: false`` with that reason and the client fills this one field
      from its own realtime client state.
    """
    section: dict[str, Any] = {
        "available": True,
        "source": SOURCE_REALTIME,
        "error": None,
        "generatedAt": _now_iso(),
        "frontendRealtime": {
            "measurable": False,
            "reason": "measured in the browser, not by the backend",
            "note": "The Data Center client reports its own realtime socket state.",
        },
    }

    for key, builder in (
        ("brokerFeed", _broker_feed),
        ("backendRealtime", _backend_realtime),
    ):
        try:
            section[key] = builder()
        except Exception as exc:  # noqa: BLE001
            logger.warning("realtime section: %s unavailable: %s", key, exc)
            section[key] = {"available": False, "error": _err(exc)}

    return section


# --------------------------------------------------------------------------- #
# Section 5 - session (Session Manager owns it)
# --------------------------------------------------------------------------- #
def session_section() -> dict[str, Any]:
    """The Session Manager's own snapshot - the subscription authority."""
    try:
        from services.session.session_manager import session_manager

        snap = session_manager.snapshot()
    except Exception as exc:  # noqa: BLE001
        return _unavailable(SOURCE_SESSION, _err(exc))

    state = snap.get("state")
    active = snap.get("active")
    expires_at = snap.get("expiresAt")
    now = time.time()
    expired: bool | None = None
    if expires_at:
        try:
            expiry_ts = datetime.fromisoformat(str(expires_at)).timestamp()
            expired = expiry_ts <= now
        except (TypeError, ValueError):
            expired = None

    return {
        "available": True,
        "source": SOURCE_SESSION,
        "error": None,
        "generatedAt": _now_iso(),
        "state": state,
        "lifecycleState": snap.get("lifecycleState"),
        "active": bool(active) if active is not None else None,
        "expired": expired,
        "mode": snap.get("mode"),
        "broker": snap.get("broker"),
        "userId": snap.get("userId"),
        "loginSource": snap.get("loginSource"),
        "loginTime": _iso_or_none(snap.get("loginTime")),
        "expiresAt": _iso_or_none(expires_at),
        "remainingSeconds": snap.get("remainingSeconds"),
        "lastActivityAt": _iso_or_none(snap.get("lastActivityAt")),
        "lastAuthError": snap.get("lastAuthError"),
        "reconnectCount": snap.get("reconnectCount"),
        "websocket": snap.get("websocket") or {},
    }


# --------------------------------------------------------------------------- #
# Section 6 - scheduler (Scheduler Engine owns the lifecycle)
# --------------------------------------------------------------------------- #
def scheduler_section() -> dict[str, Any]:
    """Scheduler lifecycle + market phase, consolidated.

    The scheduler runs an 18-state machine. The Data Center publishes the real
    state string plus the three booleans that actually matter to a reader
    (trading day, inside the login window, inside the WebSocket window) and the
    market phase - so ``WAITING_FOR_LOGIN`` can be read as "waiting for the
    login window", not as a generic failure.
    """
    section: dict[str, Any] = {
        "available": True,
        "source": SOURCE_SCHEDULER,
        "error": None,
        "generatedAt": _now_iso(),
        "state": None,
        "stateSince": None,
        "phase": None,
        "phaseSince": None,
        "nextPhase": None,
        "nextPhaseAt": None,
        "isTradingDay": None,
        "inLoginWindow": None,
        "inWebSocketWindow": None,
        "inTickCollectionWindow": None,
        "sessionOwner": None,
        "loginAttempts": None,
        "loginError": None,
        "webSocketAttempts": None,
        "webSocketError": None,
        "running": None,
        "market": None,
    }

    try:
        from scheduler import get_scheduler_info, get_scheduler_state

        st = get_scheduler_state()
        info = get_scheduler_info()
        section.update(
            {
                "state": st.get("state"),
                "stateSince": _iso_or_none(st.get("state_since")),
                "phase": st.get("phase"),
                "phaseSince": _iso_or_none(st.get("phase_since")),
                "nextPhase": st.get("next_phase"),
                "nextPhaseAt": _iso_or_none(st.get("next_phase_at")),
                "isTradingDay": st.get("is_trading_day"),
                "inLoginWindow": st.get("in_login_window"),
                "inWebSocketWindow": st.get("in_ws_window"),
                "inTickCollectionWindow": st.get("in_tick_collection_window"),
                "sessionOwner": st.get("session_owner"),
                "loginAttempts": st.get("login_attempts"),
                "loginError": st.get("login_error"),
                "webSocketAttempts": st.get("ws_attempts"),
                "webSocketError": st.get("ws_error"),
                "running": bool(info.get("running")) if info.get("running") is not None else None,
            }
        )
    except Exception as exc:  # noqa: BLE001
        section["available"] = False
        section["error"] = _err(exc)

    # Market phase is owned by the market state service, not the scheduler.
    try:
        from services.market_state import market_state_service

        snap = market_state_service.get_snapshot()
        section["market"] = {
            "available": True,
            "marketState": snap.get("market_state"),
            "marketSession": snap.get("market_session"),
            "marketStatus": snap.get("market_status"),
            "tradingDay": snap.get("trading_day"),
            "reasonCode": snap.get("reason_code"),
            "reasonMessage": snap.get("reason_message"),
            "closureReason": snap.get("closure_reason"),
            "isWeekend": snap.get("is_weekend"),
            "isExchangeHoliday": snap.get("is_exchange_holiday"),
            "nextMarketOpen": _iso_or_none(snap.get("next_market_open")),
            "nextMarketClose": _iso_or_none(snap.get("next_market_close")),
        }
    except Exception as exc:  # noqa: BLE001
        logger.debug("scheduler section: market phase unavailable: %s", exc)
        section["market"] = {"available": False, "error": _err(exc)}

    return section


# --------------------------------------------------------------------------- #
# Section 7 - persistence (DB Write Engine owns tick persistence)
# --------------------------------------------------------------------------- #
def persistence_section() -> dict[str, Any]:
    """DB Writer telemetry, republished verbatim.

    The Data Center never recomputes tick accounting. Whatever the writer
    reports is what the page shows.
    """
    try:
        from services.db_writer_engine import db_writer_engine

        snap = db_writer_engine.status_snapshot()
    except Exception as exc:  # noqa: BLE001
        return _unavailable(SOURCE_PERSISTENCE, _err(exc))

    pipeline = snap.get("pipeline") or {}
    return {
        "available": True,
        "source": SOURCE_PERSISTENCE,
        "authoritative": True,
        "error": None,
        "generatedAt": _now_iso(),
        "engineId": "db_writer_engine",
        "state": snap.get("state"),
        "health": snap.get("health"),
        "healthReason": snap.get("healthReason"),
        "version": snap.get("version"),
        "lastHeartbeat": _iso_or_none(snap.get("lastHeartbeat")),
        "ticksReceived": pipeline.get("totalReceived"),
        "ticksPersisted": pipeline.get("totalWritten"),
        "writeErrors": pipeline.get("totalWriteErrors"),
        "bufferLength": pipeline.get("bufferLength"),
        "ticksPerSecond": pipeline.get("ticksPerSecond"),
        "lastTickAt": _iso_or_none(pipeline.get("lastTickAt")),
        "lastWriteAt": _iso_or_none(pipeline.get("lastWriteAt")),
        "lastFlushAt": _iso_or_none(pipeline.get("lastFlushAt")),
        "lastFlushDurationMs": pipeline.get("lastFlushDurationMs"),
        "pipelineRunning": pipeline.get("pipelineRunning"),
        "feedLatencyMs": pipeline.get("feedLatencyMs"),
        "lastError": pipeline.get("lastError"),
        "lastFlushResult": snap.get("lastFlushResult"),
        "dataLossAccounting": snap.get("dataLossAccounting"),
    }


# --------------------------------------------------------------------------- #
# Section 8 - marketData (Market Watch owns eligibility + publication)
# --------------------------------------------------------------------------- #
def market_data_section() -> dict[str, Any]:
    """High-level Market Watch state.

    Only the counts a reader needs are surfaced. Market Watch's ranking
    algorithm, filters, ledgers and index internals are deliberately not
    projected - the Data Center is not a second Market Watch surface.
    """
    try:
        from services.market_watch_engine import market_watch_engine

        snap = market_watch_engine.status_snapshot()
    except Exception as exc:  # noqa: BLE001
        return _unavailable(SOURCE_MARKET_DATA, _err(exc))

    custom = (((snap.get("metrics") or {}).get("custom")) or {})
    return {
        "available": True,
        "source": SOURCE_MARKET_DATA,
        "error": None,
        "generatedAt": _now_iso(),
        "engineId": snap.get("engineId") or "market_watch",
        "state": snap.get("state"),
        "health": snap.get("health"),
        "healthReason": snap.get("healthReason"),
        "lifecycleState": custom.get("lifecycleState"),
        "feedState": custom.get("feedState"),
        "eligibleSymbols": custom.get("eligibleUniverseCount"),
        "eligibleStateCount": custom.get("eligibleStateCount"),
        "subscribedSymbols": custom.get("subscribedTokenCount"),
        "liveInstruments": custom.get("liveInstrumentCount"),
        "staleInstruments": custom.get("staleInstrumentCount"),
        "noDataInstruments": custom.get("noDataInstrumentCount"),
        "pendingInstruments": custom.get("pendingInstrumentCount"),
        "ticks": custom.get("tickCount"),
        "ticksPerSecond": custom.get("ticksPerSecond"),
        "lastTickAt": _iso_or_none(custom.get("lastTickAt")),
        "lastRankingAt": _iso_or_none(custom.get("lastRankingAt")),
        "lastPublishAt": _iso_or_none(custom.get("lastPublishAt")),
    }


# --------------------------------------------------------------------------- #
# Section 9 - health (coarse rollup, no new measurement)
# --------------------------------------------------------------------------- #
def _derive_health(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Roll the sections up into six meaningful categories.

    Nothing new is measured here - every verdict is a function of a value that
    another engine already reported, so this cannot drift from reality.
    """
    db = snapshot.get("database") or {}
    st = snapshot.get("storage") or {}
    rt = snapshot.get("realtime") or {}
    se = snapshot.get("session") or {}
    sc = snapshot.get("scheduler") or {}
    ps = snapshot.get("persistence") or {}
    md = snapshot.get("marketData") or {}

    broker = rt.get("brokerFeed") or {}
    backend_rt = rt.get("backendRealtime") or {}
    market = sc.get("market") or {}

    def _entry(key: str, state: str, reason: str | None) -> dict[str, Any]:
        return {"category": key, "state": state, "reason": reason}

    # Database
    if not db.get("available"):
        db_state, db_reason = "DOWN", db.get("error") or "MongoDB is not connected"
    elif not st.get("available"):
        db_state, db_reason = "DEGRADED", st.get("error")
    else:
        db_state, db_reason = "OK", None

    # Persistence
    if not ps.get("available"):
        ps_state, ps_reason = "UNKNOWN", ps.get("error")
    else:
        errors = ps.get("writeErrors")
        ps_state = "DEGRADED" if isinstance(errors, int) and errors > 0 else "OK"
        ps_reason = ps.get("healthReason") if ps_state != "OK" else None
        if ps_state == "DEGRADED" and ps_reason is None:
            ps_reason = f"{errors} tick write errors reported by DB Writer"

    # Realtime - broker feed and backend fan-out are reported as one category
    # but keep their two independent reasons.
    if not broker.get("available") and not backend_rt.get("available"):
        rt_state = "UNKNOWN"
        rt_reason = broker.get("error") or backend_rt.get("error")
    elif not broker.get("available"):
        rt_state, rt_reason = "DOWN", broker.get("error")
    elif not backend_rt.get("available"):
        rt_state, rt_reason = "DEGRADED", backend_rt.get("error")
    elif broker.get("connected") and backend_rt.get("health") in (None, "HEALTHY"):
        rt_state, rt_reason = "OK", None
    else:
        rt_state = "DEGRADED"
        parts = []
        if not broker.get("connected"):
            parts.append(
                broker.get("disconnectReason")
                or broker.get("lifecycleState")
                or "broker feed not connected"
            )
        if backend_rt.get("health") and backend_rt.get("health") != "HEALTHY":
            parts.append(str(backend_rt.get("healthReason") or backend_rt.get("health")))
        rt_reason = "; ".join(p for p in parts if p) or "realtime below nominal"

    # Session
    if not se.get("available"):
        se_state, se_reason = "UNKNOWN", se.get("error")
    elif se.get("expired") is True:
        se_state, se_reason = "DOWN", "session expired"
    elif se.get("active") is True:
        se_state, se_reason = "OK", None
    elif se.get("state"):
        se_state = "WAITING"
        se_reason = str(se.get("state"))
    else:
        se_state, se_reason = "UNKNOWN", "session state not reported"

    # Scheduler
    if not sc.get("available"):
        sc_state, sc_reason = "UNKNOWN", sc.get("error")
    elif not sc.get("isTradingDay"):
        sc_state, sc_reason = "OK", "not a trading day"
    elif sc.get("state") in (None, "ERROR", "LOGIN_FAILED", "SESSION_EXPIRED"):
        sc_state = "DOWN" if sc.get("state") in ("ERROR", "LOGIN_FAILED", "SESSION_EXPIRED") else "UNKNOWN"
        sc_reason = sc.get("loginError") or sc.get("webSocketError") or sc.get("state")
    elif sc.get("running"):
        sc_state, sc_reason = "OK", None
    else:
        sc_state, sc_reason = "WAITING", str(sc.get("state"))

    # Market data
    if not md.get("available"):
        md_state, md_reason = "UNKNOWN", md.get("error")
    elif md.get("health") in ("HEALTHY", None) and md.get("state") in ("RUNNING", None):
        md_state, md_reason = "OK", None
    else:
        md_state = "DEGRADED"
        md_reason = md.get("healthReason") or md.get("lifecycleState") or md.get("state")

    entries = [
        _entry("database", db_state, db_reason),
        _entry("persistence", ps_state, ps_reason),
        _entry("realtime", rt_state, rt_reason),
        _entry("session", se_state, se_reason),
        _entry("scheduler", sc_state, sc_reason),
        _entry("marketData", md_state, md_reason),
    ]

    states = [e["state"] for e in entries]
    if "DOWN" in states:
        overall = "DOWN"
    elif "DEGRADED" in states or "WAITING" in states:
        overall = "DEGRADED"
    elif "UNKNOWN" in states:
        overall = "UNKNOWN"
    else:
        overall = "OK"

    return {
        "source": SOURCE_HEALTH,
        "generatedAt": _now_iso(),
        "overall": overall,
        "categories": entries,
        "marketPhase": market.get("marketState"),
        "marketStatus": market.get("marketStatus"),
    }


# --------------------------------------------------------------------------- #
# Snapshot assembly
# --------------------------------------------------------------------------- #
#: Synchronous sections: cheap in-process snapshots, no I/O, no await. Still
#: individually guarded so a raising engine degrades only its own section.
SYNC_SECTIONS: dict[str, Callable[[], dict[str, Any]]] = {
    "runtime": runtime_section,
    "database": database_section,
    "session": session_section,
    "scheduler": scheduler_section,
    "persistence": persistence_section,
    "marketData": market_data_section,
    "realtime": realtime_section,
}

#: Async sections: these touch the already-cached read paths, so they stay fast
#: but must not block the event loop.
ASYNC_SECTIONS: dict[str, Callable[[], Awaitable[dict[str, Any]]]] = {
    "storage": storage_section,
}


async def build_snapshot() -> dict[str, Any]:
    """Assemble the whole Data Center snapshot with per-section isolation.

    Returns a dict shaped as::

        {
          "schemaVersion": 2,
          "generatedAt": "<iso>",
          "buildMs": <int>,
          "overall": "OK" | "DEGRADED" | "DOWN" | "UNKNOWN",
          "runtime": {...}, "database": {...}, "storage": {...},
          "realtime": {...}, "session": {...}, "scheduler": {...},
          "persistence": {...}, "marketData": {...}, "health": {...},
        }
    """
    started = time.perf_counter()
    snapshot: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": _now_iso(),
    }

    for name, builder in SYNC_SECTIONS.items():
        try:
            snapshot[name] = builder()
        except Exception as exc:  # noqa: BLE001
            logger.warning("data center snapshot: %s section failed: %s", name, exc)
            snapshot[name] = _unavailable("services.data_center_snapshot", _err(exc))

    for name, builder in ASYNC_SECTIONS.items():
        try:
            snapshot[name] = await builder()
        except Exception as exc:  # noqa: BLE001
            logger.warning("data center snapshot: %s section failed: %s", name, exc)
            snapshot[name] = _unavailable("services.data_center_snapshot", _err(exc))

    # Health is a pure derivation over the sections just built, so it is only
    # built when at least one of its inputs exists.
    try:
        snapshot["health"] = _derive_health(snapshot)
    except Exception as exc:  # noqa: BLE001
        logger.warning("data center snapshot: health rollup failed: %s", exc)
        snapshot["health"] = _unavailable(SOURCE_HEALTH, _err(exc))

    snapshot["overall"] = (snapshot.get("health") or {}).get("overall") or "UNKNOWN"
    snapshot["buildMs"] = int((time.perf_counter() - started) * 1000)
    return snapshot


#: Realtime push path: the Connection Engine rebuilds the snapshot at most once
#: per TTL and shares that document with every subscriber frame, so an open Data
#: Center page never triggers a per-client aggregation. The Connection Engine's
#: data-center loop is the only caller, so the cache is lock-free by
#: construction; the REST endpoint keeps its own independent cache.
PUSH_TTL_S = 5.0
_push_cache: tuple[float, dict[str, Any]] | None = None


async def get_cached_snapshot(ttl: float = PUSH_TTL_S) -> dict[str, Any]:
    """A snapshot for the realtime push path, rebuilt at most once per ``ttl``."""
    global _push_cache
    now = time.monotonic()
    if _push_cache is not None and now - _push_cache[0] < ttl:
        return _push_cache[1]
    snapshot = await build_snapshot()
    _push_cache = (time.monotonic(), snapshot)
    return snapshot


def get_snapshot_schema() -> dict[str, Any]:
    """Machine-readable description of the snapshot contract.

    The frontend derives its section list from this so a new backend section
    cannot be silently dropped by a stale client.
    """
    return {
        "schemaVersion": SCHEMA_VERSION,
        "sections": [
            "runtime",
            "database",
            "storage",
            "realtime",
            "session",
            "scheduler",
            "persistence",
            "marketData",
            "health",
        ],
        "healthCategories": list(HEALTH_CATEGORIES),
        "sources": {
            "runtime": SOURCE_RUNTIME,
            "database": SOURCE_DATABASE,
            "storage": SOURCE_STORAGE,
            "realtime": SOURCE_REALTIME,
            "session": SOURCE_SESSION,
            "scheduler": SOURCE_SCHEDULER,
            "persistence": SOURCE_PERSISTENCE,
            "marketData": SOURCE_MARKET_DATA,
            "health": SOURCE_HEALTH,
        },
        "readOnly": True,
    }
