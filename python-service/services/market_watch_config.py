"""Market Watch configuration — every operational rule is configuration, never code.

docs/engines/MARKET_WATCH.md §5 ("These times should be configuration, not
scattered hard-coded business rules"), §7 ("These are configurable thresholds,
not universal market facts"), §12 ("Filters must be configurable") and §13
("Use configuration") are all resolved here.

Resolution order for every value:

    1. runtime setting (``app_settings`` via ``services.runtime_settings``)
    2. environment variable (upper-cased, ``MWR_`` prefix — ``KEY_PREFIX``)
    3. the module default declared in this file

Nothing here invents market facts. Thresholds are *policy inputs*; the values
are only ever compared against real broker data by the engines that own them.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Optional

from services.runtime_settings import get_runtime_setting, rt_hhmm, rt_int

# --------------------------------------------------------------------------- #
# Runtime setting key namespace
# --------------------------------------------------------------------------- #
KEY_PREFIX = "mwr_"

# Market Watch Runtime Window (authoritative - engine ONLY runs inside this window)
K_RUNTIME_START = KEY_PREFIX + "runtime_start_hhmm"
K_RUNTIME_STOP = KEY_PREFIX + "runtime_stop_hhmm"

# Lifecycle (doc §5 operating schedule) - internal phases within the runtime window
K_PRE_MARKET = KEY_PREFIX + "pre_market_hhmm"
K_DISCOVERY = KEY_PREFIX + "discovery_hhmm"
K_FILTER_START = KEY_PREFIX + "filter_start_hhmm"
K_FILTER_WINDOW_END = KEY_PREFIX + "filter_window_end_hhmm"
K_SUBSCRIPTION_END = KEY_PREFIX + "subscription_end_hhmm"
K_ACTIVE_FROM = KEY_PREFIX + "active_from_hhmm"
K_STOP = KEY_PREFIX + "stop_hhmm"
K_FINAL_MONITORING = KEY_PREFIX + "final_monitoring_hhmm"
K_REPORT = KEY_PREFIX + "report_hhmm"
K_REPORT_READY = KEY_PREFIX + "report_ready_hhmm"

# Ranking / aggregation cadence
K_RANKING_INTERVAL = KEY_PREFIX + "ranking_interval_seconds"
K_TIMEFRAME_COMMIT_INTERVAL = KEY_PREFIX + "timeframe_commit_interval_seconds"
K_STATUS_INTERVAL = KEY_PREFIX + "status_interval_seconds"
K_INDEX_PUBLISH_INTERVAL = KEY_PREFIX + "index_publish_interval_seconds"
K_UNIVERSE_REFRESH = KEY_PREFIX + "universe_refresh_seconds"
K_STALE_THRESHOLD = KEY_PREFIX + "stale_threshold_seconds"
K_NO_DATA_MULTIPLIER = KEY_PREFIX + "no_data_multiplier"
K_PUBLISH_COALESCE = KEY_PREFIX + "publish_coalesce_ms"

# Universe / eligible-count policy (doc §13)
K_ELIGIBLE_TARGET = KEY_PREFIX + "eligible_target"
K_LOW_UNIVERSE_WARNING = KEY_PREFIX + "low_universe_warning"
K_HARD_MINIMUM = KEY_PREFIX + "hard_minimum"

# Universe eligibility basis.
#
# Market Watch is a MARKET-DATA engine: it decides which instruments to observe
# on the price feed. Which basis it uses is a policy input, so it lives here
# (runtime setting -> env -> module default) instead of being hard-coded.
#
#   INSTRUMENT_ACTIVE — an active NSE EQ security from the sanctioned instrument
#                       master is eligible. Requires no trading entitlement,
#                       because a price feed does not. This is the default: it
#                       is the only basis that lets the engine run outside a
#                       validated trading session, which is when market data is
#                       still valuable (pre-open, post-close, reconnects).
#   ACCOUNT_MIS       — additionally require broker-confirmed MIS (intraday
#                       trading) entitlement. Strictly a TRADING gate. Yields
#                       an empty eligible universe whenever no validated
#                       session has published an MIS signal, which is reported
#                       honestly as UNKNOWN rather than silently faked.
#
# An unrecognised value resolves to the module default; it is never guessed.
K_ELIGIBILITY_BASIS = KEY_PREFIX + "eligibility_basis"
ELIGIBILITY_BASIS_INSTRUMENT_ACTIVE = "INSTRUMENT_ACTIVE"
ELIGIBILITY_BASIS_ACCOUNT_MIS = "ACCOUNT_MIS"
ELIGIBILITY_BASIS_VALUES = (
    ELIGIBILITY_BASIS_INSTRUMENT_ACTIVE,
    ELIGIBILITY_BASIS_ACCOUNT_MIS,
)
DEFAULT_ELIGIBILITY_BASIS = ELIGIBILITY_BASIS_INSTRUMENT_ACTIVE

# Ranking depth (doc §14 "Top 100 gainers/losers are maximum payloads")
K_RANKING_MAX_ENTRIES = KEY_PREFIX + "ranking_max_entries"
K_INITIAL_SECTION_LIMIT = KEY_PREFIX + "initial_section_limit"
K_PAGE_SIZE = KEY_PREFIX + "page_size"
K_MAX_PINS = KEY_PREFIX + "max_pins"
K_SHOW_MORE_MAX_PAGE_SIZE = KEY_PREFIX + "show_more_max_page_size"

# Price filter (doc §12)
K_PRICE_MIN = KEY_PREFIX + "price_min"
K_PRICE_MAX = KEY_PREFIX + "price_max"

# Timeframe movement filters (doc §12) — per timeframe:
#   ``mwr_filter_{tf}_change_pct_min`` / ``_max``
#   ``mwr_filter_{tf}_price_move_min`` / ``_max``
#   ``mwr_filter_{tf}_volume_min``
# An unset bound means "not configured" and is not applied. Thresholds are never
# relaxed automatically to reach an eligible-count target (doc §12/§13).
K_FILTER_PREFIX = KEY_PREFIX + "filter_"
K_FILTER_ENABLED = KEY_PREFIX + "filter_enabled"

# Circuit policy (doc §7) — default policy table, override per value
K_CIRCUIT_POLICY = KEY_PREFIX + "circuit_policy"
K_CIRCUIT_BLOCKS = KEY_PREFIX + "circuit_block_pct"
K_CIRCUIT_NEAR_PCT = KEY_PREFIX + "circuit_near_pct"
K_CIRCUIT_REQUIRE_DATA = KEY_PREFIX + "circuit_require_data"

# Liquidity / data eligibility
K_LIQUIDITY_MIN_VOLUME = KEY_PREFIX + "liquidity_min_volume"
K_LIQUIDITY_MIN_VALUE = KEY_PREFIX + "liquidity_min_value"
K_MIN_TICK_COUNT = KEY_PREFIX + "min_tick_count"
K_REQUIRE_VOLUME_DATA = KEY_PREFIX + "require_volume_data"

# Business / instrument / margin eligibility
K_EXCLUDE_HIDDEN = KEY_PREFIX + "exclude_hidden"
K_MAX_DAILY_CHANGE_PCT = KEY_PREFIX + "max_daily_change_pct"
K_MARGIN_REQUIRED = KEY_PREFIX + "margin_required"
K_MARGIN_SOURCE = KEY_PREFIX + "margin_source"
K_MARGIN_ELIGIBLE_TOKENS = KEY_PREFIX + "margin_eligible_tokens"
K_MARGIN_INELIGIBLE_TOKENS = KEY_PREFIX + "margin_ineligible_tokens"

# Block-ledger re-entry policy (doc §6 "explicit re-entry rule")
K_REENTRY_ENABLED = KEY_PREFIX + "reentry_enabled"
K_REENTRY_REASONS = KEY_PREFIX + "reentry_reasons"

# Storage (doc §23)
K_PERSIST_TICKS = KEY_PREFIX + "persist_ticks"
K_PERSIST_CANDLES = KEY_PREFIX + "persist_candles"
K_PERSIST_DECISIONS = KEY_PREFIX + "persist_decisions"
K_TICK_RETENTION_DAYS = KEY_PREFIX + "tick_retention_days"
K_CANDLE_RETENTION_DAYS = KEY_PREFIX + "candle_retention_days"
K_DECISION_RETENTION_DAYS = KEY_PREFIX + "decision_retention_days"
K_REPORT_RETENTION_DAYS = KEY_PREFIX + "report_retention_days"

# Publish policy (doc §15)
K_PUBLISH_MAX_SYMBOLS = KEY_PREFIX + "publish_max_symbols"
K_ENABLE_LIVE_STOCK_UPDATES = KEY_PREFIX + "enable_live_stock_updates"

# Report (doc §26)
K_REPORT_TOP_N = KEY_PREFIX + "report_top_n"

# --------------------------------------------------------------------------- #
# Weekly locked universe (doc §2, §4, §5, §6, §7, §16, §32, §33)
# --------------------------------------------------------------------------- #
# The operating model in doc §2 is a WEEKLY cadence: Saturday reviews and locks
# the universe, Monday-Friday monitors exactly that locked list. These keys make
# every part of that model configuration rather than hard-coded business logic.
K_WEEKLY_ENABLED = KEY_PREFIX + "weekly_enabled"
# 0=Mon .. 6=Sun. Default 5 = Saturday (doc §2 "Saturday --- Weekly Review").
K_WEEKLY_REVIEW_WEEKDAY = KEY_PREFIX + "weekly_review_weekday"
K_WEEKLY_REVIEW_HHMM = KEY_PREFIX + "weekly_review_hhmm"
# Friday 3:25 PM scan (weekly universe refresh with intraday/LTP<800/5x margin filter)
K_FRIDAY_SCAN_HHMM = KEY_PREFIX + "friday_scan_hhmm"

# Universe source policy (doc §3 "Universe Separation", §35.2/§35.4).
#   LOCKED       — only the latest LOCKED weekly universe is monitored. This is
#                  the spec default and the only mode that satisfies §35.
#   DAILY_MASTER — legacy behaviour: rebuild the universe from the sanitised
#                  instrument master every refresh interval. Retained only so an
#                  operator can run the engine before the first weekly lock.
K_UNIVERSE_SOURCE = KEY_PREFIX + "universe_source"
UNIVERSE_SOURCE_LOCKED = "LOCKED"
UNIVERSE_SOURCE_DAILY_MASTER = "DAILY_MASTER"
UNIVERSE_SOURCE_VALUES = (UNIVERSE_SOURCE_LOCKED, UNIVERSE_SOURCE_DAILY_MASTER)
DEFAULT_UNIVERSE_SOURCE = UNIVERSE_SOURCE_LOCKED

# Weekly lock governance
K_LOCK_ENABLED = KEY_PREFIX + "lock_enabled"
K_LOCK_DEFAULT_USER = KEY_PREFIX + "lock_default_user"
K_LOCK_HISTORY_RETENTION = KEY_PREFIX + "lock_history_retention_weeks"

# §16 ₹800 rule — the weekly review threshold. A WEEKLY REVIEW CRITERION only:
# crossing it mid-week never changes membership (doc §33).
K_RUPEE_THRESHOLD = KEY_PREFIX + "rupee_threshold"
# How often a saved tick is sampled for the above/below observation counters.
K_RUPEE_OBSERVATION_INTERVAL = KEY_PREFIX + "rupee_observation_interval_seconds"

# §17 Margin rule — reporting/eligibility threshold only. The broker-provided
# margin value stays authoritative; this never overrides it.
K_MARGIN_MULTIPLIER_THRESHOLD = KEY_PREFIX + "margin_multiplier_threshold"

# §14 Circuit rule — minimum valid circuit distance below which the stock is
# DANGER and leaves the active publish/calculation set.
K_DANGER_CIRCUIT_PCT = KEY_PREFIX + "danger_circuit_pct"

# §21 1% movers — per-timeframe movement threshold, backend-owned.
K_MOVER_THRESHOLD_PCT = KEY_PREFIX + "mover_threshold_pct"

# §20 NORMAL classification threshold.
K_NORMAL_THRESHOLD_PCT = KEY_PREFIX + "normal_threshold_pct"

# --------------------------------------------------------------------------- #
# §27 State model vocabulary
# --------------------------------------------------------------------------- #
# Stock-level states (doc §27). These are BUSINESS states; the existing
# per-token feed status (PENDING/LIVE/STALE/NO_DATA/INACTIVE) continues to travel
# alongside as ``status`` so no existing consumer breaks.
STOCK_STATE_ACTIVE = "ACTIVE"
STOCK_STATE_DANGER = "DANGER"
STOCK_STATE_INTRADAY_UNAVAILABLE = "INTRADAY_UNAVAILABLE"
STOCK_STATE_STALE = "STALE"
STOCK_STATE_NO_DATA = "NO_DATA"
STOCK_STATE_INVALID = "INVALID"
STOCK_STATES: tuple[str, ...] = (
    STOCK_STATE_ACTIVE,
    STOCK_STATE_DANGER,
    STOCK_STATE_INTRADAY_UNAVAILABLE,
    STOCK_STATE_STALE,
    STOCK_STATE_NO_DATA,
    STOCK_STATE_INVALID,
)

# §20 Classification vocabulary with the documented precedence:
#   DANGER > INTRADAY_UNAVAILABLE > GAINER / LOSER > NORMAL
CLASSIFICATION_DANGER = "DANGER"
CLASSIFICATION_INTRADAY_UNAVAILABLE = "INTRADAY_UNAVAILABLE"
CLASSIFICATION_GAINER = "GAINER"
CLASSIFICATION_LOSER = "LOSER"
CLASSIFICATION_NORMAL = "NORMAL"
CLASSIFICATIONS: tuple[str, ...] = (
    CLASSIFICATION_DANGER,
    CLASSIFICATION_INTRADAY_UNAVAILABLE,
    CLASSIFICATION_GAINER,
    CLASSIFICATION_LOSER,
    CLASSIFICATION_NORMAL,
)

# §14 circuit_status — never fabricate safety when circuit data is missing.
CIRCUIT_STATUS_SAFE = "SAFE"
CIRCUIT_STATUS_NEAR = "NEAR"
CIRCUIT_STATUS_DANGER = "DANGER"
CIRCUIT_STATUS_HIT = "HIT"
CIRCUIT_STATUS_UNKNOWN = "UNKNOWN"
CIRCUIT_STATUSES: tuple[str, ...] = (
    CIRCUIT_STATUS_SAFE,
    CIRCUIT_STATUS_NEAR,
    CIRCUIT_STATUS_DANGER,
    CIRCUIT_STATUS_HIT,
    CIRCUIT_STATUS_UNKNOWN,
)

# §15/§17 eligibility + margin status vocabulary.
ELIGIBILITY_ELIGIBLE_TOKEN = "ELIGIBLE"
ELIGIBILITY_UNAVAILABLE = "UNAVAILABLE"
ELIGIBILITY_UNKNOWN = "UNKNOWN"
INTRADAY_STATUSES: tuple[str, ...] = (
    ELIGIBILITY_ELIGIBLE_TOKEN,
    ELIGIBILITY_UNAVAILABLE,
    ELIGIBILITY_UNKNOWN,
)

MARGIN_STATUS_AUTHORITATIVE = "AUTHORITATIVE"
MARGIN_STATUS_BELOW_THRESHOLD = "BELOW_THRESHOLD"
MARGIN_STATUS_UNAVAILABLE = "UNAVAILABLE"
MARGIN_STATUSES: tuple[str, ...] = (
    MARGIN_STATUS_AUTHORITATIVE,
    MARGIN_STATUS_BELOW_THRESHOLD,
    MARGIN_STATUS_UNAVAILABLE,
)

# §6/§32 Weekly universe lifecycle status.
WEEK_STATUS_DRAFT = "DRAFT"
WEEK_STATUS_LOCKED = "LOCKED"
WEEK_STATUS_SUPERSEDED = "SUPERSEDED"
WEEK_STATUSES: tuple[str, ...] = (WEEK_STATUS_DRAFT, WEEK_STATUS_LOCKED, WEEK_STATUS_SUPERSEDED)

# §32 Weekly manual commands.
REVIEW_ACTION_KEEP = "KEEP"
REVIEW_ACTION_ADD = "ADD"
REVIEW_ACTION_REMOVE = "REMOVE"
REVIEW_ACTIONS: tuple[str, ...] = (
    REVIEW_ACTION_KEEP,
    REVIEW_ACTION_ADD,
    REVIEW_ACTION_REMOVE,
)

# §5 Weekly report recommendation.
RECOMMENDATION_ADD = "ADD"
RECOMMENDATION_REMOVE = "REMOVE"
RECOMMENDATION_KEEP = "KEEP"
RECOMMENDATION_REVIEW = "REVIEW"
RECOMMENDATIONS: tuple[str, ...] = (
    RECOMMENDATION_ADD,
    RECOMMENDATION_REMOVE,
    RECOMMENDATION_KEEP,
    RECOMMENDATION_REVIEW,
)

# §27 Engine-level states required by the spec, exposed alongside the daily
# lifecycle phase so a consumer sees one vocabulary.
ENGINE_STATE_OFFLINE = "OFFLINE"
ENGINE_STATE_PRE_MARKET = "PRE_MARKET"
ENGINE_STATE_WEEKLY_LOCKED = "WEEKLY_LOCKED"
ENGINE_STATE_STARTING = "STARTING"
ENGINE_STATE_SUBSCRIBING = "SUBSCRIBING"
ENGINE_STATE_MONITORING = "MONITORING"
ENGINE_STATE_DEGRADED = "DEGRADED"
ENGINE_STATE_BLOCKING = "BLOCKING"
ENGINE_STATE_STOPPING = "STOPPING"
ENGINE_STATE_STOPPED = "STOPPED"
ENGINE_STATE_REPORTING = "REPORTING"
ENGINE_STATES: tuple[str, ...] = (
    ENGINE_STATE_OFFLINE,
    ENGINE_STATE_PRE_MARKET,
    ENGINE_STATE_WEEKLY_LOCKED,
    ENGINE_STATE_STARTING,
    ENGINE_STATE_SUBSCRIBING,
    ENGINE_STATE_MONITORING,
    ENGINE_STATE_DEGRADED,
    ENGINE_STATE_BLOCKING,
    ENGINE_STATE_STOPPING,
    ENGINE_STATE_STOPPED,
    ENGINE_STATE_REPORTING,
)

# Recovery (doc §21)
K_RECOVERY_ENABLED = KEY_PREFIX + "recovery_enabled"
K_RECOVERY_CANDLE_LOOKBACK_MINUTES = KEY_PREFIX + "recovery_candle_lookback_minutes"

# Timeframes (doc §11)
TIMEFRAMES: tuple[str, ...] = ("1m", "2m", "5m", "10m", "30m")
TIMEFRAME_SECONDS: dict[str, int] = {"1m": 60, "2m": 120, "5m": 300, "10m": 600, "30m": 1800}

# Circuit distance policies (doc §7): circuit band -> block/near threshold.
#
# doc §7 lists an example policy ("20% circuit -> block at 18%"). That example is
# NOT usable as a default: distance is measured against the circuit price, so the
# largest distance a symbol can ever have inside a band of ``b`` percent is
# ``b / (1 + b) * 100`` (16.67% for a 20% band). A block threshold of 18% would
# therefore block EVERY symbol in a 20% band, including one sitting on its
# previous close, and the engine would have no eligible universe at all.
#
# The shipped defaults are expressed as a fraction of that attainable distance
# (block at 30%, circuit-near ranking signal at 50%), so they behave the same way
# for a 2% band and a 20% band. The doc's example numbers remain available by
# configuration: MWR_CIRCUIT_BLOCK_PCT / MWR_CIRCUIT_NEAR_PCT.
DEFAULT_CIRCUIT_POLICY: dict[str, float] = {"2": 0.6, "5": 1.5, "10": 2.7, "20": 5.0}
DEFAULT_CIRCUIT_NEAR_POLICY: dict[str, float] = {"2": 1.0, "5": 2.5, "10": 4.5, "20": 8.3}

#: The example policy exactly as written in doc §7, for reference/audit only.
DOC_CIRCUIT_EXAMPLE_POLICY: dict[str, float] = {"5": 3.0, "10": 8.0, "15": 13.0, "20": 18.0}

# Eligibility statuses (doc §6, §13)
ELIGIBILITY_ELIGIBLE = "ELIGIBLE"
ELIGIBILITY_PENDING = "PENDING"
ELIGIBILITY_BLOCKED = "BLOCKED"

# Eligible-count states (doc §13)
UNIVERSE_NORMAL = "NORMAL"
UNIVERSE_LOW = "LOW_UNIVERSE"
UNIVERSE_CRITICAL_LOW = "CRITICAL_LOW_UNIVERSE"
UNIVERSE_EMPTY = "NO_ELIGIBLE_STOCKS"

# Data-quality vocabulary (doc §9, §11, §21)
DATA_QUALITY_LIVE = "LIVE"
DATA_QUALITY_IN_PROGRESS = "IN_PROGRESS"
DATA_QUALITY_COMPLETE = "COMPLETE"
DATA_QUALITY_INCOMPLETE = "INCOMPLETE"
DATA_QUALITY_STALE = "STALE"
DATA_QUALITY_UNAVAILABLE = "UNAVAILABLE"

# Block reasons (doc §6 / Phase 6)
REASON_PRICE_LIMIT = "PRICE_LIMIT"
REASON_CIRCUIT_TOO_CLOSE = "CIRCUIT_TOO_CLOSE"
REASON_LIQUIDITY_FAIL = "LIQUIDITY_FAIL"
REASON_MARGIN_INELIGIBLE = "MARGIN_INELIGIBLE"
REASON_DATA_INVALID = "DATA_INVALID"
REASON_INSTRUMENT_INELIGIBLE = "INSTRUMENT_INELIGIBLE"
REASON_BUSINESS_RULE = "BUSINESS_RULE"
REASON_FILTER_FAIL = "FILTER_FAIL"
BLOCK_REASONS: tuple[str, ...] = (
    REASON_PRICE_LIMIT,
    REASON_CIRCUIT_TOO_CLOSE,
    REASON_LIQUIDITY_FAIL,
    REASON_MARGIN_INELIGIBLE,
    REASON_DATA_INVALID,
    REASON_INSTRUMENT_INELIGIBLE,
    REASON_BUSINESS_RULE,
    REASON_FILTER_FAIL,
)

# Reasons that may be re-entered within the same trading day when the block is
# an observation of live data rather than a static business/instrument fact.
DATA_DRIVEN_REASONS: tuple[str, ...] = (
    REASON_PRICE_LIMIT,
    REASON_CIRCUIT_TOO_CLOSE,
    REASON_LIQUIDITY_FAIL,
    REASON_DATA_INVALID,
    REASON_FILTER_FAIL,
)

# --------------------------------------------------------------------------- #
# Small typed readers
# --------------------------------------------------------------------------- #
_BOOL_TRUE = frozenset({"1", "true", "yes", "on"})
_BOOL_FALSE = frozenset({"0", "false", "no", "off"})


def _env(key: str) -> Optional[str]:
    return os.environ.get(key.upper())


def mw_str(key: str, default: str) -> str:
    value = get_runtime_setting(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    env = _env(key)
    if env:
        return env.strip()
    return default


def mw_float(key: str, default: float) -> float:
    value = get_runtime_setting(key)
    if isinstance(value, bool):
        pass
    elif isinstance(value, (int, float)):
        return float(value)
    elif isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            pass
    env = _env(key)
    if env:
        try:
            return float(env)
        except ValueError:
            pass
    return default


def mw_int(key: str, default: int) -> int:
    value = get_runtime_setting(key)
    if isinstance(value, bool):
        pass
    elif isinstance(value, (int, float)):
        return int(value)
    elif isinstance(value, str):
        try:
            return int(float(value))
        except ValueError:
            pass
    env = _env(key)
    if env:
        try:
            return int(float(env))
        except ValueError:
            pass
    return default


def mw_choice(key: str, default: str, allowed: tuple[str, ...]) -> str:
    """Resolve an enum-valued setting (runtime setting -> env -> default).

    An unrecognised value resolves to ``default`` rather than being passed
    through, so a typo can never put the engine into an undefined mode. The
    effective value is always reported by :func:`as_dict`, so an operator can
    see which basis is actually in force.
    """
    raw = mw_str(key, default).strip()
    for candidate in allowed:
        if raw.upper() == candidate:
            return candidate
    return default


def mw_bool(key: str, default: bool) -> bool:
    """Resolve a boolean from runtime setting, then env, then ``default``.

    ``rt_bool`` only ever reads the runtime cache, so calling it alone gave this
    reader NO env tier: a boolean key set purely as an environment variable
    (``MWR_PERSIST_TICKS=0``) silently resolved to the module default. The
    storage on/off switches (doc §23) were unreachable by every route as a
    result. The env tier below is what makes the documented resolution order
    actually hold.
    """
    value = get_runtime_setting(key)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        text = value.strip().lower()
        if text in _BOOL_TRUE:
            return True
        if text in _BOOL_FALSE:
            return False
        # Unrecognised persisted value: fall through rather than guess.
    env = _env(key)
    if env:
        text = env.strip().lower()
        if text in _BOOL_TRUE:
            return True
        if text in _BOOL_FALSE:
            return False
    return default


def mw_hhmm(key: str, default_hour: int, default_minute: int) -> tuple[int, int]:
    """Resolve an IST ``HH:MM`` from runtime settings, then env, then default."""
    parsed = rt_hhmm(key, default_hour, default_minute)
    if parsed != (default_hour, default_minute):
        return parsed
    env = _env(key)
    if env:
        try:
            hh, _, mm = env.partition(":")
            return max(0, min(23, int(hh))), max(0, min(59, int(mm)))
        except (TypeError, ValueError):
            pass
    return default_hour, default_minute


def mw_hhmm_text(key: str, default_hour: int, default_minute: int) -> str:
    hour, minute = mw_hhmm(key, default_hour, default_minute)
    return f"{hour:02d}:{minute:02d}"


def _token_set(raw: str) -> set[str]:
    return {p.strip() for p in raw.replace(";", ",").split(",") if p.strip()}


# --------------------------------------------------------------------------- #
# Typed config sections
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class LifecycleConfig:
    runtime_start: str
    runtime_stop: str
    pre_market: str
    discovery: str
    filter_start: str
    filter_window_end: str
    subscription_end: str
    active_from: str
    final_monitoring: str
    stop: str
    report: str
    report_ready: str


@dataclass(frozen=True)
class CadenceConfig:
    ranking_interval_seconds: float
    timeframe_commit_interval_seconds: float
    status_interval_seconds: float
    index_publish_interval_seconds: float
    universe_refresh_seconds: float
    stale_threshold_seconds: float
    no_data_multiplier: float
    publish_coalesce_ms: int


@dataclass(frozen=True)
class UniversePolicyConfig:
    eligible_target: int
    low_universe_warning: int
    hard_minimum: int
    page_size: int
    initial_section_limit: int
    ranking_max_entries: int
    max_pins: int
    show_more_max_page_size: int
    max_publish_symbols: int
    eligibility_basis: str

    @property
    def requires_account_mis(self) -> bool:
        return self.eligibility_basis == ELIGIBILITY_BASIS_ACCOUNT_MIS


@dataclass(frozen=True)
class PriceFilterConfig:
    min_price: float
    max_price: float


@dataclass(frozen=True)
class TimeframeFilterConfig:
    """One timeframe's movement thresholds (doc §12). ``None`` = not set."""

    change_pct_min: Optional[float] = None
    change_pct_max: Optional[float] = None
    price_move_min: Optional[float] = None
    price_move_max: Optional[float] = None
    volume_min: Optional[float] = None

    @property
    def configured(self) -> bool:
        return any(
            value is not None
            for value in (
                self.change_pct_min, self.change_pct_max,
                self.price_move_min, self.price_move_max, self.volume_min,
            )
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "changePctMin": self.change_pct_min,
            "changePctMax": self.change_pct_max,
            "priceMoveMin": self.price_move_min,
            "priceMoveMax": self.price_move_max,
            "volumeMin": self.volume_min,
        }


