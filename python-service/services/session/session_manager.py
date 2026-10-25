"""Central broker session manager.

THIS is the single source of truth for broker login / session lifecycle in
KAUSTUBH. Every phase (Trading Terminal, Data Saver, Services, Scheduler,
Khumbha AI) must read its session state from here — never maintain its own
duplicate copy.

Design:
  - One session per active broker mode (Kotak / Shoonya / Dummy). Only the
    selected adapter is active at any time.
  - Session lifetime after a successful manual login is the configured
    lifetime (default 60 minutes), computed from the *actual* login time
    (``expires_at = login_at + lifetime``) and the live ``remaining_seconds``
    is derived from the wall clock — never faked.
  - All state is derived from the underlying engines (``kotak_session`` and
    ``ws_manager``) and unified here so the rest of the app reads ONE shape.
  - Logout reasons use a fixed honest vocabulary; when the real reason is
    unavailable we report "Reason unavailable" rather than invent one.
  - Structured AUTH_* events are logged for every auth decision without ever
    logging tokens / passwords / TOTP / full auth headers (safe identifiers
    and booleans only).

The manager is deliberately dependency-light: it stores only safe/derived
state. Raw credentials never enter this module.
"""
from __future__ import annotations

import logging
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from services.session.session_manager_config import (
    expiry_warning_seconds as _cfg_expiry_warning_seconds,
    session_lifetime_seconds as _cfg_session_lifetime_seconds,
    tick_active_window_seconds as _cfg_tick_active_window_seconds,
)

from core.timezones import IST

# ---------------------------------------------------------------------------
# Lifecycle states (authoritative vocabulary used by ALL phases / UI).
# ---------------------------------------------------------------------------
DISCONNECTED = "DISCONNECTED"
LOGGING_IN = "LOGGING_IN"
SESSION_ACTIVE = "SESSION_ACTIVE"
WS_CONNECTING = "WS_CONNECTING"
WS_ACTIVE = "WS_ACTIVE"
SESSION_EXPIRING = "SESSION_EXPIRING"
SESSION_EXPIRED = "SESSION_EXPIRED"
LOGGING_OUT = "LOGGING_OUT"
ERROR = "ERROR"

SESSION_STATES = (
    DISCONNECTED,
    LOGGING_IN,
    SESSION_ACTIVE,
    WS_CONNECTING,
    WS_ACTIVE,
    SESSION_EXPIRING,
    SESSION_EXPIRED,
    LOGGING_OUT,
    ERROR,
)

# ---------------------------------------------------------------------------
# Spec §7 session lifecycle vocabulary. ADDITIVE: the legacy ``state`` field is
# unchanged (existing consumers/tests depend on it); the canonical
# ``lifecycleState`` field carries this spec vocabulary.
# ---------------------------------------------------------------------------
SLC_NO_SESSION = "NO_SESSION"
SLC_LOGIN_REQUIRED = "LOGIN_REQUIRED"
SLC_LOGIN_IN_PROGRESS = "LOGIN_IN_PROGRESS"
SLC_SESSION_CREATED = "SESSION_CREATED"
SLC_SESSION_VALIDATING = "SESSION_VALIDATING"
SLC_SESSION_READY = "SESSION_READY"
SLC_SESSION_ACTIVE = "SESSION_ACTIVE"
SLC_SESSION_EXPIRING = "SESSION_EXPIRING"
SLC_SESSION_REFRESH = "SESSION_REFRESH"
SLC_SESSION_EXPIRED = "SESSION_EXPIRED"
SLC_RELOGIN_REQUIRED = "RELOGIN_REQUIRED"
SLC_LOGOUT_REQUESTED = "LOGOUT_REQUESTED"
SLC_LOGGING_OUT = "LOGGING_OUT"
SLC_LOGIN_FAILED = "LOGIN_FAILED"
SLC_SESSION_VALIDATION_FAILED = "SESSION_VALIDATION_FAILED"
SLC_SESSION_REFRESH_FAILED = "SESSION_REFRESH_FAILED"
SLC_LOGOUT_FAILED = "LOGOUT_FAILED"
SLC_SESSION_ERROR = "SESSION_ERROR"

SESSION_LIFECYCLE_STATES = (
    SLC_NO_SESSION,
    SLC_LOGIN_REQUIRED,
    SLC_LOGIN_IN_PROGRESS,
    SLC_SESSION_CREATED,
    SLC_SESSION_VALIDATING,
    SLC_SESSION_READY,
    SLC_SESSION_ACTIVE,
    SLC_SESSION_EXPIRING,
    SLC_SESSION_REFRESH,
    SLC_SESSION_EXPIRED,
    SLC_RELOGIN_REQUIRED,
    SLC_LOGOUT_REQUESTED,
    SLC_LOGGING_OUT,
    SLC_LOGIN_FAILED,
    SLC_SESSION_VALIDATION_FAILED,
    SLC_SESSION_REFRESH_FAILED,
    SLC_LOGOUT_FAILED,
    SLC_SESSION_ERROR,
)

SESSION_LIFECYCLE_MAP = {
    DISCONNECTED: SLC_NO_SESSION,
    LOGGING_IN: SLC_LOGIN_IN_PROGRESS,
    SESSION_ACTIVE: SLC_SESSION_ACTIVE,
    WS_CONNECTING: SLC_SESSION_VALIDATING,
    WS_ACTIVE: SLC_SESSION_READY,
    SESSION_EXPIRING: SLC_SESSION_EXPIRING,
    SESSION_EXPIRED: SLC_SESSION_EXPIRED,
    LOGGING_OUT: SLC_LOGGING_OUT,
    ERROR: SLC_SESSION_ERROR,
}


def session_lifecycle_state(state: Optional[str]) -> str:
    """Map a legacy session state onto the spec §7 lifecycle vocabulary."""
    return SESSION_LIFECYCLE_MAP.get(state or "", SLC_NO_SESSION)

# Honest logout-reason vocabulary. Never invent one outside this set.
LOGOUT_REASONS = (
    "manual_logout",
    "scheduled_logout",
    "session_expired",
    "broker_session_expired",
    "broker_rejected",
    "market_closed",
    "manual_timeout",
    "ws_auth_failure",
    "network_failure",
    "websocket_failure",
    "authentication_failure",
    "mode_switch",
    "server_shutdown",
    "application_shutdown",
    "unknown",
)

# Official audience settings for the 60-minute manual-session lifetime.
MANUAL_SESSION_SECONDS = 60 * 60  # 3600 s = 60 minutes

# ---------------------------------------------------------------------------
# Subscription / routing states (authoritative "what is subscribed" vocabulary).
# The Session Manager owns the DESIRED set (db.stocks active + pins) merged
# with the ACTUAL broker acknowledgement (engine/ws_manager acks). PIN state
# is independent of subscription state — PINNED ≠ subscribed.
# ---------------------------------------------------------------------------
SUBSCRIBED = "SUBSCRIBED"
PINNED = "PINNED"
SUBSCRIBED_PINNED = "SUBSCRIBED+PINNED"
NOT_SUBSCRIBED = "NOT SUBSCRIBED"
EXPIRED = "EXPIRED"
INACTIVE = "INACTIVE"

SUBSCRIPTION_STATES = (
    SUBSCRIBED,
    PINNED,
    SUBSCRIBED_PINNED,
    NOT_SUBSCRIBED,
    EXPIRED,
    INACTIVE,
)

# Desired-but-not-actually-subscribable states (the engine must NEVER send
# these to the broker).
SUB_BLOCKED_STATES = (EXPIRED, INACTIVE)

# ---------------------------------------------------------------------------
# Phase 3 canonical lifecycle vocabulary (§3 master spec requirement).
# These are ADDITIVE: the legacy ``state``/``subscription_state`` fields keep
# their historical values (SUBSCRIBED, PINNED, SUBSCRIBED+PINNED, ...) so
# existing consumers/tests keep working. The new ``status`` field carries the
# richer Phase 3 vocabulary. Legacy -> Phase 3 aliasing:
#   SUBSCRIBED          -> SUBSCRIBED / ACTIVE (when a validated tick is fresh)
#   PINNED              -> PINNED_ONLY
#   SUBSCRIBED+PINNED   -> SUBSCRIBED_AND_PINNED
#   NOT SUBSCRIBED      -> NOT_SUBSCRIBED (desired, no ack yet)
# ---------------------------------------------------------------------------
SM_NOT_SUBSCRIBED = "NOT_SUBSCRIBED"
SM_SUBSCRIBE_REQUESTED = "SUBSCRIBE_REQUESTED"
SM_SUBSCRIBED = "SUBSCRIBED"
SM_SUBSCRIBED_AND_PINNED = "SUBSCRIBED_AND_PINNED"
SM_PINNED_ONLY = "PINNED_ONLY"
SM_ACTIVE = "ACTIVE"
SM_INACTIVE = "INACTIVE"
SM_EXPIRED = "EXPIRED"
SM_EXPIRING = "EXPIRING"
SM_UNSUBSCRIBE_REQUESTED = "UNSUBSCRIBE_REQUESTED"
SM_UNSUBSCRIBED = "UNSUBSCRIBED"
SM_ERROR = "ERROR"

LIFECYCLE_STATES = (
    SM_NOT_SUBSCRIBED,
    SM_SUBSCRIBE_REQUESTED,
    SM_SUBSCRIBED,
    SM_SUBSCRIBED_AND_PINNED,
    SM_PINNED_ONLY,
    SM_ACTIVE,
    SM_INACTIVE,
    SM_EXPIRED,
    SM_EXPIRING,
    SM_UNSUBSCRIBE_REQUESTED,
    SM_UNSUBSCRIBED,
    SM_ERROR,
)

# Market-data tiers and their numeric feed levels (Kotak SDK). L4 = live 1+1,
# L8 = live 5+5 (platform default), L16 = ACK-only/static on the tested account
# (never reported as live full depth).
MARKET_DATA_TIERS = ("L4", "L8", "L16")
DEFAULT_FEED_LEVEL = 8
TIER_TO_FEED_LEVEL = {"L4": 4, "L8": 8, "L16": 16}
FEED_LEVEL_TO_TIER = {4: "L4", 8: "L8", 16: "L16"}
SUPPORTED_FEED_LEVELS = (4, 8, 16)

# Expiry type vocabulary (real backstops, never fabricated).
EXPIRY_PERMANENT = "PERMANENT"
EXPIRY_SESSION = "SESSION"
EXPIRY_TRADE = "TRADE"
EXPIRY_DURATION = "DURATION"
EXPIRY_ONE_SHOT = "ONE_SHOT"
EXPIRY_TYPES = (EXPIRY_PERMANENT, EXPIRY_SESSION, EXPIRY_TRADE, EXPIRY_DURATION, EXPIRY_ONE_SHOT)

# --- Phase 3 tuning -----------------------------------------------------
# An instrument with ``expires_at`` within this horizon is EXPIRING.
EXPIRY_WARNING_SECONDS = 15 * 60
# A subscribed instrument with a validated tick within this window is ACTIVE.
TICK_ACTIVE_WINDOW_SECONDS = 60.0
# Default WS connection identity for this platform.
DEFAULT_CONNECTION = "KOTAK-WS-01"

# Source tag of the Market Watch daily eligible-universe subscription intent.
# The Session Manager records this as the canonical current-day desired set;
# the WebSocket Engine merges these rows into the registry like any other
# first-class consumer so broker subscribe/unsubscribe stays authoritative.
SOURCE_DAILY_UNIVERSE = "market_watch_daily_universe"

VERSION = "1.0.0"
_log = logging.getLogger("session")


def _iso(ts: Optional[float]) -> Optional[str]:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, tz=IST).isoformat()


def _now_iso() -> str:
    return datetime.now(IST).isoformat()


def normalize_logout_reason(reason: Optional[str]) -> str:
    """Return an honest reason, or 'Reason unavailable' when unknown."""
    if not reason:
        return "Reason unavailable"
    r = str(reason).strip()
    if r in LOGOUT_REASONS:
        return r
    if r in {"unknown", "Unknown", "none"}:
        return "Reason unavailable"
    # Never guess: if it isn't in our known vocabulary, report it verbatim
    # (it came from a real observed cause) rather than substituting.
    return r


class _LogoutRecord:
    __slots__ = (
        "login_time",
        "logout_time",
        "session_duration",
        "logout_reason",
        "mode",
        "broker",
    )

    def __init__(
        self,
        login_time: Optional[float],
        logout_time: float,
        session_duration: Optional[float],
        logout_reason: str,
        mode: Optional[str],
        broker: Optional[str],
    ) -> None:
        self.login_time = login_time
        self.logout_time = logout_time
        self.session_duration = session_duration
        self.logout_reason = logout_reason
        self.mode = mode
        self.broker = broker

    def to_dict(self) -> dict[str, Any]:
        return {
            "loginTime": _iso(self.login_time),
            "logoutTime": _iso(self.logout_time),
            "sessionDuration": round(self.session_duration, 2) if self.session_duration is not None else None,
            "logoutReason": self.logout_reason,
            "mode": self.mode,
            "broker": self.broker,
        }


