"""
Live runtime settings bridge (TTL-cached).

The scheduler state machine, tick pipeline and WebSocket supervisor resolve
their knobs from this cache instead of ONLY from the immutable env config, so
changes made in the Data Saver Settings app take effect on the live process —
typically within one reconcile tick (~5 s) — WITHOUT a backend restart.

Design:

  * ``refresh_runtime_settings()`` (async) re-reads MongoDB into a thin
    process-global cache. It is called at app startup, in the scheduler
    reconcile loop (every tick) and after every ``set_setting`` write.
  * ``get_runtime_setting(key)`` (+ ``rt_bool`` / ``rt_int`` / ``rt_hhmm``)
    are synchronous and negligible on the hot paths (scheduler ``_market_slot``,
    tick flush loop). They fall back to the env ``config.settings`` defaults
    when the DB value is absent, invalid or the cache is not loaded yet.
  * ``LIVE_KEYS`` enumerates every key the runtime engine actually consumes.
    Keys outside this set are still persisted to MongoDB (and applied at
    process startup via ``apply_env_overrides`` where a config field exists),
    but the Settings UI reports them with ``live=False`` so they are never
    presented as having an instant runtime effect.

This module intentionally imports nothing from the scheduler / ws / tick
pipeline to avoid import cycles; those modules import THIS module instead.
"""
from __future__ import annotations

import asyncio
import logging
import threading
import time
from typing import Any

from config.settings import settings

logger = logging.getLogger("runtime_settings")

_TTL_SECONDS = 12.0

_lock = threading.RLock()
_cache: dict[str, Any] = {}
_cache_ts: float = 0.0

# Runtime keys the backend consumes LIVE. Adding a key here makes the Settings
# UI render its "applies immediately" indicator for it.
LIVE_KEYS: set[str] = {
    # Scheduler session lifecycle
    "sched_enabled", "sched_login_time", "sched_ws_start_time",
    "sched_tick_collection_start_time", "sched_ws_stop_time", "sched_logout_time", "sched_market_timezone",
    "sched_trading_day_behavior",
    # Trading-day phase timings (Scheduler Engine #01)
    "sched_pre_market_start_time", "sched_limit_order_start_time",
    "sched_equilibrium_start_time", "sched_buffer_start_time",
    "sched_feed_start_time", "sched_square_off_time", "sched_feed_stop_time",
    "sched_square_off_enabled",
    # Canonical trading-terminal mode (kotak | shoonya | dummy) — durable
    # authority so the scheduler and broker manager restore the user's selected
    # mode after a backend restart instead of silently falling back to Kotak.
    "terminal_mode",
    # WebSocket supervisor (reconnect policy + market window)
    "ws_enabled", "ws_auto_reconnect", "ws_max_reconnect_attempts",
    "ws_reconnect_delay_ms", "ws_backoff", "ws_heartbeat",
    "ws_tick_persistence", "ws_error_logging", "ws_history_retention_days",
    # Tick pipeline / data collection
    "ds_collection_enabled", "ds_live_tick_collection", "ds_batch_size",
    "batch_size", "buffer_size", "bulk_insert_size", "flush_interval_ms",
    "retry_count", "auto_save",
    # Mongo tick storage schema (legacy | canonical_only). canonical_only makes
    # to_storage_doc persist ONLY the master canonical representation.
    "ds_storage_schema",
    # Market Watch Engine knobs (docs/engines/MARKET_WATCH.md §23)
    "mwr_ranking_interval_seconds", "mwr_max_pins", "mwr_initial_section_limit",
    "mwr_page_size", "mwr_stale_threshold_seconds", "mwr_universe_refresh_seconds",
    # Market Watch persistence switches. services/market_watch_config.py
    # re-resolves these on EVERY tick, so a flip takes effect on the next tick.
    "mwr_persist_ticks", "mwr_persist_candles", "mwr_persist_decisions",
    "mwr_tick_retention_days",
    # Market Watch weekly intraday screen. services/market_watch_intraday.py
    # re-resolves these on EVERY scan, so editing the screen takes effect on the
    # next Sat/Sun scan without a restart.
    "mwr_price_max", "mwr_margin_required", "mwr_margin_multiplier_threshold",
    "mwr_intraday_required", "mwr_intraday_policy", "mwr_friday_scan_hhmm",
    # DB Writer tick persistence policies (independent switches)
    "dbw_personal_no_expiry_ticks", "dbw_personal_expiry_ticks", "dbw_market_watch_ticks",
    # DB Writer master switch — re-resolved on every SAVE/DROP decision.
    "dbw_ticks_enabled",
    # DB Writer storage caps. services/db_writer_engine.py re-resolves these on
    # every SAVE/DROP decision, so lifting or applying a cap takes effect on the
    # very next tick -- no restart, and no need to edit code.
    "dbw_storage_cap_personal_no_expiry", "dbw_storage_cap_personal_one_day",
    "dbw_storage_cap_market_watch_one_day", "dbw_storage_cap_reason",
    # ------------------------------------------------------------------
    # Per-engine settings surfaced by the Service Control Center's engine
    # settings form (core/engines/engine_config.py). Listing a key here makes
    # the Settings UI report it as "applies immediately" instead of
    # "restart required", so the two surfaces never contradict each other.
    # Only keys an engine actually re-resolves at runtime belong here.
    # ------------------------------------------------------------------
    # Market Watch — re-resolved every tick by services/market_watch_config.py
    "mwr_max_gainer_pins", "mwr_max_loser_pins",
    # Session Manager — re-resolved on each session validation
    "sm_session_lifetime_seconds", "sm_expiry_warning_seconds",
    "sm_tick_active_window_seconds",
    # Storage Engine — thresholds re-read on every monitoring sample
    "stg_monitoring_enabled", "stg_sample_interval_seconds", "stg_history_max",
    "stg_retention_seconds", "stg_threshold_duration_samples",
    "stg_cpu_warn_pct", "stg_cpu_crit_pct", "stg_mem_warn_pct", "stg_mem_crit_pct",
    "stg_disk_warn_pct", "stg_disk_crit_pct", "stg_queue_warn", "stg_queue_crit",
    "stg_latency_warn_ms", "stg_latency_crit_ms", "stg_database_ping_enabled",
    "stg_network_metrics_enabled", "stg_engine_health_aggregation_enabled",
    # Feature / Market Coach — window re-read per feature computation
    "fe_rolling_window", "mc_universe_size", "mc_refresh_interval_seconds",
    # Square-Off / Watchlist / WebSocket feed / Order Engine
    "sq_enabled", "sq_trigger_time", "sq_apply_to", "wl_default_watchlist",
    "ws_feed_broker", "mg_fallback_block_on_unavailable",
    "oe_requires_broker_confirmation",
}