@dataclass(frozen=True)
class FilterConfig:
    """The full doc §12 filter set: price + 1m/5m/10m/30m movement filters."""

    enabled: bool
    price: PriceFilterConfig
    timeframes: dict[str, TimeframeFilterConfig]

    def to_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "price": {"min": self.price.min_price, "max": self.price.max_price},
            "timeframes": {tf: cfg.to_dict() for tf, cfg in self.timeframes.items()},
        }


@dataclass(frozen=True)
class WeeklyConfig:
    """Weekly locked-universe governance (doc §2, §4, §6, §7, §16, §32, §33).

    Everything here is a *policy input*. None of it invents a market fact:
    the ₹800 figure is a review criterion, the 5x figure is a reporting
    threshold, and the universe source decides whether a locked list is
    honoured or the legacy daily master rebuild is used.
    """

    enabled: bool
    review_weekday: int
    review_hhmm: str
    friday_scan_hhmm: str
    universe_source: str
    lock_enabled: bool
    lock_default_user: str
    lock_history_retention: int
    rupee_threshold: float
    rupee_observation_interval: float
    margin_multiplier_threshold: float
    danger_circuit_pct: float
    mover_threshold_pct: float
    normal_threshold_pct: float

    @property
    def locked_universe_required(self) -> bool:
        """True when the engine must honour the locked list (doc §35.2)."""
        return self.universe_source == UNIVERSE_SOURCE_LOCKED

    def to_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "reviewWeekday": self.review_weekday,
            "reviewHhmm": self.review_hhmm,
            "fridayScanHhmm": self.friday_scan_hhmm,
            "universeSource": self.universe_source,
            "lockEnabled": self.lock_enabled,
            "lockDefaultUser": self.lock_default_user,
            "lockHistoryRetentionWeeks": self.lock_history_retention,
            "rupeeThreshold": self.rupee_threshold,
            "rupeeObservationIntervalSeconds": self.rupee_observation_interval,
            "marginMultiplierThreshold": self.margin_multiplier_threshold,
            "dangerCircuitPct": self.danger_circuit_pct,
            "moverThresholdPct": self.mover_threshold_pct,
            "normalThresholdPct": self.normal_threshold_pct,
            "lockedUniverseRequired": self.locked_universe_required,
        }


