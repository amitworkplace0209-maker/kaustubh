"""IST scheduler — deterministic market-session lifecycle state machine.

Single owner of the automatic session lifecycle. A single asyncio supervisor
task recomputes the *desired* state from the IST clock and the true underlying
state (Kotak session, WebSocket feed) every few seconds and drives the system
towards it. There are no reschedulable ``threading.Timer`` chains, so
start/stop is exact and duplicate runs cannot leak.

Normal market-day lifecycle (Asia/Kolkata always):

    08:50  automatic Kotak login
    08:55  WebSocket connection
    08:59  Tick collection start
    15:31  broker WebSocket disconnect (scheduled_disconnect)
    16:00  Kotak logout

State machine:

    STARTING ─▶ WAITING_FOR_LOGIN ─▶ LOGGING_IN ─▶ SESSION_ACTIVE
                                                │
      (non-trading day) ◀───────────────────┘
            │                                        ▼
    MARKET_CLOSED                          WAITING_FOR_WS ─▶ WS_CONNECTING
                                                ▲              │
                                          WS_RECONNECTING    WS_ACTIVE
                                                │              │
                                                │              ▼
                                        TICK_COLLECTION ─▶ TICK_COLLECTION_RUNNING
                                          (08:59 start)         │
                                                │              │
                                                ▼              │
                                        WS_DISCONNECTING (15:31)│
                                                │              │
                                                ▼              │
                                        LOGGING_OUT ─▶ LOGGED_OUT
                                       (16:00 logout)   / MARKET_CLOSED

    WS_PREPARING state has been removed. The 08:25 WebSocket preparation
    timing no longer exists. The scheduler goes directly from login to
    WebSocket connection.

Manual sessions are independent: they may be started on any day / any time and
last 60 minutes, surviving automatic teardown until their own expiry.
"""
from __future__ import annotations

import asyncio
import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from auth.kotak_client import kotak_session
from config.settings import settings
from core.event_loop import get_loop
from database.connection import get_db
from services import market_calendar
from services import tick_buffer
from services.notification_center import emit_event as record_event
from services.instrument_cache import load_instrument_cache
from services.market_state import market_state_service, CONFIRMATION_WINDOW_START, CONFIRMATION_WINDOW_END, MARKET_CLOSE_TIME
from services.runtime_settings import (
    rt_bool,
    rt_hhmm,
    refresh_runtime_settings,
    get_runtime_setting,
)
from services.session.session_manager import (
    session_manager,
    MANUAL_SESSION_SECONDS,
)
from ws_socket.ws_manager import ws_manager
from scheduler.persist import scheduler_ledger

logger = logging.getLogger("scheduler")

from core.timezones import IST, iso_ist


