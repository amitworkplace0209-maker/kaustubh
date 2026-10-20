"""Market Watch Engine — full-market intraday discovery, state & ranking engine.

Target architecture (docs/engines/MARKET_WATCH.md):

    Kotak Neo -> WebSocket Engine -> Market Watch Engine -> Connection Manager -> Vercel UI

Responsibilities:
    * today's eligible NSE EQ intraday universe (validated instrument master, never
      a hard-coded 600-stock list)
    * symbol/name/token registry with exchange/segment + intraday-eligibility flags
    * live market-state cache (one canonical record per token)
    * per-token status: PENDING / LIVE / STALE / NO_DATA / INACTIVE
    * 30-second ranking snapshots + Top-5 appearance counters
    * automatic max-5 Gainer pins + max-5 Loser pins (trading-day scoped, dynamic
      replacement with deterministic tie-breaking)
    * dynamic sections (top gainers, top losers, highest volume, movers, +1%/-1%,
      highest absolute change) + search/pagination over the full live universe
    * controlled/selected UI delivery (indexVersion + pinned + items per section)
    * trading-day reset (state/tick cache/registry indexes cleared, counters reset)
    * observability metrics + structured MARKET_WATCH_* logs

The engine never fabricates a value. Missing live data is reported as
PENDING / STALE / NO_DATA / CONNECTING / DISCONNECTED and missing metrics as None.

doc §2/§3/§29 ownership: Market Watch is the intelligence/state layer. It consumes
the WebSocket Engine's validated ticks, the Session Manager's session/entitlement
facts, the Subscription Registry and the DB Writer; it never authenticates,
never manages the global broker socket, never places orders and never writes to
MongoDB itself. The focused modules below implement the pieces of the spec that
used to be implicit in this file:

    market_watch_config      every operational rule is configuration
    market_watch_state      canonical typed live state (per symbol / index)
    market_watch_timeframes 1m/5m/10m/30m aggregation + buffered candle commit
    market_watch_eligibility price/circuit/liquidity/business/margin decisions
    market_watch_ledger     persistent daily block ledger (block reasons)
    market_watch_lifecycle  the daily phase machine (doc §5)
    market_watch_indexes    live index tracking (independent of rankings)
    market_watch_filters    doc §12 price + timeframe movement filters
    market_watch_publish    doc §15/§16/§19/§25 publish policy and event contract
    market_watch_report     doc §26 EOD report
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from core.engines.engine_config import ConfigField, read_only
from core.engines.engine_base import EngineBase, EngineState, EngineHealth, EngineCategory
from services.engine_event_bus import get_event_bus, EngineEvent, EngineEvents
from services.market_watch_ranking import market_watch_ranking
from services import tick_buffer
from services.instrument_cache import instrument_cache
from services.market_state import market_state_service
from services import market_calendar
from services.runtime_settings import rt_int

# ---- spec modules (single owners; imported eagerly so a syntax/runtime problem
# ---- surfaces at engine start instead of silently degrading live behaviour) ---
from services import market_watch_config as mw_config
from services.market_watch_config import (
    ELIGIBILITY_ELIGIBLE,
    TIMEFRAMES,
    universe_state,
)
from services.market_watch_eligibility import circuit_near, evaluate_state
from services.market_watch_indexes import index_tracker
from services.market_watch_ledger import block_ledger
from services.market_watch_lifecycle import (
    ACTIVE_STATES,
    BLOCKING,
    COMPLETED,
    DATA_ACTIVE_STATES,
    DISCOVERY,
    DISCOVERY_STATES,
    MARKET_WATCH_STOPPED,
    PUBLISHING_STATES,
    REPORTING,
    RUNTIME_INACTIVE,
    market_watch_lifecycle,
    now_ist,
)
from services.market_watch_publish import (
    EVENT_ERROR,
    EVENT_RANKING_UPDATE,
    EVENT_SNAPSHOT,
    EVENT_STOCK_BLOCKED,
    EVENT_STOCK_UNBLOCKED,
    blocked_event,
    error_event,
    more_snapshot_event,
    publish_policy,
    validate_show_more,
)
from services.market_watch_state import SymbolState, TimeframeState
from services.market_watch_timeframes import TimeframeCommitter, bucket_start, timeframe_engine

logger = logging.getLogger("app.market_watch_engine")

# --------------------------------------------------------------------------- #
# Defaults (config-driven at runtime; these are only fallbacks — see config())
# --------------------------------------------------------------------------- #
RANKING_INTERVAL_SECONDS = 30.0
STALE_AFTER_SECONDS = 30.0
NO_DATA_MULTIPLIER = 3.0
INITIAL_SECTION_LIMIT = 50
PAGE_SIZE = 100
MAX_PINS = 5
UNIVERSE_REFRESH_INTERVAL_SECONDS = 300.0
# Memoisation TTL for the resolved Market Watch config (per-tick hot path).
_MW_CONFIG_TTL_SEC = 1.0

# Runtime setting keys (consumed through services/runtime_settings.py).
SETTING_RANKING_INTERVAL = "mwr_ranking_interval_seconds"
SETTING_STALE_THRESHOLD = "mwr_stale_threshold_seconds"
SETTING_NO_DATA_MULTIPLIER = "mwr_no_data_multiplier"
SETTING_INITIAL_SECTION_LIMIT = "mwr_initial_section_limit"
SETTING_PAGE_SIZE = "mwr_page_size"
SETTING_MAX_PINS = "mwr_max_pins"
SETTING_UNIVERSE_REFRESH = "mwr_universe_refresh_seconds"

# Per-token status vocabulary (doc §20).
STATUS_PENDING = "PENDING"      # in universe, not yet ticked
STATUS_LIVE = "LIVE"            # valid tick within stale threshold
STATUS_STALE = "STALE"          # tick older than stale threshold
STATUS_NO_DATA = "NO_DATA"      # in universe, confirmed no data from source
STATUS_INACTIVE = "INACTIVE"    # inactive instrument (kept out of the universe)

# Feed-level state (surfaced alongside per-token status).
FEED_CONNECTING = "CONNECTING"
FEED_CONNECTED = "CONNECTED"
FEED_DISCONNECTED = "DISCONNECTED"


def _fnum(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        f = float(value)
        return f if f == f else None
    except (TypeError, ValueError):
        return None


def _epoch(value: Any) -> Optional[float]:
    """Normalize an epoch timestamp (sec or ms) to seconds, or None."""
    if value is None or value == "":
        return None
    try:
        f = float(value)
        if not (f == f):
            return None
        if abs(f) > 10_000_000_000:
            f = f / 1000.0
        return f
    except (TypeError, ValueError):
        return None


def _hhmm_to_minutes(value: Any, default: int) -> int:
    """Parse an ``"HH:MM"`` string to minutes-since-midnight.

    Returns ``default`` for anything unparseable, so a bad configured value
    degrades to the documented default instead of raising inside a loop.
    """
    try:
        parts = str(value or "").strip().split(":")
        if len(parts) < 2:
            return default
        return int(parts[0]) * 60 + int(parts[1])
    except (TypeError, ValueError):
        return default


def _next_weekday_at(now: datetime, weekday: int, hhmm: Any) -> Optional[str]:
    """Next occurrence of ``weekday`` at ``hhmm`` (IST), ISO formatted.

    Used only for observability: the schedule the engine publishes must be the
    one it actually evaluates, so a bad ``HH:MM`` degrades to 15:25 rather than
    producing a timestamp for a time the job will never use.
    """
    minutes = _hhmm_to_minutes(hhmm, 15 * 60 + 25)
    try:
        days = (int(weekday) - now.weekday()) % 7
        target = (now + timedelta(days=days)).replace(
            hour=minutes // 60, minute=minutes % 60, second=0, microsecond=0,
        )
        if target <= now:
            target += timedelta(days=7)
        return target.isoformat()
    except Exception:
        return None


def _current_trading_date() -> str:
    """Authoritative IST trading date (doc §6, §14).

    ``market_calendar.snapshot()`` is the single source of ``market_date``;
    ``market_state_service.get_snapshot()`` (MarketStateSnapshot) does NOT
    carry a ``market_date`` field, so it must never be used here (previously
    returned "" making the whole ranking/day-reset loop dead).
    """
    try:
        return str(market_calendar.snapshot().get("market_date") or "")
    except Exception:
        return ""


def _is_inactive(inst: dict) -> bool:
    status = str(inst.get("tradingStatus") or inst.get("instrumentStatus") or "").strip().upper()
    if not status:
        return False
    return "INACTIVE" in status or status in {"SUSPENDED", "EXPIRED", "NOT_TRADING", "HALTED"}


#: doc §14/§15 — a DANGER or INTRADAY_UNAVAILABLE stock leaves the ACTIVE
#: frontend publish/calculation set while its backend state stays auditable.
_NON_ACTIVE_STOCK_STATES: frozenset[str] = frozenset(
    {mw_config.STOCK_STATE_DANGER, mw_config.STOCK_STATE_INTRADAY_UNAVAILABLE}
)


class MarketWatchEngine(EngineBase):
    engine_id = "market_watch"
    engine_name = "Market Watch Engine"
    engine_category = EngineCategory.MARKET_DATA
    engine_version = "2.0.0"

    config_fields = (
        ConfigField(
            key="mwr_ranking_interval_seconds",
            label="Ranking Interval",
            summary="rankingIntervalSeconds",
            type="number",
            min=5,
            max=3600,
            unit="s",
            group="Ranking",
        ),
        ConfigField(
            key="mwr_max_gainer_pins",
            label="Max Gainer Pins",
            summary="maxGainerPins",
            type="number",
            min=0,
            max=50,
            group="Pins",
        ),
        ConfigField(
            key="mwr_max_loser_pins",
            label="Max Loser Pins",
            summary="maxLoserPins",
            type="number",
            min=0,
            max=50,
            group="Pins",
        ),
        ConfigField(
            key="mwr_page_size",
            label="Page Size",
            summary="pageSize",
            type="number",
            min=5,
            max=500,
            group="Listing",
        ),
        ConfigField(
            key="mwr_initial_section_limit",
            label="Initial Section Limit",
            summary="initialSectionLimit",
            type="number",
            min=5,
            max=500,
            group="Listing",
        ),
        ConfigField(
            key="mwr_stale_threshold_seconds",
            label="Stale Threshold",
            summary="staleThresholdSeconds",
            type="number",
            min=5,
            max=3600,
            unit="s",
            group="Quality",
            help="A quote older than this is reported as stale.",
        ),
        ConfigField(
            key="mwr_universe_refresh_seconds",
            label="Universe Refresh",
            summary="universeRefreshSeconds",
            type="number",
            min=30,
            max=86400,
            unit="s",
            group="Ranking",
        ),
        ConfigField(
            key="mwr_friday_scan_hhmm",
            label="Friday Scan Time",
            summary="fridayScanHhmm",
            type="text",
            group="Weekly",
            help=(
                "IST time of the automatic weekly universe scan (HH:MM). The "
                "scan screens every NSE EQ for intraday eligibility, LTP below "
                "the price cap and the required margin multiplier, then locks "
                "and subscribes the surviving list."
            ),
        ),
        read_only("eligibilityBasis", "Eligibility Basis"),
        read_only("spec", "Spec Version"),
    )

    def __init__(self) -> None:
        super().__init__()
        self._lock = threading.RLock()
        self._tick_cache: dict[str, dict] = {}  # token -> latest raw tick
        self._records: dict[str, dict] = {}       # token -> canonical live state (ticked only)
        self._registry: dict[str, dict] = {}    # token -> symbol/name/exchange/segment/intraday
        self._universe: set[str] = set()        # eligible token set
        self._universe_instruments: list[dict] = []
        self._inactive_count = 0                 # NSE EQ instruments excluded as inactive
        self._no_data_tokens: set[str] = set()   # confirmed-no-data universe tokens
        self._subscriber_queue: Optional[asyncio.Queue] = None
        self._listener_task: Optional[asyncio.Task] = None
        self._ranking_task: Optional[asyncio.Task] = None

        self._trading_date: str = ""
        self._last_ranking_at: float = 0.0
        self._last_publish_at: float = 0.0
        self._last_ranking_duration_ms: Optional[float] = None
        self._last_publish_duration_ms: Optional[float] = None
        self._index_version: int = 0
        self._last_ui_payload: Optional[dict] = None
        self._last_universe_refresh: float = 0.0
        # True only when the current registry was built from the loaded
        # instrument cache (not the best-effort disk fallback). The fallback
        # marks every instrument ineligible, so once the real cache is loaded
        # the universe must be rebuilt immediately rather than waiting out the
        # full refresh interval.
        self._universe_from_cache: bool = False
        self._subscribed_tokens: set[str] = set()
        self._feed_state: str = FEED_CONNECTING
        self._feed_connected_at: float = 0.0

        # Tick-rate observability (rolling window of tick timestamps).
        self._tick_count = 0
        self._last_tick_at: float = 0.0
        self._tick_marks: deque[float] = deque(maxlen=2048)

        # Pin-change tracking for MARKET_WATCH_PIN_CHANGED / metrics.
        self._prev_gainer_pins: list[str] = []
        self._prev_loser_pins: list[str] = []
        self._gainer_pin_changes = 0
        self._loser_pin_changes = 0

        # ---- doc §5/§9/§11: typed canonical state + spec modules ----
        self._states: dict[str, SymbolState] = {}   # token -> SymbolState
        self._eligible_tokens: set[str] = set()     # doc §4 eligible universe
        # Live price cap (doc §16): eligible tokens whose LTP rose above
        # ``mwr_price_max``. They keep their state and their ledger decision but
        # leave the list and the tick subscription until they fall back under
        # the cap. Mutations happen ONLY under ``self._lock``.
        self._capped_tokens: set[str] = set()
        # Set when the capped set changed and the Session Manager / WebSocket
        # Engine must be told; consumed by ``_lifecycle_tick``.
        self._price_cap_dirty = False
        self._price_cap_sync_at: float = 0.0
        self._price_cap_synced_count = 0
        self._capped_tick_count = 0
        # Persisted per-symbol weekly cap-crossing counters that back the manual
        # add/remove review. The in-memory ``observe_threshold`` counter this
        # engine has always kept is wiped at day rollover, so by review time it
        # could not answer "how many times did this stock go over the cap this
        # week". This tracker is flushed to storage, so it survives both the
        # rollover and a restart.
        self._week_crossings = None
        self._week_crossing_week: str = ""
        self._week_crossing_flushes: int = 0
        self._committer: Optional[TimeframeCommitter] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._lifecycle_state: str = ""
        self._official_rankings: dict[str, list[dict[str, Any]]] = {}
        self._last_official_ranking_at: float = 0.0
        self._blocks_recorded = 0
        self._reentries_recorded = 0
        self._eligibility_evaluated = 0
        self._persisted_ticks = 0
        self._ticks_suppressed = 0
        self._storage_switch_changes = 0
        self._stop_done_for: str = ""      # doc §26 one-shot 15:15 stop
        self._report_for: str = ""         # doc §26 one-shot EOD report
        # doc §2 step 8 — week id of the advisory weekly report already handled,
        # so the Saturday review runs at most once per reviewed week.
        self._weekly_report_for: str = ""
        # Friday 15:25 scan — the scan week is marked done even when the screen
        # selects nothing, so a broker/margin outage cannot turn the lifecycle
        # loop into a once-per-second scan storm. ``_friday_scan_running_for``
        # prevents an overlapping run while the background task is in flight.
        self._friday_scan_done_for: str = ""
        self._friday_scan_running_for: str = ""
        self._friday_scan_retry_at: float = 0.0
        self._friday_scan_task: Optional[asyncio.Task] = None
        self._friday_scan_last: dict[str, Any] = {}
        self._recovery_report: dict[str, Any] = {}
        self._lifecycle_task: Optional[asyncio.Task] = None
        self._index_task: Optional[asyncio.Task] = None
        self._publish_task: Optional[asyncio.Task] = None

        # Memoised market-watch config. Resolution builds a large dataclass
        # tree from ~40 runtime settings and ``mw_config()`` is called several
        # times per validated tick (and by the status/ranking cadences), so the
        # result is reused for a short TTL. Operators still see a setting change
        # within ``_MW_CONFIG_TTL_SEC`` seconds.
        self._mw_config_cache = None
        self._mw_config_at: float = 0.0

        # ---- doc §2/§3/§7/§28: weekly locked universe ----
        # ``_locked_universe`` is the ONLY membership source when
        # ``cfg.weekly.universe_source == LOCKED`` (doc §35.2/§35.4). It is
        # loaded on start and re-verified on restart (doc §28 steps 1-2).
        self._locked_universe = None
        self._universe_source: str = mw_config.DEFAULT_UNIVERSE_SOURCE
        self._universe_verify: dict[str, Any] = {}
        self._last_lock_check_at: float = 0.0
        self._universe_unresolved: list[str] = []

        # ---- doc §30 observability counters ----
        # doc §30 requires received / validated / invalid tick separation, which
        # the previous counters could not express. ``_received_tick_count`` is
        # bumped for every event that reaches the engine; ``_invalid_tick_count``
        # for every tick rejected before it enters calculation state.
        self._received_tick_count = 0
        self._invalid_tick_count = 0
        # doc §3/§7/§35.2 — a tick for a symbol outside the Market Watch
        # universe is never counted as validated and never creates state.
        self._out_of_universe_tick_count = 0
        self._processing_latency_ms: Optional[float] = None
        self._last_process_started: float = 0.0
        self._invalid_tick_reasons: dict[str, int] = {}
        self._invalid_tick_sample: dict[str, list[dict[str, Any]]] = {}

    # ------------------------------------------------------------------
    # doc §2/§3/§7/§28: weekly locked universe
    # ------------------------------------------------------------------
    def locked_universe(self):
        """The current ``WeeklyUniverse``, or ``None`` when nothing is locked."""
        return self._locked_universe

    def universe_verify(self) -> dict[str, Any]:
        """doc §28 step 2 — the week/version verification verdict."""
        return dict(self._universe_verify)

    def _locked_symbols(self) -> Optional[frozenset[str]]:
        cfg = self.mw_config()
        if not cfg.weekly.locked_universe_required:
            return None
        universe = self._locked_universe
        if universe is None or not universe.locked:
            return frozenset()
        return frozenset(universe.symbols)

    def _accepts_tick(self, token: str) -> bool:
        """doc §3/§7/§35.2 — is ``token`` a member of the Market Watch universe?

        In LOCKED mode the resolved locked universe IS the membership, so the
        check is an exact set lookup. In the legacy ``DAILY_MASTER`` mode the
        candidate universe (Instrument Master) is used instead. Index tokens are
        routed by ``index_tracker`` and are not equity membership, so they are
        admitted here and filtered by that tracker.
        """
        try:
            if index_tracker.is_index_token(token):
                return True
            with self._lock:
                return str(token) in self._universe
        except Exception:
            return True

    async def load_locked_universe(self, *, refresh: bool = False) -> dict[str, Any]:
        """Load + verify the locked week (doc §28 steps 1-2).

        Honest failure modes, never a silent fallback to a wider universe:
        * ``NO_LOCKED_UNIVERSE``  — nothing locked yet;
        * ``WEEK_MISMATCH``       — a lock exists but for another week;
        * ``ok``                  — the locked week is loaded and usable.
        """
        try:
            from services.market_watch_universe import (
                load_locked_universe as _load_locked,
                next_week_id_for as _next_week_id_for,
                verify_week as _verify_week,
                week_id_for as _week_id_for,
            )

            universe = await _load_locked(refresh=refresh)
            self._locked_universe = universe
            expected = _week_id_for()
            # The Friday scan locks the UPCOMING week while the current week is
            # still the one on the clock. Once that lock exists it IS the active
            # universe (``load_locked_universe`` returns the latest lock), so
            # verifying it against "the week that contains today" would report a
            # false WEEK_MISMATCH for the whole weekend.
            if universe is not None and universe.week_id == _next_week_id_for():
                expected = universe.week_id
            verdict = await _verify_week(expected) if universe is not None else {
                "ok": False,
                "reason": "NO_LOCKED_UNIVERSE",
                "expectedWeekId": expected,
                "loadedWeekId": None,
                "version": None,
            }
            if universe is not None and verdict.get("ok"):
                verdict["symbolCount"] = len(universe)
            self._universe_verify = verdict
            cfg = self.mw_config()
            self._universe_source = cfg.weekly.universe_source
            if not verdict.get("ok") and cfg.weekly.locked_universe_required:
                logger.warning(
                    "[MARKET_WATCH] locked universe unavailable (%s) — locked-only mode keeps an EMPTY universe",
                    verdict.get("reason"),
                )
            else:
                logger.info(
                    "[MARKET_WATCH] locked universe %s v%s with %s symbols (source=%s)",
                    universe.week_id if universe else None,
                    universe.version if universe else None,
                    len(universe) if universe else 0,
                    self._universe_source,
                )
            # Re-derive the membership through the same path the daily build uses.
            self._build_universe()
            return verdict
        except Exception as exc:
            self.record_error("market_watch_locked_universe_error", str(exc))
            self._universe_verify = {"ok": False, "reason": "LOAD_ERROR", "detail": str(exc)}
            return self._universe_verify

    # ------------------------------------------------------------------
    # Configuration access for the spec modules
    # ------------------------------------------------------------------
    def mw_config(self):
        """Live Market Watch configuration (re-resolved from runtime settings).

        Memoised for ``_MW_CONFIG_TTL_SEC`` because resolution is comparatively
        expensive and this is on the per-tick hot path.
        """
        now = time.monotonic()
        cached = self._mw_config_cache
        if cached is not None and (now - self._mw_config_at) < _MW_CONFIG_TTL_SEC:
            return cached
        try:
            cfg = mw_config.load()
        except Exception as exc:
            logger.warning("[MARKET_WATCH] config resolve failed: %s", exc)
            if cached is not None:
                return cached
            raise
        self._mw_config_cache = cfg
        self._mw_config_at = now
        return cfg

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    async def _on_start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._subscriber_queue = await get_event_bus().subscribe([
            EngineEvents.TICK_VALIDATED,
            EngineEvents.WEBSOCKET_CONNECTED,
            EngineEvents.WEBSOCKET_DISCONNECTED,
            EngineEvents.WEBSOCKET_RECONNECTED,
        ])
        self._listener_task = asyncio.create_task(self._listen_loop())
        self._ranking_task = asyncio.create_task(self._ranking_loop())

        # doc §31 — the weekly collections need their indexes before the first
        # Saturday scan / LOCK can read or write them.
        try:
            from services import market_watch_universe as _mw_universe
            from services import market_watch_weekly as _mw_weekly

            await _mw_universe.ensure_indexes()
            await _mw_weekly.ensure_indexes()
        except Exception as exc:
            self.record_error("market_watch_weekly_index_error", str(exc))

        # doc §28 steps 1-2: load the latest locked universe and verify its
        # week/version BEFORE any subscription intent is published.
        try:
            await self.load_locked_universe(refresh=True)
        except Exception as exc:
            self.record_error("market_watch_locked_universe_error", str(exc))

        self._build_universe()

        # ---- doc §5/§10: spec-module wiring (config is live, no restart) ----
        try:
            cfg = self.mw_config()
            publish_policy.configure(cfg)
            block_ledger.set_persist_enabled(cfg.storage.persist_decisions)
            block_ledger.ensure_sink()
            index_tracker.reconfigure()
            market_watch_lifecycle.set_transition_hook(self._on_lifecycle_transition)
        except Exception as exc:
            self.record_error("market_watch_config_error", str(exc))

        # doc §23: own the persistence gates at boot so the DB Writer's start()
        # sees the authoritative values and the engine is the single owner.
        try:
            self.reconcile_storage_switches(self.mw_config().storage)
        except Exception as exc:
            self.record_error("market_watch_storage_config_error", str(exc))

        # Candle commit loop -> DB Writer (buffered; never a per-tick Mongo write).
        if self._committer is None:
            try:
                self._committer = TimeframeCommitter(
                    timeframe_engine,
                    interval_seconds=max(1.0, self.mw_config().cadence.timeframe_commit_interval_seconds),
                    batch=1000,
                )
                await self._committer.start()
            except Exception as exc:
                self.record_error("market_watch_committer_error", str(exc))

        # Seed typed state for the eligible universe and bind it to the
        # timeframe engine (so 15:15 can force-close open buckets).
        self._seed_states()
        timeframe_engine.bind(self._states)
        timeframe_engine.set_candle_sink(self._on_candle_completed)

        # doc §21 recovery: restore what was really recorded, never replay.
        await self._recover_day(_current_trading_date())

        # doc §5 lifecycle / doc §17 indexes / doc §25 publish loops.
        self._lifecycle_task = asyncio.create_task(self._lifecycle_loop())
        self._index_task = asyncio.create_task(self._index_loop())
        self._publish_task = asyncio.create_task(self._publish_loop())

        self.set_dependencies(["websocket_engine", "connection_manager", "instrument_cache", "db_writer_engine"])
        cfg = self.config()
        cfg["spec"] = mw_config.as_dict(self.mw_config()) if hasattr(mw_config, "as_dict") else {}
        self.set_config_summary(cfg)
        # Initialize feedState from real WS status to avoid perpetual CONNECTING
        # when the engine starts outside market hours (post 15:31). Prefer the
        # centralized state_store (canonical backend state) over direct ws_manager
        # import (architecture boundary: Engine → StateStore/EventBus, not WS).
        try:
            owner_connected = False
            # Canonical path: state_store websocket entity
            try:
                from services.state_store import get_snapshot
                ws_state = get_snapshot("websocket") or {}
                owner_connected = bool(ws_state.get("connected"))
            except Exception:
                pass
            # Fallback: live broker WS manager probe (legacy, kept for transition)
            if not owner_connected:
                try:
                    from ws_socket.ws_manager import ws_manager
                    live = ws_manager.live_snapshot() or {}
                    if isinstance(live, dict):
                        owner_connected = bool(live.get("connected"))
                        if not owner_connected:
                            owner_connected = bool((live.get("owner_status") or {}).get("connected"))
                    if not owner_connected:
                        st = ws_manager.status() or {}
                        owner_connected = bool(st.get("connected") or st.get("connection_connected"))
                except Exception:
                    pass
            self._feed_state = FEED_CONNECTED if owner_connected else FEED_DISCONNECTED
            self.set_metric("feedState", self._feed_state)
        except Exception:
            pass
        logger.info(
            "[MARKET_WATCH_UNIVERSE_LOADED] universe=%d eligible=%d refresh=%ds feedState=%s",
            len(self._universe), self._eligible_token_count(), cfg.get("universeRefreshSeconds", 300), self._feed_state,
        )
        self._log_subscription_ready()
        logger.info(
            "[MARKET_WATCH] engine started: %d instruments in universe feedState=%s",
            len(self._universe), self._feed_state,
        )

    async def _on_stop(self) -> None:
        q = self._subscriber_queue
        for task_attr in (
            "_listener_task", "_ranking_task", "_lifecycle_task", "_index_task",
            "_publish_task", "_friday_scan_task",
        ):
            task = getattr(self, task_attr, None)
            if task:
                task.cancel()
                try:
                    await task
                except Exception:
                    pass
                setattr(self, task_attr, None)
        if self._committer is not None:
            try:
                await self._committer.stop()
            except Exception as exc:
                logger.debug("[MARKET_WATCH] committer stop: %s", exc)
        if q:
            await get_event_bus().unsubscribe(q)
        with self._lock:
            self._tick_cache.clear()
            self._records.clear()
            self._tick_marks.clear()
        logger.info("[MARKET_WATCH] engine stopped")

    # ------------------------------------------------------------------
    # Configuration (doc §23 — no hard-coded operational limits)
    # ------------------------------------------------------------------
    def config(self) -> dict:
        return {
            "rankingIntervalSeconds": rt_int(SETTING_RANKING_INTERVAL, RANKING_INTERVAL_SECONDS),
            "maxGainerPins": rt_int(SETTING_MAX_PINS, MAX_PINS),
            "maxLoserPins": rt_int(SETTING_MAX_PINS, MAX_PINS),
            "initialSectionLimit": rt_int(SETTING_INITIAL_SECTION_LIMIT, INITIAL_SECTION_LIMIT),
            "pageSize": rt_int(SETTING_PAGE_SIZE, PAGE_SIZE),
            "staleThresholdSeconds": rt_int(SETTING_STALE_THRESHOLD, STALE_AFTER_SECONDS),
            "universeRefreshSeconds": rt_int(SETTING_UNIVERSE_REFRESH, UNIVERSE_REFRESH_INTERVAL_SECONDS),
            "fridayScanHhmm": self.mw_config().weekly.friday_scan_hhmm,
            "eligibilityBasis": self._eligibility_basis(),
        }

    def _stale_threshold(self) -> float:
        return float(rt_int(SETTING_STALE_THRESHOLD, STALE_AFTER_SECONDS))

    def _section_limit(self) -> int:
        return int(rt_int(SETTING_INITIAL_SECTION_LIMIT, INITIAL_SECTION_LIMIT))

    def _page_size(self) -> int:
        return int(rt_int(SETTING_PAGE_SIZE, PAGE_SIZE))

    # ------------------------------------------------------------------
    # Universe (doc §5 — validated master, day-scoped, refreshable)
    # ------------------------------------------------------------------
    def _account_intraday_flag(self) -> Optional[bool]:
        """Account intraday (MIS) availability, read from real broker state.

        Market Watch must not reach into a broker client. The account's intraday
        entitlement is read from the Session Manager's PUBLISHED session state
        (the authoritative broker-state surface), falling back to the adapter
        registry for a validated session.

        Returns ``None`` — meaning "unknown" — whenever no validated session has
        published a signal, and ``None`` is never coerced to ``False``: an
        unknown account flag must not silently mark the whole universe
        ineligible. ``KotakSession.intraday_available`` is initialised to
        ``False`` before login, so reading it on an unvalidated session reported
        a *denied* entitlement that was never observed; that conflation is what
        previously emptied the eligible universe.
        """
        # 1) The Session Manager's published state. ``active`` is what makes the
        #    published flag an OBSERVATION rather than a pre-login default.
        try:
            from services.session import session_manager as _sm

            snap = _sm.snapshot() or {}
            if bool(snap.get("active")):
                published = snap.get("intraday_available")
                if published is not None:
                    return bool(published)
        except Exception:
            pass

        # 2) The adapter registry, but only for a validated session.
        try:
            from brokers.broker_registry import get_broker_registry
            from brokers.manager import get_adapter

            adapter = get_adapter(get_broker_registry().get_trading_broker())
        except Exception:
            return None
        if adapter is None:
            return None

        engine_obj = getattr(adapter, "_engine", None)
        if engine_obj is None:
            return None
        # No validated session => no observation. Report unknown, never denied.
        try:
            if not bool(getattr(engine_obj, "session_active", False)):
                return None
        except Exception:
            return None

        value = getattr(engine_obj, "intraday_available", None)
        if value is None:
            return None
        return bool(value)

    def _eligibility_basis(self) -> str:
        """Configured universe eligibility basis (see ``market_watch_config``)."""
        try:
            return str(self.mw_config().universe.eligibility_basis)
        except Exception:
            return mw_config.DEFAULT_ELIGIBILITY_BASIS

    def _eligible_count(self, inst: dict, account_intraday: Optional[bool]) -> bool:
        """Is this instrument part of the observable Market Watch universe?

        The basis is configuration, not code (``MWR_ELIGIBILITY_BASIS``):

        - ``INSTRUMENT_ACTIVE`` (default): a security is observable when the
          sanctioned instrument master reports it active. A price feed needs no
          trading entitlement, so no MIS signal is consulted.
        - ``ACCOUNT_MIS``: additionally require broker-confirmed intraday
          entitlement. With no validated session the signal is unknown and the
          honest answer is "not eligible" — the reason is reported rather than
          a capability being invented.
        """
        basis = self._eligibility_basis()
        if basis == mw_config.ELIGIBILITY_BASIS_INSTRUMENT_ACTIVE:
            if _is_inactive(inst):
                return False
            status = str(
                inst.get("tradingStatus") or inst.get("instrumentStatus") or ""
            ).strip().upper()
            # An instrument the master reports as suspended/halted/expired is
            # not observable. An EMPTY status is "unknown", which is treated as
            # observable: the master simply does not carry the field.
            if status and (
                "INACTIVE" in status
                or status in {"SUSPENDED", "EXPIRED", "NOT_TRADING", "HALTED"}
            ):
                return False
            return True

        try:
            from api.market_watch_engine import evaluate_intraday_eligibility

            res = evaluate_intraday_eligibility(
                inst, None, [], account_intraday=account_intraday,
            )
            return bool(res.get("eligible"))
        except Exception:
            return False

    def _build_universe(self) -> None:
        try:
            if not instrument_cache.loaded:
                self._build_universe_from_disk_cache()
                return
            instruments = instrument_cache.get_instruments()
        except Exception as exc:
            logger.warning("[MARKET_WATCH] universe build failed: %s", exc)
            return

        # doc §3/§7/§35: Instrument Master availability does NOT authorise a
        # Market Watch subscription. In LOCKED mode the instrument master is
        # used ONLY to enrich the locked symbols with authoritative metadata —
        # membership itself comes from the locked weekly list.
        locked = self._locked_symbols()
        if locked is not None:
            self._build_locked_universe(instruments, locked)
            return

        account_intraday = self._account_intraday_flag()
        active: list[dict] = []
        registry: dict[str, dict] = {}
        inactive_count = 0
        for inst in instruments:
            if not instrument_cache.is_nse_eq(inst):
                continue
            if _is_inactive(inst):
                inactive_count += 1
                continue
            token = str(inst.get("token") or inst.get("instrumentToken") or "")
            if not token:
                continue
            active.append(inst)
            intraday_eligible = self._eligible_count(inst, account_intraday)
            registry[token] = {
                "token": token,
                "symbol": str(inst.get("symbol") or inst.get("tradingSymbol") or ""),
                "name": str(inst.get("companyName") or ""),
                "exchange": str(inst.get("exchangeSegment") or inst.get("exchange") or "nse_cm"),
                "segment": str(inst.get("segment") or "EQUITY").upper(),
                "intradayEligible": intraday_eligible,
            }

        with self._lock:
            self._universe_instruments = active
            self._universe = set(registry.keys())
            self._registry.clear()
            self._registry.update(registry)
            self._inactive_count = inactive_count
            self._no_data_tokens = set(registry.keys()) & self._no_data_tokens
            self._prune_records_to_universe()
        self._last_universe_refresh = time.time()
        self._universe_from_cache = True

    def _prune_records_to_universe(self) -> int:
        """Drop live records that are no longer Market Watch members.

        doc §3/§7: only the universe may be served. Called with ``self._lock``
        held, right after a universe rebuild (a LOCK, a refresh, or a restart).
        Index tokens are kept because ``index_tracker`` owns them.
        """
        dropped = 0
        for token in [t for t in self._records if t not in self._universe]:
            if not index_tracker.is_index_token(token):
                self._records.pop(token, None)
                self._tick_cache.pop(token, None)
                dropped += 1
        if dropped:
            logger.info(
                "[MARKET_WATCH] pruned %d live records outside the Market Watch universe", dropped
            )
        return dropped

    def _build_locked_universe(
        self, instruments: list[dict], locked: frozenset[str]
    ) -> None:
        """doc §3/§7/§35 — membership is exactly the LOCKED list.

        The instrument master supplies authoritative metadata (token, name,
        exchange, series, lot size, …) for the locked symbols and nothing else.
        A locked symbol missing from the master is reported honestly as
        unresolved rather than being dropped silently or replaced by a wider
        set.
        """
        account_intraday = self._account_intraday_flag()
        by_symbol: dict[str, dict] = {}
        for inst in instruments or []:
            symbol = str(inst.get("symbol") or inst.get("tradingSymbol") or "")
            if symbol:
                by_symbol.setdefault(symbol, inst)

        active: list[dict] = []
        registry: dict[str, dict] = {}
        unresolved: list[str] = []
        inactive_count = 0
        for symbol in sorted(locked):
            inst = by_symbol.get(symbol)
            if inst is None:
                unresolved.append(symbol)
                continue
            if not instrument_cache.is_nse_eq(inst):
                unresolved.append(symbol)
                continue
            if _is_inactive(inst):
                inactive_count += 1
                continue
            token = str(inst.get("token") or inst.get("instrumentToken") or "")
            if not token:
                unresolved.append(symbol)
                continue
            active.append(inst)
            registry[token] = {
                "token": token,
                "symbol": str(inst.get("symbol") or inst.get("tradingSymbol") or ""),
                "name": str(inst.get("companyName") or ""),
                "exchange": str(inst.get("exchangeSegment") or inst.get("exchange") or "nse_cm"),
                "segment": str(inst.get("segment") or "EQUITY").upper(),
                "intradayEligible": self._eligible_count(inst, account_intraday),
                "locked": True,
                "series": inst.get("series"),
                "lotSize": inst.get("lotSize") or inst.get("lot_size"),
                "tickSize": inst.get("tickSize") or inst.get("tick_size"),
                "precision": inst.get("precision"),
                "multiplier": inst.get("multiplier"),
                "isin": inst.get("isin") or inst.get("ISIN"),
                "instrumentType": inst.get("instrumentType") or inst.get("instType"),
            }

        with self._lock:
            self._universe_instruments = active
            self._universe = set(registry.keys())
            self._registry.clear()
            self._registry.update(registry)
            self._inactive_count = inactive_count
            self._no_data_tokens = set(registry.keys()) & self._no_data_tokens
            # doc §3/§7/§35.2 — records for symbols that are NOT in the
            # membership (e.g. built before the first LOCK) must not keep being
            # served as Market Watch rows.
            self._prune_records_to_universe()
        self._universe_unresolved = unresolved
        self._last_universe_refresh = time.time()
        self._universe_from_cache = True
        logger.info(
            "[MARKET_WATCH] locked universe applied: %s of %s symbols resolved (inactive=%s unresolved=%s)",
            len(registry), len(locked), inactive_count, len(unresolved),
        )

    def _build_universe_from_disk_cache(self) -> None:
        """Best-effort fallback: load yesterday's validated master from disk so the
        engine still has a registry (never fabricates data — status stays PENDING)."""
        try:
            import json
            from pathlib import Path
            data_path = Path(__file__).resolve().parent.parent / "data" / "instrument_master.json"
            if not data_path.exists():
                return
            with open(data_path, encoding="utf-8") as f:
                instruments = json.load(f).get("instruments", [])
            active: list[dict] = []
            registry: dict[str, dict] = {}
            for inst in instruments:
                if (inst.get("instrumentType") or inst.get("instType", "")).upper() not in ("EQ", "BE"):
                    continue
                if _is_inactive(inst):
                    continue
                token = str(inst.get("token") or inst.get("instrumentToken") or "")
                if not token:
                    continue
                active.append(inst)
                registry[token] = {
                    "token": token,
                    "symbol": str(inst.get("symbol") or inst.get("trdSym", "") or ""),
                    "name": str(inst.get("companyName") or inst.get("name") or ""),
                    "exchange": str(inst.get("exchangeSegment") or "nse_cm"),
                    "segment": "EQUITY",
                    "intradayEligible": False,
                }
            # doc §3/§7/§35.2 — even the disk fallback must honour membership. The
            # Instrument Master is metadata only; a disk-cached master must not
            # become a wider Market Watch universe just because the in-memory
            # cache has not loaded yet.
            locked = self._locked_symbols()
            if locked is not None:
                by_symbol = {
                    str(inst.get("symbol") or inst.get("trdSym") or ""): inst
                    for inst in instruments
                }
                active = []
                registry = {}
                unresolved: list[str] = []
                for symbol in sorted(locked):
                    inst = by_symbol.get(symbol)
                    token = str((inst or {}).get("token") or (inst or {}).get("instrumentToken") or "")
                    if inst is None or not token:
                        unresolved.append(symbol)
                        continue
                    active.append(inst)
                    registry[token] = {
                        "token": token,
                        "symbol": symbol,
                        "name": str(inst.get("companyName") or inst.get("name") or ""),
                        "exchange": str(inst.get("exchangeSegment") or "nse_cm"),
                        "segment": "EQUITY",
                        "intradayEligible": False,
                    }
                self._universe_unresolved = unresolved
            with self._lock:
                self._universe_instruments = active
                self._universe = set(registry.keys())
                self._registry.clear()
                self._registry.update(registry)
            self._last_universe_refresh = time.time()
            self._universe_from_cache = False
        except Exception as exc:
            logger.warning("[MARKET_WATCH] disk universe build failed: %s", exc)

    def _maybe_refresh_universe(self) -> None:
        interval = float(rt_int(SETTING_UNIVERSE_REFRESH, UNIVERSE_REFRESH_INTERVAL_SECONDS))
        # Rebuild on the timer, or immediately once the real instrument cache
        # becomes available after a disk-fallback build. The fallback reports
        # every instrument ineligible, so waiting out the full interval would
        # leave the eligible universe empty for up to the whole refresh window
        # (observed: 2678 subscribed, 0 eligible, 0 ranking boards).
        due = (time.time() - self._last_universe_refresh) >= interval
        needs_cache_rebuild = not self._universe_from_cache
        if instrument_cache.loaded and (due or needs_cache_rebuild):
            self._build_universe()
            # Rebuild the registry from the cache, then re-derive the eligible
            # set from it. Only _seed_states() sets _eligible_tokens, and it is
            # otherwise called only during DISCOVERY, so without this the
            # eligible set would stay stale for the rest of the trading day.
            self._seed_states()
            logger.info(
                "[MARKET_WATCH_UNIVERSE_LOADED] universe refreshed universe=%d eligible=%d",
                len(self._universe), self._eligible_token_count(),
            )

    def _eligible_token_count(self) -> int:
        with self._lock:
            return sum(1 for r in self._registry.values() if r.get("intradayEligible"))

    # ------------------------------------------------------------------
    # Live price cap (doc §16 — only stocks priced under the cap are watched)
    # ------------------------------------------------------------------
    def _price_cap(self) -> float:
        """Maximum LTP a stock may print and still stay in Market Watch.

        Read from ``mwr_price_max`` (``PriceFilterConfig.max_price``). A value
        of 0 or less disables the cap entirely.
        """
        try:
            return float(self.mw_config().price.max_price)
        except Exception:
            return 0.0

    def price_capped(self, token: str) -> bool:
        with self._lock:
            return str(token) in self._capped_tokens

    def capped_tokens(self) -> list[str]:
        with self._lock:
            return sorted(self._capped_tokens)

    def watchable_tokens(self) -> set[str]:
        """Eligible tokens still under the price cap — the actual watch list.

        This set is the single source of truth for "what Market Watch is
        watching": every subscription payload, every board, every section and
        every list row is intersected with it, so a capped stock can never leak
        back into the UI or the tick feed.
        """
        with self._lock:
            return set(self._eligible_tokens) - set(self._capped_tokens)

    def _evaluate_price_cap(self, token: str, ltp: Optional[float]) -> bool:
        """Apply the price cap to one token. Returns True when the set changed.

        One tick can only move a token in one direction, so the transition is
        evaluated exactly once and the subscription sync is coalesced on the
        status cadence. ``ltp`` of ``None`` (a token that has not printed yet)
        is never capped: an unpriced stock is not "above the cap".
        """
        cap = self._price_cap()
        if cap <= 0 or ltp is None:
            return False
        with self._lock:
            capped = token in self._capped_tokens
            if ltp > cap and not capped:
                self._capped_tokens.add(token)
            elif ltp <= cap and capped:
                self._capped_tokens.discard(token)
            else:
                return False
            self._price_cap_dirty = True
            now_capped = token in self._capped_tokens
            capped_count = len(self._capped_tokens)
        self.set_metric("priceCappedCount", capped_count)
        logger.info(
            "[MARKET_WATCH_PRICE_CAP] %s token=%s ltp=%s cap=%s capped=%d",
            "CAPPED" if now_capped else "RE-ADMITTED",
            token, ltp, cap, capped_count,
        )
        return True

    def _sweep_price_cap(self) -> int:
        """Re-evaluate the cap for every live state (status cadence).

        Per-tick evaluation already caps a stock the moment it prints above the
        cap. This sweep is the safety net: it catches a token whose state was
        seeded before the engine started capping, and it re-admits stocks whose
        stored LTP now fits because an operator raised ``mwr_price_max``.
        """
        cap = self._price_cap()
        if cap <= 0:
            return 0
        changed = 0
        for token, state in list(self._states.items()):
            if self._evaluate_price_cap(token, state.ltp):
                changed += 1
        return changed

    async def _push_price_cap_sync(self) -> None:
        """Make the broker subscription match the capped set.

        Dropping a token from ``desired_subscriptions`` alone is NOT enough:
        the Session Manager keeps its own persistent desired rows
        (``source=market_watch_daily_universe``) and the WebSocket Engine
        unions every consumer's wanted keys, so a capped stock would stay
        subscribed. The daily intent must be re-applied (which deactivates rows
        that left today's set) and only then can the Engine reconcile away the
        now-unwanted broker subscription.
        """
        with self._lock:
            self._price_cap_dirty = False
            capped = sorted(self._capped_tokens)
            watchable = len(self._eligible_tokens) - len(capped)
        try:
            trading_date = self._trading_date or _current_trading_date()
            from services.session.session_manager import get_session_manager
            from api.ws_engine import get_wired_engine

            sm = get_session_manager()
            session_id = (sm.snapshot() or {}).get("session_id")
            await sm.apply_daily_subscription_intent(
                trading_date, session_id, self.daily_subscription_intent(),
            )
            wired = get_wired_engine()
            result = await wired.reconcile_broker_subscriptions()
        except Exception as exc:
            logger.warning("[MARKET_WATCH_PRICE_CAP] subscription sync failed: %s", exc)
            with self._lock:
                self._price_cap_dirty = True
            return
        self._price_cap_synced_count += 1
        self.set_metric("priceCapSyncedCount", self._price_cap_synced_count)
        logger.info(
            "[MARKET_WATCH_PRICE_CAP] subscriptions synced capped=%d watchable=%d unsub=%s",
            len(capped), watchable, (result or {}).get("to_unsubscribe"),
        )

    # ------------------------------------------------------------------
    # Subscriptions (doc §4/§16 — Connection Manager consumes this)
    # ------------------------------------------------------------------
    def desired_subscriptions(self) -> list[dict]:
        """Eligible, under-cap universe tokens for WebSocket Engine subscription."""
        if self._is_stopped():
            return []
        sub = []
        with self._lock:
            for token, meta in self._registry.items():
                if (
                    meta.get("intradayEligible")
                    and token not in self._capped_tokens
                    and token not in self._subscribed_tokens
                ):
                    sub.append({
                        "instrumentToken": token,
                        "symbol": meta.get("symbol", ""),
                        "exchangeSegment": meta.get("exchange", "nse_cm"),
                    })
        return sub

    def _is_stopped(self) -> bool:
        """True once Market Watch stopped for the day (doc §26, 15:15).

        After the stop the engine reports NO desired subscriptions, so the
        WebSocket Engine's next reconcile unsubscribes Market Watch's tokens.
        The global broker socket is untouched.

        ``RUNTIME_INACTIVE`` counts as stopped: it is the state the engine
        enters when the runtime window closes, and an engine that has left the
        window must not keep asking for subscriptions.
        """
        # Check runtime window first - engine is completely inactive outside window
        if not self._in_runtime_window():
            return True
        # RUNTIME_INACTIVE is self-sufficient: the engine sets it as soon as the
        # window closes, so it must not depend on a stop having been recorded.
        if self._lifecycle_state == RUNTIME_INACTIVE:
            return True
        return bool(self._stop_done_for) and self._lifecycle_state in (
            MARKET_WATCH_STOPPED, REPORTING, COMPLETED
        )

    def _in_runtime_window(self) -> bool:
        """Is the current IST time inside the configured runtime window?

        The Market Watch Engine ONLY operates inside the configured runtime
        window (``MWR_RUNTIME_START_HHMM`` / ``MWR_RUNTIME_STOP_HHMM``). Outside
        it the engine is completely stopped - no subscriptions, no ticks, no
        rankings, no live state. The bounds are read from configuration; the
        literals below are only a last-resort fallback if the configured value
        is unparseable, and are the same values the config defaults to.
        """
        from services.market_watch_config import load as load_config
        from services.market_watch_lifecycle import now_ist

        cfg = load_config().lifecycle
        now = now_ist()
        minutes = now.hour * 60 + now.minute

        runtime_start = _hhmm_to_minutes(cfg.runtime_start, 8 * 60 + 50)
        runtime_stop = _hhmm_to_minutes(cfg.runtime_stop, 15 * 60 + 30)
        return runtime_start <= minutes < runtime_stop

    def eligible_subscription_payload(self) -> list[dict]:
        """All intraday-eligible tokens still under the price cap."""
        if self._is_stopped():
            return []
        with self._lock:
            return [
                {
                    "instrumentToken": token,
                    "symbol": meta.get("symbol", ""),
                    "exchangeSegment": meta.get("exchange", "nse_cm"),
                    "intradayEligible": True,
                    "subscribed": token in self._subscribed_tokens,
                }
                for token, meta in self._registry.items()
                if meta.get("intradayEligible") and token not in self._capped_tokens
            ]

    def index_subscription_payload(self) -> list[dict]:
        """Index tokens Market Watch needs fed (doc §17).

        Only indexes whose instrument token actually resolved from the broker /
        instrument master (or an operator override) are requested. An unresolved
        index is never requested, because there is no real token to subscribe to.
        """
        if self._is_stopped():
            return []
        rows = []
        for state in index_tracker.states():
            if not state.token:
                continue
            rows.append({
                "instrumentToken": state.token,
                "symbol": state.name,
                "exchangeSegment": "idx_us" if state.name in ("SENSEX", "BANKNIFTY") else "idx_nse",
                "isIndex": True,
            })
        return rows

    def subscribed_token_count(self) -> int:
        with self._lock:
            return len(self._subscribed_tokens)

    # ------------------------------------------------------------------
    # Daily universe subscription intent (doc §5/§14)
    # ------------------------------------------------------------------
    # Market Watch OWNS the eligible universe; it publishes the current-day
    # daily intent and the Session Manager records it as the canonical desired
    # set. ``refresh_universe()`` must run AFTER login so the live account's
    # intraday entitlement is reflected (the pre-login build reports a near-
    # empty eligible set).
    # ------------------------------------------------------------------
    def refresh_universe(self) -> dict:
        """(Re)build the intraday-eligible NSE EQ universe from the cache.

        Same work as the periodic timer, exposed for the scheduler to invoke
        right after login / daily rollover. Returns real counts.
        """
        self._build_universe()
        self._seed_states()
        counts = {
            "universe": len(self._universe),
            "eligible": self._eligible_token_count(),
            "inactive_excluded": self._inactive_count,
        }
        logger.info(
            "[MARKET_WATCH_UNIVERSE_LOADED] refresh_universe universe=%d eligible=%d inactive=%d",
            counts["universe"], counts["eligible"], counts["inactive_excluded"],
        )
        return counts

    def eligible_token_count(self) -> int:
        with self._lock:
            return self._eligible_token_count()

    def daily_subscription_intent(self) -> list[dict]:
        """Current-day eligible-universe subscription intent rows.

        One row per intraday-eligible NSE EQ instrument that is still under the
        price cap (instrumentToken / symbol / exchangeSegment). Consumed by the
        Session Manager's ``apply_daily_subscription_intent``; re-applied whenever
        the capped set changes so a capped row is deactivated for the day.
        Never fabricated: only registry records that were actually evaluated
        intraday-eligible are included.
        """
        rows = []
        with self._lock:
            for token, meta in self._registry.items():
                if not meta.get("intradayEligible"):
                    continue
                if token in self._capped_tokens:
                    continue
                rows.append({
                    "instrumentToken": token,
                    "symbol": meta.get("symbol", ""),
                    "exchangeSegment": str(meta.get("exchange", "nse_cm")),
                })
        return rows

    def _log_subscription_ready(self) -> None:
        eligible = self._eligible_token_count()
        logger.info(
            "[MARKET_WATCH_SUBSCRIPTION_READY] eligible=%d subscribed=%d",
            eligible, len(self._subscribed_tokens),
        )

    # ------------------------------------------------------------------
    # Typed canonical state (doc §9/§11)
    # ------------------------------------------------------------------
    def _seed_states(self) -> None:
        """Create/reconcile a :class:`SymbolState` for every eligible token.

        The universe is the *candidate* set; eligibility (doc §4/§6) decides
        which of these actually join the eligible universe. States are created
        for the whole candidate set so a symbol that becomes eligible later in
        the day already has (empty, UNAVAILABLE) state instead of nothing.
        """
        now = time.time()
        cfg = self.mw_config()
        with self._lock:
            registry = dict(self._registry)
            self._eligible_tokens = {
                token for token, meta in registry.items() if meta.get("intradayEligible")
            }
            for token, meta in registry.items():
                state = self._states.get(token)
                if state is None:
                    state = SymbolState(
                        symbol=str(meta.get("symbol") or ""),
                        instrument_token=token,
                        exchange_segment=str(meta.get("exchange") or "nse_cm"),
                        exchange=str(meta.get("exchange") or "NSE").upper(),
                        segment=str(meta.get("segment") or "EQUITY"),
                        name=str(meta.get("name") or ""),
                    )
                    self._states[token] = state
                    continue
                state.symbol = str(meta.get("symbol") or state.symbol)
                state.name = str(meta.get("name") or state.name)
                state.exchange_segment = str(meta.get("exchange") or state.exchange_segment)
            # Tokens that left the universe must not keep publishing state.
            for token in [t for t in self._states if t not in registry]:
                self._states.pop(token, None)
            for token in self._eligible_tokens:
                self._states[token].refresh_status(now, cfg.cadence.stale_threshold_seconds)
        self.set_metric("stateCount", len(self._states))
        self.set_metric("eligibleUniverseCount", len(self._eligible_tokens))

    def symbol_state(self, token: str) -> Optional[SymbolState]:
        """One symbol's live state.

        Named ``symbol_state`` and not ``state``: ``EngineBase.state`` is the
        engine lifecycle state (``RUNNING``/``STOPPED``...) that the engine
        registry reads, and a same-named lookup here shadowed that property, so
        every registry surface that touches ``engine.state.value`` raised
        AttributeError (the /summary, /dependency-graph and /<id>/health
        routes all returned 500).
        """
        return self._states.get(str(token))

    def states(self) -> dict[str, SymbolState]:
        return self._states

    def eligible_states(self) -> list[SymbolState]:
        return [s for t, s in self._states.items() if t in self._eligible_tokens]

    def _apply_state_tick(self, token: str, tick: dict, entry: dict, now: float) -> None:
        """Fold one validated tick into the typed state + timeframe aggregators.

        doc §10: every tick updates ONE symbol's state and the relevant
        aggregators, enqueues a buffered DB write and stages a coalesced publish.
        It never sorts the universe and never writes to MongoDB synchronously.
        """
        cfg = self.mw_config()

        # doc §17: index ticks are consumed by the index tracker, never by the
        # equity universe. An index token has no SymbolState, so this MUST run
        # before the equity lookup or every index tick would be dropped.
        try:
            if index_tracker.apply_tick(token, tick, now):
                return
        except Exception as exc:
            logger.debug("[MARKET_WATCH_INDEX] tick failed for %s: %s", token, exc)

        state = self._states.get(token)
        if state is None:
            return
        ltp = _fnum(entry.get("ltp"))
        if ltp is not None and ltp > 0:
            state.apply_price_tick(
                now=now,
                ltp=ltp,
                previous_close=_fnum(entry.get("previousClose")),
                volume=_fnum(entry.get("volume")),
                open_=_fnum(entry.get("open")),
                high=_fnum(entry.get("high")),
                low=_fnum(entry.get("low")),
            )
            # doc §16: the moment a stock prints above the cap it leaves the
            # watch list. The transition is recorded here (per tick, one-way)
            # while the subscription sync is coalesced on the status cadence.
            self._evaluate_price_cap(token, ltp)
        upper = _fnum(entry.get("upperCircuit"))
        lower = _fnum(entry.get("lowerCircuit"))
        if upper is not None or lower is not None:
            if state.apply_circuits(upper, lower):
                state.recompute_circuit_distance()
        else:
            state.recompute_circuit_distance()

        # doc §14: circuit safety is derived from the REAL circuit prices only,
        # and stays UNKNOWN when they are missing (never fabricate safety).
        state.recompute_circuit_status(cfg)

        # doc §11: 1m/5m/10m/30m aggregation from the same validated tick.
        try:
            timeframe_engine.observe_tick(state, now)
        except Exception as exc:
            logger.debug("[MARKET_WATCH_TF] observe failed for %s: %s", token, exc)

        # doc §21: per-timeframe 1% mover flags, backend-owned.
        state.evaluate_movement_flags(cfg.weekly.mover_threshold_pct)

        # doc §16: ₹800 observation counter for the Saturday report. Crossing it
        # never changes membership (doc §33).
        state.observe_threshold(ltp, cfg.weekly.rupee_threshold, now, cfg.weekly.rupee_observation_interval)

        # Persisted counterpart of the counter above, feeding the weekly
        # add/remove review. It answers a question the in-memory counter cannot:
        # how many times this stock breached the cap ACROSS the whole week,
        # which is the evidence an operator needs before dropping a name.
        self._observe_week_crossing(token, entry, ltp, cfg.weekly.rupee_threshold)

        # doc §17: consume the authoritative margin answer when the Session
        # Manager published one; otherwise leave it UNAVAILABLE.
        self._apply_margin_from_session(state, cfg)

        # doc §20/§27: classification + stock state with the documented
        # precedence. The frontend renders these; it must not derive them.
        state.evaluate_stock_state(
            now=now, stale_after=cfg.cadence.stale_threshold_seconds, cfg=cfg
        )

        # doc §10/§23 + DB Writer single-authority rule: Market Watch decides
        # WHEN a validated tick is *offered*; the DB Writer alone decides whether
        # it is persisted. ``mwr_persist_ticks`` is only the offer gate, so an
        # operator turning the DB Writer's marketWatchOneDay permission OFF
        # genuinely stops writes even though this gate is still on.
        if cfg.storage.persist_ticks:
            self._persist_tick(token, entry, tick, now)
        else:
            self._ticks_suppressed += 1

        # doc §15/§25: stage the latest state for the controlled publish set.
        self._stage_publish(state, now)

    def _observe_week_crossing(
        self, token: str, entry: dict, ltp: Optional[float], threshold: float,
    ) -> None:
        """Fold one validated tick into the persisted weekly crossing tracker.

        Best-effort by design: the weekly review is evidence, not a trading
        gate, so a tracker failure must never interrupt the tick path. The
        tracker is created lazily and rolled over when the ISO week changes, so
        Saturday and Sunday accumulate into the same bucket.
        """
        try:
            from services.market_watch_crossings import WeeklyCrossingTracker, week_id_for

            week = week_id_for()
            if self._week_crossings is None or self._week_crossing_week != week:
                self._week_crossings = WeeklyCrossingTracker(week)
                self._week_crossing_week = week
            # The trading date, not the wall clock: a session that runs past IST
            # midnight must not file the tick under the wrong day.
            self._week_crossings.observe(
                token,
                symbol=str(entry.get("symbol") or entry.get("tradingSymbol") or ""),
                ltp=ltp,
                price_cap=threshold,
                date_str=_current_trading_date(),
            )
        except Exception as exc:
            logger.debug("[MARKET_WATCH] weekly crossing observe failed for %s: %s", token, exc)

    async def flush_week_crossings(self) -> int:
        """Hand the dirty weekly crossing rows to the DB Writer."""
        tracker = self._week_crossings
        if tracker is None:
            return 0
        try:
            from services.market_watch_crossings import flush

            count = await flush(tracker)
        except Exception as exc:
            logger.debug("[MARKET_WATCH] weekly crossing flush failed: %s", exc)
            return 0
        if count:
            self._week_crossing_flushes += 1
        return count

    def week_crossing_snapshot(self) -> dict:
        """Weekly crossing evidence for the manual review screen."""
        if self._week_crossings is None:
            from services.market_watch_crossings import WeeklyCrossingTracker, week_id_for

            self._week_crossings = WeeklyCrossingTracker(week_id_for())
            self._week_crossing_week = self._week_crossings.week_id
        return self._week_crossings.snapshot()

    def _apply_margin_from_session(self, state: SymbolState, cfg) -> None:
        """doc §17 — store the authoritative broker margin answer.

        The Session Manager is the margin owner. When it has published nothing
        for this symbol the status stays ``UNAVAILABLE`` and both values remain
        ``None``: Market Watch consumes margin, it never invents leverage.
        """
        try:
            from services.session.session_manager import get_session_manager

            snapshot = get_session_manager().snapshot() or {}
        except Exception:
            return
        decisions = snapshot.get("marginDecisions") or {}
        entry = decisions.get(state.symbol)
        if not isinstance(entry, dict):
            return
        state.apply_margin(
            value=_fnum(entry.get("marginValue") or entry.get("value") or entry.get("requiredMargin")),
            multiplier=_fnum(entry.get("multiplier") or entry.get("leverage") or entry.get("marginMultiplier")),
            threshold=cfg.weekly.margin_multiplier_threshold,
            status=None,
        )

    def _persist_tick(self, token: str, entry: dict, tick: dict, now: float) -> None:
        """Hand the validated tick to the DB Writer for a persistence decision.

        This method must never write to MongoDB and must never decide
        persistence. ``ingest_market_watch_ticks`` applies the DB Writer's own
        permission and buffers the accepted documents.
        """
        try:
            from services.db_writer_engine import db_writer_engine

            doc = {
                "_id": f"{entry.get('symbol') or token}:{int(tick.get('sequenceNumber') or now * 1000)}",
                "date": self._trading_date or _current_trading_date(),
                "instrumentToken": token,
                "symbol": entry.get("symbol"),
                "ltp": entry.get("ltp"),
                "previousClose": entry.get("previousClose"),
                "change": entry.get("change"),
                "changePct": entry.get("changePercent"),
                "volume": entry.get("volume"),
                "turnover": entry.get("turnover"),
                "open": entry.get("open"),
                "high": entry.get("high"),
                "low": entry.get("low"),
                "upperCircuit": entry.get("upperCircuit"),
                "lowerCircuit": entry.get("lowerCircuit"),
                "dataQuality": entry.get("status"),
                "lastTickAt": now,
                "receivedAt": tick.get("receivedAt"),
                "sequenceNumber": tick.get("sequenceNumber"),
            }
            result = db_writer_engine.ingest_market_watch_ticks([doc])
            if result.get("accepted", 0) > 0:
                self._persisted_ticks += 1
            elif not result.get("enabled", False):
                # DB Writer permission is OFF — this is the authoritative
                # outcome, so count it as suppressed rather than persisted.
                self._ticks_suppressed += 1
        except Exception as exc:
            logger.debug("[MARKET_WATCH] tick persist handoff skipped: %s", exc)

    def reconcile_storage_switches(self, storage: Any = None) -> dict[str, Any]:
        """Push the resolved storage on/off switches into the document buffer.

        doc §23: persistence is operator-configurable and live. The engine owns
        WHEN a tick is offered for persistence (per-tick, above); the DB Writer
        owns WHETHER it is persisted at all. These Market Watch switches are
        therefore only the *offer* gate — the DB Writer's
        ``marketWatchOneDay`` permission is ANDed on top by
        ``db_writer_engine.ingest_market_watch_ticks``, so the DB Writer
        remains the single authority. This reconciles the offer gate into the
        buffer so a flip is honoured on both sides within one status tick, and
        reports what changed for observability.
        """
        from services import market_watch_doc_buffer

        cfg_storage = storage if storage is not None else self.mw_config().storage
        before = {name: market_watch_doc_buffer.enabled(name) for name in market_watch_doc_buffer.COLLECTIONS}
        gates = market_watch_doc_buffer.apply_storage_config(cfg_storage)
        after = {name: gates.get(name, before[name]) for name in before}
        changed = {name: before[name] != after[name] for name in before if before[name] != after[name]}
        if changed:
            self._storage_switch_changes += 1
            for name, flipped in changed.items():
                self.set_metric(f"storage.{name}", after[name])
                logger.info(
                    "[MARKET_WATCH_STORAGE] %s persistence %s",
                    name, "ENABLED" if after[name] else "DISABLED",
                )
        # Report the DB Writer's authoritative tick decision alongside the offer
        # gate so no reader can mistake the Market Watch switch for authority.
        db_writer_permission = None
        try:
            from services.db_writer_engine import (
                TICK_PERSISTENCE_PERMISSIONS,
                db_writer_engine,
            )
            from services.runtime_settings import rt_bool

            key = TICK_PERSISTENCE_PERMISSIONS["marketWatchOneDay"]
            db_writer_permission = {
                "permission": "marketWatchOneDay",
                "settingKey": key,
                "enabled": rt_bool(key, False),
            }
        except Exception:
            db_writer_permission = None
        return {
            "changed": changed,
            "gates": after,
            "dropped": int(market_watch_doc_buffer.stats().get("totalGatedDrops", 0)),
            "dbWriterPermission": db_writer_permission,
        }

    def tick_saving(self) -> dict[str, Any]:
        """doc §23: the tick/candle/decision on-off state and what it has done.

        Honest by construction — every number is a real counter, and a switch
        that is off says so together with the reason it can be off (the live
        pipeline health, which is a separate master switch owned by the Data
        Saver pipeline and not by Market Watch).
        """
        from services import market_watch_doc_buffer

        cfg = self.mw_config()
        gates = {
            name: market_watch_doc_buffer.enabled(name)
            for name in market_watch_doc_buffer.COLLECTIONS
        }
        return {
            "tradingDate": self._trading_date or None,
            "persistTicks": bool(cfg.storage.persist_ticks),
            "persistCandles": bool(cfg.storage.persist_candles),
            "persistDecisions": bool(cfg.storage.persist_decisions),
            "tickRetentionDays": int(cfg.storage.tick_retention_days),
            "gates": gates,
            "ticksSaved": self._persisted_ticks,
            "ticksSuppressed": self._ticks_suppressed,
            "switchChanges": self._storage_switch_changes,
            "pipeline": market_watch_doc_buffer.stats(),
        }

    def _stage_publish(self, state: SymbolState, now: float) -> None:
        """Stage a coalesced WS #3 stock update (doc §15/§25)."""
        try:
            payload = state.to_compact()
            payload["instrumentToken"] = state.instrument_token
            publish_policy.stage_stock(state.instrument_token, payload)
        except Exception as exc:
            logger.debug("[MARKET_WATCH] stage publish failed: %s", exc)

    def _on_candle_completed(self, token: str, timeframe: str, doc: dict[str, Any]) -> None:
        """Completed candle -> buffered DB Writer commit (doc §10/§23).

        The document gets a deterministic ``_id`` (``date:token:tf:bucket``) so
        a restart or a duplicate flush upserts the same candle instead of
        creating a second row.
        """
        try:
            date = self._trading_date or _current_trading_date() or ""
            doc["date"] = date
            doc["_id"] = f"{date}:{token}:{timeframe}:{int(doc.get('bucketStartEpoch') or 0)}"
            if self._committer is not None:
                self._committer.submit(token, timeframe, doc)
            else:
                # No committer yet (early ticks during start) — buffer directly
                # through the DB Writer, which owns the same collections.
                from services.db_writer_engine import db_writer_engine

                db_writer_engine.buffer_candles([doc])
        except Exception as exc:
            logger.debug("[MARKET_WATCH_TF] candle commit skipped: %s", exc)

    # ------------------------------------------------------------------
    # doc §21 recovery
    # ------------------------------------------------------------------
    async def _recover_day(self, trading_date: str) -> None:
        """Restore real persisted state after a restart; never replay ticks.

        Steps (doc §21): session verification (owned by Session Manager) ->
        state recovery -> available timeframe state -> subscription
        reconciliation -> fresh feed -> recalculated metrics.
        """
        cfg = self.mw_config()
        report: dict[str, Any] = {"date": trading_date, "enabled": bool(cfg.recovery.enabled)}
        if not trading_date or not cfg.recovery.enabled:
            report["skipped"] = "disabled" if not cfg.recovery.enabled else "no trading date"
            self._recovery_report = report
            return
        # 1. Block-ledger recovery — the day's real decisions.
        try:
            block_ledger.configure_day(trading_date)
            restored = await block_ledger.load_day(trading_date, sorted(self._eligible_tokens))
            report["ledgerRestored"] = restored
            await block_ledger.ensure_indexes()
        except Exception as exc:
            report["ledgerError"] = str(exc)
        # 2. Timeframe recovery — completed candles are real; gaps are INCOMPLETE.
        try:
            restored_candles, incomplete = await self._restore_candles(trading_date)
            report["candlesRestored"] = restored_candles
            report["timeframesIncomplete"] = incomplete
        except Exception as exc:
            report["candleError"] = str(exc)
        self._recovery_report = report
        logger.info(
            "[MARKET_WATCH_RECOVERY] date=%s ledger=%s candles=%s incomplete=%s",
            trading_date,
            report.get("ledgerRestored"),
            report.get("candlesRestored"),
            report.get("timeframesIncomplete"),
        )
        self.set_metric("recoveryCandles", report.get("candlesRestored", 0))
        self.set_metric("recoveryIncomplete", report.get("timeframesIncomplete", 0))

    async def _restore_candles(self, trading_date: str) -> tuple[int, int]:
        """Load today's completed candles for the eligible universe.

        Candles that exist are restored verbatim. A window whose bucket had
        already started before this process began listening is INCOMPLETE: the
        earlier part of that window is genuinely gone and must not be invented
        (doc §21/§31). A window that simply has not received a tick yet stays
        UNAVAILABLE.
        """
        from database.connection import get_db

        db = get_db()
        if db is None or not self._eligible_tokens:
            return 0, 0
        tokens = sorted(self._eligible_tokens)
        restored = 0
        seen: set[str] = set()
        for tf in TIMEFRAMES:
            collection = f"market_candles_{tf}"
            try:
                cursor = db[collection].find(
                    {"date": trading_date, "instrumentToken": {"$in": tokens}},
                    {"_id": 0},
                )
                rows = await cursor.to_list(length=None)
            except Exception as exc:
                logger.debug("[MARKET_WATCH_RECOVERY] %s read failed: %s", collection, exc)
                continue
            for row in rows:
                token = str(row.get("instrumentToken") or "")
                state = self._states.get(token)
                if state is None:
                    continue
                try:
                    # ``from_storage_doc`` builds a NEW TimeframeState; it must
                    # replace the live bucket, otherwise recovery is a no-op.
                    # ``SymbolState`` is a ``slots`` dataclass whose field is
                    # ``timeframes``: addressing ``_timeframes`` raised
                    # AttributeError, which the bare ``except`` below swallowed,
                    # so every restore silently did nothing and the INCOMPLETE
                    # sweep then marked the whole timeframe view degraded.
                    state.timeframes[tf] = TimeframeState.from_storage_doc(row)
                except Exception as exc:
                    logger.debug(
                        "[MARKET_WATCH_RECOVERY] candle restore failed for %s/%s: %s",
                        token, tf, exc,
                    )
                    continue
                restored += 1
                seen.add(f"{token}:{tf}")
        # A bucket that opened before this process started listening lost its
        # earlier ticks: report INCOMPLETE instead of pretending it is intact.
        incomplete = 0
        now = time.time()
        listening_since = getattr(self, "_started_at", None) or now
        for token in tokens:
            state = self._states.get(token)
            if state is None:
                continue
            for tf in TIMEFRAMES:
                if f"{token}:{tf}" in seen:
                    continue
                if bucket_start(now, tf) >= listening_since:
                    # The window is being built live from the first tick.
                    continue
                state.timeframe(tf).mark_incomplete()
                incomplete += 1
            state.refresh_status(now, self.mw_config().cadence.stale_threshold_seconds)
        return restored, incomplete

    # ------------------------------------------------------------------
    # Tick consumption (doc §8, §19 — feed and ranking stay separate)
    # ------------------------------------------------------------------
    async def _listen_loop(self) -> None:
        q = self._subscriber_queue
        if not q:
            return
        while True:
            try:
                event = await q.get()
                event_type = event.get("eventType", "")
                if event_type == EngineEvents.TICK_VALIDATED:
                    tick = event.get("data", {}) or {}
                    token = str(tick.get("instrumentToken") or tick.get("token", ""))
                    if token:
                        self._process_tick(token, tick)
                        if token in self._registry and token not in self._subscribed_tokens:
                            with self._lock:
                                self._subscribed_tokens.add(token)
                elif event_type == EngineEvents.WEBSOCKET_DISCONNECTED:
                    self._on_ws_disconnected()
                elif event_type in (EngineEvents.WEBSOCKET_CONNECTED, EngineEvents.WEBSOCKET_RECONNECTED):
                    self._on_ws_reconnected()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.record_error("tick_processing_error", str(exc))

    def _on_ws_disconnected(self) -> None:
        self._feed_state = FEED_DISCONNECTED
        self._feed_connected_at = 0.0
        self.set_metric("feedState", FEED_DISCONNECTED)
        logger.warning("[MARKET_WATCH_WS_DISCONNECTED] feed state -> %s", FEED_DISCONNECTED)
        self._queue_status_broadcast()

    def _on_ws_reconnected(self) -> None:
        was = self._feed_state
        self._feed_state = FEED_CONNECTED
        self._feed_connected_at = time.time()
        self.set_metric("feedState", FEED_CONNECTED)
        logger.info(
            "[MARKET_WATCH_WS_RECONNECTED] feed state %s -> %s (tokens=%d)",
            was, FEED_CONNECTED, len(self._subscribed_tokens),
        )
        self._queue_status_broadcast()

    def _queue_status_broadcast(self) -> None:
        """Fire-and-forget broadcast of a status frame on feed-state changes."""
        trading_date = _current_trading_date()
        if not trading_date:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        try:
            loop.create_task(self._broadcast_state(trading_date, reason=self._feed_state))
        except Exception as exc:
            self.record_error("market_watch_broadcast_task_error", str(exc))

    async def _broadcast_state(self, trading_date: str, *, reason: str) -> None:
        """Publish realtime market-watch state frames onto the browser event bus.

        The Connection Manager bridge fans these out to every session subscribed
        to the ``market_watch`` state channel (connection_engine._STATE_TYPE_CHANNEL
        maps ``market_watch.*`` -> the channel). Per-token LIVE ticks travel the
        separate ``market_watch`` market channel; this state path carries ranking,
        pins and feed/engine status — all real values, never fabricated.
        """
        try:
            from services.event_bus import get_event_bus
        except Exception as exc:
            self.record_error("market_watch_broadcast_error", str(exc))
            return
        now = time.time()
        generated_at = self.generated_at()
        ranking = self.ranking_snapshot()
        pins = self.ranking_pins()
        status = self.status_snapshot()
        custom = status.get("metrics", {}).get("custom", {})
        frames = [
            {
                "type": "market_watch.ranking",
                "reason": reason,
                "tradingDate": trading_date,
                "generatedAt": generated_at,
                "epoch": now,
                "latest": ranking.get("latest") or {},
                "snapshotCount": ranking.get("snapshotCount", 0),
                "gainers": ranking.get("gainers", []),
                "losers": ranking.get("losers", []),
            },
            {
                "type": "market_watch.pins",
                "reason": reason,
                "tradingDate": trading_date,
                "generatedAt": generated_at,
                "epoch": now,
                "pins": pins,
            },
            {
                "type": "market_watch.status",
                "reason": reason,
                "tradingDate": trading_date,
                "generatedAt": generated_at,
                "epoch": now,
                "feedState": self._feed_state,
                   "universeSize": len(self._universe),
                   "eligibleUniverseCount": custom.get("eligibleUniverseCount", 0),
                   "priceCappedCount": custom.get("priceCappedCount", 0),
                   "priceCap": custom.get("priceCap"),
                   "watchableCount": custom.get("watchableCount", 0),
                   "subscribedTokenCount": custom.get("subscribedTokenCount", 0),
                "liveStateCount": custom.get("liveInstrumentCount", 0),
                "statusCounts": self._status_counts(now),
                "indexVersion": self._index_version,
                "lastRankingAt": custom.get("lastRankingAt"),
                "rankingIntervalSeconds": custom.get("rankingIntervalSeconds"),
                "staleThresholdSeconds": custom.get("staleThresholdSeconds"),
            },
        ]
        try:
            bus = get_event_bus()
            for frame in frames:
                await bus.publish(frame)
        except Exception as exc:
            self.record_error("market_watch_broadcast_error", str(exc))

    def _process_tick(self, token: str, tick: dict) -> None:
        now = time.time()
        self._last_process_started = now
        # doc §30: every event that reaches the engine is a RECEIVED tick.
        self._received_tick_count += 1
        ltp = _fnum(tick.get("ltp") or tick.get("lastPrice"))
        prev_close = _fnum(tick.get("prevClose") or tick.get("previousClose") or tick.get("close"))
        change = _fnum(tick.get("netChange") or tick.get("change"))
        change_pct = _fnum(tick.get("netChangePercent") or tick.get("changePercent"))
        if change is None and ltp is not None and prev_close not in (None, 0):
            change = ltp - prev_close
        if change_pct is None and change is not None and prev_close not in (None, 0):
            change_pct = (change / prev_close) * 100.0

        # doc §12: a tick with no usable LTP must not enter calculation state.
        # It is now counted as invalid instead of vanishing without a trace.
        # NOTE: membership is NOT checked here — doc §3/§7 govern WHICH tokens are
        # subscribed (see ``_build_locked_universe``), while this check governs
        # whether an arriving tick is usable at all. Index ticks legitimately have
        # no equity ``SymbolState`` and are admitted by ``_apply_state_tick``.
        if ltp is None or ltp <= 0:
            self._invalid_tick_count += 1
            self._record_invalid_tick(token, tick, "LTP_MISSING", now)
            return

        # doc §3/§7/§35.2/§35.4 — a tick for a symbol that is NOT in the Market
        # Watch universe must never enter Market Watch calculation state. In
        # LOCKED mode this is the structural enforcement of "monitor exactly the
        # locked list": an Instrument Master stock, a previously cached record or
        # another engine's subscription cannot create state here. The tick is
        # counted honestly (``out_of_universe_tick_count``) instead of vanishing.
        if not self._accepts_tick(token):
            self._out_of_universe_tick_count += 1
            return

        # doc §16: a capped stock is out of the watch list AND out of the tick
        # feed. Residual ticks that still arrive (the Session Manager drops its
        # row on the next status cadence) must not re-enter calculation state,
        # so they are counted honestly and dropped before any state work.
        if self.price_capped(token):
            self._capped_tick_count += 1
            self.set_metric("cappedTickCount", self._capped_tick_count)
            return

        meta = self._registry.get(token, {})
        entry = {
            "token": token,
            "symbol": str(tick.get("symbol") or tick.get("tradingSymbol") or meta.get("symbol") or ""),
            "name": str(tick.get("name") or tick.get("companyName") or meta.get("name") or ""),
            "ltp": ltp,
            "previousClose": prev_close,
            "change": change,
            "changePercent": change_pct,
            "volume": _fnum(tick.get("volume")),
            "turnover": _fnum(tick.get("turnover")),
            "open": _fnum(tick.get("open")),
            "high": _fnum(tick.get("high")),
            "low": _fnum(tick.get("low")),
            "bid": _fnum(tick.get("bid")),
            "ask": _fnum(tick.get("ask")),
            "lastTickAt": now,
            "exchange": str(tick.get("exchange") or meta.get("exchange") or "NSE"),
            "segment": meta.get("segment") or "EQUITY",
            "intradayEligible": bool(meta.get("intradayEligible")),
            "status": STATUS_LIVE,
        }
        self._enrich_entry(entry, token, tick, now)
        # Momentum (5m, 10m) from tick_buffer
        try:
            momentum = tick_buffer.momentum_windows(token, ltp) or {}
            entry["fiveMinPercent"] = _fnum(momentum.get("5m"))
            entry["tenMinPercent"] = _fnum(momentum.get("10m"))
        except Exception:
            pass

        with self._lock:
            self._tick_cache[token] = tick
            self._records[token] = entry
            self._tick_marks.append(now)
        self._tick_count += 1
        self._last_tick_at = now
        self.set_metric("tickCount", self._tick_count)
        self.set_metric("lastTickAt", self._last_tick_at)
        # doc §30: end-to-end processing latency for the most recent tick.
        self._processing_latency_ms = max(0.0, (time.time() - now) * 1000.0)

        # doc §9/§11/§15: fold the tick into the typed state + timeframes and
        # stage the coalesced publish. Runs outside the lock: it also offers the
        # tick for buffered persistence. Eligibility is NOT evaluated here —
        # that is doc §6's job and it runs on the status cadence in
        # ``_enforce_blocks`` so a block is recorded once, not per tick.
        self._apply_state_tick(token, tick, entry, now)

    def _record_invalid_tick(self, token: str, tick: dict, reason: str, now: float) -> None:
        """doc §12/§30 — account for a tick that must NOT enter calculation state.

        Kept as a bounded sample (the last few reasons per symbol) so a broken
        feed cannot turn the observability metric into an unbounded log.
        """
        self._invalid_tick_reasons[reason] = self._invalid_tick_reasons.get(reason, 0) + 1
        sample = self._invalid_tick_sample.setdefault(token, [])
        sample.append({"reason": reason, "at": now, "symbol": str(tick.get("symbol") or "")})
        if len(sample) > 5:
            del sample[:-5]

    def _enrich_entry(self, entry: dict, token: str, tick: dict, now: float) -> None:
        """Merge REAL extra fields into a live record.

        Sources (never fabricated, first non-null wins):
          * ``masterCanonical`` — full Master Canonical object attached to the
            flat tick when the option is enabled (engine.py ``_flat_tick``)
          * ``tick_buffer._latest_ticks`` — the central merged raw-tick store
            (carries the raw broker fields: bp/bq/sp/sq, oi, circuits, 52w,
            total_traded_value, ltq, avg_price, ...)
          * the flat handoff tick itself
        """
        master = tick.get("masterCanonical")
        if not isinstance(master, dict):
            master = {}
        latest: dict = {}
        try:
            latest = tick_buffer._latest_ticks.get(str(token)) or {}
        except Exception:
            latest = {}

        def msrc(section: str, key: str) -> Any:
            try:
                v = (master.get(section) or {}).get(key)
            except Exception:
                v = None
            if v is None or v == "":
                return None
            return v

        def lsrc(*keys: str) -> Any:
            for k in keys:
                v = latest.get(k)
                if v is not None and v != "":
                    return v
            return None

        def first(*vals: Any) -> Any:
            for v in vals:
                if v is not None:
                    return v
            return None

        entry["ltq"] = _fnum(first(
            msrc("trade", "last_trade_quantity"),
            lsrc("ltq", "last_trade_qty", "last_traded_quantity"),
            tick.get("ltq"),
        ))
        entry["avgPrice"] = _fnum(first(
            msrc("price", "average_trade_price"),
            lsrc("avg_price", "average_trade_price"),
            tick.get("avgPrice"),
        ))
        entry["oi"] = _fnum(first(
            msrc("open_interest", "open_interest"),
            lsrc("oi", "open_interest"),
            tick.get("oi"),
        ))
        entry["oiChange"] = _fnum(lsrc("oi_change"))
        entry["totalBuyQuantity"] = _fnum(first(
            msrc("volume", "buy_volume_today"),
            lsrc("total_buy_quantity", "total_buy"),
            tick.get("totalBuyQuantity"),
        ))
        entry["totalSellQuantity"] = _fnum(first(
            msrc("volume", "sell_volume_today"),
            lsrc("total_sell_quantity", "total_sell"),
            tick.get("totalSellQuantity"),
        ))
        entry["upperCircuit"] = _fnum(first(
            msrc("price", "upper_circuit_limit"),
            lsrc("upper_circuit_limit"),
            tick.get("upperCircuit"),
        ))
        entry["lowerCircuit"] = _fnum(first(
            msrc("price", "lower_circuit_limit"),
            lsrc("lower_circuit_limit"),
            tick.get("lowerCircuit"),
        ))
        entry["yearlyHigh"] = _fnum(first(
            msrc("price", "yearly_high"),
            lsrc("yearly_high"),
            tick.get("yearlyHigh"),
        ))
        entry["yearlyLow"] = _fnum(first(
            msrc("price", "yearly_low"),
            lsrc("yearly_low"),
            tick.get("yearlyLow"),
        ))
        if entry.get("turnover") is None:
            entry["turnover"] = _fnum(first(
                msrc("trade", "total_traded_value"),
                lsrc("total_traded_value"),
                tick.get("turnover"),
            ))
        entry["tradedValue"] = entry.get("turnover")
        entry["lastTradeTime"] = _epoch(first(
            msrc("trade", "last_trade_time"),
            lsrc("last_trade_time", "last_update_time"),
            tick.get("timestamp"),
        ))

        bid = _fnum(first(
            msrc("derived", "best_bid_price"),
            lsrc("bp", "bid_price"),
            tick.get("bid"),
        ))
        ask = _fnum(first(
            msrc("derived", "best_ask_price"),
            lsrc("sp", "ask_price"),
            tick.get("ask"),
        ))
        bid_qty = _fnum(first(
            msrc("derived", "best_bid_quantity"),
            lsrc("bq", "bid_qty", "bidQty"),
            tick.get("bidQty"),
        ))
        ask_qty = _fnum(first(
            msrc("derived", "best_ask_quantity"),
            lsrc("sq", "ask_qty", "askQty"),
            tick.get("askQty"),
        ))
        entry["bid"] = bid
        entry["ask"] = ask
        entry["bidQty"] = bid_qty
        entry["askQty"] = ask_qty

        buy = first(msrc("depth", "buy"), lsrc("buy"), tick.get("buy"))
        sell = first(msrc("depth", "sell"), lsrc("sell"), tick.get("sell"))
        if isinstance(buy, list) and isinstance(sell, list) and (buy or sell):
            entry["depth"] = {"buy": list(buy)[:10], "sell": list(sell)[:10]}

        if bid is not None and ask is not None:
            entry["spread"] = _fnum(round(ask - bid, 4))
            entry["midPrice"] = _fnum(round((bid + ask) / 2.0, 4))
        else:
            entry["spread"] = None
            entry["midPrice"] = None

        if (entry.get("totalBuyQuantity") or 0) > 0 and (entry.get("totalSellQuantity") or 0) > 0:
            entry["buySellRatio"] = _fnum(round(entry["totalBuyQuantity"] / entry["totalSellQuantity"], 4))
        else:
            entry["buySellRatio"] = None

        received_at = tick.get("receivedAt")
        if isinstance(received_at, (int, float)):
            entry["dataAgeSec"] = round(max(0.0, now - received_at), 3)
        else:
            entry["dataAgeSec"] = None

    # ------------------------------------------------------------------
    # Status computation (doc §20, §27)
    # ------------------------------------------------------------------
    def _update_statuses(self, now: float) -> None:
        stale_after = self._stale_threshold()
        no_data_after = stale_after * self._no_data_multiplier()
        # A universe token that never produced a tick while the feed has been
        # up long past a stale window is confirmed-no-data (doc §20 NO_DATA).
        feed_active = self._feed_state == FEED_CONNECTED and (now - self._feed_connected_at) >= stale_after
        if feed_active:
            self._no_data_tokens = {
                t for t in self._universe
                if t not in self._records and (now - self._feed_connected_at) >= no_data_after
            }
        for entry in self._records.values():
            last = entry.get("lastTickAt")
            if last is None:
                entry["status"] = STATUS_PENDING
            elif (now - last) > stale_after:
                entry["status"] = STATUS_STALE
            else:
                entry["status"] = STATUS_LIVE

        # doc §20/§27: a stock whose feed went stale must not keep claiming to be
        # an ACTIVE gainer. Re-derive the stock state and classification on the
        # status cadence so STALE/NO_DATA/DANGER stay honest even between ticks.
        try:
            cfg = self.mw_config()
        except Exception:
            return
        with self._lock:
            states = list(self._states.values())
        for state in states:
            try:
                state.refresh_status(now, stale_after)
                state.recompute_circuit_status(cfg)
                state.evaluate_stock_state(
                    now=now, stale_after=stale_after, cfg=cfg
                )
            except Exception as exc:  # never let one bad symbol stall the loop
                logger.debug("[MARKET_WATCH_STATE] refresh failed for %s: %s", state.instrument_token, exc)

    def _no_data_multiplier(self) -> float:
        try:
            return max(2.0, float(rt_int(SETTING_NO_DATA_MULTIPLIER, NO_DATA_MULTIPLIER)))
        except Exception:
            return float(NO_DATA_MULTIPLIER)

    def _status_counts(self, now: float) -> dict:
        stale_after = self._stale_threshold()
        # doc §16: capped tokens are not being watched, so they are neither
        # LIVE, STALE, PENDING nor NO_DATA — the strip reports the watch list.
        with self._lock:
            capped = set(self._capped_tokens)
            records = {t: r for t, r in self._records.items() if t not in capped}
            no_data = len(self._no_data_tokens - capped)
        live = stale = 0
        for entry in records.values():
            last = entry.get("lastTickAt")
            if last is None or (now - last) > stale_after:
                stale += 1
            else:
                live += 1
        pending = max(0, len(self._universe) - len(capped) - len(records) - no_data)
        return {
            "PENDING": pending,
            "LIVE": live,
            "STALE": stale,
            "NO_DATA": no_data,
            "INACTIVE": self._inactive_count,
            "PRICE_CAPPED": len(capped),
        }

    def status_counts(self) -> dict:
        return self._status_counts(time.time())

    def _stock_state_counts(self) -> tuple[dict[str, int], dict[str, int]]:
        """doc §27/§30 — distribution of stock states and classifications.

        All six stock-state and all five classification keys are always present
        (zero-filled) so a consumer never has to handle a missing bucket.
        """
        stock_counts: dict[str, int] = {name: 0 for name in mw_config.STOCK_STATES}
        classification_counts: dict[str, int] = {name: 0 for name in mw_config.CLASSIFICATIONS}
        with self._lock:
            states = list(self._states.values())
        for state in states:
            if state.stock_state in stock_counts:
                stock_counts[state.stock_state] += 1
            if state.classification in classification_counts:
                classification_counts[state.classification] += 1
        return stock_counts, classification_counts

    def feed_state(self) -> str:
        return self._feed_state

    # ------------------------------------------------------------------
    # Ranking loop (doc §9, §19)
    # ------------------------------------------------------------------
    async def _ranking_loop(self) -> None:
        while True:
            interval = float(rt_int(SETTING_RANKING_INTERVAL, RANKING_INTERVAL_SECONDS))
            try:
                await asyncio.sleep(interval)
                await self._run_ranking()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.debug("[MARKET_WATCH] ranking cycle skipped: %s", exc)

    async def _run_ranking(self) -> None:
        started = time.time()
        now = started
        trading_date = _current_trading_date()
        if not trading_date:
            return

        self._maybe_refresh_universe()
        self._ensure_trading_day(trading_date)
        with self._lock:
            self._update_statuses(now)

        # Stale/valid-data policy (doc §27): only fresh rows enter the ranking set.
        stale_after = self._stale_threshold()
        with self._lock:
            rows = [
                dict(r) for r in self._visible_records()
                if r.get("lastTickAt") and (now - r["lastTickAt"]) <= stale_after
                and r.get("changePercent") is not None
            ]

        gainers = sorted(
            [r for r in rows if r["changePercent"] > 0],
            key=lambda r: (-r["changePercent"], str(r.get("symbol", ""))),
        )
        losers = sorted(
            [r for r in rows if r["changePercent"] < 0],
            key=lambda r: (r["changePercent"], str(r.get("symbol", ""))),
        )

        try:
            snapshot = market_watch_ranking.record_snapshot(
                gainers, losers,
                volume_rows=[r for r in rows if r.get("volume") is not None],
                trading_date=trading_date,
                now=now,
            )
            self._last_ranking_at = now
            self._last_ranking_duration_ms = (time.time() - started) * 1000.0
            self.set_metric("rankingDurationMs", self._last_ranking_duration_ms)
            self.set_metric("lastRankingAt", now)
            self._track_pin_changes(trading_date)
            logger.info(
                "[MARKET_WATCH_RANKING_COMPLETED] date=%s snapshot=%s gainers=%d losers=%d elapsed=%.1fms",
                trading_date,
                "ok" if snapshot else "skipped",
                len(gainers), len(losers),
                self._last_ranking_duration_ms,
            )
            self._publish(trading_date, now)
            await self._broadcast_state(trading_date, reason="ranking")
        except Exception as exc:
            logger.warning("[MARKET_WATCH] ranking record failed: %s", exc)

        # doc §14: the OFFICIAL boards, computed from the typed live state and
        # capped at the configured maximum (Top 100 is a target, never a
        # guarantee — an empty board stays empty).
        try:
            await self._run_official_rankings(trading_date, now)
        except Exception as exc:
            logger.warning("[MARKET_WATCH] official ranking failed: %s", exc)

    # ------------------------------------------------------------------
    # doc §14 official rankings + doc §15 publish set
    # ------------------------------------------------------------------
    async def _run_official_rankings(self, trading_date: str, now: float) -> None:
        cfg = self.mw_config()
        limit = cfg.universe.ranking_max_entries
        stale_after = cfg.cadence.stale_threshold_seconds
        states = [s for s in self._states.values() if s.ltp is not None]
        fresh = [s for s in states if s.last_tick_time and (now - s.last_tick_time) <= stale_after]
        eligible = [
            s for s in fresh
            if s.instrument_token in self._eligible_tokens
            and s.instrument_token not in self._capped_tokens
        ]

        def row(s: SymbolState) -> dict[str, Any]:
            payload = {
                "symbol": s.symbol,
                "instrumentToken": s.instrument_token,
                "ltp": s.ltp,
                "change": s.change,
                "changePct": s.change_pct,
                "volume": s.volume,
                "vwap": s.vwap,
                "turnover": (s.vwap * s.volume) if (s.vwap is not None and s.volume is not None) else None,
                "tickCount": s.tick_count,
                "dataQuality": s.data_quality,
                "upperCircuit": s.upper_circuit,
                "lowerCircuit": s.lower_circuit,
                "circuitDistanceUpperPct": s.circuit_distance_upper_pct,
                "circuitDistanceLowerPct": s.circuit_distance_lower_pct,
                "circuitDistancePct": s.min_circuit_distance_pct(),
                "circuitStatus": s.circuit_status,
                "marginValue": s.margin_value,
                "marginMultiplier": s.margin_multiplier,
                "marginStatus": s.margin_status,
                "intradayStatus": s.intraday_status,
                "classification": s.classification,
                "stockState": s.stock_state,
                "movementFlags": dict(s.movement_flags),
                "lastTickAt": s.last_tick_time,
                "dataCompleteness": s.data_completeness,
                "timeframes": {
                    tf: {
                        "change": s.timeframe(tf).price_move,
                        "changePct": s.timeframe(tf).change_pct,
                        "volume": s.timeframe(tf).volume,
                        "dataQuality": s.timeframe(tf).data_quality,
                    }
                    for tf in TIMEFRAMES
                },
            }
            # doc §19 flat per-timeframe contract fields.
            for tf in TIMEFRAMES:
                payload[f"change_{tf}"] = s.timeframe(tf).price_move
                payload[f"change_{tf}_pct"] = s.timeframe(tf).change_pct
            return payload

        mover_threshold = cfg.weekly.mover_threshold_pct

        def movers(tf: str, reverse: bool) -> list[dict[str, Any]]:
            rows = [
                s for s in eligible
                if s.timeframe(tf).change_pct is not None and s.timeframe(tf).data_quality != "UNAVAILABLE"
            ]
            rows.sort(key=lambda s: (s.timeframe(tf).change_pct, s.symbol), reverse=reverse)
            return [row(s) for s in rows[:limit]]

        def top_movers(tf: str, reverse: bool) -> list[dict[str, Any]]:
            """doc §21/§22 — Top 1% movers for one timeframe.

            ``abs(change_pct) >= mover_threshold``. A DANGER or
            INTRADAY_UNAVAILABLE stock leaves the active calculation set
            (doc §14/§15) so it cannot top a mover board.
            """
            rows = [
                s for s in eligible
                if s.timeframe(tf).change_pct is not None
                and abs(s.timeframe(tf).change_pct) >= mover_threshold
                and s.stock_state not in _NON_ACTIVE_STOCK_STATES
            ]
            rows.sort(key=lambda s: (s.timeframe(tf).change_pct, s.symbol), reverse=reverse)
            return [row(s) for s in rows[:limit]]

        boards: dict[str, list[dict[str, Any]]] = {
            "top_gainers": [row(s) for s in sorted(
                [s for s in eligible if (s.change_pct or 0) > 0],
                key=lambda s: (-(s.change_pct or 0.0), s.symbol),
            )[:limit]],
            "top_losers": [row(s) for s in sorted(
                [s for s in eligible if (s.change_pct or 0) < 0],
                key=lambda s: (s.change_pct or 0.0, s.symbol),
            )[:limit]],
            "highest_volume": [row(s) for s in sorted(
                [s for s in eligible if s.volume], key=lambda s: (-(s.volume or 0.0), s.symbol),
            )[:limit]],
            "most_active": [row(s) for s in sorted(
                [s for s in eligible if s.tick_count], key=lambda s: (-s.tick_count, s.symbol),
            )[:limit]],
            "circuit_near": [row(s) for s in sorted(
                [s for s in eligible if circuit_near(s, cfg)],
                key=lambda s: (s.tick_count, s.symbol), reverse=True,
            )[:limit]],
            # doc §22: Circuit Near / Danger is two boards, not one.
            "circuit_danger": [row(s) for s in sorted(
                [s for s in eligible if s.circuit_status == "DANGER" or s.circuit_status == "HIT"],
                key=lambda s: (s.min_circuit_distance_pct() if s.min_circuit_distance_pct() is not None else 99.0, s.symbol),
            )[:limit]],
        }
        for tf in TIMEFRAMES:
            boards[f"movers_{tf}"] = movers(tf, True)
            boards[f"decliners_{tf}"] = movers(tf, False)
            # doc §21/§22: the 1% boards are separate from the raw movers.
            boards[f"movers_1pct_{tf}"] = top_movers(tf, True)
            boards[f"decliners_1pct_{tf}"] = top_movers(tf, False)

        self._official_rankings = boards
        self._last_official_ranking_at = now
        self.set_metric("officialRankingAt", now)
        self.set_metric("officialRankingBoards", len(boards))

        # doc §15: the top-ranked tokens join the high-frequency publish set.
        ranked_tokens: list[str] = []
        for name in (
            "top_gainers", "top_losers", "highest_volume", "most_active",
            "circuit_near", "circuit_danger",
        ):
            ranked_tokens.extend(str(r.get("instrumentToken")) for r in boards.get(name, []))
        publish_policy.set_ranked(ranked_tokens)

        from services.market_watch_publish import ranking_update_event

        await self._publish_event(
            ranking_update_event({
                "tradingDate": trading_date,
                "rankingIntervalSeconds": cfg.cadence.ranking_interval_seconds,
                "maxEntries": limit,
                "counts": {name: len(rows) for name, rows in boards.items()},
                **boards,
            })
        )

    def official_rankings(self) -> dict[str, list[dict[str, Any]]]:
        with self._lock:
            return {name: list(rows) for name, rows in self._official_rankings.items()}

    # ------------------------------------------------------------------
    # doc §5 lifecycle / doc §15 enforcement / doc §17 indexes
    # ------------------------------------------------------------------
    async def _lifecycle_loop(self) -> None:
        """Drive the phase machine, enforce blocks, stop at 15:15, report at 15:20."""
        while True:
            try:
                await asyncio.sleep(1.0)
                await self._lifecycle_tick()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.record_error("market_watch_lifecycle_error", str(exc))
                await asyncio.sleep(2.0)

    async def _lifecycle_tick(self) -> None:
        cfg = self.mw_config()
        # doc §23: reconcile the persistence on/off switches once per status
        # tick so an operator flip is honoured without a backend restart.
        self.reconcile_storage_switches(cfg.storage)
        trading_date = _current_trading_date()
        if trading_date:
            self._ensure_trading_day(trading_date)

        # doc §2 step 8: the Saturday weekly review happens AFTER the close, so
        # it must be evaluated BEFORE the runtime-window gate below. This is the
        # one Market Watch action that is deliberately allowed outside
        # 08:50-15:30: it reads saved Mon-Fri data and writes an ADVISORY report.
        # It never touches membership (that is the operator's LOCK, doc §5).
        await self._weekly_review_tick(cfg)

        # Friday 3:25 PM scan: refresh the weekly universe with filtered stocks
        # (intraday eligible, LTP < 800, margin >= 5x). It has its own Friday +
        # time guard (the scan must start before the 15:30 runtime stop) and
        # runs the slow screen in a background task.
        await self._friday_scan_tick(cfg)

        # Flush the persisted weekly crossing counters on the same cadence as
        # the storage-switch reconcile. A flush failure is swallowed inside the
        # helper: the counters are re-derived from candles at review time, so
        # losing one must never disturb the tick path or the lifecycle.
        await self.flush_week_crossings()

        # Check runtime window - engine is completely inactive outside window
        if not self._in_runtime_window():
            # Outside runtime window - ensure engine is in RUNTIME_INACTIVE state
            if self._lifecycle_state != RUNTIME_INACTIVE:
                self._lifecycle_state = RUNTIME_INACTIVE
                self.set_metric("lifecycleState", RUNTIME_INACTIVE)
                logger.info("[MARKET_WATCH] Runtime window ended - engine entering RUNTIME_INACTIVE")
            # Ensure no subscriptions or work happens outside window
            await self._ensure_stopped()
            return
        
        # Inside runtime window - normal lifecycle evaluation
        state = market_watch_lifecycle.evaluate(
            has_ranking=bool(self._last_official_ranking_at),
            trading_date=trading_date or "",
        )
        self._lifecycle_state = state
        self.set_metric("lifecycleState", state)

        if state in DISCOVERY_STATES:
            self._seed_states()
        if state in ACTIVE_STATES:
            # doc §16: re-evaluate the price cap (catches states seeded before
            # capping started and re-admits stocks under a raised cap), then
            # push any membership change into the broker subscription.
            self._sweep_price_cap()
            self._enforce_blocks()
            if self._price_cap_dirty:
                await self._push_price_cap_sync()
        if state == MARKET_WATCH_STOPPED and trading_date and self._stop_done_for != trading_date:
            await self._stop_market_watch(trading_date)
        if state == REPORTING and trading_date and self._report_for != trading_date:
            await self._generate_eod_report(trading_date)

    def _on_lifecycle_transition(self, previous: str, current: str) -> None:
        self.set_metric("lifecycleState", current)
        self.set_metric("lifecyclePrevious", previous or None)
        logger.info("[MARKET_WATCH_LIFECYCLE_TRANSITION] %s -> %s", previous or "-", current)
        self._queue_publish_event({"type": "market_watch.status", **self._lifecycle_status()})

    def _lifecycle_status(self) -> dict[str, Any]:
        snap = market_watch_lifecycle.snapshot(trading_date=self._trading_date)
        payload = snap.to_dict()
        payload["eligibleCount"] = len(self._eligible_tokens)
        payload["subscribedCount"] = len(self._subscribed_tokens)
        payload["universeState"] = universe_state(
            self.mw_config().universe, len(self._eligible_tokens)
        )
        return payload

    def _enforce_blocks(self) -> None:
        """doc §6/§7: evaluate eligibility and persist block decisions.

        Runs on the status cadence, not per tick, so a block is recorded once
        (the ledger suppresses duplicate writes) instead of churning per tick.
        A blocked symbol is NOT silently re-admitted: re-entry requires the
        configured explicit re-entry rule (doc §6).
        """
        cfg = self.mw_config()
        if self._lifecycle_state not in ACTIVE_STATES:
            return
        now = time.time()
        for state in self._states.values():
            if state.instrument_token not in self._eligible_tokens:
                continue
            entry = block_ledger.entry(state.instrument_token)
            was_blocked = entry is not None and entry.status == "BLOCKED"
            if was_blocked:
                reentry_allowed = (
                    cfg.ledger.reentry_enabled
                    and entry.reason in cfg.ledger.reentry_reasons
                )
                if not reentry_allowed:
                    continue
            self._eligibility_evaluated += 1
            decision = evaluate_state(state, cfg)
            if decision.eligible:
                block_ledger.record_active(state.instrument_token, state.symbol)
                if was_blocked:
                    reentered = block_ledger.record_reentry(state.instrument_token, now)
                    if reentered is not None:
                        self._reentries_recorded += 1
                        state.unblock()
                        self._queue_publish_event(blocked_event(reentered, blocked=False))
                        logger.info(
                            "[MARKET_WATCH_UNBLOCKED] token=%s symbol=%s reason=%s",
                            state.instrument_token, state.symbol, reentered.reason,
                        )
                continue
            state.block(
                decision.reason or "DATA_INVALID", decision.threshold, decision.observed, now
            )
            recorded = block_ledger.record_block(
                state.instrument_token,
                state.symbol,
                reason=decision.reason or "DATA_INVALID",
                threshold=decision.threshold,
                observed=decision.observed,
                detail=decision.detail,
                circuit_block_pct=decision.circuit_block_pct,
                now=now,
            )
            if recorded is None:
                continue
            newly_blocked = not was_blocked and recorded.status == "BLOCKED"
            if newly_blocked:
                self._blocks_recorded += 1
                self.set_metric("blocksRecorded", self._blocks_recorded)
                self._queue_publish_event(blocked_event(recorded, blocked=True))
                logger.info(
                    "[MARKET_WATCH_BLOCKED] token=%s symbol=%s reason=%s observed=%s threshold=%s",
                    state.instrument_token, state.symbol, decision.reason,
                    decision.observed, decision.threshold,
                )
        self.set_metric("eligibilityEvaluated", self._eligibility_evaluated)

    async def _stop_market_watch(self, trading_date: str) -> None:
        """doc §26 15:15 stop — Market Watch work and subscriptions only.

        The global Kotak WebSocket is NOT closed and the Session Manager is NOT
        asked to log out: other engines may still need the feed.
        """
        self._stop_done_for = trading_date
        logger.info("[MARKET_WATCH_STOPPED] market watch work stops for %s (global broker WS untouched)", trading_date)
        try:
            closed = timeframe_engine.close_open_candles(trading_date)
            logger.info("[MARKET_WATCH_CANDLES_CLOSED] forced-close=%d", closed)
        except Exception as exc:
            logger.warning("[MARKET_WATCH] candle force-close failed: %s", exc)
        if self._committer is not None:
            try:
                await self._committer.flush()
            except Exception as exc:
                logger.debug("[MARKET_WATCH] committer flush: %s", exc)
        # Expire Market Watch's own subscriptions by releasing its desired set
        # and asking the WebSocket Engine (the owner of the broker feed) to
        # reconcile. The global Kotak WebSocket is NOT closed here and no logout
        # is requested: other engines may still need the feed.
        try:
            with self._lock:
                released = len(self._eligible_tokens)
            from api.ws_engine import get_wired_engine

            wired = get_wired_engine()
            result = await wired.reconcile_broker_subscriptions()
            logger.info(
                "[MARKET_WATCH_SUBSCRIPTIONS_EXPIRED] released=%d wanted=%s unsub=%s",
                released, result.get("wanted"), result.get("to_unsubscribe"),
            )
        except Exception as exc:
            logger.debug("[MARKET_WATCH] subscription expiry: %s", exc)
        self._queue_publish_event({"type": "market_watch.status", **self._lifecycle_status()})

    async def _ensure_stopped(self) -> None:
        """Ensure engine is completely stopped - clear subscriptions and stop work.
        
        Called when outside runtime window. Does NOT stop global broker session.
        """
        if self._lifecycle_state in (RUNTIME_INACTIVE, MARKET_WATCH_STOPPED, REPORTING, COMPLETED):
            return  # Already stopped
        
        logger.info("[MARKET_WATCH] Runtime window ended - forcing engine stop")
        
        # Clear eligible tokens to stop subscriptions
        with self._lock:
            self._eligible_tokens.clear()
            self._capped_tokens.clear()
            self._subscribed_tokens.clear()
        
        # Ask WebSocket Engine to reconcile (will unsubscribe Market Watch tokens)
        try:
            from api.ws_engine import get_wired_engine
            wired = get_wired_engine()
            result = await wired.reconcile_broker_subscriptions()
            logger.info(
                "[MARKET_WATCH_SUBSCRIPTIONS_CLEARED] unsubscribed=%s",
                result.get("to_unsubscribe"),
            )
        except Exception as exc:
            logger.debug("[MARKET_WATCH] subscription clear: %s", exc)
        
        self._lifecycle_state = RUNTIME_INACTIVE
        self.set_metric("lifecycleState", RUNTIME_INACTIVE)
        self._queue_publish_event({"type": "market_watch.status", **self._lifecycle_status()})

    async def _generate_eod_report(self, trading_date: str) -> None:
        """doc §26 EOD report (~15:20, ready by ~15:25)."""
        from services.market_watch_report import build_report, persist

        self._report_for = trading_date
        started = time.time()
        try:
            report = build_report(
                trading_date=trading_date,
                states=self._states,
                eligible_tokens=sorted(self._eligible_tokens),
                subscribed_tokens=sorted(self._subscribed_tokens),
                ledger=block_ledger,
                lifecycle_snapshot=self._lifecycle_status(),
                stats=self.status_snapshot().get("metrics", {}).get("custom", {}),
                started_at=started,
            )
            persist(report)
            logger.info(
                "[MARKET_WATCH_EOD_REPORT] date=%s eligible=%s blocked=%s duration=%.1fms",
                trading_date, report["counts"]["eligible"], report["counts"]["blocked"],
                report.get("generationDurationMs") or 0.0,
            )
        except Exception as exc:
            logger.error("[MARKET_WATCH] EOD report failed: %s", exc)

    # ------------------------------------------------------------------

    async def _weekly_review_tick(self, cfg=None) -> None:
        """doc §2 step 8 — generate the advisory Saturday weekly report.

        Runs on the 1s lifecycle cadence but does real work at most once per
        review week, guarded by three independent conditions:

        1. ``weekly.enabled`` must be on.
        2. The current IST weekday must equal ``weekly.review_weekday`` and the
           clock must have reached ``weekly.review_hhmm``.
        3. No report may already exist for the week being reviewed.

        Condition 3 is what makes a backend restart safe: the report is keyed by
        ``weekId`` and written through the DB Writer, so re-running the tick can
        never produce a second report for the same review.

        This NEVER changes membership. The report is advisory (doc §5); the
        operator's ADD/REMOVE/KEEP and LOCK are the only authority.
        """
        try:
            weekly_cfg = (cfg or self.mw_config()).weekly
            if not getattr(weekly_cfg, "enabled", False):
                return
            now = now_ist()
            if now.weekday() != int(getattr(weekly_cfg, "review_weekday", 5)):
                return
            hhmm = str(getattr(weekly_cfg, "review_hhmm", "18:00") or "18:00")
            try:
                hour_text, _, minute_text = hhmm.partition(":")
                review_minutes = int(hour_text) * 60 + int(minute_text or 0)
            except Exception:
                review_minutes = 18 * 60
            if (now.hour * 60 + now.minute) < review_minutes:
                return

            from services import market_watch_weekly as _mw_weekly
            from services import market_watch_universe as _mw_universe

            # The report describes the week that just FINISHED.
            week_id = _mw_universe.week_id_for(now)
            if self._weekly_report_for == week_id:
                return
            existing = await _mw_weekly.load_report(week_id)
            if existing is not None:
                self._weekly_report_for = week_id
                self.set_metric("weeklyReportWeekId", week_id)
                return

            report = await _mw_weekly.build_weekly_report(week_id)
            persisted = await asyncio.to_thread(_mw_weekly.persist, report)
            self._weekly_report_for = week_id
            counts = report.get("counts", {})
            self.set_metric("weeklyReportWeekId", week_id)
            self.set_metric("weeklyReportGeneratedAt", report.get("generatedAt"))
            self.set_metric("weeklyReportCounts", counts)
            if persisted:
                logger.info(
                    "[MARKET_WATCH_WEEKLY_REPORT] week=%s reviewed=%s add=%s remove=%s keep=%s review=%s",
                    week_id, counts.get("reviewed"), counts.get("recommendAdd"),
                    counts.get("recommendRemove"), counts.get("recommendKeep"),
                    counts.get("recommendReview"),
                )
                self._queue_publish_event({
                    "type": "market_watch.status",
                    **self._lifecycle_status(),
                })
            else:
                # Honest failure: the report was built but not accepted by the
                # DB Writer. No retry storm — the next tick sees no stored report
                # and will try again on the following pass.
                logger.error(
                    "[MARKET_WATCH_WEEKLY_REPORT] week=%s built but DB Writer rejected it", week_id
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error("[MARKET_WATCH] weekly review tick failed: %s", exc)

    # ------------------------------------------------------------------
    # Friday 3:25 PM weekly universe scan
    # ------------------------------------------------------------------
    async def _friday_scan_tick(self, cfg=None) -> None:
        """Start the Friday 15:25 scan without blocking the lifecycle loop.

        Runs on the 1s lifecycle cadence but starts real work at most once per
        Friday, guarded by five independent conditions:

        1. ``weekly.enabled`` must be on.
        2. The current IST weekday must be Friday (4) and the clock must have
           reached ``weekly.friday_scan_hhmm`` (default 15:25).
        3. It must be a trading day (a holiday has no fresh LTP/margin).
        4. No scan may already have completed for the current ISO week.
        5. No scan may already be in flight, or in its post-failure back-off.

        The screen itself runs in a background task: resolving prices and broker
        margin for the whole NSE universe takes minutes, and blocking the 1 s
        lifecycle loop would also block the 15:30 stop and the EOD report.
        """
        try:
            weekly_cfg = (cfg or self.mw_config()).weekly
            if not getattr(weekly_cfg, "enabled", False):
                return
            now = now_ist()
            if now.weekday() != 4:
                return
            # A market holiday has no fresh LTP/margin to screen; the next
            # trading Friday will run instead (a manual run is still allowed).
            if not market_calendar.is_trading_day(now):
                return
            scan_minutes = _hhmm_to_minutes(
                getattr(weekly_cfg, "friday_scan_hhmm", "15:25"), 15 * 60 + 25
            )
            if (now.hour * 60 + now.minute) < scan_minutes:
                return

            from services.market_watch_universe import week_id_for
            scan_week = week_id_for(now)
            if self._friday_scan_done_for == scan_week:
                return
            if self._friday_scan_running_for == scan_week:
                return
            if time.time() < self._friday_scan_retry_at:
                return

            self._friday_scan_running_for = scan_week
            logger.info("[MARKET_WATCH_FRIDAY_SCAN] Scheduling scan for week %s", scan_week)
            self._friday_scan_task = asyncio.create_task(self._run_friday_scan_auto(scan_week))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error("[MARKET_WATCH] Friday scan tick failed: %s", exc)

    async def _run_friday_scan_auto(self, scan_week: str) -> None:
        """Background wrapper: retry a failed scan slowly, never per tick."""
        try:
            result = await self.run_friday_scan(triggered_by="auto")
            logger.info(
                "[MARKET_WATCH_FRIDAY_SCAN] auto finished ok=%s target=%s symbols=%s reason=%s",
                result.get("ok"), result.get("targetWeekId"),
                result.get("symbolCount"), result.get("reason"),
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._friday_scan_retry_at = time.time() + 300.0
            logger.error("[MARKET_WATCH] Friday scan failed: %s", exc)
        finally:
            if self._friday_scan_running_for == scan_week:
                self._friday_scan_running_for = ""

    async def run_friday_scan(
        self,
        *,
        triggered_by: str = "manual",
        target_week_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Guarded entry point for the Friday scan.

        The pipeline lives in :meth:`_run_friday_scan`. This wrapper owns the
        in-flight guard so a manual API call cannot race the automatic task (or
        another manual call), and the 1 s lifecycle tick cannot start an
        automatic scan while a manual one is already screening.
        """
        from services.market_watch_universe import week_id_for

        scan_week = week_id_for(now_ist())
        if triggered_by == "manual" and self._friday_scan_running_for:
            return {
                "ok": False,
                "triggered": False,
                "reason": "SCAN_IN_PROGRESS",
                "scanWeekId": scan_week,
                "targetWeekId": target_week_id,
                "message": "A Friday universe scan is already running",
            }
        owned = False
        if not self._friday_scan_running_for:
            # A manual run must also block the 15:25 automatic task.
            self._friday_scan_running_for = scan_week
            owned = True
        try:
            return await self._run_friday_scan(
                triggered_by=triggered_by, target_week_id=target_week_id,
            )
        finally:
            if owned and self._friday_scan_running_for == scan_week:
                self._friday_scan_running_for = ""

    async def _run_friday_scan(
        self,
        *,
        triggered_by: str = "manual",
        target_week_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Screen the full NSE equity universe, lock it and subscribe it.

        The screen (``market_watch_weekly_scan.run_scan``) keeps only stocks
        that are:

        * intraday-eligible (an explicit broker MIS answer, not UNKNOWN),
        * below the configured LTP cap (default ₹800),
        * at or above the configured margin multiplier (default 5x).

        The survivors become the **next** week's LOCKED Market Watch universe.
        Locking on Friday rather than Saturday is deliberate: Friday 15:25 is
        the last liquid observation point of the week, and the upcoming week's
        membership must be ready before Monday. The Saturday review remains
        advisory; if it already locked the target week, this scan refuses to
        overwrite it (doc §33).

        After the lock the engine reloads, rebuilds its registry, applies the
        Session Manager daily-universe intent (``expires_at=None`` — no expiry)
        and, while inside the runtime window, asks the WebSocket Engine to
        reconcile immediately. The resulting ticks then flow through the normal
        validated-tick pipeline and are persisted by the DB Writer. A scan that
        finishes after the 15:30 stop records the same intent but defers the
        socket reconcile to the next session.
        """
        from services.market_watch_universe import (
            is_locked,
            lock_universe,
            next_week_id_for,
            week_id_for,
        )
        from services.market_watch_weekly_scan import run_scan

        now = now_ist()
        scan_week = week_id_for(now)
        target_week = str(target_week_id or next_week_id_for(now))
        logger.info(
            "[MARKET_WATCH_FRIDAY_SCAN] start trigger=%s scan_week=%s target_week=%s",
            triggered_by, scan_week, target_week,
        )

        # Refuse BEFORE the expensive full-market screen when the target is
        # already frozen. This also prevents a restart after a completed scan
        # from re-running the whole screen only to hit the lock guard.
        if await is_locked(target_week):
            reason = "WEEK_ALREADY_LOCKED"
            detail = f"week {target_week} is already LOCKED (doc §33)"
            self._record_friday_scan(
                scan_week, target_week, 0, triggered_by,
                version=None, reason=reason,
            )
            self._publish_friday_scan_status()
            return {
                "ok": False,
                "triggered": True,
                "trigger": triggered_by,
                "scanWeekId": scan_week,
                "targetWeekId": target_week,
                "weekId": target_week,
                "symbolCount": 0,
                "reason": reason,
                "detail": detail,
                "message": f"Universe for {target_week} was not changed: {detail}",
            }

        scan_result = await run_scan(
            week_id=scan_week,
            target_week_id=target_week,
            dry_run=False,
            seed_draft=True,
            # The Friday rule is non-negotiable: a broker-confirmed margin of
            # at least the configured multiplier. This override keeps the
            # older global switch from silently disabling it.
            require_margin=True,
        )
        selected = scan_result.selected_symbols
        # The full per-symbol evidence is persisted in
        # ``market_watch_weekly_screen``. The command response carries the
        # counts only: returning thousands of rejected rows over HTTP would be
        # slow and the UI never renders them here.
        scan_payload = scan_result.to_dict()
        scan_payload.pop("selected", None)
        scan_payload.pop("rejected", None)
        payload: dict[str, Any] = {
            "ok": True,
            "triggered": True,
            "trigger": triggered_by,
            "scanWeekId": scan_week,
            "targetWeekId": target_week,
            "weekId": target_week,
            "symbolCount": len(selected),
            "scan": scan_payload,
        }
        logger.info(
            "[MARKET_WATCH_FRIDAY_SCAN] screen %d/%d passed "
            "(priced=%d, margin_resolved=%d, margin_unavailable=%d)",
            len(selected), scan_result.candidates, scan_result.priced,
            scan_result.margin_resolved, scan_result.margin_unavailable,
        )

        # A partial screen is not a smaller universe — it is an unknown one.
        # Never lock survivors from a run whose candidate master or margin
        # batches failed: the missing names would silently drop out.
        fatal_errors = [
            err for err in scan_result.errors
            if str(err).startswith(("candidate load failed", "margin batch failed"))
        ]
        if fatal_errors:
            reason = "SCAN_ERROR"
            detail = "; ".join(fatal_errors[:3])
            self._record_friday_scan(
                scan_week, target_week, len(selected), triggered_by,
                version=None, reason=reason, mark_done=False,
            )
            if triggered_by == "auto":
                # Retry from the lifecycle tick after the normal back-off.
                self._friday_scan_retry_at = time.time() + 300.0
            payload.update({
                "ok": False,
                "reason": reason,
                "detail": detail,
                "message": (
                    "The full-universe screen did not complete; the previous "
                    "universe was kept"
                ),
            })
            self._publish_friday_scan_status()
            return payload

        if not selected:
            # Mark the week done anyway: a broker/margin outage must not turn
            # the lifecycle loop into a once-per-second scan storm. Manual
            # execution remains available at any time.
            self._record_friday_scan(
                scan_week, target_week, 0, triggered_by,
                version=None, reason="NO_SYMBOLS_SELECTED",
            )
            payload.update({
                "message": "No stocks passed the filter - keeping the previous universe",
                "reason": "NO_SYMBOLS_SELECTED",
            })
            self._publish_friday_scan_status()
            return payload

        try:
            lock_result = await lock_universe(
                week_id=target_week,
                symbols=selected,
                locked_by=f"friday_scan_{triggered_by}",
                notes=(
                    f"Locked by the {triggered_by} Friday scan. {len(selected)} "
                    "stocks passed the intraday / LTP below cap / margin "
                    "multiplier screen."
                ),
            )
        except PermissionError as exc:
            reason = "WEEK_ALREADY_LOCKED" if "already LOCKED" in str(exc) else "LOCK_REFUSED"
            self._record_friday_scan(
                scan_week, target_week, len(selected), triggered_by,
                version=None, reason=reason,
            )
            payload.update({
                "ok": False,
                "reason": reason,
                "detail": str(exc),
                "message": f"Universe for {target_week} was not changed: {exc}",
            })
            self._publish_friday_scan_status()
            return payload

        if not lock_result.get("persisted", False):
            self._record_friday_scan(
                scan_week, target_week, len(selected), triggered_by,
                version=None, reason="NOT_PERSISTED",
            )
            payload.update({
                "ok": False,
                "reason": "NOT_PERSISTED",
                "message": (
                    "Scan completed but the locked universe was rejected by the "
                    "DB Writer; nothing was applied"
                ),
            })
            self._publish_friday_scan_status()
            return payload

        # The in-memory engine still holds the PREVIOUS lock. Reload it before
        # rebuilding, otherwise the scan would re-apply the old membership.
        await self.load_locked_universe(refresh=True)
        self._build_universe()
        self._seed_states()

        trading_date = self._trading_date or _current_trading_date() or scan_week
        subscription: dict[str, Any] = {"rows": 0, "applied": False, "reconciled": None}
        try:
            from services.session.session_manager import get_session_manager

            sm = get_session_manager()
            session_id = (sm.snapshot() or {}).get("session_id")
            rows = self.daily_subscription_intent()
            subscription["rows"] = len(rows)
            if rows:
                # ``apply_daily_subscription_intent`` records ``expires_at=None``:
                # the universe is session-scoped, not wall-clock expiring.
                await sm.apply_daily_subscription_intent(trading_date, session_id, rows)
                subscription["applied"] = True
                logger.info(
                    "[MARKET_WATCH_FRIDAY_SCAN] applied subscription intent rows=%d date=%s (no expiry)",
                    len(rows), trading_date,
                )
            if self._in_runtime_window():
                try:
                    # Make the live socket pick up the new list now instead of
                    # waiting for the next periodic WebSocket reconcile.
                    from api.ws_engine import get_wired_engine

                    subscription["reconciled"] = await get_wired_engine().reconcile_broker_subscriptions()
                except Exception as exc:
                    subscription["reconcileError"] = str(exc)
                    logger.warning(
                        "[MARKET_WATCH_FRIDAY_SCAN] subscription reconcile failed: %s", exc
                    )
            else:
                # The scan can outlive 15:30. The locked universe and the
                # Session Manager intent are already persisted; the WebSocket
                # must NOT be re-subscribed after the engine stopped for the
                # day. Monday's scheduler intent applies it again.
                subscription["deferred"] = "outside runtime window"
        except Exception as exc:
            subscription["error"] = str(exc)
            logger.warning("[MARKET_WATCH_FRIDAY_SCAN] subscription intent failed: %s", exc)

        self._record_friday_scan(
            scan_week, target_week, len(selected), triggered_by,
            version=lock_result.get("version"), reason=None,
        )
        payload.update({
            "version": lock_result.get("version", 0),
            "lock": {k: v for k, v in lock_result.items() if k != "universe"},
            "subscription": subscription,
            "message": (
                f"Friday scan locked {target_week} v{lock_result.get('version', 0)} "
                f"with {len(selected)} stocks"
            ),
        })
        self._publish_friday_scan_status()
        return payload

    def _record_friday_scan(
        self,
        scan_week: str,
        target_week: str,
        symbols: int,
        trigger: str,
        *,
        version: Optional[int],
        reason: Optional[str],
        mark_done: bool = True,
    ) -> None:
        """Remember one scan outcome, including an honest failure reason.

        ``_friday_scan_done_for`` suppresses the AUTOMATIC 15:25 run for the
        week. A manual run only sets it when that run itself happened on Friday
        at/after the configured time; a Wednesday operator refresh must not
        silence Friday's scheduled scan. ``mark_done=False`` records a
        retryable failure (a partial screen) without claiming the week is done.
        """
        at = time.time()
        now = now_ist()
        scan_minutes = _hhmm_to_minutes(
            self.mw_config().weekly.friday_scan_hhmm, 15 * 60 + 25
        )
        if mark_done and (
            trigger == "auto"
            or (now.weekday() == 4 and (now.hour * 60 + now.minute) >= scan_minutes)
        ):
            self._friday_scan_done_for = scan_week
        self._friday_scan_last = {
            "scanWeekId": scan_week,
            "targetWeekId": target_week,
            "weekId": target_week,
            "symbols": int(symbols),
            "version": version,
            "trigger": trigger,
            "reason": reason,
            "at": at,
            "atIso": datetime.fromtimestamp(at, tz=timezone.utc).isoformat(),
        }
        self.set_metric("fridayScanWeekId", target_week)
        self.set_metric("fridayScanDataWeekId", scan_week)
        self.set_metric("fridayScanSymbols", int(symbols))
        self.set_metric("fridayScanAt", at)
        self.set_metric("fridayScanTrigger", trigger)
        self.set_metric("fridayScanReason", reason)

    def friday_scan_status(self) -> dict[str, Any]:
        """Resolved Friday scan schedule + the last observed outcome (doc §30)."""
        cfg = self.mw_config()
        now = now_ist()
        try:
            from services.market_watch_universe import next_week_id_for

            next_target = next_week_id_for(now)
        except Exception:
            next_target = None
        return {
            "enabled": bool(cfg.weekly.enabled),
            "scanWeekday": 4,
            "scanHhmm": cfg.weekly.friday_scan_hhmm,
            "nextScanAt": _next_weekday_at(now, 4, cfg.weekly.friday_scan_hhmm),
            "nextTargetWeekId": next_target,
            "priceCap": cfg.price.max_price,
            "marginMultiplierThreshold": cfg.weekly.margin_multiplier_threshold,
            "running": bool(self._friday_scan_running_for),
            "lastScan": dict(self._friday_scan_last) or None,
        }

    def _publish_friday_scan_status(self) -> None:
        try:
            self._queue_publish_event({
                "type": "market_watch.status",
                **self._lifecycle_status(),
            })
        except Exception as exc:
            logger.debug("[MARKET_WATCH_FRIDAY_SCAN] status publish skipped: %s", exc)

    # ------------------------------------------------------------------
    # doc §17 index publishing (independent of the 30s ranking cycle)
    # ------------------------------------------------------------------
    async def _index_loop(self) -> None:
        while True:
            try:
                interval = max(0.2, self.mw_config().cadence.index_publish_interval_seconds)
                await asyncio.sleep(interval)
                if self._lifecycle_state not in DATA_ACTIVE_STATES:
                    continue
                payload = index_tracker.to_dict()
                index_tracker.mark_published()
                from services.market_watch_publish import index_update_event

                await self._publish_event(index_update_event(payload))
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.record_error("market_watch_index_publish_error", str(exc))
                await asyncio.sleep(2.0)

    # ------------------------------------------------------------------
    # doc §25 coalesced publish flush
    # ------------------------------------------------------------------
    async def _publish_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(0.1)
                if self._lifecycle_state not in PUBLISHING_STATES:
                    publish_policy.drain()  # drop stale frames outside publishing
                    continue
                if not publish_policy.due():
                    continue
                # doc §18: the publish set also needs ongoing timeframe
                # updates, staged on the same coalescing window.
                self._stage_timeframes_for_publish_set()
                stocks, timeframes = publish_policy.drain()
                for event in stocks:
                    await self._publish_event(event)
                for event in timeframes:
                    await self._publish_event(event)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.record_error("market_watch_publish_error", str(exc))
                await asyncio.sleep(1.0)

    def _stage_timeframes_for_publish_set(self) -> None:
        """Stage required timeframe updates for the publish set (doc §18)."""
        for token in publish_policy.publish_set():
            state = self._states.get(token)
            if state is None:
                continue
            publish_policy.stage_timeframes(
                token,
                {
                    "symbol": state.symbol,
                    "instrumentToken": token,
                    "timeframes": state.to_public(include_timeframes=True).get("timeframes", {}),
                },
            )

    # ------------------------------------------------------------------
    # WS #3 publishing (via the Connection Manager bridge)
    # ------------------------------------------------------------------
    async def _publish_event(self, event: dict[str, Any]) -> None:
        """Publish one doc §19 event onto the frontend event bus.

        All ``market_watch.*`` frames are routed by the Connection Manager to the
        ``market_watch`` channel (WS #3). Publishing is best-effort: a bus failure
        is counted, never fatal to the tick/ranking path.
        """
        try:
            from services.event_bus import get_event_bus as _bus

            await _bus().publish(event)
        except Exception as exc:
            self.record_error("market_watch_publish_error", str(exc))

    def _queue_publish_event(self, event: dict[str, Any]) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(lambda: loop.create_task(self._publish_event(event)))
        except Exception as exc:
            logger.debug("[MARKET_WATCH] queue publish failed: %s", exc)

    # ------------------------------------------------------------------
    # WS #4 command entry point (doc §16/§18/§19)
    # ------------------------------------------------------------------
    async def handle_ws_command(self, payload: dict[str, Any]) -> Optional[dict[str, Any]]:
        """Validate and execute one Market Watch WS #4 command.

        Returns the response event to send back (``market_watch.more_snapshot`` /
        ``market_watch.status``) or ``None``. Validation failures return a
        ``market_watch.error`` event — the gateway never has to know the rules.
        """
        from services.market_watch_publish import (
            CMD_DISPLAY_INTENT,
            CMD_PIN_STOCK,
            CMD_SELECT_STOCK,
            CMD_SHOW_MORE,
            CMD_UNPIN_STOCK,
        )

        if not isinstance(payload, dict):
            return error_event(None, "400", "command payload must be an object")
        command = str(payload.get("type") or "").strip()
        request_id = str(payload.get("request_id") or payload.get("requestId") or "").strip()
        if not command:
            return error_event(request_id or None, "400", "command type is required")

        cfg = self.mw_config()
        if command == CMD_SHOW_MORE:
            ok, reason, request = validate_show_more(payload, cfg)
            if not ok:
                return error_event(request_id or None, "400", reason)
            return self._show_more(request)

        token = str(
            payload.get("instrumentToken") or payload.get("instrument_token")
            or payload.get("token") or ""
        ).strip()
        symbols = payload.get("symbols") or payload.get("tokens") or []
        if command in (CMD_SELECT_STOCK, CMD_PIN_STOCK, CMD_UNPIN_STOCK):
            if not token and isinstance(symbols, list) and symbols:
                token = str(symbols[0]).strip()
            if not token:
                return error_event(request_id or None, "400", "instrumentToken is required")
            if command == CMD_SELECT_STOCK:
                if token not in self._states:
                    return error_event(request_id or None, "404", f"unknown instrumentToken {token}")
                publish_policy.select(token)
            elif command == CMD_PIN_STOCK:
                if token not in self._states:
                    return error_event(request_id or None, "404", f"unknown instrumentToken {token}")
                publish_policy.pin(token)
            else:
                publish_policy.unpin(token)
            return {"type": "market_watch.status", "request_id": request_id or None, **self._lifecycle_status(),
                    "publishSet": publish_policy.publish_set()}
        if command == CMD_DISPLAY_INTENT:
            visible = payload.get("visible") or payload.get("tokens") or payload.get("symbols") or []
            if isinstance(visible, str):
                visible = [visible]
            if not isinstance(visible, list):
                return error_event(request_id or None, "400", "visible must be a list of instrument tokens")
            known = [str(t) for t in visible if str(t) in self._states]
            unknown = [str(t) for t in visible if str(t) not in self._states]
            publish_policy.set_visible(known)
            self._stage_timeframes_for_publish_set()
            if unknown:
                return {
                    "type": "market_watch.status", "request_id": request_id or None,
                    **self._lifecycle_status(),
                    "publishSet": publish_policy.publish_set(),
                    "ignoredTokens": unknown,
                }
            return {"type": "market_watch.status", "request_id": request_id or None,
                    **self._lifecycle_status(), "publishSet": publish_policy.publish_set()}
        return error_event(request_id or None, "400", f"unsupported Market Watch command: {command}")

    def _show_more(self, request: dict[str, Any]) -> dict[str, Any]:
        """doc §16: a paged snapshot of the eligible universe.

        Opening Show More does NOT promote anything into the continuous
        high-frequency publish set.

        Every section is paged over the FULL eligible universe ordered by its own
        real metric. The official boards are capped at the configured maximum, so
        paging them directly would silently truncate the universe at that cap.
        """
        section = str(request.get("section") or "top_gainers")
        page = max(1, int(request.get("page", 1)))
        page_size = max(1, int(request.get("page_size", 100)))
        rows = self._section_over_eligible_universe(section)
        total = len(rows)
        start = (page - 1) * page_size
        return more_snapshot_event(request, rows[start:start + page_size], total)

    def _section_over_eligible_universe(self, section: str) -> list[dict[str, Any]]:
        """Order the WHOLE eligible universe by one section's real metric."""
        live = [
            s for s in self._states.values()
            if s.instrument_token in self._eligible_tokens
            and s.instrument_token not in self._capped_tokens
            and s.ltp is not None
        ]

        def by_change(s: SymbolState) -> float:
            return s.change_pct if s.change_pct is not None else 0.0

        def by_volume(s: SymbolState) -> float:
            return s.volume if s.volume is not None else 0.0

        def by_ticks(s: SymbolState) -> float:
            return float(s.tick_count)

        if section in ("top_gainers", "top_losers"):
            ordered = sorted(live, key=lambda s: (-by_change(s), s.symbol))
            if section == "top_losers":
                ordered = sorted(live, key=lambda s: (by_change(s), s.symbol))
        elif section in ("highest_volume", "highest_turnover", "most_active"):
            ordered = sorted(live, key=lambda s: (-by_volume(s), s.symbol))
        elif section in ("near_circuit", "circuit_near"):
            def circuit_gap(s: SymbolState) -> float:
                gaps = [
                    g for g in (s.circuit_distance_upper_pct, s.circuit_distance_lower_pct)
                    if g is not None
                ]
                return min(gaps) if gaps else float("inf")
            ordered = sorted(live, key=lambda s: (circuit_gap(s), s.symbol))
        else:
            ordered = sorted(live, key=lambda s: (-by_change(s), s.symbol))
        return [s.to_compact() for s in ordered]

    # ------------------------------------------------------------------
    # doc §22 WS #3 reconnect snapshot
    # ------------------------------------------------------------------
    def reconnect_snapshot(self) -> dict[str, Any]:
        """Full Market Watch snapshot used on WS #3 reconnect (doc §22).

        The UI must not wait for the next 30-second ranking cycle to become
        consistent, so this carries the current rankings, pins, indexes, the
        publish set and the lifecycle status immediately.
        """
        cfg = self.mw_config()
        boards = self.official_rankings()
        snapshot = {
            "type": EVENT_SNAPSHOT,
            "tradingDate": self._trading_date,
            "serverTime": time.time(),
            "eligibleCount": len(self._eligible_tokens),
            "subscribedCount": len(self._subscribed_tokens),
            "universeState": universe_state(cfg.universe, len(self._eligible_tokens)),
            "lifecycle": self._lifecycle_status(),
            "publishSet": publish_policy.publish_set(),
            "stocks": {
                token: state.to_public()
                for token, state in self._states.items()
                if token in publish_policy.publish_set()
            },
            "indexes": index_tracker.to_dict(),
            "blocked": [e.to_dict() for e in block_ledger.entries() if e.status == "BLOCKED"],
            "counts": {name: len(rows) for name, rows in boards.items()},
            **boards,
        }
        return snapshot

    # ------------------------------------------------------------------
    # Trading-day reset (doc §6, §14, §27)
    # ------------------------------------------------------------------
    def _ensure_trading_day(self, trading_date: str) -> None:
        with self._lock:
            if not trading_date or trading_date == self._trading_date:
                return
            previous = self._trading_date
            if self._trading_date:
                self._records.clear()
                self._tick_cache.clear()
                self._tick_marks.clear()
                self._index_version = 0
                self._subscribed_tokens.clear()
                self._no_data_tokens.clear()
                self._reset_daily_components(previous, trading_date)
                logger.info(
                    "[MARKET_WATCH_DAY_RESET] trading day reset %s -> %s",
                    self._trading_date, trading_date,
                )
            self._trading_date = trading_date

    def _reset_daily_components(self, previous: str, trading_date: str) -> None:
        """Reset every day-scoped component built for the previous session.

        Day-scoped, so a stale candle, block, ranking or publish entry from
        yesterday must never leak into today's snapshot.
        """
        self._states.clear()
        self._eligible_tokens = set()
        # doc §16: yesterday's price cap must not leak into today's watch list.
        self._capped_tokens = set()
        self._price_cap_dirty = False
        self._stop_done_for = ""
        self._report_for = ""
        self._weekly_report_for = ""
        self._last_universe_refresh = 0.0
        self._blocks_recorded = 0
        self._reentries_recorded = 0
        self._eligibility_evaluated = 0
        self._recovery_report = {}
        # doc §2/§3/§7/§28: the locked universe is NOT day-scoped — it is the
        # weekly membership and must survive a daily rollover unchanged. Only the
        # ROLES change (today's locked symbols become the candidates).
        self._subscribed_tokens = set()
        # doc §30 counters are cumulative for the process lifetime, so they are
        # NOT reset here — only the day-scoped recovery report is.
        # Ledger is day-scoped: yesterday's blocks must not block today.
        try:
            block_ledger.configure_day(trading_date)
        except Exception as exc:
            logger.debug("[MARKET_WATCH_DAY_RESET] ledger reset: %s", exc)
        # Lifecycle transitions and schedule anchors.
        try:
            market_watch_lifecycle.reset()
        except Exception as exc:
            logger.debug("[MARKET_WATCH_DAY_RESET] lifecycle reset: %s", exc)
        # Timeframe buckets and the completed-candle ring.
        try:
            timeframe_engine.reset()
        except Exception as exc:
            logger.debug("[MARKET_WATCH_DAY_RESET] timeframe reset: %s", exc)
        # Index state, publish set and pending coalesced events.
        for component, label in ((index_tracker, "index"), (publish_policy, "publish")):
            try:
                component.reset()
            except Exception as exc:
                logger.debug("[MARKET_WATCH_DAY_RESET] %s reset: %s", label, exc)
        self.set_metric("dayResetFrom", previous)
        self.set_metric("dayResetTo", trading_date)

    # ------------------------------------------------------------------
    # Pin change detection (doc §12) + metrics
    # ------------------------------------------------------------------
    def _track_pin_changes(self, trading_date: str) -> None:
        pins = market_watch_ranking.pins()
        now_pins_g = [p["token"] for p in pins.get("gainers", [])]
        now_pins_l = [p["token"] for p in pins.get("losers", [])]

        if now_pins_g != self._prev_gainer_pins:
            self._gainer_pin_changes += 1
            self.set_metric("gainerPinChanges", self._gainer_pin_changes)
            self._emit_pin_changed("gainer", trading_date, self._prev_gainer_pins, now_pins_g)
        if now_pins_l != self._prev_loser_pins:
            self._loser_pin_changes += 1
            self.set_metric("loserPinChanges", self._loser_pin_changes)
            self._emit_pin_changed("loser", trading_date, self._prev_loser_pins, now_pins_l)

        self._prev_gainer_pins = now_pins_g
        self._prev_loser_pins = now_pins_l

    def _emit_pin_changed(self, kind: str, trading_date: str, prev: list[str], now: list[str]) -> None:
        symbols_now = [
            self._records.get(t, {}).get("symbol") or self._registry.get(t, {}).get("symbol") or t
            for t in now
        ]
        logger.info(
            "[MARKET_WATCH_PIN_CHANGED] kind=%s date=%s pins=%s",
            kind, trading_date, symbols_now,
        )

    # ------------------------------------------------------------------
    # UI publish (doc §16 — controlled/selected; indexVersion + pinned + items)
    # ------------------------------------------------------------------
    def _publish(self, trading_date: str, now: float) -> None:
        started = time.time()
        with self._lock:
            self._index_version += 1
        self._last_publish_at = now
        self._last_publish_duration_ms = (time.time() - started) * 1000.0
        # Force a fresh build so the cached payload carries the bumped version.
        with self._lock:
            self._last_ui_payload = None
        self._last_ui_payload = self.ui_payload()
        self.set_metric("uiPublishDurationMs", self._last_publish_duration_ms)
        self.set_metric("indexVersion", self._index_version)

    def last_ui_payload(self) -> dict | None:
        with self._lock:
            return self._last_ui_payload

    def generated_at(self) -> str:
        import datetime
        return datetime.datetime.now(datetime.timezone.utc).strftime("%H:%M:%S")

    def ui_payload(self) -> dict:
        """Doc §16 controlled publish: section + indexVersion + generatedAt + pinned + items."""
        cached = self.last_ui_payload()
        if cached is not None:
            cached["ok"] = True
            return cached
        now = time.time()
        self._update_statuses(now)
        trading_date = _current_trading_date()
        limit = self._section_limit()
        sections = self.get_sections(limit=limit)
        pins = market_watch_ranking.pins()

        def _section(name: str, items: list[dict]) -> dict:
            return {
                "section": name,
                "indexVersion": self._index_version,
                "generatedAt": self.generated_at(),
                "items": items,
            }

        return {
            "ok": True,
            "tradingDate": trading_date,
            "indexVersion": self._index_version,
            "generatedAt": self.generated_at(),
            "feedState": self._feed_state,
            "liveStateCount": len(self._records),
            "universeSize": len(self._universe),
            "statusCounts": self._status_counts(now),
            "pinned": {
                "gainers": pins.get("gainers", []),
                "losers": pins.get("losers", []),
            },
            "sections": [
                _section("top_gainers", sections["topGainers"]),
                _section("top_losers", sections["topLosers"]),
                _section("highest_volume", sections["highestVolume"]),
                _section("highest_turnover", sections["highestTurnover"]),
                _section("highest_absolute_change", sections["highestAbsoluteChange"]),
                _section("strong_movers", sections["strongMovers"]),
                _section("weak_movers", sections["weakMovers"]),
                _section("buying_strength", sections["buyingStrength"]),
                _section("five_minute_movers", sections["fiveMinuteMovers"]),
                _section("ten_minute_movers", sections["tenMinuteMovers"]),
            ],
        }

    def publish_sections(self) -> dict:
        return self.ui_payload()

    # ------------------------------------------------------------------
    # Public API (for the HTTP layer)
    # ------------------------------------------------------------------
    def latest_state(self, token: str) -> Optional[dict]:
        with self._lock:
            return dict(self._records.get(str(token), {}))

    def live_state_count(self) -> int:
        with self._lock:
            return len(self._records)

    def universe_size(self) -> int:
        return len(self._universe)

    def registry(self) -> list[dict]:
        with self._lock:
            return [dict(m) for m in self._registry.values()]

    def get_gainer_rows(self, limit: int = 50) -> list[dict]:
        with self._lock:
            rows = sorted(
                [dict(r) for r in self._visible_records()
                 if r.get("changePercent") is not None and r["changePercent"] > 0],
                key=lambda r: (-r["changePercent"], str(r.get("symbol", ""))),
            )
        return rows[:limit]

    def get_loser_rows(self, limit: int = 50) -> list[dict]:
        with self._lock:
            rows = sorted(
                [dict(r) for r in self._visible_records()
                 if r.get("changePercent") is not None and r["changePercent"] < 0],
                key=lambda r: (r["changePercent"], str(r.get("symbol", ""))),
            )
        return rows[:limit]

    def get_highest_volume_rows(self, limit: int = 50) -> list[dict]:
        with self._lock:
            rows = sorted(
                [dict(r) for r in self._visible_records() if r.get("volume") is not None],
                key=lambda r: (-r["volume"], str(r.get("symbol", ""))),
            )
        return rows[:limit]

    def get_highest_turnover_rows(self, limit: int = 50) -> list[dict]:
        with self._lock:
            rows = sorted(
                [dict(r) for r in self._visible_records() if r.get("tradedValue") is not None],
                key=lambda r: (-r["tradedValue"], str(r.get("symbol", ""))),
            )
        return rows[:limit]

    def get_buying_strength_rows(self, limit: int = 50) -> list[dict]:
        with self._lock:
            rows = sorted(
                [dict(r) for r in self._visible_records() if r.get("buySellRatio") is not None],
                key=lambda r: (-r["buySellRatio"], str(r.get("symbol", ""))),
            )
        return rows[:limit]

    def get_highest_absolute_change_rows(self, limit: int = 50) -> list[dict]:
        with self._lock:
            rows = sorted(
                [dict(r) for r in self._visible_records() if r.get("changePercent") is not None],
                key=lambda r: (-abs(r["changePercent"]), str(r.get("symbol", ""))),
            )
        return rows[:limit]

    def get_strong_mover_rows(self, limit: int = 50) -> list[dict]:
        """+1% movers (doc §9)."""
        with self._lock:
            rows = sorted(
                [dict(r) for r in self._visible_records()
                 if r.get("changePercent") is not None and r["changePercent"] >= 1.0],
                key=lambda r: (-r["changePercent"], str(r.get("symbol", ""))),
            )
        return rows[:limit]

    def get_weak_mover_rows(self, limit: int = 50) -> list[dict]:
        """-1% movers (doc §9)."""
        with self._lock:
            rows = sorted(
                [dict(r) for r in self._visible_records()
                 if r.get("changePercent") is not None and r["changePercent"] <= -1.0],
                key=lambda r: (r["changePercent"], str(r.get("symbol", ""))),
            )
        return rows[:limit]

    def get_five_minute_mover_rows(self, limit: int = 50) -> list[dict]:
        with self._lock:
            rows = sorted(
                [dict(r) for r in self._visible_records() if r.get("fiveMinPercent") is not None],
                key=lambda r: (-r["fiveMinPercent"], str(r.get("symbol", ""))),
            )
        return rows[:limit]

    def get_ten_minute_mover_rows(self, limit: int = 50) -> list[dict]:
        with self._lock:
            rows = sorted(
                [dict(r) for r in self._visible_records() if r.get("tenMinPercent") is not None],
                key=lambda r: (-r["tenMinPercent"], str(r.get("symbol", ""))),
            )
        return rows[:limit]

    def get_sections(self, limit: int | None = None) -> dict[str, Any]:
        """All dynamic sections for the UI (doc §9, §15)."""
        if limit is None:
            limit = self._section_limit()
        return {
            "topGainers": self.get_gainer_rows(limit),
            "topLosers": self.get_loser_rows(limit),
            "highestVolume": self.get_highest_volume_rows(limit),
            "highestTurnover": self.get_highest_turnover_rows(limit),
            "highestAbsoluteChange": self.get_highest_absolute_change_rows(limit),
            "strongMovers": self.get_strong_mover_rows(limit),
            "weakMovers": self.get_weak_mover_rows(limit),
            "buyingStrength": self.get_buying_strength_rows(limit),
            "fiveMinuteMovers": self.get_five_minute_mover_rows(limit),
            "tenMinuteMovers": self.get_ten_minute_mover_rows(limit),
        }

    # ------------------------------------------------------------------
    # Search / pagination / detail (doc §17, §18)
    # ------------------------------------------------------------------
    def _visible_records(self) -> list[dict]:
        """Live records minus price-capped tokens (doc §16).

        Every board, section and ranking row the UI can render is built from
        this, so a capped stock leaves the list everywhere at once. Lock is
        re-entrant: the callers already hold ``self._lock``.
        """
        with self._lock:
            capped = self._capped_tokens
            if not capped:
                return [dict(r) for r in self._records.values()]
            return [dict(r) for t, r in self._records.items() if t not in capped]

    def _live_rows(self) -> list[dict]:
        return self._visible_records()

    def full_universe_rows(self, limit: int = 0) -> list[dict]:
        """Merged live rows + PENDING placeholders for watchable tokens only."""
        with self._lock:
            no_data = set(self._no_data_tokens)
            capped = set(self._capped_tokens)
            merged: dict[str, dict] = {}
            for token, meta in self._registry.items():
                if token in capped:
                    continue
                merged[token] = {
                    **meta,
                    "status": STATUS_NO_DATA if token in no_data else STATUS_PENDING,
                    "ltp": None, "change": None, "changePercent": None,
                    "volume": None, "lastTickAt": None,
                    "fiveMinPercent": None, "tenMinPercent": None,
                }
            for token, entry in self._records.items():
                if token in capped:
                    continue
                row = dict(entry)
                # doc §19: flat per-timeframe change / change_pct so list views
                # (GET "" / /rank / /search) can render 1m/2m/5m/10m without
                # deriving anything. Values come from the typed SymbolState.
                state = self._states.get(token)
                if state is not None:
                    tfs = state.timeframes
                    for tf in TIMEFRAMES:
                        tf_state = tfs.get(tf)
                        row[f"change_{tf}"] = tf_state.price_move if tf_state else None
                        row[f"change_{tf}_pct"] = tf_state.change_pct if tf_state else None
                merged[token] = row
            rows = list(merged.values())
        if limit:
            rows = rows[:limit]
        return rows

    def paginate(self, section: str, offset: int = 0, limit: int | None = None) -> dict:
        """Slice a section by name (doc §18): cursored page of a dynamic section."""
        if limit is None:
            limit = self._page_size()
        if limit <= 0:
            limit = 100
        if offset < 0:
            offset = 0
        # Page over the FULL ranked set (not just the section-limit window) so
        # cursored "load more" keeps returning newer rows.
        with self._lock:
            window = max(len(self._records), self._section_limit())
        section_rows = self.get_sections(limit=window)
        available = {
            "top_gainers": "topGainers",
            "top_losers": "topLosers",
            "highest_volume": "highestVolume",
            "highest_turnover": "highestTurnover",
            "highest_absolute_change": "highestAbsoluteChange",
            "strong_movers": "strongMovers",
            "weak_movers": "weakMovers",
            "buying_strength": "buyingStrength",
            "five_minute_movers": "fiveMinuteMovers",
            "ten_minute_movers": "tenMinuteMovers",
        }
        key = available.get(section)
        if key is None:
            # doc §22: the 1% movers and Circuit Danger boards were computed but
            # unreachable over REST. Serve them directly from the official
            # ranking boards so every spec board is actually addressable.
            board = self._official_rankings.get(section)
            if board is None:
                return {"ok": False, "section": section, "reason": "unknown_section"}
            page = board[offset: offset + limit]
            return {
                "ok": True,
                "section": section,
                "offset": offset,
                "limit": limit,
                "count": len(page),
                "total": len(board),
                "hasMore": (offset + limit) < len(board),
                "items": page,
            }
        items = section_rows.get(key, [])
        page = items[offset: offset + limit]
        return {
            "ok": True,
            "section": section,
            "offset": offset,
            "limit": limit,
            "count": len(page),
            "total": len(items),
            "hasMore": (offset + limit) < len(items),
            "items": page,
        }

    def search(self, query: str, limit: int | None = None, offset: int = 0) -> dict:
        """Full-universe search over symbol/name (doc §17). No new feed required."""
        if limit is None:
            limit = self._page_size()
        if limit <= 0:
            limit = 100
        q = (query or "").strip().upper()
        if offset < 0:
            offset = 0
        all_rows = self.full_universe_rows()
        if q:
            all_rows = [
                r for r in all_rows
                if q in str(r.get("symbol", "")).upper()
                or q in str(r.get("name", "")).upper()
                or r.get("token") == q
            ]
        page = all_rows[offset: offset + limit]
        return {
            "ok": True,
            "query": query or "",
            "offset": offset,
            "limit": limit,
            "count": len(page),
            "total": len(all_rows),
            "items": page,
        }

    def stock_detail(self, token: str) -> Optional[dict]:
        """Current cached state for a specific stock (doc §17)."""
        with self._lock:
            return dict(self._records.get(str(token), {}))

    def record_for(self, symbol_or_token: str) -> Optional[dict]:
        """doc §23 — the backend-owned contract for one symbol.

        Prefers the typed ``SymbolState`` because it carries classification,
        circuit status, margin and the flat per-timeframe change fields that the
        legacy flat record does not. Falls back to the flat record so a symbol
        that only ever arrived through the legacy path is still answerable.
        """
        key = str(symbol_or_token or "")
        with self._lock:
            state = self._states.get(key)
            if state is not None:
                payload = state.to_public()
                payload["record"] = dict(self._records.get(key, {}))
                return payload
            token = key
            meta = self._registry.get(key)
            if meta is None:
                for candidate, entry in self._registry.items():
                    if str(entry.get("symbol") or "") == key:
                        token, meta = candidate, entry
                        break
            else:
                token = key
            flat = self._records.get(token)
            if flat is None:
                return None
            out = dict(flat)
            out.setdefault("symbol", (meta or {}).get("symbol"))
            out.setdefault("name", (meta or {}).get("name"))
            return out

    # ------------------------------------------------------------------
    # Ranking read models (for the HTTP layer)
    # ------------------------------------------------------------------
    def ranking_snapshot(self) -> dict:
        return market_watch_ranking.snapshot()

    def ranking_pins(self) -> dict:
        return market_watch_ranking.pins()

    def ranking_status(self) -> dict:
        return market_watch_ranking.status()

    # ------------------------------------------------------------------
    # Override status_snapshot (doc §25 observability)
    # ------------------------------------------------------------------
    def status_snapshot(self) -> dict:
        now = time.time()
        base = super().status_snapshot()
        counts = self._status_counts(now)
        marks = list(self._tick_marks)
        tps = None
        if marks:
            window = marks[-min(len(marks), 60):]
            if len(window) >= 2:
                tps = len(window) / max((window[-1] - window[0]), 0.001)
        cfg = self.mw_config()
        stock_counts, classification_counts = self._stock_state_counts()
        from services import market_watch_universe as _mw_universe_mod
        weekly_report_counts = (self.get_metrics().get("custom") or {}).get("weeklyReportCounts")
        weekly_report_at = (self.get_metrics().get("custom") or {}).get("weeklyReportGeneratedAt")
        custom = {
            "eligibleUniverseCount": len(self._universe),
            "eligibleStateCount": len(self._eligible_tokens),
            # doc §16: how many of the eligible tokens are OUT of the watch
            # list because they printed above ``mwr_price_max``. Everything the
            # UI shows is ``eligibleStateCount - priceCappedCount``.
            "priceCappedCount": len(self._capped_tokens),
            "priceCap": self._price_cap() or None,
            "watchableCount": len(self._eligible_tokens) - len(self._capped_tokens),
            "subscribedTokenCount": self.subscribed_token_count(),
            "liveInstrumentCount": counts.get("LIVE", 0),
            "staleInstrumentCount": counts.get("STALE", 0),
            "noDataInstrumentCount": counts.get("NO_DATA", 0),
            "pendingInstrumentCount": counts.get("PENDING", 0),
            "ticksPerSecond": tps,
            "lastTickAt": self._last_tick_at or None,
            "tickCount": self._tick_count,
            "rankingDurationMs": self._last_ranking_duration_ms,
            "uiPublishDurationMs": self._last_publish_duration_ms,
            "lastRankingAt": self._last_ranking_at or None,
            "lastPublishAt": self._last_publish_at or None,
            "indexVersion": self._index_version,
            "feedState": self._feed_state,
            "rankingIntervalSeconds": rt_int(SETTING_RANKING_INTERVAL, RANKING_INTERVAL_SECONDS),
            "staleThresholdSeconds": rt_int(SETTING_STALE_THRESHOLD, STALE_AFTER_SECONDS),
            "gainerPinChanges": self._gainer_pin_changes,
            "loserPinChanges": self._loser_pin_changes,
            # ---- doc §5/§7/§11/§13/§15/§17/§19/§21 ----
            "lifecycle": self._lifecycle_status(),
            "lifecycleState": self._lifecycle_state or None,
            "universeState": universe_state(cfg.universe, len(self._eligible_tokens)),
            "eligibleTarget": cfg.universe.eligible_target,
            "lowUniverseWarning": cfg.universe.low_universe_warning,
            "timeframes": {
                **timeframe_engine.stats(),
                "committer": self._committer.status() if self._committer else None,
            },
            "ledger": block_ledger.summary(),
            "publish": publish_policy.status(),
            "indexes": index_tracker.to_dict(),
            "eligibilityEvaluated": self._eligibility_evaluated,
            "blocksRecorded": self._blocks_recorded,
            "reentriesRecorded": self._reentries_recorded,
            "persistedTicks": self._persisted_ticks,
            "ticksSuppressed": self._ticks_suppressed,
            "storage": self.tick_saving(),
            "officialRankingAt": self._last_official_ranking_at or None,
            "officialRankingBoards": {name: len(rows) for name, rows in self._official_rankings.items()},
            "recovery": self._recovery_report,
            "stopped": self._is_stopped(),
            "filters": cfg.filters.to_dict(),
            # ---- doc §30 observability contract ----
            # Every metric name below is the one the spec asks a consumer /
            # Data Center to read. They are emitted at the TOP level of
            # ``custom`` (not nested under a board map) so a monitoring job can
            # poll them without knowing the board layout.
            "locked_universe_count": (
                len(self._locked_universe) if self._locked_universe is not None else None
            ),
            "active_subscription_count": self.subscribed_token_count(),
            "received_tick_count": self._received_tick_count,
            "validated_tick_count": self._tick_count,
            "invalid_tick_count": self._invalid_tick_count,
            "invalid_tick_reasons": dict(self._invalid_tick_reasons),
            "out_of_universe_tick_count": self._out_of_universe_tick_count,
            "danger_count": stock_counts.get("DANGER", 0),
            "intraday_unavailable_count": stock_counts.get("INTRADAY_UNAVAILABLE", 0),
            "top_gainers_count": len(self._official_rankings.get("top_gainers", [])),
            "top_losers_count": len(self._official_rankings.get("top_losers", [])),
            "movers_1m_count": len(self._official_rankings.get("movers_1pct_1m", [])),
            "movers_2m_count": len(self._official_rankings.get("movers_1pct_2m", [])),
            "movers_5m_count": len(self._official_rankings.get("movers_1pct_5m", [])),
            "movers_10m_count": len(self._official_rankings.get("movers_1pct_10m", [])),
            "movers_30m_count": len(self._official_rankings.get("movers_1pct_30m", [])),
            "last_tick_at": self._last_tick_at or None,
            "processing_latency_ms": self._processing_latency_ms,
            "publish_latency_ms": self._last_publish_duration_ms,
            "websocket_status": self._feed_state,
            # doc §2/§7/§28: proof that the locked list is the intended
            # subscription list. ``unresolvedSymbols`` are locked symbols the
            # instrument master could not resolve — reported, never substituted.
            "weekly": {
                "universeSource": self._universe_source,
                "weekId": self._locked_universe.week_id if self._locked_universe else None,
                "version": self._locked_universe.version if self._locked_universe else None,
                "status": self._locked_universe.status if self._locked_universe else None,
                "lockedAt": self._locked_universe.locked_at if self._locked_universe else None,
                "lockedBy": self._locked_universe.locked_by if self._locked_universe else None,
                "effectiveFrom": self._locked_universe.effective_from if self._locked_universe else None,
                "effectiveTo": self._locked_universe.effective_to if self._locked_universe else None,
                "addedCount": len(self._locked_universe.added) if self._locked_universe else None,
                "removedCount": len(self._locked_universe.removed) if self._locked_universe else None,
                "keptCount": len(self._locked_universe.kept) if self._locked_universe else None,
                "resolvedSymbolCount": len(self._universe),
                "unresolvedSymbolCount": len(self._universe_unresolved),
                "unresolvedSymbols": self._universe_unresolved[:25],
                "verify": self._universe_verify,
                "engineState": mw_config.ENGINE_STATE_WEEKLY_LOCKED
                if (self._locked_universe is not None and self._locked_universe.locked)
                else mw_config.ENGINE_STATE_OFFLINE,
            },
            # doc §2 step 8 / §5: the advisory Saturday review. ``reviewEnabled``
            # and ``reviewHhmm`` are the resolved configuration that decides WHEN
            # this runs; ``reviewWeekday``/``nextReviewAt`` make the schedule
            # observable instead of implicit. ``generatedWeekId`` is the week the
            # last stored report describes.
            "weeklyReview": {
                "reviewEnabled": bool(getattr(cfg.weekly, "enabled", False)),
                "reviewWeekday": getattr(cfg.weekly, "review_weekday", None),
                "reviewHhmm": getattr(cfg.weekly, "review_hhmm", None),
                "rupeeThreshold": getattr(cfg.weekly, "rupee_threshold", None),
                "marginMultiplierThreshold": getattr(cfg.weekly, "margin_multiplier_threshold", None),
                "reportWeekId": self._weekly_report_for or None,
                "reportGeneratedAt": weekly_report_at,
                "reportCounts": weekly_report_counts or None,
                # doc §2: the review READS the week that finished and LOCKS the
                # week that starts next. Both are surfaced so an operator never
                # has to compute an ISO week by hand.
                "reportWeekIdForNow": _mw_universe_mod.week_id_for(now_ist()),
                "targetWeekId": _mw_universe_mod.review_target_week_id(now_ist()),
                "nextReviewAt": _mw_universe_mod.next_review_at(cfg),
            },
            # Friday 15:25 automatic universe refresh: the resolved schedule and
            # the last real outcome (target week, survivor count, trigger and
            # failure reason). No value is inferred from the clock.
            "fridayScan": self.friday_scan_status(),
            # doc §27 stock-state distribution.
            "stockStates": stock_counts,
            "classificationCounts": classification_counts,
        }
        base["metrics"]["custom"].update(custom)
        return base

    # ------------------------------------------------------------------
    # doc §22/§16: HTTP-facing spec surfaces
    # ------------------------------------------------------------------
    def market_watch_snapshot(self, page: int = 1, page_size: int = 100) -> dict:
        """Paged eligible-universe snapshot (doc §16 Show More over REST)."""
        from services.market_watch_publish import more_snapshot_event

        cfg = self.mw_config()
        page = max(1, int(page or 1))
        page_size = max(1, min(int(page_size or cfg.universe.page_size), cfg.universe.show_more_max_page_size))
        ordered = sorted(
            [s for s in self._states.values() if s.instrument_token in self._eligible_tokens],
            key=lambda s: (s.symbol or ""),
        )
        start = (page - 1) * page_size
        window = ordered[start:start + page_size]
        return more_snapshot_event(
            {"request_id": f"rest-{self._trading_date}-{page}", "page": page, "page_size": page_size},
            [s.to_public() for s in window],
            len(ordered),
        )

    def blocked_snapshot(self) -> dict:
        return {
            "tradingDate": self._trading_date,
            "lifecycle": self._lifecycle_status(),
            "summary": block_ledger.summary(),
            "blocked": [e.to_dict() for e in block_ledger.entries() if e.status == "BLOCKED"],
        }

    def timeframe_snapshot(self, token: str) -> Optional[dict]:
        state = self.symbol_state(token)
        if state is None:
            return None
        return {
            "symbol": state.symbol,
            "instrumentToken": state.instrument_token,
            "timeframes": state.to_public(include_timeframes=True).get("timeframes", {}),
            "ltp": state.ltp,
            "change": state.change,
            "changePct": state.change_pct,
            "vwap": state.vwap,
            "volume": state.volume,
            "dataQuality": state.data_quality,
            "lastTickTime": state.last_tick_time,
        }


market_watch_engine = MarketWatchEngine()