@dataclass(frozen=True)
class CircuitConfig:
    block_pct_by_band: dict[str, float]
    near_pct_by_band: dict[str, float]
    default_block_pct: float
    default_near_pct: float
    require_data: bool


@dataclass(frozen=True)
class LiquidityConfig:
    min_volume: float
    min_value: float
    min_tick_count: int
    require_volume_data: bool


@dataclass(frozen=True)
class BusinessConfig:
    exclude_hidden: bool
    max_daily_change_pct: float
    margin_required: bool
    margin_source: str
    margin_eligible_tokens: frozenset[str]
    margin_ineligible_tokens: frozenset[str]


@dataclass(frozen=True)
class LedgerConfig:
    reentry_enabled: bool
    reentry_reasons: frozenset[str]


@dataclass(frozen=True)
class StorageConfig:
    persist_ticks: bool
    persist_candles: bool
    persist_decisions: bool
    tick_retention_days: int
    candle_retention_days: int
    decision_retention_days: int
    report_retention_days: int


@dataclass(frozen=True)
class RecoveryConfig:
    enabled: bool
    candle_lookback_minutes: int


@dataclass(frozen=True)
class PublishConfig:
    coalesce_ms: int
    max_symbols: int
    live_stock_updates: bool


@dataclass(frozen=True)
class MarketWatchConfig:
    lifecycle: LifecycleConfig
    cadence: CadenceConfig
    universe: UniversePolicyConfig
    price: PriceFilterConfig
    filters: FilterConfig
    circuit: CircuitConfig
    liquidity: LiquidityConfig
    business: BusinessConfig
    weekly: WeeklyConfig
    ledger: LedgerConfig
    storage: StorageConfig
    recovery: RecoveryConfig
    publish: PublishConfig
    report_top_n: int


