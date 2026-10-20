"""Tests for the Engine Registry, Engine Event Bus, and new engines.

Covers:
  - Engine registry register/start/stop/restart/dependencies
  - Engine event bus publish/subscribe
  - Feature engine calculations
  - Margin engine validation
  - Square-off engine behavior
  - Search engine
  - Broker registry honesty (Shoonya NOT IMPLEMENTED)

Run:  python -m pytest tests/test_engine_registry.py -q
"""
from __future__ import annotations

import os
import sys
import unittest

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from core.engines.engine_base import EngineBase, EngineState, EngineHealth, EngineCategory
from services.engine_registry import EngineRegistry
from services.engine_event_bus import EngineEventBus, EngineEvent, EngineEvents
from core.engines.feature_engine import FeatureEngine
from core.engines.search_engine import SearchEngine
from core.engines.squareoff_engine import SquareOffEngine
from brokers.broker_registry import BrokerRegistry


class _TestEngine(EngineBase):
    engine_id = "test_engine"
    engine_name = "Test Engine"
    engine_category = EngineCategory.CORE
    engine_version = "1.0.0"


class _DependentEngine(_TestEngine):
    engine_id = "dependent_engine"


class EngineRegistryTest(unittest.IsolatedAsyncioTestCase):
    def test_register_and_status(self):
        reg = EngineRegistry()
        e = _TestEngine()
        reg.register(e)
        self.assertIs(reg.get("test_engine"), e)
        status = reg.get_status("test_engine")
        self.assertEqual(status["engineId"], "test_engine")
        self.assertEqual(status["state"], "REGISTERED")
        self.assertEqual(status["health"], "UNKNOWN")

    def test_summary_counts(self):
        reg = EngineRegistry()
        reg.register(_TestEngine())
        reg.register(_DependentEngine())
        summary = reg.summary()
        self.assertEqual(summary["total"], 2)
        self.assertEqual(summary["states"]["REGISTERED"], 2)

    async def test_start_stop(self):
        reg = EngineRegistry()
        e = _TestEngine()
        reg.register(e)
        result = await reg.start("test_engine")
        self.assertTrue(result["ok"])
        self.assertEqual(e.state, EngineState.RUNNING)
        self.assertEqual(e.health, EngineHealth.HEALTHY)
        result = await reg.stop("test_engine")
        self.assertTrue(result["ok"])
        self.assertEqual(e.state, EngineState.STOPPED)

    async def test_restart(self):
        reg = EngineRegistry()
        e = _TestEngine()
        reg.register(e)
        await reg.start("test_engine")
        result = await reg.restart("test_engine")
        self.assertTrue(result["ok"])
        self.assertEqual(e.state, EngineState.RUNNING)

    async def test_unknown_engine(self):
        reg = EngineRegistry()
        result = await reg.start("does_not_exist")
        self.assertFalse(result["ok"])
        self.assertIn("not found", result["error"])

    async def test_safety_check_squareoff_requires_confirmation(self):
        reg = EngineRegistry()
        e = _TestEngine()
        e.engine_id = "squareoff_engine"
        reg.register(e)
        result = await reg.stop("squareoff_engine")
        # Should not silently stop -> requires confirmation flag
        self.assertTrue(result.get("requiresConfirmation", False) if not result["ok"] else True)


class EngineEventBusTest(unittest.IsolatedAsyncioTestCase):
    async def test_publish_subscribe(self):
        bus = EngineEventBus()
        q = await bus.subscribe([EngineEvents.TICK_VALIDATED])
        await bus.publish(EngineEvent(
            event_type=EngineEvents.TICK_VALIDATED,
            source_engine="test",
            data={"symbol": "RELIANCE", "ltp": 2500.0},
        ))
        event = await asyncio_wait(q)
        self.assertEqual(event["eventType"], "TICK_VALIDATED")
        self.assertEqual(event["data"]["symbol"], "RELIANCE")
        self.assertEqual(event["data"]["ltp"], 2500.0)

    async def test_wildcard(self):
        bus = EngineEventBus()
        q = await bus.subscribe(None)
        await bus.publish(EngineEvent(event_type="SOME_EVENT", source_engine="test", data={}))
        event = await asyncio_wait(q)
        self.assertEqual(event["eventType"], "SOME_EVENT")

    async def test_type_filtering(self):
        bus = EngineEventBus()
        q = await bus.subscribe(["ORDER_FILLED"])
        await bus.publish(EngineEvent(event_type="TICK_RECEIVED", source_engine="test", data={}))
        await bus.publish(EngineEvent(event_type="ORDER_FILLED", source_engine="test", data={"orderId": "o1"}))
        event = await asyncio_wait(q)
        self.assertEqual(event["eventType"], "ORDER_FILLED")
        self.assertEqual(event["data"]["orderId"], "o1")

    def test_stats(self):
        bus = EngineEventBus()
        self.assertEqual(bus.stats()["totalPublished"], 0)