def _iso_or_none(value) -> str | None:
    """Normalize a manager timestamp (epoch float / datetime / str) to ISO.

    ``ws_manager.status()`` reports ``last_message_at`` as an epoch float, so
    the scheduler card has to convert it. Returns None for absent values so
    the card never invents a liveness timestamp.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return iso_ist(value)
    if isinstance(value, (int, float)):
        try:
            return iso_ist(datetime.fromtimestamp(float(value), tz=timezone.utc))
        except (OverflowError, OSError, ValueError):
            return None
    return str(value) or None


def _ws_last_message_at() -> str | None:
    """Last real feed message timestamp, or None if unavailable.

    Diagnostic only: never raises, because a missing or failing status
    surface must not take down the broker lifecycle card.
    """
    try:
        st = ws_manager.status() or {}
    except Exception:
        logger.debug("scheduler: ws_manager.status() unavailable", exc_info=True)
        return None
    return _iso_or_none(st.get("last_message_at"))

# Runtime states (single source of truth for the whole app).
STATE_STARTING = "STARTING"
STATE_WAITING_FOR_LOGIN = "WAITING_FOR_LOGIN"
STATE_LOGGING_IN = "LOGGING_IN"
STATE_SESSION_ACTIVE = "SESSION_ACTIVE"
STATE_WAITING_FOR_WS = "WAITING_FOR_WS"
STATE_WS_CONNECTING = "WS_CONNECTING"
STATE_WS_ACTIVE = "WS_ACTIVE"
STATE_WS_RECONNECTING = "WS_RECONNECTING"
STATE_WS_DISCONNECTING = "WS_DISCONNECTING"
STATE_TICK_COLLECTION = "TICK_COLLECTION"
STATE_TICK_COLLECTION_RUNNING = "TICK_COLLECTION_RUNNING"
STATE_LOGGING_OUT = "LOGGING_OUT"
STATE_LOGGED_OUT = "LOGGED_OUT"
STATE_SESSION_EXPIRED = "SESSION_EXPIRED"
STATE_LOGIN_FAILED = "LOGIN_FAILED"
STATE_MARKET_CLOSED = "MARKET_CLOSED"
STATE_WAITING_FOR_NEXT_TRADING_DAY = "WAITING_FOR_NEXT_TRADING_DAY"
STATE_ERROR = "ERROR"

# Backward-compatible aliases (old vocabulary → current).
STATE_OFFLINE = STATE_STARTING
STATE_PRE_MARKET = STATE_WAITING_FOR_LOGIN
STATE_LOGIN_PENDING = STATE_WAITING_FOR_LOGIN
STATE_WS_START_PENDING = STATE_WAITING_FOR_WS
STATE_WS_STOP_PENDING = STATE_WS_DISCONNECTING
STATE_LOGOUT_PENDING = STATE_LOGGING_OUT

# ---------------------------------------------------------------------------
# Trading-day phases (Scheduler Engine #01 spec §3 / §17)
#
# The lifecycle *state* above describes the connection machinery (login, feed,
# collection). The *phase* describes WHERE we are inside the trading day:
#
#     08:55–09:00 READINESS  (ensure all engines are up)
#     09:00–09:05 PRE_MARKET
#     09:05–09:10 LIMIT_ORDER_WINDOW
#     09:10–09:12 EQUILIBRIUM
#     09:12–09:15 BUFFER
#     09:15–15:16 LIVE_FEED
#     15:16–15:30 SQUARE_OFF
#     15:30–15:31 FEED_STOPPING
#     15:31–16:00 WEBSOCKET_STOPPING
#     16:00       LOGOUT → DAY_COMPLETE
#
# The phase is recomputed from the IST clock on every reconcile tick, so it is
# time-authoritative and idempotent: a restart converges to the correct phase
# without replaying history.
# ---------------------------------------------------------------------------
PHASE_CLOSED = "CLOSED"
PHASE_READINESS = "READINESS"
PHASE_PRE_MARKET = "PRE_MARKET"
PHASE_LIMIT_ORDER_WINDOW = "LIMIT_ORDER_WINDOW"
PHASE_EQUILIBRIUM = "EQUILIBRIUM"
PHASE_BUFFER = "BUFFER"
PHASE_LIVE_FEED = "LIVE_FEED"
PHASE_SQUARE_OFF = "SQUARE_OFF"
PHASE_FEED_STOPPING = "FEED_STOPPING"
PHASE_WEBSOCKET_STOPPING = "WEBSOCKET_STOPPING"
PHASE_LOGOUT = "LOGOUT"
PHASE_DAY_COMPLETE = "DAY_COMPLETE"

# Ordered phase boundaries: (phase_name, key in ``_sched_times()``).
_PHASE_ORDER = [
    (PHASE_READINESS, "ws_start"),
    (PHASE_PRE_MARKET, "pre_market"),
    (PHASE_LIMIT_ORDER_WINDOW, "limit_order"),
    (PHASE_EQUILIBRIUM, "equilibrium"),
    (PHASE_BUFFER, "buffer"),
    (PHASE_LIVE_FEED, "feed_start"),
    (PHASE_SQUARE_OFF, "square_off"),
    (PHASE_FEED_STOPPING, "feed_stop"),
    (PHASE_WEBSOCKET_STOPPING, "ws_stop"),
    (PHASE_LOGOUT, "logout"),
]

# Phase-entry events for the *non-action* phases. Action phases (square-off,
# feed stop, WebSocket stop, logout) emit their own trigger events from the
# idempotent trigger methods so an event is never emitted twice.
_PHASE_ENTRY_EVENTS = {
    PHASE_PRE_MARKET: "PRE_MARKET_STARTED",
    PHASE_LIMIT_ORDER_WINDOW: "LIMIT_ORDER_WINDOW_STARTED",
    PHASE_EQUILIBRIUM: "EQUILIBRIUM_STARTED",
    PHASE_BUFFER: "BUFFER_STARTED",
    PHASE_LIVE_FEED: "LIVE_FEED_STARTED",
}

# States that still admit login/feed retries without spamming events.
_RETRY_STATES = {STATE_WAITING_FOR_LOGIN, STATE_LOGIN_FAILED}

# Bounded operation timeouts — never wait forever (works with #21/#22).
_LOGIN_TIMEOUT = 30.0            # broker login (TOTP + MPIN) max wait
_INSTRUMENT_CACHE_TIMEOUT = 45.0  # scrip-master CSV download max wait
_WS_BACKOFF_CAP = 60.0


def _is_weekday(dt: datetime) -> bool:
    return dt.date().weekday() < 5


def _is_holiday(dt: datetime) -> bool:
    return market_calendar.is_trading_day(dt.date()) is False and _is_weekday(dt)


def _is_trading_day(dt: datetime | None = None) -> bool:
    dt = dt or _now_ist()
    return market_calendar.is_trading_day(dt.date())


def _now_ist() -> datetime:
    if _TEST_CLOCK is not None:
        return _TEST_CLOCK()
    return datetime.now(IST)


# ---------------------------------------------------------------------------
# Configurable market timezone + trading-day interpretation (REAL settings)
# ---------------------------------------------------------------------------
# `sched_market_timezone` and `sched_trading_day_behavior` are live consumed
# here: every decision site below uses the MARKET-zone instant and the
# configured day interpretation, so editing either in the settings UI
# re-shapes the lifecycle within one reconcile tick (also on save, the
# settings service wakes this controller). With the default `Asia/Kolkata` +
# `trading_days` the resolution is identical to previous hardcoded behaviour —
# only non-default values change what the machine does.
try:
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover — zoneinfo is stdlib on 3.9+
    ZoneInfo = None  # type: ignore[assignment]

_MARKET_TZ_DEFAULT = "Asia/Kolkata"
_TZ_CACHE: dict[str, Any] = {}
_TZ_LOCK = threading.Lock()


def _market_tz():
    """Resolve the configured IANA market timezone (cached); invalid values
    fall back to IST so a typo can never stall the lifecycle."""
    name = _configured_market_tzname()
    with _TZ_LOCK:
        cached = _TZ_CACHE.get(name)
    if cached is not None:
        return cached
    tz = None
    if ZoneInfo is not None:
        try:
            tz = ZoneInfo(name)
        except Exception:
            tz = None
    if tz is None:
        tz = IST
        logger.warning("sched_market_timezone=%r is not a valid IANA zone — using Asia/Kolkata", name)
    with _TZ_LOCK:
        _TZ_CACHE[name] = tz
    return tz


def _configured_market_tzname() -> str:
    raw = get_runtime_setting("sched_market_timezone")
    value = str(raw).strip() if raw is not None else ""
    return value or _MARKET_TZ_DEFAULT


def _now_market() -> datetime:
    """Decision clock — the wall clock IN the configured market timezone.

    Identical to _now_ist() when the market timezone is Asia/Kolkata (the
    shipped default), so tests and default behaviour are unchanged.
    """
    if _TEST_CLOCK is not None:
        return _TEST_CLOCK().astimezone(_market_tz())
    return datetime.now(_market_tz())


_TRADING_DAY_BEHAVIORS = ("trading_days", "weekdays", "calendar_days")


def _market_tz_label() -> str:
    """The configured market zone as a display label, e.g. 'Asia/Kolkata (IST, +05:30)'."""
    name = _configured_market_tzname()
    try:
        tz = _market_tz()
        stamp = datetime.now(tz)
        offset = stamp.strftime("%z")
        pretty = stamp.strftime("%Z") or name
        return f"{name} ({pretty}, {offset[:3]}:{offset[3:] or '00'})"
    except Exception:
        return name


def _trading_day_behavior() -> str:
    raw = get_runtime_setting("sched_trading_day_behavior")
    value = str(raw).strip().lower() if raw is not None else ""
    return value if value in _TRADING_DAY_BEHAVIORS else "trading_days"


def _effective_trading_day(now: datetime) -> bool:
    """Interpret the calendar for the configured behaviour:

    * ``trading_days``  — real NSE calendar + weekend/holiday closures (default)
    * ``weekdays``      — Mon..Fri run regardless of exchange holidays
    * ``calendar_days`` — every single day runs (paper / soak testing)
    """
    behavior = _trading_day_behavior()
    if behavior == "calendar_days":
        return True
    if behavior == "weekdays":
        return _is_weekday(now)
    return _is_trading_day(now)


def _next_effective_trading_day(day) -> datetime.date | None:
    """Next date whose run is admitted under the configured behaviour."""
    behavior = _trading_day_behavior()
    d = day + timedelta(days=1)
    for _ in range(366):
        sched_day = datetime.combine(d, datetime.min.time(), tzinfo=IST)
        if _effective_trading_day(sched_day):
            return d
        d += timedelta(days=1)
    return None


def _validation_issues(times: dict[str, tuple[int, int]]) -> list[dict]:
    """Cross-key schedule validation from the REAL configured values.

    The lifecycle order is fixed (login → ws → tick → phases → square-off →
    feed stop → ws stop → logout). Consecutive events may share a value
    (warn — the later phase still gates correctly, but the window collapses);
    any inversion is an error because that phase can never fire.
    """
    chain = [
        ("login", "ws_start"),
        ("ws_start", "tick_collection_start"),
        ("tick_collection_start", "pre_market"),
        ("pre_market", "limit_order"),
        ("limit_order", "equilibrium"),
        ("equilibrium", "buffer"),
        ("buffer", "feed_start"),
        ("feed_start", "square_off"),
        ("square_off", "feed_stop"),
        ("feed_stop", "ws_stop"),
        ("ws_stop", "logout"),
    ]
    labels = {
        "login": "Login", "ws_start": "WS Connect",
        "tick_collection_start": "Tick collection", "pre_market": "Pre-market",
        "limit_order": "Limit-order window", "equilibrium": "Equilibrium",
        "buffer": "Buffer", "feed_start": "Live feed", "square_off": "Square-off",
        "feed_stop": "Feed stop", "ws_stop": "WS Disconnect", "logout": "Logout",
    }
    issues: list[dict] = []
    seen: set[tuple[int, int]] = set()
    for first, second in chain:
        a, b = times.get(first), times.get(second)
        if not a or not b:
            continue
        if a < b:
            continue
        severity = "warn" if a == b else "error"
        message = (
            f"{labels[first]} ({a[0]:02d}:{a[1]:02d}) {labels[second]} ({b[0]:02d}:{b[1]:02d}) se"
            + (" same hai — window collapse ho gaya hai" if a == b else " pehle ho raha hai — "
               "ye phase kabhi fire nahi hoga")
        )
        issues.append({
            "code": "ORDERING" if a > b else "WINDOW_COLLAPSE",
            "severity": severity,
            "first_key": first,
            "second_key": second,
            "first": f"{a[0]:02d}:{a[1]:02d}",
            "second": f"{b[0]:02d}:{b[1]:02d}",
            "message": message,
        })
        if a > b:
            seen.add((a[0] * 60 + a[1], b[0] * 60 + b[1]))  # keep shape stable
    return issues


# ---------------------------------------------------------------------------
# Multi-broker enablement (spec: independent simultaneous broker lifecycles)
# ---------------------------------------------------------------------------
def _broker_enabled(broker: str) -> bool:
    try:
        from brokers.selection import is_broker_enabled
        return bool(is_broker_enabled(broker))
    except Exception:
        return False


def _enabled_brokers_now() -> tuple[str, ...]:
    """Ordered tuple of brokers the scheduler drives this tick.

    Kotak is the legacy default (always driven unless KOTAK_ENABLED=false);
    Shoonya only when the adapter is enabled. Dummy is never scheduled.
    Regression-safe: an enablement resolution failure falls back to kotak-only,
    which is exactly today's behaviour.
    """
    try:
        from brokers.selection import enabled_brokers
        enabled = enabled_brokers()
        if not enabled:
            return ("kotak",)
        return tuple(b for b in enabled if _broker_enabled(b)) or ("kotak",)
    except Exception:
        return ("kotak",)


def _scheduled_feed_is_dummy() -> bool:
    """True only when the scheduler's OWN feed broker is the paper engine.

    The ACTIVE TRADING TERMINAL is deliberately NOT consulted here. Terminal
    selection decides which broker receives ORDERS; the schedule decides which
    broker provides LOGIN + SESSION + WEBSOCKET + DATA SAVER. Dummy is never a
    scheduled feed broker (``brokers.selection.enabled_brokers`` excludes it),
    and the paper engine is explicitly allowed to consume Kotak Neo market data.

    Conflating the two is what parked the whole lifecycle: with the terminal on
    "dummy" the scheduler refused to log in, so the feed could never come up and
    ``do_login`` reported success without logging in at all.
    """
    enabled = _enabled_brokers_now()
    return bool(enabled) and all(b == "dummy" for b in enabled)


def _shoonya_active() -> bool:
    try:
        from brokers.shoonya_adapter import shoonya_adapter
        return bool(shoonya_adapter.is_logged_in)
    except Exception:
        return False


def _shoonya_ws_connected() -> bool:
    try:
        rec = session_manager.terminal_session("shoonya")
        return (rec or {}).get("connection_status") == "CONNECTED"
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Test-only clock seam (never used in production).
# Lets tests drive the state machine with a simulated IST clock so every
# lifecycle transition (08:25 WS prep / 08:50 login / 15:31 WS stop / 16:00
# logout, weekend + holiday closures, manual-session expiry) can be asserted
# without waiting for the real calendar.
# ---------------------------------------------------------------------------
_TEST_CLOCK = None


def _set_test_clock(clock_fn=None):
    """Inject a callable returning an IST-aware datetime; ``None`` restores."""
    global _TEST_CLOCK
    _TEST_CLOCK = clock_fn


def _next_occurrence(now: datetime, hour: int, minute: int) -> datetime:
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return target


def _day_at(d: datetime | datetime.date, hour: int, minute: int) -> datetime:
    if isinstance(d, datetime):
        d = d.date()
    return datetime.combine(d, datetime.min.time().replace(hour=hour, minute=minute), tzinfo=_market_tz())


def _login_backoff(attempt: int) -> float:
    return min(2 ** min(max(attempt, 1), 6), 300.0)


def _ws_backoff(attempt: int) -> float:
    return min(2 ** min(max(attempt, 1), 6), _WS_BACKOFF_CAP)


def _active_mode_name() -> str:
    # The mode identity belongs to the broker manager's active terminal — the
    # env default is only a fallback. This prevents a successful scheduler
    # login from overwriting the central mode to "kotak" (or any env default)
    # when the user actually selected dummy/live terminal elsewhere.
    try:
        from brokers.manager import active_terminal
        term = active_terminal()
        if term in {"kotak", "shoonya", "dummy"}:
            return term
    except Exception:
        pass
    mode = (settings.broker_mode or "kotak").lower()
    return mode if mode in {"kotak", "shoonya", "dummy"} else "kotak"


def _sched_times() -> dict[str, tuple[int, int]]:
    """Resolved session window from LIVE DB settings (fallback: env config).

    The scheduler owns the session lifecycle, so it also owns the application
    of `sched_*` settings: every reconcile tick re-reads the TTL cache (see
    ``services.runtime_settings``), meaning time edits and the sched_enabled
    toggle take effect within a few seconds, without a backend restart.
    """
    return {
        "login": rt_hhmm("sched_login_time", settings.login_hour, settings.login_minute),
        "logout": rt_hhmm("sched_logout_time", settings.logout_hour, settings.logout_minute),
        "ws_start": rt_hhmm("sched_ws_start_time", settings.ws_start_hour, settings.ws_start_minute),
        "tick_collection_start": rt_hhmm("sched_tick_collection_start_time", settings.tick_collection_hour, settings.tick_collection_minute),
        "ws_stop": rt_hhmm("sched_ws_stop_time", settings.ws_stop_hour, settings.ws_stop_minute),
        # Trading-day phase boundaries (Engine #01). Every one is independently
        # configurable and applied live (LIVE_KEYS), so the phase machine never
        # depends on hardcoded times.
        "pre_market": rt_hhmm("sched_pre_market_start_time", settings.pre_market_hour, settings.pre_market_minute),
        "limit_order": rt_hhmm("sched_limit_order_start_time", settings.limit_order_hour, settings.limit_order_minute),
        "equilibrium": rt_hhmm("sched_equilibrium_start_time", settings.equilibrium_hour, settings.equilibrium_minute),
        "buffer": rt_hhmm("sched_buffer_start_time", settings.buffer_hour, settings.buffer_minute),
        "feed_start": rt_hhmm("sched_feed_start_time", settings.feed_start_hour, settings.feed_start_minute),
        "square_off": rt_hhmm("sched_square_off_time", settings.square_off_hour, settings.square_off_minute),
        "feed_stop": rt_hhmm("sched_feed_stop_time", settings.feed_stop_hour, settings.feed_stop_minute),
        # Market Watch Friday scan (weekly universe refresh). One key, shared
        # with the engine, so the ledger and the scanner cannot drift apart.
        "market_watch_friday_scan": rt_hhmm("mwr_friday_scan_hhmm", 15, 25),
    }


def _trading_phase(now: datetime, times: dict, trading_day: bool) -> str:
    """Resolve the current trading-day phase (pure; time-authoritative).

    The same IST instant always yields the same phase, so a restart converges
    to the correct phase without replaying past transitions. Missing timing
    keys are tolerated (callers/tests may pass a reduced schedule).
    """
    if not trading_day:
        return PHASE_CLOSED
    login_at = _today_at(now, *times["login"])
    if now < login_at:
        return PHASE_CLOSED
    current = PHASE_READINESS
    for phase, key in _PHASE_ORDER:
        hhmm = times.get(key)
        if hhmm is None:
            continue
        if now >= _today_at(now, hhmm[0], hhmm[1]):
            current = phase
        else:
            break
    if now >= _today_at(now, *times["logout"]):
        current = PHASE_DAY_COMPLETE
    return current


class SchedulerController:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        # Guards the actual login/logout execution (defensive; all callers
        # are on the app loop, but login/logout must never interleave).
        self._exec_lock = threading.Lock()
        # Serialises reconcile ticks (asyncio-driven, one reconcile at a time).
        self._busy_lock: asyncio.Lock | None = None

        self._running = False
        self._state = STATE_STARTING
        self._state_since: float | None = None
        self._session_owner: str | None = None

        self._manual_expire_at: float | None = None

        self._login_attempts = 0
        self._login_error: str | None = None
        self._next_login_attempt_at = 0.0

        self._ws_attempts = 0
        self._ws_error: str | None = None
        self._next_ws_attempt_at = 0.0
        # True once this session-day's tick collection has started (08:59).
        self._tick_collection_started = False

        # Daily full-market subscription intent (doc §5/§14): idempotency marks
        # so the current-day eligible universe is applied ONCE per trading day,
        # BEFORE the WebSocket supervisor subscribes, and the engine reconcile
        # runs once per day over the real WS connection.
        self._daily_intent_applied_date: str = ""
        self._engine_daily_reconcile_date: str = ""
        # Daily positions sweep mark: the 08:50 rollover settles prior-date demo
        # intraday opens and drops cached broker positions, once per trading date.
        self._positions_rollover_date: str = ""

        self._supervisor_task: asyncio.Task | None = None
        self._quality_task: asyncio.Task | None = None
        self._tick_seconds = 5.0
        # Wake signal for the supervisor loop: set after startup / manual
        # requests so the very first reconciliation happens immediately instead
        # of waiting for the next 5s tick (current-time reconciliation on boot).
        self._wake_event: asyncio.Event | None = None

        # Cached scheduler-run ledger values, refreshed every reconcile tick so
        # synchronous info endpoints (get_scheduler_info etc.) never block.
        self._ledger_cache: dict = {}
        self._ledger_today_statuses: dict[str, str] = {}

        # Trading-day phase machine (Engine #01).
        self._phase = PHASE_CLOSED
        self._phase_since: float | None = time.time()
        # Idempotency flags for the daily phase triggers. The ledger records the
        # persisted outcome, so a restart never re-fires a completed trigger
        # (missed-event recovery, spec §19/§20).
        self._square_off_triggered = False
        self._square_off_completed = False
        self._feed_stop_triggered = False
        self._ws_stop_event_fired = False
        self._logout_event_fired = False
        self._day_complete_fired = False
        # Readiness report cache (spec §6) — refreshed every reconcile tick.
        self._ready_overall: str | None = None
        self._ready_report: dict = {
            "overall": None, "applicable": False, "checks": [], "as_of": None,
        }
        # Last observed reconcile decision (dedupe for structured lifecycle logs).
        self._last_lifecycle_key: str | None = None

        # Multi-broker orchestration: per-broker lifecycle report + enablement.
        # ``_brokers_report`` is refreshed every reconcile tick so synchronous
        # API endpoints can render per-broker lifecycle cards without a lock.
        self._brokers_report: dict[str, dict] = {}
        self._enabled_brokers: tuple[str, ...] = ()
        self._shoonya_driver: Any = None
        self._startup_events_fired = False
        self._broker_frames: dict[str, str] = {}

    # ------------------------------------------------------------------
    # Public lifecycle
    # ------------------------------------------------------------------

    def start_scheduler(self) -> None:
        with self._lock:
            if self._running:
                return
            self._running = True
            self._state = STATE_STARTING
            self._state_since = time.time()
        try:
            loop = get_loop()
        except RuntimeError:
            logger.error("Scheduler cannot start: application event loop not ready")
            with self._lock:
                self._running = False
            return
        loop.call_soon_threadsafe(self._launch_supervisor)
        import os as _os
        record_event("scheduler", "SCHEDULER_STARTED", "info", "Scheduler started")
        logger.info("[SCHEDULER] instance=%s started", _os.getpid())
        try:
            _cal = market_calendar.snapshot()
            if _cal.get("day_class") == "WEEKEND":
                logger.info("WAITING_MARKET weekend — next market open is %s",
                            _cal.get("next_market_open") or "unknown")
        except Exception as _cal_exc:
            logger.debug("WAITING_MARKET classification unavailable: %s", _cal_exc)
        # Wake immediately to classify today (startup report path).
        self.request_reconcile()

    def stop_scheduler(self) -> None:
        with self._lock:
            self._running = False
            task = self._supervisor_task
            qtask = self._quality_task
        try:
            loop = get_loop()
            if task is not None:
                loop.call_soon_threadsafe(self._cancel_supervisor)
                # Deterministic teardown: close the feed on the app loop after
                # the supervisor stops, so no socket thread is left behind.
                loop.call_soon_threadsafe(self._schedule_final_ws_teardown)
            if qtask is not None:
                loop.call_soon_threadsafe(self._cancel_quality)
        except RuntimeError:
            pass

    def _cancel_quality(self) -> None:
        task = self._quality_task
        if task is not None and not task.done():
            task.cancel()
        self._set_state(STATE_LOGGED_OUT, "scheduler stopped")
        record_event("scheduler", "SCHEDULER_STOPPED", "info", "Scheduler stopped")
        logger.info("Scheduler stopped")

    def _schedule_final_ws_teardown(self) -> None:
        try:
            ws_manager.stop_supervisor()
            ws_manager.disconnect(why="application_shutdown")
        except Exception:
            logger.exception("WebSocket disconnect during scheduler stop failed")

    def request_reconcile(self) -> None:
        """Ask the supervisor to re-evaluate as soon as possible."""
        if self._is_running():
            try:
                loop = get_loop()
                if loop.is_running():
                    loop.call_soon_threadsafe(self._wake_supervisor)
            except RuntimeError:
                pass

    def notify_auth_failure(self) -> None:
        """WebSocket detected an auth/session expiry — schedule a re-login."""
        logger.warning("Scheduler notified of auth failure; scheduling re-login")
        # Only a dummy SCHEDULED feed suppresses recovery; a Dummy trading
        # terminal must not leave an expired broker session stranded.
        if _scheduled_feed_is_dummy():
            logger.info("Scheduler auth-failure re-login skipped: scheduled feed is the dummy engine")
            return
        kotak_session.mark_session_expired(reason="ws_auth_failure")
        with self._lock:
            self._login_attempts = 0
            self._login_error = None
            self._next_login_attempt_at = 0.0
        self.request_reconcile()

    # ------------------------------------------------------------------
    # Login / logout
    # ------------------------------------------------------------------

    async def do_login(self, source: str = "scheduler", retry: int = 3) -> bool:
        if source not in {"scheduler", "manual"}:
            logger.error("Invalid login source: %s", source)
            return False

        # Only a dummy SCHEDULED feed skips the real login. Previously this
        # returned True while doing nothing, which published a fake
        # "session active" while the broker was never contacted.
        if _scheduled_feed_is_dummy():
            logger.info("Login skipped: scheduled feed is the dummy engine")
            return True

        # No duplicate logins: one central session. If a usable session
        # already exists, return its state instead of logging in again (#7).
        if kotak_session.session_active and self._session_owner is not None:
            logger.info("Login skipped: session already active (owner=%s)", self._session_owner)
            _sync_session_manager_view(self._session_owner)
            return True

        if source == "manual" and self._session_owner == "scheduler":
            logger.info("Manual login blocked: scheduler session lives")
            _sync_session_manager_view("scheduler")
            return True

        ok = False
        last_error: str | None = None
        with self._exec_lock:
            for attempt in range(retry):
                self._set_state(STATE_LOGGING_IN, "login attempt", source=source)
                try:
                    ok = await self._do_login_impl(source)
                    last_error = None
                    break
                except Exception as exc:
                    last_error = str(exc)
                    logger.error("Login attempt %d failed: %s", attempt + 1, exc)
                    if attempt < retry - 1:
                        await asyncio.sleep(2 ** attempt)

        with self._lock:
            if ok:
                self._login_attempts = 0
                self._login_error = None
                if source == "manual":
                    self._manual_expire_at = time.time() + MANUAL_SESSION_SECONDS
            else:
                self._login_attempts = retry
                self._login_error = last_error
                self._next_login_attempt_at = time.time() + _login_backoff(retry)
                self._set_state(STATE_LOGIN_FAILED, last_error or "login failed")
                return False

        if source == "manual":
            logger.info(
                "Manual session started; auto-logout in %d minutes",
                MANUAL_SESSION_SECONDS // 60,
            )
            record_event(
                "scheduler", "manual_session", "info",
                f"Manual session started (auto-logout in {MANUAL_SESSION_SECONDS // 60} minutes)",
            )

        # Fast-forward the state machine so the feed starts immediately when
        # the login happens inside the WebSocket window.
        await self._reconcile()
        return True

    async def do_logout(self, source: str | None = None) -> bool:
        if source == "manual":
            reason = "manual_logout"
        elif source == "system":
            reason = "application_shutdown"
        else:
            reason = "scheduled_logout"
        if source == "manual" and self._session_owner != "manual":
            logger.info("Manual logout skipped: session owner is %s", self._session_owner)
            return True
        busy = self._busy_lock
        if busy is None:
            await self._logout_current(reason)
        else:
            async with busy:
                await self._logout_current(reason)
        return True

    # ------------------------------------------------------------------
    # Info / status / schedule
    # ------------------------------------------------------------------

    def get_scheduler_info(self) -> dict:
        now = _now_market()
        slot = self._market_slot(now)
        sched = self.get_schedule()
        market_state_snap = market_state_service.get_snapshot()
        times = _sched_times()
        login_h, login_m = times["login"]
        logout_h, logout_m = times["logout"]
        ws_start_h, ws_start_m = times["ws_start"]
        tick_h, tick_m = times["tick_collection_start"]
        ws_stop_h, ws_stop_m = times["ws_stop"]
        with self._lock:
            state = self._state
            owner = self._session_owner
            phase = self._phase
            phase_since = self._phase_since
        phase_since_iso = (
            datetime.fromtimestamp(phase_since, tz=IST).isoformat()
            if phase_since is not None else None
        )
        return {
            "running": self._is_running(),
            "enabled": rt_bool("sched_enabled", True),
            "state": state,
            "phase": phase,
            "phase_since": phase_since_iso,
            "next_phase": sched.get("next_phase"),
            "next_phase_at": sched.get("next_phase_at"),
            "phases": sched.get("phases"),
            "readiness": self.readiness_snapshot(),
            "session_owner": owner,
            "login_time": f"{login_h:02d}:{login_m:02d}",
            "tick_collection_time": f"{tick_h:02d}:{tick_m:02d}",
            "logout_time": f"{logout_h:02d}:{logout_m:02d}",
            "ws_start_time": f"{ws_start_h:02d}:{ws_start_m:02d}",
            "ws_stop_time": f"{ws_stop_h:02d}:{ws_stop_m:02d}",
            "is_trading_day": slot["trading_day"],
            "in_tick_collection_window": slot["in_tick_collection_window"],
            "market_status": market_calendar.market_status(now),
            "market_session": market_calendar.market_session(now),
            "session_active": kotak_session.session_active,
            "websocket_connected": ws_manager.is_connected(),
            "next_login": sched["next_login_time"],
            "next_tick_collection": sched["next_tick_collection_time"],
            "next_logout": sched["next_logout_time"],
            "next_ws_start": sched["next_ws_connect_time"],
            "next_ws_stop": sched["next_ws_disconnect_time"],
            "schedule": sched,
            # Market state service data
            "market_state": market_state_snap.get("market_state"),
            "market_reason_code": market_state_snap.get("reason_code"),
            "market_reason_message": market_state_snap.get("reason_message"),
            "market_state_source": market_state_snap.get("source"),
            "confirmation_window_active": market_state_snap.get("confirmation_window_active"),
            "ticks_in_window": market_state_snap.get("ticks_received_in_window"),
            "unique_instruments_in_window": market_state_snap.get("unique_instruments_with_ticks"),
            # Persistent scheduler-run ledger (real values; refreshed each tick)
            "ledger": self._ledger_cache,
            "ledger_jobs_today": self._ledger_today_statuses,
            # Multi-broker orchestration (independent simultaneous lifecycles)
            "enabled_brokers": list(self._enabled_brokers),
            "brokers": self.broker_reports(),
        }

    def get_scheduler_state(self) -> dict:
        now = _now_market()
        slot = self._market_slot(now)
        sched = self.get_schedule()
        times = _sched_times()
        login_h, login_m = times["login"]
        logout_h, logout_m = times["logout"]
        ws_start_h, ws_start_m = times["ws_start"]
        tick_h, tick_m = times["tick_collection_start"]
        ws_stop_h, ws_stop_m = times["ws_stop"]
        with self._lock:
            state = self._state
            state_since = self._state_since
            owner = self._session_owner
            phase = self._phase
            phase_since = self._phase_since
            login_attempts = self._login_attempts
            login_error = self._login_error
            ws_attempts = self._ws_attempts
            ws_error = self._ws_error
            manual_expire_at = self._manual_expire_at
            in_login_window = slot["in_login_window"]
            in_ws_window = slot["in_ws_window"]
            in_tick_collection_window = slot["in_tick_collection_window"]
        # Windows are only meaningful on a real trading day; otherwise they are
        # "not applicable" (never a confusing "open" on a weekend).
        trading_day = slot["trading_day"]
        state_since_iso = (
            datetime.fromtimestamp(state_since, tz=IST).isoformat()
            if state_since is not None
            else None
        )
        phase_since_iso = (
            datetime.fromtimestamp(phase_since, tz=IST).isoformat()
            if phase_since is not None
            else None
        )
        manual_expire_iso = (
            datetime.fromtimestamp(manual_expire_at, tz=IST).isoformat()
            if manual_expire_at is not None
            else None
        )
        return {
            "state": state,
            "state_since": state_since_iso,
            "phase": phase,
            "phase_since": phase_since_iso,
            "next_phase": sched.get("next_phase"),
            "next_phase_at": sched.get("next_phase_at"),
            "phases": sched.get("phases"),
            "readiness": self.readiness_snapshot(),
            "session_owner": owner,
            "login_attempts": login_attempts,
            "login_error": login_error,
            "ws_attempts": ws_attempts,
            "ws_error": ws_error,
            "is_trading_day": slot["trading_day"],
            "in_login_window": in_login_window,
            "in_ws_window": in_ws_window,
            "in_tick_collection_window": in_tick_collection_window,
            "login_window_applicable": trading_day,
            "ws_window_applicable": trading_day,
            "login_time": f"{login_h:02d}:{login_m:02d}",
            "tick_collection_time": f"{tick_h:02d}:{tick_m:02d}",
            "logout_time": f"{logout_h:02d}:{logout_m:02d}",
            "ws_start_time": f"{ws_start_h:02d}:{ws_start_m:02d}",
            "ws_stop_time": f"{ws_stop_h:02d}:{ws_stop_m:02d}",
            "next_login": sched["next_login_time"],
            "next_tick_collection": sched["next_tick_collection_time"],
            "next_logout": sched["next_logout_time"],
            "next_ws_start": sched["next_ws_connect_time"],
            "next_ws_stop": sched["next_ws_disconnect_time"],
            "next_event": sched["next_event"],
            "next_event_at": sched["next_event_at"],
            "remaining_seconds": sched["remaining_seconds"],
            "manual_expire_at": manual_expire_iso,
            "schedule": sched,
            "ledger": self._ledger_cache,
            "ledger_jobs_today": self._ledger_today_statuses,
            "enabled_brokers": list(self._enabled_brokers),
            "brokers": self.broker_reports(),
        }

    async def get_scheduler_summary(self) -> dict:
        """Authoritative today's-scheduler summary (Phase 22 / 53).

        Every value flows from the persisted ledger + the server-side IST clock
        + the real trading calendar + the real session/feed/market state. The
        frontend only reads this; it never computes or fabricates state.
        """
        now = _now_market()
        today_iso = now.date().isoformat()
        try:
            business_date = today_iso
            ledger = self._ledger_cache
            # Force a fresh persisted read for the calling request so the
            # response always reflects committed MongoDB records (Phase 20).
            ledger = await scheduler_ledger.summary(business_date=business_date)
            executions = await scheduler_ledger.executions(business_date=business_date)
        except Exception:
            logger.exception("Scheduler summary ledger read failed")
            ledger = self._ledger_cache or {}
            executions = []

        sched = self.get_schedule()
        slot = self._market_slot(now)
        market_snap = market_state_service.get_snapshot()
        with self._lock:
            state = self._state
            owner = self._session_owner
            phase = self._phase

        # Next event (Phase 24): earliest valid future occurrence strictly after
        # server IST, using the real market calendar (Phase 25). Falls back to
        # the next trading day when today's lifecycle has finished.
        next_event = None
        if sched.get("next_event") and sched.get("next_event_at"):
            next_event = {
                "event": sched["next_event"],
                "at_ist": sched["next_event_at"],
                "remaining_seconds": sched.get("remaining_seconds"),
            }

        return {
            "current_time_ist": now.isoformat(),
            "market_date": today_iso,
            "current_trading_day": today_iso,
            "next_trading_day": sched.get("next_trading_day"),
            "scheduler_state": "RUNNING" if self._is_running() else "STOPPED",
            "scheduler_runtime_state": state,
            "phase": phase,
            "next_phase": sched.get("next_phase"),
            "next_phase_at": sched.get("next_phase_at"),
            "readiness": self.readiness_snapshot(),
            "session_owner": owner,
            "business_date": business_date,
            "market_state": market_snap.get("market_state") or "",
            "is_trading_day": slot["trading_day"],
            "session_active": kotak_session.session_active,
            "websocket_connected": ws_manager.is_connected(),
            "today": ledger.get("today") or {},
            "last_event": ledger.get("last_event"),
            "next_event": next_event,
            "next_event_at": (sched.get("next_event_at") or None),
            # Documented contract: today's lifecycle instants + live snapshots.
            "login": sched.get("today_login_time"),
            "tick_collection": sched.get("today_tick_collection_time"),
            "websocket_connect": sched.get("today_ws_connect_time"),
            "websocket_disconnect": sched.get("today_ws_disconnect_time"),
            "logout": sched.get("today_logout_time"),
            "session": {
                "active": kotak_session.session_active,
                "owner": owner,
                "last_login_at": _sched_iso(kotak_session.last_login_at)
                                 if getattr(kotak_session, "last_login_at", None) else None,
                "last_logout_at": _sched_iso(kotak_session.last_logout_at)
                                  if getattr(kotak_session, "last_logout_at", None) else None,
            },
            # Authoritative central-session snapshot (Session Manager = owner).
            "session_manager": self._safe_session_snapshot(),
            "websocket": {
                "connected": ws_manager.is_connected(),
            },
            "day_schedule": {
                "login": sched.get("today_login_time"),
                "tick_collection": sched.get("today_tick_collection_time"),
                "ws_connect": sched.get("today_ws_connect_time"),
                "ws_disconnect": sched.get("today_ws_disconnect_time"),
                "logout": sched.get("today_logout_time"),
                "trading_day": sched.get("today_trading_day"),
            },
            "executions": executions,
            "enabled_brokers": list(self._enabled_brokers),
            "brokers": self.broker_reports(),
            "timezone": "Asia/Kolkata",
        }

    def get_schedule(self) -> dict:
        """Next-event snapshot (#14). Backend is the source of truth — no
        frontend countdowns."""
        now = _now_market()
        today = now.date()
        now_str = now.strftime("%H:%M")
        times = _sched_times()
        login_t, logout_t, ws_start_t, tick_t, ws_stop_t = (
            times["login"], times["logout"], times["ws_start"],
            times["tick_collection_start"], times["ws_stop"],
        )
        pre_t, lim_t, equ_t, buf_t, feed_t, sq_t, fstop_t = (
            times["pre_market"], times["limit_order"], times["equilibrium"],
            times["buffer"], times["feed_start"], times["square_off"],
            times["feed_stop"],
        )
        def build(d: datetime.date) -> dict:
            return {
                "login": _day_at(d, login_t[0], login_t[1]),
                "ws_connect": _day_at(d, ws_start_t[0], ws_start_t[1]),
                "tick_collection_start": _day_at(d, tick_t[0], tick_t[1]),
                "ws_disconnect": _day_at(d, ws_stop_t[0], ws_stop_t[1]),
                "logout": _day_at(d, logout_t[0], logout_t[1]),
            }

        def build_phase_times(d: datetime.date) -> dict:
            return {
                "readiness": _day_at(d, ws_start_t[0], ws_start_t[1]),
                "pre_market": _day_at(d, pre_t[0], pre_t[1]),
                "limit_order": _day_at(d, lim_t[0], lim_t[1]),
                "equilibrium": _day_at(d, equ_t[0], equ_t[1]),
                "buffer": _day_at(d, buf_t[0], buf_t[1]),
                "live_feed": _day_at(d, feed_t[0], feed_t[1]),
                "square_off": _day_at(d, sq_t[0], sq_t[1]),
                "feed_stop": _day_at(d, fstop_t[0], fstop_t[1]),
                "websocket_close": _day_at(d, ws_stop_t[0], ws_stop_t[1]),
                "logout": _day_at(d, logout_t[0], logout_t[1]),
            }

        today_trading = _effective_trading_day(now)
        today_events = build(today) if today_trading else None

        if today_trading:
            future = [(n, t) for n, t in today_events.items() if t > now]
            if future:
                ref = today
            else:
                ref = _next_effective_trading_day(today) or today
        else:
            ref = _next_effective_trading_day(today) or today

        ref_events = build(ref)
        candidates = [(n, t) for n, t in ref_events.items()]
        if ref == today:
            candidates = [(n, t) for n, t in candidates if t > now]

        def _iso(dt: datetime) -> str | None:
            return dt.isoformat() if dt is not None else None

        next_event = min(candidates, key=lambda x: x[1]) if candidates else None

        # Next phase boundary (spec §25: "Next Event: Square-Off"). Kept
        # separate from ``next_event`` so the existing countdown contract is
        # unchanged while the phase machine gains its own next-transition.
        today_phase_times = build_phase_times(today) if today_trading else None
        phase_ref = build_phase_times(ref)
        if today_trading:
            phase_candidates = [
                (n, t) for n, t in (today_phase_times or {}).items() if t > now
            ]
        else:
            phase_candidates = list(phase_ref.items())
        next_phase = min(phase_candidates, key=lambda x: x[1]) if phase_candidates else None

        issues = _validation_issues(times)
        return {
            "issues": issues,
            "issues_error_count": sum(1 for i in issues if i["severity"] == "error"),
            "issues_warning_count": sum(1 for i in issues if i["severity"] == "warn"),
            "trading_day_behavior": _trading_day_behavior(),
            "market_timezone": _configured_market_tzname(),
            "schedule": {
                "login": f"{login_t[0]:02d}:{login_t[1]:02d}",
                "ws_connect": f"{ws_start_t[0]:02d}:{ws_start_t[1]:02d}",
                "tick_collection_start": f"{tick_t[0]:02d}:{tick_t[1]:02d}",
                "pre_market_start": f"{pre_t[0]:02d}:{pre_t[1]:02d}",
                "limit_order_start": f"{lim_t[0]:02d}:{lim_t[1]:02d}",
                "equilibrium_start": f"{equ_t[0]:02d}:{equ_t[1]:02d}",
                "buffer_start": f"{buf_t[0]:02d}:{buf_t[1]:02d}",
                "feed_start": f"{feed_t[0]:02d}:{feed_t[1]:02d}",
                "square_off": f"{sq_t[0]:02d}:{sq_t[1]:02d}",
                "feed_stop": f"{fstop_t[0]:02d}:{fstop_t[1]:02d}",
                "ws_disconnect": f"{ws_stop_t[0]:02d}:{ws_stop_t[1]:02d}",
                "logout": f"{logout_t[0]:02d}:{logout_t[1]:02d}",
                "timezone": _market_tz_label(),
            },
            "phases": {
                name: dt.isoformat() for name, dt in (today_phase_times or {}).items()
            },
            "today_phase_times": {
                name: _iso(dt) for name, dt in (today_phase_times or {}).items()
            },
            "next_phase": next_phase[0] if next_phase else None,
            "next_phase_at": _iso(next_phase[1]) if next_phase else None,
            "next_phase_remaining_seconds": round(
                (next_phase[1] - now).total_seconds(), 1
            ) if next_phase else None,
            "today_trading_day": today_trading,
            "today_login_time": _iso(today_events["login"]) if today_events else None,
            "today_ws_connect_time": _iso(today_events["ws_connect"]) if today_events else None,
            "today_tick_collection_time": _iso(today_events["tick_collection_start"]) if today_events else None,
            "today_ws_disconnect_time": _iso(today_events["ws_disconnect"]) if today_events else None,
            "today_logout_time": _iso(today_events["logout"]) if today_events else None,
            "next_login_time": _iso(ref_events["login"]),
            "next_ws_connect_time": _iso(ref_events["ws_connect"]),
            "next_tick_collection_time": _iso(ref_events["tick_collection_start"]),
            "next_ws_disconnect_time": _iso(ref_events["ws_disconnect"]),
            "next_logout_time": _iso(ref_events["logout"]),
            "next_trading_day": ref.isoformat(),
            "next_event": next_event[0] if next_event else None,
            "next_event_at": _iso(next_event[1]) if next_event else None,
            "remaining_seconds": round(
                (next_event[1] - now).total_seconds(), 1
            ) if next_event else None,
            "now_ist": now.isoformat(),
            "now_time": now_str,
        }

    # ------------------------------------------------------------------
    # Supervisor loop
    # ------------------------------------------------------------------

    def _is_running(self) -> bool:
        with self._lock:
            return self._running

    def _launch_supervisor(self) -> None:
        if self._supervisor_task is not None and not self._supervisor_task.done():
            return
        self._busy_lock = asyncio.Lock()
        self._wake_event = asyncio.Event()
        task = asyncio.ensure_future(self._supervisor_loop())
        self._supervisor_task = task
        task.add_done_callback(self._on_supervisor_done)
        # Data Quality is DEMAND-DRIVEN: analysis only runs when the Data
        # Quality page is visited (see GET /api/data-quality/summary + POST
        # /api/data-quality/scan). No background scan is launched here, so the
        # backend stays in Quality STANDBY unless a scan is explicitly requested.

    def _launch_quality_task(self) -> None:
        """Dedicated, single periodic Data Quality scan task.

        Runs on its own loop (independent of the tick lifecycle) at the
        configured scanIntervalSeconds. `periodic_scan_if_due` is guarded by
        an internal asyncio lock so exactly one scan runs at a time, and the
        interval is tracked via MongoDB-backed config, so restarting the
        process resumes an accurate schedule.
        """
        try:
            from services.data_quality import periodic_scan_if_due
        except Exception as exc:  # pragma: no cover
            logger.warning("quality scan task unavailable: %s", exc)
            return
        if self._quality_task is not None and not self._quality_task.done():
            return

        async def _quality_loop() -> None:
            # defer the first run until the interval has elapsed since boot
            try:
                from services.data_quality import mark_process_started
                mark_process_started()
            except Exception:
                pass
            first_pause = 60.0
            if getattr(self, "_first_quality_pause", None) is not None:
                first_pause = self._first_quality_pause
            try:
                await asyncio.sleep(first_pause)
            except asyncio.CancelledError:
                return
            while self._is_running():
                try:
                    await periodic_scan_if_due()
                except Exception as exc:  # pragma: no cover
                    logger.exception("periodic quality scan failed: %s", exc)
                await asyncio.sleep(30)

        self._quality_task = asyncio.ensure_future(_quality_loop())

    def _on_supervisor_done(self, task: asyncio.Task) -> None:
        if task.cancelled() or task.exception() is None:
            return
        logger.exception("Scheduler supervisor loop crashed", exc_info=task.exception())
        record_event("scheduler", "supervisor_crash", "error", str(task.exception()))
        # Never leave the system without a state owner: a fresh supervisor is
        # relaunched so the lifecycle keeps driving itself.
        try:
            loop = get_loop()
            if loop.is_running():
                loop.call_soon_threadsafe(self._launch_supervisor)
        except RuntimeError:
            pass

    def _cancel_supervisor(self) -> None:
        task = self._supervisor_task
        if task is not None and not task.done():
            task.cancel()

    def _wake_supervisor(self) -> None:
        ev = self._wake_event
        if ev is not None and not ev.is_set():
            ev.set()

    async def _supervisor_loop(self) -> None:
        while self._is_running():
            try:
                await self._reconcile()
            except Exception as exc:
                logger.exception("Scheduler reconcile failed: %s", exc)
                self._set_state(STATE_ERROR, "reconcile failure")
            # Wake on request_reconcile() (startup / manual), otherwise the
            # regular 5s tick. ``wait_for`` + timeout mirrors the old
            # ``asyncio.sleep(tick)`` while making boots reconcile immediately.
            try:
                await asyncio.wait_for(self._wake_event.wait(),
                                       timeout=self._tick_seconds)
            except asyncio.TimeoutError:
                pass
            finally:
                if self._wake_event.is_set():
                    self._wake_event.clear()

    async def _reconcile(self) -> None:
        if not self._is_running():
            return
        busy = self._busy_lock
        if busy is None:
            return
        if busy.locked():
            return
        async with busy:
            try:
                await self._reconcile_unlocked()
            except Exception as exc:
                logger.exception("Scheduler reconcile error: %s", exc)
                self._set_state(STATE_ERROR, str(exc))

    # ------------------------------------------------------------------
    # State machine core
    # ------------------------------------------------------------------

    async def _reconcile_unlocked(self) -> None:
        # Re-read the live settings bridge so `sched_*` / `ws_enabled` edits
        # take effect within one tick (no restart, no polling by the UI).
        try:
            await refresh_runtime_settings()
        except Exception:
            pass

        # Scheduler disabled → deterministic teardown, then stay parked until
        # re-enabled (same safe path as a closed market day).
        if not rt_bool("sched_enabled", True):
            sup_state = ws_manager.get_supervisor_state()
            if sup_state not in {"STOPPED", "WAITING_FOR_MARKET_WINDOW"}:
                ws_manager.stop_supervisor()
            if ws_manager.is_connected() or ws_manager.subscribed_count() > 0:
                await self._stop_ws("scheduler_disabled")
            if kotak_session.session_active or self._session_owner is not None:
                await self._logout_current("scheduler_disabled")
                self._set_state(STATE_LOGGED_OUT, "scheduler disabled")
            elif self._state != STATE_LOGGED_OUT:
                self._set_state(STATE_LOGGED_OUT, "scheduler disabled")
            return

        # Paper-feed gate ────────────────────────────────────────────────
        # Only a genuinely dummy SCHEDULED feed parks the lifecycle. The active
        # trading terminal is irrelevant here: selecting the Dummy paper engine
        # must NOT disable the scheduled broker login/session/WebSocket/Data
        # Saver chain, because Dummy consumes that same market data.
        #
        # (b) is preserved: never destroy an existing broker session just
        #     because the active terminal is Dummy — Kotak->Dummy->Kotak must
        #     restore the existing Kotak session.
        try:
            if _scheduled_feed_is_dummy():
                if kotak_session.session_active or self._session_owner is not None:
                    self._set_state(STATE_SESSION_ACTIVE, "paper feed — scheduler parked, existing session preserved")
                elif self._state != STATE_LOGGED_OUT:
                    self._set_state(STATE_LOGGED_OUT, "paper feed — scheduled feed broker is the dummy engine")
                return
        except Exception:
            pass

        now = _now_market()
        slot = self._market_slot(now)
        times = _sched_times()
        session_active = kotak_session.session_active
        ws_connected = ws_manager.is_connected()
        sup_state = ws_manager.get_supervisor_state()

        # ── Multi-broker enablement (re-read every tick) ───────────────
        # Kotak keeps its regression-tested machine below; Shoonya runs as an
        # independent driver sharing the same time-table. When Kotak is
        # deliberately disabled, the Shoonya driver owns the global view.
        enabled = _enabled_brokers_now()
        self._enabled_brokers = enabled
        kotak = "kotak" in enabled

        # ── Startup observation events (once per process) ──────────────
        # Honest backend-start timeline: the scheduler reports what it loaded
        # and — if the process came up inside the active window — that it is in
        # reconciliation (catch-up) mode rather than waiting for tomorrow.
        try:
            if not self._startup_events_fired:
                self._startup_events_fired = True
                record_event("scheduler", "BACKEND_STARTED", "info",
                             "Backend started; scheduler loaded",
                             {"brokers": list(enabled), "at_ist": now.isoformat()})
                record_event("scheduler", "SCHEDULE_LOADED", "info",
                             "Daily schedule loaded",
                             {"brokers": list(enabled), "at_ist": now.isoformat()})
                if slot["trading_day"] and slot["in_login_window"]:
                    record_event("scheduler", "ACTIVE_WINDOW_DETECTED", "info",
                                 "Startup inside the active login window — "
                                 "reconciliation mode (catch-up, not skipped)",
                                 {"window": "LOGIN", "at_ist": now.isoformat()})
                elif slot["trading_day"] and slot["past_logout"]:
                    record_event("scheduler", "ACTIVE_WINDOW_DETECTED", "info",
                                 "Startup after the daily lifecycle window",
                                 {"window": "POST_LOGOUT", "at_ist": now.isoformat()})
        except Exception:
            logger.debug("Scheduler startup events failed", exc_info=True)

        # ── Evaluate MarketStateService on every reconcile tick ───────
        # This keeps the authoritative market state fresh for all consumers.
        market_state_service.evaluate(now)

        # ── Persistent scheduler-run ledger: missed-job recovery ──────
        # Time-authoritative reconciliation of today's scheduled executions.
        # IDEMPOTENT: a terminal run is never re-executed; catch-up decisions
        # below only record + verify outcomes, the state machine acts.
        today_iso = now.date().isoformat()
        today_status: dict[str, str] = {}
        today_broker: dict[str, dict[str, str]] = {}
        try:
            snap = market_state_service.get_snapshot()
            # One broker-scoped reconciliation per enabled broker (idempotency
            # keys are broker-scoped, so the same scheduled instant never
            # collides across simultaneously-driven broker lifecycles). Kotak
            # keeps the legacy key format; the phase flags below are Kotak's.
            for broker in enabled:
                broker_session = (
                    session_active if broker == "kotak" else _shoonya_active()
                )
                broker_ws = (
                    ws_connected if broker == "kotak" else _shoonya_ws_connected()
                )
                await scheduler_ledger.reconcile(
                    now=now,
                    schedule=times,
                    business_date=today_iso,
                    is_trading_day=slot["trading_day"],
                    session_active=broker_session,
                    ws_connected=broker_ws,
                    network_ok=bool(snap.get("network_ok", True)),
                    market_state=snap.get("market_state") or "",
                    market_session=snap.get("market_session") or "",
                    ws_enabled=rt_bool("ws_enabled", True),
                    past_logout=slot["past_logout"],
                    phase=self._phase,
                    square_off_completed=self._square_off_completed,
                    feed_stop_completed=self._feed_stop_triggered,
                    record_event=record_event,
                    broker=broker,
                )
            today_status = await scheduler_ledger.today_job_statuses(today_iso)
            try:
                today_broker = await scheduler_ledger.today_broker_statuses(today_iso)
            except Exception:
                today_broker = {}
            # Legacy/fake-ledger fallback: no per-broker grouping available →
            # every enabled broker sees the flat union, exactly as before.
            if not today_broker:
                today_broker = {b: today_status for b in enabled}
            self._ledger_today_statuses = today_status
            self._ledger_cache = await scheduler_ledger.summary(business_date=today_iso)
        except Exception as exc:
            logger.exception("Scheduler ledger reconcile failed: %s", exc)
            if not today_broker and enabled:
                today_broker = {b: today_status for b in enabled}

        # ── 08:50 daily positions sweep (every tick, gated inside) ──
        # Settles prior-date demo intraday opens into the closed trail and drops
        # cached broker positions, once per trading date, so the positions page
        # opens clean for the new date. Reads stay fresh regardless via the
        # lazy rollover in api.demo.get_dummy_positions.
        await self._ensure_positions_day_rollover(now)

        # ── Live per-broker reports (every tick, every lifecycle path) ──
        # Ran BEFORE the Kotak state machine so early-return branches (login
        # window, ws connecting, tick collection, market-closed) still publish
        # fresh per-broker cards; re-run at the tail with the final state.
        await self._refresh_broker_reports(
            now, slot, times, today_iso, today_broker, today_status, enabled,
            kotak, record_event)

        # ── Structured lifecycle observation (key=value, deduped) ──────
        # One line per state transition (never per 5s tick): time-authoritative
        # current-time reconciliation summary. This is the single observability
        # hook for "what did the scheduler decide at this instant".
        try:
            def _short(s: str) -> str:
                s = str(s)
                return s[:12]

            key = "|".join([
                str(slot["trading_day"]),
                str(slot["in_login_window"]),
                str(slot["in_ws_window"]),
                str(slot["past_logout"]),
                str(session_active),
                str(ws_connected),
                _short(self._state),
                _short(self._phase),
                _short(today_status.get("login", "")),
                _short(today_status.get("ws_start", "")),
            ])
            if key != self._last_lifecycle_key:
                self._last_lifecycle_key = key
                logger.info(
                    "LIFECYCLE state=%s phase=%s trading_day=%s "
                    "login_window=%s ws_window=%s past_logout=%s "
                    "session_active=%s ws_connected=%s "
                    "login_job=%s ws_job=%s at_ist=%s",
                    self._state, self._phase, slot["trading_day"],
                    slot["in_login_window"], slot["in_ws_window"],
                    slot["past_logout"], session_active, ws_connected,
                    today_status.get("login", ""),
                    today_status.get("ws_start", ""),
                    now.isoformat(),
                )
        except Exception:
            logger.debug("Scheduler lifecycle observation failed", exc_info=True)

        # ── Trading-day phase machine (spec §3/§17) ────────────────────
        # Time-authoritative: recomputed from the IST clock every tick so a
        # restart converges to the correct phase with no replay.
        phase = _trading_phase(now, times, slot["trading_day"])
        self._set_phase(phase)

        # Readiness report (spec §6) — refreshed every tick, event on toggle.
        self._refresh_readiness(now, slot["trading_day"])

        # Phase-entry triggers — idempotent per process and persisted through
        # the ledger, so a duplicate/restart never double-fires an action.

        # ── Shoonya-only hand-off ─────────────────────────────────────
        # When Kotak is intentionally disabled, the global-view lifecycle
        # belongs to the first enabled broker (Shoonya). The Kotak-specific
        # machine below is skipped; the per-broker driver owns the drive AND
        # mirrors the global state.
        if not kotak:
            return
        if slot["trading_day"]:
            square_off_at = _today_at(now, *times.get("square_off", (15, 16)))
            feed_stop_at = _today_at(now, *times.get("feed_stop", (15, 30)))
            ws_stop_at = _today_at(now, *times["ws_stop"])
            logout_at = _today_at(now, *times["logout"])

            if not self._square_off_triggered and now >= square_off_at:
                persisted = today_status.get("square_off")
                if persisted in {"COMPLETED", "ALREADY_SATISFIED"}:
                    self._square_off_triggered = True
                    self._square_off_completed = True
                elif persisted in {"MISSED_EXPIRED", "SKIPPED", "FAILED"}:
                    self._square_off_triggered = True
                    self._square_off_completed = False
                elif now < feed_stop_at:
                    # Defer until broker session is live: a late-start (e.g. 15:26
                    # for a 15:16 schedule) would otherwise attempt positions
                    # fetch with no Kotak session and fail permanently.
                    if not kotak_session.session_active:
                        logger.info("[SCHEDULER] square-off deferred: broker session not active yet, will retry next tick")
                    else:
                        should_mark = await self._trigger_square_off(now)
                        if should_mark:
                            self._square_off_triggered = True
                        else:
                            logger.info("[SCHEDULER] square-off deferred by engine: will retry next tick")
                else:
                    # Window closed before we could trigger (late restart) — do
                    # not place closing orders past the configured window.
                    self._square_off_triggered = True

            if not self._feed_stop_triggered and now >= feed_stop_at:
                if now < ws_stop_at or ws_connected:
                    await self._trigger_feed_stop(now)
                else:
                    self._feed_stop_triggered = True

            if not self._ws_stop_event_fired and now >= ws_stop_at:
                self._ws_stop_event_fired = True
                record_event("scheduler", "WEBSOCKET_STOP_TRIGGERED", "info",
                             "WebSocket close window reached",
                             {"at_ist": now.isoformat()})
            if not self._logout_event_fired and now >= logout_at:
                self._logout_event_fired = True
                record_event("scheduler", "LOGOUT_TRIGGERED", "info",
                             "Scheduled logout window reached",
                             {"at_ist": now.isoformat()})
            if (not self._day_complete_fired and now >= logout_at
                    and not ws_connected and not session_active
                    and self._session_owner is None):
                self._day_complete_fired = True
                record_event("scheduler", "TRADING_DAY_COMPLETED", "info",
                             "Trading day lifecycle complete",
                             {"at_ist": now.isoformat()})

        # No blind actions once today's window has been judged obsolete: if the
        # scheduled login is terminal-expired/skipped, the
        # remaining day must NOT auto-login.
        login_blocked = today_status.get("login") in {"MISSED_EXPIRED", "SKIPPED"}
        # ws_start (now 08:55) and tick_collection_start (08:59) share the
        # same ws_window validity. The tick collection window is valid
        # as long as the ws window is still open.
        #
        # A MANUAL session is an explicit user login, so the day's
        # missed/skipped scheduled jobs (which describe the AUTOMATIC
        # lifecycle) must not keep its feed down: honoring them here parked a
        # mid-day manual login forever with "feed window expired; feed not
        # started for the day" while the ws window was still open.
        tick_blocked = (
            self._session_owner != "manual"
            and today_status.get("ws_start") in {"MISSED_EXPIRED", "SKIPPED"}
        )

        # ── Confirmation window lifecycle ──────────────────────────
        # At 09:13 IST: start the confirmation window
        if slot["trading_day"] and slot["in_ws_window"]:
            t = now.time()
            from services.market_state import CONFIRMATION_WINDOW_START, CONFIRMATION_WINDOW_END
            if t >= CONFIRMATION_WINDOW_START and not market_state_service._confirmation_started:
                market_state_service.start_confirmation_window()

        # At 09:17 IST: evaluate the confirmation deadline
        if slot["trading_day"] and not market_state_service._confirmation_decided:
            t = now.time()
            from services.market_state import CONFIRMATION_WINDOW_END
            if t >= CONFIRMATION_WINDOW_END and market_state_service._confirmation_started:
                result = market_state_service.evaluate_confirmation_deadline()
                if result is not None and result.market_state == "NO_TICKS_AFTER_CONFIRMATION":
                    logger.info(
                        "[MARKET] Confirmation deadline: no ticks received — "
                        "market appears closed"
                    )
                    if ws_connected or ws_manager.subscribed_count() > 0:
                        await self._stop_ws("no_ticks_confirmation")
                    ws_manager.stop_supervisor()

        # Not a trading day — no automatic trading-session lifecycle.
        if not slot["trading_day"]:
            if ws_manager.get_supervisor_state() not in {
                "STOPPED", "WAITING_FOR_MARKET_WINDOW",
            }:
                ws_manager.stop_supervisor()
            if ws_connected or ws_manager.subscribed_count() > 0:
                await self._stop_ws("market_closed")
            if self._session_owner == "manual":
                if self._manual_expire_at is not None and now.timestamp() >= self._manual_expire_at:
                    await self._logout_current("session_expired")
                    self._set_state(STATE_SESSION_EXPIRED, "manual session expired")
                elif self._state != STATE_MARKET_CLOSED:
                    self._set_state(
                        STATE_MARKET_CLOSED,
                        "closed market day; manual session retained",
                    )
                return
            if session_active or self._session_owner is not None:
                await self._logout_current("market_closed")
            if self._state != STATE_MARKET_CLOSED:
                record_event("scheduler", "MARKET_CLOSED", "info",
                             f"Not a trading day ({market_calendar.day_class(now.date())})")
            self._set_state(STATE_MARKET_CLOSED)
            return

        # Past the scheduled logout time on a trading day.
        if slot["past_logout"]:
            if self._session_owner == "manual":
                if self._manual_expire_at is not None and now.timestamp() >= self._manual_expire_at:
                    await self._logout_current("session_expired")
                    self._set_state(STATE_SESSION_EXPIRED, "manual session expired")
                else:
                    if sup_state not in {"STOPPED", "WAITING_FOR_MARKET_WINDOW"}:
                        ws_manager.stop_supervisor()
                    if ws_connected or ws_manager.subscribed_count() > 0:
                        await self._stop_ws("scheduled_disconnect")
                    if self._state != STATE_MARKET_CLOSED:
                        self._set_state(STATE_MARKET_CLOSED, "trading hours over; manual session retained")
                return
            if ws_connected or session_active or self._session_owner is not None:
                await self._logout_current("scheduled_logout")
                return
            next_day = market_calendar.next_trading_day(now.date())
            if next_day and next_day > now.date():
                self._set_state(
                    STATE_WAITING_FOR_NEXT_TRADING_DAY,
                    f"lifecycle complete; next trading day {next_day.isoformat()}",
                )
            else:
                self._set_state(STATE_LOGGED_OUT)
            return

        # Manual sessions auto-expire after 60 minutes.
        if self._session_owner == "manual" and self._manual_expire_at is not None:
            if now.timestamp() >= self._manual_expire_at:
                logger.info("Manual session expired; logging out")
                await self._logout_current("session_expired")
                self._set_state(STATE_SESSION_EXPIRED, "manual session expired")
                return

        # No active session yet — within the login window, keep trying.
        if not session_active:
            if login_blocked:
                await self._park_session_today(
                    "scheduled login window expired; no automatic session for the day"
                )
                return
            if slot["in_login_window"]:
                await self._ensure_login_locked()
            else:
                self._set_state(STATE_WAITING_FOR_LOGIN)
            return

        # Session is active — determine the current lifecycle stage.
        # The sequence is now: 08:50 LOGIN → 08:55 WEBSOCKET CONNECT → 08:59 TICK COLLECTION.

        # WS#2 order feed (Kotak OrderFeedWebSocket via create_order_feed): the
        # supervisor is session-driven (never market-window gated) so post-market
        # order/position events keep flowing for as long as a session is active.
        try:
            from ws_socket.order_feed_manager import order_feed_manager
            of_state = order_feed_manager.get_supervisor_state()
            if of_state in ("OF_STOPPED", "OF_WAITING", "OF_AUTH_REQUIRED", "OF_ERROR"):
                order_feed_manager.start_supervisor()
        except Exception:
            logger.exception("[SCHEDULER] order feed supervisor start failed")

        if slot["in_ws_window"]:
            # The WebSocket window (08:55 onwards) is open.
            # Apply today's eligible-universe daily subscription intent FIRST,
            # so the supervisor's connect/restore targets the full current-day
            # desired set (never the db.stocks-only handful). Idempotent/day.
            try:
                await self._ensure_daily_subscription_intent()
            except Exception:
                logger.exception("[SCHEDULER] daily subscription intent ensure failed")
            # If the WS connect hasn't happened yet, start it.
            if tick_blocked:
                if sup_state not in {"STOPPED", "WAITING_FOR_MARKET_WINDOW"}:
                    ws_manager.stop_supervisor()
                if ws_connected or ws_manager.subscribed_count() > 0:
                    await self._stop_ws("feed_window_expired")
                if self._state not in {STATE_TICK_COLLECTION, STATE_TICK_COLLECTION_RUNNING, STATE_WS_ACTIVE}:
                    self._set_state(STATE_WS_ACTIVE,
                                    "feed window expired; feed not started for the day")
                return
            # Check if tick collection should start (08:59 onwards)
            if slot["in_tick_collection_window"]:
                if ws_connected:
                    if not self._tick_collection_started:
                        self._tick_collection_started = True
                        self._set_state(STATE_TICK_COLLECTION, "tick collection starting")
                    else:
                        self._set_state(STATE_TICK_COLLECTION_RUNNING, "tick collection running")
                    # Startup path goes through the engine reconcile (full set).
                    try:
                        await self._trigger_daily_engine_reconcile()
                    except Exception:
                        logger.exception("[SCHEDULER] daily engine reconcile trigger failed")
                    return
                # WS connected is required before tick collection can start
                if sup_state in {"STOPPED", "WAITING_FOR_MARKET_WINDOW"}:
                    ws_manager.start_supervisor()
                self._set_state(STATE_WS_CONNECTING)
                return
            # Before tick collection window (08:55-08:59): WS should be connecting/connected
            if ws_connected:
                self._reset_ws_state()
                self._set_state(STATE_WS_ACTIVE)
                try:
                    await self._trigger_daily_engine_reconcile()
                except Exception:
                    logger.exception("[SCHEDULER] daily engine reconcile trigger failed")
                return
            if sup_state in {"STOPPED", "WAITING_FOR_MARKET_WINDOW"}:
                ws_manager.start_supervisor()
            self._set_state(STATE_WS_CONNECTING)
            return

        # Outside the WebSocket window but before the logout time.
        if sup_state not in {"STOPPED", "WAITING_FOR_MARKET_WINDOW"}:
            ws_manager.stop_supervisor()
        if ws_connected:
            await self._stop_ws("scheduled_disconnect")
            self._set_state(STATE_WS_DISCONNECTING)

        self._set_state(STATE_SESSION_ACTIVE)

        # ── Parallel broker lifecycles (Shoonya alongside Kotak) ───────
        # Rebuild with the final state of this tick (fresh state_message) and
        # publish only real transitions — never re-drive the Shoonya lifecycle
        # twice in one tick.
        await self._refresh_broker_reports(
            now, slot, times, today_iso, today_broker, today_status, enabled,
            kotak, record_event, drive_shoonya=False)

    async def _refresh_broker_reports(self, now, slot, times, today_iso,
                                      today_broker, today_status, enabled,
                                      kotak, record_event, *,
                                      drive_shoonya=True) -> None:
        """Refresh every enabled broker's lifecycle card + SSE transitions."""
        try:
            if drive_shoonya and "shoonya" in enabled:
                await self._reconcile_shoonya(now, slot, times, today_iso,
                                              today_broker, enabled, record_event)
            self._build_kotak_report(
                now, slot, times, today_broker.get("kotak") or today_status)
            for b, rep in self._brokers_report.items():
                await self._publish_broker_frame(b, rep)
        except Exception:
            logger.debug("Scheduler broker reports failed", exc_info=True)

    async def _publish_broker_frame(self, broker: str, report: dict) -> None:
        """Broadcast a broker-lifecycle frame to the schedule-events SSE bus.

        Deduped per lifecycle transition (state / login / ws / ledger change),
        so the Schedules page timeline refreshes live without 5s-tick noise.
        """
        try:
            sig = (
                broker,
                report.get("state"),
                (report.get("login") or {}).get("state"),
                (report.get("ws") or {}).get("state"),
                "|".join(str(v) for v in (report.get("ledger") or {}).values()),
            )
            prev = self._broker_frames.get(broker)
            if prev == sig:
                return
            self._broker_frames[broker] = sig
            from services.event_bus import publish_event
            await publish_event({
                "type": "broker_lifecycle",
                "broker": broker,
                "event": report.get("state"),
                "state": report.get("state_message"),
                "action": (report.get("message") or ""),
                "ts": _now_ist().isoformat(),
            })
        except Exception:
            pass

    async def _reconcile_shoonya(self, now, slot, times, today_iso,
                                 today_broker, enabled, record_event) -> None:
        """Drive the Shoonya scheduled lifecycle (independent of Kotak)."""
        if "shoonya" not in enabled:
            return
        if self._shoonya_driver is None:
            from scheduler.broker_lifecycle import ShoonyaLifecycleDriver
            self._shoonya_driver = ShoonyaLifecycleDriver(self)
        is_primary = "kotak" not in enabled
        today_status = today_broker.get("shoonya") or {}
        report = await self._shoonya_driver.reconcile(
            now=now, slot=slot, times=times, today_iso=today_iso,
            today_status=today_status, record_event=record_event,
            is_primary=is_primary,
        )
        self._brokers_report["shoonya"] = report

    def _build_kotak_report(self, now, slot, times, today_status) -> None:
        """Per-broker lifecycle card for Kotak (same shape as Shoonya)."""
        log = bool(getattr(kotak_session, "session_active", False))
        ws = "CONNECTED" if ws_manager.is_connected() else "DISCONNECTED"
        state = self._state
        if not slot["trading_day"]:
            bridge = "MARKET_CLOSED"
        elif slot["past_logout"]:
            bridge = "LOGGED_OUT"
        elif not log:
            bridge = ("FAILED" if today_status.get("login") in {"MISSED_EXPIRED", "SKIPPED"}
                      else "LOGIN_PENDING" if slot["in_login_window"] else "LOGIN_PENDING")
        elif state == STATE_WS_DISCONNECTING:
            bridge = "WS_STOPPING"
        elif ws == "CONNECTED":
            bridge = "WS_CONNECTED"
        elif slot["in_ws_window"]:
            bridge = "WS_CONNECTING"
        else:
            bridge = "SESSION_VALID"
        login_t, ws_start_t, ws_stop_t, logout_t = (
            times["login"], times["ws_start"], times["ws_stop"], times["logout"],
        )
        last_login = getattr(kotak_session, "last_login_at", None)
        self._brokers_report["kotak"] = {
            "broker": "kotak",
            "broker_name": "Kotak Neo",
            "enabled": "kotak" in self._enabled_brokers,
            "primary": "kotak" in (self._enabled_brokers or ("kotak",)) and \
                (self._enabled_brokers[0] == "kotak" if self._enabled_brokers else True),
            "state": bridge,
            "state_message": self._state,
            "login": {
                "state": "LOGGED_IN" if log else bridge,
                "in_window": bool(slot["in_login_window"]),
                "blocked": today_status.get("login") in {"MISSED_EXPIRED", "SKIPPED"},
                "window": f"{login_t[0]:02d}:{login_t[1]:02d}",
            },
            "ws": {
                "state": ws,
                "connected": ws == "CONNECTED",
                "start": f"{ws_start_t[0]:02d}:{ws_start_t[1]:02d}",
                "stop": f"{ws_stop_t[0]:02d}:{ws_stop_t[1]:02d}",
                # Real feed liveness, not a hardcoded null: the same
                # ws_manager.status() that backs /api/websocket/status.
                # Guarded so a status-surface problem can never abort the
                # lifecycle report (it is diagnostic data, not control flow).
                "last_message_at": _ws_last_message_at(),
                "reason": None,
            },
            "logout": {"time": f"{logout_t[0]:02d}:{logout_t[1]:02d}"},
            "oauth": {"required": False, "url": None, "code_provided": False,
                      "accept_endpoint": None},
            "session": {
                "active": log,
                "login_source": getattr(kotak_session, "login_source", None),
                "login_time": _sched_iso(last_login) if last_login else None,
                "expires_at": None,
            },
            "ledger": {
                "login": today_status.get("login"),
                "ws_start": today_status.get("ws_start"),
                "tick_collection": today_status.get("tick_collection"),
                "ws_stop": today_status.get("ws_stop"),
                "logout": today_status.get("logout"),
            },
            "last_event": None,
        }

    def broker_reports(self) -> dict[str, dict]:
        """Live per-broker lifecycle reports (also exposed on /status)."""
        reports = dict(self._brokers_report)
        # Always guarantee the primary broker has a card even before the first
        # reconcile tick (boot/restart race) — derived, never fabricated.
        if "kotak" not in reports and "kotak" in self._enabled_brokers:
            self._build_kotak_report(_now_market(), self._market_slot(_now_market()),
                                     _sched_times(), {})
            reports = dict(self._brokers_report)
        return reports

    async def _ensure_daily_subscription_intent(self) -> bool:
        """Apply today's Market Watch daily-universe intent (idempotent/day).

        Refreshes the intraday-eligible NSE EQ universe POST-login, then asks
        the Session Manager to record the current trading day's rows as the
        canonical desired set (source=market_watch_daily_universe). Runs
        BEFORE the WebSocket supervisor subscribes so the full universe — not
        the db.stocks-only handful — is the reconnect/restore target. Returns
        True once today's intent is recorded (no-op on later ticks).
        """
        cal = market_calendar.snapshot() or {}
        market_date = str(cal.get("market_date") or "")
        if not market_date:
            return False
        with self._lock:
            if self._daily_intent_applied_date == market_date:
                return True
        try:
            from services.market_watch_engine import market_watch_engine
            counts = market_watch_engine.refresh_universe()
            rows = market_watch_engine.daily_subscription_intent()
        except Exception as exc:
            logger.warning("[SCHEDULER] daily universe intent build failed: %s", exc)
            return False
        try:
            session_id = (session_manager.snapshot() or {}).get("session_id")
        except Exception:
            session_id = None
        try:
            snap = await session_manager.apply_daily_subscription_intent(
                market_date, session_id, rows,
            )
        except Exception as exc:
            logger.warning("[SCHEDULER] daily universe intent apply failed: %s", exc)
            return False
        with self._lock:
            self._daily_intent_applied_date = market_date
        logger.info(
            "[SCHEDULER] daily universe intent applied date=%s eligible=%d daily_universe_desired=%s desired=%s",
            market_date,
            counts.get("eligible"),
            snap.get("daily_universe_desired"),
            snap.get("desired"),
        )
        return True

    async def _ensure_positions_day_rollover(self, now: datetime) -> None:
        """08:50 daily positions sweep (idempotent/day).

        Settles prior-date demo intraday opens into the closed trail (reason
        ``AUTO_DAY_ROLLOVER``, backdated to their own date) and drops cached
        broker positions so the positions page opens clean for the new date.
        Gated to 08:50+ IST; earlier reads are already fresh via the lazy
        rollover in ``api.demo.get_dummy_positions``.
        """
        try:
            from services.dummy_extras import trading_date as _tdate
            day = _tdate(now)
            if (now.hour, now.minute) < (8, 50):
                return
            with self._lock:
                if self._positions_rollover_date == day:
                    return
                self._positions_rollover_date = day
        except Exception as exc:
            logger.warning("[SCHEDULER] positions rollover date check failed: %s", exc)
            return
        try:
            from api.demo import rollover_demo_positions
            res = await rollover_demo_positions(day)
            logger.info("[SCHEDULER] positions day rollover date=%s rolled=%d realized=%s",
                        day, res.get("rolled"), res.get("realized"))
        except Exception:
            logger.exception("[SCHEDULER] demo positions rollover failed")
        try:
            from services.broker_cache import broker_cache
            broker_cache.invalidate("positions")
        except Exception:
            logger.exception("[SCHEDULER] positions cache invalidate failed")

    async def _trigger_daily_engine_reconcile(self) -> None:
        """Day-guarded startup reconcile through the WebSocket Engine.

        The real daily startup path is: daily intent applied -> supervisor
        connects & subscribes the registry -> engine reconcile mirrors the ACK
        into the Session Manager and closes any registry/broker drift. Fires
        once per trading day, only while the live WS is actually connected.
        """
        cal = market_calendar.snapshot() or {}
        market_date = str(cal.get("market_date") or "")
        if not market_date:
            return
        with self._lock:
            if self._engine_daily_reconcile_date == market_date:
                return
        try:
            from ws_socket.engine.engine import engine
            if engine.owner is None or not engine._owner_connected():
                return
            summary = await engine.reconcile_broker_subscriptions()
        except Exception as exc:
            logger.warning("[SCHEDULER] engine daily reconcile failed: %s", exc)
            return
        with self._lock:
            self._engine_daily_reconcile_date = market_date
        logger.info(
            "[SCHEDULER] engine daily reconcile done date=%s wanted=%s subscribed=%s to_unsub=%s",
            market_date, summary.get("wanted"), summary.get("count"),
            summary.get("to_unsubscribe"),
        )

    async def _ensure_login_locked(self) -> None:
        with self._lock:
            attempts = self._login_attempts
            next_at = self._next_login_attempt_at
        now = time.time()

        if now < next_at:
            self._set_state(
                STATE_LOGIN_FAILED if attempts > 0 else STATE_WAITING_FOR_LOGIN,
                f"retry in {round(next_at - now)}s",
            )
            return

        if kotak_session.session_active:
            return

        latest_error: str | None = None
        ok = False
        with self._exec_lock:
            try:
                self._set_state(STATE_LOGGING_IN, "login attempt", source="scheduler")
                # busy lock is already held by the reconcile loop — acquiring it
                # again here would self-deadlock (non-reentrant asyncio.Lock).
                ok = await self._do_login_impl("scheduler", acquire_busy=False)
            except Exception as exc:
                latest_error = str(exc)
                logger.error("Scheduler login failed: %s", exc)

        if ok:
            with self._lock:
                self._login_attempts = 0
                self._login_error = None
            self._set_state(STATE_SESSION_ACTIVE)
            return

        with self._lock:
            self._login_attempts = attempts + 1
            self._login_error = latest_error
            self._next_login_attempt_at = time.time() + _login_backoff(attempts + 1)
        self._set_state(STATE_LOGIN_FAILED, latest_error or "login failed")

    async def _ensure_ws_subscribed(self) -> None:
        with self._lock:
            attempts = self._ws_attempts
            next_at = self._next_ws_attempt_at
        now = time.time()

        if now < next_at:
            self._set_state(
                STATE_WS_RECONNECTING if attempts > 0 else STATE_WAITING_FOR_WS,
                f"retry in {round(next_at - now)}s",
            )
            return

        self._set_state(STATE_WS_CONNECTING, "connecting broker feed")

        ok = await self._start_ws()
        if ok and ws_manager.is_connected():
            with self._lock:
                self._ws_attempts = 0
                self._ws_error = None
            self._set_state(STATE_WS_ACTIVE)
            return
        if ok:
            # The SDK accepted the subscription but the socket has not opened
            # yet (async connect thread). Give the on_open callback a bounded
            # chance to fire before scheduling a retry.
            for _ in range(int(self._tick_seconds * 2)):
                await asyncio.sleep(0.5)
                if ws_manager.is_connected():
                    with self._lock:
                        self._ws_attempts = 0
                        self._ws_error = None
                    self._set_state(STATE_WS_ACTIVE)
                    return

        with self._lock:
            self._ws_attempts = attempts + 1
            self._ws_error = self._ws_error or "subscribe failed"
            self._next_ws_attempt_at = time.time() + _ws_backoff(attempts + 1)
        # Any failed attempt means we are reconnecting (never hide it behind the
        # pre-attempt WAITING_FOR_WS label).
        self._set_state(STATE_WS_RECONNECTING, "subscribe failed")

    def _reset_ws_state(self) -> None:
        with self._lock:
            self._ws_attempts = 0
            self._ws_error = None
            self._next_ws_attempt_at = 0.0

    # ------------------------------------------------------------------
    # Execution helpers
    # ------------------------------------------------------------------

    async def _do_login_impl(self, source: str, acquire_busy: bool = True) -> bool:
        await tick_buffer.start()

        # Reconcile must never observe a half-finished login (broker session
        # active but owner not yet assigned) and tear it down. The reconcile
        # loop already holds ``_busy_lock`` when it calls this method, so an
        # extra acquire would self-deadlock (asyncio.Lock is NOT reentrant) —
        # the automatic 09:00 login used to hang forever here and the held
        # lock then blocked every subsequent manual login too. ``acquire_busy``
        # keeps the guard for the external (do_login / manual) path and skips
        # it for the reconcile path that already owns the lock (#4/#5/#21).
        if acquire_busy:
            busy = self._busy_lock
            if busy is None:
                busy = asyncio.Lock()
                self._busy_lock = busy
            async with busy:
                return await self._login_impl_body(source)
        return await self._login_impl_body(source)

    async def _login_impl_body(self, source: str) -> bool:
        # Kotak login does blocking network I/O (TOTP + MPIN validation). Run
        # it off the app loop AND under a hard timeout so a hung broker never
        # freezes the loop or blocks forever (#21).
        try:
            await asyncio.wait_for(
                asyncio.to_thread(kotak_session.login, source=source),
                timeout=_LOGIN_TIMEOUT,
            )
        except asyncio.TimeoutError as exc:
            raise RuntimeError(f"Broker login timed out after {_LOGIN_TIMEOUT:g}s") from exc

        if not kotak_session.session_active:
            raise RuntimeError("Kotak login completed but session is not active")

        # Claim ownership BEFORE any further await so a concurrent reconcile
        # (non-trading-day / past-logout) treats this as an owned session.
        with self._lock:
            self._session_owner = source

        # Instrument cache download is blocking network I/O — offload it too.
        try:
            await asyncio.wait_for(
                asyncio.to_thread(load_instrument_cache),
                timeout=_INSTRUMENT_CACHE_TIMEOUT,
            )
        except asyncio.TimeoutError:
            logger.warning("Instrument cache load timed out (non-critical)")
        except Exception as exc:
            logger.warning("Instrument cache load failed (non-critical): %s", exc)

        logger.info("Session owner set to %s", source)
        record_event(
            "scheduler", "login_ok", "info",
            "Kotak session established",
            {"source": source},
        )

        # WS#2: kick the Order & Position feed (Broker → Backend) supervisor
        # — it is session-driven (not market-window gated) so after-market
        # order events are delivered. Best-effort, never blocks login.
        try:
            from ws_socket.order_feed_manager import order_feed_manager
            order_feed_manager.start_supervisor()
            logger.info("[SCHEDULER] Order Feed WS#2 supervisor started (post-login)")
        except Exception as exc:
            logger.warning("[SCHEDULER] Order Feed WS#2 start failed (lazy retry): %s", exc)

        # Register the session in the ONE central session manager. Automatic
        # (scheduler-owned) sessions carry the REAL scheduled logout instant as
        # their expires_at (today's wall-clock logout time) so the UI countdown
        # is backend-authoritative; manual sessions get the 60-minute lifetime.
        scheduled_expires_at = None
        if source == "scheduler":
            try:
                slot = self._market_slot(_now_market())
                if slot["logout_at"] is not None:
                    scheduled_expires_at = slot["logout_at"].timestamp()
            except Exception as exc:
                logger.warning("Scheduler logout instant unavailable: %s", exc)
        try:
            session_manager.mark_login_success(
                mode=_active_mode_name(),
                broker="Kotak Neo",
                user_id=kotak_session.user_id or None,
                session_ref=kotak_session.session_id or None,
                lifetime_seconds=None if source == "scheduler" else MANUAL_SESSION_SECONDS,
                source=source,
                scheduled_expires_at=scheduled_expires_at,
            )
        except Exception as exc:
            logger.warning("Central session registration failed: %s", exc)
        return True

    async def _start_ws(self) -> bool:
        if not kotak_session.session_active:
            logger.warning("WebSocket start skipped: Kotak session is not active")
            return False
        try:
            await session_manager.refresh_desired_subscriptions()
            tokens = session_manager.subscription_desired_keys()
        except Exception as exc:
            logger.error("Failed to load desired subscriptions: %s", exc)
            return False

        if not tokens:
            logger.warning("WebSocket start skipped: no active subscriptions found")
            return False

        try:
            result = await ws_manager.subscribe(tokens)
            if not result.get("ok"):
                self._store_ws_error(result.get("message"))
                return False
        except Exception as exc:
            logger.exception("WebSocket subscribe failed")
            self._store_ws_error(str(exc))
            return False

        logger.info("WebSocket session started: subscribed %d tokens", len(tokens))
        return True

    def _store_ws_error(self, message: str | None) -> None:
        with self._lock:
            self._ws_error = message or self._ws_error or "subscribe failed"

    async def _stop_ws(self, reason: str) -> None:
        try:
            ws_manager.disconnect(why=reason)
        except Exception:
            logger.exception("WebSocket disconnect during scheduler stop failed")
        record_event("scheduler", "ws_stop", "info", reason)

    async def _park_session_today(self, reason: str) -> None:
        """Deterministic end-of-day park after a session window expired.

        Stops the feed, logs out any live session and marks the day closed so
        the scheduler never blindly re-logs-in after the scheduled window was
        judged obsolete (missed login/feed window).
        """
        sup_state = ws_manager.get_supervisor_state()
        if sup_state not in {"STOPPED", "WAITING_FOR_MARKET_WINDOW"}:
            ws_manager.stop_supervisor()
        try:
            from ws_socket.order_feed_manager import order_feed_manager
            order_feed_manager.stop_supervisor()
        except Exception:
            logger.exception("[SCHEDULER] order feed supervisor stop failed")
        if ws_manager.is_connected() or ws_manager.subscribed_count() > 0:
            await self._stop_ws("scheduler_park")
        if kotak_session.session_active or self._session_owner is not None:
            await self._logout_current(reason)
        elif self._state != STATE_MARKET_CLOSED:
            self._set_state(STATE_MARKET_CLOSED, reason)

    async def _logout_current(self, reason: str) -> None:
        self._set_state(STATE_LOGGING_OUT, reason)
        # Stop the supervisor first (prevents it from reconnecting during logout)
        ws_manager.stop_supervisor()
        try:
            from ws_socket.order_feed_manager import order_feed_manager
            order_feed_manager.stop_supervisor()
        except Exception:
            logger.exception("[SCHEDULER] order feed supervisor stop failed")
        try:
            ws_manager.disconnect(why=reason)
        except Exception:
            logger.exception("WebSocket disconnect before logout failed")

        # The scheduler owns the scheduled BROKER session, so the scheduled
        # logout must always run: gating it on the trading terminal used to
        # leave the Kotak session authenticated all night whenever the paper
        # engine was selected. The dummy terminal itself is still protected —
        # mark_logout() below is scoped to mode="kotak" only.
        try:
            await tick_buffer.stop()
        except Exception:
            logger.exception("Tick buffer stop during logout failed")

        with self._exec_lock:
            try:
                await asyncio.wait_for(
                    asyncio.to_thread(kotak_session.logout),
                    timeout=_LOGIN_TIMEOUT,
                )
            except asyncio.TimeoutError:
                logger.error("Broker logout timed out; session invalidated locally")
            except Exception:
                logger.exception("Kotak logout call failed")

        with self._lock:
            self._session_owner = None
            self._manual_expire_at = None
            self._ws_attempts = 0
            self._ws_error = None
            self._next_ws_attempt_at = 0.0
            self._tick_collection_started = False

        self._set_state(STATE_LOGGED_OUT, reason)
        # Only mark the kotak session as logged out — the dummy terminal is
        # managed independently and must survive any scheduler action.
        session_manager.mark_logout(reason, mode="kotak")
        record_event("scheduler", "logout_ok", "info", reason)

    # ------------------------------------------------------------------
    # Trading-day phase machine (Engine #01)
    # ------------------------------------------------------------------

    def _set_phase(self, phase: str, message: str = "") -> bool:
        """Publish a phase transition (idempotent): only a real change fires.

        Emits ``PHASE_CHANGED`` with the previous/current phase + timestamp
        (spec §9) and the phase-entry event for non-action phases.
        """
        with self._lock:
            previous = self._phase
            changed = phase != previous
            if changed:
                self._phase = phase
                self._phase_since = time.time()
        if not changed:
            return False
        now_iso = _now_ist().isoformat()
        record_event(
            "scheduler", "PHASE_CHANGED", "info",
            f"Phase {previous} -> {phase}" + (f" ({message})" if message else ""),
            {"previous_phase": previous, "new_phase": phase, "timestamp": now_iso},
        )
        logger.info("[SCHEDULER] phase %s -> %s%s", previous, phase,
                    f" ({message})" if message else "")
        entry_event = _PHASE_ENTRY_EVENTS.get(phase)
        if entry_event:
            record_event("scheduler", entry_event, "info",
                         f"{phase} entered",
                         {"phase": phase, "timestamp": now_iso})
        return True

    @staticmethod
    def _engine_running(engine_id: str) -> bool:
        """Best-effort readiness probe for a registered engine (never raises)."""
        try:
            from services.engine_registry import get_engine_registry
            status = get_engine_registry().get_status(engine_id)
            if not status:
                return False
            return status.get("state") in {"RUNNING", "HEALTHY", "DEGRADED"}
        except Exception:
            return False

    def _refresh_readiness(self, now: datetime, trading_day: bool) -> None:
        """Verify critical components (spec §6) and emit on READY/NOT_READY toggle.

        Critical failure means the scheduler reports NOT_READY + notification and
        does not let trading silently start — the phase machine still runs so the
        operator can see exactly what is missing.
        """
        if not trading_day:
            self._ready_overall = None
            self._ready_report = {
                "overall": None, "applicable": False, "checks": [],
                "as_of": None,
            }
            return
        session_ok = bool(kotak_session.session_active)
        try:
            # ``snapshot()["active"]`` is exactly ``is_active()``, but the
            # snapshot also rebuilds the full ~2.7k-row subscription view. The
            # readiness refresh runs on the event loop, so read the O(1) truth
            # directly instead of materialising the whole aggregate every tick.
            session_mgr_ok = bool(session_manager.is_active())
        except Exception:
            session_mgr_ok = False
        ws_ok = ws_manager.is_connected()
        try:
            subs_count = int(ws_manager.subscribed_count())
        except Exception:
            subs_count = 0

        checks = [
            {"component": "session_manager", "critical": True, "ready": session_mgr_ok},
            {"component": "session", "critical": True, "ready": session_ok},
            {"component": "websocket_engine", "critical": True, "ready": ws_ok},
            {"component": "subscriptions", "critical": True,
             "ready": subs_count > 0, "detail": f"{subs_count} active"},
            {"component": "feature_engine", "critical": True,
             "ready": self._engine_running("feature_engine")},
            {"component": "storage_engine", "critical": True,
             "ready": self._engine_running("storage_engine")},
            {"component": "db_writer_engine", "critical": True,
             "ready": self._engine_running("db_writer_engine")},
            {"component": "order_engine", "critical": False,
             "ready": self._engine_running("order_engine")},
            {"component": "position_engine", "critical": False,
             "ready": self._engine_running("position_engine")},
            {"component": "connection_manager", "critical": False,
             "ready": self._engine_running("connection_manager")},
            {"component": "model_group", "critical": False, "ready": None,
             "detail": "not registered"},
        ]
        overall = "READY" if all(
            c["ready"] for c in checks if c["critical"]
        ) else "NOT_READY"
        self._ready_report = {
            "overall": overall,
            "applicable": True,
            "checks": checks,
            "as_of": now.isoformat(),
        }
        if overall != self._ready_overall:
            self._ready_overall = overall
            failed = [c["component"] for c in checks
                      if c["critical"] and not c["ready"]]
            record_event(
                "scheduler",
                "SCHEDULER_READY" if overall == "READY" else "SCHEDULER_NOT_READY",
                "info" if overall == "READY" else "warning",
                "Engine readiness: " + overall
                + (f" (missing: {', '.join(failed)})" if failed else ""),
                {"overall": overall, "missing": failed},
            )

    def readiness_snapshot(self) -> dict:
        return dict(self._ready_report)

    @staticmethod
    def _safe_session_snapshot() -> dict:
        """Best-effort central Session Manager snapshot (never raises)."""
        try:
            return {
                "active": bool(session_manager.is_active()),
                "state": session_manager.snapshot().get("state"),
                "mode": session_manager.snapshot().get("mode"),
                "wsState": session_manager.snapshot().get("ws_state"),
            }
        except Exception:
            return {"active": False, "state": None, "mode": None, "wsState": None}

    async def _trigger_square_off(self, now: datetime) -> bool:
        """Publish TRIGGER_SQUARE_OFF and hand the closing flow to the engine.

        The scheduler only TRIGGERS (spec §13/§29): the Square-Off Engine owns
        "how". Idempotent — the caller guards with ``_square_off_triggered`` and
        the persisted ledger guards across restarts.
        """
        enabled = rt_bool("sched_square_off_enabled", settings.square_off_enabled)
        terminal = _active_mode_name()
        if not enabled:
            self._square_off_completed = False
            record_event("scheduler", "SQUARE_OFF_TRIGGERED", "warning",
                         "Square-off trigger skipped: disabled in settings",
                         {"terminal": terminal, "result": "SKIPPED_DISABLED",
                          "at_ist": now.isoformat()})
            return True
        status = "FAILED"
        details: dict = {"terminal": terminal, "at_ist": now.isoformat()}
        deferred = False
        try:
            from core.engines.squareoff_engine import squareoff_engine
            result = await squareoff_engine.execute_square_off(
                terminal=terminal, source="scheduler",
            )
            status = str(
                result.get("status") or ("COMPLETED" if result.get("ok") else "FAILED")
            )
            deferred = bool(result.get("deferred"))
            details.update({
                "result": status,
                "filled": result.get("filled"),
                "failed": result.get("failed"),
                "total": result.get("total"),
                "deferred": deferred,
            })
            if deferred:
                details["note"] = "square-off deferred: no broker session, will retry"
        except Exception as exc:
            logger.exception("Square-off trigger failed")
            details["error"] = str(exc)
            if "Kotak Neo session required" in str(exc) or "NOT_LOGGED_IN" in str(exc):
                deferred = True
                details["deferred"] = True
        # Deferred due to missing session is not a terminal completion — caller
        # decides whether to keep ` _square_off_triggered` unset for retry.
        if deferred:
            self._square_off_completed = False
            # Do not treat as completed; caller may retry next tick.
        else:
            self._square_off_completed = status in {"COMPLETED", "PARTIAL", "CANCELLED"}
        record_event(
            "scheduler", "SQUARE_OFF_TRIGGERED",
            "info" if self._square_off_completed else "warning",
            f"Square-off trigger result: {status}", details,
        )
        # Return False when deferred so caller can retry next tick instead of
        # marking the window permanently consumed.
        if deferred:
            return False
        return True

    async def _trigger_feed_stop(self, now: datetime) -> None:
        """Publish FEED_STOP_TRIGGERED and run the feed-stop policy.

        Separate from the 15:31 WebSocket close (spec §14): flush the tick
        buffer so the day's collected ticks are durable before the feed winds
        down. Connection Manager subscribers react to the published event.
        """
        details: dict = {"at_ist": now.isoformat()}
        try:
            details["ticks_flushed"] = await tick_buffer.flush()
        except Exception as exc:
            details["flush_error"] = str(exc)
        self._feed_stop_triggered = True
        record_event("scheduler", "FEED_STOP_TRIGGERED", "info",
                     "Feed-stop policy executed", details)

    # ------------------------------------------------------------------
    # State helpers
    # ------------------------------------------------------------------

    def _market_slot(self, now: datetime) -> dict:
        trading_day = _effective_trading_day(now)
        times = _sched_times()
        login_h, login_m = times["login"]
        logout_h, logout_m = times["logout"]
        ws_start_h, ws_start_m = times["ws_start"]
        tick_start_h, tick_start_m = times["tick_collection_start"]
        ws_stop_h, ws_stop_m = times["ws_stop"]
        login_at = _today_at(now, login_h, login_m)
        logout_at = _today_at(now, logout_h, logout_m)
        ws_start = _today_at(now, ws_start_h, ws_start_m)
        tick_start = _today_at(now, tick_start_h, tick_start_m)
        ws_stop = _today_at(now, ws_stop_h, ws_stop_m)
        # Windows only apply on a real trading day. On a weekend / exchange
        # holiday the scheduler never connects, so reporting them "open" would
        # be a lie — the API marks them NOT APPLICABLE instead (see below).
        in_login_window = False
        in_ws_window = False
        in_tick_collection_window = False
        if trading_day:
            # Login catch-up window extends to LOGOUT (16:00), not ws_stop (15:31).
            # This allows an afternoon restart (e.g. 14:30 or even 15:45) to
            # establish a session and complete the day's lifecycle.
            in_login_window = login_at <= now < logout_at
            in_ws_window = ws_start <= now < ws_stop
            in_tick_collection_window = tick_start <= now < ws_stop
        return {
            "trading_day": trading_day,
            "login_open": login_at,
            "logout_at": logout_at,
            "ws_start": ws_start,
            "tick_collection_start": tick_start,
            "ws_stop": ws_stop,
            "in_login_window": in_login_window,
            "in_ws_window": in_ws_window,
            "in_tick_collection_window": in_tick_collection_window,
            "past_logout": now >= logout_at,
            "past_ws_stop": now >= ws_stop,
        }

    def _set_state(self, state: str, message: str = "", source: str = "") -> None:
        with self._lock:
            changed = state != self._state
            self._state = state
            if changed or self._state_since is None:
                self._state_since = time.time()
        if changed or message:
            record_event(
                "scheduler",
                f"state:{state}",
                "error" if state in {STATE_LOGIN_FAILED, STATE_ERROR} else "info",
                message or state,
                {"from": source} if source else {},
            )
            logger.info(
                "Scheduler state -> %s%s",
                state,
                f" ({message})" if message else "",
            )
            # Push real transitions to the centralized realtime store so the
            # GlobalTopBar's SCHEDULER indicator updates the instant a phase
            # changes instead of waiting for a stream reconnect.
            if changed:
                self._publish_state_store(state, message)

    def _publish_state_store(self, state: str, message: str = "") -> None:
        """Publish the scheduler's live state to the shared realtime store.

        Best-effort and non-fatal: the SSE stream merges this into
        `state.scheduler`, which is the single source for the topbar pill.
        """
        try:
            import asyncio
            from services.state_store import set_entity_state

            try:
                running = self._is_running()
            except Exception:
                running = None

            async def _publish() -> None:
                try:
                    await set_entity_state(
                        "scheduler",
                        {"state": state, "running": running},
                        message or "scheduler_state_change",
                    )
                except Exception:
                    logger.debug("scheduler state publish failed", exc_info=True)

            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                loop = None
            if loop is not None and loop.is_running():
                loop.create_task(_publish())
        except Exception:
            logger.debug("scheduler state publish setup failed", exc_info=True)


def _today_at(now: datetime, hour: int, minute: int) -> datetime:
    return now.replace(hour=hour, minute=minute, second=0, microsecond=0)


def _sched_iso(value) -> str | None:
    """Best-effort ISO string for a stored timestamp (may be ISO or datetime)."""
    try:
        if isinstance(value, datetime):
            return value.astimezone(IST).isoformat()
        if value:
            return str(value)
    except Exception:
        return None
    return None



# ---------------------------------------------------------------------------
# Module-level singleton + backwards-compatible facade
# ---------------------------------------------------------------------------

_scheduler = SchedulerController()


def start_scheduler() -> None:
    _scheduler.start_scheduler()


def stop_scheduler() -> None:
    _scheduler.stop_scheduler()


def _sync_session_manager_view(owner: str | None) -> None:
    """Re-publish a live broker session the login skipped over.

    A skipped ("already active") or blocked ("scheduler owns it") login
    performs no broker I/O, so nothing re-registers the live session — a
    view left at LOGGING_IN (e.g. by a manual /login issued while the
    scheduler owns the session) would sit there forever and the UI would
    read "session inactive" despite a live broker session. Heal that view
    only when it isn't already active; a healthy active view is never
    touched (no id/countdown reset).
    """
    try:
        if session_manager.is_active():
            return
        if not kotak_session.session_active:
            return
        src = "scheduler" if str(owner or "").lower() == "scheduler" else "manual"
        session_manager.mark_login_success(
            mode=_active_mode_name(),
            broker="Kotak Neo",
            user_id=kotak_session.user_id or None,
            session_ref=kotak_session.session_id or None,
            lifetime_seconds=None if src == "scheduler" else MANUAL_SESSION_SECONDS,
            source=src,
        )
        logger.info("Session view synced to active (owner=%s)", owner)
    except Exception as exc:
        logger.warning("Session view sync skipped: %s", exc)


async def do_login(source: str = "scheduler", retry: int = 3) -> bool:
    return await _scheduler.do_login(source=source, retry=retry)


async def do_logout(source: str | None = None) -> bool:
    return await _scheduler.do_logout(source=source)


def get_scheduler_info() -> dict:
    return _scheduler.get_scheduler_info()


def get_scheduler_state() -> dict:
    return _scheduler.get_scheduler_state()


def get_scheduler_phases() -> dict:
    """Trading-day phase schedule (ISO instants) from the live IST clock."""
    return _scheduler.get_schedule().get("today_phase_times") or {}


def get_scheduler_readiness() -> dict:
    """Latest engine-readiness report (spec §6). Never fabricated."""
    return _scheduler.readiness_snapshot()


def get_schedule() -> dict:
    return _scheduler.get_schedule()


async def get_scheduler_summary() -> dict:
    return await _scheduler.get_scheduler_summary()


async def get_scheduler_history(limit: int = 50, business_date: str = "") -> dict:
    """Persisted scheduler run ledger — the honest execution history.

    Reads straight from MongoDB ``scheduler_runs`` (newest-first). ``limit``
    is clamped so an over-large request can never return unbounded rows.
    """
    try:
        from services.json_safe import sanitize_for_json
        db = get_db()
        q: dict = {}
        if business_date:
            q["business_date"] = business_date
        cursor = db.scheduler_runs.find(
            q, {"_id": 0}
        ).sort([("scheduled_at", -1)]).limit(min(max(limit, 1), 500))
        rows = [doc async for doc in cursor]
        return {"count": len(rows), "business_date": business_date, "runs": sanitize_for_json(rows)}
    except Exception as exc:
        logger.warning("get_scheduler_history failed: %s", exc)
        return {"count": 0, "business_date": business_date, "runs": []}


def request_reconcile() -> None:
    _scheduler.request_reconcile()


def notify_auth_failure() -> None:
    _scheduler.notify_auth_failure()


async def get_scheduler_runs(
    *,
    business_date: str = "",
    job_id: str = "",
    status: str = "",
    trigger: str = "",
    schedule_id: str = "",
    search: str = "",
    failed_only: bool = False,
    catch_up_only: bool = False,
    sort: str = "scheduled_at",
    order: str = "desc",
    page: int = 1,
    page_size: int = 20,
) -> dict:
    """Paginated scheduler-run ledger (real persisted ``scheduler_runs``)."""
    from scheduler.persist import scheduler_ledger
    return await scheduler_ledger.list_runs(
        business_date=business_date,
        job_id=job_id,
        status=status,
        trigger=trigger,
        schedule_id=schedule_id,
        search=search,
        failed_only=failed_only,
        catch_up_only=catch_up_only,
        sort=sort,
        order=order,
        page=page,
        page_size=page_size,
    )


async def get_scheduler_run(run_id: str) -> dict | None:
    """One run by its deterministic execution_id (None when not found)."""
    from scheduler.persist import scheduler_ledger
    return await scheduler_ledger.get_run_by_execution_id(run_id)


# ---------------------------------------------------------------------------
# Settings-page preview — the LIVE effective scheduler configuration
# ---------------------------------------------------------------------------

_PREVIEW_ORDER = [
    ("sched_login_time", "login", "Broker session login"),
    ("sched_ws_start_time", "ws_start", "WebSocket feed connect"),
    ("sched_tick_collection_start_time", "tick_collection_start", "Tick capture start"),
    ("sched_pre_market_start_time", "pre_market", "Pre-market phase"),
    ("sched_limit_order_start_time", "limit_order", "Limit-order window"),
    ("sched_equilibrium_start_time", "equilibrium", "Equilibrium phase"),
    ("sched_buffer_start_time", "buffer", "Buffer phase"),
    ("sched_feed_start_time", "feed_start", "Live feed phase"),
    ("sched_square_off_time", "square_off", "Square-off trigger"),
    ("sched_feed_stop_time", "feed_stop", "Broker feed stop"),
    ("sched_ws_stop_time", "ws_stop", "WebSocket disconnect"),
    ("sched_logout_time", "logout", "Broker session logout"),
    ("mwr_friday_scan_hhmm", "market_watch_friday_scan", "Market Watch Friday scan"),
]


async def effective_settings_preview() -> dict:
    """GET /api/scheduler/settings-preview backend payload.

    Resolves every scheduled key EXACTLY the way the engine resolves it —
    runtime cache (TTL-cached Mongo) → env default — and pairs it with the
    persisted source (`db` vs `default`), the effective HH:MM, the next
    occurrence under the configured trading-day behaviour, and the ordering
    validation issues. Nothing is invented: keys resolve through the same
    ``_sched_times()`` path the state machine uses on every tick.
    """
    from services.settings_service import DEFAULTS as _DEFS, get_all_settings

    sched = _scheduler.get_schedule()
    times = _sched_times()
    now = _now_market()
    try:
        stored = await get_all_settings()
    except Exception:
        stored = {}

    # For the "next occurrence" computation: today when the event's time is
    # still ahead AND today is admitted by the behaviour, otherwise the next
    # admitted day.
    behavior_ref = _next_effective_trading_day(now.date()) or now.date()

    def _hhmm(pair) -> str:
        return f"{pair[0]:02d}:{pair[1]:02d}"

    entries: list[dict] = []
    for db_key, sched_key, label in _PREVIEW_ORDER:
        pair = times.get(sched_key)
        value_doc = stored.get(db_key)
        # get_all_settings() always returns a FULL map — an effective value
        # exists for every DEFAULTS key even when Mongo has no row. The
        # persisted-override marker is `updatedAt`, never doc presence.
        has_db = value_doc is not None and value_doc.get("updatedAt") is not None
        default_hhmm = _DEFS.get(db_key, {}).get("value")
        entry: dict[str, Any] = {
            "key": db_key,
            "label": label,
            "effective": _hhmm(pair) if pair else None,
            "source": "db" if has_db else "default",
            "db_value": value_doc.get("value") if has_db else None,
            "default_value": default_hhmm,
            "live": True,
        }
        if pair is not None and sched_key != "market_watch_friday_scan":
            target = None
            # "Today if ahead" applies ONLY when today is actually admitted by
            # the configured trading-day behaviour — on a weekend / holiday the
            # engine will NOT fire today's slot, so the next occurrence rolls
            # to the next admitted day (behaviour-aware, same as the machine).
            if sched.get("today_trading_day") is not False:
                today_at = _day_at(now, pair[0], pair[1])
                if today_at > now:
                    target = today_at
            if target is None:
                target = _day_at(behavior_ref, pair[0], pair[1])
            entry["next_at"] = target.isoformat()
            entry["remaining_seconds"] = round((target - now).total_seconds(), 1)
        entries.append(entry)

    issues = sched.get("issues", [])
    return {
        "now": now.isoformat(),
        "market_timezone": _configured_market_tzname(),
        "timezone_label": _market_tz_label(),
        "timezone_is_default": _configured_market_tzname() == _MARKET_TZ_DEFAULT,
        "trading_day_behavior": _trading_day_behavior(),
        "today_trading_day": sched.get("today_trading_day"),
        "next_trading_day": sched.get("next_trading_day"),
        "next_event": sched.get("next_event"),
        "next_event_at": sched.get("next_event_at"),
        "next_event_remaining_seconds": sched.get("remaining_seconds"),
        "entries": entries,
        "issues": issues,
        "issues_ok": not any(i["severity"] == "error" for i in issues),
        "issue_error_count": sched.get("issues_error_count", 0),
        "issue_warning_count": sched.get("issues_warning_count", 0),
        "reconcile_tick_seconds": getattr(_scheduler, "_tick_seconds", 5),
        "note": (
            "Save karte hi settings_service runtime cache turant refresh karti hai "
            "aur scheduler wake ho jata hai — engine is preview ko reconcile tick "
            f"(~{getattr(_scheduler, '_tick_seconds', 5)}s) me live adopt karta hai."
        ),
    }