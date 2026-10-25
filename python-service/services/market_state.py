"""Market State Service — single authoritative source of truth for market state.

Decision hierarchy (in priority order):
    1. Official broker/exchange holiday/status
    2. Weekend rule (Saturday/Sunday)
    3. Known exchange trading calendar (from market_calendar)
    4. Scheduled market hours
    5. 09:13-09:17 WebSocket confirmation window
    6. Live tick state

The service separates these distinct states:
    - OFFICIAL_HOLIDAY    broker/exchange says holiday
    - WEEKEND             Saturday/Sunday
    - MARKET_OPEN         live ticks received
    - MARKET_CLOSED       market hours ended (15:31+)
    - PRE_MARKET          before 09:00
    - MARKET_OPEN_CHECKING 09:13-09:17 confirmation window
    - NO_TICKS_AFTER_CONFIRMATION  WS connected but no ticks 09:13-09:17
    - NETWORK_OFFLINE     internet connectivity lost
    - BROKER_UNAVAILABLE  broker API unreachable
    - AUTH_REQUIRED       session expired / not authenticated
    - SUBSCRIPTION_FAILED WS connected but subscription failed
    - WEBSOCKET_ERROR     WS connection error (not market closed)
    - UNKNOWN

CRITICALLY: absence of ticks is NEVER evidence of a holiday.
A network failure is NEVER market closed.
A WebSocket failure is NEVER market closed.
"""
from __future__ import annotations

import logging
import threading
import time as _time
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional

from services import market_calendar

logger = logging.getLogger("market_state")

from core.timezones import IST

# ── Market state constants ────────────────────────────────────────────
PRE_MARKET = "PRE_MARKET"
MARKET_OPEN = "MARKET_OPEN"
MARKET_CLOSED = "MARKET_CLOSED"
EXCHANGE_HOLIDAY = "EXCHANGE_HOLIDAY"
WEEKEND = "WEEKEND"
MARKET_OPEN_CHECKING = "MARKET_OPEN_CHECKING"
NO_TICKS_AFTER_CONFIRMATION = "NO_TICKS_AFTER_CONFIRMATION"
NETWORK_OFFLINE = "NETWORK_OFFLINE"
BROKER_UNAVAILABLE = "BROKER_UNAVAILABLE"
AUTH_REQUIRED = "AUTH_REQUIRED"
SUBSCRIPTION_FAILED = "SUBSCRIPTION_FAILED"
WEBSOCKET_ERROR = "WEBSOCKET_ERROR"
UNKNOWN = "UNKNOWN"
SPECIAL_CLOSURE_STATE = "SPECIAL_CLOSURE"

# ── Reason code constants ─────────────────────────────────────────────
RC_EXCHANGE_HOLIDAY = "EXCHANGE_HOLIDAY"
RC_WEEKEND = "WEEKEND"
RC_SPECIAL_CLOSURE = "SPECIAL_CLOSURE"
RC_LIVE_TICKS_RECEIVED = "LIVE_TICKS_RECEIVED"
RC_MARKET_WINDOW_CLOSED = "MARKET_WINDOW_CLOSED"
RC_NO_TICKS_AFTER_OPEN_CONFIRMATION = "NO_TICKS_AFTER_OPEN_CONFIRMATION"
RC_NETWORK_OFFLINE = "NETWORK_OFFLINE"
RC_BROKER_UNAVAILABLE = "BROKER_UNAVAILABLE"
RC_AUTH_REQUIRED = "AUTH_REQUIRED"
RC_SUBSCRIPTION_FAILED = "SUBSCRIPTION_FAILED"
RC_WEBSOCKET_ERROR = "WEBSOCKET_ERROR"
RC_UNKNOWN = "UNKNOWN"
RC_PRE_MARKET = "PRE_MARKET"
RC_MARKET_HOURS = "MARKET_HOURS"
RC_BROKER_REPORTED_HOLIDAY = "BROKER_REPORTED_HOLIDAY"