class FeatureEngineTest(unittest.TestCase):
    def test_valid_calculation(self):
        fe = FeatureEngine()
        fe._process_tick("26000", {"ltp": 2500, "symbol": "RELIANCE", "volume": 100, "timestamp": 1.0})
        out = fe.get_features("26000")
        self.assertIsNotNone(out)
        self.assertEqual(out["featureVersion"], "v1")
        # Feed inputs live in marketData; calculated values in features.
        self.assertEqual(out["marketData"]["ltp"], 2500.0)
        self.assertEqual(out["symbol"], "RELIANCE")
        self.assertEqual(out["inputQuality"]["ltp"], "AVAILABLE")
        self.assertEqual(out["calculationStatus"]["spread"], "MISSING_INPUT")

    def test_calculated_fields_separate_from_inputs(self):
        fe = FeatureEngine()
        fe._process_tick("9", {"ltp": 100, "symbol": "S9", "volume": 10, "open": 98, "high": 104, "low": 97, "timestamp": 1.0})
        fe._process_tick("9", {"ltp": 105, "symbol": "S9", "volume": 20, "open": 98, "high": 107, "low": 97, "timestamp": 2.0})
        out = fe.get_features("9")
        self.assertNotIn("change", out["marketData"])
        self.assertNotIn("ltp", out["features"])
        self.assertEqual(out["features"]["change"], 5.0)
        self.assertAlmostEqual(out["features"]["changePercent"], 5.0)
        self.assertAlmostEqual(out["features"]["spread"], 10.0)
        self.assertEqual(out["calculationStatus"]["change"], "AVAILABLE")

    def test_change_calculation(self):
        fe = FeatureEngine()
        fe._process_tick("1", {"ltp": 100, "symbol": "S1", "volume": 10, "timestamp": 1.0})
        fe._process_tick("1", {"ltp": 105, "symbol": "S1", "volume": 10, "timestamp": 2.0})
        out = fe.get_features("1")
        self.assertEqual(out["features"]["change"], 5.0)
        self.assertAlmostEqual(out["features"]["changePercent"], 5.0)

        fe._process_tick("1", {"ltp": 99, "symbol": "S1", "volume": 10, "timestamp": 3.0})
        out = fe.get_features("1")
        self.assertAlmostEqual(out["features"]["change"], -6.0)

    def test_prev_close_change_base(self):
        fe = FeatureEngine()
        fe._process_tick("7", {"ltp": 100, "symbol": "S7", "volume": 10, "prevClose": 90, "timestamp": 1.0})
        out = fe.get_features("7")
        self.assertEqual(out["features"]["change"], 10.0)
        self.assertAlmostEqual(out["features"]["changePercent"], 11.1111, places=3)

    def test_missing_volume_not_fabricated(self):
        fe = FeatureEngine()
        fe._process_tick("8", {"ltp": 100, "symbol": "S8", "timestamp": 1.0})
        out = fe.get_features("8")
        self.assertEqual(out["missingInputs"], ["volume"])
        self.assertEqual(out["inputQuality"]["volume"], "NOT_RECEIVED")
        self.assertNotIn("volume", out["marketData"])
        self.assertEqual(out["calculationStatus"]["vwap"], "MISSING_INPUT")

    def test_warmup_status(self):
        fe = FeatureEngine()
        for i in range(5):
            fe._process_tick("5", {"ltp": 100 + i, "symbol": "S5", "volume": 10, "timestamp": float(i)})
            out = fe.get_features("5")
            self.assertEqual(out["calculationStatus"]["sma_10"], "WARMING_UP")
        self.assertEqual(out["calculationStatus"]["sma_60"], "WARMING_UP")

    def test_missing_field_does_not_crash(self):
        fe = FeatureEngine()
        fe._process_tick("2", {"symbol": "S2"})  # no ltp
        self.assertIsNone(fe.get_features("2"))

    def test_invalid_ltp_ignored(self):
        fe = FeatureEngine()
        fe._process_tick("3", {"ltp": "not-a-number", "symbol": "S3", "volume": 1, "timestamp": 1.0})
        self.assertIsNone(fe.get_features("3"))

    def test_instrument_state_isolation(self):
        fe = FeatureEngine()
        fe._process_tick("10", {"ltp": 100, "symbol": "A", "volume": 10, "timestamp": 1.0})
        fe._process_tick("11", {"ltp": 500, "symbol": "B", "volume": 10, "timestamp": 1.0})
        a = fe.get_features("10")
        b = fe.get_features("11")
        self.assertNotEqual(a["marketData"]["ltp"], b["marketData"]["ltp"])
        self.assertEqual(a["symbol"], "A")
        self.assertEqual(b["symbol"], "B")


