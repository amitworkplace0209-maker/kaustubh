"""Modular calculator plug-in framework for the Feature Engine.

Implements the feature-engine.md §20–§22 architecture:

- ``feature_engine`` stays an orchestrator; each calculation is an independent
  component (``BaseCalculator``) that declares its required / optional inputs,
  its warm-up requirement, maintains its own state view and returns a value
  plus a calculation status.
- ``CalculatorRegistry`` collects the plug-ins; new calculations can be
  registered without touching unrelated ones (doc §21).
- Statuses follow doc §14: AVAILABLE / WARMING_UP / INSUFFICIENT_DATA /
  MISSING_INPUT / INVALID_INPUT / NOT_SUPPORTED / ERROR.

Pure module: stdlib only, no broker SDK, no engine imports (no cycles).
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Any, Optional

AVAILABLE = "AVAILABLE"
WARMING_UP = "WARMING_UP"
INSUFFICIENT_DATA = "INSUFFICIENT_DATA"
MISSING_INPUT = "MISSING_INPUT"
INVALID_INPUT = "INVALID_INPUT"
NOT_SUPPORTED = "NOT_SUPPORTED"
ERROR = "ERROR"

CALCULATION_STATUSES = (
    AVAILABLE,
    WARMING_UP,
    INSUFFICIENT_DATA,
    MISSING_INPUT,
    INVALID_INPUT,
    NOT_SUPPORTED,
    ERROR,
)

DEFAULT_HISTORY_DEPTH = 600


@dataclass
class CalculatorContext:
    """Immutable per-tick view handed to every calculator."""

    ltp: float
    market: dict[str, Any]
    prev_tick: Optional[dict]
    now: float

    def value(self, field: str) -> Any:
        return self.market.get(field)

    def prev_ltp(self) -> Optional[float]:
        if not self.prev_tick:
            return None
        raw = self.prev_tick.get("ltp") or self.prev_tick.get("lastPrice")
        try:
            value = float(str(raw).replace(",", ""))
        except (TypeError, ValueError):
            return None
        return value if value > 0 else None

    def change_base(self) -> Optional[float]:
        """Previous close when the feed provides one, else the previous tick."""
        raw = self.market.get("prevClose")
        if raw is not None:
            try:
                value = float(str(raw).replace(",", ""))
            except (TypeError, ValueError):
                value = None
            if value is not None and value > 0:
                return value
        return self.prev_ltp()


@dataclass
class CalculatorState:
    """Per-instrument rolling state (isolated per token).

    The rolling VWAP numerator/denominator are maintained incrementally as the
    bounded history window slides, and the price list is materialised at most
    once per observed tick. This keeps per-tick work O(calculators) instead of
    rebuilding the full 600-point history for every calculator on every tick.
    """

    history: deque = field(default_factory=lambda: deque(maxlen=DEFAULT_HISTORY_DEPTH))
    _pv_sum: float = 0.0
    _vol_sum: float = 0.0
    _vol_count: int = 0
    _version: int = 0
    _prices_cache: Optional[list[float]] = None
    _prices_cache_version: int = -1

    def observe(self, now: float, ltp: float, volume: Optional[float]) -> None:
        hist = self.history
        maxlen = hist.maxlen
        if maxlen is not None and len(hist) == maxlen:
            _ts, old_price, old_vol = hist[0]
            if old_vol and old_vol > 0:
                self._pv_sum -= old_price * old_vol
                self._vol_sum -= old_vol
                self._vol_count -= 1
        hist.append((now, ltp, volume))
        if volume and volume > 0:
            self._pv_sum += ltp * volume
            self._vol_sum += volume
            self._vol_count += 1
        self._version += 1

    @property
    def observed(self) -> int:
        return len(self.history)

    def prices(self) -> list[float]:
        if self._prices_cache_version != self._version:
            self._prices_cache = [price for _, price, _ in self.history]
            self._prices_cache_version = self._version
        return self._prices_cache

    def volume_prices(self) -> list[tuple[float, float]]:
        """(price, volume) pairs where a real positive volume was observed."""
        return [(price, vol) for _, price, vol in self.history if vol and vol > 0]

    def volume_observed(self) -> int:
        """Count of positive-volume observations currently in the window."""
        return self._vol_count

    def vwap(self) -> Optional[float]:
        """Incremental volume-weighted average price, or ``None`` with no volume."""
        if self._vol_sum <= 0:
            return None
        return round(self._pv_sum / self._vol_sum, 4)


@dataclass
class CalculatorOutcome:
    value: Any = None
    status: str = MISSING_INPUT
    error: str = ""

    @property
    def available(self) -> bool:
        return self.status == AVAILABLE


class BaseCalculator:
    """Independent calculation component (doc §21).

    Subclasses declare ``name``, ``required_inputs``, ``optional_inputs`` and
    ``warmup`` and implement :meth:`status` + :meth:`calculate`. The engine
    never needs to know how a calculator works — only its contract.
    """

    name: str = ""
    required_inputs: tuple[str, ...] = ()
    optional_inputs: tuple[str, ...] = ()
    warmup: int = 0

    def missing_inputs(self, ctx: CalculatorContext, state: CalculatorState) -> list[str]:
        return [f for f in self.required_inputs if ctx.value(f) is None]

    def status(self, ctx: CalculatorContext, state: CalculatorState) -> str:
        if self.warmup and state.observed < self.warmup:
            return WARMING_UP
        return AVAILABLE if self.missing_inputs(ctx, state) == [] else MISSING_INPUT

    def calculate(self, ctx: CalculatorContext, state: CalculatorState) -> Any:  # pragma: no cover
        raise NotImplementedError

    def run(self, ctx: CalculatorContext, state: CalculatorState) -> CalculatorOutcome:
        status = self.status(ctx, state)
        if status != AVAILABLE:
            return CalculatorOutcome(value=None, status=status)
        value = self.calculate(ctx, state)
        if value is None:
            return CalculatorOutcome(value=None, status=INSUFFICIENT_DATA)
        return CalculatorOutcome(value=value, status=AVAILABLE)

    def describe(self) -> dict:
        return {
            "name": self.name,
            "requiredInputs": list(self.required_inputs),
            "optionalInputs": list(self.optional_inputs),
            "warmup": self.warmup,
        }


class ChangeCalculator(BaseCalculator):
    name = "change"
    required_inputs = ()
    optional_inputs = ("prevClose", "ltp")
    warmup = 1

    def status(self, ctx: CalculatorContext, state: CalculatorState) -> str:
        return AVAILABLE if ctx.change_base() is not None else MISSING_INPUT

    def calculate(self, ctx: CalculatorContext, state: CalculatorState) -> Any:
        base = ctx.change_base()
        if base is None:
            return None
        return round(ctx.ltp - base, 4)


class ChangePercentCalculator(BaseCalculator):
    name = "changePercent"
    required_inputs = ()
    optional_inputs = ("prevClose", "ltp")
    warmup = 1

    def status(self, ctx: CalculatorContext, state: CalculatorState) -> str:
        return AVAILABLE if ctx.change_base() is not None else MISSING_INPUT

    def calculate(self, ctx: CalculatorContext, state: CalculatorState) -> Any:
        base = ctx.change_base()
        if base is None:
            return None
        return round(((ctx.ltp - base) / base) * 100.0, 4)


class SpreadCalculator(BaseCalculator):
    name = "spread"
    required_inputs = ("high", "low")
    warmup = 1

    def calculate(self, ctx: CalculatorContext, state: CalculatorState) -> Any:
        high = ctx.value("high")
        low = ctx.value("low")
        if high is None or low is None:
            return None
        return round(float(high) - float(low), 4)


class VwapCalculator(BaseCalculator):
    name = "vwap"
    required_inputs = ("volume",)
    optional_inputs = ("ltp",)
    warmup = 2

    def status(self, ctx: CalculatorContext, state: CalculatorState) -> str:
        if ctx.value("volume") is None:
            return MISSING_INPUT
        if state.observed < self.warmup or state.volume_observed() <= 0:
            return WARMING_UP
        return AVAILABLE

    def calculate(self, ctx: CalculatorContext, state: CalculatorState) -> Any:
        return state.vwap()


class SimpleMovingAverageCalculator(BaseCalculator):
    name = "sma"
    required_inputs = ("ltp",)
    warmup = 1

    def __init__(self, window: int) -> None:
        self.window = int(window)
        self.name = f"sma_{self.window}"
        self.warmup = self.window

    def calculate(self, ctx: CalculatorContext, state: CalculatorState) -> Any:
        prices = state.prices()
        if len(prices) < self.window:
            return None
        return round(sum(prices[-self.window:]) / self.window, 4)

    def describe(self) -> dict:
        data = super().describe()
        data["window"] = self.window
        return data


class CalculatorRegistry:
    """Ordered collection of calculator plug-ins (doc §21)."""

    def __init__(self, calculators: Optional[list[BaseCalculator]] = None) -> None:
        self._calculators: list[BaseCalculator] = list(calculators or [])

    def register(self, calculator: BaseCalculator, *, replace: bool = False) -> bool:
        if not getattr(calculator, "name", ""):
            raise ValueError("calculator must declare a name")
        existing = {c.name: i for i, c in enumerate(self._calculators)}
        if calculator.name in existing:
            if not replace:
                return False
            self._calculators[existing[calculator.name]] = calculator
            return True
        self._calculators.append(calculator)
        return True

    def unregister(self, name: str) -> bool:
        for index, calculator in enumerate(self._calculators):
            if calculator.name == name:
                self._calculators.pop(index)
                return True
        return False

    def get(self, name: str) -> Optional[BaseCalculator]:
        for calculator in self._calculators:
            if calculator.name == name:
                return calculator
        return None

    def list(self) -> list[BaseCalculator]:
        return list(self._calculators)

    def names(self) -> list[str]:
        return [c.name for c in self._calculators]

    def describe(self) -> list[dict]:
        return [c.describe() for c in self._calculators]


def default_registry() -> CalculatorRegistry:
    """The built-in calculation set (feature-engine.md §8-§9)."""
    return CalculatorRegistry([
        ChangeCalculator(),
        ChangePercentCalculator(),
        SpreadCalculator(),
        VwapCalculator(),
        SimpleMovingAverageCalculator(10),
        SimpleMovingAverageCalculator(60),
    ])


DEFAULT_CALCULATIONS: tuple[str, ...] = tuple(c.name for c in default_registry().list())