# ── Confirmation window defaults ──────────────────────────────────────
CONFIRMATION_WINDOW_START = time(9, 13, 0)   # IST
CONFIRMATION_WINDOW_END = time(9, 17, 0)     # IST
MARKET_CLOSE_TIME = time(15, 31, 0)          # IST — WS stop time


@dataclass
class MarketStateSnapshot:
    """Immutable snapshot of the current market state."""
    market_state: str
    reason_code: str
    reason_message: str
    source: str
    checked_at: str
    trading_day: bool
    day_class: str
    market_session: str
    market_status: str
    closure_reason: Optional[str]
    is_weekend: bool
    is_exchange_holiday: bool
    is_special_closure: bool
    confirmation_window_active: bool
    confirmation_window_start: Optional[str]
    confirmation_window_end: Optional[str]
    ticks_received_in_window: int
    unique_instruments_with_ticks: int
    first_tick_at: Optional[str]
    last_tick_at: Optional[str]
    websocket_connected: bool
    subscriptions_active: int
    network_ok: bool
    next_market_open: Optional[str]
    next_market_close: Optional[str]

    def to_dict(self) -> dict:
        return {
            "market_state": self.market_state,
            "reason_code": self.reason_code,
            "reason_message": self.reason_message,
            "source": self.source,
            "checked_at": self.checked_at,
            "trading_day": self.trading_day,
            "day_class": self.day_class,
            "market_session": self.market_session,
            "market_status": self.market_status,
            "closure_reason": self.closure_reason,
            "is_weekend": self.is_weekend,
            "is_exchange_holiday": self.is_exchange_holiday,
            "is_special_closure": self.is_special_closure,
            "confirmation_window_active": self.confirmation_window_active,
            "confirmation_window_start": self.confirmation_window_start,
            "confirmation_window_end": self.confirmation_window_end,
            "ticks_received_in_window": self.ticks_received_in_window,
            "unique_instruments_with_ticks": self.unique_instruments_with_ticks,
            "first_tick_at": self.first_tick_at,
            "last_tick_at": self.last_tick_at,
            "websocket_connected": self.websocket_connected,
            "subscriptions_active": self.subscriptions_active,
            "network_ok": self.network_ok,
            "next_market_open": self.next_market_open,
            "next_market_close": self.next_market_close,
        }


@dataclass
class DailyDecision:
    """Persisted daily market decision record."""
    date: str
    exchange: str
    weekday: str
    official_status: str
    official_reason: Optional[str]
    websocket_started_at: Optional[str] = None
    websocket_connected_at: Optional[str] = None
    subscription_completed_at: Optional[str] = None
    confirmation_window_start: Optional[str] = None
    confirmation_window_end: Optional[str] = None
    first_tick_at: Optional[str] = None
    ticks_received_during_confirmation: int = 0
    final_market_decision: Optional[str] = None
    final_reason: Optional[str] = None
    decision_source: Optional[str] = None
    websocket_closed_at: Optional[str] = None

    def to_dict(self) -> dict:
        return {k: v for k, v in self.__dict__.items()}


