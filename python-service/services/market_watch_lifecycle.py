"""Market Watch daily lifecycle state machine.

docs/engines/MARKET_WATCH.md §5 and Phase 3:

    PRE_MARKET -> DISCOVERY -> FILTERING -> SUBSCRIBED -> MONITORING -> BLOCKING
    -> FINAL_MONITORING -> MARKET_WATCH_STOPPED -> REPORTING -> COMPLETED

Default operating schedule (all values are configuration, see
``services.market_watch_config``):

    08:50  Kotak session        (Session Manager owns this — Market Watch only
                                 observes the session snapshot)
    09:10  discovery starts
    09:10-09:12 eligibility / filtering
    09:12-09:14 subscription reconciliation
    09:14  frontend becomes data-active
    09:14-15:15 live monitoring (1m/5m/10m/30m + 30s rankings)
    15:15  Market Watch work/subscriptions expire (global broker WS untouched)
    15:20  EOD report generation
    15:25  report target ready

The state is a pure function of the IST wall clock, so a scheduler restart or a
backend restart resumes at the correct phase without replaying anything.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

from services.market_watch_config import LifecycleConfig, load as load_config

logger = logging.getLogger("app.market_watch_lifecycle")

from core.timezones import IST

# Phase constants (doc §5)
PRE_MARKET = "PRE_MARKET"
DISCOVERY = "DISCOVERY"
FILTERING = "FILTERING"
SUBSCRIBED = "SUBSCRIBED"
MONITORING = "MONITORING"
BLOCKING = "BLOCKING"
FINAL_MONITORING = "FINAL_MONITORING"
MARKET_WATCH_STOPPED = "MARKET_WATCH_STOPPED"
REPORTING = "REPORTING"
COMPLETED = "COMPLETED"

# Runtime window phases (outside the daily window)
RUNTIME_INACTIVE = "RUNTIME_INACTIVE"  # Before runtime_start or after runtime_stop

#: Ordered lifecycle. The engine uses the position to decide which duties run.
STATES: tuple[str, ...] = (
    PRE_MARKET,
    DISCOVERY,
    FILTERING,
    SUBSCRIBED,
    MONITORING,
    BLOCKING,
    FINAL_MONITORING,
    MARKET_WATCH_STOPPED,
    REPORTING,
    COMPLETED,
    RUNTIME_INACTIVE,
)

#: States in which Market Watch actively maintains live per-symbol state.
ACTIVE_STATES = frozenset({MONITORING, BLOCKING, FINAL_MONITORING})
#: States in which the eligible universe is being discovered/filtered.
DISCOVERY_STATES = frozenset({DISCOVERY, FILTERING})
#: States in which the frontend is considered data-active (doc §8, "09:14").
DATA_ACTIVE_STATES = frozenset({SUBSCRIBED, MONITORING, BLOCKING, FINAL_MONITORING})
#: States that accept new publish traffic.
PUBLISHING_STATES = frozenset({MONITORING, BLOCKING, FINAL_MONITORING})


def _parse_hhmm(value: str, fallback: tuple[int, int] = (0, 0)) -> tuple[int, int]:
    try:
        hour, _, minute = str(value).partition(":")
        return max(0, min(23, int(hour))), max(0, min(59, int(minute)))
    except (TypeError, ValueError):
        return fallback


def now_ist() -> datetime:
    return datetime.now(tz=IST)


def _minutes(hhmm: str) -> int:
    hour, minute = _parse_hhmm(hhmm)
    return hour * 60 + minute


def state_for(now: datetime, cfg: Optional[LifecycleConfig] = None) -> str:
    """Pure function: IST wall clock -> lifecycle state.
    
    The Market Watch Engine ONLY runs inside the configured runtime window
    (runtime_start to runtime_stop). Outside this window, the engine is
    RUNTIME_INACTIVE regardless of trading day status.
    """
    cfg = cfg or load_config().lifecycle
    minutes = now.hour * 60 + now.minute
    runtime_start = _minutes(cfg.runtime_start)
    runtime_stop = _minutes(cfg.runtime_stop)
    
    # HARD RUNTIME WINDOW: Engine is completely inactive outside this window
    if minutes < runtime_start or minutes >= runtime_stop:
        return RUNTIME_INACTIVE
    
    # Inside runtime window - evaluate internal lifecycle phases
    discovery = _minutes(cfg.discovery)
    filter_start = _minutes(cfg.filter_start)
    filter_end = _minutes(cfg.filter_window_end)
    subscription_end = _minutes(cfg.subscription_end)
    active_from = _minutes(cfg.active_from)
    final_monitoring = _minutes(cfg.final_monitoring)
    stop = _minutes(cfg.stop)
    report = _minutes(cfg.report)
    report_ready = _minutes(cfg.report_ready)

    if minutes < discovery:
        return PRE_MARKET
    if minutes < filter_start:
        # Universe build from the real instrument master.
        return DISCOVERY
    if minutes < filter_end:
        # doc §5: 09:10-09:12 eligibility / filter evaluation.
        return FILTERING
    if minutes < active_from:
        # doc §5: 09:12-09:14 subscription reconciliation; the frontend is not
        # Market-Watch data active until ``active_from``.
        return SUBSCRIBED
    if minutes < final_monitoring:
        # BLOCKING is the block-enforcement duty window inside live monitoring.
        # It starts once the first ranking pass of the day exists.
        return MONITORING
    if minutes < stop:
        # Last live window: existing state is monitored and reported, but the
        # universe is already frozen for the day.
        return FINAL_MONITORING
    if minutes < report:
        return MARKET_WATCH_STOPPED
    if minutes < report_ready:
        return REPORTING
    return COMPLETED


def blocking_state_for(now: datetime, has_ranking: bool, cfg: Optional[LifecycleConfig] = None) -> str:
    """Same as :func:`state_for` but promotes MONITORING -> BLOCKING once the
    first official ranking snapshot of the day exists (the block ledger only
    starts recording after a real ranking has been produced)."""
    base = state_for(now, cfg)
    if base == MONITORING and has_ranking:
        return BLOCKING
    return base

@dataclass
class LifecycleSnapshot:
    state: str
    previous: str
    changed_at: Optional[float]
    trading_date: str
    server_time: str
    schedule: dict[str, str]
    next_state: str
    minutes_to_next: int
    data_active: bool
    monitoring: bool
    runtime_active: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "previousState": self.previous,
            "changedAt": self.changed_at,
            "tradingDate": self.trading_date,
            "serverTime": self.server_time,
            "schedule": self.schedule,
            "nextState": self.next_state,
            "minutesToNext": self.minutes_to_next,
            "dataActive": self.data_active,
            "monitoring": self.monitoring,
            "runtimeActive": self.runtime_active,
            "states": list(STATES),
        }


class MarketWatchLifecycle:
    """Tracks the current phase and emits transitions (no timers of its own —
    the owning engine's status loop drives it)."""

    def __init__(self, on_transition: Optional[Callable[[str, str], None]] = None) -> None:
        self._lock = threading.RLock()
        self._state = PRE_MARKET
        self._previous = ""
        self._changed_at: Optional[float] = None
        self._date = ""
        self._on_transition = on_transition
        self._transitions: list[dict[str, Any]] = []

    def set_transition_hook(self, hook: Callable[[str, str], None]) -> None:
        self._on_transition = hook

    @property
    def state(self) -> str:
        with self._lock:
            return self._state

    def evaluate(self, now: Optional[datetime] = None, *, has_ranking: bool = False,
                 trading_date: str = "") -> str:
        """Advance the state machine; returns the current state."""
        now = now or now_ist()
        target = blocking_state_for(now, has_ranking)
        with self._lock:
            if trading_date and trading_date != self._date:
                self._date = trading_date
                self._previous = ""
                self._state = ""
            if target == self._state:
                return self._state
            self._previous = self._state
            self._state = target
            self._changed_at = time.time()
            self._transitions.append({
                "from": self._previous,
                "to": target,
                "at": self._changed_at,
                "serverTime": now.isoformat(),
            })
            del self._transitions[:-50]
        logger.info(
            "[MARKET_WATCH_LIFECYCLE] %s -> %s (ist=%s)", self._previous or "-", target, now.strftime("%H:%M"),
        )
        if self._on_transition is not None:
            try:
                self._on_transition(self._previous, target)
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning("[MARKET_WATCH_LIFECYCLE] transition hook failed: %s", exc)
        return target

    def snapshot(self, now: Optional[datetime] = None, trading_date: str = "") -> LifecycleSnapshot:
        now = now or now_ist()
        cfg = load_config().lifecycle
        with self._lock:
            state = self._state or state_for(now, cfg)
            previous = self._previous
            changed_at = self._changed_at
        schedule = {
            "runtimeStart": cfg.runtime_start,
            "runtimeStop": cfg.runtime_stop,
            "preMarket": cfg.pre_market,
            "discovery": cfg.discovery,
            "filterStart": cfg.filter_start,
            "filterWindowEnd": cfg.filter_window_end,
            "subscriptionEnd": cfg.subscription_end,
            "activeFrom": cfg.active_from,
            "finalMonitoring": cfg.final_monitoring,
            "stop": cfg.stop,
            "report": cfg.report,
            "reportReady": cfg.report_ready,
        }
        minutes = now.hour * 60 + now.minute
        ordered = [(name, _minutes(v)) for name, v in (
            (PRE_MARKET, cfg.pre_market),
            (DISCOVERY, cfg.discovery),
            (FILTERING, cfg.filter_start),
            (SUBSCRIBED, cfg.filter_window_end),
            (MONITORING, cfg.active_from),
            (FINAL_MONITORING, cfg.final_monitoring),
            (MARKET_WATCH_STOPPED, cfg.stop),
            (REPORTING, cfg.report),
            (COMPLETED, cfg.report_ready),
        )]
        upcoming = [(name, m) for name, m in ordered if m > minutes]
        next_state, next_minute = upcoming[0] if upcoming else (COMPLETED, _minutes(cfg.report_ready))
        runtime_start = _minutes(cfg.runtime_start)
        runtime_stop = _minutes(cfg.runtime_stop)
        runtime_active = runtime_start <= minutes < runtime_stop
        return LifecycleSnapshot(
            state=state,
            previous=previous,
            changed_at=changed_at,
            trading_date=trading_date or self._date,
            server_time=now.isoformat(),
            schedule=schedule,
            next_state=next_state,
            minutes_to_next=max(0, next_minute - minutes),
            data_active=state in DATA_ACTIVE_STATES,
            monitoring=state in ACTIVE_STATES,
            runtime_active=runtime_active,
        )

    def transitions(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(t) for t in self._transitions]

    def reset(self) -> None:
        with self._lock:
            self._state = ""
            self._previous = ""
            self._changed_at = None
            self._transitions.clear()


market_watch_lifecycle = MarketWatchLifecycle()

__all__ = [
    "ACTIVE_STATES",
    "BLOCKING",
    "COMPLETED",
    "DATA_ACTIVE_STATES",
    "DISCOVERY",
    "DISCOVERY_STATES",
    "FILTERING",
    "FINAL_MONITORING",
    "IST",
    "MARKET_WATCH_STOPPED",
    "MarketWatchLifecycle",
    "MONITORING",
    "PRE_MARKET",
    "PUBLISHING_STATES",
    "REPORTING",
    "RUNTIME_INACTIVE",
    "STATES",
    "SUBSCRIBED",
    "market_watch_lifecycle",
    "now_ist",
    "state_for",
]