# Config-level keys applied to the env `Settings` dataclass once at startup,
# so persisted settings that the backend only reads at boot DO take effect on
# the next process start. Each maps persisted key -> list of (field, parser).
def _parse_hhmm(hhmm: Any) -> tuple[int, int] | None:
    if isinstance(hhmm, str) and ":" in hhmm:
        try:
            h, m = hhmm.strip().split(":")
            h, m = int(h), int(m)
            if 0 <= h <= 23 and 0 <= m <= 59:
                return h, m
        except (ValueError, TypeError):
            return None
    return None


def _to_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


# (persisted_key, [(field, parser)]) — applied to the `Settings` dataclass at boot.
_STARTUP_OVERRIDES: dict[str, list[tuple[str, Any]]] = {
    "sched_login_time": [
        ("login_hour", lambda v, d: _parse_hhmm(v)[0] if _parse_hhmm(v) else d),
        ("login_minute", lambda v, d: _parse_hhmm(v)[1] if _parse_hhmm(v) else d),
    ],
    "sched_logout_time": [
        ("logout_hour", lambda v, d: _parse_hhmm(v)[0] if _parse_hhmm(v) else d),
        ("logout_minute", lambda v, d: _parse_hhmm(v)[1] if _parse_hhmm(v) else d),
    ],
    "sched_ws_start_time": [
        ("ws_start_hour", lambda v, d: _parse_hhmm(v)[0] if _parse_hhmm(v) else d),
        ("ws_start_minute", lambda v, d: _parse_hhmm(v)[1] if _parse_hhmm(v) else d),
    ],
    "sched_tick_collection_start_time": [
        ("tick_collection_hour", lambda v, d: _parse_hhmm(v)[0] if _parse_hhmm(v) else d),
        ("tick_collection_minute", lambda v, d: _parse_hhmm(v)[1] if _parse_hhmm(v) else d),
    ],
    "sched_ws_stop_time": [
        ("ws_stop_hour", lambda v, d: _parse_hhmm(v)[0] if _parse_hhmm(v) else d),
        ("ws_stop_minute", lambda v, d: _parse_hhmm(v)[1] if _parse_hhmm(v) else d),
    ],
    "sched_pre_market_start_time": [
        ("pre_market_hour", lambda v, d: _parse_hhmm(v)[0] if _parse_hhmm(v) else d),
        ("pre_market_minute", lambda v, d: _parse_hhmm(v)[1] if _parse_hhmm(v) else d),
    ],
    "sched_limit_order_start_time": [
        ("limit_order_hour", lambda v, d: _parse_hhmm(v)[0] if _parse_hhmm(v) else d),
        ("limit_order_minute", lambda v, d: _parse_hhmm(v)[1] if _parse_hhmm(v) else d),
    ],
    "sched_equilibrium_start_time": [
        ("equilibrium_hour", lambda v, d: _parse_hhmm(v)[0] if _parse_hhmm(v) else d),
        ("equilibrium_minute", lambda v, d: _parse_hhmm(v)[1] if _parse_hhmm(v) else d),
    ],
    "sched_buffer_start_time": [
        ("buffer_hour", lambda v, d: _parse_hhmm(v)[0] if _parse_hhmm(v) else d),
        ("buffer_minute", lambda v, d: _parse_hhmm(v)[1] if _parse_hhmm(v) else d),
    ],
    "sched_feed_start_time": [
        ("feed_start_hour", lambda v, d: _parse_hhmm(v)[0] if _parse_hhmm(v) else d),
        ("feed_start_minute", lambda v, d: _parse_hhmm(v)[1] if _parse_hhmm(v) else d),
    ],
    "sched_square_off_time": [
        ("square_off_hour", lambda v, d: _parse_hhmm(v)[0] if _parse_hhmm(v) else d),
        ("square_off_minute", lambda v, d: _parse_hhmm(v)[1] if _parse_hhmm(v) else d),
    ],
    "sched_feed_stop_time": [
        ("feed_stop_hour", lambda v, d: _parse_hhmm(v)[0] if _parse_hhmm(v) else d),
        ("feed_stop_minute", lambda v, d: _parse_hhmm(v)[1] if _parse_hhmm(v) else d),
    ],
    "flush_interval_ms": [("buffer_flush_interval_ms", lambda v, d: _to_int(v, d))],
    "buffer_size": [("buffer_max_size", lambda v, d: _to_int(v, d))],
    "bulk_insert_size": [("bulk_insert_size", lambda v, d: _to_int(v, d))],
    "log_level": [("log_level", lambda v, d: str(v))],
}