def _band_lookup(table: dict[str, float], band: float, default: float) -> float:
    """Pick the configured block threshold for a circuit band width."""
    if band <= 0:
        return default
    for width, pct in table.items():
        try:
            if abs(float(width) - band) < 1e-6:
                return pct
        except (TypeError, ValueError):
            continue
    # Fall back to the nearest configured band (defensive, still deterministic).
    best: Optional[tuple[float, float]] = None
    for width, pct in table.items():
        try:
            delta = abs(float(width) - band)
        except (TypeError, ValueError):
            continue
        if best is None or delta < best[0]:
            best = (delta, pct)
    return best[1] if best else default


def _bands(raw: str, defaults: dict[str, float]) -> dict[str, float]:
    parsed: dict[str, float] = {}
    for part in raw.replace(";", ",").split(","):
        if not part.strip():
            continue
        width, _, pct = part.partition("=")
        if not pct:
            width, _, pct = part.partition(":")
        try:
            parsed[str(float(width))] = float(pct)
        except (TypeError, ValueError):
            continue
    return parsed or dict(defaults)


def load() -> MarketWatchConfig:
    """Resolve the full Market Watch configuration (cheap; safe to call often)."""
    block_bands = _bands(mw_str(K_CIRCUIT_BLOCKS, ""), DEFAULT_CIRCUIT_POLICY)
    near_bands = _bands(mw_str(K_CIRCUIT_NEAR_PCT, ""), DEFAULT_CIRCUIT_NEAR_POLICY)
    default_block = mw_float(KEY_PREFIX + "circuit_block_pct", 3.0)
    default_near = mw_float(KEY_PREFIX + "circuit_near_pct", 4.0)

    stale_after = mw_int(KEY_PREFIX + "stale_threshold_seconds", 30)
    no_data_mult = max(2.0, mw_float(K_NO_DATA_MULTIPLIER, 3.0))

    reentry_reasons_raw = mw_str(K_REENTRY_REASONS, ",".join(DATA_DRIVEN_REASONS))
    reentry_reasons = frozenset(
        r.strip().upper() for r in reentry_reasons_raw.replace(";", ",").split(",") if r.strip()
    ) & frozenset(BLOCK_REASONS)

    # doc A12 price band. ``mwr_price_max`` is the LIVE price cap: only stocks
    # priced at or below it stay in the Market Watch list and in the tick
    # subscription (see ``MarketWatchEngine._evaluate_price_cap``). Raising it
    # is an operator action (env var), never a code change.
    price_cfg = PriceFilterConfig(
        min_price=mw_float(K_PRICE_MIN, 0.0),
        max_price=mw_float(K_PRICE_MAX, 800.0),
    )
    timeframe_filters = {
        tf: TimeframeFilterConfig(
            change_pct_min=_optional_float(f"{K_FILTER_PREFIX}{tf}_change_pct_min"),
            change_pct_max=_optional_float(f"{K_FILTER_PREFIX}{tf}_change_pct_max"),
            price_move_min=_optional_float(f"{K_FILTER_PREFIX}{tf}_price_move_min"),
            price_move_max=_optional_float(f"{K_FILTER_PREFIX}{tf}_price_move_max"),
            volume_min=_optional_float(f"{K_FILTER_PREFIX}{tf}_volume_min"),
        )
        for tf in TIMEFRAMES
    }
    filter_cfg = FilterConfig(
        enabled=mw_bool(K_FILTER_ENABLED, True),
        price=price_cfg,
        timeframes=timeframe_filters,
    )

    return MarketWatchConfig(
        lifecycle=LifecycleConfig(
            runtime_start=mw_hhmm_text(K_RUNTIME_START, 8, 50),
            runtime_stop=mw_hhmm_text(K_RUNTIME_STOP, 15, 30),
            pre_market=mw_hhmm_text(K_PRE_MARKET, 9, 0),
            discovery=mw_hhmm_text(K_DISCOVERY, 9, 10),
            filter_start=mw_hhmm_text(K_FILTER_START, 9, 11),
            filter_window_end=mw_hhmm_text(K_FILTER_WINDOW_END, 9, 12),
            subscription_end=mw_hhmm_text(K_SUBSCRIPTION_END, 9, 14),
            active_from=mw_hhmm_text(K_ACTIVE_FROM, 9, 14),
            final_monitoring=mw_hhmm_text(K_FINAL_MONITORING, 15, 5),
            stop=mw_hhmm_text(K_STOP, 15, 15),
            report=mw_hhmm_text(K_REPORT, 15, 20),
            report_ready=mw_hhmm_text(K_REPORT_READY, 15, 25),
        ),
        cadence=CadenceConfig(
            ranking_interval_seconds=max(1.0, mw_float(K_RANKING_INTERVAL, 30.0)),
            timeframe_commit_interval_seconds=max(1.0, mw_float(K_TIMEFRAME_COMMIT_INTERVAL, 5.0)),
            status_interval_seconds=max(1.0, mw_float(K_STATUS_INTERVAL, 10.0)),
            index_publish_interval_seconds=max(0.2, mw_float(K_INDEX_PUBLISH_INTERVAL, 1.0)),
            universe_refresh_seconds=max(10.0, mw_float(K_UNIVERSE_REFRESH, 300.0)),
            stale_threshold_seconds=max(1.0, float(stale_after)),
            no_data_multiplier=no_data_mult,
            publish_coalesce_ms=max(50, mw_int(K_PUBLISH_COALESCE, 250)),
        ),
        universe=UniversePolicyConfig(
            eligible_target=max(0, mw_int(K_ELIGIBLE_TARGET, 100)),
            low_universe_warning=max(0, mw_int(K_LOW_UNIVERSE_WARNING, 75)),
            # doc §13: HARD_MINIMUM is 0 — never fabricate entries to reach a count.
            hard_minimum=max(0, mw_int(K_HARD_MINIMUM, 0)),
            page_size=max(1, mw_int(K_PAGE_SIZE, 100)),
            initial_section_limit=max(1, mw_int(K_INITIAL_SECTION_LIMIT, 50)),
            ranking_max_entries=max(1, mw_int(K_RANKING_MAX_ENTRIES, 100)),
            max_pins=max(1, mw_int(K_MAX_PINS, 5)),
            show_more_max_page_size=max(1, mw_int(K_SHOW_MORE_MAX_PAGE_SIZE, 500)),
            max_publish_symbols=max(1, mw_int(K_PUBLISH_MAX_SYMBOLS, 250)),
            eligibility_basis=mw_choice(
                K_ELIGIBILITY_BASIS, DEFAULT_ELIGIBILITY_BASIS, ELIGIBILITY_BASIS_VALUES
            ),
        ),
        price=price_cfg,
        filters=filter_cfg,
        circuit=CircuitConfig(
            block_pct_by_band=block_bands,
            near_pct_by_band=near_bands,
            default_block_pct=default_block,
            default_near_pct=default_near,
            require_data=mw_bool(K_CIRCUIT_REQUIRE_DATA, True),
        ),
        liquidity=LiquidityConfig(
            min_volume=mw_float(K_LIQUIDITY_MIN_VOLUME, 0.0),
            min_value=mw_float(K_LIQUIDITY_MIN_VALUE, 0.0),
            min_tick_count=max(0, mw_int(K_MIN_TICK_COUNT, 1)),
            require_volume_data=mw_bool(K_REQUIRE_VOLUME_DATA, False),
        ),
        business=BusinessConfig(
            exclude_hidden=mw_bool(K_EXCLUDE_HIDDEN, True),
            max_daily_change_pct=mw_float(K_MAX_DAILY_CHANGE_PCT, 25.0),
            margin_required=mw_bool(K_MARGIN_REQUIRED, False),
            # Market Watch CONSUMES margin decisions; it never computes them
            # (doc §6: "it does not invent broker margin values").
            margin_source=mw_str(K_MARGIN_SOURCE, "session_manager"),
            margin_eligible_tokens=frozenset(_token_set(mw_str(K_MARGIN_ELIGIBLE_TOKENS, ""))),
            margin_ineligible_tokens=frozenset(_token_set(mw_str(K_MARGIN_INELIGIBLE_TOKENS, ""))),
        ),
        weekly=WeeklyConfig(
            enabled=mw_bool(K_WEEKLY_ENABLED, True),
            review_weekday=min(6, max(0, mw_int(K_WEEKLY_REVIEW_WEEKDAY, 5))),
            review_hhmm=mw_hhmm_text(K_WEEKLY_REVIEW_HHMM, 18, 0),
            friday_scan_hhmm=mw_hhmm_text(K_FRIDAY_SCAN_HHMM, 15, 25),
            universe_source=mw_choice(K_UNIVERSE_SOURCE, DEFAULT_UNIVERSE_SOURCE, UNIVERSE_SOURCE_VALUES),
            lock_enabled=mw_bool(K_LOCK_ENABLED, True),
            lock_default_user=mw_str(K_LOCK_DEFAULT_USER, "operator"),
            lock_history_retention=max(1, mw_int(K_LOCK_HISTORY_RETENTION, 104)),
            # doc §16: a weekly REVIEW criterion, never a live add/remove trigger.
            rupee_threshold=max(0.0, mw_float(K_RUPEE_THRESHOLD, 800.0)),
            rupee_observation_interval=max(1.0, mw_float(K_RUPEE_OBSERVATION_INTERVAL, 60.0)),
            # doc §17: a reporting/eligibility threshold; broker margin stays authoritative.
            margin_multiplier_threshold=max(0.0, mw_float(K_MARGIN_MULTIPLIER_THRESHOLD, 5.0)),
            # doc §14: "minimum valid circuit distance < 2%" is DANGER.
            danger_circuit_pct=max(0.0, mw_float(K_DANGER_CIRCUIT_PCT, 2.0)),
            # doc §21: abs(change_pct) >= 1% is a mover.
            mover_threshold_pct=max(0.0, mw_float(K_MOVER_THRESHOLD_PCT, 1.0)),
            # doc §20: movement below this is NORMAL.
            normal_threshold_pct=max(0.0, mw_float(K_NORMAL_THRESHOLD_PCT, 1.0)),
        ),
        ledger=LedgerConfig(
            # doc §6: a blocked stock must not silently re-enter. Re-entry is OFF
            # unless explicitly enabled for data-driven reasons.
            reentry_enabled=mw_bool(K_REENTRY_ENABLED, False),
            reentry_reasons=reentry_reasons,
        ),
        storage=StorageConfig(
            persist_ticks=mw_bool(K_PERSIST_TICKS, True),
            persist_candles=mw_bool(K_PERSIST_CANDLES, True),
            persist_decisions=mw_bool(K_PERSIST_DECISIONS, True),
            tick_retention_days=max(1, mw_int(K_TICK_RETENTION_DAYS, 2)),
            candle_retention_days=max(1, mw_int(K_CANDLE_RETENTION_DAYS, 30)),
            decision_retention_days=max(1, mw_int(K_DECISION_RETENTION_DAYS, 90)),
            report_retention_days=max(1, mw_int(K_REPORT_RETENTION_DAYS, 365)),
        ),
        recovery=RecoveryConfig(
            enabled=mw_bool(K_RECOVERY_ENABLED, True),
            candle_lookback_minutes=max(1, mw_int(K_RECOVERY_CANDLE_LOOKBACK_MINUTES, 180)),
        ),
        publish=PublishConfig(
            coalesce_ms=max(50, mw_int(K_PUBLISH_COALESCE, 250)),
            max_symbols=max(1, mw_int(K_PUBLISH_MAX_SYMBOLS, 250)),
            live_stock_updates=mw_bool(K_ENABLE_LIVE_STOCK_UPDATES, True),
        ),
        report_top_n=max(1, mw_int(K_REPORT_TOP_N, 20)),
    )


