from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import random
import socket
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Any

from auth.kotak_client import kotak_session
from config.settings import settings
from services.runtime_settings import rt_bool, rt_int, get_runtime_setting

logger = logging.getLogger("websocket")

_PROCESS_STARTED_AT = time.time()

# ---------------------------------------------------------------------------
# Supervisor states — explicit state machine for the broker WebSocket lifecycle
# ---------------------------------------------------------------------------
SUPERVISOR_STOPPED = "STOPPED"
SUPERVISOR_WAITING = "WAITING_FOR_MARKET_WINDOW"
SUPERVISOR_CONNECTING = "CONNECTING"
SUPERVISOR_CONNECTED = "CONNECTED"
SUPERVISOR_DISCONNECTED = "DISCONNECTED"
SUPERVISOR_RECONNECTING = "RECONNECTING"
SUPERVISOR_AUTH_REQUIRED = "AUTH_REQUIRED"
SUPERVISOR_AUTH_FAILED = "AUTH_FAILED"
SUPERVISOR_NETWORK_OFFLINE = "NETWORK_OFFLINE"
SUPERVISOR_BROKER_UNAVAILABLE = "BROKER_UNAVAILABLE"
SUPERVISOR_STOPPING = "STOPPING"
SUPERVISOR_ERROR = "ERROR"

# Reconnect backoff: 1, 2, 4, 8, 15, 30, 60 seconds (capped)
_RECONNECT_DELAYS = [1.0, 2.0, 4.0, 8.0, 15.0, 30.0, 60.0]

# Internet check interval (seconds)
_INTERNET_CHECK_INTERVAL = 10.0

# Market window IST
from core.timezones import IST

# Controlled disconnect-reason taxonomy.
WS_REASON_CODES: dict[str, str] = {
    "scheduled_disconnect": "scheduled_disconnect",
    "session_expired": "session_expired",
    "manual_logout": "manual_logout",
    "logout": "manual_logout",
    "broker_closed": "broker_closed",
    "broker_rejected": "broker_rejected",
    "authentication_failed": "authentication_failed",
    "network_error": "network_error",
    "internet_disconnected": "internet_disconnected",
    "websocket_error": "websocket_error",
    "heartbeat_timeout": "heartbeat_timeout",
    "server_restart": "server_restart",
    "application_shutdown": "application_shutdown",
    "market_closed": "market_closed",
    "market_window_end": "market_window_end",
    "duplicate_connection_prevented": "duplicate_connection_prevented",
    "unknown_error": "unknown_error",
}

_PHRASE_TO_CODE = {
    "Authentication failure": "authentication_failed",
    "Connection refused": "broker_rejected",
    "Timeout": "network_error",
    "Network error": "network_error",
    "Server unavailable": "broker_closed",
    "WebSocket closed": "websocket_error",
    "Unknown": "unknown_error",
}


def _reason_code(reason: str | None) -> str:
    if not reason:
        return "unknown_error"
    if reason in WS_REASON_CODES:
        return WS_REASON_CODES[reason]
    r = str(reason).strip().lower()
    for key in WS_REASON_CODES:
        if key in r:
            return WS_REASON_CODES[key]
    for phrase, code in _PHRASE_TO_CODE.items():
        if phrase.lower() in r:
            return code
    return "unknown_error"


def _lifecycle_state(state: str, connected: bool) -> str:
    if state == SUPERVISOR_CONNECTED and connected:
        return "WS_CONNECTED"
    if state == SUPERVISOR_CONNECTING:
        return "WS_CONNECTING"
    if state in {SUPERVISOR_RECONNECTING, SUPERVISOR_NETWORK_OFFLINE, SUPERVISOR_AUTH_REQUIRED}:
        return "WS_RECONNECTING"
    if state in {SUPERVISOR_ERROR, SUPERVISOR_AUTH_FAILED, SUPERVISOR_BROKER_UNAVAILABLE}:
        return "WS_ERROR"
    if state in {SUPERVISOR_DISCONNECTED, SUPERVISOR_STOPPED, SUPERVISOR_STOPPING}:
        return "WS_DISCONNECTED"
    if state == SUPERVISOR_CONNECTED and not connected:
        return "WS_RECONNECTING"
    return "WS_WAITING"


def _iso(seconds: float | None) -> str | None:
    if seconds is None:
        return None
    return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat()


def _new_ws_id() -> str:
    """Readable connection id next to the history service format.

    ``ws_20260909_143621_bf3ac`` — IST-stamped so connection tables and the
    monitor are trivially sortable/identifiable by humans.
    """
    stamp = datetime.now(IST).strftime("%Y%m%d_%H%M%S")
    return f"ws_{stamp}_{uuid.uuid4().hex[:5]}"


def _session_duration(st: dict) -> float | None:
    """Uptime (sec) of the current live session, or None when not connected."""
    if not st.get("connected") or not st.get("connected_at"):
        return None
    try:
        start = datetime.fromisoformat(st["connected_at"])
        return round((datetime.now(timezone.utc) - start).total_seconds(), 1)
    except Exception:
        return None


def _classify_reason(error, message) -> str | None:
    chunks = " ".join(
        str(x) for x in (error, message) if x not in (None, "")
    ).lower()
    if not chunks:
        return None
    if "refused" in chunks:
        return "Connection refused"
    if "timed out" in chunks or "timeout" in chunks:
        return "Timeout"
    if any(w in chunks for w in ("authentication", "invalid token", "unauthor")):
        return "Authentication failure"
    if any(w in chunks for w in ("dns", "no address", "host not found")):
        return "Network error"
    if any(w in chunks for w in ("unavailable", "503", "unreachable")):
        return "Server unavailable"
    if error is not None:
        return "Network error"
    return "WebSocket closed"


def _chain_coros(*coros):
    async def _runner() -> None:
        for c in coros:
            try:
                await c
            except Exception:
                logger.debug("Chained websocket persistence coroutine failed", exc_info=True)
    return _runner()


# ---------------------------------------------------------------------------
# Internet connectivity check (cross-platform, non-blocking)
# ---------------------------------------------------------------------------

async def _check_internet() -> bool:
    """Check if the internet is reachable by resolving a DNS name."""
    try:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, socket.gethostbyname, "google.com")
        return True
    except (socket.gaierror, OSError, asyncio.TimeoutError):
        return False


def _is_market_window(now_ist: datetime | None = None) -> bool:
    """Check if current IST time is within the market feed window.

    Uses the LIVE ``sched_ws_start_time`` / ``sched_ws_stop_time`` runtime
    settings (env defaults as fallback) AND the holiday-aware trading calendar
    — not a bare weekday check — so exchange holidays are never treated as open
    and a Settings edit takes effect on the next supervisor tick.
    """
    now = now_ist or datetime.now(IST)
    try:
        from services.market_calendar import is_trading_day
        if not is_trading_day(now.date()):
            return False
    except Exception:
        if now.weekday() >= 5:
            return False
    try:
        from services.runtime_settings import rt_hhmm
        start_h, start_m = rt_hhmm(
            "sched_ws_start_time", settings.ws_start_hour, settings.ws_start_minute)
        stop_h, stop_m = rt_hhmm(
            "sched_ws_stop_time", settings.ws_stop_hour, settings.ws_stop_minute)
    except Exception:
        start_h, start_m, stop_h, stop_m = (
            settings.ws_start_hour, settings.ws_start_minute,
            settings.ws_stop_hour, settings.ws_stop_minute,
        )
    ws_start = now.replace(
        hour=start_h, minute=start_m,
        second=0, microsecond=0,
    )
    ws_stop = now.replace(
        hour=stop_h, minute=stop_m,
        second=0, microsecond=0,
    )
    return ws_start <= now < ws_stop


def _report_session_ws(method: str, *args) -> None:
    """Forward a real broker-WebSocket lifecycle event into the central Session
    Manager, making it the authoritative WS session state (WS_CONNECTING /
    WS_ACTIVE / SESSION_ACTIVE). Never raises; missing/cold session manager is
    a no-op. Safe from any thread (session_manager is RLock-protected).
    """
    try:
        from services.session.session_manager import session_manager
        fn = getattr(session_manager, method, None)
        if fn is not None:
            fn(*args)
    except Exception:
        logger.debug("session_manager.%s report skipped", method, exc_info=True)


