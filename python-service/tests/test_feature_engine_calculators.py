"""Feature Engine modular calculator framework tests (feature-engine.md §20-§27).

Pure unit tests: registry contract, calculator input declarations, unchanged
feature output, warm-up state, error isolation, and calculation metrics.
"""
from __future__ import annotations

import unittest

from core.engines.feature_calculators import (
    AVAILABLE,
    ERROR,
    MISSING_INPUT,
    WARMING_UP,
    BaseCalculator,
    default_registry,
)
from core.engines.feature_engine import CALCULATIONS, FeatureEngine


class BrokenCalculator(BaseCalculator):
    name = "broken"
    required_inputs = ()
    warmup = 1

    def status(self, ctx, state):
        return AVAILABLE

    def calculate(self, ctx, state):
        raise RuntimeError("boom")


def tick(**overrides) -> dict:
    data = {
        "instrumentToken": "11536",
        "symbol": "SBIN",
        "exchange": "nse_cm",
        "ltp": 100.0,
        "prevClose": 95.0,
        "open": 96.0,
        "high": 110.0,
        "low": 90.0,
        "volume": 10.0,
    }
    data.update(overrides)
    return data


class CalculatorRegistryTest(unittest.TestCase):
    def test_registry_matches_engine_contract(self):
        registry = default_registry()
        self.assertEqual(registry.names(), list(CALCULATIONS))
        self.assertEqual(
            registry.names(),
            ["change", "changePercent", "spread", "vwap", "sma_10", "sma_60"],
        )

    def test_calculators_declare_inputs_and_warmup(self):
        registry = default_registry()
        spread = registry.get("spread")
        self.assertEqual(spread.required_inputs, ("high", "low"))
        vwap = registry.get("vwap")
        self.assertEqual(vwap.required_inputs, ("volume",))
        self.assertEqual(registry.get("sma_10").warmup, 10)
        self.assertEqual(registry.get("sma_60").warmup, 60)
        # change declares its inputs as optional (prev-close falls back to prev tick)
        self.assertEqual(registry.get("change").required_inputs, ())
        self.assertIn("prevClose", registry.get("change").optional_inputs)

    def test_register_and_remove(self):
        registry = default_registry()
        added = BrokenCalculator()
        self.assertTrue(registry.register(added))
        self.assertIn("broken", registry.names())
        self.assertFalse(registry.register(BrokenCalculator()))  # no dup without replace
        self.assertTrue(registry.unregister("broken"))
        self.assertNotIn("broken", registry.names())


class FeatureEngineCalculatorTest(unittest.TestCase):
    def setUp(self):
        self.engine = FeatureEngine()

    def test_output_shape_and_warmup(self):
        self.engine._process_tick("11536", tick())
        first = self.engine.get_features("11536")
        self.assertEqual(first["features"]["change"], 5.0)
        self.assertAlmostEqual(first["features"]["changePercent"], 5.2632, places=3)
        self.assertEqual(first["features"]["spread"], 20.0)
        self.assertEqual(first["calculationStatus"]["vwap"], WARMING_UP)
        self.assertEqual(first["calculationStatus"]["sma_10"], WARMING_UP)
        self.assertEqual(first["calculationStatus"]["sma_60"], WARMING_UP)
        self.assertNotIn("sma_10", first["features"])

        self.engine._process_tick("11536", tick(ltp=102.0, volume=20.0))
        second = self.engine.get_features("11536")
        self.assertEqual(second["calculationStatus"]["vwap"], AVAILABLE)
        self.assertAlmostEqual(second["features"]["vwap"], 101.3333, places=3)

    def test_change_falls_back_to_previous_tick(self):
        self.engine._process_tick("1", tick(instrumentToken="1", prevClose=None))
        first = self.engine.get_features("1")
        self.assertEqual(first["calculationStatus"]["change"], MISSING_INPUT)
        self.engine._process_tick("1", tick(instrumentToken="1", prevClose=None, ltp=101.0))
        second = self.engine.get_features("1")
        self.assertEqual(second["calculationStatus"]["change"], AVAILABLE)
        self.assertEqual(second["features"]["change"], 1.0)

    def test_missing_volume_is_never_fabricated(self):
        payload = tick(volume=None)
        payload.pop("volume")
        self.engine._process_tick("11536", payload)
        out = self.engine.get_features("11536")
        self.assertEqual(out["missingInputs"], ["volume"])
        self.assertEqual(out["inputQuality"]["volume"], "NOT_RECEIVED")
        self.assertEqual(out["calculationStatus"]["vwap"], MISSING_INPUT)
        self.assertNotIn("vwap", out["features"])

    def test_error_isolation(self):
        self.engine.register_calculator(BrokenCalculator())
        self.engine._process_tick("11536", tick(volume=20.0))
        out = self.engine.get_features("11536")
        self.assertEqual(out["calculationStatus"]["broken"], ERROR)
        self.assertNotIn("broken", out["features"])
        # unrelated calculations are unaffected
        self.assertEqual(out["calculationStatus"]["change"], AVAILABLE)
        self.assertEqual(out["calculationStatus"]["spread"], AVAILABLE)
        broken = next(r for r in self.engine.calculators_view() if r["name"] == "broken")
        self.assertGreaterEqual(broken["errors"], 1)

    def test_metrics_and_calculator_view(self):
        for i in range(5):
            self.engine._process_tick("11536", tick(ltp=100.0 + i, volume=10.0 + i))
        snap = self.engine.status_snapshot()
        custom = snap["metrics"]["custom"]
        self.assertIn("calculationLatencyP95Ms", custom)
        self.assertIn("calculationLatencyP99Ms", custom)
        self.assertEqual(custom["calculatorCount"], 6)
        self.assertIn("calculations", snap)
        rows = {row["name"]: row for row in snap["calculations"]}
        self.assertEqual(rows["sma_60"]["status"], WARMING_UP)
        # declared warm-up requirement stays distinct from the runtime counter
        self.assertEqual(rows["sma_60"]["warmup"], 60)
        self.assertGreaterEqual(rows["sma_60"]["warmupCount"], 1)
        self.assertEqual(rows["spread"]["requiredInputs"], ["high", "low"])


if __name__ == "__main__":
    unittest.main()