class CentralSessionManager:
    """Authoritative, thread-safe holder of the broker session lifecycle."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._state = DISCONNECTED
        self._state_since: Optional[float] = None
        self._state_message: str = ""

        # ---- mode / identity ----
        self._mode: Optional[str] = None          # "kotak" | "shoonya" | "dummy"
        self._broker: Optional[str] = None         # display name, e.g. "Kotak Neo"
        self._user_id: Optional[str] = None        # safe account identifier
        self._session_id: Optional[str] = None     # generated UUID-style id
        self._session_id_ref: Optional[str] = None  # opaque short ref only

        # ---- lifetime ----
        self._login_at: Optional[float] = None
        self._expires_at: Optional[float] = None
        self._validated_at: Optional[float] = None
        # Lifetime the ACTIVE session actually used at login (None for
        # scheduler-owned sessions without a wall-clock countdown; falls back
        # to the configured lifetime for new manual sessions).
        self._session_lifetime: Optional[float] = None
        # Honest session owner — "MANUAL" | "SCHEDULER". Never fabricated:
        # derived from the actual login path (scheduler -> automatic login).
        self._login_source: Optional[str] = None

        # ---- timestamps ----
        self._last_activity_at: Optional[float] = None
        self._last_ws_event_at: Optional[float] = None
        self._last_rest_success_at: Optional[float] = None
        self._last_rest_failure_at: Optional[float] = None
        self._last_auth_error_at: Optional[float] = None
        self._last_rest_error: Optional[str] = None
        self._last_auth_error: Optional[str] = None
        self._ws_connected_at: Optional[float] = None
        self._ws_disconnected_at: Optional[float] = None
        self._ws_last_message_at: Optional[float] = None
        self._reconnect_count = 0
        self._ws_state: str = "DISCONNECTED"
        self._ws_disconnect_reason: Optional[str] = None

        # ---- history ----
        self._session_history: list[_LogoutRecord] = []

        # ---- per-terminal session records (§4 terminal isolation) ----
        # One independent record per terminal ("dummy" / "kotak" / "shoonya").
        # Switching terminals ONLY changes the ACTIVE CONTEXT — it never calls
        # logout/destroy/invalidate on the previously selected terminal. Each
        # record survives until the TERMINAL's own logout or expiry.
        self._sessions: dict[str, dict[str, Any]] = {}

        # ---- subscription / routing state ("what is subscribed") ----
        # Unique per-instrument records keyed by (exchange_segment, token).
        # The Session Manager is the SINGLE source of truth for what SHOULD be
        # subscribed (desired), what the BROKER ACTUALLY acknowledged (acks),
        # pin state, real expiry, routing (which WS owner serves it) and the
        # field requirements of the consuming profiles. The WebSocket Engine
        # consumes this state and drives the broker delta; it never decides
        # what should be subscribed on its own.
        self._subs: dict[tuple[str, str], dict[str, Any]] = {}
        self._subs_pins: dict[tuple[str, str], dict[str, Any]] = {}
        # Global routing context of the market-data feed (single WS owner).
        self._subs_routing: str = "DISCONNECTED"
        self._subs_routing_owner: str = "ws_manager"
        self._subs_revision: int = 0
        self._subs_last_updated: Optional[float] = None
        self._subs_last_refresh: float = 0.0
        # Current-day Market Watch daily-universe intent summary. The
        # authoritative records live in ``_subs``; this is the last applied
        # intent's metadata. Empty until the first apply, so the read endpoint
        # is valid before the first Friday/daily intent of the process.
        self._daily_intent: dict[str, Any] = {}
        # Memoised token -> record snapshot for :meth:`active_registry`. It is
        # rebuilt ONLY when ``_subs_revision`` changes, so hot-path consumers
        # (the DB Writer consults the registry once per tick batch) never pay
        # the full ~2.7k-record rebuild repeatedly while nothing has changed.
        self._active_registry_cache: Optional[dict[str, dict[str, Any]]] = None
        self._active_registry_cache_rev: int = -1
        # Same pattern for :meth:`subscription_snapshot` (the status/telemetry
        # projection). It is polled every ~2s by several independent loops
        # (engine registry status, connection-engine broadcasts, REST health
        # probes) and each rebuild walks the whole registry building ISO
        # timestamps under the registry lock. At ~2.7k rows that rebuild alone
        # was the #1 self-frame (~1/3 of process CPU, profiled) and starved the
        # HTTP loop (dashboard REST timeouts). Cached on revision + a short
        # TTL: a registry mutation invalidates immediately, and while nothing
        # mutates the snapshot is rebuilt at most once per TTL — every consumer
        # already treats the payload as a polling-time status view.
        self._SUBS_SNAPSHOT_TTL_S = 1.0
        self._subs_snapshot_cache: Optional[dict[str, Any]] = None
        self._subs_snapshot_cache_rev: int = -1
        self._subs_snapshot_at: float = 0.0

        # ---- Phase 3 canonical store support ----
        # Per-connection runtime records + the highest revision each connection
        # has APPLIED (so the Control Center sees intent/apply drift honestly).
        self._subs_connections: dict[str, dict[str, Any]] = {}
        self._subs_applied_revisions: dict[str, int] = {}

        # ---- margin / intraday eligibility (published, not computed here) ----
        # token -> {"eligible": bool, "reason": str, "multiplier": float|None,
        #           "status": str, "basis": str, "resolvedAt": float}
        #
        # Market Watch CONSUMES this; it never derives broker margin itself. The
        # producer is services/market_watch_margin.py, which resolves it from
        # the broker's own margin API. Kept here (rather than in a module
        # global) so the session snapshot is the single place a consumer can
        # read an authoritative decision, alongside everything else it reads.
        # A token that is absent is UNKNOWN, never "eligible".
        self._margin_decisions: dict[str, dict[str, Any]] = {}

        # ---- live time-series events (append-only ring) ----
        from collections import deque
        self._event_log: deque[dict] = deque(maxlen=100)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    @property
    def subs_revision(self) -> int:
        """Monotonic counter of every subscription-registry mutation.

        Read-only and O(1) on purpose. Hot-path consumers that must not rebuild
        the whole snapshot per event (notably the DB Write Engine, which consults
        the registry once per tick to classify it) cache the snapshot and key
        that cache on this counter, so a subscribe/unsubscribe/expiry is
        observed immediately instead of after a TTL.

        The Session Manager stays the single authority: this publishes *when*
        its state changed, never what it contains.
        """
        return self._subs_revision

    def _stamp(self, event: str, message: str = "", meta: Optional[dict] = None) -> None:
        from services.event_history import record_event as re
        try:
            re("session", event, "info", message, dict(meta or {}))
        except Exception:
            _log.debug("event history unavailable")
        with self._lock:
            self._event_log.append(
                {
                    "at": _now_iso(),
                    "event": event,
                    "message": message,
                    "meta": dict(meta or {}),
                }
            )

    def _auth_log(self, event: str, detail: str = "", meta: Optional[dict] = None) -> None:
        # Safe-only logging: booleans / identifiers, never secrets.
        safe = {"mode": self._mode, "broker": self._broker, "user_id": self._user_id}
        if meta:
            safe.update(meta)
        _log.info("AUTH_%s %s", event, detail, extra={"category": "auth", "meta": safe})

    # ------------------------------------------------------------------
    # Phase 3 helpers (safe async scheduling + engine event publishing)
    # ------------------------------------------------------------------
    def _run_coro_safe(self, coro_builder) -> None:
        """Schedule a coroutine on the app loop (best-effort, never raises).

        Safe to call from ANY thread (sync tick threads, API handlers).
        """
        try:
            import asyncio
            from core.event_loop import get_loop

            def _go():
                async def _p():
                    try:
                        await coro_builder()
                    except Exception:
                        _log.debug("session manager background task failed", exc_info=True)
                try:
                    loop = get_loop()
                    if loop is not None and loop.is_running():
                        loop.call_soon_threadsafe(lambda: asyncio.ensure_future(_p()))
                    else:
                        _p()
                except RuntimeError:
                    _p()

            loop = get_loop()
            if loop is not None and loop.is_running():
                loop.call_soon_threadsafe(_go)
            else:
                _go()
        except Exception:  # noqa: BLE001
            _log.debug("session manager coroutine schedule failed", exc_info=True)

    def _publish_engine_event(self, event_type: str, data: dict) -> None:
        """Publish an Engine Event Bus event for the Phase 3 control plane.

        ``SUBSCRIPTION_UPDATED`` is the canonical change signal consumers (the
        WS engine controller, realtime UI) subscribe to. Returns immediately;
        publishing happens on the app loop.
        """

        def _go():
            async def _p():
                try:
                    from services.engine_event_bus import get_event_bus, EngineEvent
                    await get_event_bus().publish(EngineEvent(
                        event_type=event_type,
                        source_engine="session_manager",
                        data=data,
                    ))
                except Exception:  # noqa: BLE001
                    _log.debug("engine event publish failed (%s)", event_type, exc_info=True)
            try:
                import asyncio
                asyncio.ensure_future(_p())
            except RuntimeError:
                loop = None
                try:
                    from core.event_loop import get_loop
                    loop = get_loop()
                except Exception:  # noqa: BLE001
                    loop = None
                if loop is not None:
                    loop.call_soon_threadsafe(lambda: asyncio.ensure_future(_p()))

        try:
            from core.event_loop import get_loop
            loop = get_loop()
        except Exception:  # noqa: BLE001
            loop = None
        if loop is not None and loop.is_running():
            loop.call_soon_threadsafe(_go)
        else:
            # No running app loop (unit tests / offline tooling): best-effort
            # no-op so we never create an un-awaited coroutine.
            _log.debug("engine event publish skipped (no running loop): %s", event_type)

    def _publish_domain_event(self, event_type: str, rec: Optional[dict] = None,
                              **extra: Any) -> None:
        """Publish a spec §25 Session Manager domain event.

        Additive to ``SUBSCRIPTION_UPDATED``: carries the per-instrument
        identity the WebSocket Engine needs to consume lifecycle changes.
        """
        data: dict[str, Any] = {"engine": "session_manager"}
        if isinstance(rec, dict):
            seg = rec.get("exchange_segment") or ""
            tok = rec.get("instrument_token") or ""
            if seg or tok:
                data["instrument_key"] = f"{seg}|{tok}"
            data["exchange_segment"] = seg
            data["instrument_token"] = tok
            symbol = rec.get("symbol") or rec.get("trading_symbol") or ""
            if symbol:
                data["symbol"] = symbol
            if rec.get("expires_at"):
                data["expires_at"] = _iso(rec.get("expires_at"))
            data["expiry_type"] = rec.get("expiry_type")
        data.update(extra)
        self._publish_engine_event(event_type, data)

    def _persist_flags(self) -> bool:
        """Whether canonical instrumentation should be mirrored to Mongo."""
        try:
            import os
            raw = os.environ.get("SESSION_MANAGER_PERSIST")
            if raw is not None:
                return str(raw).strip().lower() in ("1", "true", "yes", "on")
        except Exception:  # noqa: BLE001
            pass
        try:
            from database.connection import is_mongo_connected
            return is_mongo_connected()
        except Exception:  # noqa: BLE001
            return False

    async def _persist_record(self, key: tuple[str, str], event: Optional[str] = None,
                              meta: Optional[dict] = None) -> None:
        """Best-effort mirror of one runtime record into the canonical store."""
        if not self._persist_flags():
            return
        try:
            from services.session import instrument_store
            rec = self._subs.get(key)
            if rec is None:
                return
            raw = dict(rec)
            broker = str(raw.get("broker") or self._mode or "kotak").lower()
            seg = str(raw.get("exchange_segment") or key[0])
            tok = str(raw.get("instrument_token") or key[1])
            iid = instrument_store.instrument_id(broker, seg, tok)
            status = self.canonical_status(raw)
            doc = {
                "instrument_id": iid,
                "broker": broker,
                "exchange_segment": seg,
                "instrument_token": tok,
                "instrument_key": f"{seg}|{tok}",
                "symbol": raw.get("symbol") or raw.get("trading_symbol") or "",
                "trading_symbol": raw.get("trading_symbol") or raw.get("symbol") or "",
                "is_index": bool(raw.get("is_index", False)),
                "is_depth": bool(raw.get("is_depth", False)),
                "source": (raw.get("source") or "manual"),
                "sources": list(raw.get("sources") or []) or ([(raw.get("source") or "manual")] if raw.get("source") else []),
                "desired": bool(raw.get("desired", False)),
                "active": bool(raw.get("active", True)),
                "advertised": bool(raw.get("advertised", False)),
                "pinned": dict(raw["pin"]) if isinstance(raw.get("pin"), dict) else bool(raw.get("pin")),
                "status": status,
                "subscription_state": raw.get("state") or status,
                "expires_at": raw.get("expires_at"),
                "expiry_type": raw.get("expiry_type"),
                "expiry_label": raw.get("expiry_label"),
                "feed_level": raw.get("feed_level"),
                "market_data": FEED_LEVEL_TO_TIER.get(raw.get("feed_level")) if raw.get("feed_level") else raw.get("market_data"),
                "required_fields": list(raw.get("required_fields") or []),
                "routing": {"state": raw.get("routing") or self._subs_routing,
                            "owner": raw.get("routing_owner") or self._subs_routing_owner},
                "routing_targets": list(raw.get("routing_targets") or []),
                "connection_targets": list(raw.get("connection_targets") or []),
                # Timestamps are persisted as epoch FLOATS (runtime-facing);
                # the API/UI keeps ISO-8601 strings. Never mix types.
                "last_update_at": raw.get("last_update_at"),
                "created_at": raw.get("created_at"),
                "updated_at": time.time(),
                "last_tick_at": raw.get("last_tick_at"),
                "revision": self._subs_revision,
            }
            await instrument_store.save_instrument(doc)
            if event:
                await instrument_store.record_event({
                    "event": event,
                    "event_type": event,
                    "instrument_id": iid,
                    "broker": broker,
                    "exchange_segment": seg,
                    "instrument_token": tok,
                    "symbol": doc["symbol"],
                    "source": doc["source"],
                    "revision": self._subs_revision,
                    "message": meta.get("message", "") if meta else "",
                    "state": status,
                    "meta": dict(meta or {}),
                })
        except Exception:  # noqa: BLE001
            _log.debug("session manager persistence mirror failed (%s)", key, exc_info=True)

    async def _persist_many(self, records: list[dict]) -> None:
        for rec in records or []:
            key = self._row_key(rec)
            if key[1]:
                await self._persist_record(key)

    @staticmethod
    def canonical_status(rec: dict[str, Any], now: Optional[float] = None) -> str:
        """Derive the Phase 3 canonical lifecycle status from a record.

        Honest derivation only: EXPIRED requires a real past ``expires_at``,
        ACTIVE requires a fresh validated tick, ERROR requires an explicit
        error, request states require explicit request flags. Nothing is
        guessed or fabricated.
        """
        now = now or time.time()
        expires_at = rec.get("expires_at")
        past = expires_at is not None and now >= float(expires_at)
        expiring = (
            expires_at is not None
            and not past
            and (float(expires_at) - now) <= _cfg_expiry_warning_seconds()
        )
        active_flag = bool(rec.get("active", True))
        desired = bool(rec.get("desired", False))
        pinned = bool(rec.get("pin"))
        subscribed = bool(rec.get("subscribed", False))
        last_tick = rec.get("last_tick_at")
        fresh_tick = (
            subscribed
            and last_tick is not None
            and (now - float(last_tick)) <= _cfg_tick_active_window_seconds()
        )

        if past:
            return SM_EXPIRED
        if expiring:
            return SM_EXPIRING
        if rec.get("error"):
            return SM_ERROR
        if not active_flag and not pinned and not desired:
            return SM_INACTIVE
        if rec.get("unsub_requested") and subscribed:
            return SM_UNSUBSCRIBE_REQUESTED
        if rec.get("sub_requested") and not subscribed:
            return SM_SUBSCRIBE_REQUESTED
        if not desired and not pinned and not subscribed:
            return SM_UNSUBSCRIBED
        if subscribed:
            if pinned:
                return SM_ACTIVE if fresh_tick else SM_SUBSCRIBED_AND_PINNED
            return SM_ACTIVE if fresh_tick else SM_SUBSCRIBED
        if pinned:
            return SM_PINNED_ONLY
        return SM_NOT_SUBSCRIBED

    def _set_state(self, state: str, message: str = "") -> None:
        changed = False
        with self._lock:
            if state != self._state:
                changed = True
                self._state = state
                self._state_since = time.time()
            if message:
                self._state_message = message
        if changed:
            self._stamp(f"state:{state}", message)
            _log.info("SESSION_STATE %s %s", state, message)
            self._publish_state_change(state, message)

    def _session_entity(self, state: str, message: str = "") -> dict[str, Any]:
        """Canonical session entity published to the centralized state store.

        Carries the CURRENT mode so the frontend reconciler never observes a
        stale terminal after a pure context switch (set_mode) — even when the
        session state string itself never changes (e.g. DISCONNECTED→DISCONNECTED).
        """
        active = state in {SESSION_ACTIVE, WS_ACTIVE, WS_CONNECTING, SESSION_EXPIRING}
        # Every entity carries the CANONICAL session snapshot fields (mode,
        # expiresAt / remainingSeconds / loginTime ...) so the frontend renders
        # the real countdown from the ONE backend-driven session record — it
        # never fabricates an expiry.
        snap = self.snapshot()
        return {
            "status": state,
            "lifecycleState": session_lifecycle_state(state),
            "active": active,
            "stateMessage": message,
            "expiresAt": snap.get("expiresAt"),
            "remainingSeconds": snap.get("remainingSeconds"),
            "loginTime": snap.get("loginTime"),
            "validatedAt": snap.get("validatedAt"),
            "stateSince": snap.get("stateSince"),
            "userId": snap.get("userId"),
            "mode": snap.get("mode"),
            "sessionId": snap.get("sessionId"),
            "loginSource": snap.get("loginSource"),
        }

    def _publish_session_entity(self, state: str, message: str = "") -> None:
        """Publish the canonical session entity to the centralized state store."""
        try:
            import asyncio
            from core.event_loop import get_loop
            from services.state_store import set_entity_state

            entity = self._session_entity(state, message)

            def _do():
                async def _p():
                    try:
                        await set_entity_state(
                            "session",
                            entity,
                            message or "session_state_change",
                        )
                    except Exception:
                        pass
                try:
                    loop = get_loop()
                    if loop is not None and loop.is_running():
                        loop.call_soon_threadsafe(lambda: asyncio.ensure_future(_p()))
                    else:
                        _do()
                except RuntimeError:
                    _do()

            try:
                loop = get_loop()
                if loop is not None and loop.is_running():
                    loop.call_soon_threadsafe(_do)
                else:
                    _do()
            except Exception:
                _do()
        except Exception:
            pass

    def _publish_state_change(self, state: str, message: str = "") -> None:
        """Publish session state transition to the centralized state store."""
        try:
            import asyncio
            from core.event_loop import get_loop
            from services.state_store import set_entity_state, set_service_state

            def _do():
                async def _p():
                    try:
                        await set_entity_state(
                            "session",
                            self._session_entity(state, message),
                            message or "session_state_change",
                        )
                    except Exception:
                        pass
                    status_map = {
                        SESSION_ACTIVE: "RUNNING",
                        WS_ACTIVE: "RUNNING",
                        WS_CONNECTING: "STARTED",
                        SESSION_EXPIRING: "DEGRADED",
                        SESSION_EXPIRED: "STOPPED",
                        LOGGING_IN: "STARTED",
                        LOGGING_OUT: "RECOVERING",
                        DISCONNECTED: "STOPPED",
                        ERROR: "FAILED",
                    }
                    try:
                        await set_service_state(
                            "kotak_session",
                            status_map.get(state, "UNKNOWN"),
                            message or "",
                        )
                    except Exception:
                        pass
                try:
                    loop = get_loop()
                    if loop is not None and loop.is_running():
                        loop.call_soon_threadsafe(lambda: asyncio.ensure_future(_p()))
                    else:
                        _do()
                except RuntimeError:
                    _do()

            try:
                loop = get_loop()
                if loop is not None and loop.is_running():
                    loop.call_soon_threadsafe(_do)
                else:
                    _do()
            except Exception:
                _do()
        except Exception:
            pass

    def _notify_critical(self, category: str, severity: str, title: str,
                         message: str, meta: Optional[dict] = None) -> None:
        """Best-effort Notification Engine integration (spec §35).

        Critical session events (expiry, login failure, connection loss,
        reconcile failure) are surfaced through the SINGLE notification
        system — ``services.notification_service.notify`` — which chains
        every notification to a real event-ledger row and gates on settings.
        Scheduled on the app loop exactly like engine-event publishing and
        never raises; a missing/stopped loop is a silent no-op (tests/offline).
        """
        def _go():
            async def _p():
                try:
                    from services.notification_service import notify
                    await notify(
                        category, severity, title, message,
                        source="session_manager", event_type=title,
                        metadata=meta,
                    )
                except Exception:  # noqa: BLE001 - notifications are non-fatal
                    _log.debug("session notification failed (%s)", title, exc_info=True)
            try:
                import asyncio
                asyncio.ensure_future(_p())
            except RuntimeError:
                loop = None
                try:
                    from core.event_loop import get_loop
                    loop = get_loop()
                except Exception:  # noqa: BLE001
                    loop = None
                if loop is not None:
                    loop.call_soon_threadsafe(lambda: asyncio.ensure_future(_p()))

        try:
            from core.event_loop import get_loop
            loop = get_loop()
        except Exception:  # noqa: BLE001
            loop = None
        if loop is not None and loop.is_running():
            loop.call_soon_threadsafe(_go)
        else:
            _log.debug("session notification skipped (no running loop): %s", title)

    # ------------------------------------------------------------------
    # Per-terminal session records (§4 terminal isolation)
    # ------------------------------------------------------------------
    # Every terminal owns an INDEPENDENT session record. Switching the active
    # terminal never logs out / invalidates the previously selected terminal's
    # record; only an explicit logout or a real broker expiry transitions that
    # terminal's record. When the UI switches back, the record is restored into
    # the "active view" so a Kotak→Dummy→Kotak cycle restores the Kotak session.
    # ------------------------------------------------------------------
    def _record(self, terminal: str, broker: Optional[str] = None) -> dict[str, Any]:
        with self._lock:
            rec = self._sessions.get(terminal)
            if rec is None:
                rec = {
                    "terminal_id": terminal,
                    "broker_id": broker,
                    "session_id": None,
                    "session_ref": None,
                    "session_status": DISCONNECTED,
                    "login_status": "logged_out",
                    "user_id": None,
                    "created_at": None,
                    "expires_at": None,
                    "last_activity": None,
                    "validated_at": None,
                    "connection_status": self._ws_state,
                    "login_source": None,
                    "state_message": "",
                }
                self._sessions[terminal] = rec
            elif broker:
                rec["broker_id"] = broker
            return rec

    def _sync_record_from_view(self, terminal: Optional[str] = None) -> dict[str, Any]:
        """Persist the current view into the record for ``terminal`` (or the
        active terminal) at login time so switching away later can restore it."""
        with self._lock:
            target = terminal or self._mode or "unknown"
            rec = self._record(target, self._broker)
            rec.update({
                "broker_id": self._broker or rec["broker_id"],
                "session_id": self._session_id,
                "session_ref": self._session_id_ref,
                "user_id": self._user_id,
                "created_at": self._login_at,
                "expires_at": self._expires_at,
                "validated_at": self._validated_at,
                "login_source": self._login_source,
                "connection_status": self._ws_state,
                "state_message": self._state_message or "",
            })
            if self._state:
                rec["session_status"] = self._state
            if self._expires_at is not None:
                rec["login_status"] = "logged_in"
            return rec

    def _restore_record_to_view(self, terminal: str) -> bool:
        """Restore the active-session view from a terminal's persisted record.

        Called on set_mode so switching back to a previously logged-in terminal
        shows its real (still-valid) session instead of a blank DISCONNECTED.
        Returns True when a record was found and applied.
        """
        with self._lock:
            rec = self._sessions.get(terminal)
            if rec is None:
                return False
            view = dict(rec)
            self._mode = terminal
            self._broker = rec.get("broker_id") or self._broker
            self._user_id = rec.get("user_id")
            self._session_id = rec.get("session_id")
            self._session_id_ref = rec.get("session_ref")
            self._login_at = rec.get("created_at")
            self._expires_at = rec.get("expires_at")
            self._validated_at = rec.get("validated_at")
            self._login_source = rec.get("login_source")
        status = view.get("session_status") or DISCONNECTED
        msg = view.get("state_message") or f"terminal {terminal}"
        self._set_state(status, msg)
        return True

    def terminal_session(self, terminal: str) -> dict[str, Any]:
        """Safe per-terminal record (no secrets). Empty envelope when unknown."""
        with self._lock:
            rec = self._sessions.get(terminal)
            if rec is not None:
                return dict(rec)
        return {
            "terminal_id": terminal,
            "broker_id": None,
            "session_id": None,
            "session_ref": None,
            "session_status": "NONE",
            "login_status": "not_started",
            "user_id": None,
            "created_at": None,
            "expires_at": None,
            "last_activity": None,
            "validated_at": None,
            "connection_status": "DISCONNECTED",
            "login_source": None,
            "state_message": "",
        }

    def manage_terminal_session(
        self,
        terminal: str,
        *,
        broker: Optional[str] = None,
        user_id: Optional[str] = None,
        session_ref: Optional[str] = None,
    ) -> dict[str, Any]:
        """Register a MANAGED terminal connection WITHOUT switching the active view.

        Used by Dummy Mode's always-on paper connection: the paper engine needs
        no broker credentials, so the backend keeps that terminal connected while
        it runs. The central active session stays exactly where the user left it
        (e.g. Kotak); only the terminal's own per-terminal record is written.
        """
        terminal = (terminal or "unknown").lower()
        now = time.time()
        session_id = f"ses_{uuid.uuid4().hex[:12]}"
        with self._lock:
            rec = self._record(terminal, broker)
            rec.update({
                "session_id": session_id,
                "session_ref": session_ref or session_id,
                "user_id": user_id,
                "created_at": now,
                "validated_at": now,
                "last_activity": now,
                "session_status": SESSION_ACTIVE,
                "login_status": "logged_in",
                "connection_status": self._ws_state or "CONNECTED",
                "login_source": "MANAGED",
                "state_message": "managed connection",
                "expires_at": None,
            })
            return dict(rec)

    # ------------------------------------------------------------------
    # Terminal-scoped background registration (scheduler-driven brokers)
    # ------------------------------------------------------------------
    # The Scheduler logs each enabled broker in independently and
    # simultaneously. Background logins must NEVER switch the user's active
    # view (_mode), the central state, or the global WebSocket flags: they only
    # write the target terminal's OWN record. The active view keeps whatever
    # the user selected (e.g. Kotak) while Shoonya logs in next to it.
    # ------------------------------------------------------------------

    def register_terminal_login(
        self,
        terminal: str,
        *,
        broker: Optional[str] = None,
        user_id: Optional[str] = None,
        session_ref: Optional[str] = None,
        login_source: Optional[str] = None,
        expires_at: Optional[float] = None,
        state_message: Optional[str] = None,
    ) -> dict[str, Any]:
        terminal = (terminal or "unknown").lower()
        now = time.time()
        session_id = f"ses_{uuid.uuid4().hex[:12]}"
        with self._lock:
            rec = self._record(terminal, broker)
            rec.update({
                "session_id": session_id,
                "session_ref": session_ref or session_id,
                "user_id": user_id,
                "created_at": now,
                "expires_at": expires_at,
                "validated_at": now,
                "last_activity": now,
                "session_status": SESSION_ACTIVE,
                "login_status": "logged_in",
                "login_source": login_source or "SCHEDULER",
                "state_message": state_message or "background login",
            })
            return dict(rec)

    def register_terminal_logout(
        self,
        terminal: str,
        *,
        reason: Optional[str] = None,
    ) -> dict[str, Any]:
        terminal = (terminal or "unknown").lower()
        reason = normalize_logout_reason(reason or "logout")
        now = time.time()
        with self._lock:
            rec = self._record(terminal, None)
            rec.update({
                "session_status": DISCONNECTED,
                "login_status": "logged_out",
                "session_id": None,
                "session_ref": None,
                "expires_at": None,
                "last_activity": now,
                "connection_status": "DISCONNECTED",
                "state_message": reason,
            })
            return dict(rec)

    def register_terminal_ws(
        self,
        terminal: str,
        state: str,
        *,
        connected_at: Optional[float] = None,
        disconnected_at: Optional[float] = None,
        last_message_at: Optional[float] = None,
        reason: Optional[str] = None,
    ) -> dict[str, Any]:
        terminal = (terminal or "unknown").lower()
        state = str(state or "CONNECTING").upper()
        if state not in {"CONNECTED", "DISCONNECTED", "CONNECTING", "STOPPED"}:
            state = "CONNECTING"
        now = time.time()
        with self._lock:
            rec = self._record(terminal, None)
            prev = rec.get("ws_connected_at")
            rec.update({
                "connection_status": state,
                "ws_state": state,
                "ws_connected_at": (
                    connected_at if connected_at is not None
                    else (now if state == "CONNECTED" else prev)
                ),
                "ws_disconnected_at": (
                    disconnected_at if disconnected_at is not None
                    else (now if state == "DISCONNECTED"
                          else rec.get("ws_disconnected_at"))
                ),
                "ws_last_message_at": (
                    last_message_at if last_message_at is not None
                    else rec.get("ws_last_message_at")
                ),
                "ws_reason": reason or rec.get("ws_reason"),
                "last_activity": now,
            })
            return dict(rec)

    # ------------------------------------------------------------------
    # Mode selection
    # ------------------------------------------------------------------
    def set_mode(self, mode: str, broker: Optional[str] = None, user_id: Optional[str] = None) -> None:
        """Select the active terminal CONTEXT (identity only; no login/logout).

        Switching is a pure context switch — it must never invalidate another
        terminal's session. If the target terminal has its own session record
        (from a prior login), that record is restored into the active view so
        Kotak→Dummy→Kotak cycles restore the existing Kotak session. If the
        target has no record, the view moves to that terminal's honest
        disconnected state.
        """
        mode = (mode or "kotak").lower()
        with self._lock:
            was = self._mode
            self._mode = mode
            if broker:
                self._broker = broker
            if user_id:
                self._user_id = user_id
        self._stamp("mode_set", f"mode={mode}")
        self._auth_log("MODE_SET", f"mode={mode}")
        # Publish the canonical session entity ALWAYS on a real context switch —
        # even when the state string does not change (DISCONNECTED→DISCONNECTED) —
        # so the frontend reconciler's `state.session?.mode` is never stale and it
        # does not fall back to an env-default terminal (kotak) after a switch to
        # dummy/shoonya.
        if was != mode:
            self._publish_session_entity(self._state, f"terminal mode {mode}")
        # Restore the target terminal's own session view when it has one.
        if not self._restore_record_to_view(mode):
            # No record yet → truthful disconnected view for the new terminal.
            # The previously-selected terminal's session is untouched (it lives
            # in its own record created at login time and is restored on switch
            # back); only the ACTIVE VIEW is reset, never any other terminal.
            with self._lock:
                self._user_id = user_id or None
                self._session_id = None
                self._session_id_ref = None
                self._login_at = None
                self._expires_at = None
                self._validated_at = None
                self._login_source = None
            if self._state != DISCONNECTED:
                self._set_state(DISCONNECTED, f"terminal {mode} not connected")

    # ------------------------------------------------------------------
    # Login
    # ------------------------------------------------------------------
    def mark_login_started(self) -> None:
        self._set_state(LOGGING_IN, "login in progress")
        self._auth_log("REQUEST", "manual login requested")

    def mark_login_success(
        self,
        *,
        mode: str,
        broker: str,
        user_id: Optional[str] = None,
        session_ref: Optional[str] = None,
        login_at: Optional[float] = None,
        lifetime_seconds: Optional[float] = None,
        source: str = "manual",
        scheduled_expires_at: Optional[float] = None,
    ) -> dict[str, Any]:
        """Record a successful broker login.

        ``expires_at`` is the REAL session end instant:
          - ``scheduled_expires_at`` (a scheduler-owned automatic login): the
            actual scheduled logout time for today — an absolute wall-clock
            instant, exactly like a manual expiry.
          - Otherwise ``login_time + lifetime_seconds``. Manual sessions use
            the configured session lifetime (default 60 minutes) so the
            Configuration UI applies live to NEW sessions.
        ``login_source`` captures the honest owner ("MANUAL"/"SCHEDULER") so
        the UI can render the correct countdown label — never guessed.

        The countdown is derived live from the wall clock — never fabricated.
        """
        now = time.time()
        login_at = login_at if login_at is not None else now
        if scheduled_expires_at is not None:
            expires_at = float(scheduled_expires_at)
            session_lifetime: Optional[float] = None
        elif lifetime_seconds is None:
            session_lifetime = float(_cfg_session_lifetime_seconds())
            expires_at = login_at + session_lifetime
        else:
            session_lifetime = float(lifetime_seconds)
            expires_at = login_at + session_lifetime
        session_id = f"ses_{uuid.uuid4().hex[:12]}"
        source_upper = "SCHEDULER" if str(source or "").lower() == "scheduler" else "MANUAL"

        with self._lock:
            self._mode = mode.lower()
            self._broker = broker
            self._user_id = user_id
            self._session_id = session_id
            self._session_id_ref = session_ref or session_id
            self._login_at = login_at
            self._expires_at = expires_at
            self._session_lifetime = session_lifetime
            self._login_source = source_upper
            self._validated_at = now
            self._last_activity_at = now
            self._last_auth_error = None
            self._last_auth_error_at = None
        self._set_state(SESSION_ACTIVE, "login success")
        self._sync_record_from_view(mode.lower())
        self._stamp("LOGIN_SUCCESS", f"mode={mode} broker={broker}")
        self._auth_log("ACCEPTED", f"login success mode={mode} user={user_id}")
        self._publish_domain_event("SESSION_CREATED", mode=mode.lower(), broker=broker,
                                   session_id=session_id, source=source_upper)
        return self.snapshot()

    def mark_expired(self, reason: Optional[str] = "session_expired") -> dict[str, Any]:
        """Record that an ACTIVE session reached its expiry.

        Pure state bookkeeping for the ACTIVE terminal: closing the broker
        WebSocket and logging out the broker is the scheduler's / endpoint's
        job so this module never imports the Kotak engine (no import cycles).
        Only the target terminal's OWN record moves to expired — other
        terminals' sessions are untouched.
        """
        reason = normalize_logout_reason(reason)
        now = time.time()
        with self._lock:
            target = self._mode or "unknown"
            login_at = self._login_at
            duration = (now - login_at) if login_at is not None else None
            if login_at is not None or self._mode:
                self._session_history.append(
                    _LogoutRecord(
                        login_time=login_at,
                        logout_time=now,
                        session_duration=duration,
                        logout_reason=reason,
                        mode=self._mode,
                        broker=self._broker,
                    )
                )
            self._login_at = None
            self._expires_at = None
            self._session_lifetime = None
            self._login_source = None
            self._validated_at = None
            self._session_id = None
            self._session_id_ref = None
            self._user_id = None if self._mode in {None, ""} else self._user_id
            rec = self._sessions.get(target)
            if rec is not None:
                rec.update({
                    "session_status": SESSION_EXPIRED,
                    "login_status": "expired",
                    "session_id": None,
                    "session_ref": None,
                    "expires_at": None,
                    "last_activity": now,
                    "connection_status": self._ws_state,
                    "state_message": reason,
                })
        self._set_state(SESSION_EXPIRED, reason)
        self._stamp("SESSION_EXPIRED", reason)
        self._auth_log("EXPIRED", reason)
        self._publish_domain_event("SESSION_EXPIRED", mode=target, reason=reason)
        self._notify_critical(
            "session", "warning", "Session expired",
            f"Broker session expired ({reason or 'session_expired'})",
            meta={"mode": target, "broker": self._broker, "reason": reason},
        )
        return self.snapshot()

    def mark_login_failure(self, error: Optional[str] = None) -> dict[str, Any]:
        with self._lock:
            self._last_auth_error = error or "authentication_failure"
            self._last_auth_error_at = time.time()
        self._set_state(ERROR, "login failed")
        self._stamp("LOGIN_FAILED", error or "")
        self._auth_log("REJECTED", "login failed")
        self._publish_domain_event("SESSION_ERROR", stage="login",
                                   error=error or "authentication_failure")
        self._notify_critical(
            "session", "error", "Session login failed",
            f"Could not establish broker session ({error or 'authentication_failure'})",
            meta={"stage": "login", "broker": self._broker, "error": error or ""},
        )
        return self.snapshot()

    # ------------------------------------------------------------------
    # Logout
    # ------------------------------------------------------------------
    def mark_logout(self, reason: Optional[str] = None, mode: Optional[str] = None) -> dict[str, Any]:
        """Record a session end with an honest reason; never guess.

        Terminal-scoped: default target is the ACTIVE terminal. Only that
        terminal's record is moved to logged-out — every other terminal keeps
        its own independent session record intact.
        """
        reason = normalize_logout_reason(reason)
        target = (mode or self._mode or "unknown").lower()
        now = time.time()
        with self._lock:
            login_at = self._login_at
            duration = (now - login_at) if login_at is not None else None
            if login_at is not None or self._state not in {DISCONNECTED} or self._mode:
                self._session_history.append(
                    _LogoutRecord(
                        login_time=login_at,
                        logout_time=now,
                        session_duration=duration,
                        logout_reason=reason,
                        mode=target,
                        broker=self._broker,
                    )
                )
            self._login_at = None
            self._expires_at = None
            self._session_lifetime = None
            self._login_source = None
            self._validated_at = None
            self._session_id = None
            self._session_id_ref = None
            self._user_id = None if self._mode in {None, ""} else self._user_id
            rec = self._sessions.get(target)
            if rec is not None:
                rec.update({
                    "session_status": DISCONNECTED,
                    "login_status": "logged_out",
                    "session_id": None,
                    "session_ref": None,
                    "expires_at": None,
                    "last_activity": now,
                    "connection_status": self._ws_state,
                    "state_message": reason,
                })
        self._set_state(LOGGING_OUT, reason)
        self._stamp("LOGOUT_RECORDED", reason)
        self._auth_log("LOGOUT", reason)
        self._set_state(DISCONNECTED, "logged out")
        self._publish_domain_event("SESSION_LOGOUT_COMPLETED", mode=target, reason=reason)
        return self.snapshot()

    # ------------------------------------------------------------------
    # Expiry / session validity
    # ------------------------------------------------------------------
    def remaining_seconds(self) -> Optional[float]:
        with self._lock:
            expires_at = self._expires_at
            state = self._state
        if expires_at is None:
            # Automatic (scheduler-owned) session: active until logout, no
            # wall-clock countdown.
            return None
        remaining = expires_at - time.time()
        if remaining <= 0 and state not in {SESSION_EXPIRED, SESSION_EXPIRING}:
            self._set_state(SESSION_EXPIRED, "session expired")
            remaining = 0.0
        elif 0 < remaining <= 300 and state == SESSION_ACTIVE:
            self._set_state(SESSION_EXPIRING, "session expiring")
        return max(0.0, remaining)

    def is_active(self) -> bool:
        with self._lock:
            expires = self._expires_at
            state = self._state
        if expires is not None and time.time() >= expires:
            if state in {SESSION_ACTIVE, SESSION_EXPIRING}:
                self._set_state(SESSION_EXPIRED, "session expired")
            return False
        return state in {SESSION_ACTIVE, SESSION_EXPIRING, WS_CONNECTING, WS_ACTIVE}

    # ------------------------------------------------------------------
    # WebSocket ownership / status
    # ------------------------------------------------------------------
    def mark_ws_connecting(self) -> None:
        self._set_state(WS_CONNECTING, "websocket connecting")
        self._stamp("WS_CONNECTING", "")

    def mark_ws_connected(self, timestamp: Optional[float] = None) -> None:
        now = timestamp if timestamp is not None else time.time()
        with self._lock:
            self._ws_connected_at = now
            self._ws_disconnected_at = None
            self._ws_state = "CONNECTED"
        self._set_state(WS_ACTIVE, "websocket connected")
        self._stamp("WEBSOCKET_CONNECTED", "")
        self._publish_domain_event("SESSION_READY", mode=self._mode, ws_state="CONNECTED")

    def mark_ws_disconnected(self, reason: Optional[str], timestamp: Optional[float] = None) -> None:
        now = timestamp if timestamp is not None else time.time()
        with self._lock:
            self._ws_disconnected_at = now
            self._ws_disconnect_reason = reason or self._ws_disconnect_reason
            self._ws_state = "DISCONNECTED"
            self._reconnect_count += 0  # reconnect count incremented on reconnect
        self._stamp("WEBSOCKET_DISCONNECTED", reason or "")
        if self.is_active():
            self._set_state(SESSION_ACTIVE, "websocket down (session valid)")
        try:
            from services.notification_center import _DELIBERATE_REASON_CODES
            dealib = set(_DELIBERATE_REASON_CODES)
        except Exception:  # noqa: BLE001
            dealib = {"scheduled_disconnect", "application_shutdown", "market_closed",
                      "user_disconnect", "stopped_by_scheduler", "app_shutdown", "logout"}
        if reason and str(reason).lower() not in dealib:
            self._notify_critical(
                "session", "warning", "Session feed disconnected",
                f"Session feed disconnected while session active ({reason or 'unknown reason'})",
                meta={"broker": self._broker, "reason": reason or ""},
            )

    def mark_ws_reconnecting(self) -> None:
        with self._lock:
            self._reconnect_count += 1
            self._ws_state = "RECONNECTING"
        self._set_state(WS_CONNECTING, "reconnecting")
        self._stamp("RECONNECTING", "")

    def mark_ws_message(self, timestamp: Optional[float] = None) -> None:
        with self._lock:
            self._ws_last_message_at = timestamp if timestamp is not None else time.time()
            self._last_ws_event_at = time.time()
            self._last_activity_at = time.time()

    # ------------------------------------------------------------------
    # Subscription / routing state (authoritative "what is subscribed")
    # ------------------------------------------------------------------
    # The Session Manager is the SINGLE source of truth for the subscription
    # set (desired + actual broker acks + pins + real expiry + routing + field
    # requirements). The WebSocket Engine consumes this state and computes the
    # broker delta; the scheduler sources its WS preparation from here. Every
    # mutation bumps ``_subs_revision`` so consumers can diff cheaply.
    # ------------------------------------------------------------------

    @staticmethod
    def _row_key(row: dict) -> tuple[str, str]:
        """Normalize any instrument row/body into ``(exchange_segment, token)``."""
        segment = str(row.get("exchange_segment") or row.get("exchangeSegment") or "")
        token = row.get("instrument_token")
        if token is None:
            token = row.get("instrumentToken")
        if token is None:
            ik = row.get("instrument_key")
            if isinstance(ik, str) and "|" in ik:
                segment, _, token = ik.partition("|")
        return (segment, str(token or ""))

    @staticmethod
    def _subscribers(rec: dict[str, Any]) -> list[str]:
        """Derived consumer list for an instrument (spec §9/§10).

        Built from the accumulated ``sources`` plus any pin consumers; never
        fabricated (empty when nothing has claimed the instrument).
        """
        names: list[str] = []
        for name in list(rec.get("sources") or []):
            if name and name not in names:
                names.append(name)
        pin = rec.get("pin")
        if isinstance(pin, dict):
            for name in list(pin.get("consumers") or []):
                if name and name not in names:
                    names.append(name)
        src = rec.get("source")
        if src and src not in names:
            names.append(src)
        return names

    def _bump_subs(self, message: str = "") -> int:
        with self._lock:
            self._subs_revision += 1
            self._subs_last_updated = time.time()
            revision = self._subs_revision
        self._stamp("SUBSCRIPTIONS_UPDATED", message, {"revision": revision})
        _log.info(
            "[SESSION_MANAGER] event=SUBSCRIPTIONS_UPDATED revision=%d %s",
            revision, message,
        )
        return revision

    def _recompute_sub_state(self, rec: dict[str, Any], now: float) -> str:
        """Derive the canonical subscription state from the record's inputs."""
        if rec.get("active") is False and not rec.get("pin") and not rec.get("desired"):
            return INACTIVE
        expires_at = rec.get("expires_at")
        if expires_at is not None and now >= float(expires_at):
            return EXPIRED
        pinned = bool(rec.get("pin"))
        subscribed = bool(rec.get("subscribed"))
        if pinned:
            return SUBSCRIBED_PINNED if subscribed else PINNED
        return SUBSCRIBED if subscribed else NOT_SUBSCRIBED

    def _subs_record(self, key: tuple[str, str], seed: Optional[dict] = None) -> dict[str, Any]:
        with self._lock:
            rec = self._subs.get(key)
            if rec is None:
                now = time.time()
                rec = {
                    "instrument_token": (seed or {}).get("instrument_token") or key[1],
                    "exchange_segment": (seed or {}).get("exchange_segment") or key[0],
                    "symbol": (seed or {}).get("symbol") or "",
                    "trading_symbol": (seed or {}).get("trading_symbol") or (seed or {}).get("symbol") or "",
                    "is_index": bool((seed or {}).get("is_index", False)),
                    "is_depth": bool((seed or {}).get("is_depth", False)),
                    "source": (seed or {}).get("source") or "broker_ack",
                    "sources": list((seed or {}).get("sources") or [])
                               or ([(seed or {}).get("source") or "broker_ack"]),
                    "desired": bool((seed or {}).get("desired", True)),
                    "active": bool((seed or {}).get("active", True)),
                    "advertised": bool((seed or {}).get("advertised", False)),
                    "subscribed": False,
                    "pin": None,
                    "expires_at": (seed or {}).get("expires_at"),
                    "expiry_type": (seed or {}).get("expiry_type"),
                    "expiry_label": (seed or {}).get("expiry_label"),
                    "feed_level": (seed or {}).get("feed_level"),
                    "market_data": (seed or {}).get("market_data"),
                    "routing": (seed or {}).get("routing") or self._subs_routing,
                    "routing_owner": (seed or {}).get("routing_owner") or self._subs_routing_owner,
                    "routing_targets": list((seed or {}).get("routing_targets") or []),
                    "connection_targets": list((seed or {}).get("connection_targets") or []),
                    "required_fields": list((seed or {}).get("required_fields") or []),
                    "broker": (seed or {}).get("broker") or (self._mode or "kotak").lower(),
                    "last_update_at": (seed or {}).get("last_update_at"),
                    "created_at": (seed or {}).get("created_at") or now,
                    "updated_at": (seed or {}).get("updated_at") or now,
                    "last_tick_at": (seed or {}).get("last_tick_at"),
                    "sub_requested": bool((seed or {}).get("sub_requested", False)),
                    "unsub_requested": bool((seed or {}).get("unsub_requested", False)),
                    "error": (seed or {}).get("error"),
                    "error_at": (seed or {}).get("error_at"),
                    "market_date": (seed or {}).get("market_date"),
                    "source_session_id": (seed or {}).get("source_session_id"),
                    "state": NOT_SUBSCRIBED,
                }
                self._subs[key] = rec
            return rec

    async def refresh_desired_subscriptions(self, force: bool = False) -> dict[str, int]:
        """Rebuild the DESIRED set from MongoDB ``stocks`` (active) + pins.

        This is the ONLY place the session-day subscription intent is derived
        from the database; the scheduler and WebSocket engine read it back via
        :meth:`subscription_desired_keys`. Throttled (10 s) unless ``force``.
        Instruments no longer active are marked INACTIVE (still reported, never
        subscribed). Returns the current counts.
        """
        now = time.time()
        with self._lock:
            if not force and (now - self._subs_last_refresh) < 10.0:
                return self.subscription_counts()
            self._subs_last_refresh = now
        try:
            from database.connection import get_db
            db = get_db()
            cursor = db.stocks.find({"active": True})
            stocks = await cursor.to_list(length=None)
        except Exception as exc:  # noqa: BLE001
            _log.warning("Desired-subscription refresh failed: %s", exc)
            return self.subscription_counts()

        try:
            from services.instrument_cache import instrument_cache
            master_loaded = bool(instrument_cache.loaded)
        except Exception:  # noqa: BLE001 - defensive: cache is optional
            instrument_cache = None
            master_loaded = False

        incoming: dict[tuple[str, str], dict[str, Any]] = {}
        for s in stocks or []:
            token_val = s.get("instrumentToken") or s.get("token") or s.get("instrument_token")
            if not token_val:
                continue
            segment = str(s.get("exchangeSegment", "nse_cm"))
            key = (segment, str(token_val))
            # Enrich from the SANCTIONED instrument master (the authoritative
            # per-instrument feed classification). The persisted stock doc may
            # carry stale/hardcoded flags; the master is the real source of
            # truth for isIndex / isDepth / feedLevel / marketData. An explicit
            # truthy flag in the stock doc always wins; the master fills
            # missing/unknown values only — never downgrades an explicit intent.
            inst = None
            if master_loaded and instrument_cache is not None:
                try:
                    inst = instrument_cache.lookup_by_token(str(token_val))
                except Exception:  # noqa: BLE001 - defensive lookups
                    inst = None
            stock_index = bool(s.get("isIndex", False))
            stock_feed_level = s.get("feedLevel") if s.get("feedLevel") is not None else None
            stock_market = s.get("marketData") or s.get("market_data") or None
            master_index = bool((inst or {}).get("isIndex", False))
            master_feed_level = (inst or {}).get("feedLevel")
            master_market = (inst or {}).get("marketData")
            is_index = stock_index or master_index
            feed_level = stock_feed_level if stock_feed_level is not None else master_feed_level
            market_data = stock_market or master_market
            if is_index:
                is_depth = False
                feed_level = None
                market_data = "INDEX"
            else:
                # L8 depth is now the default market-data feed for every equity.
                # Stale L4/touch-line flags are promoted to L8 — never kept, never
                # downgraded. Full depth (L16) is preserved when requested.
                is_depth = True
                if feed_level not in (8, 16):
                    feed_level = 8
                    market_data = "L8"
                elif feed_level == 16:
                    market_data = "L16"
                else:
                    market_data = "L8"
            incoming[key] = {
                "instrument_token": str(token_val),
                "exchange_segment": segment,
                "symbol": s.get("symbol") or s.get("tradingSymbol") or "",
                "trading_symbol": s.get("tradingSymbol") or s.get("symbol") or "",
                "is_index": is_index,
                "is_depth": is_depth,
                "feed_level": feed_level,
                "market_data": market_data,
                "source": "stocks_db",
                "sources": ["stocks_db"],
                "desired": True,
                "active": True,
                # Equities carry no expiry — honest, never fabricated:
                "expires_at": None,
                "expiry_type": None,
                "expiry_label": None,
            }

        changed = False
        with self._lock:
            prev_desired = {k for k, r in self._subs.items() if r.get("desired")}
            for key, seed in incoming.items():
                rec = self._subs_record(key, dict(seed))
                if not rec.get("desired") or rec.get("active") is False:
                    changed = True
                rec["desired"] = True
                rec["active"] = True
                rec["source"] = seed["source"]
                srcs = list(rec.get("sources") or [])
                if "stocks_db" not in srcs:
                    srcs.append("stocks_db")
                rec["sources"] = srcs
                if seed.get("symbol"):
                    rec["symbol"] = seed["symbol"]
                    rec["trading_symbol"] = seed.get("trading_symbol") or rec["trading_symbol"]
                # Only pull stock-level flags; broker ack / pin / fields stay.
                rec["is_index"] = seed.get("is_index", rec.get("is_index", False))
                rec["is_depth"] = seed.get("is_depth", rec.get("is_depth", False))
                # Feed classification comes straight from the sanctioned master
                # via the seed; a known value always overrides a stale/None one.
                if seed.get("feed_level") is not None:
                    rec["feed_level"] = seed["feed_level"]
                if seed.get("market_data"):
                    rec["market_data"] = seed["market_data"]
                rec["expires_at"] = seed.get("expires_at") or rec.get("expires_at")
                rec["expiry_type"] = seed.get("expiry_type") or rec.get("expiry_type")
                rec["broker"] = rec.get("broker") or (self._mode or "kotak").lower()
            # Sweep: only disable records whose own source of desire disappeared.
            # Canonical-store instruments (watchlist / search / dashboard /
            # engine / manual upserts) are NOT disabled just because they are
            # absent from db.stocks — "removed from the market universe" is a
            # different decision made by the canonical store owner.
            for key in list(self._subs):
                if key not in incoming:
                    rec = self._subs[key]
                    source = rec.get("source") or ""
                    store_desired = bool(rec.get("desired"))
                    if source == "stocks_db" or not store_desired:
                        if rec.get("desired"):
                            changed = True
                        rec["desired"] = False
                        if not rec.get("pin"):
                            if rec.get("active"):
                                changed = True
                            rec["active"] = False
            now_ts = time.time()
            for rec in self._subs.values():
                state = self._recompute_sub_state(rec, now_ts)
                if rec.get("state") != state:
                    changed = True
                    rec["state"] = state
                rec["updated_at"] = now_ts
            new_desired = {k for k, r in self._subs.items() if r.get("desired")}
            if prev_desired != new_desired:
                changed = True
        if changed:
            self._bump_subs("desired subscriptions refreshed")
            # Persist the market-universe facet once on a FORCED refresh
            # (boot path) so the canonical store survives a restart.
            if force:
                await self._persist_many(list(incoming.values()))
            self._publish_engine_event(
                "SUBSCRIPTION_UPDATED",
                {"kind": "desired_refreshed", "counts": self.subscription_counts()},
            )
        return self.subscription_counts()

    # ------------------------------------------------------------------
    # Daily Market Watch universe subscription intent (doc §5/§14)
    # ------------------------------------------------------------------
    # The Market Watch Engine builds the intraday-eligible NSE EQ universe for
    # the trading day; the Session Manager records it as the canonical
    # current-day DESIRED set (source=market_watch_daily_universe) tagged with
    # trading_date / session_id / revision. Previous-day universe intents are
    # expired here so a new trading day never silently keeps subscribing
    # revoked instruments. The WebSocket Engine reconciles this set with the
    # broker after every apply (daily path) and on reconnect.
    # ------------------------------------------------------------------
    @staticmethod
    def _daily_feed_flags(inst: Optional[dict]) -> dict:
        """Sanctioned feed classification for a universe instrument.

        mirrors the equities branch of ``refresh_desired_subscriptions``:
        L8 depth is the default market-data feed for every equity; L16 is
        preserved when the sanctioned master says so; indices (never part of
        the NSE EQ universe but defensively handled) use the INDEX feed.
        """
        if isinstance(inst, dict) and inst.get("isIndex"):
            return {
                "is_index": True,
                "is_depth": False,
                "feed_level": None,
                "market_data": "INDEX",
            }
        feed_level = (inst or {}).get("feedLevel")
        if feed_level == 16:
            return {
                "is_index": False,
                "is_depth": True,
                "feed_level": 16,
                "market_data": "L16",
            }
        return {
            "is_index": False,
            "is_depth": True,
            "feed_level": DEFAULT_FEED_LEVEL,
            "market_data": "L8",
        }

    async def apply_daily_subscription_intent(
        self,
        market_date: str,
        session_id: Optional[str],
        rows: list[dict],
    ) -> dict[str, Any]:
        """Record the Market Watch current-day eligible universe intent.

        ``rows`` are the intraday-eligible universe subscriptions produced by
        the Market Watch Engine for ``market_date``. Every row is merged into
        the canonical set (desired=True, active=True, source=market_watch_daily
        _universe, tagged with trading_date/session_id). Records that carried
        ONLY the daily-universe source and are NOT in today's set are
        deactivated (revoked for the new day). Returns a live snapshot of the
        applied intent (counts are real, never fabricated).
        """
        today = str(market_date or "")
        incoming: dict[tuple[str, str], dict[str, Any]] = {}
        for row in rows or []:
            token = str(row.get("instrumentToken") or row.get("instrument_token") or "")
            if not token:
                continue
            segment = str(row.get("exchangeSegment") or row.get("exchange_segment") or "nse_cm")
            inst = None
            try:
                from services.instrument_cache import instrument_cache
                if instrument_cache.loaded:
                    inst = instrument_cache.lookup_by_token(token)
            except Exception:  # noqa: BLE001 - defensive
                inst = None
            flags = self._daily_feed_flags(inst if isinstance(inst, dict) else None)
            incoming[(segment, token)] = {
                "instrument_token": token,
                "exchange_segment": segment,
                "symbol": row.get("symbol") or "",
                "trading_symbol": (row.get("tradingSymbol")
                                   or row.get("trading_symbol") or row.get("symbol") or ""),
                **flags,
                "source": SOURCE_DAILY_UNIVERSE,
                "sources": [SOURCE_DAILY_UNIVERSE],
                "desired": True,
                "active": True,
                # The daily universe is a session-scoped intent — rebuilt each
                # day, never a fabricated wall-clock expiry.
                "expires_at": None,
                "expiry_type": None,
                "expiry_label": None,
                "market_date": today,
                "source_session_id": session_id,
            }

        now = time.time()
        changed = False
        changed_keys: set[tuple[str, str]] = set()
        with self._lock:
            prev_desired = {k for k, r in self._subs.items() if r.get("desired")}
            for key, seed in incoming.items():
                rec = self._subs_record(key, dict(seed))
                changed_keys.add(key)
                if not rec.get("desired") or rec.get("active") is False:
                    changed = True
                rec["desired"] = True
                rec["active"] = True
                rec["source"] = SOURCE_DAILY_UNIVERSE
                srcs = list(rec.get("sources") or [])
                if SOURCE_DAILY_UNIVERSE not in srcs:
                    srcs.append(SOURCE_DAILY_UNIVERSE)
                rec["sources"] = srcs
                if seed.get("symbol"):
                    rec["symbol"] = seed["symbol"]
                    rec["trading_symbol"] = seed.get("trading_symbol") or rec["trading_symbol"]
                rec["is_index"] = bool(seed.get("is_index", rec.get("is_index", False)))
                rec["is_depth"] = bool(seed.get("is_depth", rec.get("is_depth", False)))
                if seed.get("feed_level") is not None:
                    rec["feed_level"] = seed["feed_level"]
                if seed.get("market_data"):
                    rec["market_data"] = seed["market_data"]
                rec["expires_at"] = seed.get("expires_at") or rec.get("expires_at")
                rec["expiry_type"] = seed.get("expiry_type") or rec.get("expiry_type")
                rec["market_date"] = today
                if session_id is not None:
                    rec["source_session_id"] = session_id
                rec["broker"] = rec.get("broker") or (self._mode or "kotak").lower()
            # Expire the PREVIOUS day's / revoked universe intent: a record
            # whose daily-universe claim is stale (older trading date, or the
            # token is no longer in today's universe) loses that claim. Pins
            # are preserved (the consumer still requires the feed) — the pin
            # keeps the record desired, it just stops counting as a universe
            # claim, exactly like the db.stocks sweep.
            for key in list(self._subs):
                rec = self._subs[key]
                srcs = list(rec.get("sources") or [])
                if SOURCE_DAILY_UNIVERSE not in srcs:
                    continue
                if str(rec.get("market_date") or "") == today and key in incoming:
                    continue
                if rec.get("desired") or rec.get("active"):
                    changed = True
                srcs = [s for s in srcs if s != SOURCE_DAILY_UNIVERSE]
                if not srcs:
                    rec["source"] = "pin" if rec.get("pin") else "manual"
                rec["sources"] = srcs
                if not rec.get("pin"):
                    rec["desired"] = False
                    rec["active"] = False
                changed_keys.add(key)
            for key, rec in self._subs.items():
                state = self._recompute_sub_state(rec, now)
                if rec.get("state") != state:
                    changed = True
                    rec["state"] = state
                    changed_keys.add(key)
                rec["updated_at"] = now
            new_desired = {k for k, r in self._subs.items() if r.get("desired")}
            if prev_desired != new_desired:
                changed = True
            self._daily_intent = {
                "market_date": today,
                "session_id": session_id,
                "rows_applied": len(incoming),
                "applied_at": time.time(),
                "revision": self._subs_revision,
            }
        if changed:
            self._bump_subs(f"daily universe intent applied (date={today or '?'})")
            # Persist every record this apply changed, not just the new rows.
            # Revoked rows must reach the store with desired=False or the next
            # restart restores the previous (larger) universe.
            await self._persist_many([self._subs[k] for k in changed_keys])
            self._publish_engine_event(
                "SUBSCRIPTION_UPDATED",
                {
                    "kind": "daily_market_universe",
                    "market_date": today,
                    "rows": len(incoming),
                    "counts": self.subscription_counts(),
                },
            )
        return self.daily_intent_snapshot()

    def daily_intent_snapshot(self) -> dict[str, Any]:
        """Live read of the current-day Market Watch daily-universe intent."""
        with self._lock:
            intent = dict(self._daily_intent or {})
            desired_by_source: dict[str, int] = {}
            universe_desired: set[tuple[str, str]] = set()
            universe_dates: set[str] = set()
            for key, rec in list(self._subs.items()):
                if not rec.get("desired"):
                    continue
                src = rec.get("source") or "unknown"
                desired_by_source[src] = desired_by_source.get(src, 0) + 1
                if SOURCE_DAILY_UNIVERSE in (rec.get("sources") or []):
                    universe_desired.add(key)
                    market_date = str(rec.get("market_date") or "")
                    if market_date:
                        universe_dates.add(market_date)
            counts = self.subscription_counts()
            rows_applied = int(intent.get("rows_applied") or 0)
            if not rows_applied and universe_desired:
                # After a restart the in-memory summary is empty, but the
                # canonical daily-universe records were restored from the
                # store. Report that restored set instead of a misleading 0.
                rows_applied = len(universe_desired)
            market_date = intent.get("market_date")
            if not market_date and len(universe_dates) == 1:
                market_date = next(iter(universe_dates))
        return {
            "ok": True,
            "market_date": market_date,
            "session_id": intent.get("session_id"),
            "revision": counts.get("revision"),
            "rows_applied": rows_applied,
            "daily_universe_desired": len(universe_desired),
            "desired": counts.get("desired", 0),
            "desired_by_source": dict(desired_by_source),
            "subscribed": counts.get("subscribed", 0),
            "applied_at": _iso(intent.get("applied_at")) if intent.get("applied_at") else None,
        }

    def publish_margin_decisions(
        self, decisions: dict[str, dict[str, Any]],
    ) -> dict[str, int]:
        """Publish broker-resolved margin/leverage decisions (the producer side).

        This is the write half of the contract that
        :func:`services.market_watch_eligibility.margin_decision` reads out of
        the snapshot. Called by the margin resolver, never by a consumer.

        A decision is stored only when it is actually ANSWERED. An unanswered
        lookup is not published at all, so a consumer's absence-means-unknown
        reading stays truthful instead of picking up a fabricated "no".
        """
        stored = 0
        with self._lock:
            for token, entry in (decisions or {}).items():
                key = str(token or "").strip()
                if not key or not isinstance(entry, dict):
                    continue
                self._margin_decisions[key] = {
                    "eligible": bool(entry.get("eligible")),
                    "reason": str(entry.get("reason") or ""),
                    "multiplier": entry.get("multiplier"),
                    "marginAmount": entry.get("marginAmount"),
                    "status": str(entry.get("status") or "AUTHORITATIVE"),
                    "basis": str(entry.get("basis") or ""),
                    "intradayStatus": str(entry.get("intradayStatus") or "UNKNOWN"),
                    "resolvedAt": entry.get("resolvedAt") or time.time(),
                }
                stored += 1
        return {"published": stored, "total": len(self._margin_decisions)}

    def margin_decisions_for(self, tokens: list[str] | None = None) -> dict[str, dict[str, Any]]:
        """Read published margin decisions for ``tokens`` (or all of them)."""
        with self._lock:
            if tokens is None:
                return dict(self._margin_decisions)
            return {
                str(t): self._margin_decisions[str(t)]
                for t in tokens
                if str(t) in self._margin_decisions
            }

    def set_pin_intents(self, pins: list[dict], bump: bool = True) -> dict[str, int]:
        """Merge engine-reported pin intents into the subscription records.

        ``pins`` is the engine's ``PinManager.list()`` (full pin dicts, not the
        flattened registry rows). PIN state is independent of subscription
        state — a removed pin never unsubscribes an instrument another consumer
        still requires (the engine owns that dedup).
        """
        now = time.time()
        new_pins: dict[tuple[str, str], dict[str, Any]] = {}
        changed_to: dict[tuple[str, str], Optional[dict[str, Any]]] = {}
        for row in pins or []:
            key = self._row_key(row)
            if not key[1]:
                continue
            pin = {
                "source": row.get("source", "manual"),
                "priority": row.get("priority", 1),
                "profile_id": row.get("profile_id", "PINNED_HIGH"),
                "consumers": list(row.get("consumers") or []),
                "reason": row.get("reason", ""),
                "expires_at": row.get("expires_at"),
                "fields": list(row.get("fields") or []),
            }
            new_pins[key] = pin
            changed_to[key] = pin
        with self._lock:
            existing = dict(self._pin_keys())
            merged: set = set()
            for key in new_pins:
                rec = self._subs_record(key, {
                    "symbol": new_pins[key].get("symbol") or "",
                })
                if rec.get("pin") != new_pins[key]:
                    changed_to[key] = dict(new_pins[key])
                rec["pin"] = dict(new_pins[key])
                if key in existing:
                    existing.remove(key)
                merged.add(key)
            # Pins removed at the engine: drop the pin, keep the record honest.
            for key in existing:
                if key in self._subs:
                    if self._subs[key].get("pin") is not None:
                        changed_to[key] = None
                    self._subs[key]["pin"] = None
        applied = len(new_pins)
        if bump and changed_to:
            for rec in list(self._subs.values()):
                rec["state"] = self._recompute_sub_state(rec, now)
            self._bump_subs(f"pin intents applied (pins={applied})")
        return self.subscription_counts()

    def _pin_keys(self) -> list[tuple[str, str]]:
        return [k for k, r in self._subs.items() if r.get("pin") is not None]

    def mark_broker_subscribed(self, rows: list[dict]) -> dict[str, int]:
        """Record broker acknowledgements for instruments actually subscribed."""
        changed = False
        now = time.time()
        with self._lock:
            for row in rows or []:
                key = self._row_key(row)
                if not key[1]:
                    continue
                rec = self._subs_record(key, dict(row))
                rec["subscribed"] = True
                rec["active"] = True
                rec["last_update_at"] = now
                state = self._recompute_sub_state(rec, now)
                if rec.get("state") != state:
                    changed = True
                    rec["state"] = state
        if changed:
            self._bump_subs("broker acknowledgements (subscribed)")
        for row in rows or []:
            rec = self._subs.get(self._row_key(row))
            if rec is not None:
                self._publish_domain_event("SUBSCRIPTION_ACTIVATED", rec,
                                           source="broker_ack")
        return self.subscription_counts()

    def mark_broker_unsubscribed(self, rows: list[dict], reason: str = "") -> dict[str, int]:
        """Record that the broker no longer sends these instruments."""
        changed = False
        now = time.time()
        with self._lock:
            for row in rows or []:
                key = self._row_key(row)
                if not key[1]:
                    continue
                rec = self._subs.get(key)
                if rec is None or not rec.get("subscribed"):
                    continue
                rec["subscribed"] = False
                rec["last_update_at"] = now
                state = self._recompute_sub_state(rec, now)
                if rec.get("state") != state:
                    changed = True
                    rec["state"] = state
        if changed:
            self._bump_subs(f"broker acknowledgements (unsubscribed) {reason}".strip())
        for row in rows or []:
            rec = self._subs.get(self._row_key(row))
            if rec is not None:
                self._publish_domain_event("SUBSCRIPTION_DEACTIVATED", rec,
                                           source="broker_ack", reason=reason)
        return self.subscription_counts()

    def expire_subscription(self, row: dict, expires_at: float) -> dict[str, int]:
        """Mark an instrument EXPIRED — real expiry only (never fabricated)."""
        key = self._row_key(row)
        if not key[1]:
            return self.subscription_counts()
        with self._lock:
            rec = self._subs_record(key, {
                "instrument_token": key[1],
                "exchange_segment": key[0],
                "symbol": row.get("symbol", ""),
            })
            if float(expires_at) != rec.get("expires_at"):
                changed = True
            rec["expires_at"] = float(expires_at)
            rec["subscription_state_explicit"] = True
            rec["state"] = EXPIRED
        self._bump_subs(f"expired subscription {key[0]}|{key[1]}")
        self._publish_domain_event("STOCK_EXPIRED", rec, source="expiry")
        self._publish_domain_event("SUBSCRIPTION_DEACTIVATED", rec, source="expiry")
        return self.subscription_counts()

    def deactivate_subscription(self, row: dict) -> dict[str, int]:
        key = self._row_key(row)
        if not key[1]:
            return self.subscription_counts()
        with self._lock:
            rec = self._subs_record(key, {
                "instrument_token": key[1],
                "exchange_segment": key[0],
                "symbol": row.get("symbol", ""),
            })
            rec["active"] = False
            if not rec.get("pin"):
                rec["desired"] = False
            rec["state"] = INACTIVE
        self._bump_subs(f"deactivated subscription {key[0]}|{key[1]}")
        self._publish_domain_event("SUBSCRIPTION_DEACTIVATED", rec, source="deactivate")
        return self.subscription_counts()

    def mark_subscription_routing(self, state: str, owner: str = "ws_manager",
                                  bump: bool = False) -> None:
        """Record which connection serves the feed (route per subscription)."""
        with self._lock:
            if state == self._subs_routing and owner == self._subs_routing_owner:
                return
            self._subs_routing = state
            self._subs_routing_owner = owner
            for rec in self._subs.values():
                rec["routing"] = state
                rec["routing_owner"] = owner
        if bump:
            self._bump_subs(f"subscription routing -> {state} ({owner})")
        else:
            with self._lock:
                self._subs_revision += 1

    def set_required_fields(self, rows: list[dict]) -> None:
        """Attach the field requirements of the consuming profiles per instrument."""
        changed = False
        with self._lock:
            for row in rows or []:
                key = self._row_key(row)
                fields = row.get("required_fields") or row.get("fields")
                if fields and key[1]:
                    rec = self._subs_record(key, row)
                    if list(fields) != list(rec.get("required_fields") or []):
                        rec["required_fields"] = list(fields)
                        changed = True
        if changed:
            self._bump_subs("required fields updated")

    def mark_instrument_tick(self, row: dict, at: Optional[float] = None) -> None:
        """Record the last feed timestamp for an instrument (TICK_VALIDATED).

        Does not bump the revision (validated ticks are high-frequency; the
        canonical ACTIVE status is derived live from ``last_tick_at``).
        """
        key = self._row_key(row)
        if not key[1]:
            return
        now = at if at is not None else time.time()
        with self._lock:
            rec = self._subs.get(key)
            if rec is None:
                rec = self._subs_record(key, {
                    "instrument_token": key[1],
                    "exchange_segment": key[0],
                    "symbol": row.get("symbol", ""),
                })
            prev_tick = rec.get("last_tick_at")
            rec["last_update_at"] = now
            rec["last_tick_at"] = now
            # Only flip EXPIRED -> subscribing on a real validated tick is NOT
            # allowed here: expiry overrides feed (honest state machine).
            if prev_tick is None:
                pass

    # ------------------------------------------------------------------
    # Phase 3 canonical lifecycle management (Session Manager Engine)
    # ------------------------------------------------------------------
    # Adds persistent, multi-source instrument CRUD: subscribe / unsubscribe /
    # pin / unpin / activate / deactivate / expire / remove + a reconcile sweep
    # that enforces real expiries. Every mutation bumps the revision, publishes
    # a SESSION_INSTRUMENT_* engine event and mirrors the canonical record to
    # Mongo (``session_manager_instruments``) so restart recovery never guesses.
    # ------------------------------------------------------------------
    def _row_key_from_data(self, data: dict) -> tuple[str, str]:
        """Normalize an arbitrary input body into ``(segment, token)``.

        Accepts ``instrument_key`` (``seg|tok``), ``exchangeSegment`` /
        ``instrumentToken`` and ``exchange_segment`` / ``instrument_token``.
        """
        row = dict(data or {})
        ik = row.get("instrument_key")
        if ik and isinstance(ik, str) and "|" in ik:
            seg, _, tok = ik.partition("|")
            row.setdefault("exchange_segment", seg)
            row.setdefault("instrument_token", tok)
        if row.get("exchangeSegment") and not row.get("exchange_segment"):
            row["exchange_segment"] = row["exchangeSegment"]
        if row.get("instrumentToken") and not row.get("instrument_token"):
            row["instrument_token"] = row["instrumentToken"]
        return (str(row.get("exchange_segment") or ""), str(row.get("instrument_token") or ""))

    def _sanitize_feed_level(self, level: Any) -> Optional[int]:
        """Returns a real supported feed level (4/8/16) or None."""
        try:
            level = int(level)
        except (TypeError, ValueError):
            return None
        return level if level in SUPPORTED_FEED_LEVELS else None

    def _merge_expiry(self, rec: dict[str, Any], data: dict) -> bool:
        """Merge an expiry from user input onto a record (honest, real only)."""
        changed = False
        raw = data.get("expires_at")
        expiry_type = (data.get("expiry_type") or "").upper()
        label = data.get("expiry_label")
        if expiry_type and expiry_type not in EXPIRY_TYPES:
            expiry_type = "DURATION"
        if raw is not None:
            try:
                value = float(raw)
            except (TypeError, ValueError):
                value = None
            if value is not None:
                if rec.get("expires_at") != value:
                    rec["expires_at"] = value
                    changed = True
                if expiry_type and rec.get("expiry_type") != expiry_type:
                    rec["expiry_type"] = expiry_type
                    changed = True
                if label and rec.get("expiry_label") != label:
                    rec["expiry_label"] = label
                    changed = True
                rec["active"] = True
        return changed

    async def reload_instruments(self, force: bool = False, broker: Optional[str] = None) -> int:
        """Hydrate the in-memory canonical set from the Mongo canonical store.

        This is the crash-recovery path: the store is the durable record of
        desired / active / pinned / feed level / expiry / fields per instrument.
        Runtime-only facets (broker acks) are NOT rebuilt — the engine re-acks
        on reconnect. Returns the number of canonical records loaded.
        """
        try:
            from services.session import instrument_store
            records = await instrument_store.load_instruments(broker=broker)
        except Exception as exc:  # noqa: BLE001 - defensive
            _log.warning("canonical store reload failed: %s", exc)
            return 0
        now = time.time()
        changed = False
        with self._lock:
            for rec in records or []:
                seg = str(rec.get("exchange_segment") or "")
                tok = str(rec.get("instrument_token") or "")
                if not seg or not tok:
                    continue
                key = (seg, tok)
                runtime = self._subs.get(key)
                seed = {
                    "instrument_token": tok,
                    "exchange_segment": seg,
                    "symbol": rec.get("symbol") or "",
                    "trading_symbol": rec.get("trading_symbol") or "",
                    "is_index": bool(rec.get("is_index", False)),
                    "is_depth": bool(rec.get("is_depth", False)),
                    "source": rec.get("source") or "migration",
                    "sources": list(rec.get("sources") or []) or ([rec.get("source")] if rec.get("source") else []),
                    "desired": bool(rec.get("desired", False)),
                    "active": bool(rec.get("active", True)),
                    "advertised": bool(rec.get("advertised", False)),
                    "expires_at": rec.get("expires_at"),
                    "expiry_type": rec.get("expiry_type"),
                    "expiry_label": rec.get("expiry_label"),
                    "feed_level": self._sanitize_feed_level(rec.get("feed_level")),
                    "market_data": rec.get("market_data"),
                    "required_fields": list(rec.get("required_fields") or []),
                    "routing_targets": list(rec.get("routing_targets") or []),
                    "connection_targets": list(rec.get("connection_targets") or []),
                    "broker": rec.get("broker") or (self._mode or "kotak").lower(),
                    "created_at": rec.get("created_at") or now,
                    "last_update_at": rec.get("last_update_at"),
                    "error": rec.get("error"),
                }
                rec2 = self._subs_record(key, seed)
                if runtime is None:
                    changed = True
                # Restore durable facets (pin+desired are canonical; acks are
                # runtime and intentionally left False until re-acked).
                rec2["desired"] = bool(rec.get("desired", False))
                rec2["active"] = bool(rec.get("active", True))
                if isinstance(rec.get("pinned"), dict) and rec.get("pinned"):
                    rec2["pin"] = dict(rec.get("pinned"))
                elif rec.get("pinned") is False:
                    rec2["pin"] = None
                rec2["feed_level"] = self._sanitize_feed_level(rec.get("feed_level"))
                if not rec2["feed_level"] and not rec2.get("market_data"):
                    rec2["feed_level"] = DEFAULT_FEED_LEVEL
                rec2["required_fields"] = list(rec.get("required_fields") or [])
                rec2["expires_at"] = rec.get("expires_at")
                rec2["expiry_type"] = rec.get("expiry_type")
                rec2["expiry_label"] = rec.get("expiry_label")
                rec2["last_update_at"] = rec.get("last_update_at") or now
                if rec2.get("state") != NOT_SUBSCRIBED:
                    changed = True
                    rec2["state"] = NOT_SUBSCRIBED
            for rec in self._subs.values():
                state = self._recompute_sub_state(rec, now)
                rec["state"] = state
        if changed:
            self._bump_subs("canonical store reloaded")
        return len(records or [])

    async def upsert_instrument(self, data: dict, source: Optional[str] = None) -> dict[str, Any]:
        """Create or MERGE one canonical instrument record (single source of
        truth — callers may never create a second record for the same key)."""
        key = self._row_key_from_data(data)
        if not key[1]:
            raise ValueError("instrument_token required")
        if source and isinstance(data, dict) and not data.get("source"):
            data = {**data, "source": source}
        with self._lock:
            now = time.time()
            rec = self._subs_record(key, dict(data))
            broker = str(data.get("broker") or rec.get("broker") or self._mode or "kotak").lower()
            rec["broker"] = broker
            rec["active"] = bool(data.get("active", rec.get("active", True)))
            rec["advertised"] = bool(data.get("advertised", rec.get("advertised", False)))
            if data.get("symbol"):
                rec["symbol"] = data["symbol"]
                rec["trading_symbol"] = data.get("trading_symbol") or rec["symbol"]
            if data.get("trading_symbol"):
                rec["trading_symbol"] = data["trading_symbol"]
            rec["is_index"] = bool(data.get("is_index", rec.get("is_index", False)))
            rec["is_depth"] = bool(data.get("is_depth", rec.get("is_depth", False)))
            source = data.get("source")
            if source:
                rec["source"] = source
                srcs = list(rec.get("sources") or [])
                if source not in srcs:
                    srcs.append(source)
                rec["sources"] = srcs
            level = self._sanitize_feed_level(data.get("feed_level"))
            if level:
                rec["feed_level"] = level
                rec["market_data"] = FEED_LEVEL_TO_TIER.get(level, rec.get("market_data"))
            elif data.get("market_data"):
                tier = str(data.get("market_data")).upper()
                if tier in MARKET_DATA_TIERS:
                    rec["market_data"] = tier
                    rec["feed_level"] = TIER_TO_FEED_LEVEL.get(tier)
            if data.get("required_fields") is not None:
                rec["required_fields"] = list(data["required_fields"] or [])
            if data.get("routing_targets") is not None:
                rec["routing_targets"] = list(data["routing_targets"] or [])
            if data.get("connection_targets") is not None:
                rec["connection_targets"] = list(data["connection_targets"] or [])
            changed = self._merge_expiry(rec, data)
            # Default intent for a new record: desired & subscribable.
            if data.get("desired") is not None:
                if bool(rec.get("desired")) != bool(data["desired"]):
                    changed = True
                rec["desired"] = bool(data["desired"])
            elif not rec.get("expires_at") or now < float(rec["expires_at"]):
                if not rec.get("desired") and rec.get("active") is not False:
                    changed = True
                    rec["desired"] = True
            rec["updated_at"] = now
            state = self._recompute_sub_state(rec, now)
            if rec.get("state") != state:
                changed = True
                rec["state"] = state
            revision = self._subs_revision
        if changed:
            revision = self._bump_subs(f"upsert instrument {key[0]}|{key[1]}")
        await self._persist_record(key, "SESSION_INSTRUMENT_UPSERTED",
                                   {"message": f"upsert {key[0]}|{key[1]}"})
        if changed:
            self._publish_engine_event("SESSION_INSTRUMENT_UPDATED", {
                "kind": "upsert",
                "instrument_key": f"{key[0]}|{key[1]}",
                "status": self.canonical_status(rec),
                "revision": revision,
            })
        self._run_coro_safe(self._notify_engine_lazily)
        return self._canonical_read_row(key)

    async def _notify_engine_lazily(self) -> None:
        try:
            from core.event_loop import get_loop
        except Exception:
            return
        try:
            from ws_socket.engine import engine as ws_engine  # noqa: F401
        except Exception:
            return

    def _canonical_read_row(self, key: tuple[str, str]) -> dict[str, Any]:
        """Safe canonical read row for ONE instrument (used by the API)."""
        with self._lock:
            rec = self._subs.get(key)
            if rec is None:
                return {"ok": False, "error": "instrument not found"}
            now = time.time()
            row = {
                "instrument_id": self._canonical_id(key),
                "broker": rec.get("broker") or (self._mode or "kotak").lower(),
                "exchange_segment": rec.get("exchange_segment") or key[0],
                "instrument_token": rec.get("instrument_token") or key[1],
                "instrument_key": f"{key[0]}|{key[1]}",
                "symbol": rec.get("symbol") or rec.get("trading_symbol") or "",
                "trading_symbol": rec.get("trading_symbol") or rec.get("symbol") or "",
                "is_index": bool(rec.get("is_index", False)),
                "is_depth": bool(rec.get("is_depth", False)),
                "source": rec.get("source"),
                "sources": list(rec.get("sources") or []),
                "subscribers": self._subscribers(rec),
                "subscriberCount": len(self._subscribers(rec)),
                "desired": bool(rec.get("desired", False)),
                "active": bool(rec.get("active", True)),
                "advertised": bool(rec.get("advertised", False)),
                "archived": bool(rec.get("archived", False)),
                "subscribed": bool(rec.get("subscribed", False)),
                "state": rec.get("state"),
                "subscription_state": rec.get("state"),
                "status": self.canonical_status(rec, now),
                "pin": dict(rec["pin"]) if isinstance(rec.get("pin"), dict) else None,
                "expires_at": _iso(rec.get("expires_at")) if rec.get("expires_at") else None,
                "expiry_type": rec.get("expiry_type"),
                "expiry_label": rec.get("expiry_label"),
                "feed_level": rec.get("feed_level"),
                "market_data": rec.get("market_data"),
                "routing": {"state": rec.get("routing") or self._subs_routing,
                            "owner": rec.get("routing_owner") or self._subs_routing_owner},
                "routing_targets": list(rec.get("routing_targets") or []),
                "connection_targets": list(rec.get("connection_targets") or []),
                "required_fields": list(rec.get("required_fields") or []),
                "error": rec.get("error"),
                "error_at": _iso(rec.get("error_at")) if rec.get("error_at") else None,
                "last_update_at": _iso(rec.get("last_update_at")),
                "last_tick_at": _iso(rec.get("last_tick_at")) if rec.get("last_tick_at") else None,
                "revision": self._subs_revision,
            }
            row["ok"] = True
            return row

    def _canonical_id(self, key: tuple[str, str]) -> str:
        with self._lock:
            rec = self._subs.get(key)
            broker = (rec or {}).get("broker") or (self._mode or "kotak").lower()
        return f"{broker}|{key[0]}|{key[1]}"

    def _row_context(self, row: dict) -> Optional[tuple[tuple[str, str], dict[str, Any]]]:
        """Return ``(key, rec)`` for a normalized row or None."""
        key = self._row_key_from_data(row)
        if not key[1]:
            return None
        with self._lock:
            rec = self._subs.get(key)
        return (key, rec)

    async def subscribe_instrument(self, row: dict, source: str = "manual") -> dict[str, Any]:
        """Mark an instrument as a DESIRED subscribe request.

        The broker ack (engine) later flips ``subscribed`` via
        :meth:`mark_broker_subscribed`. Keep ``desired=True`` and
        ``sub_requested=True`` until either an ack or an explicit cancel.
        """
        key = self._row_key_from_data(row)
        if not key[1]:
            raise ValueError("instrument_token required")
        created = key not in self._subs
        with self._lock:
            now = time.time()
            rec = self._subs_record(key, dict(row), )
            changed = False
            if not rec.get("desired"):
                rec["desired"] = True
                changed = True
            if not rec.get("active"):
                rec["active"] = True
                changed = True
            if not rec.get("sub_requested"):
                rec["sub_requested"] = True
                changed = True
            if rec.get("unsub_requested"):
                rec["unsub_requested"] = False
                changed = True
            if rec.get("error"):
                rec["error"] = None
                rec["error_at"] = None
                changed = True
            if row.get("source"):
                rec["source"] = row["source"]
            rec["updated_at"] = now
            revision = self._subs_revision
        if changed:
            revision = self._bump_subs(f"subscribe request {key[0]}|{key[1]}")
        await self._persist_record(key, "SESSION_INSTRUMENT_SUBSCRIBE_REQUESTED",
                                   {"message": f"subscribe {key[0]}|{key[1]}",
                                    "source": source})
        self._publish_engine_event("SUBSCRIPTION_UPDATED", {
            "kind": "subscribe_requested",
            "instrument_key": f"{key[0]}|{key[1]}",
            "revision": revision,
        })
        self._publish_domain_event("STOCK_ADDED" if created else "STOCK_UPDATED",
                                   rec, source=source, revision=revision)
        self._publish_domain_event("SUBSCRIPTION_ADDED", rec, source=source,
                                   revision=revision)
        return self._canonical_read_row(key)

    async def unsubscribe_instrument(self, row: dict, source: str = "manual") -> dict[str, Any]:
        """Remove the feed DESIRE for an instrument (pin consumers are honored).

        Stays catalogued (active unchanged); the engine stops sending it unless
        a pin still requires it. Status -> UNSUBSCRIBE_REQUESTED while the ack
        is pending, then UNSUBSCRIBED once the broker stops sending.
        """
        key = self._row_key_from_data(row)
        if not key[1]:
            raise ValueError("instrument_token required")
        with self._lock:
            now = time.time()
            rec = self._subs.get(key)
            if rec is None:
                rec = self._subs_record(key, dict(row), )
            changed = False
            if rec.get("desired"):
                rec["desired"] = False
                changed = True
            if not rec.get("unsub_requested"):
                rec["unsub_requested"] = True
                changed = True
            if rec.get("sub_requested"):
                rec["sub_requested"] = False
                changed = True
            rec["updated_at"] = now
            revision = self._subs_revision
        if changed:
            revision = self._bump_subs(f"unsubscribe request {key[0]}|{key[1]}")
        await self._persist_record(key, "SESSION_INSTRUMENT_UNSUBSCRIBE_REQUESTED",
                                   {"message": f"unsubscribe {key[0]}|{key[1]}",
                                    "source": source})
        self._publish_engine_event("SUBSCRIPTION_UPDATED", {
            "kind": "unsubscribe_requested",
            "instrument_key": f"{key[0]}|{key[1]}",
            "revision": revision,
        })
        self._publish_domain_event("SUBSCRIPTION_REMOVED", rec, source=source,
                                   revision=revision)
        return self._canonical_read_row(key)

    async def pin_instrument(self, row: dict, *, source: str = "manual", priority: int = 1,
                             profile_id: str = "PINNED_HIGH", consumers: Optional[list] = None,
                             reason: str = "", expires_at: Optional[float] = None) -> dict[str, Any]:
        """Pin an instrument (a durable high-priority feed intent)."""
        key = self._row_key_from_data(row)
        if not key[1]:
            raise ValueError("instrument_token required")
        pin = {
            "source": source,
            "priority": int(priority or 1),
            "profile_id": profile_id or "PINNED_HIGH",
            "consumers": list(consumers or []),
            "reason": reason or "",
            "expires_at": expires_at,
            "symbol": row.get("symbol", ""),
        }
        with self._lock:
            now = time.time()
            rec = self._subs_record(key, dict(row), )
            changed = False
            if rec.get("pin") != pin:
                rec["pin"] = dict(pin)
                changed = True
            if not rec.get("desired"):
                rec["desired"] = True
                changed = True
            if not rec.get("active"):
                rec["active"] = True
                changed = True
            rec["updated_at"] = now
            revision = self._subs_revision
        if changed:
            revision = self._bump_subs(f"pin intent {key[0]}|{key[1]}")
        await self._persist_record(key, "SESSION_INSTRUMENT_PINNED",
                                   {"message": f"pin {key[0]}|{key[1]}", "source": source})
        self._publish_engine_event("SUBSCRIPTION_UPDATED", {
            "kind": "pinned", "instrument_key": f"{key[0]}|{key[1]}", "revision": revision,
        })
        return self._canonical_read_row(key)

    async def unpin_instrument(self, row: dict, source: str = "manual") -> dict[str, Any]:
        """Remove a pin. Other consumers keep their own intent (never unsub)."""
        key = self._row_key_from_data(row)
        if not key[1]:
            raise ValueError("instrument_token required")
        with self._lock:
            now = time.time()
            rec = self._subs.get(key)
            changed = False
            if rec is not None and rec.get("pin") is not None:
                rec["pin"] = None
                changed = True
                rec["updated_at"] = now
            revision = self._subs_revision
        if changed:
            revision = self._bump_subs(f"pin removed {key[0]}|{key[1]}")
        if rec is not None:
            await self._persist_record(key, "SESSION_INSTRUMENT_UNPINNED",
                                       {"message": f"unpin {key[0]}|{key[1]}", "source": source})
            self._publish_engine_event("SUBSCRIPTION_UPDATED", {
                "kind": "unpinned", "instrument_key": f"{key[0]}|{key[1]}", "revision": revision,
            })
            return self._canonical_read_row(key)
        raise KeyError("instrument not found")

    async def activate_instrument(self, row: dict, source: str = "manual") -> dict[str, Any]:
        """Re-activate a deactivated instrument (restores desire unless expired)."""
        key = self._row_key_from_data(row)
        if not key[1]:
            raise ValueError("instrument_token required")
        with self._lock:
            now = time.time()
            rec = self._subs_record(key, dict(row), )
            changed = False
            if not rec.get("active"):
                rec["active"] = True
                changed = True
            rec["advertised"] = False
            if not rec.get("desired") and not rec.get("expires_at"):
                rec["desired"] = True
                changed = True
            if rec.get("error"):
                rec["error"] = None
                rec["error_at"] = None
                changed = True
            if rec.get("archived"):
                rec["archived"] = False
                changed = True
            rec["updated_at"] = now
            revision = self._subs_revision
        if changed:
            revision = self._bump_subs(f"activate {key[0]}|{key[1]}")
        await self._persist_record(key, "SESSION_INSTRUMENT_ACTIVATED",
                                   {"message": f"activate {key[0]}|{key[1]}", "source": source})
        self._publish_engine_event("SUBSCRIPTION_UPDATED", {
            "kind": "activated", "instrument_key": f"{key[0]}|{key[1]}", "revision": revision,
        })
        self._publish_domain_event("SUBSCRIPTION_ACTIVATED", rec, source=source,
                                   revision=revision)
        return self._canonical_read_row(key)

    async def deactivate_instrument(self, row: dict, source: str = "manual") -> dict[str, Any]:
        """Deactivate an instrument: removes it from the desired set and drops
        the pin so the engine stops feeding it (Status -> INACTIVE)."""
        key = self._row_key_from_data(row)
        if not key[1]:
            raise ValueError("instrument_token required")
        with self._lock:
            now = time.time()
            rec = self._subs.get(key)
            if rec is None:
                rec = self._subs_record(key, dict(row), )
            changed = False
            if rec.get("active") is not False:
                rec["active"] = False
                changed = True
            if rec.get("desired"):
                rec["desired"] = False
                changed = True
            if rec.get("pin") is not None:
                rec["pin"] = None
                changed = True
            if rec.get("unsub_requested") is not True:
                rec["unsub_requested"] = True
                changed = True
            if rec.get("sub_requested"):
                rec["sub_requested"] = False
                changed = True
            rec["updated_at"] = now
            revision = self._subs_revision
        if changed:
            revision = self._bump_subs(f"deactivate {key[0]}|{key[1]}")
        await self._persist_record(key, "SESSION_INSTRUMENT_DEACTIVATED",
                                   {"message": f"deactivate {key[0]}|{key[1]}", "source": source})
        self._publish_engine_event("SUBSCRIPTION_UPDATED", {
            "kind": "deactivated", "instrument_key": f"{key[0]}|{key[1]}", "revision": revision,
        })
        self._publish_domain_event("SUBSCRIPTION_DEACTIVATED", rec, source=source,
                                   revision=revision)
        return self._canonical_read_row(key)

    async def set_instrument_expiry(self, row: dict, *, expires_at: float, expiry_type: str = "DURATION",
                                    label: Optional[str] = None, source: str = "manual") -> dict[str, Any]:
        """Set a REAL expiry instant on an instrument (never fabricated)."""
        key = self._row_key_from_data(row)
        if not key[1]:
            raise ValueError("instrument_token required")
        expiry_value = float(expires_at)
        if expiry_value <= 0:
            raise ValueError("expires_at must be a positive epoch")
        if expiry_type.upper() not in EXPIRY_TYPES:
            raise ValueError(f"expiry_type must be one of {EXPIRY_TYPES}")
        with self._lock:
            now = time.time()
            rec = self._subs_record(key, dict(row), )
            changed = False
            if rec.get("expires_at") != expiry_value:
                rec["expires_at"] = expiry_value
                changed = True
            if rec.get("expiry_type") != expiry_type.upper():
                rec["expiry_type"] = expiry_type.upper()
                changed = True
            if label and rec.get("expiry_label") != label:
                rec["expiry_label"] = label
                changed = True
            rec["updated_at"] = now
            revision = self._subs_revision
        if changed:
            revision = self._bump_subs(f"expiry set {key[0]}|{key[1]}")
        await self._persist_record(key, "SESSION_INSTRUMENT_EXPIRY_SET",
                                   {"message": f"expiry set {key[0]}|{key[1]}", "source": source})
        self._publish_engine_event("SESSION_INSTRUMENT_EXPIRY_SET", {
            "kind": "expiry_set", "instrument_key": f"{key[0]}|{key[1]}", "revision": revision,
        })
        return self._canonical_read_row(key)

    async def remove_instrument(self, row: dict, *, purge: bool = False, source: str = "manual") -> dict[str, Any]:
        """Archive (default) or hard-purge a canonical instrument.

        Archive keeps history and surfaces status INACTIVE; purge physically
        deletes the Mongo record and the in-memory entry.
        """
        key = self._row_key_from_data(row)
        if not key[1]:
            raise ValueError("instrument_token required")
        with self._lock:
            rec = self._subs.get(key)
            if rec is not None:
                rec["desired"] = False
                rec["active"] = False
                rec["subscribed"] = False
                rec["pin"] = None
                rec["unsub_requested"] = True
                rec["sub_requested"] = False
                rec["archived"] = True
                rec["updated_at"] = time.time()
            revision = self._bump_subs(f"remove instrument {key[0]}|{key[1]}")
        if purge:
            if rec is not None:
                with self._lock:
                    self._subs.pop(key, None)
            try:
                from services.session import instrument_store
                iid = instrument_store.instrument_id(
                    (rec or {}).get("broker") or (self._mode or "kotak").lower(), key[0], key[1])
                await instrument_store.delete_instrument(iid=iid)
            except Exception:  # noqa: BLE001
                _log.debug("canonical purge failed (%s)", key, exc_info=True)
        elif rec is not None:
            await self._persist_record(key, "SESSION_INSTRUMENT_REMOVED",
                                       {"message": f"removed {key[0]}|{key[1]}", "source": source})
        self._publish_engine_event("SUBSCRIPTION_UPDATED", {
            "kind": "removed", "instrument_key": f"{key[0]}|{key[1]}", "purge": bool(purge),
            "revision": revision,
        })
        self._publish_domain_event("STOCK_REMOVED", rec, purge=bool(purge),
                                   source=source, revision=revision)
        if rec is None:
            return {"ok": True, "removed": False, "purge": bool(purge)}
        return self._canonical_read_row(key)

    async def mark_instrument_error(self, row: dict, message: str = "", source: str = "manual") -> dict[str, Any]:
        """Record an explicit instrument error (broker reject etc.)."""
        key = self._row_key_from_data(row)
        if not key[1]:
            raise ValueError("instrument_token required")
        with self._lock:
            now = time.time()
            rec = self._subs_record(key, dict(row), )
            rec["error"] = message or "instrument error"
            rec["error_at"] = now
            rec["updated_at"] = now
            revision = self._bump_subs(f"instrument error {key[0]}|{key[1]}")
        await self._persist_record(key, "SESSION_INSTRUMENT_ERROR",
                                   {"message": message or "instrument error", "source": source})
        return self._canonical_read_row(key)

    async def clear_instrument_error(self, row: dict, source: str = "manual") -> dict[str, Any]:
        key = self._row_key_from_data(row)
        if not key[1]:
            raise ValueError("instrument_token required")
        with self._lock:
            rec = self._subs.get(key)
            if rec is not None and (rec.get("error") or rec.get("error_at")):
                rec["error"] = None
                rec["error_at"] = None
                rec["updated_at"] = time.time()
            revision = self._subs_revision
        if rec is not None:
            await self._persist_record(key, "SESSION_INSTRUMENT_ERROR_CLEARED",
                                       {"message": f"error cleared {key[0]}|{key[1]}", "source": source})
            return self._canonical_read_row(key)
        raise KeyError("instrument not found")

    async def track_instrument(self, row: dict, source: str = "manual") -> dict[str, Any]:
        """Best-effort canonical tracking from user-facing flows.

        Merges the row (idempotent by key, never duplicates), then requests a
        subscription so the WebSocket Engine actually serves feed for it. Kept
        honest: no fake expiries, no guessed status — state derives from real
        broker/feed confirmation.
        """
        result = await self.upsert_instrument(row, source=source)
        key = self._row_key(row)
        if not key[1]:
            return result
        sub = await self.subscribe_instrument(row, source=source)
        merged = dict(result or {})
        merged.update({"subscribed": bool(sub.get("subscribed")), "status": sub.get("status")})
        return merged

    def update_routing_metadata(self, rows: list[dict]) -> None:
        """Mirror engine-side routing/fields/feed intent onto canonical rows."""
        changed = False
        with self._lock:
            now = time.time()
            for row in rows or []:
                key = self._row_key(row)
                if not key[1]:
                    continue
                rec = self._subs.get(key)
                if rec is None:
                    rec = self._subs_record(key, row)
                if row.get("required_fields") is not None and list(rec.get("required_fields") or []) != list(row["required_fields"]):
                    rec["required_fields"] = list(row["required_fields"])
                    changed = True
                targets = list(row.get("routing_targets") or [])
                if list(rec.get("routing_targets") or []) != targets:
                    rec["routing_targets"] = targets
                    changed = True
                ct = list(row.get("connection_targets") or [])
                if list(rec.get("connection_targets") or []) != ct:
                    rec["connection_targets"] = ct
                    changed = True
                level = self._sanitize_feed_level(row.get("feed_level"))
                if level and rec.get("feed_level") != level:
                    rec["feed_level"] = level
                    rec["market_data"] = FEED_LEVEL_TO_TIER.get(level)
                    changed = True
                rec["updated_at"] = now
        if changed:
            self._bump_subs("routing metadata updated")
            self._publish_engine_event("SUBSCRIPTION_UPDATED", {
                "kind": "routing_metadata", "revision": self._subs_revision,
            })

    async def reconcile(self, now_ts: Optional[float] = None) -> dict[str, Any]:
        """Enforce every real expiry + finalize pending requests.

        Sweeps the canonical set:
        - EXPIRING -> EXPIRED when the wall clock passes ``expires_at``
          (desired cleared, engine notified to unsubscribe via SUBSCRIPTION_UPDATED).
        - request flags that are clearly stale are normalized.

        Returns a report of what actually changed. Never fabricates expiries.
        """
        now = now_ts if now_ts is not None else time.time()
        expired_keys: list[tuple[str, str]] = []
        cleared_keys: list[tuple[str, str]] = []
        changed = False
        with self._lock:
            for key, rec in list(self._subs.items()):
                expires_at = rec.get("expires_at")
                state = self._recompute_sub_state(rec, now)
                if (expires_at is not None and now >= float(expires_at)
                        and rec.get("state") != EXPIRED):
                    rec["desired"] = False
                    rec["subscribed"] = False
                    rec["unsub_requested"] = True
                    rec["sub_requested"] = False
                    rec["state"] = EXPIRED
                    rec["updated_at"] = now
                    expired_keys.append(key)
                    changed = True
                elif rec.get("sub_requested") and not rec.get("desired"):
                    rec["sub_requested"] = False
                    changed = True
                elif rec.get("unsub_requested") and rec.get("sub_requested"):
                    rec["unsub_requested"] = False
                    changed = True
                elif state != rec.get("state"):
                    rec["state"] = state
                    changed = True
            if changed:
                self._subs_revision += 1
                self._subs_last_updated = now
                revision = self._subs_revision
            else:
                revision = self._subs_revision
        for key in expired_keys:
            await self._persist_record(key, "SESSION_INSTRUMENT_EXPIRED",
                                       {"message": f"expired {key[0]}|{key[1]}"})
        if changed:
            self._stamp("SUBSCRIPTIONS_UPDATED", f"reconcile expired={len(expired_keys)}",
                        {"revision": revision})
            self._publish_engine_event("SUBSCRIPTION_UPDATED", {
                "kind": "reconcile", "expired": len(expired_keys), "revision": revision,
            })
        return {
            "ok": True,
            "timestamp": _now_iso(),
            "revision": revision,
            "expired_now": [f"{k[0]}|{k[1]}" for k in expired_keys],
            "request_normalized": len(cleared_keys),
            "changed": bool(changed),
            "counts": self.subscription_counts(),
        }

    # ---- connections / revision application --------------------------
    def mark_connection_connected(self, connection_id: str = DEFAULT_CONNECTION, *,
                                  broker: Optional[str] = None,
                                  feed_level: Optional[int] = None) -> None:
        with self._lock:
            rec = self._subs_connections.setdefault(connection_id, {
                "connection_id": connection_id,
                "broker": broker,
                "state": "CONNECTED",
                "connected_at": time.time(),
                "disconnected_at": None,
                "feed_level": self._sanitize_feed_level(feed_level),
                "last_applied_revision": self._subs_applied_revisions.get(connection_id, 0),
                "last_heartbeat": time.time(),
            })
            rec["state"] = "CONNECTED"
            rec["connected_at"] = time.time()
            rec["disconnected_at"] = None
            rec["last_heartbeat"] = time.time()
            if broker:
                rec["broker"] = broker
            level = self._sanitize_feed_level(feed_level)
            if level:
                rec["feed_level"] = level
            self._subs_applied_revisions.setdefault(connection_id, 0)

    def mark_connection_disconnected(self, connection_id: str = DEFAULT_CONNECTION, *,
                                     reason: str = "") -> None:
        with self._lock:
            rec = self._subs_connections.setdefault(connection_id, {
                "connection_id": connection_id,
                "state": "DISCONNECTED",
                "connected_at": None,
                "disconnected_at": time.time(),
                "reconnect_count": 0,
                "last_applied_revision": self._subs_applied_revisions.get(connection_id, 0),
                "last_heartbeat": time.time(),
            })
            rec["state"] = "DISCONNECTED"
            rec["disconnected_at"] = time.time()
            rec["reason"] = reason or rec.get("reason", "")
            rec["reconnect_count"] = int(rec.get("reconnect_count", 0)) + 1

    def mark_revision_applied(self, revision: int, connection_id: str = DEFAULT_CONNECTION) -> None:
        """Record that ``connection_id`` applied a session-manager revision."""
        with self._lock:
            self._subs_applied_revisions[connection_id] = int(revision)
            rec = self._subs_connections.get(connection_id)
            if rec is not None:
                rec["last_applied_revision"] = int(revision)
                rec["last_heartbeat"] = time.time()

    def revision_status(self) -> dict[str, Any]:
        with self._lock:
            desired = self._subs_revision
            applied = dict(self._subs_applied_revisions)
            lag = {
                cid: max(0, desired - (int(rev) if rev is not None else 0))
                for cid, rev in applied.items()
            }
        return {
            "desired": desired,
            "applied_by_connection": applied,
            "lag": lag,
            "fully_applied": bool(applied) and all(v >= desired for v in lag.values()) or not self._subs_connections,
        }

    def connections_snapshot(self) -> list[dict[str, Any]]:
        with self._lock:
            now = time.time()
            out = []
            for cid, rec in self._subs_connections.items():
                applied = self._subs_applied_revisions.get(cid, 0)
                out.append({
                    "connection_id": cid,
                    "broker": rec.get("broker"),
                    "state": rec.get("state", "UNKNOWN"),
                    "connected_at": _iso(rec.get("connected_at")),
                    "disconnected_at": _iso(rec.get("disconnected_at")),
                    "reason": rec.get("reason"),
                    "reconnect_count": int(rec.get("reconnect_count", 0)),
                    "feed_level": rec.get("feed_level"),
                    "last_applied_revision": applied,
                    "last_heartbeat": _iso(rec.get("last_heartbeat")),
                })
            applied_default = int(self._subs_applied_revisions.get(DEFAULT_CONNECTION, 0))
        if out:
            return out
        # Boot-fallback: the ws engine mirror only registers feed links on its
        # routing sync (market window / owner up). Before that the registry is
        # empty — surface the REAL owner feed link derived from the live
        # session snapshot instead, so the page always shows concrete state.
        # Every field below is genuine live state; nothing is fabricated.
        try:
            snap = self.snapshot()
            ws = snap.get("websocket") or {}
            live = str(ws.get("state") or "").upper() == "CONNECTED"
            reason = None if live else (str(ws.get("disconnectReason") or "").strip() or snap.get("stateMessage") or None)
            return [{
                "connection_id": DEFAULT_CONNECTION,
                "broker": snap.get("broker"),
                "state": "CONNECTED" if live else "DISCONNECTED",
                "connected_at": ws.get("connectedAt") if live else None,
                "disconnected_at": None if live else ws.get("disconnectedAt"),
                "reason": reason,
                "reconnect_count": int(ws.get("reconnectCount") or 0),
                "feed_level": None,
                "last_applied_revision": applied_default,
                "last_heartbeat": ws.get("lastMessageAt") or ws.get("disconnectedAt") or None,
                "derived_from": "session_snapshot",
            }]
        except Exception:  # noqa: BLE001 - never fail the read side
            return out

    def phase3_health(self) -> dict[str, Any]:
        """Honest health: session active + engine reachable + no intent/apply
        drift + no abnormal expiry backlog."""
        try:
            sub = self.subscription_snapshot()
            counts = sub["counts"]
            applied = self.revision_status()
            state = self._state
            ws = self._ws_state
            conns = self.connections_snapshot()
            any_connected = any(c.get("state") == "CONNECTED" for c in conns)
            drift = any(v > 0 for v in applied["lag"].values())
            ok = (
                self.is_active()
                and counts.get("desired", 0) >= 0
                and not drift
            )
            reasons = []
            if not self.is_active():
                reasons.append("no active session")
            if not any_connected and counts.get("desired", 0):
                reasons.append("feed connection down")
            if drift:
                reasons.append("revision drift (intent not applied)")
            if ws != "CONNECTED" and self.is_active():
                reasons.append(f"websocket state={ws}")
            return {
                "ok": ok,
                "state": state,
                "active": self.is_active(),
                "websocket": ws,
                "connection_connected": any_connected,
                "revision_drift": drift,
                "revision_lag": applied["lag"],
                "reasons": reasons,
            }
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc), "reasons": ["health check failed"]}

    def phase3_snapshot(self) -> dict[str, Any]:
        """Full Phase 3 Session Manager Engine status (Control Center payload).

        Safe (never credentials). Includes the session block, canonical
        instrument rows, per-connection state, revision intent/apply, and a
        real health summary — everything the /services/session-manager page
        renders.
        """
        base = self.snapshot()
        sub = self.subscription_snapshot()
        status_counts: dict[str, int] = {}
        level_counts: dict[str, int] = {}
        for row in sub.get("instruments", []):
            status = row.get("status") or "UNKNOWN"
            status_counts[status] = status_counts.get(status, 0) + 1
            level = f"L{row.get('feed_level')}" if row.get("feed_level") else (row.get("market_data") or "UNSET")
            level_counts[level] = level_counts.get(level, 0) + 1
        rev_status = self.revision_status()
        return {
            "engineVersion": "2.2.0",
            "name": "Session Manager",
            "id": "session_manager",
            "status": base.get("status"),
            "lifecycleState": base.get("lifecycleState"),
            "active": base.get("active"),
            "mode": base.get("mode"),
            "broker": base.get("broker"),
            "userId": base.get("userId"),
            "loginSource": base.get("loginSource"),
            "loginTime": base.get("loginTime"),
            "expiresAt": base.get("expiresAt"),
            "remainingSeconds": base.get("remainingSeconds"),
            "websocket": base.get("websocket"),
            "sessionRouting": base.get("sessionRouting"),
            "revision": sub.get("revision"),
            "lastUpdatedAt": sub.get("last_updated_at"),
            "counts": sub.get("counts"),
            "statusCounts": status_counts,
            "feedLevelCounts": level_counts,
            "instruments": sub.get("instruments"),
            "routing": sub.get("routing"),
            "connections": self.connections_snapshot(),
            "revisionApply": rev_status,
            "health": self.phase3_health(),
        }

    # ---- read side ----------------------------------------------------
    def subscription_desired_keys(self) -> list[dict]:
        """Authoritative DESIRED broker token set the engine must subscribe.

        Never includes EXPIRED / INACTIVE instruments. Returns normalised
        ``{instrument_token, exchange_segment, symbol, isIndex, isDepth,
        feedLevel, marketData}`` rows so the WebSocket manager routes each
        token to the correct feed family (scrips vs index vs depth).
        """
        out: list[dict] = []
        with self._lock:
            now = time.time()
            for key, rec in self._subs.items():
                if not rec.get("desired"):
                    continue
                state = self._recompute_sub_state(rec, now)
                if state in SUB_BLOCKED_STATES:
                    continue
                out.append({
                    "instrument_token": rec.get("instrument_token") or key[1],
                    "exchange_segment": rec.get("exchange_segment") or key[0],
                    "symbol": (rec.get("symbol") or rec.get("trading_symbol") or ""),
                    "isIndex": bool(rec.get("is_index", False)),
                    "isDepth": bool(rec.get("is_depth", False)),
                    "feedLevel": rec.get("feed_level"),
                    "marketData": rec.get("market_data"),
                })
        return out

    def subscription_desired_keys_by_row(self) -> list[dict]:
        """Like :meth:`subscription_desired_keys` but with full record detail
        plus the computed state (drives delta decisions in the engine)."""
        out: list[dict] = []
        with self._lock:
            now = time.time()
            for key, rec in self._subs.items():
                if not rec.get("desired"):
                    continue
                state = self._recompute_sub_state(rec, now)
                if state in SUB_BLOCKED_STATES:
                    continue
                row = dict(rec)
                row["state"] = state
                out.append(row)
        return out

    def is_subscription_desired(self, row: dict) -> bool:
        key = self._row_key(row)
        with self._lock:
            rec = self._subs.get(key)
            if rec is None:
                return False
            return bool(rec.get("desired")) and self._recompute_sub_state(rec, time.time()) not in SUB_BLOCKED_STATES

    def subscription_counts(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        with self._lock:
            now = time.time()
            for rec in self._subs.values():
                state = rec.get("state")
                if state is None:
                    state = self._recompute_sub_state(rec, now)
                counts[state] = counts.get(state, 0) + 1
            revision = self._subs_revision
            last_updated = self._subs_last_updated
            routing = self._subs_routing
            routing_owner = self._subs_routing_owner
        return {
            "total": sum(counts.values()),
            "subscribed": counts.get(SUBSCRIBED, 0) + counts.get(SUBSCRIBED_PINNED, 0),
            "pinned": counts.get(PINNED, 0) + counts.get(SUBSCRIBED_PINNED, 0),
            "pinned_only": counts.get(PINNED, 0),
            "not_subscribed": counts.get(NOT_SUBSCRIBED, 0),
            "expired": counts.get(EXPIRED, 0),
            "inactive": counts.get(INACTIVE, 0),
            "desired": sum(1 for r in self._subs.values() if r.get("desired")),
            "revision": revision,
            "last_updated_at": _iso(last_updated),
            "routing": {"state": routing, "owner": routing_owner},
        }

    def subscription_snapshot(self) -> dict[str, Any]:
        """Canonical, safe subscription-state snapshot (never credentials)."""
        now = time.time()
        cached = self._subs_snapshot_cache
        if (
            cached is not None
            and self._subs_snapshot_cache_rev == self._subs_revision
            and now - self._subs_snapshot_at < self._SUBS_SNAPSHOT_TTL_S
        ):
            return cached
        instruments: list[dict[str, Any]] = []
        with self._lock:
            now = time.time()
            routing = self._subs_routing
            routing_owner = self._subs_routing_owner
            revision = self._subs_revision
            last_updated = self._subs_last_updated
            for key, rec in self._subs.items():
                state = rec.get("state")
                if state is None:
                    state = self._recompute_sub_state(rec, now)
                status = self.canonical_status(rec, now)
                pin = rec.get("pin")
                subscribers = self._subscribers(rec)
                instruments.append({
                    "exchange_segment": rec.get("exchange_segment") or key[0],
                    "instrument_token": rec.get("instrument_token") or key[1],
                    "instrument_key": f"{key[0]}|{key[1]}",
                    "symbol": rec.get("symbol") or rec.get("trading_symbol") or "",
                    "trading_symbol": rec.get("trading_symbol") or rec.get("symbol") or "",
                    "is_index": bool(rec.get("is_index", False)),
                    "is_depth": bool(rec.get("is_depth", False)),
                    "state": state,
                    "subscription_state": state,
                    "status": status,
                    "desired": bool(rec.get("desired", False)),
                    "active": bool(rec.get("active", True)),
                    "advertised": bool(rec.get("advertised", False)),
                    "archived": bool(rec.get("archived", False)),
                    "subscribed": bool(rec.get("subscribed", False)),
                    "source": rec.get("source"),
                    "sources": list(rec.get("sources") or []),
                    "subscribers": subscribers,
                    "subscriberCount": len(subscribers),
                    "broker": rec.get("broker") or (self._mode or "kotak").lower(),
                    "pin": dict(pin) if isinstance(pin, dict) else None,
                    "expires_at": _iso(rec.get("expires_at")) if rec.get("expires_at") else None,
                    "expiry_type": rec.get("expiry_type"),
                    "expiry_label": rec.get("expiry_label"),
                    "feed_level": rec.get("feed_level"),
                    "market_data": rec.get("market_data"),
                    "routing": {
                        "state": (rec.get("routing") or routing),
                        "owner": (rec.get("routing_owner") or routing_owner),
                    },
                    "routing_targets": list(rec.get("routing_targets") or []),
                    "connection_targets": list(rec.get("connection_targets") or []),
                    "required_fields": list(rec.get("required_fields") or []),
                    "error": rec.get("error"),
                    "error_at": _iso(rec.get("error_at")) if rec.get("error_at") else None,
                    "last_update_at": _iso(rec.get("last_update_at")),
                    "last_tick_at": _iso(rec.get("last_tick_at")) if rec.get("last_tick_at") else None,
                })
        payload = {
            "revision": revision,
            "last_updated_at": _iso(last_updated),
            "routing": {"state": routing, "owner": routing_owner},
            "counts": self.subscription_counts(),
            "instruments": instruments,
        }
        self._subs_snapshot_cache = payload
        self._subs_snapshot_cache_rev = revision
        self._subs_snapshot_at = now
        return payload

    def active_registry(self) -> dict[str, dict[str, Any]]:
        """Token -> canonical subscription record for internal consumers.

        Built from the raw registry (``self._subs``) rather than the API-facing
        :meth:`subscription_snapshot`, which converts ``expires_at`` to an ISO
        string and drops ``market_date``. Consumers that classify a tick by
        source and enforce expiry (the DB Writer) need those lossy fields in
        their original form: numeric ``expires_at`` and the day-scope
        ``market_date``. It is a read-only snapshot, never a second registry.

        Memoised on ``subs_revision``: the dict of per-record copies is rebuilt
        only when the subscription registry actually mutates, so a consumer that
        re-reads it on a timer (the DB Writer's TTL safety net) gets an O(1)
        lookup instead of rebuilding ~2.7k records on the event loop. The
        per-tick ``last_tick_at``/``last_update_at`` marks deliberately do NOT
        bump the revision; no consumer of this method reads those fields (the
        DB Writer classifies by source/expiry, the Trade API by active/desired/
        state), so the snapshot stays semantically current.
        """
        with self._lock:
            revision = self._subs_revision
            cache = self._active_registry_cache
            if cache is not None and self._active_registry_cache_rev == revision:
                return cache
            snapshot = {
                str(rec.get("instrument_token") or key[1]): dict(rec)
                for key, rec in self._subs.items()
            }
            self._active_registry_cache = snapshot
            self._active_registry_cache_rev = revision
            return snapshot

    # ------------------------------------------------------------------
    # Aggregate control-center views (real state only, never fabricated)
    # ------------------------------------------------------------------
    def subscriptions_view(self) -> dict[str, Any]:
        """Desired / actual / pending / ACK / failed / expired breakdown."""
        snap = self.subscription_snapshot()
        out = {
            "desired": 0, "subscribed": 0, "pending": 0, "acked": 0,
            "failed": 0, "unsubscribed": 0, "expired": 0,
        }
        for row in snap["instruments"]:
            if bool(row.get("desired")) or bool(row.get("subscribed")):
                out["desired"] += 1
            if bool(row.get("subscribed")):
                out["subscribed"] += 1
                out["acked"] += 1
            state = str(row.get("subscription_state") or "").upper()
            if state in ("SUBSCRIBED",):  # not ACKed yet at broker level
                out["pending"] += 1
            if state in ("FAILED", "ERROR"):
                out["failed"] += 1
            if state in ("UNSUBSCRIBED", "NOT_SUBSCRIBED"):
                out["unsubscribed"] += 1
            if state in ("EXPIRED",):
                out["expired"] += 1
        out["counts"] = snap["counts"]
        out["revision"] = snap["revision"]
        out["rows"] = snap["instruments"]
        return out

    def sources_view(self) -> dict[str, Any]:
        """Source-type rollup — honest counting + real per-source facts.

        Two real views of every canonical row:
        - ``sources``: every origin tag a row carries. A row can carry more
          than one tag, so these counts are NOT additive to ``total``.
        - ``primary``: every row counted EXACTLY ONCE by its primary origin
          (``row.source``) — these share buckets sum to 100% of the registry.

        Each bucket also carries real lifecycle stats (desired / subscribed /
        pinned / expired, index rows) and freshness (latest registry touch) so
        the page never has to guess anything.
        """

        def _new_bucket() -> dict[str, Any]:
            return {
                "count": 0, "desired": 0, "subscribed": 0, "pinned": 0,
                "expired": 0, "indexes": 0, "symbols": [], "last_update_at": None,
            }

        def _bump(b: dict[str, Any], row: dict[str, Any]) -> None:
            b["count"] += 1
            if row.get("desired"):
                b["desired"] += 1
            if row.get("subscribed"):
                b["subscribed"] += 1
            if row.get("pin"):
                b["pinned"] += 1
            if str(row.get("status") or "").upper() == "EXPIRED":
                b["expired"] += 1
            if row.get("is_index"):
                b["indexes"] += 1
            sym = row.get("symbol")
            if sym and len(b["symbols"]) < 50:
                b["symbols"].append(sym)
            lu = row.get("last_update_at")
            if lu and (b["last_update_at"] is None or str(lu) > str(b["last_update_at"])):
                b["last_update_at"] = lu

        snap = self.subscription_snapshot()
        rows = snap["instruments"]
        per_source: dict[str, dict[str, Any]] = {}
        primary: dict[str, dict[str, Any]] = {}
        for row in rows:
            psrc = row.get("source") or "unknown"
            srcs = set(row.get("sources") or [])
            srcs.add(psrc)
            for src in srcs:
                _bump(per_source.setdefault(src, _new_bucket()), row)
            _bump(primary.setdefault(psrc, _new_bucket()), row)
        for bucket_map in (per_source, primary):
            for bucket in bucket_map.values():
                bucket["symbols"] = sorted(set(bucket["symbols"]))
        total = len(rows)
        market_watch_primary = sum(1 for r in rows if str(r.get("source") or "") == "market_watch_daily_universe")
        return {
            "sources": per_source,
            "primary": primary,
            "marketWatchPrimaryCount": market_watch_primary,
            "total": total,
        }

    def pins_view(self) -> dict[str, Any]:
        """Pinned instruments with pin source / time / routing / connection."""
        snap = self.subscription_snapshot()
        pinned: list[dict[str, Any]] = []
        for row in snap["instruments"]:
            pin = row.get("pin") if isinstance(row.get("pin"), dict) else None
            if pin is None:
                continue
            pinned.append({
                "instrument_key": row.get("instrument_key"),
                "symbol": row.get("symbol"),
                "exchange_segment": row.get("exchange_segment"),
                "instrument_token": row.get("instrument_token"),
                "pin_source": pin.get("source"),
                "pin_time": _iso(pin.get("created_at")) if pin.get("created_at") else None,
                "routing": row.get("routing"),
                "connection_targets": row.get("connection_targets") or [],
                "feed_level": row.get("feed_level"),
            })
        return {"pinned": pinned, "count": len(pinned)}

    def expiry_view(self) -> dict[str, Any]:
        """Expiry classification: today / N-day / custom / expiring / expired."""
        snap = self.subscription_snapshot()
        buckets = {
            "today": [], "nday": [], "custom": [], "expiring": [], "expired": [],
            "no_expiry": [],
        }
        now = time.time()
        import datetime as _dt
        today_start = _dt.datetime.combine(
            _dt.datetime.fromtimestamp(now, tz=_dt.timezone.utc).astimezone().date(),
            _dt.datetime.min.time(),
        ).timestamp()
        tomorrow_start = today_start + 86400
        for row in snap["instruments"]:
            status = str(row.get("status") or "").upper()
            expires_at = row.get("expires_at")
            exp_ts = None
            if expires_at:
                try:
                    exp_ts = float(expires_at)
                except Exception:
                    exp_ts = None
            etype = str(row.get("expiry_type") or "").upper()
            if status == "EXPIRED" or (exp_ts and exp_ts <= now):
                buckets["expired"].append(row)
            elif exp_ts and exp_ts < tomorrow_start:
                buckets["today"].append(row)
            elif exp_ts and exp_ts >= tomorrow_start:
                if etype == "CUSTOM":
                    buckets["custom"].append(row)
                else:
                    buckets["nday"].append(row)
            elif status == "EXPIRING":
                buckets["expiring"].append(row)
            else:
                buckets["no_expiry"].append(row)
        return {
            "today": len(buckets["today"]),
            "nday": len(buckets["nday"]),
            "custom": len(buckets["custom"]),
            "expiring": len(buckets["expiring"]),
            "expired": len(buckets["expired"]),
            "no_expiry": len(buckets["no_expiry"]),
            "rows": {
                "today": buckets["today"], "nday": buckets["nday"],
                "custom": buckets["custom"], "expiring": buckets["expiring"],
                "expired": buckets["expired"], "no_expiry": buckets["no_expiry"],
            },
        }

    # ------------------------------------------------------------------
    # REST activity
    # ------------------------------------------------------------------
    def mark_rest_success(self, endpoint: str) -> None:
        with self._lock:
            self._last_rest_success_at = time.time()
            self._last_activity_at = time.time()
            self._last_rest_error = None
        self._stamp("REST_SUCCESS", endpoint)

    def mark_rest_failure(self, endpoint: str, error: Optional[str] = None) -> None:
        with self._lock:
            self._last_rest_failure_at = time.time()
            self._last_rest_error = error
            self._last_activity_at = time.time()
        self._stamp("REST_FAILURE", endpoint)

    # ------------------------------------------------------------------
    # Snapshot (safe; never exposes tokens/credentials)
    # ------------------------------------------------------------------
    # Defense-in-depth (§33): even though this module never stores
    # credentials, raw per-terminal records are projected through an
    # allow-list before any public serialization so a future refactor can
    # never leak a stored secret through the snapshot/API boundary.
    _SAFE_TERMINAL_SESSION_KEYS = (
        "broker_id", "session_id", "session_ref", "user_id",
        "session_status", "login_status", "login_source",
        "created_at", "expires_at", "validated_at",
        "last_activity", "connection_status", "state_message",
        "ws_state", "ws_connected_at", "ws_disconnected_at",
        "ws_last_message_at", "ws_reason",
    )

    def _safe_terminal_sessions(self, records: Optional[dict] = None) -> dict[str, dict]:
        """Project per-terminal session records through the allow-list."""
        out: dict[str, dict] = {}
        for terminal, rec in (records or {}).items():
            if not isinstance(rec, dict):
                continue
            out[str(terminal)] = {
                k: rec.get(k) for k in self._SAFE_TERMINAL_SESSION_KEYS
            }
        return out

    def snapshot(self) -> dict[str, Any]:
        """Authoritative, safe session snapshot consumed by every phase."""
        with self._lock:
            mode = self._mode
            broker = self._broker
            user_id = self._user_id
            session_id = self._session_id
            session_ref = self._session_id_ref
            login_source = self._login_source
            login_at = self._login_at
            expires_at = self._expires_at
            validated_at = self._validated_at
            state = self._state
            state_since = self._state_since
            state_message = self._state_message
            last_activity = self._last_activity_at
            last_ws_event = self._last_ws_event_at
            last_rest_success = self._last_rest_success_at
            last_rest_failure = self._last_rest_failure_at
            last_auth_error = self._last_auth_error
            last_auth_error_at = self._last_auth_error_at
            last_rest_error = self._last_rest_error
            ws_connected = self._ws_connected_at
            ws_disconnected = self._ws_disconnected_at
            ws_last_msg = self._ws_last_message_at
            ws_state = self._ws_state
            ws_reason = self._ws_disconnect_reason
            reconnect = self._reconnect_count
            history = list(self._session_history)
            event_log = list(self._event_log)
            sessions = self._safe_terminal_sessions(self._sessions)

        active = self.is_active()
        remaining = self.remaining_seconds()
        last_logout = history[-1].to_dict() if history else None
        now = time.time()
        # Copy under the lock so a consumer reading this snapshot can never see a
        # half-updated decision set.
        with self._lock:
            margin_decisions = dict(self._margin_decisions)

        return {
            "version": VERSION,
            "status": state,
            "state": state,
            # Published by services/market_watch_margin.py from the broker's own
            # margin API. Read by services/market_watch_eligibility.margin_decision.
            # An absent token means UNKNOWN, never "eligible".
            "marginDecisions": margin_decisions,
            "lifecycleState": session_lifecycle_state(state),
            "stateMessage": state_message,
            "stateSince": _iso(state_since),
            "active": active,
            "mode": mode,
            "broker": broker,
            "userId": user_id,
            "sessionId": session_id,
            "sessionReference": session_ref,
            "loginSource": login_source,
            "loginTime": _iso(login_at),
            "expiresAt": _iso(expires_at),
            "validatedAt": _iso(validated_at),
            "remainingSeconds": round(remaining, 1) if remaining is not None else None,
            "sessionDurationSeconds": self._session_lifetime,
            # internet / market are not owned here; placeholders point to live sources.
            "lastActivityAt": _iso(last_activity),
            "lastWebSocketEventAt": _iso(last_ws_event),
            "lastRestSuccessAt": _iso(last_rest_success),
            "lastRestFailureAt": _iso(last_rest_failure),
            "lastRestError": last_rest_error,
            "lastAuthError": last_auth_error,
            "lastAuthErrorAt": _iso(last_auth_error_at),
            "websocket": {
                "state": ws_state,
                "connected": self._ws_state == "CONNECTED",
                "connectedAt": _iso(ws_connected),
                "disconnectedAt": _iso(ws_disconnected),
                "lastMessageAt": _iso(ws_last_msg),
                "disconnectReason": ws_reason,
                "reconnectCount": reconnect,
            },
            "sessionHistory": [h.to_dict() for h in history],
            "lastLogout": last_logout,
            "lastLogoutAt": _iso(history[-1].logout_time) if history else None,
            "sessions": sessions,
            "terminalSessions": sessions,
            "events": event_log,
            "sessionRouting": {"state": self._subs_routing, "owner": self._subs_routing_owner},
            "subscriptionState": self.subscription_snapshot(),
        }

    def clear_session_history(self) -> None:
        with self._lock:
            self._session_history.clear()

    def auth_gate(self, endpoint: str) -> None:
        """Raise an authentication error if no valid session exists.

        Called at the top of every authenticated broker endpoint so the whole
        app shares ONE auth decision (and ONE log trail) instead of each route
        maintaining its own check.
        """
        import fastapi

        if self._mode == "dummy":
            # Dummy mode establishes an ACTIVE session like any other broker.
            if self.is_active():
                self._auth_log("ACCEPTED", f"endpoint={endpoint}")
                return
            self.mark_rest_failure(endpoint, "not logged in")
            self._auth_log("REJECTED", f"endpoint={endpoint}")
            raise fastapi.HTTPException(403, "Not logged in")

        from auth.kotak_client import kotak_session

        if not kotak_session.session_active:
            self.mark_rest_failure(endpoint, "session not found / not logged in")
            self._auth_log("REJECTED", f"endpoint={endpoint}")
            raise fastapi.HTTPException(403, "Not logged in to broker")
        if not self.is_active():
            self.mark_rest_failure(endpoint, "session expired")
            self._auth_log("REJECTED", f"endpoint={endpoint} expired")
            raise fastapi.HTTPException(403, "Session expired")
        self.mark_rest_success(endpoint)
        self._auth_log("ACCEPTED", f"endpoint={endpoint}")


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------
session_manager = CentralSessionManager()


def get_session_manager() -> CentralSessionManager:
    """Canonical accessor for the process-wide Session Manager.

    Market Watch (and the weekly report) imported this name on the assumption
    that it existed, but only the instance was declared — the resulting
    ``ImportError`` was swallowed by their broad ``except`` blocks, so the
    subscription intent was never applied. Keeping the accessor next to the
    singleton makes the instance importable as a function (tests can patch it)
    without a second manager ever being constructed.
    """
    return session_manager