class MarketStateService:
    """Single authoritative source of truth for market state.

    Thread-safe: all mutable state is protected by a lock.
    The scheduler and WebSocket manager feed events into this service,
    and all API endpoints / frontend pages read from it.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()

        # Current state
        self._market_state: str = UNKNOWN
        self._reason_code: str = RC_UNKNOWN
        self._reason_message: str = "Market state not yet determined"
        self._source: str = "initialization"

        # Confirmation window tracking
        self._confirmation_started: bool = False
        self._confirmation_window_start_at: Optional[str] = None
        self._confirmation_window_end_at: Optional[str] = None
        self._ticks_in_window: int = 0
        self._unique_instruments_in_window: set = set()
        self._first_tick_at: Optional[str] = None
        self._last_tick_at: Optional[str] = None
        self._tick_receive_times: list = []

        # Connection health
        self._websocket_connected: bool = False
        self._subscriptions_active: int = 0
        self._network_ok: bool = True
        self._subscription_succeeded: bool = False

        # Daily decision record
        self._daily_decision: Optional[DailyDecision] = None

        # Whether the 09:17 no-tick decision has been made
        self._confirmation_decided: bool = False

        # Event log
        self._event_log: list = []

    # ── Public API ────────────────────────────────────────────────────

    def evaluate(self, now: Optional[datetime] = None) -> MarketStateSnapshot:
        """Evaluate and return the current market state snapshot.

        This is the main entry point. Call from scheduler tick, API, or frontend.
        Does NOT modify state — pure evaluation.
        """
        now = now or datetime.now(IST)
        if isinstance(now, datetime):
            now = now.astimezone(IST)

        d = now.date()
        cls = market_calendar.day_class(d)
        session = market_calendar.market_session(now)
        snap = market_calendar.snapshot(now)

        with self._lock:
            ws_connected = self._websocket_connected
            subs = self._subscriptions_active
            net_ok = self._network_ok
            ticks_in_win = self._ticks_in_window
            unique_inst = len(self._unique_instruments_in_window)
            first_tick = self._first_tick_at
            last_tick = self._last_tick_at
            conf_active = self._is_confirmation_window_active(now)
            conf_start = self._confirmation_window_start_at
            conf_end = self._confirmation_window_end_at

        # Decision hierarchy
        market_state, reason_code, reason_message, source = self._decide(
            now, cls, session, snap, ws_connected, subs, net_ok,
            ticks_in_win, unique_inst, conf_active,
        )

        return MarketStateSnapshot(
            market_state=market_state,
            reason_code=reason_code,
            reason_message=reason_message,
            source=source,
            checked_at=now.isoformat(),
            trading_day=market_calendar.is_trading_day(d),
            day_class=cls,
            market_session=session,
            market_status=market_calendar.market_status(now),
            closure_reason=market_calendar.closure_reason(d),
            is_weekend=(cls == market_calendar.WEEKEND),
            is_exchange_holiday=(cls == market_calendar.EXCHANGE_HOLIDAY),
            is_special_closure=(cls == market_calendar.SPECIAL_CLOSURE),
            confirmation_window_active=conf_active,
            confirmation_window_start=conf_start,
            confirmation_window_end=conf_end,
            ticks_received_in_window=ticks_in_win,
            unique_instruments_with_ticks=unique_inst,
            first_tick_at=first_tick,
            last_tick_at=last_tick,
            websocket_connected=ws_connected,
            subscriptions_active=subs,
            network_ok=net_ok,
            next_market_open=snap.get("next_market_open"),
            next_market_close=snap.get("next_market_close"),
        )

    def get_state(self) -> str:
        """Return just the current market state string."""
        with self._lock:
            return self._market_state

    def get_snapshot(self) -> dict:
        """Return full market state as a dict (for API consumption)."""
        return self.evaluate().to_dict()

    # ── Event feed from WebSocket manager ─────────────────────────────

    def on_websocket_connected(self) -> None:
        """Called when WebSocket successfully connects."""
        now_str = datetime.now(IST).isoformat()
        with self._lock:
            self._websocket_connected = True
        self._record_event("WS_CONNECTED", f"WebSocket connected at {now_str}")
        self._log_decision("WS_CONNECTED", now_str)

    def on_websocket_disconnected(self, reason: str = "") -> None:
        """Called when WebSocket disconnects."""
        with self._lock:
            self._websocket_connected = False
        self._record_event("WS_DISCONNECTED", f"WebSocket disconnected: {reason}")

    def on_subscriptions_ready(self, count: int) -> None:
        """Called when subscriptions are confirmed active."""
        now_str = datetime.now(IST).isoformat()
        with self._lock:
            self._subscriptions_active = count
            self._subscription_succeeded = True
        self._record_event("SUBSCRIPTIONS_READY", f"{count} subscriptions active")
        self._log_decision("SUBSCRIPTIONS_READY", now_str)

    def on_tick_received(self, instrument_token: str, timestamp: Optional[str] = None) -> None:
        """Called for each valid live tick from the broker WebSocket.

        This is the ONLY way to confirm market is open.
        Repeated same-price ticks from different broker events still count.
        """
        now = datetime.now(IST)
        now_iso = now.isoformat()
        with self._lock:
            self._ticks_in_window += 1
            self._unique_instruments_in_window.add(instrument_token)
            if self._first_tick_at is None:
                self._first_tick_at = now_iso
            self._last_tick_at = now_iso
            self._tick_receive_times.append(now.time())

        # If we receive a tick during confirmation window, market is OPEN
        if self._is_confirmation_window_active(now):
            self._record_event(
                "FIRST_TICK_RECEIVED" if self._ticks_in_window == 1 else "TICK_RECEIVED",
                f"Tick from {instrument_token} at {now_iso}",
            )
            # If we were waiting for confirmation, confirm market open
            if self._market_state in {MARKET_OPEN_CHECKING, PRE_MARKET, UNKNOWN}:
                self._set_state(
                    MARKET_OPEN, RC_LIVE_TICKS_RECEIVED,
                    f"Live SFeed ticks received ({self._ticks_in_window} ticks, "
                    f"{len(self._unique_instruments_in_window)} instruments)",
                    "kotak_sfeed",
                )

    def on_network_offline(self) -> None:
        """Called when internet connectivity is lost."""
        with self._lock:
            self._network_ok = False
        self._set_state(
            NETWORK_OFFLINE, RC_NETWORK_OFFLINE,
            "Internet connectivity lost — this is NOT market closed",
            "network_check",
        )

    def on_network_online(self) -> None:
        """Called when internet connectivity is restored."""
        with self._lock:
            self._network_ok = True
        self._record_event("NETWORK_RESTORED", "Internet connectivity restored")

    def on_broker_error(self, error: str) -> None:
        """Called when broker WebSocket encounters an error."""
        # Do NOT set MARKET_CLOSED — this is a broker failure
        self._record_event("BROKER_ERROR", error)

    def on_auth_failure(self) -> None:
        """Called when authentication fails."""
        if self._market_state not in {EXCHANGE_HOLIDAY, WEEKEND, MARKET_CLOSED}:
            self._set_state(
                AUTH_REQUIRED, RC_AUTH_REQUIRED,
                "Broker authentication failed — this is NOT market closed",
                "kotak_auth",
            )

    def on_subscription_failed(self, error: str) -> None:
        """Called when subscription request fails."""
        with self._lock:
            self._subscription_succeeded = False
        self._record_event("SUBSCRIPTION_FAILED", error)

    # ── Confirmation window management ────────────────────────────────

    def start_confirmation_window(self) -> None:
        """Called at 09:13 IST to begin the confirmation window."""
        now_str = datetime.now(IST).isoformat()
        with self._lock:
            self._confirmation_started = True
            self._confirmation_window_start_at = now_str
            self._confirmation_window_end_at = None
            self._ticks_in_window = 0
            self._unique_instruments_in_window = set()
            self._first_tick_at = None
            self._last_tick_at = None
            self._tick_receive_times = []
            self._confirmation_decided = False

        self._set_state(
            MARKET_OPEN_CHECKING, RC_MARKET_HOURS,
            "09:13-09:17 confirmation window started — waiting for WebSocket connection and live ticks",
            "scheduler",
        )
        self._record_event("WS_CONFIRMATION_STARTED", f"Confirmation window: {CONFIRMATION_WINDOW_START}-{CONFIRMATION_WINDOW_END} IST")
        self._log_decision("WS_CONFIRMATION_STARTED", now_str)

    def evaluate_confirmation_deadline(self) -> Optional[MarketStateSnapshot]:
        """Called at 09:17 IST to evaluate the confirmation window result.

        Returns the final market state snapshot if a decision is made.
        Returns None if the window is not yet over or was already decided.
        """
        now = datetime.now(IST)
        with self._lock:
            if self._confirmation_decided:
                return None
            if not self._is_confirmation_window_active(now):
                # Window has passed — make decision
                self._confirmation_decided = True

                ws_ok = self._websocket_connected
                subs_ok = self._subscription_succeeded and self._subscriptions_active > 0
                net_ok = self._network_ok
                ticks = self._ticks_in_window

                now_str = now.isoformat()
                with self._lock:
                    self._confirmation_window_end_at = now_str

                if ws_ok and subs_ok and net_ok and ticks == 0:
                    # Connected, subscribed, no network issue, but zero ticks
                    self._set_state(
                        NO_TICKS_AFTER_CONFIRMATION,
                        RC_NO_TICKS_AFTER_OPEN_CONFIRMATION,
                        "WebSocket connected and subscriptions active, but no live ticks "
                        "received during 09:13-09:17 confirmation window",
                        "websocket_confirmation",
                    )
                    self._record_event(
                        "NO_TICKS_CONFIRMATION",
                        "No ticks during confirmation — market appears closed",
                    )
                    self._log_decision("NO_TICKS_AFTER_CONFIRMATION", now_str)
                    # Persist the daily decision
                    self._persist_daily_decision(
                        final_decision=NO_TICKS_AFTER_CONFIRMATION,
                        final_reason="No live ticks during 09:13-09:17 confirmation",
                        decision_source="websocket_confirmation",
                    )
                elif ws_ok and ticks > 0:
                    # Ticks arrived — market is open
                    self._set_state(
                        MARKET_OPEN, RC_LIVE_TICKS_RECEIVED,
                        f"Market open confirmed: {ticks} ticks from "
                        f"{len(self._unique_instruments_in_window)} instruments",
                        "kotak_sfeed",
                    )
                    self._record_event("MARKET_OPEN_CONFIRMED", f"Ticks={ticks}")
                    self._log_decision("MARKET_OPEN", now_str)
                    self._persist_daily_decision(
                        final_decision=MARKET_OPEN,
                        final_reason=f"Live ticks received ({ticks})",
                        decision_source="kotak_sfeed",
                    )
                elif not net_ok:
                    # Network was down — NOT market closed
                    self._set_state(
                        NETWORK_OFFLINE, RC_NETWORK_OFFLINE,
                        "Confirmation deadline reached but network was offline — "
                        "cannot determine market state",
                        "network_check",
                    )
                elif not ws_ok:
                    # WS never connected — NOT market closed
                    self._set_state(
                        WEBSOCKET_ERROR, RC_WEBSOCKET_ERROR,
                        "Confirmation deadline reached but WebSocket never connected — "
                        "this is a connection failure, not market closed",
                        "websocket_confirmation",
                    )
                else:
                    # Edge case: WS connected but subscription failed
                    self._set_state(
                        SUBSCRIPTION_FAILED, RC_SUBSCRIPTION_FAILED,
                        "Confirmation deadline reached but subscriptions were not established",
                        "websocket_confirmation",
                    )

                return self.evaluate(now)

        return None

    def stop_market_feed(self) -> None:
        """Called at 15:31 IST to cleanly stop the market feed."""
        now_str = datetime.now(IST).isoformat()
        with self._lock:
            self._websocket_connected = False
            self._subscriptions_active = 0

        self._set_state(
            MARKET_CLOSED, RC_MARKET_WINDOW_CLOSED,
            "Market window closed (15:31 IST) — feed stopped for the day",
            "scheduler",
        )
        self._record_event("MARKET_WINDOW_CLOSED", "Feed stopped at 15:31 IST")
        self._log_decision("MARKET_WINDOW_CLOSED", now_str)
        self._persist_daily_decision(
            final_decision=MARKET_CLOSED,
            final_reason="Market window closed at 15:31 IST",
            decision_source="scheduler",
        )

    def reset_daily(self) -> None:
        """Reset daily state for a new trading day."""
        with self._lock:
            self._confirmation_started = False
            self._confirmation_window_start_at = None
            self._confirmation_window_end_at = None
            self._ticks_in_window = 0
            self._unique_instruments_in_window = set()
            self._first_tick_at = None
            self._last_tick_at = None
            self._tick_receive_times = []
            self._websocket_connected = False
            self._subscriptions_active = 0
            self._network_ok = True
            self._subscription_succeeded = False
            self._confirmation_decided = False
            self._daily_decision = None
            self._event_log = []
        self._set_state(UNKNOWN, RC_UNKNOWN, "Daily reset", "scheduler")

    # ── Private: decision hierarchy ───────────────────────────────────

    def _decide(
        self,
        now: datetime,
        cls: str,
        session: str,
        snap: dict,
        ws_connected: bool,
        subs: int,
        net_ok: bool,
        ticks_in_win: int,
        unique_inst: int,
        conf_active: bool,
    ) -> tuple[str, str, str, str]:
        """Apply the decision hierarchy to determine market state."""

        # 1. Official exchange holiday
        if cls == market_calendar.EXCHANGE_HOLIDAY:
            reason = snap.get("closure_reason") or "Exchange holiday"
            return (
                EXCHANGE_HOLIDAY,
                RC_EXCHANGE_HOLIDAY,
                reason,
                "market_calendar",
            )

        # 2. Weekend
        if cls == market_calendar.WEEKEND:
            return (
                WEEKEND,
                RC_WEEKEND,
                "Weekend — market closed",
                "market_calendar",
            )

        # 3. Special closure
        if cls == market_calendar.SPECIAL_CLOSURE:
            reason = snap.get("closure_reason") or "Special market closure"
            return (
                SPECIAL_CLOSURE_STATE,
                RC_SPECIAL_CLOSURE,
                reason,
                "market_calendar",
            )

        # 4. Not a trading day (shouldn't reach here if above checks work,
        #    but defensive)
        if not market_calendar.is_trading_day(now.date()):
            return (
                MARKET_CLOSED,
                RC_EXCHANGE_HOLIDAY,
                snap.get("closure_reason") or "Not a trading day",
                "market_calendar",
            )

        # From here on: it IS a trading day (weekday, not a holiday)

        # 5. Past market close time (15:31+)
        t = now.time()
        if t >= MARKET_CLOSE_TIME:
            return (
                MARKET_CLOSED,
                RC_MARKET_WINDOW_CLOSED,
                "Market window closed (past 15:31 IST)",
                "scheduler",
            )

        # 6. Before market window (before 09:00)
        if t < time(9, 0, 0):
            return (
                PRE_MARKET,
                RC_PRE_MARKET,
                f"Pre-market — market opens at 09:15 IST, login at 09:00 IST",
                "market_calendar",
            )

        # 7. Confirmation window active (09:13-09:17)
        if conf_active:
            if ticks_in_win > 0:
                return (
                    MARKET_OPEN,
                    RC_LIVE_TICKS_RECEIVED,
                    f"Market open: {ticks_in_win} live ticks from {unique_inst} instruments "
                    f"during confirmation window",
                    "kotak_sfeed",
                )
            # Still in window, waiting for ticks
            if not ws_connected and not net_ok:
                return (
                    NETWORK_OFFLINE,
                    RC_NETWORK_OFFLINE,
                    "Confirmation window active but network is offline",
                    "network_check",
                )
            if not ws_connected:
                return (
                    WEBSOCKET_ERROR,
                    RC_WEBSOCKET_ERROR,
                    "Confirmation window active but WebSocket not yet connected",
                    "scheduler",
                )
            return (
                MARKET_OPEN_CHECKING,
                RC_MARKET_HOURS,
                f"Confirmation window active (09:13-09:17) — "
                f"WS={'connected' if ws_connected else 'disconnected'}, "
                f"subs={subs}, ticks={ticks_in_win}",
                "scheduler",
            )

        # 8. Inside market hours (09:17 - 15:31) but after confirmation
        if ws_connected and ticks_in_win > 0:
            return (
                MARKET_OPEN,
                RC_LIVE_TICKS_RECEIVED,
                f"Market open: receiving live ticks ({ticks_in_win} total, "
                f"{unique_inst} instruments)",
                "kotak_sfeed",
            )

        if ws_connected and not net_ok:
            return (
                NETWORK_OFFLINE,
                RC_NETWORK_OFFLINE,
                "WebSocket connected but network degraded",
                "network_check",
            )

        if not ws_connected and not net_ok:
            return (
                NETWORK_OFFLINE,
                RC_NETWORK_OFFLINE,
                "Network offline — market state cannot be confirmed",
                "network_check",
            )

        if not ws_connected:
            return (
                WEBSOCKET_ERROR,
                RC_WEBSOCKET_ERROR,
                "WebSocket disconnected during market hours — attempting reconnect",
                "scheduler",
            )

        # WS connected but no ticks yet (normal during early hours)
        return (
            MARKET_OPEN,
            RC_MARKET_HOURS,
            f"Market hours active (session={session}), WS connected, "
            f"awaiting first tick",
            "market_calendar",
        )

    # ── Private: helpers ──────────────────────────────────────────────

    def _is_confirmation_window_active(self, now: datetime) -> bool:
        """Check if current time is within the 09:13-09:17 confirmation window."""
        if not market_calendar.is_trading_day(now.date()):
            return False
        t = now.time()
        return CONFIRMATION_WINDOW_START <= t < CONFIRMATION_WINDOW_END

    def _set_state(
        self,
        market_state: str,
        reason_code: str,
        reason_message: str,
        source: str,
    ) -> None:
        """Transition to a new market state."""
        with self._lock:
            old_state = self._market_state
            self._market_state = market_state
            self._reason_code = reason_code
            self._reason_message = reason_message
            self._source = source
        if old_state != market_state:
            logger.info(
                "[MARKET] state=%s -> %s reason_code=%s source=%s",
                old_state, market_state, reason_code, source,
            )

    def _record_event(self, event: str, message: str) -> None:
        """Record an event in the audit trail."""
        now_str = datetime.now(IST).isoformat()
        with self._lock:
            self._event_log.append({
                "event": event,
                "message": message,
                "ts": now_str,
            })
        try:
            from services.notification_center import emit_event as record_event
            record_event("market_state", event, "info", message)
        except Exception:
            pass

    def _log_decision(self, decision: str, timestamp: str) -> None:
        """Log a market state decision for auditability."""
        logger.info(
            "[MARKET] decision=%s timestamp=%s state=%s reason=%s",
            decision, timestamp, self._market_state, self._reason_code,
        )

    def _persist_daily_decision(
        self,
        final_decision: str,
        final_reason: str,
        decision_source: str,
    ) -> None:
        """Persist the daily market decision record."""
        now = datetime.now(IST)
        with self._lock:
            self._daily_decision = DailyDecision(
                date=now.date().isoformat(),
                exchange="NSE",
                weekday=now.strftime("%A"),
                official_status=market_calendar.day_class(now.date()),
                official_reason=market_calendar.closure_reason(now.date()),
                websocket_started_at=self._confirmation_window_start_at,
                websocket_connected_at=self._first_tick_at,
                subscription_completed_at=self._confirmation_window_start_at,
                confirmation_window_start=self._confirmation_window_start_at,
                confirmation_window_end=self._confirmation_window_end_at,
                first_tick_at=self._first_tick_at,
                ticks_received_during_confirmation=self._ticks_in_window,
                final_market_decision=final_decision,
                final_reason=final_reason,
                decision_source=decision_source,
                websocket_closed_at=now.isoformat() if final_decision == MARKET_CLOSED else None,
            )

    def get_daily_decision(self) -> Optional[dict]:
        """Return the persisted daily decision record."""
        with self._lock:
            return self._daily_decision.to_dict() if self._daily_decision else None

    def get_event_log(self) -> list:
        """Return the event audit trail."""
        with self._lock:
            return list(self._event_log)


# ── Module-level singleton ────────────────────────────────────────────

market_state_service = MarketStateService()
