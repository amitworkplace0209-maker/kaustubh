"""Market Watch canonical state models (docs/engines/MARKET_WATCH.md §9, §11, §20).

One typed record per tracked symbol plus the four timeframe records it owns.
These are plain dataclasses (the project convention for engine internals —
``core.engines`` and ``services`` use dataclasses; ``models/`` holds the Pydantic
API schemas) so the hot tick path stays allocation-light and lock-free apart from
the engine's own RLock.

Hard rules encoded here:

* every numeric field is ``Optional`` — a missing broker value stays ``None``
  and is serialised as ``null`` (doc §20 "Do not convert missing data into zero");
* ``data_quality`` is always one of the ``DATA_QUALITY_*`` vocabulary values;
* timeframe ``change_pct`` is NEVER the daily change percentage (doc §11).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

from services.market_watch_config import (
    CIRCUIT_STATUS_DANGER,
    CIRCUIT_STATUS_HIT,
    CIRCUIT_STATUS_NEAR,
    CIRCUIT_STATUS_SAFE,
    CIRCUIT_STATUS_UNKNOWN,
    CIRCUIT_STATUSES,
    CLASSIFICATIONS,
    CLASSIFICATION_DANGER,
    CLASSIFICATION_GAINER,
    CLASSIFICATION_INTRADAY_UNAVAILABLE,
    CLASSIFICATION_LOSER,
    CLASSIFICATION_NORMAL,
    DATA_QUALITY_COMPLETE,
    DATA_QUALITY_IN_PROGRESS,
    DATA_QUALITY_INCOMPLETE,
    DATA_QUALITY_LIVE,
    DATA_QUALITY_STALE,
    DATA_QUALITY_UNAVAILABLE,
    ELIGIBILITY_ELIGIBLE,
    ELIGIBILITY_ELIGIBLE_TOKEN,
    ELIGIBILITY_UNKNOWN,
    ELIGIBILITY_UNAVAILABLE,
    MARGIN_STATUS_AUTHORITATIVE,
    MARGIN_STATUS_BELOW_THRESHOLD,
    MARGIN_STATUS_UNAVAILABLE,
    MARGIN_STATUSES,
    STOCK_STATE_ACTIVE,
    STOCK_STATE_DANGER,
    STOCK_STATE_INTRADAY_UNAVAILABLE,
    STOCK_STATE_INVALID,
    STOCK_STATE_NO_DATA,
    STOCK_STATE_STALE,
    STOCK_STATES,
    TIMEFRAMES,
    block_pct_for_band,
    near_pct_for_band,
)

# Per-token feed status vocabulary (kept from the existing engine contract).
STATUS_PENDING = "PENDING"
STATUS_LIVE = "LIVE"
STATUS_STALE = "STALE"
STATUS_NO_DATA = "NO_DATA"
STATUS_INACTIVE = "INACTIVE"

SUBSCRIPTION_NONE = "NONE"
SUBSCRIPTION_DESIRED = "DESIRED"
SUBSCRIPTION_ACTIVE = "ACTIVE"


def utc_iso(ts: Optional[float]) -> Optional[str]:
    if ts is None:
        return None
    try:
        return datetime.fromtimestamp(float(ts), tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError, OverflowError):
        return None


def fnum(value: Any) -> Optional[float]:
    """Coerce to a finite float or ``None`` (never NaN, never a silent 0)."""
    if value is None or value == "" or isinstance(value, bool):
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return f


def epoch_seconds(value: Any) -> Optional[float]:
    """Normalise an epoch expressed in seconds or milliseconds to seconds."""
    f = fnum(value)
    if f is None:
        return None
    if abs(f) > 10_000_000_000:
        f = f / 1000.0
    return f


def _round(value: Optional[float], digits: int = 4) -> Optional[float]:
    if value is None:
        return None
    return round(value, digits)


@dataclass(slots=True)
class TimeframeState:
    """One 1m/5m/10m/30m bucket (doc §11).

    ``open``/``high``/``low``/``close`` come only from real ticks. A bucket with
    no ticks keeps every price ``None`` and reports ``data_quality =
    UNAVAILABLE``; a bucket that was restored from storage but is missing part of
    its history reports ``INCOMPLETE``. Nothing is ever synthesised.
    """

    timeframe: str
    start_time: Optional[float] = None
    end_time: Optional[float] = None
    open: Optional[float] = None
    high: Optional[float] = None
    low: Optional[float] = None
    close: Optional[float] = None
    volume: Optional[float] = None
    price_move: Optional[float] = None
    change_pct: Optional[float] = None
    vwap: Optional[float] = None
    tick_count: int = 0
    data_quality: str = DATA_QUALITY_UNAVAILABLE
    complete: bool = False
    _cum_turnover: float = field(default=0.0, repr=False)
    _cum_volume: float = field(default=0.0, repr=False)
    _last_volume: Optional[float] = field(default=None, repr=False)

    # ------------------------------------------------------------------ #
    def apply_tick(self, ltp: float, volume: Optional[float], now: float, bucket: float) -> None:
        """Fold one real tick into this bucket.

        ``volume`` is the broker's CUMULATIVE day volume, so the bucket's own
        volume is a delta. The first tick of a bucket anchors the delta; without
        a prior cumulative reading the delta is unknown and the bucket keeps its
        data quality degraded rather than inventing a volume.
        """
        if self.open is None:
            self.open = ltp
            self.high = ltp
            self.low = ltp
            # The broker's ``volume`` is the CUMULATIVE DAY volume, so the first
            # tick of a bucket can only ANCHOR the delta base. Counting the whole
            # cumulative figure as this bucket's volume would report the whole
            # session as one candle.
            self._cum_volume = float(volume) if volume is not None else 0.0
            self._last_volume = volume
            self.volume = 0.0 if volume is not None else None
            self.data_quality = DATA_QUALITY_LIVE if volume is not None else DATA_QUALITY_INCOMPLETE
        else:
            if ltp > (self.high if self.high is not None else ltp):
                self.high = ltp
            if ltp < (self.low if self.low is not None else ltp):
                self.low = ltp
            if volume is not None:
                delta = float(volume) - self._cum_volume
                # Brokers occasionally re-send a lower cumulative volume on a
                # new session roll; never emit a negative bucket volume.
                if delta >= 0:
                    self._cum_volume = float(volume)
                    self._last_volume = volume
                    self.volume = (self.volume or 0.0) + delta
                    # Tick VWAP: turnover accumulated from the real traded
                    # deltas of THIS bucket only (never the broker's day VWAP,
                    # which would mix the whole session into one candle).
                    self._cum_turnover += ltp * delta
            if self.data_quality != DATA_QUALITY_INCOMPLETE:
                self.data_quality = DATA_QUALITY_LIVE
        self.close = ltp
        self.end_time = now
        self.tick_count += 1
        self.start_time = self.start_time if self.start_time is not None else bucket
        self.complete = False
        self.data_quality = self.data_quality or DATA_QUALITY_LIVE
        self._recompute(now)

    def _recompute(self, now: float) -> None:
        self.price_move = None
        self.change_pct = None
        if self.open in (None, 0) or self.close is None:
            return
        self.price_move = self.close - self.open
        self.change_pct = (self.close - self.open) / self.open * 100.0
        # VWAP only from real traded turnover inside this bucket. Without traded
        # volume the VWAP is unknown and stays None — it is never a price average.
        if self.volume and self._cum_turnover > 0:
            self.vwap = self._cum_turnover / self.volume
        else:
            self.vwap = None

    def mark_stale(self, now: float, stale_after: float) -> None:
        if self.tick_count == 0:
            self.data_quality = DATA_QUALITY_UNAVAILABLE
            return
        if self.complete:
            self.data_quality = DATA_QUALITY_COMPLETE
            return
        if self.end_time is not None and (now - self.end_time) > stale_after:
            self.data_quality = DATA_QUALITY_STALE

    def mark_incomplete(self) -> None:
        self.data_quality = DATA_QUALITY_INCOMPLETE

    def to_dict(self) -> dict[str, Any]:
        return {
            "timeframe": self.timeframe,
            "open": _round(self.open),
            "high": _round(self.high),
            "low": _round(self.low),
            "close": _round(self.close),
            "volume": self.volume,
            "priceMove": _round(self.price_move),
            "changePct": _round(self.change_pct),
            "vwap": _round(self.vwap),
            "startTime": utc_iso(self.start_time),
            "endTime": utc_iso(self.end_time),
            "tickCount": self.tick_count,
            "dataQuality": self.data_quality,
            "complete": self.complete,
        }

    def to_storage_doc(self, symbol: str, token: str, date: str) -> dict[str, Any]:
        return {
            "date": date,
            "symbol": symbol,
            "instrumentToken": token,
            "timeframe": self.timeframe,
            "bucketStart": utc_iso(self.start_time),
            "bucketStartEpoch": self.start_time,
            "bucketEnd": utc_iso(self.end_time),
            "open": _round(self.open),
            "high": _round(self.high),
            "low": _round(self.low),
            "close": _round(self.close),
            "volume": self.volume,
            "priceMove": _round(self.price_move),
            "changePct": _round(self.change_pct),
            "vwap": _round(self.vwap),
            "tickCount": self.tick_count,
            "dataQuality": self.data_quality,
            "complete": self.complete,
        }

    @classmethod
    def from_storage_doc(cls, doc: dict[str, Any]) -> "TimeframeState":
        tf = str(doc.get("timeframe") or "1m")
        state = cls(timeframe=tf)
        state.open = fnum(doc.get("open"))
        state.high = fnum(doc.get("high"))
        state.low = fnum(doc.get("low"))
        state.close = fnum(doc.get("close"))
        state.volume = fnum(doc.get("volume"))
        state.price_move = fnum(doc.get("priceMove"))
        state.change_pct = fnum(doc.get("changePct"))
        state.vwap = fnum(doc.get("vwap"))
        state.tick_count = int(doc.get("tickCount") or 0)
        state.complete = bool(doc.get("complete"))
        state.start_time = epoch_seconds(doc.get("bucketStartEpoch") or doc.get("bucketStart"))
        state.end_time = epoch_seconds(doc.get("bucketEnd"))
        state.data_quality = str(doc.get("dataQuality") or DATA_QUALITY_INCOMPLETE)
        return state


@dataclass(slots=True)
class IndexState:
    """A live index (doc §17). Fed by real index ticks, published independently
    of the 30-second ranking cycle."""

    name: str
    token: str
    ltp: Optional[float] = None
    open: Optional[float] = None
    high: Optional[float] = None
    low: Optional[float] = None
    previous_close: Optional[float] = None
    change: Optional[float] = None
    change_pct: Optional[float] = None
    volume: Optional[float] = None
    last_tick_time: Optional[float] = None
    tick_count: int = 0
    data_quality: str = DATA_QUALITY_UNAVAILABLE

    def apply_tick(self, tick: dict[str, Any], now: float) -> bool:
        ltp = fnum(tick.get("ltp") or tick.get("lastPrice") or tick.get("lastTradedPrice"))
        if ltp is None or ltp <= 0:
            return False
        self.ltp = ltp
        self.open = fnum(tick.get("open") or tick.get("openPrice")) or self.open
        self.high = fnum(tick.get("high") or tick.get("highPrice")) or self.high
        self.low = fnum(tick.get("low") or tick.get("lowPrice")) or self.low
        prev = fnum(tick.get("prevClose") or tick.get("previousClose") or tick.get("close"))
        if prev is not None:
            self.previous_close = prev
        vol = fnum(tick.get("volume") or tick.get("totalTradedVolume"))
        if vol is not None:
            self.volume = vol
        if self.previous_close not in (None, 0):
            self.change = ltp - self.previous_close
            self.change_pct = (self.change / self.previous_close) * 100.0
        self.last_tick_time = epoch_seconds(tick.get("timestamp") or tick.get("brokerUpdateTimestamp")) or now
        self.tick_count += 1
        self.data_quality = DATA_QUALITY_LIVE
        return True

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "token": self.token,
            "ltp": _round(self.ltp, 2),
            "open": _round(self.open, 2),
            "high": _round(self.high, 2),
            "low": _round(self.low, 2),
            "previousClose": _round(self.previous_close, 2),
            "change": _round(self.change, 2),
            "changePct": _round(self.change_pct, 2),
            "volume": self.volume,
            "lastTickTime": utc_iso(self.last_tick_time),
            "tickCount": self.tick_count,
            "dataQuality": self.data_quality,
        }


@dataclass(slots=True)
class SymbolState:
    """Canonical per-symbol Market Watch state (doc §9, verbatim field list)."""

    symbol: str
    instrument_token: str
    exchange_segment: str = "nse_cm"
    exchange: str = "NSE"
    segment: str = "EQUITY"
    name: str = ""

    ltp: Optional[float] = None
    previous_close: Optional[float] = None
    change: Optional[float] = None
    change_pct: Optional[float] = None

    volume: Optional[float] = None
    vwap: Optional[float] = None
    open: Optional[float] = None
    day_high: Optional[float] = None
    day_low: Optional[float] = None

    upper_circuit: Optional[float] = None
    lower_circuit: Optional[float] = None
    circuit_distance_upper_pct: Optional[float] = None
    circuit_distance_lower_pct: Optional[float] = None
    circuit_band_pct: Optional[float] = None
    #: doc §14 — SAFE / NEAR / DANGER / HIT / UNKNOWN. UNKNOWN whenever the real
    #: circuit prices are missing; safety is never fabricated.
    circuit_status: str = CIRCUIT_STATUS_UNKNOWN

    last_tick_time: Optional[float] = None
    last_valid_tick_time: Optional[float] = None
    tick_count: int = 0

    eligibility_status: str = ELIGIBILITY_ELIGIBLE
    block_reason: Optional[str] = None
    blocked_at: Optional[float] = None
    block_threshold: Optional[float] = None
    block_observed: Optional[float] = None
    subscription_status: str = SUBSCRIPTION_NONE

    timeframes: dict[str, TimeframeState] = field(default_factory=dict)

    data_quality: str = DATA_QUALITY_UNAVAILABLE
    status: str = STATUS_PENDING

    # Optional real extra fields (depth/spread) retained for the REST surface.
    bid: Optional[float] = None
    ask: Optional[float] = None
    data_age_sec: Optional[float] = None

    # ------------------------------------------------------------------ #
    # doc §27 stock-level business state and §20 classification.
    #
    # ``status`` above stays the per-token FEED status (PENDING/LIVE/STALE/…),
    # which is a freshness signal. ``stock_state`` is the doc §27 business
    # state, ``classification`` is the doc §20 label, and ``movement_flags``
    # is the doc §21 per-timeframe 1% mover set. All three are derived in the
    # backend; the frontend only renders them (doc §24).
    # ------------------------------------------------------------------ #
    stock_state: str = STOCK_STATE_NO_DATA
    classification: str = CLASSIFICATION_NORMAL
    movement_flags: dict[str, bool] = field(default_factory=dict)

    # doc §15 intraday eligibility as a three-value status.
    intraday_status: str = ELIGIBILITY_UNKNOWN

    # doc §17 — authoritative broker/margin owner values only. ``None`` means
    # the broker published nothing; leverage is never invented.
    margin_value: Optional[float] = None
    margin_multiplier: Optional[float] = None
    margin_status: str = MARGIN_STATUS_UNAVAILABLE

    # doc §16 ₹800 observation counters (weekly review criterion only).
    observations_above_threshold: int = 0
    observations_at_or_below_threshold: int = 0
    last_threshold_observation_at: Optional[float] = None

    # doc §5 — share of the weekly-report field list this symbol can supply.
    data_completeness: Optional[float] = None

    def __post_init__(self) -> None:
        for tf in TIMEFRAMES:
            self.timeframes.setdefault(tf, TimeframeState(timeframe=tf))

    # ------------------------------------------------------------------ #
    def apply_price_tick(self, *, now: float, ltp: float, previous_close: Optional[float],
                         volume: Optional[float], open_: Optional[float], high: Optional[float],
                         low: Optional[float], timestamp: Optional[float] = None) -> None:
        """Fold one validated tick into the canonical state (single symbol only)."""
        self.ltp = ltp
        if previous_close not in (None, 0):
            self.previous_close = previous_close
        self.change = ltp - self.previous_close if self.previous_close is not None else None
        self.change_pct = (self.change / self.previous_close * 100.0) if self.change is not None and self.previous_close else None
        if volume is not None:
            self.volume = volume
        self.open = open_ if open_ is not None else self.open
        if high is not None:
            self.day_high = high if self.day_high is None else max(self.day_high, high)
        if low is not None:
            self.day_low = low if self.day_low is None else min(self.day_low, low)
        self.last_tick_time = timestamp if timestamp is not None else now
        self.last_valid_tick_time = self.last_tick_time
        self.tick_count += 1
        self.data_age_sec = round(max(0.0, now - (self.last_tick_time or now)), 3)
        self.data_quality = DATA_QUALITY_LIVE
        self.status = STATUS_LIVE

    def apply_circuits(self, upper: Optional[float], lower: Optional[float]) -> bool:
        """Store real circuit prices and recompute the ACTUAL circuit distance.

        distance_upper = (upper_circuit - ltp) / upper_circuit * 100
        distance_lower = (ltp - lower_circuit) / lower_circuit * 100

        Circuit proximity is therefore derived from the real circuit boundary and
        never from the daily change percentage (doc §7).
        """
        changed = False
        if upper is not None and upper > 0:
            self.upper_circuit = upper
            changed = True
        if lower is not None and lower > 0:
            self.lower_circuit = lower
            changed = True
        self.recompute_circuit_distance()
        return changed

    def recompute_circuit_distance(self) -> None:
        ltp = self.ltp
        if ltp is not None and self.upper_circuit:
            self.circuit_distance_upper_pct = (self.upper_circuit - ltp) / self.upper_circuit * 100.0
        else:
            self.circuit_distance_upper_pct = None
        if ltp is not None and self.lower_circuit:
            self.circuit_distance_lower_pct = (ltp - self.lower_circuit) / self.lower_circuit * 100.0
        else:
            self.circuit_distance_lower_pct = None
        if self.upper_circuit and self.lower_circuit and self.previous_close:
            from services.market_watch_config import band_pct_from_circuits

            # Per-side band (exchange convention: 2/5/10/20%), derived from the
            # real circuit prices, so the configured band keys line up.
            self.circuit_band_pct = band_pct_from_circuits(
                self.upper_circuit, self.lower_circuit, self.previous_close
            )
        else:
            self.circuit_band_pct = None

    def block(self, reason: str, threshold: Optional[float], observed: Optional[float], now: float) -> None:
        from services.market_watch_config import ELIGIBILITY_BLOCKED

        self.eligibility_status = ELIGIBILITY_BLOCKED
        self.block_reason = reason
        self.block_threshold = threshold
        self.block_observed = observed
        self.blocked_at = now

    def unblock(self) -> None:
        from services.market_watch_config import ELIGIBILITY_ELIGIBLE

        self.eligibility_status = ELIGIBILITY_ELIGIBLE
        self.block_reason = None
        self.block_threshold = None
        self.block_observed = None
        self.blocked_at = None

    @property
    def is_blocked(self) -> bool:
        from services.market_watch_config import ELIGIBILITY_BLOCKED

        return self.eligibility_status == ELIGIBILITY_BLOCKED

    # ------------------------------------------------------------------ #
    # ------------------------------------------------------------------ #
    def min_circuit_distance_pct(self) -> Optional[float]:
        """Smallest valid upper/lower circuit distance, or ``None``.

        doc §14: the danger test is on the MINIMUM valid distance, so a missing
        side must never be read as 0 (that would fake a danger).
        """
        values = [
            d
            for d in (self.circuit_distance_upper_pct, self.circuit_distance_lower_pct)
            if d is not None and d >= 0
        ]
        return min(values) if values else None

    def recompute_circuit_status(self, cfg: Any = None) -> str:
        """doc §14 — classify circuit safety from the REAL circuit prices.

        ``UNKNOWN`` when either circuit price is missing (never fabricate
        safety), ``HIT`` at or beyond a boundary, ``DANGER`` inside the
        configured danger band, ``NEAR`` inside the near band, else ``SAFE``.
        """
        upper, lower = self.upper_circuit, self.lower_circuit
        ltp = self.ltp
        if upper is None or lower is None or ltp is None:
            self.circuit_status = CIRCUIT_STATUS_UNKNOWN
            return self.circuit_status
        if ltp >= upper or ltp <= lower:
            self.circuit_status = CIRCUIT_STATUS_HIT
            return self.circuit_status
        minimum = self.min_circuit_distance_pct()
        if minimum is None:
            self.circuit_status = CIRCUIT_STATUS_UNKNOWN
            return self.circuit_status
        if cfg is not None:
            if minimum < cfg.weekly.danger_circuit_pct:
                self.circuit_status = CIRCUIT_STATUS_DANGER
                return self.circuit_status
            near = near_pct_for_band(cfg.circuit, self.circuit_band_pct)
            if minimum < near:
                self.circuit_status = CIRCUIT_STATUS_NEAR
                return self.circuit_status
        self.circuit_status = CIRCUIT_STATUS_SAFE
        return self.circuit_status

    def apply_margin(
        self,
        *,
        value: Optional[float],
        multiplier: Optional[float],
        threshold: float,
        status: Optional[str] = None,
    ) -> str:
        """doc §17 — store the authoritative broker margin answer.

        Market Watch CONSUMES margin; it never computes leverage. When nothing
        authoritative is available the status is ``UNAVAILABLE`` and both values
        stay ``None``.
        """
        self.margin_value = value
        self.margin_multiplier = multiplier
        if status:
            self.margin_status = status
        elif multiplier is None or value is None:
            self.margin_status = MARGIN_STATUS_UNAVAILABLE
        elif multiplier < threshold:
            self.margin_status = MARGIN_STATUS_BELOW_THRESHOLD
        else:
            self.margin_status = MARGIN_STATUS_AUTHORITATIVE
        return self.margin_status

    def observe_threshold(self, ltp: Optional[float], threshold: float, now: float, interval: float) -> bool:
        """doc §16 — count above/at-or-below observations.

        Sampled at ``interval`` seconds so a fast feed cannot inflate the weekly
        counters. Crossing the threshold NEVER changes membership (doc §33);
        this only feeds the Saturday report.
        """
        if ltp is None:
            return False
        if (
            self.last_threshold_observation_at is not None
            and (now - self.last_threshold_observation_at) < interval
        ):
            return False
        self.last_threshold_observation_at = now
        if ltp >= threshold:
            self.observations_above_threshold += 1
        else:
            self.observations_at_or_below_threshold += 1
        return True

    # ------------------------------------------------------------------ #
    def evaluate_movement_flags(self, threshold: float) -> dict[str, bool]:
        """doc §21 — per-timeframe 1% mover flags, computed in the backend.

        ``True`` means ``abs(change_pct) >= threshold`` for that timeframe.
        A timeframe with no data is ``False`` (never treated as a mover).
        """
        flags: dict[str, bool] = {}
        for name in TIMEFRAMES:
            tf = self.timeframes.get(name)
            pct = tf.change_pct if tf is not None else None
            flags[name] = bool(pct is not None and abs(pct) >= threshold)
        self.movement_flags = flags
        return flags

    def evaluate_stock_state(self, *, now: float, stale_after: float, cfg: Any = None) -> str:
        """doc §27 stock state + doc §20 classification, backend-owned.

        Precedence (doc §20)::

            DANGER > INTRADAY_UNAVAILABLE > GAINER / LOSER > NORMAL

        ``stock_state`` mirrors the business outcome; ``classification`` is the
        doc §20 label the frontend renders (doc §24 forbids the client deriving
        either).
        """
        # INVALID — the tick itself never made it into calculation state, so a
        # symbol with no usable LTP and an explicit invalid reason is invalid.
        if self.ltp is None and self.data_quality == DATA_QUALITY_UNAVAILABLE and self.block_reason:
            self.stock_state = STOCK_STATE_INVALID
            self.classification = CLASSIFICATION_DANGER
            return self.stock_state

        circuit_status = (
            self.circuit_status
            if cfg is not None
            else self.recompute_circuit_status(None)
        )
        self.classification = self._classify(circuit_status, cfg)
        self.stock_state = self._stock_state_from_classification()
        return self.stock_state

    def _classify(self, circuit_status: str, cfg: Any) -> str:
        # 1. DANGER — circuit danger/hit, or intraday unavailable.
        if circuit_status in (CIRCUIT_STATUS_DANGER, CIRCUIT_STATUS_HIT):
            return CLASSIFICATION_DANGER
        if self.intraday_status == ELIGIBILITY_UNAVAILABLE:
            return CLASSIFICATION_INTRADAY_UNAVAILABLE
        # 2. Movement — only a valid, priced symbol can be a gainer/loser.
        if self.ltp is None or self.change_pct is None:
            return CLASSIFICATION_NORMAL
        normal_below = cfg.weekly.normal_threshold_pct if cfg is not None else 1.0
        if abs(self.change_pct) < normal_below:
            return CLASSIFICATION_NORMAL
        return CLASSIFICATION_GAINER if self.change_pct > 0 else CLASSIFICATION_LOSER

    def _stock_state_from_classification(self) -> str:
        classification = self.classification
        if classification == CLASSIFICATION_DANGER:
            return STOCK_STATE_DANGER
        if classification == CLASSIFICATION_INTRADAY_UNAVAILABLE:
            return STOCK_STATE_INTRADAY_UNAVAILABLE
        # Feed freshness still decides between a usable and an unusable symbol.
        if self.ltp is None:
            return STOCK_STATE_NO_DATA
        if self.status == STATUS_STALE:
            return STOCK_STATE_STALE
        if self.status in (STATUS_NO_DATA, STATUS_INACTIVE):
            return STOCK_STATE_NO_DATA
        return STOCK_STATE_ACTIVE

    def timeframe(self, name: str) -> TimeframeState:
        tf = self.timeframes.get(name)
        if tf is None:
            tf = TimeframeState(timeframe=name)
            self.timeframes[name] = tf
        return tf

    def refresh_status(self, now: float, stale_after: float) -> None:
        if self.status == STATUS_NO_DATA or self.status == STATUS_INACTIVE:
            return
        if self.last_valid_tick_time is None:
            self.status = STATUS_PENDING
        elif (now - self.last_valid_tick_time) > stale_after:
            self.status = STATUS_STALE
        else:
            self.status = STATUS_LIVE
        for tf in self.timeframes.values():
            tf.mark_stale(now, stale_after)

    # ------------------------------------------------------------------ #
    def to_public(self, *, include_timeframes: bool = True) -> dict[str, Any]:
        """Serialise for WS#3 / REST. Missing values stay ``None`` (doc §20)."""
        out: dict[str, Any] = {
            "symbol": self.symbol,
            "token": self.instrument_token,
            "name": self.name,
            "exchange": self.exchange,
            "exchangeSegment": self.exchange_segment,
            "segment": self.segment,
            "ltp": _round(self.ltp, 4),
            "previousClose": _round(self.previous_close, 4),
            "change": _round(self.change, 4),
            "changePercent": _round(self.change_pct, 4),
            "volume": self.volume,
            "vwap": _round(self.vwap, 4),
            "open": _round(self.open, 4),
            "dayHigh": _round(self.day_high, 4),
            "dayLow": _round(self.day_low, 4),
            "upperCircuit": _round(self.upper_circuit, 4),
            "lowerCircuit": _round(self.lower_circuit, 4),
            "circuitDistanceUpperPct": _round(self.circuit_distance_upper_pct, 4),
            "circuitDistanceLowerPct": _round(self.circuit_distance_lower_pct, 4),
            "circuitDistancePct": _round(self.min_circuit_distance_pct(), 4),
            "circuitBandPct": _round(self.circuit_band_pct, 4),
            "circuitStatus": self.circuit_status,
            "marginValue": _round(self.margin_value, 4),
            "marginMultiplier": _round(self.margin_multiplier, 4),
            "marginStatus": self.margin_status,
            "intradayStatus": self.intraday_status,
            "observationsAboveThreshold": self.observations_above_threshold,
            "observationsAtOrBelowThreshold": self.observations_at_or_below_threshold,
            "lastThresholdObservationAt": utc_iso(self.last_threshold_observation_at),
            "dataCompleteness": self.data_completeness,
            "lastTickAt": utc_iso(self.last_tick_time),
            "lastTickEpoch": self.last_tick_time,
            "lastValidTickTime": utc_iso(self.last_valid_tick_time),
            "tickCount": self.tick_count,
            "eligibilityStatus": self.eligibility_status,
            "blockReason": self.block_reason,
            "blockedAt": utc_iso(self.blocked_at),
            "subscriptionStatus": self.subscription_status,
            "dataQuality": self.data_quality,
            "status": self.status,
            "stockState": self.stock_state,
            "classification": self.classification,
            "movementFlags": dict(self.movement_flags),
            "dataAgeSec": self.data_age_sec,
            "bid": _round(self.bid, 4),
            "ask": _round(self.ask, 4),
        }
        if include_timeframes:
            out["timeframes"] = {name: tf.to_dict() for name, tf in self.timeframes.items()}
            # doc §19 — flat per-timeframe change / change_pct. These are the
            # contract fields the frontend renders; it must never derive them
            # (doc §24). Nested ``timeframes`` above stays for OHLCV detail.
            for name in TIMEFRAMES:
                tf = self.timeframes.get(name)
                out[f"change_{name}"] = _round(tf.price_move, 4) if tf else None
                out[f"change_{name}_pct"] = _round(tf.change_pct, 4) if tf else None
            # Backwards-compatible flat fields for the existing UI/rank sections.
            m5 = self.timeframes.get("5m")
            m10 = self.timeframes.get("10m")
            out["fiveMinPercent"] = _round(m5.change_pct, 4) if m5 else None
            out["tenMinPercent"] = _round(m10.change_pct, 4) if m10 else None
        return out

    def to_compact(self) -> dict[str, Any]:
        """Compact row for ranking / Show More payloads (still real values only)."""
        return {
            "token": self.instrument_token,
            "symbol": self.symbol,
            "name": self.name,
            "exchangeSegment": self.exchange_segment,
            "ltp": _round(self.ltp, 4),
            "change": _round(self.change, 4),
            "changePercent": _round(self.change_pct, 4),
            "volume": self.volume,
            "turnover": _round(self.vwap and self.vwap * (self.volume or 0), 2),
            "open": _round(self.open, 4),
            "high": _round(self.day_high, 4),
            "low": _round(self.day_low, 4),
            "upperCircuit": _round(self.upper_circuit, 4),
            "lowerCircuit": _round(self.lower_circuit, 4),
            "circuitDistanceUpperPct": _round(self.circuit_distance_upper_pct, 4),
            "circuitDistanceLowerPct": _round(self.circuit_distance_lower_pct, 4),
            "circuitDistancePct": _round(self.min_circuit_distance_pct(), 4),
            "circuitStatus": self.circuit_status,
            "marginValue": _round(self.margin_value, 4),
            "marginMultiplier": _round(self.margin_multiplier, 4),
            "marginStatus": self.margin_status,
            "intradayStatus": self.intraday_status,
            "classification": self.classification,
            "stockState": self.stock_state,
            "movementFlags": dict(self.movement_flags),
            "dataCompleteness": self.data_completeness,
            "dataQuality": self.data_quality,
            "status": self.status,
            "eligibilityStatus": self.eligibility_status,
            "blockReason": self.block_reason,
            "lastTickAt": utc_iso(self.last_tick_time),
            "change_1m": _round(self.timeframes["1m"].price_move, 4) if "1m" in self.timeframes else None,
            "change_1m_pct": _round(self.timeframes["1m"].change_pct, 4) if "1m" in self.timeframes else None,
            "change_2m": _round(self.timeframes["2m"].price_move, 4) if "2m" in self.timeframes else None,
            "change_2m_pct": _round(self.timeframes["2m"].change_pct, 4) if "2m" in self.timeframes else None,
            "change_5m": _round(self.timeframes["5m"].price_move, 4) if "5m" in self.timeframes else None,
            "change_5m_pct": _round(self.timeframes["5m"].change_pct, 4) if "5m" in self.timeframes else None,
            "change_10m": _round(self.timeframes["10m"].price_move, 4) if "10m" in self.timeframes else None,
            "change_10m_pct": _round(self.timeframes["10m"].change_pct, 4) if "10m" in self.timeframes else None,
            "change_30m": _round(self.timeframes["30m"].price_move, 4) if "30m" in self.timeframes else None,
            "change_30m_pct": _round(self.timeframes["30m"].change_pct, 4) if "30m" in self.timeframes else None,
        }


__all__ = [
    "CIRCUIT_STATUSES",
    "CLASSIFICATIONS",
    "DATA_QUALITY_COMPLETE",
    "DATA_QUALITY_IN_PROGRESS",
    "DATA_QUALITY_INCOMPLETE",
    "DATA_QUALITY_LIVE",
    "DATA_QUALITY_STALE",
    "DATA_QUALITY_UNAVAILABLE",
    "ELIGIBILITY_ELIGIBLE_TOKEN",
    "ELIGIBILITY_UNKNOWN",
    "ELIGIBILITY_UNAVAILABLE",
    "MARGIN_STATUSES",
    "STOCK_STATES",
    "STATUS_INACTIVE",
    "STATUS_LIVE",
    "STATUS_NO_DATA",
    "STATUS_PENDING",
    "STATUS_STALE",
    "SUBSCRIPTION_ACTIVE",
    "SUBSCRIPTION_DESIRED",
    "SUBSCRIPTION_NONE",
    "IndexState",
    "SymbolState",
    "TimeframeState",
    "epoch_seconds",
    "fnum",
    "utc_iso",
]
