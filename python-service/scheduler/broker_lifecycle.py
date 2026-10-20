"""Per-broker lifecycle driver for the Scheduler (multi-broker orchestration).

The scheduler drives the scheduled lifecycle for EVERY enabled broker
independently and simultaneously:

    LOGIN -> SESSION VALIDATED -> WS CONNECT -> live feed -> WS STOP -> LOGOUT

Kotak keeps the existing, regression-tested controller path
(:class:`SchedulerController` in ``scheduler/__init__``). This module adds the
Shoonya segment as an independent driver that shares the SAME TIME-TABLE /
trading-day / ledger statuses but owns only its own terminal.

Honesty rules baked in:
  * NO view switching — background logins register only terminal-scoped records.
  * NO automatic Dummy fallback — this driver never fabricates a "logged in".
  * NO token persistence — the OAuth code / access token never leave memory.
  * OAuth code absent today means LOGIN_PENDING + SHOONYA_OAUTH_CODE_REQUIRED
    (honest), retried each tick; the moment a code arrives the login runs.
  * Broker-scoped ledger (``broker`` field) so Kotak and Shoonya runs for the
    same scheduled instant never collide.
"""

from __future__ import annotations
import logging
from datetime import datetime, timezone
from typing import Any, Callable

from core.timezones import UTC, iso_ist
from services.session.session_manager import session_manager

_log = logging.getLogger("broker_lifecycle")

# Bridge statuses surfaced per broker (own vocabulary; consumers map to UI).
MARKET_CLOSED = "MARKET_CLOSED"
LOGIN_PENDING = "LOGIN_PENDING"
LOGGING_IN = "LOGGING_IN"
LOGGED_IN = "LOGGED_IN"
SESSION_VALID = "SESSION_VALID"
WS_CONNECTING = "WS_CONNECTING"
WS_CONNECTED = "WS_CONNECTED"
WS_DISCONNECTED = "WS_DISCONNECTED"
WS_STOPPING = "WS_STOPPING"
LOGGED_OUT = "LOGGED_OUT"
FAILED = "FAILED"


def _iso(ts) -> str | None:
    try:
        return iso_ist(datetime.fromtimestamp(ts, tz=UTC))
    except Exception:
        return None


def _now_iso() -> str:
    try:
        return iso_ist(datetime.now(tz=UTC))
    except Exception:
        return ""


