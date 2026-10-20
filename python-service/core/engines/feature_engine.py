"""Feature / Calculation Engine — converts raw ticks into strategy-ready data.

Receives normalized ticks from the WebSocket Engine via the event bus,
calculates derived fields (change, change%, spread, rolling metrics),
and maintains per-instrument feature state for the Model Group and
Suggestion Engine.

Contract (docs/engines/feature-engine.md):
- Consumes ONLY the standardized MarketFeed (never raw broker payloads).
- Input fields and calculated fields are kept in separate namespaces
  (``marketData`` vs ``features``) so broker/feed values never mix with
  derived values.
- Missing inputs are reported in ``missingInputs`` / ``inputQuality`` —
  never silently fabricated (e.g. missing volume is not turned into 0).
- Every calculation carries a status (AVAILABLE / WARMING_UP /
  MISSING_INPUT) so an invalid calculation is never presented as valid.
- Output carries ``featureVersion`` so formula changes stay comparable.
- Per-instrument state (price/volume history, previous tick) is isolated.
- Calculation latency and error counts are measured (perf §24-25).
"""

from __future__ import annotations

import logging
import time
from collections import defaultdict, deque
from typing import Any, Optional

from core.engines.engine_base import EngineBase, EngineState, EngineHealth, EngineCategory
from core.engines.engine_config import ConfigField, read_only
from core.engines.feature_calculators import (
    AVAILABLE,
    ERROR,
    MISSING_INPUT,
    WARMING_UP,
    CalculatorContext,
    CalculatorRegistry,
    CalculatorState,
    DEFAULT_CALCULATIONS,
    default_registry,
)
from services import pipeline_latency
from services.engine_event_bus import get_event_bus, EngineEvent, EngineEvents

logger = logging.getLogger("app.feature_engine")

FEATURE_VERSION = "v1"

# Standardized MarketFeed input fields the engine understands. This is the
# input *contract*; the engine never assumes a field exists merely because it
# is common in market-data feeds.
INPUT_FIELDS = (
    "ltp", "lastPrice", "open", "high", "low", "close", "volume",
    "bid", "ask", "bidQty", "askQty", "prevClose", "timestamp", "ts",
    "exchange",
)
# Feed fields passed through verbatim into the marketData namespace.
MARKET_DATA_FIELDS = (
    "open", "high", "low", "close", "volume", "bid", "ask", "bidQty", "askQty",
    "prevClose",
)
# Calculations this engine can produce (additive / pluggable per doc §21-22).
# Sourced from the calculator registry so the contract can never drift from
# the registered plug-ins.
CALCULATIONS = DEFAULT_CALCULATIONS

# Default rolling window when the runtime settings bridge has no value yet.
DEFAULT_ROLLING_WINDOW = 600


def _rolling_window() -> int:
    """Live rolling-window length in seconds (settings bridge -> default).

    Read through the runtime bridge rather than baked in, so a change made in
    the Service Control Center actually resizes the history window instead of
    only updating a label.
    """
    try:
        from services.runtime_settings import rt_int
        return max(rt_int("fe_rolling_window", DEFAULT_ROLLING_WINDOW), 1)
    except Exception:
        return DEFAULT_ROLLING_WINDOW