def block_pct_for_band(cfg: CircuitConfig, band_pct: Optional[float]) -> float:
    return _band_lookup(cfg.block_pct_by_band, band_pct or 0.0, cfg.default_block_pct)


def near_pct_for_band(cfg: CircuitConfig, band_pct: Optional[float]) -> float:
    return _band_lookup(cfg.near_pct_by_band, band_pct or 0.0, cfg.default_near_pct)


def band_pct_from_circuits(upper: Optional[float], lower: Optional[float], previous_close: Optional[float]) -> Optional[float]:
    """Circuit band width in percent, derived from the ACTUAL circuit prices.

    Exchange bands (2/5/10/20%) are quoted PER SIDE around the previous close:
    a 20% band means upper = pc * 1.20 and lower = pc * 0.80, i.e. a 40% span.
    This returns the per-side band ``(upper - lower) / 2 / previous_close * 100``
    so it lines up with the configured band keys ("10", "20"). It is the real
    band the exchange applied, never a hard-coded label.
    """
    if upper is None or lower is None or previous_close in (None, 0):
        return None
    try:
        up = float(upper)
        lo = float(lower)
        pc = float(previous_close)
    except (TypeError, ValueError):
        return None
    if pc == 0 or up <= 0 or lo <= 0 or up <= lo:
        return None
    return (up - lo) / 2.0 / pc * 100.0


