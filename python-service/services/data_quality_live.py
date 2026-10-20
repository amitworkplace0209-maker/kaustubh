"""Lightweight real-time Data Quality snapshot (read-only monitoring).

This module is the single source of truth for the redesigned Data Quality
page. It aggregates ONLY in-memory counters/state already maintained by the
live pipeline engines — it never scans MongoDB, never triggers duplicate
scans, and never writes ticks.

Pipeline (read-only)::

    Kotak Neo SDK -> WebSocket Engine -> Market Watch -> Live Tick
        -> DB Writer (SAVE/DROP) -> MongoDB
        -> data_quality_live.build_snapshot()
        -> backend SSE/WebSocket -> Data Quality UI

Source of truth per metric:
    total_ticks      -> WebSocket Engine (ws_manager tick_count)
    tick_rate        -> tick_buffer rolling 10s window (ticksPerSecond)
    saved_ticks      -> tick_buffer totalWritten (DB Writer -> Mongo)
    failed_ticks     -> tick_buffer totalWriteErrors (Mongo write failures)
    duplicate_ticks  -> DB Writer _duplicates (dedup cache hits)
    dropped_ticks    -> DB Writer _rejected (SAVE/DROP validation drops)
    active_symbols   -> Session Manager active_registry (subscribed universe)
    freshness        -> backend timestamps (last_tick_at -> now)
    ws status        -> ws_manager.status()
    market watch     -> market_watch_engine.status_snapshot()
    db writer        -> db_writer_engine counters + tick_buffer
    mongodb          -> database.connection.get_mongo_info() (I/O-free)

Contract:
    REST  GET /api/data-quality/live  -> build_snapshot()
    SSE   event {type: "quality_live", ...snapshot} every ~1s on the
          existing shared event_bus (/api/schedule-events/stream).
          The frontend reuses its single SSE connection — no second socket.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger("app.data_quality_live")

# Stale thresholds (seconds) — mirrors services/data_quality freshness.
LIVE_SEC = 5.0
DEGRADED_SEC = 30.0

# Cached Mongo ping so the 1s broadcast loop never blocks on I/O.
_mongo_ping_cache: dict[str, Any] = {"pingMs": None, "at": 0.0}
_MONGO_PING_TTL_S = 10.0

# Previous cumulative counters for backend-computed per-second rates.
# throughput = (current - previous) / time_delta — never frontend counting.
_prev_rates: dict[str, Any] = {"at": 0.0, "received": None, "written": None, "errors": None, "dropped": None}
_MIN_RATE_DT_S = 0.5


def _delta_rates(received: int, written: int, errors: int, dropped: int) -> dict[str, float | None]:
    """Backend per-second rates from cumulative counters (monotonic clock)."""
    now = time.monotonic()
    prev_at = float(_prev_rates.get("at") or 0.0)
    out: dict[str, float | None] = {
        "ingressPerSec": None,
        "writePerSec": None,
        "dropPerSec": None,
        "failPerSec": None,
    }
    try:
        if _prev_rates.get("received") is not None and now - prev_at >= _MIN_RATE_DT_S:
            dt = max(now - prev_at, 1e-3)
            pairs = (
                ("ingressPerSec", received - int(_prev_rates["received"])),
                ("writePerSec", written - int(_prev_rates["written"])),
                ("dropPerSec", dropped - int(_prev_rates["dropped"])),
                ("failPerSec", errors - int(_prev_rates["errors"])),
            )
            for key, delta in pairs:
                # Counter reset (restart) yields negative delta -> report None once.
                out[key] = round(max(delta, 0) / dt, 2) if delta >= 0 else None
    except (TypeError, ValueError):
        pass
    _prev_rates.update({"at": now, "received": received, "written": written, "errors": errors, "dropped": dropped})
    return out


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_ts(value: Any) -> float | None:
    """Parse ISO string / epoch seconds / epoch ms / datetime to epoch sec."""
    if value is None:
        return None
    try:
        if isinstance(value, (int, float)):
            v = float(value)
            # Heuristic: ms epoch is far larger than s epoch.
            if v > 1e12:
                return v / 1000.0
            if v > 1e10:
                return v / 1000.0
            return v
        if isinstance(value, datetime):
            dt = value
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.timestamp()
        if isinstance(value, str):
            s = value.strip()
            if not s:
                return None
            # Epoch as string?
            try:
                num = float(s)
                return _parse_ts(num)
            except ValueError:
                pass
            iso = s.replace("Z", "+00:00")
            try:
                dt = datetime.fromisoformat(iso)
            except ValueError:
                return None
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.timestamp()
    except Exception:
        return None
    return None


def _freshness(last_tick_at: Any, now: float | None = None) -> dict[str, Any]:
    now = now if now is not None else time.time()
    ts = _parse_ts(last_tick_at)
    if ts is None:
        return {
            "lastTickAt": None,
            "freshnessMs": None,
            "freshnessState": "NO_DATA",
        }
    age_ms = max(0.0, (now - ts) * 1000.0)
    age_s = age_ms / 1000.0
    if age_s < LIVE_SEC:
        state = "LIVE"
    elif age_s <= DEGRADED_SEC:
        state = "DEGRADED"
    else:
        state = "STALE"
    return {
        "lastTickAt": last_tick_at,
        "freshnessMs": round(age_ms, 1),
        "freshnessState": state,
    }


def _safe_int(value: Any) -> int | None:
    try:
        if value is None:
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def _safe_float(value: Any) -> float | None:
    try:
        if value is None:
            return None
        f = float(value)
        return f
    except (TypeError, ValueError):
        return None


def _mongo_status() -> dict[str, Any]:
    """I/O-free Mongo status (never exposes URI/credentials)."""
    try:
        from database.connection import get_mongo_info

        info = get_mongo_info() or {}
        return {
            "connected": bool(info.get("connected")),
            "source": info.get("source"),
            "database": info.get("database"),
            "host": info.get("host"),
            "error": info.get("error"),
            "serverVersion": info.get("serverVersion"),
        }
    except Exception as exc:
        logger.debug("mongo info unavailable: %s", exc)
        return {"connected": False, "source": None, "error": "unavailable"}


async def _mongo_ping_cached() -> float | None:
    """Ping at most every _MONGO_PING_TTL_S; returns pingMs or None."""
    now = time.monotonic()
    cached_at = float(_mongo_ping_cache.get("at") or 0.0)
    if now - cached_at < _MONGO_PING_TTL_S and _mongo_ping_cache.get("pingMs") is not None:
        try:
            return float(_mongo_ping_cache["pingMs"])
        except (TypeError, ValueError):
            return None
    try:
        from database.connection import ping_mongo

        import asyncio

        res = await asyncio.wait_for(ping_mongo(timeout_s=2.0), timeout=2.5)
        ping_ms = res.get("pingMs") if isinstance(res, dict) else None
        if ping_ms is not None:
            _mongo_ping_cache["pingMs"] = float(ping_ms)
            _mongo_ping_cache["at"] = now
            return float(ping_ms)
        # Failed ping: keep old value but refresh timestamp to avoid hammering.
        _mongo_ping_cache["at"] = now
        return None
    except Exception:
        _mongo_ping_cache["at"] = now
        return None


def _ws_status() -> dict[str, Any]:
    try:
        from ws_socket.ws_manager import ws_manager

        st = ws_manager.status() or {}
        diag = st.get("diagnostics") or {}
        metrics = st.get("metrics") or {}
        return {
            "connected": bool(st.get("connected")),
            "state": st.get("lifecycle_state") or st.get("state"),
            "supervisorState": st.get("supervisor_state"),
            "feedState": st.get("feed_state"),
            "subscriptions": _safe_int(st.get("subscription_count")) or 0,
            "tickCount": _safe_int(st.get("tick_count")) or 0,
            "messagesReceived": _safe_int(st.get("total_messages") if st.get("total_messages") is not None else st.get("messages_received")) or 0,
            "ticksReceived": _safe_int(metrics.get("ticks_received")),
            "lastTickAt": st.get("last_tick_at"),
            "lastMessageAt": st.get("last_message_at"),
            "reconnectCount": _safe_int(st.get("reconnect_count")) or 0,
            "secondsSinceTick": _safe_float(diag.get("seconds_since_last_tick")),
            "connectedAt": st.get("connected_at"),
            "disconnectReason": st.get("disconnect_reason"),
        }
    except Exception as exc:
        logger.debug("ws status unavailable: %s", exc)
        return {"connected": False, "state": None, "error": "unavailable"}


def _tick_buffer() -> dict[str, Any]:
    try:
        from services import tick_buffer

        return tick_buffer.stats() or {}
    except Exception as exc:
        logger.debug("tick_buffer stats unavailable: %s", exc)
        return {}


def _db_writer() -> dict[str, Any]:
    """DB Writer counters (in-memory, no Mongo I/O)."""
    out: dict[str, Any] = {
        "ingested": None,
        "rejected": None,
        "duplicates": None,
        "queueRejected": None,
        "dropReasons": {},
    }
    try:
        from services.db_writer_engine import db_writer_engine as eng

        for attr, key in (
            ("_ingested", "ingested"),
            ("_rejected", "rejected"),
            ("_duplicates", "duplicates"),
            ("_queue_rejected", "queueRejected"),
        ):
            try:
                out[key] = int(getattr(eng, attr, 0) or 0)
            except (TypeError, ValueError):
                out[key] = 0
        try:
            rc = getattr(eng, "_reason_counts", {}) or {}
            out["dropReasons"] = {str(k): int(v) for k, v in dict(rc).items()}
        except Exception:
            out["dropReasons"] = {}
    except Exception as exc:
        logger.debug("db_writer counters unavailable: %s", exc)
    return out


def _market_watch() -> dict[str, Any]:
    try:
        from services.market_watch_engine import market_watch_engine as mw

        snap = None
        try:
            snap = mw.status_snapshot() or {}
        except Exception:
            snap = {}
        custom = (snap.get("metrics") or {}).get("custom") or {}
        base = snap.get("status") or snap.get("state")

        def _pick(*keys: str) -> Any:
            for k in keys:
                if custom.get(k) is not None:
                    return custom.get(k)
                if snap.get(k) is not None:
                    return snap.get(k)
            return None

        subscribed = _pick("subscribedTokenCount", "eligibleStateCount", "eligibleUniverseCount")
        return {
            "running": not bool(_pick("stopped")),
            "state": custom.get("lifecycleState") or custom.get("feedState") or base,
            "feedState": custom.get("feedState"),
            "activeSymbols": _safe_int(_pick("eligibleStateCount", "eligibleUniverseCount", "subscribedTokenCount")),
            "subscribed": _safe_int(subscribed) or 0,
            "liveInstruments": _safe_int(custom.get("liveInstrumentCount")),
            "ticksPerSecond": _safe_float(custom.get("ticksPerSecond")),
            "tickCount": _safe_int(custom.get("tickCount")),
            "lastTickAt": custom.get("lastTickAt"),
        }
    except Exception as exc:
        logger.debug("market_watch status unavailable: %s", exc)
        return {"running": False, "state": None, "error": "unavailable"}


def _active_registry_count() -> int | None:
    try:
        from services.session.session_manager import session_manager

        reg = session_manager.active_registry() or {}
        return len(reg)
    except Exception:
        return None


def _scheduler_status() -> dict[str, Any]:
    """Scheduler engine state (owner: scheduler)."""
    try:
        import scheduler as _sched

        info = _sched.get_scheduler_info() or {}
        running = info.get("running")
        if running is None:
            running = bool(info.get("state"))
        return {
            "running": bool(running),
            "state": str(info.get("state") or ("RUNNING" if running else "STOPPED")),
        }
    except Exception as exc:
        logger.debug("scheduler status unavailable: %s", exc)
        return {"running": None, "state": None}


def _session_status() -> dict[str, Any]:
    """Broker session state (owner: session manager / Kotak session)."""
    try:
        from auth.kotak_client import kotak_session

        active = bool(getattr(kotak_session, "session_active", False))
        return {
            "active": active,
            "state": "ACTIVE" if active else "INACTIVE",
        }
    except Exception as exc:
        logger.debug("session status unavailable: %s", exc)
        return {"active": None, "state": None}


def _buffer_config() -> dict[str, Any]:
    """DB Writer buffer tuning (owner: DB Writer / tick_buffer config)."""
    out: dict[str, Any] = {"batchSize": None, "flushIntervalMs": None}
    try:
        from services import tick_buffer

        for fn_name, key in (("r_bulk_insert", "batchSize"), ("r_flush_interval_ms", "flushIntervalMs")):
            try:
                fn = getattr(tick_buffer, fn_name, None)
                if callable(fn):
                    out[key] = int(fn())
            except (TypeError, ValueError):
                pass
    except Exception as exc:
        logger.debug("buffer config unavailable: %s", exc)
    return out


def _recent_issues(limit: int = 8) -> list[dict[str, Any]]:
    """Small recent window of important in-memory events (no Mongo scan)."""
    issues: list[dict[str, Any]] = []
    try:
        from services import event_history

        events = event_history.recent_events(limit=60) or []
        for ev in events:
            sev = str(ev.get("severity") or ev.get("status") or "info").lower()
            if sev not in ("warning", "error", "critical"):
                continue
            ts = ev.get("ts")
            try:
                ts_iso = ts.isoformat() if hasattr(ts, "isoformat") else (str(ts) if ts else None)
            except Exception:
                ts_iso = None
            issues.append(
                {
                    "ts": ts_iso,
                    "title": str(ev.get("event") or "event"),
                    "detail": str(ev.get("message") or ev.get("reason") or ""),
                    "severity": sev,
                    "source": str(ev.get("source") or ""),
                    "symbol": ev.get("symbol"),
                }
            )
            if len(issues) >= limit:
                break
    except Exception as exc:
        logger.debug("recent events unavailable: %s", exc)
    # Fallback: surface live error strings from engines so the panel is never
    # empty when something is actually broken.
    if not issues:
        try:
            buf = _tick_buffer()
            last_err = buf.get("lastError")
            if last_err:
                issues.append(
                    {
                        "ts": None,
                        "title": "tick_buffer_error",
                        "detail": str(last_err)[:280],
                        "severity": "error",
                        "source": "tick_buffer",
                        "symbol": None,
                    }
                )
        except Exception:
            pass
    return issues[:limit]


def build_snapshot(ping_ms: float | None = None) -> dict[str, Any]:
    """Build the lightweight live snapshot (sync part; ping optional)."""
    now_wall = time.time()
    ws = _ws_status()
    buf = _tick_buffer()
    dbw = _db_writer()
    mw = _market_watch()
    mongo = _mongo_status()
    registry_count = _active_registry_count()

    total_written = _safe_int(buf.get("totalWritten")) or 0
    total_errors = _safe_int(buf.get("totalWriteErrors")) or 0
    ingested = int(dbw.get("ingested") or 0)
    rejected = int(dbw.get("rejected") or 0)
    duplicates = int(dbw.get("duplicates") or 0)

    # Total attempts through the DB Writer consumer path.
    received = ingested + rejected + duplicates
    # True broker-side total (authoritative when the feed has ever ticked).
    ws_ticks = int(ws.get("tickCount") or 0)
    total_ticks = ws_ticks if ws_ticks > 0 else received

    tick_rate = _safe_float(buf.get("ticksPerSecond")) or 0.0
    write_rate = _safe_float(buf.get("writesPerSecond")) or 0.0

    # Backend-computed per-second rates from cumulative counters.
    # Semantics: received(attempts) = ingested(accepted) + rejected(dropped)
    #   + duplicates; accepted(buffered) ~= written + failed + pending.
    delta = _delta_rates(received, total_written, total_errors, rejected)
    ingress_per_sec = delta["ingressPerSec"]
    # Processing = accepted-into-buffer rate (backend rolling window).
    processing_per_sec = _safe_float(buf.get("ticksPerSecond"))

    # Active symbols: subscribed universe first, live-ticking fallback.
    active_symbols: int | None = registry_count
    if active_symbols is None:
        active_symbols = _safe_int(mw.get("subscribed"))
    ticking = _safe_int(buf.get("activeTickStocks"))
    if active_symbols in (None, 0) and ticking:
        active_symbols = ticking

    # Freshness prefers the WS tick clock, falls back to buffer clock.
    last_tick = ws.get("lastTickAt") or buf.get("lastTickAt") or mw.get("lastTickAt")
    fresh = _freshness(last_tick, now_wall)

    # DB-write freshness is tracked independently from tick freshness.
    last_write_at = buf.get("lastWriteAt") or buf.get("lastFlushAt")
    write_fresh = _freshness(last_write_at, now_wall)
    write_age_state = write_fresh.get("freshnessState")
    # A write clock only means something once a write has ever happened.
    if last_write_at is None:
        write_age_state = "NO_DATA"

    feed_lat = buf.get("feedLatencyMs") or {}
    latency_ms = _safe_float(feed_lat.get("currentMs"))
    if latency_ms is None:
        # Fall back to hop-to-hop backend measurement when feed age is unknown.
        try:
            from services import pipeline_latency as _pl

            stages = (_pl.stats() or {}).get("stages") or {}
            for key in ("ws_recv_to_db_writer", "broker_to_db_writer", "ws_recv_to_mongo", "broker_to_ws"):
                blk = stages.get(key) or {}
                if blk.get("p50_ms") is not None:
                    latency_ms = float(blk["p50_ms"])
                    break
        except Exception:
            pass

    # Engine running flags (real, never hardcoded green).
    db_running = bool(buf.get("pipelineRunning"))
    ws_connected = bool(ws.get("connected"))
    mw_running = bool(mw.get("running")) if mw.get("running") is not None else None
    mongo_connected = bool(mongo.get("connected"))

    queue_depth = _safe_int(buf.get("bufferLength")) or 0
    queue_cap = _safe_int(buf.get("bufferMaxSize"))
    buf_cfg = _buffer_config()
    sched = _scheduler_status()
    sess = _session_status()

    # Mongo write-hop latency (backend clock only, never broker clock).
    mongo_hop_ms: float | None = None
    try:
        from services import pipeline_latency as _plm

        _stages = (_plm.stats() or {}).get("stages") or {}
        for _key in ("ws_recv_to_mongo", "broker_to_mongo"):
            _blk = _stages.get(_key) or {}
            if _blk.get("p50_ms") is not None:
                mongo_hop_ms = float(_blk["p50_ms"])
                break
    except Exception:
        pass

    # Tick Processing stage: the buffer flush loop + live flow-through.
    processing_flowing = (fresh.get("freshnessState") == "LIVE") or (float(tick_rate or 0.0) > 0)
    processing_state = "FLOWING" if processing_flowing else ("IDLE" if db_running else "STOPPED")

    # WS engine's own computed rates (pass-through when the engine provides them).
    ws_rates = ws.get("rates") if isinstance(ws.get("rates"), dict) else None

    # Denominator for percentages: all ingest attempts.
    denom = received if received > 0 else (total_ticks if total_ticks > 0 else 0)

    def _pct(n: int) -> float | None:
        if not denom:
            return None
        try:
            return round((n / denom) * 100.0, 3)
        except ZeroDivisionError:
            return None

    def _conn_state(connected: bool | None) -> str:
        if connected is True:
            return "CONNECTED"
        if connected is False:
            return "DISCONNECTED"
        return "UNKNOWN"

    snapshot: dict[str, Any] = {
        "timestamp": _now_iso(),
        "totalTicks": total_ticks,
        "tickRate": round(float(tick_rate), 2),
        "receivedTicks": received,
        "savedTicks": total_written,
        "savedPct": _pct(total_written),
        "failedTicks": total_errors,
        "failedPct": _pct(total_errors),
        "duplicateTicks": duplicates,
        "duplicatePct": _pct(duplicates),
        "droppedTicks": rejected,
        "droppedPct": _pct(rejected),
        "activeSymbols": active_symbols,
        "tickingSymbols": ticking,
        "writesPerSecond": round(float(write_rate), 2),
        "queueDepth": queue_depth,
        "queueCapacity": queue_cap,
        "latencyMs": latency_ms,
        "freshnessMs": fresh.get("freshnessMs"),
        "freshnessState": fresh.get("freshnessState"),
        "lastTickAt": fresh.get("lastTickAt"),
        "lastWriteAt": last_write_at,
        "writeAgeMs": write_fresh.get("freshnessMs"),
        "writeAgeState": write_age_state,
        "throughput": {
            # All backend-computed; None until two snapshots establish a delta.
            "ingressPerSec": ingress_per_sec,
            "processingPerSec": processing_per_sec,
            "writePerSec": round(float(write_rate), 2),
            "dropPerSec": delta["dropPerSec"],
            "failPerSec": delta["failPerSec"],
            "tickRate": round(float(tick_rate), 2),
        },
        "websocket": {
            "connected": ws_connected,
            "state": _conn_state(ws_connected),
            "feedState": ws.get("feedState"),
            "supervisorState": ws.get("supervisorState"),
            "subscriptions": ws.get("subscriptions") or 0,
            "messagesReceived": ws.get("messagesReceived") or 0,
            "ticksReceived": ws.get("ticksReceived"),
            "rates": ws_rates,
            "lastTickAt": ws.get("lastTickAt"),
            "lastMessageAt": ws.get("lastMessageAt"),
            "reconnectCount": ws.get("reconnectCount") or 0,
        },
        "marketWatch": {
            "running": mw_running,
            "state": mw.get("state") or ("RUNNING" if mw_running else "STOPPED"),
            "feedState": mw.get("feedState"),
            "activeSymbols": mw.get("activeSymbols"),
            "subscribed": mw.get("subscribed") or 0,
            "ticksPerSecond": mw.get("ticksPerSecond"),
            "lastTickAt": mw.get("lastTickAt"),
        },
        "dbWriter": {
            "running": db_running,
            "state": "RUNNING" if db_running else "IDLE",
            "received": received,
            "written": total_written,
            "dropped": rejected,
            "failed": total_errors,
            "duplicates": duplicates,
            "queue": queue_depth,
            "queueCapacity": queue_cap,
            "writeRate": round(float(write_rate), 2),
            "lastWriteAt": buf.get("lastWriteAt"),
            "lastFlushAt": buf.get("lastFlushAt"),
            "dropReasons": dbw.get("dropReasons") or {},
        },
        "mongodb": {
            "connected": mongo_connected,
            "state": _conn_state(mongo_connected),
            "source": mongo.get("source"),
            "pingMs": ping_ms if ping_ms is not None else _mongo_ping_cache.get("pingMs"),
            "writeLatencyMs": mongo_hop_ms,
            "error": mongo.get("error"),
        },
        "ingestion": {
            # MongoDB write path, owned by DB Writer + tick_buffer.
            "received": received,
            "queued": queue_depth,
            "written": total_written,
            "failed": total_errors,
            "dropped": rejected,
            "pending": queue_depth,
            "queueDepth": queue_depth,
            "queueCapacity": queue_cap,
            "writeRate": round(float(write_rate), 2),
            "writeLatencyMs": mongo_hop_ms,
            "batchSize": buf_cfg.get("batchSize"),
            "flushIntervalMs": buf_cfg.get("flushIntervalMs"),
            "lastWriteAt": last_write_at,
            "lastWriteError": buf.get("lastError"),
            "lastFailedWriteAt": buf.get("lastFailedWriteAt"),
            "uptimeSec": buf.get("pipelineUptimeSeconds"),
        },
        "scheduler": {
            "running": sched.get("running"),
            "state": sched.get("state") or ("RUNNING" if sched.get("running") else "STOPPED"),
        },
        "session": {
            "active": sess.get("active"),
            "state": sess.get("state") or "UNKNOWN",
        },
        "pipeline": [
            {
                "name": "Market Watch",
                "state": mw.get("state") or ("RUNNING" if mw_running else "STOPPED"),
                "ok": bool(mw_running),
            },
            {
                "name": "WebSocket",
                "state": _conn_state(ws_connected),
                "ok": ws_connected,
            },
            {
                "name": "Tick Processing",
                "state": processing_state,
                "ok": db_running and processing_flowing,
            },
            {
                "name": "DB Writer",
                "state": "RUNNING" if db_running else "IDLE",
                "ok": db_running,
            },
            {
                "name": "MongoDB",
                "state": _conn_state(mongo_connected),
                "ok": mongo_connected,
            },
        ],
        "recentIssues": _recent_issues(limit=8),
    }
    return snapshot


async def build_snapshot_async() -> dict[str, Any]:
    """Async wrapper that refreshes the cached Mongo ping before snapshotting."""
    ping_ms: float | None = None
    try:
        ping_ms = await _mongo_ping_cached()
    except Exception:
        ping_ms = None
    # get_mongo_info is sync/I/O-free; when the driver reports disconnected
    # the cached ping must not masquerade as live.
    try:
        from database.connection import is_mongo_connected

        if not is_mongo_connected():
            ping_ms = None
    except Exception:
        pass
    return build_snapshot(ping_ms=ping_ms)