def _fresh() -> bool:
    with _lock:
        return bool(_cache) and (time.monotonic() - _cache_ts) < _TTL_SECONDS


def get_runtime_setting(key: str):
    """Synchronous cached read (never awaits MongoDB)."""
    with _lock:
        return _cache.get(key) if _cache else None


def rt_bool(key: str, default: bool) -> bool:
    value = get_runtime_setting(key)
    return value if isinstance(value, bool) else default


def rt_int(key: str, default: int) -> int:
    value = get_runtime_setting(key)
    if isinstance(value, bool):
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def rt_hhmm(key: str, default_hour: int, default_minute: int) -> tuple[int, int]:
    """Resolve an HH:MM setting, falling back to the env defaults."""
    parsed = _parse_hhmm(get_runtime_setting(key))
    return parsed if parsed else (default_hour, default_minute)


async def refresh_runtime_settings() -> None:
    """Re-read the runtime keys from MongoDB into the cache (best-effort)."""
    global _cache, _cache_ts
    snapshot: dict[str, Any] = {}
    try:
        from services.settings_service import DEFAULTS, get_all_settings
        all_settings = await get_all_settings()
        for key in LIVE_KEYS:
            item = all_settings.get(key)
            snapshot[key] = (
                item.get("value") if item is not None else DEFAULTS.get(key, {}).get("value")
            )
        with _lock:
            _cache = snapshot
            _cache_ts = time.monotonic()
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.debug("runtime settings refresh failed (using previous cache): %s", exc)


def is_live_key(key: str) -> bool:
    return key in LIVE_KEYS


def apply_env_overrides() -> None:
    """Overlay persisted settings onto the env ``Settings`` dataclass once at boot.

    Fixes the "settings do nothing" gap for config that the backend only reads
    at import time, so persisted values genuinely apply on the next start.
    Only safe, read-once fields are patched (never live socket/auth state).
    """
    applied: list[str] = []
    with _lock:
        snapshot = dict(_cache)
    from services.settings_service import DEFAULTS

    for key, fields in _STARTUP_OVERRIDES.items():
        item = DEFAULTS.get(key)
        if item is None:
            continue
        value = snapshot.get(key, item.get("value"))
        if value is None:
            continue
        for field_name, parser in fields:
            current = getattr(settings, field_name)
            try:
                parsed = parser(value, current)
            except Exception:
                continue
            if parsed is not None:
                setattr(settings, field_name, parsed)
        applied.append(key)

    if applied:
        logger.info("Applied persisted DB settings to runtime config at boot: %s", ", ".join(applied))


def start_background_sync(interval_seconds: float = _TTL_SECONDS) -> asyncio.Task | None:
    """Periodically refresh the cache so settings changes propagate even when
    the scheduler is stopped (e.g. sched_enabled toggled while offline)."""
    from core.event_loop import get_loop

    async def _loop() -> None:
        while True:
            try:
                await refresh_runtime_settings()
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            await asyncio.sleep(interval_seconds)

    try:
        loop = get_loop()
    except Exception:
        return None
    if loop is None or not loop.is_running():
        return None
    return loop.create_task(_loop())


def snapshot() -> dict[str, Any]:
    """Read-only copy of the current runtime cache (for status endpoints)."""
    with _lock:
        return {k: v for k, v in _cache.items()}