def universe_state(cfg: UniversePolicyConfig, eligible: int) -> str:
    """doc §13 eligible-count policy. Never relaxes anything to reach a target."""
    if eligible <= 0:
        return UNIVERSE_EMPTY
    if eligible < cfg.hard_minimum:
        return UNIVERSE_EMPTY
    if eligible < cfg.low_universe_warning:
        return UNIVERSE_CRITICAL_LOW
    if eligible < cfg.eligible_target:
        return UNIVERSE_LOW
    return UNIVERSE_NORMAL


def _optional_float(key: str) -> Optional[float]:
    """Configured bound or ``None`` (unset). Unset bounds are NOT applied."""
    from services.runtime_settings import get_runtime_setting as _grs

    raw = os.getenv(key.upper())
    if raw in (None, ""):
        try:
            raw = _grs(key)
        except Exception:
            raw = None
    if raw in (None, ""):
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def as_dict(cfg: Optional[MarketWatchConfig] = None) -> dict[str, Any]:
    cfg = cfg or load()
    return {
        "lifecycle": cfg.lifecycle.__dict__,
        "cadence": cfg.cadence.__dict__,
        "universe": cfg.universe.__dict__,
        "price": cfg.price.__dict__,
        "filters": cfg.filters.to_dict(),
        "circuit": {
            "blockPctByBand": cfg.circuit.block_pct_by_band,
            "nearPctByBand": cfg.circuit.near_pct_by_band,
            "defaultBlockPct": cfg.circuit.default_block_pct,
            "defaultNearPct": cfg.circuit.default_near_pct,
            "requireData": cfg.circuit.require_data,
        },
        "liquidity": cfg.liquidity.__dict__,
        "business": {
            **cfg.business.__dict__,
            "marginEligibleTokens": sorted(cfg.business.margin_eligible_tokens),
            "marginIneligibleTokens": sorted(cfg.business.margin_ineligible_tokens),
        },
        "weekly": cfg.weekly.to_dict(),
        "ledger": {"reentryEnabled": cfg.ledger.reentry_enabled, "reentryReasons": sorted(cfg.ledger.reentry_reasons)},
        "storage": cfg.storage.__dict__,
        "recovery": cfg.recovery.__dict__,
        "publish": cfg.publish.__dict__,
        "reportTopN": cfg.report_top_n,
        "timeframes": list(TIMEFRAMES),
        "blockReasons": list(BLOCK_REASONS),
        "stockStates": list(STOCK_STATES),
        "classifications": list(CLASSIFICATIONS),
        "circuitStatuses": list(CIRCUIT_STATUSES),
        "intradayStatuses": list(INTRADAY_STATUSES),
        "marginStatuses": list(MARGIN_STATUSES),
        "engineStates": list(ENGINE_STATES),
        "weekStatuses": list(WEEK_STATUSES),
        "reviewActions": list(REVIEW_ACTIONS),
        "recommendations": list(RECOMMENDATIONS),
    }