class WebSocketManager:
    """WebSocket manager for the kotakneoapi (v3) SFeedWebSocket feed.

    Now includes a BrokerWebSocketSupervisor that owns the connection lifecycle
    during the market window (09:13-15:31 IST). The supervisor automatically
    reconnects on any recoverable failure with exponential backoff.
    """

    def __init__(self):
        self._lock = threading.RLock()
        self._connected = False
        self._subscribed_tokens: list[dict] = []
        self._token_symbols: dict[str, str] = {}
        # Actual feed family subscribed per instrument: "L4" | "L8" | "L16" | "INDEX"
        self._subscribed_feed_levels: dict[str, str] = {}
        self._last_tick_at: float | None = None
        self._last_message_at: float | None = None
        self._tick_count = 0
        self._subscribe_lock = asyncio.Lock()
        self._subscribe_generation = 0

        # ---- v3 socket state ----
        self._ws: Any = None
        self._reader_task: asyncio.Task | None = None
        self._last_connect_error: str | None = None

        # ---- Real connection lifecycle tracking ----
        self._connected_at: float | None = None
        self._disconnected_at: float | None = None
        self._last_connection_at: float | None = None
        self._disconnect_reason: str | None = None
        self._disconnect_reason_code: str | None = None
        self._pending_error: str | None = None
        self._connection_history: deque[dict] = deque(maxlen=200)
        self._websocket_id: str = _new_ws_id()
        self._session_id: str | None = None
        self._counter_update_task: asyncio.Task | None = None
        self._live_publish_task: asyncio.Task | None = None
        self._stale_feed_flagged: bool = False

        # Rolling rate counters (timestamps of recent events)
        self._recent_messages: deque[float] = deque()  # timestamps of recent messages
        self._recent_ticks: deque[float] = deque()     # timestamps of recent ticks

        self._state: str = "DISCONNECTED"

        # ---- Feed diagnostics (real, from actual SFeed messages) ----
        self._total_messages_received: int = 0
        self._total_ticks_valid: int = 0
        self._total_ticks_rejected: int = 0
        self._total_parse_errors: int = 0
        self._total_malformed: int = 0
        self._total_heartbeat: int = 0
        self._total_subscription_acks: int = 0
        self._total_market_status: int = 0
        self._total_index_messages: int = 0
        self._total_cas_change: int = 0
        self._last_message_type: str | None = None
        self._feed_state: str = "NO_FEED"  # NO_FEED / RECEIVING / STALE
        self._feed_state_since: float = time.time()
        self._messages_by_type: dict[str, int] = {}

        self._metrics = {
            "ticks_received": 0,
            "ticks_validated": 0,
            "ticks_rejected": 0,
            "connects": 0,
            "disconnects": 0,
            "errors": 0,
            "subscribe_calls": 0,
            "unsubscribe_calls": 0,
            "duplicate_subscriptions_blocked": 0,
        }

        # ---- Supervisor state machine ----
        self._supervisor_state: str = SUPERVISOR_STOPPED
        self._supervisor_task: asyncio.Task | None = None
        self._supervisor_event: asyncio.Event = asyncio.Event()
        self._supervisor_start_requested: bool = False
        self._supervisor_stop_requested: bool = False
        self._supervisor_reconnect_attempt: int = 0
        self._supervisor_last_internet_check: float = 0.0
        self._supervisor_internet_ok: bool = True
        # Subscription registry — survives reconnects
        self._subscription_registry: list[dict] = []
        # Engine publish hook — set by the WebSocket Engine to fan out every
        # decoded SFeed message (optional; absent = no-op).
        self._publish_hook = None

    # ------------------------------------------------------------------
    # SUPERVISOR — Public lifecycle API
    # ------------------------------------------------------------------

    def start_supervisor(self) -> None:
        """Request the supervisor to start (called by scheduler at 09:13)."""
        logger.info("[WS-SUPERVISOR] start requested")
        self._supervisor_start_requested = True
        self._supervisor_stop_requested = False
        with self._lock:
            if self._supervisor_task is not None and not self._supervisor_task.done():
                # Already running — just signal it
                self._signal_supervisor()
                return
        # Launch on the app loop
        try:
            from core.event_loop import get_loop
            loop = get_loop()
            if loop.is_running():
                loop.call_soon_threadsafe(self._launch_supervisor)
        except RuntimeError:
            logger.error("[WS-SUPERVISOR] Cannot start: event loop not ready")

    def stop_supervisor(self) -> None:
        """Request the supervisor to stop (called by scheduler at 15:31)."""
        logger.info("[WS-SUPERVISOR] stop requested")
        self._supervisor_stop_requested = True
        self._supervisor_start_requested = False
        self._signal_supervisor()

    def get_supervisor_state(self) -> str:
        """Return the current supervisor state for status reporting."""
        with self._lock:
            return self._supervisor_state

    # ------------------------------------------------------------------
    # SUPERVISOR — Internal
    # ------------------------------------------------------------------

    def _launch_supervisor(self) -> None:
        """Launch the supervisor task on the current event loop."""
        task = self._supervisor_task
        if task is not None and not task.done():
            return
        self._supervisor_event = asyncio.Event()
        try:
            self._supervisor_task = asyncio.ensure_future(self._supervisor_loop())
            self._supervisor_task.add_done_callback(self._on_supervisor_done)
        except RuntimeError:
            logger.exception("[WS-SUPERVISOR] Failed to launch")

    def _on_supervisor_done(self, task: asyncio.Task) -> None:
        if task.cancelled():
            return
        if task.exception() is not None:
            logger.exception("[WS-SUPERVISOR] Supervisor crashed", exc_info=task.exception())
            # Auto-relaunch
            try:
                from core.event_loop import get_loop
                loop = get_loop()
                if loop.is_running():
                    loop.call_soon_threadsafe(self._launch_supervisor)
            except RuntimeError:
                pass

    def _signal_supervisor(self) -> None:
        """Wake the supervisor from its sleep."""
        try:
            self._supervisor_event.set()
        except Exception:
            pass

    def _set_supervisor_state(self, state: str, reason: str = "") -> None:
        """Transition the supervisor state machine, publish on actual change."""
        with self._lock:
            old = self._supervisor_state
            if old == state:
                return
            self._supervisor_state = state
        logger.info(
            "[WS-SUPERVISOR] state=%s -> %s%s",
            old, state, f" reason={reason}" if reason else "",
        )
        self._publish_ws_state(state, reason)
        # Mirror the supervisor transition into the central session manager so
        # the WS session state stays authoritative (idempotent stamps).
        try:
            if state == SUPERVISOR_CONNECTING:
                _report_session_ws("mark_ws_connecting")
            elif state == SUPERVISOR_CONNECTED:
                _report_session_ws("mark_ws_connected")
            elif state == SUPERVISOR_RECONNECTING:
                _report_session_ws("mark_ws_reconnecting")
            elif state in {SUPERVISOR_DISCONNECTED, SUPERVISOR_STOPPED,
                           SUPERVISOR_STOPPING, SUPERVISOR_WAITING, SUPERVISOR_ERROR}:
                _report_session_ws("mark_ws_disconnected", (reason or state)[:200])
        except Exception:
            pass

    async def _supervisor_loop(self) -> None:
        """Main supervisor loop — runs for the lifetime of the supervisor task."""
        import os as _os
        logger.info("[WS-SUPERVISOR] supervisor loop started (instance=%s)", _os.getpid())
        while not self._supervisor_stop_requested:
            try:
                await self._supervisor_tick()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.exception("[WS-SUPERVISOR] tick error: %s", exc)
                self._set_supervisor_state(SUPERVISOR_ERROR, str(exc))
            # Sleep with interrupt capability
            try:
                self._supervisor_event.clear()
                await asyncio.wait_for(self._supervisor_event.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                pass

        # Clean shutdown
        self._set_supervisor_state(SUPERVISOR_STOPPING)
        await self._supervisor_teardown()
        self._set_supervisor_state(SUPERVISOR_STOPPED, "supervisor stopped")
        logger.info("[WS-SUPERVISOR] supervisor loop ended")

    async def _supervisor_tick(self) -> None:
        """Single tick of the supervisor state machine."""
        state = self._supervisor_state

        # If stop was requested, transition out
        if self._supervisor_stop_requested:
            if state not in {SUPERVISOR_STOPPED, SUPERVISOR_STOPPING}:
                await self._supervisor_teardown()
                self._set_supervisor_state(SUPERVISOR_STOPPED, "market_window_end")
            return

        # Check if we should be in the market window
        if not _is_market_window():
            if state not in {SUPERVISOR_STOPPED, SUPERVISOR_WAITING}:
                await self._supervisor_teardown()
            self._set_supervisor_state(SUPERVISOR_WAITING)
            return

        # Broker WebSocket disabled in Settings → never connect or reconnect
        # (the scheduler parks it here; re-enabling resumes on the next tick).
        if not rt_bool("ws_enabled", True):
            if state not in {SUPERVISOR_STOPPED, SUPERVISOR_WAITING}:
                await self._supervisor_teardown()
            self._set_supervisor_state(SUPERVISOR_WAITING, "ws disabled in settings")
            return

        # In market window — check session
        if not kotak_session.session_active:
            if state != SUPERVISOR_AUTH_REQUIRED:
                self._set_supervisor_state(SUPERVISOR_AUTH_REQUIRED, "session not active")
            return

        # Check internet connectivity
        now = time.time()
        if now - self._supervisor_last_internet_check > _INTERNET_CHECK_INTERVAL:
            self._supervisor_last_internet_check = now
            internet_ok = await _check_internet()
            self._supervisor_internet_ok = internet_ok
            if not internet_ok:
                if state != SUPERVISOR_NETWORK_OFFLINE:
                    self._set_supervisor_state(SUPERVISOR_NETWORK_OFFLINE, "no internet")
                # Feed network state into MarketStateService
                try:
                    from services.market_state import market_state_service
                    market_state_service.on_network_offline()
                except Exception:
                    pass
                return
            else:
                # Feed network restored into MarketStateService
                try:
                    from services.market_state import market_state_service
                    market_state_service.on_network_online()
                except Exception:
                    pass

        if not self._supervisor_internet_ok:
            # Re-check more frequently when offline
            self._supervisor_last_internet_check = 0.0
            if state != SUPERVISOR_NETWORK_OFFLINE:
                self._set_supervisor_state(SUPERVISOR_NETWORK_OFFLINE, "no internet")
            return

        # We have internet and a valid session inside the market window
        if state in {SUPERVISOR_WAITING, SUPERVISOR_STOPPED}:
            # First time entering the market window — connect
            self._set_supervisor_state(SUPERVISOR_CONNECTING, "market_window_open")
            await self._supervisor_connect()
            return

        if state == SUPERVISOR_AUTH_REQUIRED:
            # Session just became active — try connecting
            self._set_supervisor_state(SUPERVISOR_CONNECTING, "session_available")
            await self._supervisor_connect()
            return

        if state == SUPERVISOR_NETWORK_OFFLINE:
            # Internet came back — reconnect
            self._set_supervisor_state(SUPERVISOR_RECONNECTING, "internet_restored")
            self._supervisor_reconnect_attempt = 0
            await self._supervisor_connect()
            return

        if state == SUPERVISOR_DISCONNECTED:
            # Unexpected disconnect — reconnect (unless disabled in Settings)
            if not rt_bool("ws_auto_reconnect", True):
                if self._supervisor_state != SUPERVISOR_DISCONNECTED:
                    self._set_supervisor_state(SUPERVISOR_DISCONNECTED, "auto-reconnect disabled")
                return
            self._set_supervisor_state(SUPERVISOR_RECONNECTING, "unexpected_disconnect")
            self._supervisor_reconnect_attempt = 0
            await self._supervisor_connect()
            return

        if state == SUPERVISOR_RECONNECTING:
            # Backoff retry (bounded by the configured attempt cap, if any)
            max_attempts = rt_int("ws_max_reconnect_attempts", 0)
            if max_attempts > 0 and self._supervisor_reconnect_attempt >= max_attempts:
                self._record_reconnect_exhausted(max_attempts)
                return
            delay = self._get_reconnect_delay(self._supervisor_reconnect_attempt)
            logger.info(
                "[WS-SUPERVISOR] reconnecting attempt=%d delay=%.1fs",
                self._supervisor_reconnect_attempt, delay,
            )
            self._record_reconnect_attempt(self._supervisor_reconnect_attempt, delay)
            await asyncio.sleep(delay)
            self._supervisor_reconnect_attempt += 1
            await self._supervisor_connect()
            return

        if state in {SUPERVISOR_CONNECTED, SUPERVISOR_CONNECTING}:
            # Verify the connection is still alive
            with self._lock:
                ws_alive = self._ws is not None and self._connected
            if not ws_alive and state == SUPERVISOR_CONNECTED:
                self._set_supervisor_state(SUPERVISOR_DISCONNECTED, "connection_lost")
            return

    def _get_reconnect_delay(self, attempt: int) -> float:
        """Reconnect backoff, honouring the live Settings knobs:

        * ``ws_reconnect_delay_ms`` sets the configured base delay.
        * ``ws_backoff`` toggles exponential growth (capped at that delay)
          vs. a fixed delay.
        * Full jitter de-synchronizes reconnect storms.
        """
        base = _RECONNECT_DELAYS[attempt] if attempt < len(_RECONNECT_DELAYS) else _RECONNECT_DELAYS[-1]
        delay_ms = rt_int("ws_reconnect_delay_ms", 0)
        if delay_ms and delay_ms > 0:
            configured = delay_ms / 1000.0
            if rt_bool("ws_backoff", True):
                base = min(float(2 ** min(attempt, 6)), configured)
            else:
                base = configured
        return base * random.uniform(0.5, 1.0)

    def _record_reconnect_exhausted(self, max_attempts: int) -> None:
        """Stop the supervisor cleanly after the configured reconnect cap."""
        with self._lock:
            self._connection_history.append({
                "event": "reconnect_exhausted",
                "at": _iso(time.time()),
                "status": "stopped",
                "reason": f"reconnect attempts exhausted ({max_attempts})",
            })
        self._set_supervisor_state(
            SUPERVISOR_STOPPED, f"reconnect attempts exhausted ({max_attempts})"
        )
        try:
            from services.notification_center import emit_event as record_event
            record_event(
                "websocket", "ws_reconnect_exhausted", "warning",
                f"WebSocket reconnect stopped after {max_attempts} attempts",
            )
        except Exception:
            pass
        logger.warning("WebSocket reconnect exhausted after %d attempts", max_attempts)

    async def _supervisor_connect(self) -> None:
        """Attempt to connect and subscribe — called by the supervisor loop."""
        self._set_supervisor_state(SUPERVISOR_CONNECTING)
        _report_session_ws("mark_ws_connecting")
        ws = await self._connect_fresh()
        if ws is None:
            error = self._last_connect_error or "connect failed"
            logger.warning(
                "[WS-SUPERVISOR] supervisor_connect: failed attempt=%d error=%s",
                self._supervisor_reconnect_attempt, error,
            )
            if "authentication" in error.lower() or "Authentication" in error:
                self._set_supervisor_state(SUPERVISOR_AUTH_FAILED, error)
                _notify_auth_failure()
                return
            if not self._supervisor_internet_ok:
                self._set_supervisor_state(SUPERVISOR_NETWORK_OFFLINE, error)
                return
            # Non-fatal: schedule reconnect with backoff
            self._set_supervisor_state(SUPERVISOR_RECONNECTING, error)
            return

        # Connected — restore subscriptions from registry
        await self._supervisor_restore_subscriptions()

    async def _supervisor_restore_subscriptions(self) -> None:
        """Re-subscribe all tokens from the subscription registry.

        If the registry is empty (e.g. after a process restart), rebuild it
        from the MongoDB ``stocks`` collection (active: true).
        """
        with self._lock:
            registry = list(self._subscription_registry)
        if not registry:
            # Self-healing: rebuild from the Session Manager's desired set first
            # (single source of truth). MongoDB fallback is ONLY allowed when
            # no daily universe has been applied (legacy/pre-intent). If
            # daily_universe_desired >0 but registry is still empty (e.g. transient
            # hydrate failure), do NOT silently shrink to db.stocks — keep empty
            # and retry next tick so WS#1 restores the full eligible universe after reconnect.
            registry = await self._reload_subscriptions_from_session_manager()
            if not registry:
                # Check intent before falling back to DB
                try:
                    from services.session.session_manager import session_manager
                    snap = session_manager.daily_intent_snapshot() or {}
                    desired = int(snap.get("daily_universe_desired") or 0)
                except Exception:
                    desired = 0
                if desired <= 0:
                    registry = await self._reload_subscriptions_from_db()
                else:
                    logger.warning("[WS-SUPERVISOR] daily_universe_desired=%d but session_manager returned empty desired — not falling back to db.stocks (will retry)", desired)
            if not registry:
                self._set_supervisor_state(SUPERVISOR_CONNECTED, "connected (no subscriptions)")
                if self._supervisor_reconnect_attempt > 0:
                    self._record_reconnected(self._supervisor_reconnect_attempt)
                logger.info("[WS-SUPERVISOR] subscriptions_restored count=0 (empty registry, no desired subscriptions)")
                return

        result = await self.subscribe(registry)
        count = result.get("count", 0)
        self._set_supervisor_state(SUPERVISOR_CONNECTED, "connected")
        if self._supervisor_reconnect_attempt > 0:
            self._record_reconnected(self._supervisor_reconnect_attempt)
        logger.info("[WS-SUPERVISOR] subscriptions_restored count=%d", count)
        logger.info("[WS-SUPERVISOR] ticks_resumed")
        # Feed subscription event into MarketStateService
        try:
            from services.market_state import market_state_service
            total_subs = len(self._subscription_registry)
            market_state_service.on_subscriptions_ready(total_subs)
        except Exception:
            pass

    async def _reload_subscriptions_from_session_manager(self) -> list[dict]:
        """Rebuild the WS registry from the Session Manager's desired set.

        The Session Manager is the authoritative source of what should be
        subscribed; this keeps the supervisor honest with the engine even
        after a process restart. When the current-day Market Watch daily
        universe intent has been applied, the desired set is read as-is —
        never re-derived from ``db.stocks`` (which would silently shrink a
        2,600+ symbol universe back to a handful).
        """
        try:
            from services.session.session_manager import session_manager
            universe_desired = 0
            try:
                snap = session_manager.daily_intent_snapshot() or {}
                universe_desired = int(snap.get("daily_universe_desired") or 0)
            except Exception:  # noqa: BLE001 - snapshot is best-effort
                universe_desired = 0
            if universe_desired <= 0:
                # Legacy/boot path (no daily universe applied yet): overlay
                # db.stocks desired records, then read the merged set.
                await session_manager.refresh_desired_subscriptions(force=True)
            tokens = session_manager.subscription_desired_keys()
        except Exception as exc:
            logger.warning("[WS-SUPERVISOR] reload subscriptions from session manager failed: %s", exc)
            return []
        if not tokens:
            logger.info("[WS-SUPERVISOR] no desired subscriptions from session manager")
            return []
        with self._lock:
            self._update_subscription_registry(tokens)
        logger.info(
            "[WS-SUPERVISOR] Rebuilt subscription registry from session manager: %d tokens "
            "(daily_universe_desired=%d)",
            len(tokens), universe_desired,
        )
        return tokens

    async def _reload_subscriptions_from_db(self) -> list[dict]:
        """Load active stocks from MongoDB and build token dicts for WS subscription."""
        try:
            from database.connection import get_db
            db = get_db()
            cursor = db.stocks.find({"active": True})
            stocks = await cursor.to_list(length=500)
            if not stocks:
                logger.info("[WS-SUPERVISOR] No active stocks in DB to subscribe")
                return []
            tokens = []
            for s in stocks:
                token_val = s.get("token") or s.get("instrumentToken") or s.get("instrument_token")
                if not token_val:
                    continue
                is_index = bool(s.get("isIndex", False))
                if is_index:
                    feed_flags = {
                        "isIndex": True,
                        "isDepth": False,
                        "feedLevel": None,
                        "marketData": "INDEX",
                    }
                else:
                    # Default market-data feed for every equity is L8 depth.
                    # Stale L4 flags are promoted (never downgraded).
                    feed_flags = {
                        "isIndex": False,
                        "isDepth": True,
                        "feedLevel": 8,
                        "marketData": "L8",
                    }
                tokens.append({
                    "instrument_token": str(token_val),
                    "exchange_segment": str(s.get("exchangeSegment", "nse_cm")),
                    "symbol": str(s.get("symbol", s.get("tradingSymbol", ""))),
                    **feed_flags,
                })
            if tokens:
                # Update the in-memory registry so future reconnects use it
                self._update_subscription_registry(tokens)
                logger.info(
                    "[WS-SUPERVISOR] Rebuilt subscription registry from DB: %d tokens", len(tokens)
                )
            return tokens
        except Exception as exc:
            logger.warning("[WS-SUPERVISOR] Failed to reload subscriptions from DB: %s", exc)
            return []

    async def _supervisor_teardown(self) -> None:
        """Cleanly close the WebSocket connection."""
        with self._lock:
            was_connected = self._connected
            ws = self._ws
            reader = self._reader_task

        if reader is not None and not reader.done():
            reader.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await reader
        if ws is not None:
            with contextlib.suppress(Exception):
                await ws.close()

        with self._lock:
            self._ws = None
            self._reader_task = None
            if was_connected:
                self._connected = False
                self._disconnected_at = time.time()

    # ------------------------------------------------------------------
    # SDK CALLBACKS (bound to the live SFeedWebSocket)
    # ------------------------------------------------------------------

    def _on_open(self, message=None):
        with self._lock:
            self._websocket_id = _new_ws_id()
            self._connected = True
            self._metrics["connects"] += 1
            self._stale_feed_flagged = False
            now = time.time()
            self._connected_at = now
            self._last_connection_at = now
            self._disconnected_at = None
            self._disconnect_reason = None
            self._disconnect_reason_code = None
            self._pending_error = None
            self._state = "CONNECTED"
            self._session_id = self._read_central_session_id()
            self._connection_history.append({
                "event": "connect",
                "at": _iso(now),
                "status": "connected",
                "reason": "connected" if message is None else str(message)[:200],
            })
        # Feed connection event into MarketStateService
        try:
            from services.market_state import market_state_service
            market_state_service.on_websocket_connected()
        except Exception:
            pass
        self._start_reader()
        try:
            self._counter_update_task = asyncio.ensure_future(self._periodic_counter_update())
        except Exception:
            pass
        self._start_live_publisher()
        self._record_event("connected", "WebSocket feed connected",
                           reason_code="ws_connect", severity="info")
        self._persist_connect()
        self._publish_ws_state("CONNECTED", "connected")
        # The broker feed is genuinely open — notify market-data engines that
        # track the feed lifecycle (so feed_state is truthful, not stuck).
        self._publish_ws_engine_event("WEBSOCKET_CONNECTED", {"reason": "connected"})
        # The broker feed is genuinely open — record it in the session manager.
        _report_session_ws("mark_ws_connected")
        # Reset reconnect counter on successful connection
        self._supervisor_reconnect_attempt = 0
        logger.info("[WS-SUPERVISOR] state=CONNECTED message=%s", message)

    @staticmethod
    def _read_central_session_id() -> str | None:
        try:
            from services.session.session_manager import session_manager
            return session_manager.snapshot().get("sessionId")
        except Exception:
            return None

    def _on_error(self, error):
        with self._lock:
            self._metrics["errors"] += 1
            self._pending_error = str(error) if error else None
        # Log full error details — str(error) is often empty for WebSocket exceptions
        exc_type = type(error).__name__ if error else "None"
        exc_repr = repr(error) if error else "None"
        logger.error(
            "[WS-SUPERVISOR] sdk_error: type=%s str=%s repr=%s",
            exc_type, error, exc_repr,
        )

    def _on_external_disconnect(self):
        self._on_close(self._pending_error or None)

    def _on_close(self, message=None):
        if hasattr(self, '_counter_update_task') and self._counter_update_task:
            self._counter_update_task.cancel()
            self._counter_update_task = None
        if hasattr(self, '_live_publish_task') and self._live_publish_task:
            self._live_publish_task.cancel()
            self._live_publish_task = None
        with self._lock:
            was_connected = self._connected
            self._connected = False
            self._metrics["disconnects"] += 1
            now = time.time()
            self._disconnected_at = now
            duration = (now - self._connected_at) if was_connected and self._connected_at else None
            reason = _classify_reason(self._pending_error, message) or self._disconnect_reason or "Unknown"
            self._disconnect_reason = reason
            self._disconnect_reason_code = _reason_code(reason)
            self._pending_error = None

            # Record disconnect but DON'T clear subscription registry
            # (the supervisor will re-subscribe from the registry)
            stale_count = len(self._subscribed_tokens)
            self._subscribed_tokens.clear()
            self._token_symbols.clear()

            if self._state not in {"STOPPED_BY_SCHEDULER", "STOPPED_BY_USER",
                                   "STOPPED_MARKET_CLOSED"}:
                self._state = "FAILED"

            self._connection_history.append({
                "event": "disconnect",
                "at": _iso(now),
                "status": "disconnected",
                "reason": reason,
                "reason_code": self._disconnect_reason_code,
                "durationSec": round(duration, 1) if duration is not None else None,
                "staleSubscriptionsCleared": stale_count,
            })

        # Feed disconnect event into MarketStateService — NOT as market_closed
        try:
            from services.market_state import market_state_service
            market_state_service.on_websocket_disconnected(reason)
        except Exception:
            pass

        self._record_event(
            "disconnected", reason,
            reason_code=self._disconnect_reason_code,
            severity="warning",
            details=str(message)[:300] if message else reason,
            duration=round(duration, 1) if duration is not None else None,
        )
        try:
            from services.websocket_history_service import update_connection_counters as _update_counters
            self._schedule_async(_update_counters(
                self._websocket_id,
                messages=self._total_messages_received,
                ticks=self._total_ticks_valid,
                errors=self._metrics.get("errors", 0),
                subscription_count=len(self._subscription_registry),
                reconnect_count=self._metrics.get("connects", 0),
            ))
        except Exception:
            pass
        self._persist_disconnect(
            reason, self._disconnect_reason_code, duration,
            "warning", event_label="disconnected",
        )
        self._publish_ws_state("DISCONNECTED", reason)
        # The broker feed is down — notify market-data engines that track the
        # feed lifecycle (so feed_state flips to DISCONNECTED on a real drop).
        self._publish_ws_engine_event("WEBSOCKET_DISCONNECTED", {"reason": reason})
        # The broker feed is down — record it in the central session manager
        # (session stays valid; only the feed state goes DISCONNECTED).
        _report_session_ws("mark_ws_disconnected", reason)

        if reason == "Authentication failure":
            self._record_event(
                "ws_auth_failed", "Authentication failure detected",
                reason_code="ws_auth_failed", severity="warning",
                details="Session credentials expired",
            )
            _notify_auth_failure()
            # Set supervisor state so it can handle re-login
            self._set_supervisor_state(SUPERVISOR_AUTH_REQUIRED, "session_expired")
            # Feed auth failure into MarketStateService — NOT market_closed
            try:
                from services.market_state import market_state_service
                market_state_service.on_auth_failure()
            except Exception:
                pass

        logger.warning(
            "[WS-SUPERVISOR] sdk_disconnect reason=%s cleared=%d subscriptions",
            reason, stale_count,
        )

    # ------------------------------------------------------------------
    # FEED READER
    # ------------------------------------------------------------------

    def _start_reader(self) -> None:
        ws = self._ws
        if ws is None:
            return
        task = self._reader_task
        if task is not None and not task.done():
            return
        try:
            self._reader_task = asyncio.create_task(self._reader_loop(ws))
        except RuntimeError:
            logger.exception("No running event loop to start the feed reader")

    async def _reader_loop(self, ws) -> None:
        try:
            async for message in ws:
                self._handle_feed_message(message)
        except asyncio.CancelledError:
            return
        except Exception as exc:
            logger.exception("Feed reader stopped unexpectedly: %s", exc)
        finally:
            if self._reader_task is asyncio.current_task():
                self._reader_task = None

    async def _periodic_counter_update(self):
        """Periodically persist counter values to MongoDB during active connection."""
        while self._connected:
            try:
                await asyncio.sleep(30)  # Every 30 seconds
                if not self._connected:
                    break
                from services.websocket_history_service import update_connection_counters as _update_counters
                await _update_counters(
                    self._websocket_id,
                    messages=self._total_messages_received,
                    ticks=self._total_ticks_valid,
                    errors=self._metrics.get("errors", 0),
                    subscription_count=len(self._subscription_registry),
                    reconnect_count=self._metrics.get("connects", 0),
                )
            except asyncio.CancelledError:
                break
            except Exception:
                pass

    # ------------------------------------------------------------------
    # LIVE PUBLISHER — throttle live metrics onto the centralized stream
    # ------------------------------------------------------------------

    def _start_live_publisher(self) -> None:
        try:
            self._live_publish_task = asyncio.ensure_future(self._live_publisher_loop())
        except Exception:
            logger.debug("Failed to start live publisher")

    async def _live_publisher_loop(self) -> None:
        """Push a live WS metrics frame to the shared realtime channel (~2s).

        Only runs while connected; state *transitions* are published by
        ``_publish_ws_state`` when there is no live connection.
        """
        while self._connected:
            try:
                await asyncio.sleep(2)
                if not self._connected:
                    break
                await self._publish_live_frame()
                self._check_stale_feed()
            except asyncio.CancelledError:
                return
            except Exception:
                pass
        self._live_publish_task = None

    async def _publish_live_frame(self) -> None:
        try:
            from services.state_store import set_entity_state
            await set_entity_state(
                "websocket",
                {"live": self.live_snapshot()},
                "websocket_live_frame",
            )
        except Exception:
            logger.debug("state_store live publish failed", exc_info=True)

    def _check_stale_feed(self) -> None:
        """Transition the persistent feed_state to STALE + record the incident.

        Real detection: while connected, if no tick has arrived within the
        configured threshold (``ws_stale_feed_sec``), the feed is marked stale
        once per incident. Recovery is detected in ``_process_tick``.
        """
        with self._lock:
            if not self._connected:
                return
            last_tick_at = self._last_tick_at
            feed_state = self._feed_state
        if feed_state != "RECEIVING" or last_tick_at is None:
            return
        now = time.time()
        threshold = rt_int("ws_stale_feed_sec", 30)
        if now - last_tick_at <= threshold:
            return
        with self._lock:
            if self._stale_feed_flagged:
                return
            self._stale_feed_flagged = True
            self._feed_state = "STALE"
            self._feed_state_since = now
        seconds = round(now - last_tick_at, 1)
        self._emit_ws_event(
            "stale_feed",
            f"No ticks received for {seconds}s (threshold {threshold}s)",
            severity="warning",
            details="realtime feed health check",
            meta={
                "seconds_since_tick": seconds,
                "threshold_sec": threshold,
                "connection_id": self._websocket_id,
            },
        )

    def _record_reconnect_attempt(self, attempt: int, delay: float) -> None:
        """Persist one real reconnect attempt (audit + reconnect history)."""
        with self._lock:
            self._connection_history.append({
                "event": "reconnecting",
                "at": _iso(time.time()),
                "status": "reconnecting",
                "reason": f"Reconnect attempt #{attempt + 1}",
                "attempt": attempt + 1,
                "backoff_sec": round(delay, 1),
                "previous_state": self._supervisor_state,
            })
        self._emit_ws_event(
            "reconnecting",
            f"Reconnecting attempt #{attempt + 1} (backoff {round(delay, 1)}s)",
            severity="warning",
            details="supervisor reconnect",
            meta={
                "attempt": attempt + 1,
                "backoff_sec": round(delay, 1),
                "previous_state": self._supervisor_state,
                "connection_id": self._websocket_id,
            },
        )

    def _record_reconnected(self, attempt: int) -> None:
        """Persist a successful reconnection (recovery evidence for alerts)."""
        with self._lock:
            self._connection_history.append({
                "event": "reconnected",
                "at": _iso(time.time()),
                "status": "reconnected",
                "reason": f"Reconnected after {attempt} attempt(s)",
                "attempt": attempt,
            })
        self._emit_ws_event(
            "reconnected",
            f"Reconnected after {attempt} attempt(s)",
            severity="success",
            details="supervisor reconnect succeeded",
            meta={
                "attempt": attempt,
                "connection_id": self._websocket_id,
            },
        )

    def _emit_ws_event(self, event_type: str, message: str, *, severity: str = "info",
                       details: str | None = None, meta: dict | None = None) -> None:
        """Emit into the system ledger AND persist onto the WS history record."""
        self._record_event(
            event_type, message,
            severity=severity, details=details or "", meta=meta or {},
        )
        try:
            from services.websocket_history_service import record_event as ws_record_event
            coro = ws_record_event(
                self._websocket_id, event_type, message,
                severity=severity, details=details, meta=meta,
            )
            self._schedule_async(coro)
        except Exception:
            pass

    def live_snapshot(self) -> dict:
        """Canonical live frame for the monitor (real values, market-aware)."""
        st = self.status()
        rates = st.get("rates") or {}
        metrics = st.get("metrics") or {}
        diag = st.get("diagnostics") or {}
        market: dict = {}
        try:
            from services.market_calendar import snapshot as _cal_snap
            market = _cal_snap() or {}
        except Exception:
            pass
        return {
            "supervisorState": st.get("supervisor_state"),
            "state": st.get("lifecycle_state"),
            "connected": st.get("connected"),
            "feedState": st.get("feed_state"),
            "feedStateSince": st.get("feed_state_since"),
            "connectionId": st.get("websocket_id"),
            "sessionId": st.get("session_id"),
            "connectedAt": st.get("connected_at"),
            "disconnectedAt": st.get("disconnected_at"),
            "disconnectReason": st.get("disconnect_reason"),
            "disconnectReasonCode": st.get("disconnect_reason_code"),
            "currentSessionUptimeSec": _session_duration(st),
            "lastMessageAt": st.get("last_message_at"),
            "lastTickAt": st.get("last_tick_at"),
            "secondsSinceTick": diag.get("seconds_since_last_tick"),
            "secondsSinceMessage": diag.get("seconds_since_last_message"),
            "messagesReceived": st.get("total_messages"),
            "ticksReceived": metrics.get("ticks_received", 0),
            "errorCount": metrics.get("errors", 0),
            "subscriptionCount": st.get("subscription_count"),
            "subscriptionRegistryCount": st.get("subscription_registry_count"),
            "reconnectCount": st.get("reconnect_count"),
            "reconnectAttempt": st.get("reconnect_attempt"),
            "rates": rates,
            "internetOk": st.get("internet_ok"),
            "processStartedAt": st.get("process_started_at"),
            "connectionHistoryCount": st.get("connection_history_count"),
            "market": market,
        }

    def set_publish_hook(self, hook=None) -> None:
        """Attach (or clear) the Central WebSocket Engine publish hook.

        The engine receives every decoded SFeed message verbatim and performs
        its own canonical fan-out. The WebSocket manager remains the single
        Kotak connection owner.
        """
        self._publish_hook = hook

    def _handle_feed_message(self, message) -> None:
        now = time.time()
        with self._lock:
            self._last_message_at = now
            self._total_messages_received += 1
            self._recent_messages.append(now)
            # Track message type distribution
            msg_type = type(message).__name__
            self._last_message_type = msg_type
            self._messages_by_type[msg_type] = self._messages_by_type.get(msg_type, 0) + 1

        # Central WebSocket Engine hook (fan-out to the routing engine). The
        # hook is set via set_publish_hook(); it never blocks the owner and a
        # failure in it must not break the raw broker path.
        if self._publish_hook is not None:
            try:
                self._publish_hook(message)
            except Exception:
                logger.exception("[SFEED] WebSocket Engine publish hook failed")
                with self._lock:
                    self._metrics["publish_hook_errors"] = (
                        self._metrics.get("publish_hook_errors", 0) + 1
                    )

        # Handle SFeedMarketStatus (market open/close) — informational, not a tick
        from neo_api_client.websocket.feed.models import (
            SFeedMarketStatus, SFeedIndex, SFeedCasChange,
        )
        if isinstance(message, SFeedMarketStatus):
            with self._lock:
                self._total_market_status += 1
            logger.info(
                "[SFEED] market_status: exchange=%s status=%s (%s)",
                getattr(message, "exchange_segment", "?"),
                getattr(message, "status", "?"),
                getattr(message, "status_code", "?"),
            )
            return

        if isinstance(message, SFeedIndex):
            with self._lock:
                self._total_index_messages += 1
            # Index messages carry LTP — treat as a valid data tick. Persistence
            # happens in the Engine's Data Saver consumer, not here.
            self._process_tick(message, now)
            return

        if isinstance(message, SFeedCasChange):
            with self._lock:
                self._total_cas_change += 1
            return

        # SFeedScrip or SFeedScripLite — the main tick path.
        # Validation is performed by the SDK decode; no raw projection here.
        self._process_tick(message, now)

    def _process_tick(self, message, now: float) -> None:
        """Process a decoded tick message: update metrics, feed state.

        Persistence is handled by the Central WebSocket Engine's Data Saver
        consumer (feed hook -> canonical -> router -> MongoDB), so this manager
        only does local bookkeeping — the legacy ``_sfeed_to_raw`` / tick-buffer
        projection is gone.
        """
        with self._lock:
            self._last_tick_at = now
            self._tick_count += 1
            self._metrics["ticks_received"] += 1
            self._metrics["ticks_validated"] += 1
            self._total_ticks_valid += 1
            self._recent_ticks.append(now)
            # Feed state transitions
            feed_resumed = False
            if self._feed_state != "RECEIVING":
                was_stale = self._feed_state in ("STALE", "DEGRADED") or self._stale_feed_flagged
                self._feed_state = "RECEIVING"
                self._feed_state_since = now
                self._stale_feed_flagged = False
                feed_resumed = was_stale
                logger.info("[SFEED] FEED_STATE -> RECEIVING (first tick)")

        if feed_resumed:
            self._emit_ws_event(
                "feed_resumed",
                "Feed recovered — ticks flowing again",
                severity="success",
                details="feed health recovery",
                meta={"connection_id": self._websocket_id},
            )

        # Feed tick into MarketStateService for market-open confirmation
        try:
            from services.market_state import market_state_service
            instrument_token = str(getattr(message, "instrument_token", ""))
            if instrument_token:
                market_state_service.on_tick_received(instrument_token)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # PREPARE (pre-login registry pre-warm — NO broker contact)
    # ------------------------------------------------------------------

    def prepare_subscriptions(self, tokens: list[dict]) -> int:
        """Pre-warm the subscription registry WITHOUT contacting the broker.

        Used by the scheduler WS prep phase (pre-login): the desired set from
        the Session Manager is merged into the registry so that as soon as a
        real connection exists post-login the supervisor sends exactly that
        same set to the broker. Sends nothing to the broker on its own.
        """
        if not tokens:
            return 0
        with self._lock:
            before = len(self._subscription_registry)
            self._update_subscription_registry(tokens)
            added = len(self._subscription_registry) - before
        if added:
            logger.info(
                "[WS-SUPERVISOR] subscription_prepare tokens=%d added=%d",
                len(tokens), added,
            )
        return added

    # ------------------------------------------------------------------
    # SUBSCRIBE
    # ------------------------------------------------------------------

    async def subscribe(self, instrument_tokens: list[dict]) -> dict:
        if not instrument_tokens:
            return {"ok": False, "message": "No instrument tokens supplied", "count": 0}

        if not kotak_session.logged_in:
            return {"ok": False, "message": "Not logged in to Kotak", "count": 0}

        client = kotak_session.client
        if not client:
            return {"ok": False, "message": "Kotak SDK client is not available", "count": 0}

        async with self._subscribe_lock:
            with self._lock:
                self._metrics["subscribe_calls"] += 1

            ws = await self._ensure_connected()
            if ws is None:
                return {
                    "ok": False,
                    "message": self._last_connect_error or "WebSocket not connected",
                    "count": 0,
                }

            new_tokens = []
            with self._lock:
                # Dedup first against already-subscribed tokens, then within
                # the same batch so we never send duplicate (token, segment).
                seen_in_batch: set[tuple] = set()
                for token in instrument_tokens:
                    if _is_duplicate(self._subscribed_tokens, token):
                        self._metrics["duplicate_subscriptions_blocked"] += 1
                        continue
                    key = (token.get("instrument_token"), token.get("exchange_segment"))
                    if key in seen_in_batch:
                        self._metrics["duplicate_subscriptions_blocked"] += 1
                        continue
                    seen_in_batch.add(key)
                    new_tokens.append(token)

            if not new_tokens:
                return {"ok": True, "message": "Already subscribed", "count": 0}

            try:
                await _send_subscribe(ws, new_tokens)
            except Exception as exc:
                logger.exception("Kotak subscribe failed")
                with self._lock:
                    self._connected = False
                    self._state = "FAILED"
                return {"ok": False, "message": f"Subscribe failed: {exc}", "count": 0}

            with self._lock:
                self._subscribed_tokens.extend(new_tokens)
                for token in new_tokens:
                    instrument_token = str(token.get("instrument_token", ""))
                    symbol = token.get("symbol")
                    if instrument_token and symbol:
                        self._token_symbols[instrument_token] = str(symbol)
                    self._record_feed_level(instrument_token, token)
                # Update the subscription registry (survives reconnects)
                # Only register tokens that were actually sent to the broker
                self._update_subscription_registry(new_tokens)

            # Report the broker acknowledgement back to the Session Manager
            # (single source of truth for subscription state).
            try:
                from services.session.session_manager import session_manager
                session_manager.mark_broker_subscribed(new_tokens)
            except Exception:
                logger.exception("Failed to mirror subscribe ack into session manager")

            logger.info("Subscribed to %d tokens", len(new_tokens))
            return {"ok": True, "message": "Subscribed", "count": len(new_tokens)}

    def _update_subscription_registry(self, tokens: list[dict]) -> None:
        """Merge new tokens into the subscription registry (deduplicated)."""
        existing_keys = {
            (t.get("instrument_token"), t.get("exchange_segment"))
            for t in self._subscription_registry
        }
        for token in tokens:
            key = (token.get("instrument_token"), token.get("exchange_segment"))
            if key not in existing_keys:
                self._subscription_registry.append(token)
                existing_keys.add(key)

    async def _ensure_connected(self):
        ws = self._ws
        if ws is not None and ws.is_connected:
            return ws
        return await self._connect_fresh()

    async def _connect_fresh(self):
        import traceback

        client = kotak_session.client
        if not client:
            self._last_connect_error = "Kotak SDK client is not available"
            logger.error("[WS-SUPERVISOR] connect_fresh: client is None")
            return None
        try:
            from neo_api_client.websocket.feed.exceptions import AuthenticationError
        except Exception as exc:
            self._last_connect_error = f"SFeedWebSocket unavailable: {exc}"
            logger.error("[WS-SUPERVISOR] connect_fresh: cannot import feed exceptions: %s", exc)
            return None

        self._discard_ws()

        # Create the websocket. Disable both SDK-level retries so OUR
        # supervisor owns the full connection lifecycle with proper
        # exponential backoff and diagnostic logging.
        #
        # max_reconnect_attempts=0:
        #   SDK does NOT auto-reconnect after a post-connect disconnect.
        #   Our supervisor detects the disconnect and reconnects.
        #
        # max_connect_retries=0:
        #   SDK does NOT retry the initial connect() internally.
        #   Our supervisor retries with exponential backoff.
        try:
            ws = client.create_websocket(
                max_reconnect_attempts=0,
                max_connect_retries=0,
            )
        except Exception as exc:
            self._last_connect_error = f"Failed to create feed: {exc}"
            logger.error(
                "[WS-SUPERVISOR] connect_fresh: create_websocket failed: %s %s",
                type(exc).__name__, exc,
            )
            return None

        ws.on_connect = self._on_open
        ws.on_disconnect = self._on_external_disconnect
        ws.on_error = self._on_error

        with self._lock:
            self._ws = ws
        self._last_connect_error = None

        # Pre-connect diagnostics
        ws_url = getattr(ws, "url", "unknown")
        has_token = bool(getattr(ws, "access_token", None))
        logger.info(
            "[WS-SUPERVISOR] connect_fresh: attempting ws.connect() url=%s has_token=%s",
            ws_url, has_token,
        )

        connect_start = time.time()
        try:
            # connect() takes NO arguments — all config is on the constructor.
            await ws.connect()
        except AuthenticationError as exc:
            elapsed = time.time() - connect_start
            self._last_connect_error = f"AuthenticationError: {exc}"
            logger.error(
                "[WS-SUPERVISOR] connect_fresh: AUTH FAILED (%.1fs) exc=%s detail=%s",
                elapsed, type(exc).__name__, exc,
            )
            with self._lock:
                self._ws = None
            _notify_auth_failure()
            return None
        except Exception as exc:
            elapsed = time.time() - connect_start
            exc_type = type(exc).__name__
            exc_str = str(exc) or repr(exc)
            tb = traceback.format_exc()
            logger.error(
                "[WS-SUPERVISOR] connect_fresh: CONNECT FAILED (%.1fs)\n"
                "  exc_type=%s\n"
                "  exc_str=%s\n"
                "  exc_repr=%s\n"
                "  url=%s\n"
                "  has_token=%s\n"
                "  traceback:\n%s",
                elapsed, exc_type, exc_str, repr(exc),
                ws_url, has_token, tb,
            )
            self._last_connect_error = f"{exc_type}: {exc_str}"
            with self._lock:
                self._ws = None
            return None

        # Clear per-connection tokens (but NOT the subscription registry)
        with self._lock:
            self._subscribed_tokens.clear()
            self._token_symbols.clear()
            self._subscribed_feed_levels.clear()
        self._start_reader()
        logger.info("[WS-SUPERVISOR] connect_fresh: connected in %.1fs", time.time() - connect_start)
        return ws

    def _discard_ws(self) -> None:
        reader = self._reader_task
        if reader is not None and not reader.done():
            reader.cancel()
        self._reader_task = None
        old_ws = self._ws
        self._ws = None
        # Close the old WebSocket to release the fd/socket — fire and forget.
        if old_ws is not None:
            try:
                from core.event_loop import get_loop
                loop = get_loop()
                if loop.is_running():
                    async def _close_old():
                        with contextlib.suppress(Exception):
                            await old_ws.close()
                    loop.call_soon_threadsafe(lambda: asyncio.ensure_future(_close_old()))
            except Exception:
                pass

    # ------------------------------------------------------------------
    # UNSUBSCRIBE
    # ------------------------------------------------------------------

    async def unsubscribe(self, instrument_tokens: list[dict]) -> dict:
        if not instrument_tokens:
            return {"ok": True, "message": "No instrument tokens supplied", "count": 0}

        with self._lock:
            self._metrics["unsubscribe_calls"] += 1

        ws = self._ws
        if ws is not None and ws.is_connected:
            try:
                await _send_unsubscribe(ws, instrument_tokens)
            except Exception as exc:
                logger.exception("Kotak unsubscribe failed")
                return {"ok": False, "message": f"Unsubscribe failed: {exc}", "count": 0}

        with self._lock:
            for token in instrument_tokens:
                self._subscribed_tokens = [
                    existing
                    for existing in self._subscribed_tokens
                    if not (
                        existing.get("instrument_token") == token.get("instrument_token")
                        and existing.get("exchange_segment") == token.get("exchange_segment")
                    )
                ]
                tok = str(token.get("instrument_token", ""))
                if tok:
                    self._subscribed_feed_levels.pop(tok, None)
                # Also remove from subscription registry
                self._subscription_registry = [
                    existing
                    for existing in self._subscription_registry
                    if not (
                        existing.get("instrument_token") == token.get("instrument_token")
                        and existing.get("exchange_segment") == token.get("exchange_segment")
                    )
                ]

        # Mirror the unsubscribe acknowledgement into the Session Manager.
        try:
            from services.session.session_manager import session_manager
            session_manager.mark_broker_unsubscribed(instrument_tokens, reason="engine unsubscribe")
        except Exception:
            logger.exception("Failed to mirror unsubscribe ack into session manager")

        logger.info("Unsubscribed %d tokens", len(instrument_tokens))
        return {"ok": True, "message": "Unsubscribed", "count": len(instrument_tokens)}

    # ------------------------------------------------------------------
    # DISCONNECT (intentional — backward compatible with scheduler)
    # ------------------------------------------------------------------

    def disconnect(self, why: str | None = None):
        """Intentional teardown of the feed.

        ``why`` is an honest reason from the controlled taxonomy.
        """
        with self._lock:
            tokens = list(self._subscribed_tokens)
            self._token_symbols.clear()
            was_connected = self._connected
            self._subscribed_tokens.clear()
            self._connected = False
            now = time.time()
            self._disconnected_at = now
            if was_connected and self._connected_at:
                duration = now - self._connected_at
            else:
                duration = None
            reason = why or "Intentional shutdown"
            self._disconnect_reason = reason
            self._disconnect_reason_code = _reason_code(reason)
            self._pending_error = None
            if why and "market_closed" in why:
                self._state = "STOPPED_MARKET_CLOSED"
            elif why:
                self._state = "STOPPED_BY_SCHEDULER"
            else:
                self._state = "STOPPED_BY_USER"
            self._connection_history.append({
                "event": "disconnect",
                "at": _iso(now),
                "status": "disconnected",
                "reason": reason,
                "reason_code": self._disconnect_reason_code,
                "durationSec": round(duration, 1) if duration is not None else None,
            })
        self._record_event(
            "stopped", reason,
            reason_code=self._disconnect_reason_code,
            severity="info",
            details=str(why) if why else "Intentional shutdown",
            duration=round(duration, 1) if duration is not None else None,
        )
        self._persist_disconnect(
            reason, self._disconnect_reason_code, duration,
            "info", event_label="stopped",
        )
        self._publish_ws_state(self._state, reason)
        # Intentional teardown — reflect it in the central session manager.
        _report_session_ws("mark_ws_disconnected", reason)

        try:
            from core.event_loop import get_loop
            loop = get_loop()
            if loop.is_running():
                loop.call_soon_threadsafe(self._schedule_teardown)
            else:
                self._ws = None
        except Exception:
            logger.exception("Failed to schedule WebSocket teardown")
            self._ws = None

        logger.info("WebSocket manager disconnected; cleared %d subscriptions",
                    len(tokens))

    def _schedule_teardown(self) -> None:
        try:
            asyncio.ensure_future(self._teardown_ws())
        except Exception:
            logger.exception("Failed to enqueue WebSocket teardown")

    async def _teardown_ws(self) -> None:
        ws = self._ws
        reader = self._reader_task
        self._ws = None
        self._reader_task = None
        if reader is not None and not reader.done():
            reader.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await reader
        if ws is not None:
            with contextlib.suppress(Exception):
                await ws.close()

    def mark_disconnected(self, reason: str, *, state: str | None = None) -> None:
        """Record a disconnect that happened without an SDK close callback."""
        with self._lock:
            was_connected = self._connected
            self._connected = False
            now = time.time()
            self._disconnected_at = now
            if was_connected and self._connected_at:
                duration = now - self._connected_at
            else:
                duration = None
            self._disconnect_reason = reason or "Unknown"
            self._disconnect_reason_code = _reason_code(reason)
            self._pending_error = None
            self._state = state or ("FAILED" if reason not in {"Unknown", "Intentional shutdown"} else "DISCONNECTED")
            self._connection_history.append({
                "event": "disconnect",
                "at": _iso(now),
                "status": "disconnected",
                "reason": reason or "Unknown",
                "reason_code": self._disconnect_reason_code,
                "durationSec": round(duration, 1) if duration is not None else None,
            })
        self._record_event(
            "disconnected", reason or "Unknown",
            reason_code=self._disconnect_reason_code,
            severity=("warning" if self._state == "FAILED" else "info"),
            duration=round(duration, 1) if duration is not None else None,
        )
        self._persist_disconnect(
            reason or "Unknown", self._disconnect_reason_code, duration,
            "warning" if self._state == "FAILED" else "info",
            event_label="disconnected",
        )
        self._publish_ws_state(
            "FAILED" if self._state == "FAILED" else "DISCONNECTED",
            reason or "",
        )
        # Forced/observed disconnect — reflect it in the central session manager.
        _report_session_ws("mark_ws_disconnected", reason or "Unknown")
        logger.info("WebSocket marked disconnected: %s", reason)

    def is_connected(self) -> bool:
        with self._lock:
            return self._connected

    def subscribed_count(self) -> int:
        with self._lock:
            return len(self._subscribed_tokens)

    def _record_event(self, event: str, message: str, **meta) -> None:
        try:
            from services.notification_center import emit_event as record_event
            record_event("websocket", event, meta.get("severity", "info"), message, meta)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # PERSISTENCE (async on the app loop)
    # ------------------------------------------------------------------

    @staticmethod
    def _schedule_async(coro) -> None:
        try:
            from core.event_loop import get_loop
            loop = get_loop()
            if loop is not None and loop.is_running():
                loop.call_soon_threadsafe(
                    lambda: asyncio.ensure_future(coro)
                )
                return
        except Exception:
            logger.debug("Failed to schedule async persistence", exc_info=True)

        # No running shared loop reference (e.g. during tests / pre-startup).
        # Attach the coroutine to the current loop, or drive it on a fresh one,
        # so it is always awaited and never leaked.
        try:
            current = asyncio.get_running_loop()
            current.create_task(coro)
            return
        except RuntimeError:
            pass
        try:
            current = asyncio.get_event_loop()
            if current.is_running():
                current.call_soon_threadsafe(lambda: asyncio.ensure_future(coro))
            else:
                current.create_task(coro)
            return
        except RuntimeError:
            pass
        except Exception:
            pass
        try:
            asyncio.run(coro)
        except Exception:
            logger.debug("Failed to run async persistence on fresh loop", exc_info=True)

    @staticmethod
    def _publish_ws_state(conn_state: str, reason: str = "") -> None:
        """Publish broker WebSocket state change to the centralized store."""
        try:
            from services.state_store import set_entity_state, set_service_state
            from core.event_loop import get_loop

            def _do():
                async def _p():
                    try:
                        await set_entity_state(
                            "websocket",
                            {"state": conn_state, "reason": reason or ""},
                            reason or "websocket_state_change",
                        )
                    except Exception:
                        logger.debug("state_store ws publish failed", exc_info=True)
                    status_map = {
                        "CONNECTED": "RUNNING",
                        "CONNECTING": "STARTED",
                        "RECONNECTING": "RECOVERING",
                        "FAILED": "FAILED",
                        "DISCONNECTED": "STOPPED",
                        "STOPPED": "STOPPED",
                        "STOPPING": "STOPPED",
                        "WAITING_FOR_MARKET_WINDOW": "STOPPED",
                        "NETWORK_OFFLINE": "DEGRADED",
                        "AUTH_REQUIRED": "UNKNOWN",
                        "AUTH_FAILED": "FAILED",
                        "BROKER_UNAVAILABLE": "UNAVAILABLE",
                        "ERROR": "FAILED",
                    }
                    status = status_map.get(conn_state, "UNKNOWN")
                    try:
                        await set_service_state("broker_ws", status, reason or "")
                    except Exception:
                        logger.debug("state_store service publish failed", exc_info=True)
                try:
                    asyncio.ensure_future(_p())
                except RuntimeError:
                    pass

            loop = get_loop()
            if loop is not None and loop.is_running():
                loop.call_soon_threadsafe(_do)
            else:
                _do()
        except Exception:
            logger.debug("state publish failed", exc_info=True)

    @staticmethod
    def _publish_ws_engine_event(event_type: str, data: dict | None = None) -> None:
        """Publish a broker-WebSocket lifecycle event onto the engine event bus.

        Consumers like ``market_watch_engine`` subscribe to
        ``WEBSOCKET_CONNECTED / WEBSOCKET_DISCONNECTED / WEBSOCKET_RECONNECTED``
        to keep their ``feed_state`` truthful without fabricating it. Fires from
        the SDK callbacks (sync); the publish is scheduled on the app loop.
        """
        try:
            from services.engine_event_bus import EngineEvent, get_event_bus

            async def _p():
                try:
                    await get_event_bus().publish(EngineEvent(
                        event_type=event_type,
                        source_engine="ws_manager",
                        data=data or {},
                    ))
                except Exception:
                    logger.debug("engine event publish failed (%s)", event_type, exc_info=True)

            WebSocketManager._schedule_async(_p())
        except Exception:
            logger.debug("notify engine bus failed for %s", event_type, exc_info=True)

    def _persist_connect(self) -> None:
        try:
            from services.websocket_history_service import (
                open_connection, record_event as ws_record_event,
            )
            cid = self._websocket_id
            history_coro = open_connection(
                connection_id=cid,
                session_id=self._session_id,
                connected_at=datetime.fromtimestamp(
                    self._connected_at, tz=timezone.utc
                ) if self._connected_at else None,
                subscription_count=len(self._subscribed_tokens),
            )
            event_coro = ws_record_event(
                cid, "connected", "WebSocket feed connected",
                severity="success",
            )
            self._schedule_async(_chain_coros(history_coro, event_coro))
        except Exception:
            logger.debug("Failed to persist websocket connect")

        try:
            from services.notification_service import notify
            notify_coro = notify(
                "websocket", "success", "WebSocket Connected",
                f"Feed connected ({self._websocket_id or 'ws'}).",
                source="websocket", event_type="websocket_connected",
            )
            self._schedule_async(notify_coro)
        except Exception:
            logger.debug("Failed to notify websocket connected")

    def _persist_disconnect(self, reason: str, reason_code: str, duration: float | None,
                            severity: str, event_label: str) -> None:
        try:
            from services.websocket_history_service import (
                close_connection, record_event as ws_record_event,
            )
            cid = self._websocket_id
            close_coro = close_connection(
                cid,
                disconnected_at=datetime.fromtimestamp(
                    self._disconnected_at, tz=timezone.utc
                ) if self._disconnected_at else None,
                reason=reason or "Unknown",
                close_code=reason_code or None,
            )
            event_coro = ws_record_event(
                cid, event_label, reason or "Unknown",
                severity=severity, details=reason,
            )
            self._schedule_async(_chain_coros(close_coro, event_coro))
        except Exception:
            logger.debug("Failed to persist websocket disconnect")

        try:
            from services.notification_service import notify
            notify_coro = notify(
                "websocket",
                "info" if severity == "info" else "error",
                "WebSocket Disconnected",
                f"{reason or 'WebSocket closed'} ({self._websocket_id or 'ws'}).",
                source="websocket", event_type="websocket_disconnected",
            )
            self._schedule_async(notify_coro)
        except Exception:
            logger.debug("Failed to notify websocket disconnected")

    # ------------------------------------------------------------------
    # STATUS
    # ------------------------------------------------------------------

    def _record_feed_level(self, instrument_token: str, token: dict) -> str:
        """Record the REAL feed family this instrument was subscribed on.

        Precedence: explicit ``feedLevel`` > ``isDepth``/``isIndex`` flags >
        ``marketData`` tier > L8 default. Only called for tokens actually sent
        to the broker, so it always reflects observed subscription calls.
        """
        level = token.get("feedLevel")
        if level is not None:
            feed = f"L{int(level)}"
        elif token.get("isDepth"):
            feed = "L8"
        elif token.get("isIndex"):
            feed = "INDEX"  # index feed (subscribe_index)
        elif token.get("marketData"):
            tier = str(token.get("marketData")).upper()
            if tier.startswith("L"):
                feed = tier[:3]
            else:
                feed = "L8"
        else:
            feed = "L8"  # default market-data feed is L8 depth
        if instrument_token:
            self._subscribed_feed_levels[instrument_token] = feed
        return feed

    def feed_levels(self) -> dict[str, int]:
        """Real composition of subscribed feed families: {'L4': n, 'L8': n}."""
        counts: dict[str, int] = {}
        for feed in self._subscribed_feed_levels.values():
            counts[feed] = counts.get(feed, 0) + 1
        return {"L4": counts.get("L4", 0), "L8": counts.get("L8", 0), "L16": counts.get("L16", 0), "INDEX": counts.get("INDEX", 0)}

    def _compute_rates(self) -> dict:
        """Compute rolling message/tick rates from recent timestamps."""
        now = time.time()
        # Prune entries older than 65 seconds
        while self._recent_messages and self._recent_messages[0] < now - 65:
            self._recent_messages.popleft()
        while self._recent_ticks and self._recent_ticks[0] < now - 65:
            self._recent_ticks.popleft()
        msg_1s = sum(1 for t in self._recent_messages if t > now - 1)
        msg_5s = sum(1 for t in self._recent_messages if t > now - 5)
        msg_60s = sum(1 for t in self._recent_messages if t > now - 60)
        tick_1s = sum(1 for t in self._recent_ticks if t > now - 1)
        tick_5s = sum(1 for t in self._recent_ticks if t > now - 5)
        tick_60s = sum(1 for t in self._recent_ticks if t > now - 60)
        return {
            "messages_per_second": round(msg_1s, 1),
            "messages_5s_average": round(msg_5s / 5, 1),
            "messages_60s_average": round(msg_60s / 60, 1),
            "ticks_per_second": round(tick_1s, 1),
            "ticks_5s_average": round(tick_5s / 5, 1),
            "ticks_60s_average": round(tick_60s / 60, 1),
        }

    def status(self) -> dict:
        with self._lock:
            last_tick_at = self._last_tick_at
            last_message_at = self._last_message_at
            metrics = dict(self._metrics)
            history = list(self._connection_history)
            lifecycle_state = _lifecycle_state(self._supervisor_state, self._connected)
            sup_state = self._supervisor_state
            feed_state = self._feed_state
            feed_state_since = self._feed_state_since
            now = time.time()
            # Compute seconds since last tick/message for diagnostics
            secs_since_tick = round(now - last_tick_at, 1) if last_tick_at else None
            secs_since_msg = round(now - last_message_at, 1) if last_message_at else None
            # Determine stale threshold: >30s without ticks = STALE
            if feed_state == "RECEIVING" and secs_since_tick is not None and secs_since_tick > 30:
                feed_state = "STALE"
            elif feed_state == "RECEIVING" and secs_since_tick is not None and secs_since_tick > 5:
                feed_state = "DEGRADED"

            return {
                "connected": self._connected,
                "state": self._state,
                "supervisor_state": sup_state,
                "lifecycle_state": lifecycle_state,
                "feed_state": feed_state,
                "feed_state_since": _iso(feed_state_since),
                "websocket_id": self._websocket_id,
                "session_id": self._session_id,
                "subscribed_symbols": len(self._subscribed_tokens),
                "subscription_count": len(self._subscribed_tokens),
                "subscription_registry_count": len(self._subscription_registry),
                "feed_levels": self.feed_levels(),
                "last_tick_at": (
                    datetime.fromtimestamp(last_tick_at, tz=timezone.utc).isoformat()
                    if last_tick_at else None
                ),
                "last_message_at": (
                    datetime.fromtimestamp(last_message_at, tz=timezone.utc).isoformat()
                    if last_message_at else None
                ),
                "tick_count": self._tick_count,
                "metrics": metrics,
                "messages_received": self._total_messages_received,
                "total_messages": self._total_messages_received,
                "rates": self._compute_rates(),
                "reconnect_count": metrics.get("connects", 0),
                "reconnect_attempt": self._supervisor_reconnect_attempt,
                "process_started_at": _iso(_PROCESS_STARTED_AT),
                "connected_at": _iso(self._connected_at),
                "disconnected_at": _iso(self._disconnected_at),
                "last_connection_at": _iso(self._last_connection_at),
                "disconnect_reason": self._disconnect_reason,
                "disconnect_reason_code": self._disconnect_reason_code,
                "connection_history": history[-20:],
                "connection_history_count": len(history),
                "internet_ok": self._supervisor_internet_ok,
                # Feed diagnostics — real counters from actual SFeed messages
                "diagnostics": {
                    "total_messages_received": self._total_messages_received,
                    "total_ticks_valid": self._total_ticks_valid,
                    "total_ticks_rejected": self._total_ticks_rejected,
                    "total_malformed": self._total_malformed,
                    "total_heartbeat": self._total_heartbeat,
                    "total_market_status": self._total_market_status,
                    "total_index_messages": self._total_index_messages,
                    "total_cas_change": self._total_cas_change,
                    "total_subscription_acks": self._total_subscription_acks,
                    "last_message_type": self._last_message_type,
                    "messages_by_type": dict(self._messages_by_type),
                    "seconds_since_last_tick": secs_since_tick,
                    "seconds_since_last_message": secs_since_msg,
                    "feed_state": feed_state,
                    "token_symbols_count": len(self._token_symbols),
                },
            }

    def health(self) -> dict:
        with self._lock:
            return {
                "healthy": self._connected,
                "connected": self._connected,
                "subscribed": len(self._subscribed_tokens),
                "last_tick_at": self._last_tick_at,
                "supervisor_state": self._supervisor_state,
            }


# -------------------------------------------------------------
# HELPERS
# -------------------------------------------------------------

def _is_duplicate(tokens: list[dict], token: dict) -> bool:
    instrument_token = token.get("instrument_token")
    exchange_segment = token.get("exchange_segment")
    return any(
        existing.get("instrument_token") == instrument_token
        and existing.get("exchange_segment") == exchange_segment
        for existing in tokens
    )


def _group_intents(tokens: list[dict]) -> tuple[list[dict], list[dict], list[dict], list[dict]]:
    """Classify tokens by broker feed family.

    Indices use ``subscribe_index``. Full-depth tokens (L16) use
    ``subscribe_full_depth``. The default market-data feed for equities is L8
    depth (``subscribe_depth``); L4 touch-line ``subscribe_scrips`` is only
    used for explicit legacy intents (feedLevel 1/2/4 or marketData
    L1/L4/TOUCH_LINE). Tokens with no classification default to L8 depth.
    """
    scrips: list[dict] = []
    indices: list[dict] = []
    full_depths: list[dict] = []
    depths: list[dict] = []
    for token in tokens:
        market_data = str(token.get("marketData") or "").upper()
        feed_level = token.get("feedLevel")
        if token.get("isIndex") or market_data == "INDEX":
            indices.append(token)
        elif market_data == "L16" or feed_level == 16:
            full_depths.append(token)
        elif market_data == "L8" or feed_level == 8 or token.get("isDepth"):
            depths.append(token)
        elif market_data in ("L1", "L4", "TOUCH_LINE") or feed_level in (1, 2, 4):
            scrips.append(token)
        else:
            depths.append(token)  # default market-data feed = L8 depth
    return scrips, indices, full_depths, depths


def _ws_token(token: dict):
    from neo_api_client.websocket.feed import WsToken
    return WsToken(
        exchange_segment=str(token.get("exchange_segment") or "nse_cm"),
        instrument_token=str(token.get("instrument_token") or ""),
    )


_DEFAULT_SUBSCRIBE_BATCH_SIZE = 200


def _subscribe_batch_size() -> int:
    """Deterministic broker subscribe batch size (tokens per WS frame).

    A single subscribe frame must never carry the entire daily universe.
    Override with env ``WS_SUBSCRIBE_BATCH_SIZE`` (falling back to the runtime
    setting ``ws_subscribe_batch_size``, then ``200``).
    """
    raw = os.environ.get("WS_SUBSCRIBE_BATCH_SIZE")
    if raw:
        try:
            n = int(raw)
            if n > 0:
                return n
        except (TypeError, ValueError):
            pass
    n = rt_int("ws_subscribe_batch_size", 0)
    return n if n > 0 else _DEFAULT_SUBSCRIBE_BATCH_SIZE


def _batched(tokens: list[dict], size: int) -> list[list[dict]]:
    if size <= 0 or len(tokens) <= size:
        return [tokens] if tokens else []
    return [tokens[i:i + size] for i in range(0, len(tokens), size)]


async def _send_subscribe(ws, tokens: list[dict]) -> None:
    """Subscribe tokens in deterministic per-family batches.

    Each broker feed family (scrips / index / full-depth / depth) is chunked
    into frames of ``_subscribe_batch_size()`` tokens, so a 2,600+ symbol
    daily universe goes out as ~14 bounded frames instead of one giant
    ``inputtoken`` list. Batches are sent sequentially so the SDK's per-batch
    subscribe-ACK bookkeeping stays correct.
    """
    scrips, indices, full_depths, depths = _group_intents(tokens)
    size = _subscribe_batch_size()
    frames = 0
    for chunk in _batched(scrips, size):
        await ws.subscribe_scrips([_ws_token(t) for t in chunk])
        frames += 1
    for chunk in _batched(indices, size):
        await ws.subscribe_index([_ws_token(t) for t in chunk])
        frames += 1
    for chunk in _batched(full_depths, size):
        await ws.subscribe_full_depth([_ws_token(t) for t in chunk])
        frames += 1
    for chunk in _batched(depths, size):
        await ws.subscribe_depth([_ws_token(t) for t in chunk])
        frames += 1
    logger.debug(
        "[WS-SUBSCRIBE] sent %d tokens in %d frames (batch_size=%d)",
        len(tokens), frames, size,
    )


async def _send_unsubscribe(ws, tokens: list[dict]) -> None:
    """Unsubscribe tokens in the same deterministic per-family batches."""
    scrips, indices, full_depths, depths = _group_intents(tokens)
    size = _subscribe_batch_size()
    for chunk in _batched(scrips, size):
        await ws.unsubscribe_scrips([_ws_token(t) for t in chunk])
    for chunk in _batched(indices, size):
        await ws.unsubscribe_index([_ws_token(t) for t in chunk])
    for chunk in _batched(full_depths, size):
        await ws.unsubscribe_full_depth([_ws_token(t) for t in chunk])
    for chunk in _batched(depths, size):
        await ws.unsubscribe_depth([_ws_token(t) for t in chunk])


def _notify_auth_failure() -> None:
    try:
        from scheduler import notify_auth_failure
        notify_auth_failure()
    except Exception:
        logger.exception("Failed to notify scheduler about auth failure")


ws_manager = WebSocketManager()