class FeatureEngine(EngineBase):
    engine_id = "feature_engine"
    engine_name = "Feature Engine"
    engine_category = EngineCategory.MARKET_DATA
    engine_version = "1.0.0"

    config_fields = (
        ConfigField(
            key="fe_rolling_window",
            label="Rolling Window",
            summary="rollingWindow",
            type="number",
            min=1,
            max=86400,
            unit="s",
            group="Computation",
            help="Seconds of tick history each feature calculation looks back over.",
        ),
        read_only("calculations", "Calculations"),
        read_only("calculators", "Calculator Plug-ins"),
        read_only("featureVersion", "Feature Version"),
        read_only("inputContract", "Input Contract"),
    )

    def __init__(self) -> None:
        super().__init__()
        self._tick_cache: dict[str, dict] = {}  # token -> latest standardized tick
        self._rolling_window_size = _rolling_window()
        self._price_history: dict[str, deque] = defaultdict(
            lambda: deque(maxlen=self._rolling_window_size))
        self._feature_cache: dict[str, dict] = {}  # token -> latest FeatureOutput
        self._canonical_cache: dict[str, dict] = {}  # token -> latest masterCanonical (opt-in)
        self._calculation_count = 0
        self._invalid_input_count = 0
        self._missing_input_count = 0
        self._latency_samples: deque[float] = deque(maxlen=200)
        self._subscriber_queue = None
        self._listener_task = None
        # Modular calculator plug-ins (doc §20-§21). Each calculation is
        # independent and error-isolated (doc §26); per-calculator stats and
        # latency are tracked for the metrics contract (doc §25).
        self.calculators: CalculatorRegistry = default_registry()
        self._calc_state: dict[str, CalculatorState] = {}
        self._calc_stats: dict[str, dict] = {}
        self._calc_latency: dict[str, deque] = {}
        for calculator in self.calculators.list():
            self._calc_stats[calculator.name] = {
                "calculations": 0, "errors": 0, "available": 0,
                "warmup": 0, "missingInput": 0, "invalidInput": 0,
                "lastStatus": None, "lastValue": None, "lastLatencyMs": None,
            }
            self._calc_latency[calculator.name] = deque(maxlen=200)

    async def _on_start(self) -> None:
        self._subscriber_queue = await get_event_bus().subscribe([EngineEvents.TICK_VALIDATED])
        self._listener_task = __import__("asyncio").create_task(self._listen_loop())
        self.set_dependencies(["websocket_engine", "connection_manager"])
        self.refresh_config_summary()
        logger.info("[FEATURE] engine started")

    def refresh_config_summary(self) -> None:
        """Re-read the rolling window from the settings bridge.

        Pure function of the live setting, so the Control Center can republish
        it on demand instead of showing whatever was captured at startup.
        """
        self.set_config_summary({
            "rollingWindow": _rolling_window(),
            "calculations": list(CALCULATIONS),
            "calculators": self.calculators.describe(),
            "featureVersion": FEATURE_VERSION,
            "inputContract": list(INPUT_FIELDS),
        })

    async def _on_stop(self) -> None:
        if self._subscriber_queue and self._listener_task:
            self._listener_task.cancel()
            try:
                await self._listener_task
            except Exception:
                pass
            await get_event_bus().unsubscribe(self._subscriber_queue)
        self._tick_cache.clear()
        self._feature_cache.clear()
        self._canonical_cache.clear()
        logger.info("[FEATURE] engine stopped")

    def canonical_for(self, token: str) -> dict | None:
        """Latest MASTER CANONICAL market-data object for a token (opt-in).

        None until the WebSocket Engine enables the master-canonical handoff.
        """
        return self._canonical_cache.get(token)

    async def _listen_loop(self) -> None:
        """Consume validated ticks and compute features."""
        q = self._subscriber_queue
        if not q:
            return
        while True:
            try:
                event = await q.get()
                tick = event.get("data", {})
                token = tick.get("instrumentToken") or tick.get("token", "")
                if not token:
                    continue
                self._sync_rolling_window()
                self._process_tick(token, tick)
            except __import__("asyncio").CancelledError:
                raise
            except Exception as exc:
                self.record_error("tick_processing_error", str(exc))

    def _sync_rolling_window(self) -> None:
        """Resize the per-instrument history when the setting changed.

        A deque's maxlen is fixed at construction, so a window change has to
        rebuild the buffers. History already collected beyond the new window is
        dropped, and the retained tail is preserved rather than discarded.
        """
        wanted = _rolling_window()
        if wanted == self._rolling_window_size:
            return
        self._rolling_window_size = wanted
        rebuilt: dict[str, deque] = defaultdict(lambda: deque(maxlen=wanted))
        for token, history in self._price_history.items():
            rebuilt[token] = deque(list(history)[-wanted:], maxlen=wanted)
        self._price_history = rebuilt
        # Republish the summary so the Control Center reports the window that is
        # actually in force instead of the one captured at startup.
        self.refresh_config_summary()
        self.record_activity("ROLLING_WINDOW_CHANGED", f"window={wanted}s")

    def _process_tick(self, token: str, tick: dict) -> None:
        """Compute features from a single standardized tick.

        The engine isolates per-instrument state and never mixes instruments:
        every value computed downstream is derived from this token's own state.
        """
        start = time.perf_counter()
        now = time.time()

        ltp = self._safe_float(tick.get("ltp") or tick.get("lastPrice"))
        if ltp is None or ltp <= 0:
            self._invalid_input_count += 1
            self.set_metric("invalidInputs", self._invalid_input_count)
            self.record_event()
            return

        symbol = tick.get("symbol") or tick.get("tradingSymbol") or ""
        exchange = tick.get("exchange", "")
        feed_ts = tick.get("timestamp") or tick.get("ts") or now

        # Capture the standardized feed inputs (verbatim, non-calculated).
        market: dict[str, Any] = {"ltp": ltp}
        for field in MARKET_DATA_FIELDS:
            value = tick.get(field)
            if value is None:
                continue
            market[field] = self._safe_float(value)
        if exchange:
            market["exchange"] = exchange

        # Required-input accounting. Volume may legitimately be absent; it is
        # reported as missing, never fabricated to 0 (doc §13).
        volume = market.get("volume")
        missing: list[str] = []
        quality: dict[str, str] = {"ltp": "AVAILABLE"}
        if volume is None:
            missing.append("volume")
            quality["volume"] = "NOT_RECEIVED"
        else:
            quality["volume"] = "AVAILABLE"
        for ohlc_field in ("open", "high", "low", "close"):
            if ohlc_field in market:
                quality[ohlc_field] = "AVAILABLE"
            else:
                quality[ohlc_field] = "NOT_RECEIVED"

        prev = self._tick_cache.get(token)
        self._tick_cache[token] = tick

        # Master canonical handoff (opt-in): when the WebSocket Engine ships
        # ``masterCanonical`` on TICK_VALIDATED, the FE caches the authoritative
        # canonical object for this token. Existing calculators keep consuming
        # the fixed flat schema; NEW feature code consumes the canonical object
        # (no broker-specific names, no alias duplicates).
        mc = tick.get("masterCanonical")
        if mc:
            self._canonical_cache[token] = mc

        history = self._price_history[token]
        history.append((now, ltp, volume if volume is not None else 0.0))

        state = self._calc_state.get(token)
        if state is None:
            state = CalculatorState()
            self._calc_state[token] = state
        # Only a real positive volume is observed (doc §13 — never fabricate 0).
        state.observe(now, ltp, volume if (volume is not None and volume > 0) else None)

        ctx = CalculatorContext(ltp=ltp, market=market, prev_tick=prev, now=now)

        features: dict[str, Any] = {}
        status: dict[str, str] = {}
        warmup_count = 0

        # Each calculation is independent and error-isolated (doc §26): a
        # failing calculator reports ERROR while the others still produce.
        for calculator in self.calculators.list():
            started = time.perf_counter()
            try:
                outcome = calculator.run(ctx, state)
                value, calc_status = outcome.value, outcome.status
            except Exception as exc:  # noqa: BLE001 — isolate per calculation
                value, calc_status = None, ERROR
                self.record_error(f"calculator_error:{calculator.name}", str(exc))
            elapsed_ms = (time.perf_counter() - started) * 1000.0

            stats = self._calc_stats.setdefault(calculator.name, {
                "calculations": 0, "errors": 0, "available": 0, "warmup": 0,
                "missingInput": 0, "invalidInput": 0, "lastStatus": None,
                "lastValue": None, "lastLatencyMs": None,
            })
            stats["calculations"] += 1
            stats["lastStatus"] = calc_status
            stats["lastLatencyMs"] = round(elapsed_ms, 4)
            self._calc_latency.setdefault(calculator.name, deque(maxlen=200)).append(elapsed_ms)

            if calc_status == AVAILABLE:
                features[calculator.name] = value
                stats["available"] += 1
                stats["lastValue"] = value
            elif calc_status == WARMING_UP:
                warmup_count += 1
                stats["warmup"] += 1
            elif calc_status == MISSING_INPUT:
                stats["missingInput"] += 1
            elif calc_status == ERROR:
                stats["errors"] += 1
            else:
                stats["invalidInput"] += 1
            status[calculator.name] = calc_status

        if missing:
            self._missing_input_count += len(missing)
            self.set_metric("missingInputs", self._missing_input_count)

        output: dict[str, Any] = {
            "instrumentToken": str(token),
            "symbol": symbol,
            "exchange": exchange,
            "timestamp": feed_ts,
            "featureTimestamp": now,
            "featureVersion": FEATURE_VERSION,
            "marketData": market,
            "features": features,
            "calculationStatus": status,
            "missingInputs": missing,
            "inputQuality": quality,
        }
        self._feature_cache[token] = output
        self._calculation_count += 1

        latency_ms = (time.perf_counter() - start) * 1000.0
        self._latency_samples.append(latency_ms)

        # True WS-receive -> feature-calculation-done latency (B) plus the
        # engine's own calculation cost. All backend-clock, never broker clock.
        pipeline_latency.record_ms("feature_calc", latency_ms)
        received_at = tick.get("receivedAt")
        if received_at:
            try:
                pipeline_latency.record(
                    "ws_recv_to_feature_done", time.time() - float(received_at)
                )
            except (TypeError, ValueError):
                pass

        self.set_metric("totalCalculations", self._calculation_count)
        self.set_metric("activeTokens", len(self._feature_cache))
        self.set_metric("lastCalculationLatencyMs", round(latency_ms, 4))
        samples = list(self._latency_samples)
        if samples:
            self.set_metric(
                "avgCalculationLatencyMs",
                round(sum(samples) / len(samples), 4),
            )
            self.set_metric("calculationLatencyP95Ms", round(_percentile(samples, 95), 4))
            self.set_metric("calculationLatencyP99Ms", round(_percentile(samples, 99), 4))
        self.set_metric("calculationErrors", self._calculation_error_count())
        self.set_metric("warmupCount", warmup_count)
        self.set_metric("calculatorCount", len(self.calculators.list()))
        self.record_event()

    def get_features(self, token: str) -> Optional[dict]:
        return self._feature_cache.get(token)

    def get_all_features(self) -> dict[str, dict]:
        return dict(self._feature_cache)

    def get_latest_features(self, tokens: list[str] | None = None) -> list[dict]:
        if tokens:
            return [self._feature_cache[t] for t in tokens if t in self._feature_cache]
        return list(self._feature_cache.values())

    # ------------------------------------------------------------------
    # Calculator plug-in control (doc §20-§21)
    # ------------------------------------------------------------------
    def _calculation_error_count(self) -> int:
        return sum(stats.get("errors", 0) for stats in self._calc_stats.values())

    def calculators_view(self) -> list[dict]:
        """Per-calculator contract + real runtime stats (doc §25)."""
        rows: list[dict] = []
        for calculator in self.calculators.list():
            stats = self._calc_stats.get(calculator.name, {})
            latency = list(self._calc_latency.get(calculator.name) or [])
            row = calculator.describe()
            row.update({
                "status": stats.get("lastStatus"),
                "calculations": stats.get("calculations", 0),
                "available": stats.get("available", 0),
                "errors": stats.get("errors", 0),
                "warmupCount": stats.get("warmup", 0),
                "missingInput": stats.get("missingInput", 0),
                "invalidInput": stats.get("invalidInput", 0),
                "lastValue": stats.get("lastValue"),
                "lastLatencyMs": stats.get("lastLatencyMs"),
                "avgLatencyMs": round(sum(latency) / len(latency), 4) if latency else None,
                "p95LatencyMs": round(_percentile(latency, 95), 4) if latency else None,
            })
            rows.append(row)
        return rows

    def register_calculator(self, calculator, *, replace: bool = False) -> bool:
        """Add an independent calculation without touching the others."""
        registered = self.calculators.register(calculator, replace=replace)
        if registered and calculator.name not in self._calc_stats:
            self._calc_stats[calculator.name] = {
                "calculations": 0, "errors": 0, "available": 0, "warmup": 0,
                "missingInput": 0, "invalidInput": 0, "lastStatus": None,
                "lastValue": None, "lastLatencyMs": None,
            }
            self._calc_latency[calculator.name] = deque(maxlen=200)
        return registered

    def remove_calculator(self, name: str) -> bool:
        return self.calculators.unregister(name)

    def status_snapshot(self) -> dict:
        base = super().status_snapshot()
        base["metrics"]["custom"]["activeTokens"] = len(self._feature_cache)
        base["metrics"]["custom"]["totalCalculations"] = self._calculation_count
        base["metrics"]["custom"]["invalidInputs"] = self._invalid_input_count
        base["metrics"]["custom"]["missingInputs"] = self._missing_input_count
        base["metrics"]["custom"]["avgCalculationLatencyMs"] = self.get_metrics().get("custom", {}).get(
            "avgCalculationLatencyMs"
        )
        base["calculations"] = self.calculators_view()
        base["calculatorRegistry"] = self.calculators.describe()
        return base

    @staticmethod
    def _safe_float(val: Any) -> float | None:
        if val is None:
            return None
        try:
            return float(str(val).replace(",", ""))
        except (ValueError, TypeError):
            return None


def _percentile(samples: list[float], p: float) -> float:
    """Nearest-rank percentile (samples need not be sorted)."""
    if not samples:
        return 0.0
    ordered = sorted(samples)
    if p <= 0:
        return ordered[0]
    if p >= 100:
        return ordered[-1]
    rank = int(round((p / 100.0) * (len(ordered) - 1)))
    return ordered[max(0, min(rank, len(ordered) - 1))]


# Module singleton
feature_engine = FeatureEngine()