# Module-level cache: configuration is re-resolved by the engine on a timer so
# operators see changes without a restart, but a per-call resolve is cheap
# enough that the cache is invalidated by ``invalidate()``.
_cached_cfg: Optional[MarketWatchConfig] = None


def get() -> MarketWatchConfig:
    global _cached_cfg
    if _cached_cfg is None:
        _cached_cfg = load()
    return _cached_cfg


def invalidate() -> None:
    global _cached_cfg
    _cached_cfg = None


__all__ = [
    "BLOCK_REASONS",
    "BusinessConfig",
    "CadenceConfig",
    "CIRCUIT_STATUS_DANGER",
    "CIRCUIT_STATUS_HIT",
    "CIRCUIT_STATUS_NEAR",
    "CIRCUIT_STATUS_SAFE",
    "CIRCUIT_STATUS_UNKNOWN",
    "CIRCUIT_STATUSES",
    "CLASSIFICATIONS",
    "CLASSIFICATION_DANGER",
    "CLASSIFICATION_GAINER",
    "CLASSIFICATION_INTRADAY_UNAVAILABLE",
    "CLASSIFICATION_LOSER",
    "CLASSIFICATION_NORMAL",
    "DATA_DRIVEN_REASONS",
    "DEFAULT_UNIVERSE_SOURCE",
    "ELIGIBILITY_BLOCKED",
    "ELIGIBILITY_ELIGIBLE",
    "ELIGIBILITY_PENDING",
    "ELIGIBILITY_ELIGIBLE_TOKEN",
    "ELIGIBILITY_UNAVAILABLE",
    "ELIGIBILITY_UNKNOWN",
    "ENGINE_STATES",
    "ENGINE_STATE_BLOCKING",
    "ENGINE_STATE_DEGRADED",
    "ENGINE_STATE_MONITORING",
    "ENGINE_STATE_OFFLINE",
    "ENGINE_STATE_PRE_MARKET",
    "ENGINE_STATE_REPORTING",
    "ENGINE_STATE_STARTING",
    "ENGINE_STATE_STOPPED",
    "ENGINE_STATE_STOPPING",
    "ENGINE_STATE_SUBSCRIBING",
    "ENGINE_STATE_WEEKLY_LOCKED",
    "FilterConfig",
    "INTRADAY_STATUSES",
    "LedgerConfig",
    "LifecycleConfig",
    "LiquidityConfig",
    "MARGIN_STATUSES",
    "MARGIN_STATUS_AUTHORITATIVE",
    "MARGIN_STATUS_BELOW_THRESHOLD",
    "MARGIN_STATUS_UNAVAILABLE",
    "MarketWatchConfig",
    "PriceFilterConfig",
    "PublishConfig",
    "REASON_BUSINESS_RULE",
    "REASON_CIRCUIT_TOO_CLOSE",
    "REASON_DATA_INVALID",
    "REASON_FILTER_FAIL",
    "REASON_INSTRUMENT_INELIGIBLE",
    "REASON_LIQUIDITY_FAIL",
    "REASON_MARGIN_INELIGIBLE",
    "REASON_PRICE_LIMIT",
    "RECOMMENDATIONS",
    "RECOMMENDATION_ADD",
    "RECOMMENDATION_KEEP",
    "RECOMMENDATION_REMOVE",
    "RECOMMENDATION_REVIEW",
    "REVIEW_ACTIONS",
    "REVIEW_ACTION_ADD",
    "REVIEW_ACTION_KEEP",
    "REVIEW_ACTION_REMOVE",
    "RecoveryConfig",
    "STOCK_STATES",
    "STOCK_STATE_ACTIVE",
    "STOCK_STATE_DANGER",
    "STOCK_STATE_INVALID",
    "STOCK_STATE_NO_DATA",
    "STOCK_STATE_STALE",
    "StorageConfig",
    "TIMEFRAMES",
    "TIMEFRAME_SECONDS",
    "TimeframeFilterConfig",
    "UNIVERSE_NORMAL",
    "UNIVERSE_CRITICAL_LOW",
    "UNIVERSE_EMPTY",
    "UNIVERSE_LOW",
    "UNIVERSE_SOURCE_DAILY_MASTER",
    "UNIVERSE_SOURCE_LOCKED",
    "UNIVERSE_SOURCE_VALUES",
    "UniversePolicyConfig",
    "WEEK_STATUSES",
    "WEEK_STATUS_DRAFT",
    "WEEK_STATUS_LOCKED",
    "WEEK_STATUS_SUPERSEDED",
    "WeeklyConfig",
    "as_dict",
    "band_pct_from_circuits",
    "block_pct_for_band",
    "get",
    "invalidate",
    "load",
    "near_pct_for_band",
    "universe_state",
]