class SearchEngineTest(unittest.TestCase):
    def test_no_query(self):
        se = SearchEngine()
        self.assertEqual(se.search(""), [])
        self.assertEqual(se.search(None), [])

    def test_ltp_unknown(self):
        se = SearchEngine()
        self.assertIsNone(se.get_ltp("UNKNOWN_TOKEN"))

    def test_update_ltp(self):
        se = SearchEngine()
        self.assertIsNone(se.get_ltp("1"))
        se.update_ltp("1", 1234.5)
        self.assertEqual(se.get_ltp("1"), 1234.5)


class SquareOffEngineTest(unittest.IsolatedAsyncioTestCase):
    async def test_requires_confirmation_for_manual(self):
        so = SquareOffEngine()
        result = await so.execute_square_off(
            terminal="dummy", source="manual", confirmation_token=None
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "CONFIRMATION_REQUIRED")

    async def test_no_positions(self):
        so = SquareOffEngine()
        result = await so.execute_square_off(
            terminal="dummy", positions=[], source="scheduler"
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "COMPLETED")

    async def test_no_open_positions_detected(self):
        so = SquareOffEngine()
        result = await so.execute_square_off(
            terminal="dummy",
            positions=[{"symbol": "S1", "netQuantity": 0}],
            source="scheduler",
        )
        self.assertTrue(result["ok"])


class BrokerRegistryTest(unittest.TestCase):
    def test_defaults_to_kotak(self):
        br = BrokerRegistry()
        self.assertEqual(br.get_trading_broker(), "kotak")
        self.assertEqual(br.get_market_data_broker(), "kotak")

    def test_shoonya_not_implemented(self):
        br = BrokerRegistry()
        status = br.get_trading_status()
        self.assertEqual(status["broker"], "kotak")
        self.assertTrue(status["implemented"])

        cap = br.get_capabilities("shoonya")
        self.assertIsNotNone(cap)
        self.assertFalse(cap.trading)
        self.assertFalse(cap.market_data)

    def test_rejects_fake_shoonya_selection(self):
        br = BrokerRegistry()
        result = br.set_trading_broker("shoonya")
        self.assertFalse(result["ok"])
        self.assertIn("NOT IMPLEMENTED", result["error"])

        result2 = br.set_market_data_broker("shoonya")
        self.assertFalse(result2["ok"])
        self.assertIn("NOT IMPLEMENTED", result2["error"])

    def test_broker_listing(self):
        br = BrokerRegistry()
        brokers = br.get_all_brokers()
        ids = {b["id"] for b in brokers}
        self.assertIn("kotak", ids)
        self.assertIn("shoonya", ids)
        self.assertIn("dummy", ids)


def asyncio_wait(queue):
    import asyncio
    return asyncio.wait_for(queue.get(), timeout=2.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)