class ShoonyaLifecycleDriver:
    """Independent scheduled lifecycle owner for the Shoonya terminal."""

    BROKER = "shoonya"
    BROKER_NAME = "Shoonya"

    def __init__(self, controller: Any) -> None:
        self.controller = controller
        self._last_event: dict | None = None
        self._prev_ws: str | None = None
        self._login_triggered_date: str | None = None
        self._oauth_warned_date: str | None = None
        self._login_blocked_date: str | None = None
        self._ws_stop_fired_date: str | None = None

    # ------------------------------------------------------------------
    # Capability / adapter access (lazy; never fails a tick)
    # ------------------------------------------------------------------

    def _adapter(self):
        from brokers.shoonya_adapter import shoonya_adapter
        return shoonya_adapter

    def logged_in(self) -> bool:
        try:
            return bool(self._adapter().is_logged_in)
        except Exception:
            return False

    def has_auth_code(self) -> bool:
        try:
            return bool(getattr(self._adapter(), "_pending_auth_code", None))
        except Exception:
            return False

    def oauth_url(self) -> str | None:
        try:
            return self._adapter().oauth_url()
        except Exception:
            return None

    def _terminal(self) -> dict[str, Any]:
        try:
            rec = session_manager.terminal_session("shoonya")
            return rec if isinstance(rec, dict) else {}
        except Exception:
            return {}

    def ws_state(self) -> str:
        try:
            st = (self._terminal().get("connection_status") or "DISCONNECTED").upper()
        except Exception:
            st = "DISCONNECTED"
        return st if st in {"CONNECTED", "DISCONNECTED", "CONNECTING", "STOPPED"} else "DISCONNECTED"

    # ------------------------------------------------------------------
    # Event emission (deduped per transition/date so ticks stay cheap)
    # ------------------------------------------------------------------

    def _emit(self, record_event: Callable, event: str, message: str,
              meta: dict | None = None, *, force: bool = False) -> None:
        last = self._last_event
        if not force and last and last.get("event") == event and last.get("message") == message:
            return
        try:
            record_event("scheduler", event, "info", message, {
                "broker": self.BROKER, **(meta or {}),
            })
        except Exception:
            pass
        self._last_event = {"event": event, "message": message, "at_ist": _now_iso(),
                            "meta": meta or {}}

    # ------------------------------------------------------------------
    # Primary (global view) mirror when Kotak is disabled
    # ------------------------------------------------------------------

    def _mirror_primary(self, bridge: str, message: str) -> None:
        mapper = {
            MARKET_CLOSED: "STATE_MARKET_CLOSED",
            LOGIN_PENDING: "STATE_WAITING_FOR_LOGIN",
            LOGGING_IN: "STATE_LOGGING_IN",
            LOGGED_IN: "STATE_SESSION_ACTIVE",
            SESSION_VALID: "STATE_SESSION_ACTIVE",
            WS_CONNECTING: "STATE_WS_CONNECTING",
            WS_CONNECTED: "STATE_WS_ACTIVE",
            WS_DISCONNECTED: "STATE_WS_RECONNECTING",
            WS_STOPPING: "STATE_WS_DISCONNECTING",
            LOGGED_OUT: "STATE_LOGGED_OUT",
            FAILED: "STATE_ERROR",
        }
        const_name = mapper.get(bridge)
        if not const_name:
            return
        try:
            from scheduler import __dict__ as _sched
            state_val = _sched.get(const_name)
            if state_val is not None:
                self.controller._set_state(state_val, message or bridge)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Core reconcile (called once per scheduler tick per broker)
    # ------------------------------------------------------------------

    async def reconcile(
        self,
        *,
        now: datetime,
        slot: dict[str, Any],
        times: dict[str, tuple[int, int]],
        today_iso: str,
        today_status: dict[str, str],
        record_event: Callable,
        is_primary: bool,
    ) -> dict[str, Any]:
        log = self.logged_in()
        ws = self.ws_state()
        bridge = self._bridge(slot, today_status, log, ws)
        message = self._bridge_message(bridge, slot, today_status, log, ws)

        try:
            await self._act(now, slot, times, today_status, record_event, bridge, log, ws)
        except Exception as exc:
            _log.exception("Shoonya lifecycle reconcile error: %s", exc)
            bridge = FAILED
            message = f"reconcile error: {exc}"

        # Re-read after actions (a login/logout may have just happened).
        log = self.logged_in()
        ws = self.ws_state()
        bridge = self._bridge(slot, today_status, log, ws)
        if is_primary:
            self._mirror_primary(bridge, message)

        return self._report(slot, times, today_status, log, ws, bridge, message, is_primary)

    # ------------------------------------------------------------------
    # Determination
    # ------------------------------------------------------------------

    @staticmethod
    def _login_blocked(today_status: dict[str, str]) -> bool:
        return today_status.get("login") in {"MISSED_EXPIRED", "SKIPPED"}

    def _bridge(self, slot, today_status, log, ws) -> str:
        if not slot["trading_day"]:
            return MARKET_CLOSED
        if log:
            if slot["past_logout"]:
                return LOGGED_OUT
            if slot["in_ws_window"]:
                return WS_CONNECTED if ws == "CONNECTED" else WS_CONNECTING
            if slot.get("past_ws_stop"):
                return WS_STOPPING
            return SESSION_VALID
        if self._login_blocked(today_status):
            return FAILED
        if slot["past_logout"]:
            return LOGGED_OUT
        if slot["in_login_window"]:
            return LOGGING_IN if self.has_auth_code() else LOGIN_PENDING
        return LOGIN_PENDING

    @staticmethod
    def _bridge_message(bridge, slot, today_status, log, ws) -> str:
        if bridge == MARKET_CLOSED:
            return "not a trading day"
        if bridge == LOGGED_OUT:
            return "scheduled logout completed"
        if bridge == FAILED:
            return "scheduled login window expired; no automatic session"
        if bridge == LOGIN_PENDING:
            return "awaiting Shoonya OAuth code" if not log else "waiting for login window"
        if bridge == LOGGING_IN:
            return "exchanging OAuth code"
        if bridge == WS_CONNECTING:
            return "Shoonya feed connecting"
        if bridge == WS_CONNECTED:
            return "Shoonya feed live"
        if bridge == WS_STOPPING:
            return "Shoonya feed stopped; session retained"
        return "Shoonya session active"

    # ------------------------------------------------------------------
    # Actions (side effects — the ONLY place Shoonya is driven)
    # ------------------------------------------------------------------

    async def _act(self, now, slot, times, today_status, record_event,
                   bridge, log, ws) -> None:
        adapter = self._adapter()
        login_blocked = self._login_blocked(today_status)
        past_ws_stop = bool(slot.get("past_ws_stop"))

        # Not a trading day / past logout: honest teardown only.
        if (not slot["trading_day"]) or slot["past_logout"]:
            if log:
                await adapter.logout(
                    reason="market_closed" if not slot["trading_day"] else "scheduled_logout",
                    register_central=False,
                )
                self._emit(record_event, "LOGOUT_SUCCESS",
                           "Scheduled Shoonya logout completed",
                           {"reason": "market_closed" if not slot["trading_day"] else "scheduled_logout"})
            elif ws in {"CONNECTED", "CONNECTING"}:
                adapter.stop_feed(
                    reason="market_closed" if not slot["trading_day"] else "scheduled_disconnect")
                self._emit(record_event, "WS_STOP_TRIGGERED",
                           "Shoonya feed stopped (market closed/logout)")
            return

        if log:
            # Feed must be live inside the WS window; reconnect on drops.
            if slot["in_ws_window"]:
                if ws != "CONNECTED":
                    prev_was_connected = self._prev_ws == "CONNECTED"
                    await adapter.ensure_feed(ws_scope=self.BROKER)
                    new_ws = self.ws_state()
                    if new_ws == "CONNECTED":
                        self._emit(record_event, "WS_CONNECTED",
                                   "Shoonya feed connected",
                                   {"reconnect": prev_was_connected})
                    elif prev_was_connected:
                        self._emit(record_event, "WS_DISCONNECTED",
                                   "Shoonya feed disconnected (reconnecting)")
                    else:
                        self._emit(record_event, "WS_START_TRIGGERED",
                                   "Shoonya feed start triggered")
            # Between ws_stop and logout the feed is intentionally held closed.
            if past_ws_stop and ws in {"CONNECTED", "CONNECTING"}:
                adapter.stop_feed(reason="scheduled_disconnect")
                self._ws_stop_fired_date = None
                self._emit(record_event, "WS_STOP_TRIGGERED",
                           "Shoonya feed stopped (scheduled)")
        else:
            if login_blocked:
                if self._login_blocked_date != now.date().isoformat():
                    self._login_blocked_date = now.date().isoformat()
                    self._emit(record_event, "LOGIN_TRIGGERED",
                               "Shoonya scheduled login blocked for the day",
                               {"reason_code": "LOGIN_WINDOW_EXPIRED"})
                return
            if slot["in_login_window"]:
                if self.has_auth_code():
                    self._emit(record_event, "LOGIN_STARTED",
                               "Shoonya scheduled login starting")
                    try:
                        ok = await adapter.login(register_central=False, ws_scope=self.BROKER)
                        if ok:
                            self._emit(record_event, "LOGIN_SUCCESS",
                                       "Shoonya scheduled login successful")
                        else:
                            self._emit(record_event, "LOGIN_FAILED",
                                       "Shoonya scheduled login failed")
                    except Exception as exc:
                        self._emit(record_event, "LOGIN_FAILED",
                                   f"Shoonya scheduled login failed: {exc}")
                else:
                    today = now.date().isoformat()
                    if self._oauth_warned_date != today:
                        self._oauth_warned_date = today
                        self._emit(record_event, "SHOONYA_OAUTH_CODE_REQUIRED",
                                   "Complete the Shoonya OAuth handshake to log in",
                                   {"accept_endpoint": "/api/shoonya/oauth-code",
                                    "oauth_url": self.oauth_url() or ""})
                    if self._login_triggered_date != today:
                        self._login_triggered_date = today
                        self._emit(record_event, "LOGIN_TRIGGERED",
                                   "Shoonya scheduled login pending (no OAuth code yet)",
                                   {"oauth": "pending"})
        self._prev_ws = self.ws_state()

    # ------------------------------------------------------------------
    # Report (consumers: /api/scheduler/status + frontend broker cards)
    # ------------------------------------------------------------------

    def _report(self, slot, times, today_status, log, ws, bridge, message,
                is_primary) -> dict[str, Any]:
        term = self._terminal()
        login_t = times["login"]
        ws_start_t = times["ws_start"]
        ws_stop_t = times["ws_stop"]
        logout_t = times["logout"]
        last_msg = term.get("ws_last_message_at")
        return {
            "broker": self.BROKER,
            "broker_name": self.BROKER_NAME,
            "enabled": True,
            "primary": is_primary,
            "state": bridge,
            "state_message": message,
            "login": {
                "state": (LOGGED_IN if log else bridge),
                "in_window": bool(slot["in_login_window"]),
                "blocked": self._login_blocked(today_status),
                "window": f"{login_t[0]:02d}:{login_t[1]:02d}",
            },
            "ws": {
                "state": ws,
                "connected": ws == "CONNECTED",
                "start": f"{ws_start_t[0]:02d}:{ws_start_t[1]:02d}",
                "stop": f"{ws_stop_t[0]:02d}:{ws_stop_t[1]:02d}",
                "last_message_at": _iso(last_msg) if last_msg else None,
                "reason": term.get("ws_reason"),
            },
            "logout": {
                "time": f"{logout_t[0]:02d}:{logout_t[1]:02d}",
            },
            "oauth": {
                "required": not log and slot["in_login_window"] and not self.has_auth_code(),
                "url": self.oauth_url() if not log else None,
                "code_provided": self.has_auth_code(),
                "accept_endpoint": "/api/shoonya/oauth-code",
            },
            "session": {
                "active": log,
                "login_source": term.get("login_source"),
                "login_time": _iso(term.get("created_at")) if term.get("created_at") else None,
                "expires_at": _iso(term.get("expires_at")) if term.get("expires_at") else None,
            },
            "ledger": {
                "login": today_status.get("login"),
                "ws_start": today_status.get("ws_start"),
                "tick_collection": today_status.get("tick_collection"),
                "ws_stop": today_status.get("ws_stop"),
                "logout": today_status.get("logout"),
            },
            "last_event": self._last_event,
        }