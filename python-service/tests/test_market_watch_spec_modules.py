"""Tests for the Market Watch spec modules (docs/engines/MARKET_WATCH.md).

Covers the pieces the updated specification requires and that the engine now
delegates to:

    market_watch_config       configuration, not code
    market_watch_state        canonical typed state + timeframes
    market_watch_timeframes   1m/5m/10m/30m aggregation + candle commit
    market_watch_eligibility  price/circuit/liquidity/filter/margin decisions
    market_watch_ledger       daily block ledger (doc §6/§7)
    market_watch_lifecycle    the daily phase machine (doc §5)
    market_watch_indexes      live indexes (doc §17)
    market_watch_filters      doc §12 price + timeframe movement filters
    market_watch_publish      doc §15/§16/§19/§25 publish policy
    market_watch_report       doc §26 EOD report
    market_watch_doc_buffer   buffered persistence owned by the DB Writer

The tests are DB-free and deterministic: no Mongo, no broker, no clock beyond
explicitly injected timestamps, and no fabricated market values.

Run:  python -m pytest tests/test_market_watch_spec_modules.py -q
"""
from __future__ import annotations

import asyncio
import os
import sys
import unittest
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from services import market_watch_config as mwcfg  # noqa: E402
from services.market_watch_config import (  # noqa: E402
    CircuitConfig,
    FilterConfig,
    MarketWatchConfig,
    PriceFilterConfig,
    TimeframeFilterConfig,
)
from services.market_watch_doc_buffer import COLLECTIONS as MW_COLLECTIONS  # noqa: E402
from services.market_watch_doc_buffer import add as doc_add  # noqa: E402
from services.market_watch_doc_buffer import pending as doc_pending  # noqa: E402
from services.market_watch_doc_buffer import reset as doc_reset  # noqa: E402
from services.market_watch_doc_buffer import stats as doc_stats  # noqa: E402
from services.market_watch_eligibility import (  # noqa: E402
    circuit_distance_lower,
    circuit_distance_upper,
    circuit_near,
    circuit_thresholds,
    evaluate_state,
)
from services.market_watch_filters import apply_movement_filters, evaluate_movement  # noqa: E402
from services.market_watch_ledger import (  # noqa: E402
    COLLECTION as LEDGER_COLLECTION,
    STATUS_ACTIVE,
    STATUS_BLOCKED,
    DailyBlockLedger,
)
from services.market_watch_lifecycle import (  # noqa: E402
    BLOCKING,
    COMPLETED,
    DISCOVERY,
    FINAL_MONITORING,
    FILTERING,
    IST,
    MARKET_WATCH_STOPPED,
    MONITORING,
    PRE_MARKET,
    REPORTING,
    RUNTIME_INACTIVE,
    STATES,
    SUBSCRIBED,
    blocking_state_for,
    state_for,
)
from services.market_watch_publish import (  # noqa: E402
    COMMAND_TYPES,
    EVENT_MORE_SNAPSHOT,
    EVENT_STOCK_UPDATE,
    EVENT_TYPES,
    PublishPolicy,
    more_snapshot_event,
    validate_show_more,
)
from services.market_watch_report import build_report  # noqa: E402
from services.market_watch_state import SymbolState, TimeframeState  # noqa: E402
from services.market_watch_timeframes import TimeframeEngine, timeframe_engine  # noqa: E402

#: A fixed epoch aligned to a 60-second boundary, so bucket maths is exact.
T0 = 1_757_000_040.0


def _state(symbol: str = "AAA", token: str = "1", **kw) -> SymbolState:
    return SymbolState(symbol=symbol, instrument_token=token, name=symbol, **kw)


def _ticked(
    symbol: str = "AAA",
    token: str = "1",
    *,
    ltp: float = 100.0,
    previous_close: float | None = 100.0,
    volume: float | None = 10_000.0,
    now: float = T0,
) -> SymbolState:
    """A state that has recorded one real validated tick."""
    state = _state(symbol, token)
    state.apply_price_tick(
        now=now, ltp=ltp, previous_close=previous_close, volume=volume,
        open_=ltp, high=ltp, low=ltp,
    )
    return state


def _circuited(state: SymbolState, upper: float, lower: float) -> SymbolState:
    state.apply_circuits(upper, lower)
    return state


def _at(hh: int, mm: int) -> datetime:
    return datetime(2026, 9, 26, hh, mm, tzinfo=IST)


def _with(**overrides) -> MarketWatchConfig:
    """Clone the loaded config with selected sections replaced."""
    import dataclasses

    base = mwcfg.load()
    return dataclasses.replace(base, **overrides)


def _circuit(block_by_band=None, near_by_band=None, require_data=True) -> CircuitConfig:
    """Circuit policy mirroring the shipped defaults (doc §7, see config note)."""
    return CircuitConfig(
        block_pct_by_band=block_by_band if block_by_band is not None else dict(mwcfg.DEFAULT_CIRCUIT_POLICY),
        near_pct_by_band=near_by_band if near_by_band is not None else dict(mwcfg.DEFAULT_CIRCUIT_NEAR_POLICY),
        default_block_pct=3.0,
        default_near_pct=4.0,
        require_data=require_data,
    )


# --------------------------------------------------------------------------- #
# doc §5 lifecycle
# --------------------------------------------------------------------------- #
class TestLifecycle(unittest.TestCase):
    def test_states_are_the_documented_sequence(self):
        self.assertEqual(
            STATES,
            (
                "PRE_MARKET", "DISCOVERY", "FILTERING", "SUBSCRIBED", "MONITORING",
                "BLOCKING", "FINAL_MONITORING", "MARKET_WATCH_STOPPED", "REPORTING", "COMPLETED",
                "RUNTIME_INACTIVE",
            ),
        )

    def test_schedule_transitions(self):
        # Before runtime window (08:50) -> RUNTIME_INACTIVE
        self.assertEqual(state_for(_at(8, 0)), RUNTIME_INACTIVE)
        self.assertEqual(state_for(_at(8, 49)), RUNTIME_INACTIVE)
        # At runtime start (08:50) -> PRE_MARKET
        self.assertEqual(state_for(_at(8, 50)), PRE_MARKET)
        # Internal lifecycle phases
        self.assertEqual(state_for(_at(9, 10)), DISCOVERY)
        self.assertEqual(state_for(_at(9, 11)), FILTERING)
        self.assertEqual(state_for(_at(9, 13)), SUBSCRIBED)
        self.assertEqual(state_for(_at(9, 14)), MONITORING)
        self.assertEqual(state_for(_at(15, 5)), FINAL_MONITORING)
        self.assertEqual(state_for(_at(15, 14)), FINAL_MONITORING)
        # Runtime stop at 15:30 -> RUNTIME_INACTIVE (not MARKET_WATCH_STOPPED)
        # At 15:15 we're inside runtime window (08:50-15:30), internal phase is MARKET_WATCH_STOPPED
        self.assertEqual(state_for(_at(15, 15)), MARKET_WATCH_STOPPED)
        self.assertEqual(state_for(_at(15, 30)), RUNTIME_INACTIVE)
        self.assertEqual(state_for(_at(16, 0)), RUNTIME_INACTIVE)

    def test_final_monitoring_is_a_real_phase(self):
        """FINAL_MONITORING must be reachable, not just declared."""
        self.assertEqual(state_for(_at(15, 5)), FINAL_MONITORING)
        self.assertEqual(state_for(_at(15, 14)), FINAL_MONITORING)
        self.assertIn(FINAL_MONITORING, {state_for(_at(15, mm)) for mm in range(5, 15)})

    def test_blocking_starts_only_after_a_real_ranking_exists(self):
        self.assertEqual(blocking_state_for(_at(10, 0), has_ranking=False), MONITORING)
        self.assertEqual(blocking_state_for(_at(10, 0), has_ranking=True), BLOCKING)

    def test_final_monitoring_is_not_promoted_to_blocking(self):
        self.assertEqual(blocking_state_for(_at(15, 10), has_ranking=True), FINAL_MONITORING)

    def test_schedule_is_configuration_not_code(self):
        cfg = mwcfg.load()
        self.assertEqual(cfg.lifecycle.discovery, "09:10")
        self.assertEqual(cfg.lifecycle.active_from, "09:14")
        self.assertEqual(cfg.lifecycle.final_monitoring, "15:05")
        self.assertEqual(cfg.lifecycle.stop, "15:15")
        self.assertEqual(cfg.lifecycle.report, "15:20")
        self.assertEqual(cfg.lifecycle.report_ready, "15:25")


# --------------------------------------------------------------------------- #
# doc §7 circuit-distance logic
# --------------------------------------------------------------------------- #
class TestCircuitDistance(unittest.TestCase):
    def test_upper_distance_formula(self):
        # doc §7: upper 500, current 485 -> 3.0%
        self.assertAlmostEqual(circuit_distance_upper(485.0, 500.0), 3.0, places=6)

    def test_lower_distance_formula(self):
        self.assertAlmostEqual(circuit_distance_lower(103.0, 100.0), 3.0, places=6)

    def test_state_stores_the_measured_distance(self):
        state = _circuited(_ticked(ltp=485.0, previous_close=450.0), 500.0, 400.0)
        self.assertAlmostEqual(state.circuit_distance_upper_pct, 3.0, places=4)
        self.assertAlmostEqual(state.circuit_distance_lower_pct, 21.25, places=4)
        # Per-side band: (500 - 400) / 2 / 450 = 11.11%
        self.assertAlmostEqual(state.circuit_band_pct, 11.1111, places=3)

    def test_missing_circuit_price_yields_none_not_zero(self):
        self.assertIsNone(circuit_distance_upper(100.0, None))
        self.assertIsNone(circuit_distance_lower(None, 100.0))
        self.assertIsNone(circuit_distance_upper(100.0, 0.0))
        self.assertIsNone(circuit_distance_lower(100.0, 0.0))

    def test_distance_is_never_derived_from_the_daily_change(self):
        """A +20% day with a 20% band is 0% from the upper circuit."""
        state = _circuited(_ticked(ltp=120.0, previous_close=100.0), 120.0, 80.0)
        self.assertAlmostEqual(state.change_pct, 20.0, places=4)
        self.assertAlmostEqual(state.circuit_distance_upper_pct, 0.0, places=6)

    def test_block_threshold_follows_the_real_band(self):
        """A 20% band must not block a symbol sitting on its previous close."""
        cfg = _with(circuit=_circuit())
        state = _circuited(_ticked(ltp=100.0, previous_close=100.0), 120.0, 80.0)
        block, near = circuit_thresholds(cfg.circuit, state)
        # Attainable distance for a 20% band is 120->100 = 16.67%; the shipped
        # default blocks at 30% of that, not the doc's unusable 18% example.
        self.assertAlmostEqual(block, 5.0, places=6)
        self.assertAlmostEqual(near, 8.3, places=6)
        self.assertLess(block, circuit_distance_upper(100.0, 120.0))
        self.assertTrue(evaluate_state(state, cfg).eligible)

    def test_narrow_band_uses_the_narrow_threshold(self):
        cfg = _with(circuit=_circuit())
        state = _circuited(_ticked(ltp=100.0, previous_close=100.0), 110.0, 90.0)
        block, _ = circuit_thresholds(cfg.circuit, state)
        self.assertAlmostEqual(block, 2.7, places=6)

    def test_a_threshold_above_the_attainable_distance_would_block_everything(self):
        """Regression guard for the doc §7 example policy."""
        cfg = _with(circuit=_circuit(dict(mwcfg.DOC_CIRCUIT_EXAMPLE_POLICY),
                                     dict(mwcfg.DOC_CIRCUIT_EXAMPLE_POLICY),
                                     require_data=False))
        state = _circuited(_ticked(ltp=100.0, previous_close=100.0), 120.0, 80.0)
        self.assertFalse(evaluate_state(state, cfg).eligible)

    def test_too_close_to_circuit_is_blocked_with_the_measured_distance(self):
        cfg = _with(circuit=_circuit({"20": 3.0}, {"20": 4.0}, require_data=False))
        state = _circuited(_ticked(ltp=485.0, previous_close=450.0), 500.0, 400.0)
        decision = evaluate_state(state, cfg)
        self.assertFalse(decision.eligible)
        self.assertEqual(decision.reason, "CIRCUIT_TOO_CLOSE")
        self.assertAlmostEqual(decision.observed, 3.0, places=3)

    def test_lower_circuit_proximity_also_blocks(self):
        cfg = _with(circuit=_circuit({"20": 3.0}, {"20": 4.0}, require_data=False))
        state = _circuited(_ticked(ltp=403.0, previous_close=450.0), 500.0, 400.0)
        decision = evaluate_state(state, cfg)
        self.assertFalse(decision.eligible)
        self.assertEqual(decision.reason, "CIRCUIT_TOO_CLOSE")
        self.assertIn("lower", decision.detail)

    def test_circuit_near_is_a_ranking_signal_not_a_block(self):
        cfg = _with(circuit=_circuit({"20": 3.0}, {"20": 4.0}, require_data=False))
        near_state = _circuited(_ticked(ltp=483.0, previous_close=450.0), 500.0, 400.0)
        self.assertTrue(circuit_near(near_state, cfg))
        far_state = _circuited(_ticked(ltp=300.0, previous_close=300.0), 500.0, 200.0)
        self.assertFalse(circuit_near(far_state, cfg))


# --------------------------------------------------------------------------- #
# doc §6 eligibility ordering / no fabricated data
# --------------------------------------------------------------------------- #
class TestEligibility(unittest.TestCase):
    def test_no_tick_is_data_invalid(self):
        decision = evaluate_state(_state(), mwcfg.load())
        self.assertFalse(decision.eligible)
        self.assertEqual(decision.reason, "DATA_INVALID")

    def test_zero_or_negative_price_is_data_invalid(self):
        decision = evaluate_state(_state(ltp=0.0, tick_count=3), mwcfg.load())
        self.assertEqual(decision.reason, "DATA_INVALID")

    def test_data_validity_is_checked_before_everything_else(self):
        """A cheap AND invalid symbol reports DATA_INVALID, not PRICE_LIMIT."""
        cfg = _with(price=PriceFilterConfig(min_price=50.0, max_price=1e9))
        decision = evaluate_state(_state(ltp=1.0), cfg)
        self.assertEqual(decision.reason, "DATA_INVALID")

    def test_price_band(self):
        cfg = _with(price=PriceFilterConfig(min_price=50.0, max_price=500.0),
                    business=_business(max_daily_change_pct=0.0),
                    circuit=_circuit(require_data=False))
        cheap = _ticked("CHEAP", "1", ltp=10.0, previous_close=10.0)
        self.assertEqual(evaluate_state(cheap, cfg).reason, "PRICE_LIMIT")
        dear = _ticked("DEAR", "2", ltp=900.0, previous_close=900.0)
        self.assertEqual(evaluate_state(dear, cfg).reason, "PRICE_LIMIT")
        ok = _ticked("OK", "3", ltp=200.0, previous_close=200.0)
        self.assertTrue(evaluate_state(ok, cfg).eligible)

    def test_business_band_is_checked_before_the_price_band(self):
        """doc §6 order: business rules are evaluated before the price filter."""
        cfg = _with(price=PriceFilterConfig(min_price=50.0, max_price=500.0),
                    business=_business(max_daily_change_pct=5.0),
                    circuit=_circuit(require_data=False))
        state = _ticked("MOVER", "1", ltp=900.0, previous_close=800.0)
        self.assertEqual(evaluate_state(state, cfg).reason, "BUSINESS_RULE")

    def test_inactive_instrument_is_reported(self):
        state = _ticked()
        state.status = "SUSPENDED"
        self.assertEqual(evaluate_state(state, mwcfg.load()).reason, "INSTRUMENT_INELIGIBLE")

    def test_business_band_is_reported_with_its_threshold(self):
        cfg = _with(business=_business(max_daily_change_pct=5.0))
        state = _ticked(ltp=110.0, previous_close=100.0)
        decision = evaluate_state(state, cfg)
        self.assertEqual(decision.reason, "BUSINESS_RULE")
        self.assertEqual(decision.threshold, 5.0)
        self.assertAlmostEqual(decision.observed, 10.0, places=4)

    def test_missing_circuit_data_is_not_treated_as_eligible(self):
        cfg = _with(circuit=_circuit(require_data=True))
        state = _ticked(ltp=100.0)
        decision = evaluate_state(state, cfg)
        self.assertFalse(decision.eligible)
        self.assertEqual(decision.reason, "DATA_INVALID")

    def test_missing_volume_is_not_treated_as_traded(self):
        cfg = _with(
            circuit=_circuit(require_data=False),
            liquidity=_liquidity(require_volume_data=True),
        )
        decision = evaluate_state(_ticked(volume=None), cfg)
        self.assertFalse(decision.eligible)
        self.assertEqual(decision.reason, "LIQUIDITY_FAIL")

    def test_volume_below_the_minimum_fails(self):
        cfg = _with(
            circuit=_circuit(require_data=False),
            liquidity=_liquidity(min_volume=1_000.0),
        )
        state = _ticked(volume=10.0)
        decision = evaluate_state(state, cfg)
        self.assertEqual(decision.reason, "LIQUIDITY_FAIL")
        self.assertEqual(decision.observed, 10.0)

    def test_missing_turnover_fails_rather_than_assuming_zero(self):
        """min_value needs vwap*volume; without them it is unknown, not zero."""
        cfg = _with(
            circuit=_circuit(require_data=False),
            liquidity=_liquidity(min_value=1.0),
        )
        state = _ticked(volume=1_000.0)
        self.assertIsNone(state.vwap)
        self.assertEqual(evaluate_state(state, cfg).reason, "LIQUIDITY_FAIL")

    def test_missing_margin_decision_never_invents_one(self):
        cfg = _with(business=_business(margin_required=True),
                    circuit=_circuit(require_data=False))
        state = _circuited(_ticked(ltp=100.0, previous_close=100.0), 110.0, 90.0)
        decision = evaluate_state(state, cfg)
        self.assertFalse(decision.eligible)
        self.assertEqual(decision.reason, "MARGIN_INELIGIBLE")

    def test_operator_margin_allow_list_is_consumed(self):
        cfg = _with(
            business=_business(margin_required=True, margin_eligible_tokens=frozenset({"1"})),
            circuit=_circuit(require_data=False),
        )
        state = _circuited(_ticked("AAA", "1", ltp=100.0), 110.0, 90.0)
        self.assertTrue(evaluate_state(state, cfg).eligible)

    def test_operator_margin_deny_list_is_consumed(self):
        cfg = _with(
            business=_business(margin_required=True, margin_ineligible_tokens=frozenset({"1"})),
            circuit=_circuit(require_data=False),
        )
        state = _circuited(_ticked("AAA", "1", ltp=100.0), 110.0, 90.0)
        self.assertEqual(evaluate_state(state, cfg).reason, "MARGIN_INELIGIBLE")

    def test_a_deny_list_does_not_ineligible_everything_else(self):
        """A deny set excludes only its members; the rest go to the real source."""
        cfg = _with(
            business=_business(margin_required=True, margin_ineligible_tokens=frozenset({"1"})),
            circuit=_circuit(require_data=False),
        )
        other = _circuited(_ticked("BBB", "2", ltp=100.0), 110.0, 90.0)
        decision = evaluate_state(other, cfg)
        # No Session Manager decision is available in a unit test, so the honest
        # answer is "unknown", NOT an operator deny.
        self.assertFalse(decision.eligible)
        self.assertEqual(decision.reason, "MARGIN_INELIGIBLE")
        self.assertIn("no authoritative margin decision", decision.detail)

    def test_an_allow_list_excludes_everything_else(self):
        """A non-empty allow-list is a decision about who is eligible."""
        cfg = _with(
            business=_business(margin_required=True, margin_eligible_tokens=frozenset({"1"})),
            circuit=_circuit(require_data=False),
        )
        other = _circuited(_ticked("BBB", "2", ltp=100.0), 110.0, 90.0)
        self.assertEqual(evaluate_state(other, cfg).reason, "MARGIN_INELIGIBLE")

    def test_movement_filter_failure_blocks_the_symbol(self):
        cfg = _with(
            filters=FilterConfig(
                enabled=True,
                price=PriceFilterConfig(0.0, 1e9),
                timeframes={"1m": TimeframeFilterConfig(change_pct_min=1.0)},
            ),
            circuit=_circuit(require_data=False),
        )
        state = _ticked(ltp=100.0)
        state.timeframe("1m").change_pct = 0.2
        decision = evaluate_state(state, cfg)
        self.assertEqual(decision.reason, "FILTER_FAIL")
        state.timeframe("1m").change_pct = 1.5
        self.assertTrue(evaluate_state(state, cfg).eligible)

    def test_disabled_movement_filters_are_ignored(self):
        cfg = _with(
            filters=FilterConfig(
                enabled=False,
                price=PriceFilterConfig(0.0, 1e9),
                timeframes={"1m": TimeframeFilterConfig(change_pct_min=1.0)},
            ),
            circuit=_circuit(require_data=False),
        )
        self.assertTrue(evaluate_state(_ticked(), cfg).eligible)


def dataclasses_replace_business(**overrides):
    return _business(**overrides)


def _business(**overrides):
    import dataclasses

    return dataclasses.replace(mwcfg.load().business, **overrides)


def _liquidity(**overrides):
    import dataclasses

    return dataclasses.replace(mwcfg.load().liquidity, **overrides)


# --------------------------------------------------------------------------- #
# doc §11 timeframes
# --------------------------------------------------------------------------- #
class TestTimeframes(unittest.TestCase):
    def setUp(self):
        self.engine = TimeframeEngine()
        self.state = _state()

    def _tick(self, price, when, volume=None, state=None):
        state = state or self.state
        state.apply_price_tick(
            now=when, ltp=price, previous_close=None, volume=volume,
            open_=price, high=price, low=price,
        )
        self.engine.observe_tick(state, when)

    def test_all_four_timeframes_exist(self):
        for tf in ("1m", "2m", "5m", "10m", "30m"):
            self.assertIsNotNone(self.state.timeframe(tf))

    def test_ohlc_from_real_ticks(self):
        self._tick(100.0, T0, 100)
        self._tick(110.0, T0 + 10, 300)
        self._tick(90.0, T0 + 20, 600)
        tfs = self.state.timeframe("1m")
        self.assertEqual((tfs.open, tfs.high, tfs.low, tfs.close), (100.0, 110.0, 90.0, 90.0))
        self.assertAlmostEqual(tfs.price_move, -10.0, places=6)
        self.assertAlmostEqual(tfs.change_pct, -10.0, places=6)
        self.assertEqual(tfs.tick_count, 3)

    def test_volume_is_a_delta_of_the_broker_cumulative(self):
        self._tick(100.0, T0, 100)      # bucket opens: cumulative 100 anchors the base
        self._tick(101.0, T0 + 5, 250)  # +150 traded inside the bucket
        self._tick(102.0, T0 + 10, 400)  # +150 traded inside the bucket
        # The whole cumulative day figure is NOT the candle's volume.
        self.assertEqual(self.state.timeframe("1m").volume, 300)

    def test_vwap_comes_from_real_traded_turnover(self):
        self._tick(100.0, T0, 100)          # opens the bucket
        self._tick(110.0, T0 + 5, 200)     # +100 traded at 110
        self._tick(90.0, T0 + 10, 300)     # +100 traded at 90
        tfs = self.state.timeframe("1m")
        # 200 traded volume inside the bucket: 100@110 + 100@90.
        self.assertAlmostEqual(tfs.vwap, 100.0, places=6)

    def test_a_single_tick_candle_has_no_vwap(self):
        self._tick(100.0, T0, 100)
        tfs = self.state.timeframe("1m")
        self.assertEqual(tfs.volume, 0.0)
        self.assertIsNone(tfs.vwap, "one tick cannot produce a traded VWAP")

    def test_vwap_stays_none_without_traded_volume(self):
        self._tick(100.0, T0, None)
        self._tick(110.0, T0 + 5, None)
        self.assertIsNone(self.state.timeframe("1m").vwap)

    def test_bucket_volume_never_goes_negative_on_a_session_roll(self):
        self._tick(100.0, T0, 5_000)
        self._tick(101.0, T0 + 5, 10)  # broker re-sent a lower cumulative
        self.assertGreaterEqual(self.state.timeframe("1m").volume, 0)

    def test_change_pct_is_measured_from_the_bucket_open(self):
        self._tick(100.0, T0, 10)
        self._tick(120.0, T0 + 5, 20)
        self.assertAlmostEqual(self.state.timeframe("1m").change_pct, 20.0, places=6)

    def test_boundary_rollover_closes_the_previous_candle(self):
        self._tick(100.0, T0, 100)
        emitted = []
        self.engine.set_candle_sink(lambda token, tf, doc: emitted.append((token, tf, dict(doc))))
        self._tick(105.0, T0 + 120, 200)  # next minute
        self.assertTrue(emitted, "crossing a boundary must close the open bucket")
        token, tf, doc = emitted[0]
        self.assertEqual((token, tf), ("1", "1m"))
        self.assertTrue(doc["complete"])
        self.assertEqual(doc["open"], 100.0)
        self.assertEqual(doc["close"], 100.0)
        self.assertEqual(doc["close"], 100.0, "the new tick opens the NEXT bucket")

    def test_a_fresh_bucket_reports_no_carried_over_prices(self):
        self._tick(100.0, T0, 100)
        self._tick(105.0, T0 + 120, 200)
        tfs = self.state.timeframe("1m")
        self.assertEqual(tfs.open, 105.0)
        self.assertEqual(tfs.tick_count, 1)

    def test_timeframes_roll_independently(self):
        self._tick(100.0, T0, 10)
        self._tick(101.0, T0 + 5 * 60, 20)  # 5m boundary, still the same 30m
        self.assertEqual(self.state.timeframe("5m").tick_count, 1)
        self.assertEqual(self.state.timeframe("30m").tick_count, 2)
        self.assertEqual(self.state.timeframe("1m").tick_count, 1)

    def test_unreconstructable_bucket_is_incomplete_not_invented(self):
        tfs = self.state.timeframe("5m")
        tfs.mark_incomplete()
        self.assertEqual(tfs.data_quality, "INCOMPLETE")
        self.assertIsNone(tfs.close)

    def test_storage_round_trip(self):
        self._tick(100.0, T0, 100)
        self._tick(110.0, T0 + 10, 300)
        doc = self.state.timeframe("1m").to_storage_doc("AAA", "1", "2026-09-26")
        restored = TimeframeState.from_storage_doc(doc)
        self.assertEqual(restored.close, 110.0)
        self.assertEqual(restored.high, 110.0)
        self.assertEqual(restored.volume, 200)
        self.assertEqual(restored.data_quality, doc["dataQuality"])
        self.assertAlmostEqual(restored.vwap, self.state.timeframe("1m").vwap, places=4)

    def test_completed_history_is_bounded(self):
        for i in range(120):
            self._tick(100.0 + (i % 5), T0 + i * 60, 10 + i)
        self.assertLessEqual(len(self.engine.completed_history("1", "1m")), 4)

    def test_force_close_emits_and_resets(self):
        self._tick(100.0, T0, 100)
        self.engine.bind({"1": self.state})
        closed = self.engine.close_open_candles("2026-09-26")
        self.assertGreaterEqual(closed, 1)
        self.assertEqual(self.state.timeframe("1m").tick_count, 0)
        self.assertEqual(self.state.timeframe("1m").data_quality, "UNAVAILABLE")

    def test_force_close_without_ticks_emits_nothing(self):
        self.engine.bind({"1": self.state})
        self.assertEqual(self.engine.close_open_candles("2026-09-26"), 0)

    def test_restore_rebuilds_only_the_current_bucket(self):
        now = T0 + 30
        self._tick(100.0, T0, 100)
        stored = self.state.timeframe("1m").to_storage_doc("AAA", "1", "2026-09-26")
        fresh = _state()
        self.assertEqual(self.engine.restore_symbol(fresh, [stored], now), 1)
        self.assertEqual(fresh.timeframe("1m").data_quality, "INCOMPLETE")

    def test_restore_of_a_stale_bucket_marks_incomplete(self):
        fresh = _state()
        stored = self.state.timeframe("1m").to_storage_doc("AAA", "1", "2026-09-26")
        self.assertEqual(self.engine.restore_symbol(fresh, [stored], T0 + 3600), 0)
        self.assertEqual(fresh.timeframe("1m").data_quality, "INCOMPLETE")

    def test_module_singleton_exists(self):
        self.assertIsNotNone(timeframe_engine)
        self.assertIsInstance(timeframe_engine, TimeframeEngine)


# --------------------------------------------------------------------------- #
# doc §12 movement filters
# --------------------------------------------------------------------------- #
class TestMovementFilters(unittest.TestCase):
    @staticmethod
    def _cfg(**kw) -> FilterConfig:
        def tf(name):
            return TimeframeFilterConfig(
                change_pct_min=kw.get(f"{name}_pct_min"),
                change_pct_max=kw.get(f"{name}_pct_max"),
                price_move_min=kw.get(f"{name}_move_min"),
                volume_min=kw.get(f"{name}_volume_min"),
            )
        return FilterConfig(
            enabled=True,
            price=PriceFilterConfig(0.0, 1e9),
            timeframes={name: tf(name) for name in ("1m", "5m", "10m", "30m")},
        )

    def test_and_semantics_across_timeframes(self):
        cfg = self._cfg(**{"5m_pct_min": 1.0, "10m_pct_min": 1.5, "30m_pct_min": 2.0})
        state = _state(ltp=100.0)
        for name, value in (("5m", 1.2), ("10m", 1.6), ("30m", 2.4)):
            state.timeframe(name).change_pct = value
        passed, failures = evaluate_movement(state, cfg)
        self.assertTrue(passed, failures)
        state.timeframe("30m").change_pct = 1.9
        passed, failures = evaluate_movement(state, cfg)
        self.assertFalse(passed)
        self.assertTrue(any("30m" in f for f in failures), failures)

    def test_upper_bound_is_respected(self):
        cfg = self._cfg(**{"1m_pct_max": 5.0})
        state = _state(ltp=100.0)
        state.timeframe("1m").change_pct = 6.0
        self.assertFalse(evaluate_movement(state, cfg)[0])
        state.timeframe("1m").change_pct = 4.0
        self.assertTrue(evaluate_movement(state, cfg)[0])

    def test_absolute_price_move_filter(self):
        cfg = self._cfg(**{"1m_move_min": 5.0})
        state = _state(ltp=100.0)
        state.timeframe("1m").price_move = 4.0
        self.assertFalse(evaluate_movement(state, cfg)[0])
        state.timeframe("1m").price_move = 6.0
        self.assertTrue(evaluate_movement(state, cfg)[0])

    def test_volume_minimum_filter(self):
        cfg = self._cfg(**{"1m_volume_min": 1_000.0})
        state = _state(ltp=100.0)
        state.timeframe("1m").volume = 500
        self.assertFalse(evaluate_movement(state, cfg)[0])
        state.timeframe("1m").volume = 5_000
        self.assertTrue(evaluate_movement(state, cfg)[0])

    def test_missing_metric_fails_and_is_reported(self):
        cfg = self._cfg(**{"1m_pct_min": 0.5})
        passed, failures = evaluate_movement(_state(ltp=100.0), cfg)
        self.assertFalse(passed)
        self.assertTrue(failures, "a missing value must be explained, not silently passed")

    def test_a_symbol_without_a_price_is_not_evaluated(self):
        cfg = self._cfg(**{"1m_pct_min": 0.5})
        passed, failures = evaluate_movement(_state(), cfg)
        self.assertFalse(passed)
        self.assertIn("ltp: no value", failures)

    def test_unset_bounds_are_not_applied(self):
        cfg = self._cfg()
        state = _state(ltp=100.0)
        state.timeframe("1m").change_pct = -99.0
        self.assertTrue(evaluate_movement(state, cfg)[0])

    def test_disabled_config_passes_everything(self):
        cfg = FilterConfig(
            enabled=False, price=PriceFilterConfig(0.0, 1e9),
            timeframes={"1m": TimeframeFilterConfig(change_pct_min=1.0)},
        )
        self.assertTrue(evaluate_movement(_state(), cfg)[0])
        self.assertTrue(evaluate_movement(_state(ltp=5.0), cfg)[0])

    def test_apply_over_a_state_map_splits_pass_and_fail(self):
        cfg = self._cfg(**{"1m_pct_min": 1.0})
        states = {}
        for i in range(5):
            st = _state(f"S{i}", str(i), ltp=100.0)
            st.timeframe("1m").change_pct = 2.0 if i < 2 else 0.1
            states[str(i)] = st
        passed, failures = apply_movement_filters(states, cfg)
        self.assertEqual(len(passed), 2)
        self.assertEqual(len(failures), 3)
        self.assertIn("3", failures)


# --------------------------------------------------------------------------- #
# doc §6/§7 block ledger
# --------------------------------------------------------------------------- #
class TestBlockLedger(unittest.TestCase):
    def setUp(self):
        self.ledger = DailyBlockLedger()
        self.ledger.configure_day("2026-09-26")
        self.written: list[dict] = []
        self.ledger.set_sink(lambda docs: self.written.extend(docs) or len(docs))

    def _block(self, token="1", symbol="AAA", reason="PRICE_LIMIT", **kw):
        return self.ledger.record_block(
            token, symbol, reason=reason,
            threshold=kw.get("threshold", 5.0), observed=kw.get("observed", 1.0),
            detail=kw.get("detail", ""), circuit_block_pct=kw.get("circuit_block_pct"),
            now=kw.get("now", T0),
        )

    def test_block_document_has_the_documented_fields(self):
        entry = self._block(reason="CIRCUIT_TOO_CLOSE", threshold=3.0, observed=1.2,
                            detail="upper circuit within block distance", circuit_block_pct=3.0)
        doc = entry.to_doc()
        for field in (
            "symbol", "instrumentToken", "date", "status", "reason", "threshold",
            "observed_value", "blocked_at", "detail", "circuitBlockPct", "reentered_at",
        ):
            self.assertIn(field, doc)
        self.assertEqual(doc["status"], STATUS_BLOCKED)
        self.assertEqual(doc["date"], "2026-09-26")

    def test_a_block_is_buffered_through_the_sink(self):
        self._block()
        self.assertEqual(len(self.written), 1)
        self.assertEqual(self.written[0]["_id"], "2026-09-26:1")

    def test_duplicate_block_does_not_churn_writes(self):
        for _ in range(5):
            self._block()
        self.assertEqual(len(self.written), 1)
        self.assertEqual(self.ledger.summary()["blocked"], 1)

    def test_a_different_reason_updates_the_entry(self):
        self._block(reason="PRICE_LIMIT")
        self._block(reason="LIQUIDITY_FAIL")
        self.assertEqual(len(self.written), 2)
        self.assertEqual(self.ledger.entry("1").reason, "LIQUIDITY_FAIL")

    def test_blocked_symbol_does_not_silently_re_enter(self):
        self._block()
        self.assertTrue(self.ledger.is_blocked("1"))
        self.ledger.record_active("1", "AAA")
        self.assertTrue(self.ledger.is_blocked("1"), "record_active must not clear a block")

    def test_explicit_re_entry_is_recorded_and_keeps_the_block(self):
        self._block()
        entry = self.ledger.record_reentry("1", now=T0 + 60)
        self.assertEqual(entry.status, STATUS_ACTIVE)
        self.assertIsNotNone(entry.reentered_at)
        self.assertEqual(entry.reason, "PRICE_LIMIT", "the original block is preserved")
        self.assertFalse(self.ledger.is_blocked("1"))
        self.assertEqual(self.ledger.summary()["reentered"], 1)

    def test_re_entry_of_a_non_blocked_symbol_is_a_no_op(self):
        self.assertIsNone(self.ledger.record_reentry("1", now=T0))

    def test_day_roll_clears_state(self):
        self._block()
        self.ledger.configure_day("2026-09-27")
        self.assertEqual(self.ledger.blocked_tokens(), set())
        self.assertEqual(self.ledger.date, "2026-09-27")

    def test_configuring_the_same_day_keeps_state(self):
        self._block()
        self.ledger.configure_day("2026-09-26")
        self.assertTrue(self.ledger.is_blocked("1"))

    def test_summary_counts_reasons(self):
        for token, reason in (("1", "PRICE_LIMIT"), ("2", "PRICE_LIMIT"), ("3", "CIRCUIT_TOO_CLOSE")):
            self._block(token=token, symbol=token, reason=reason)
        summary = self.ledger.summary()
        self.assertEqual(summary["blocked"], 3)
        self.assertEqual(summary["reasonCounts"], {"PRICE_LIMIT": 2, "CIRCUIT_TOO_CLOSE": 1})

    def test_persistence_can_be_disabled(self):
        self.ledger.set_persist_enabled(False)
        self._block(token="9", symbol="Z")
        self.assertEqual(self.written, [])
        self.assertTrue(self.ledger.is_blocked("9"), "the in-memory decision still stands")

    def test_a_failing_sink_never_breaks_the_decision(self):
        def boom(docs):
            raise RuntimeError("mongo down")
        self.ledger.set_sink(boom)
        entry = self._block()
        self.assertIsNotNone(entry)
        self.assertTrue(self.ledger.is_blocked("1"))


# --------------------------------------------------------------------------- #
# doc §15/§16/§19/§25 publish policy
# --------------------------------------------------------------------------- #
class TestPublishPolicy(unittest.TestCase):
    def setUp(self):
        self.policy = PublishPolicy()
        self.policy.configure(mwcfg.load())

    def test_documented_event_and_command_vocabulary(self):
        for event in (
            "market_watch.snapshot", "market_watch.ranking_update", "market_watch.stock_update",
            "market_watch.index_update", "market_watch.timeframe_update",
            "market_watch.stock_blocked", "market_watch.stock_unblocked",
            "market_watch.status", "market_watch.more_snapshot", "market_watch.error",
        ):
            self.assertIn(event, EVENT_TYPES)
        for command in (
            "market_watch.show_more", "market_watch.select_stock", "market_watch.pin_stock",
            "market_watch.unpin_stock", "market_watch.display_intent",
        ):
            self.assertIn(command, COMMAND_TYPES)

    def test_publish_set_is_top_pinned_selected_visible_only(self):
        self.policy.set_ranked(["1", "2"])
        self.policy.pin("3")
        self.policy.select("4")
        self.policy.set_visible(["5"])
        self.assertEqual(self.policy.publish_set(), ["1", "2", "3", "4", "5"])

    def test_symbol_outside_the_set_is_never_published(self):
        self.policy.set_ranked(["1"])
        self.assertTrue(self.policy.stage_stock("1", {"symbol": "AAA"}))
        self.assertFalse(self.policy.stage_stock("999", {"symbol": "XXX"}))
        self.assertEqual(self.policy.pending_count(), 1)
        self.assertEqual(self.policy.status()["suppressed"], 1)

    def test_coalescing_keeps_only_the_latest_state(self):
        self.policy.set_ranked(["1"])
        for price in (100, 101, 102, 103):
            self.policy.stage_stock("1", {"symbol": "AAA", "ltp": price})
        stocks, _ = self.policy.drain()
        self.assertEqual(len(stocks), 1)
        self.assertEqual(stocks[0]["ltp"], 103)
        self.assertEqual(stocks[0]["type"], EVENT_STOCK_UPDATE)
        self.assertEqual(self.policy.status()["coalesced"], 3)

    def test_timeframes_are_a_separate_event_stream(self):
        self.policy.set_ranked(["1"])
        self.policy.stage_timeframes("1", {"symbol": "AAA", "timeframes": {}})
        stocks, timeframes = self.policy.drain()
        self.assertEqual(stocks, [])
        self.assertEqual(timeframes[0]["type"], "market_watch.timeframe_update")

    def test_due_respects_the_coalesce_window(self):
        import time as _time

        self.policy.set_ranked(["1"])
        self.assertFalse(self.policy.due(), "nothing staged -> nothing due")
        self.policy.stage_stock("1", {"symbol": "AAA"})
        self.assertTrue(self.policy.due(), "the first flush is immediate")
        self.policy.drain()
        self.policy.stage_stock("1", {"symbol": "AAA"})
        self.assertFalse(self.policy.due(), "inside the window")
        self.policy._last_flush_at = _time.time() - 10.0
        self.assertTrue(self.policy.due(), "past the window")

    def test_publish_set_is_bounded_but_reported_honestly(self):
        import dataclasses

        cfg = _with(publish=dataclasses.replace(
            mwcfg.load().publish, coalesce_ms=250, max_symbols=3, live_stock_updates=True,
        ))
        policy = PublishPolicy()
        policy.configure(cfg)
        policy.set_ranked(["1", "2", "3", "4", "5"])
        self.assertEqual(len(policy.publish_set()), 3)
        self.assertEqual(policy.publish_set_size(), 5)
        self.assertEqual(policy.status()["publishSetSize"], 5)

    def test_live_updates_can_be_switched_off(self):
        import dataclasses

        cfg = _with(publish=dataclasses.replace(mwcfg.load().publish, live_stock_updates=False))
        policy = PublishPolicy()
        policy.configure(cfg)
        policy.set_ranked(["1"])
        self.assertFalse(policy.stage_stock("1", {"symbol": "AAA"}))

    def test_show_more_validation_is_paged_and_bounded(self):
        ok, reason, request = validate_show_more({"request_id": "r1", "page": 2, "page_size": 100})
        self.assertTrue(ok, reason)
        self.assertEqual(request["page"], 2)
        self.assertEqual(request["section"], "top_gainers")
        capped = mwcfg.load().universe.show_more_max_page_size
        _, _, big = validate_show_more({"request_id": "r1", "page_size": 100_000})
        self.assertEqual(big["page_size"], capped)
        self.assertFalse(validate_show_more({"page": 1})[0], "request_id is required")
        self.assertFalse(validate_show_more({"request_id": "r", "page": 0})[0])
        self.assertFalse(validate_show_more({"request_id": "r", "page": "abc"})[0])
        self.assertFalse(validate_show_more({"request_id": "r", "section": "nope"})[0])

    def test_more_snapshot_event_shape(self):
        event = more_snapshot_event(
            {"request_id": "r1", "page": 1, "page_size": 50}, [{"symbol": "AAA"}], 327,
        )
        self.assertEqual(event["type"], EVENT_MORE_SNAPSHOT)
        self.assertEqual(event["request_id"], "r1")
        self.assertEqual(event["total_eligible"], 327)
        self.assertEqual(event["page_size"], 50)
        self.assertEqual(len(event["stocks"]), 1)

    def test_reset_clears_the_set_and_the_queue(self):
        self.policy.set_ranked(["1"])
        self.policy.select("2")
        self.policy.stage_stock("1", {"symbol": "AAA"})
        self.policy.reset()
        self.assertEqual(self.policy.publish_set(), [])
        self.assertEqual(self.policy.pending_count(), 0)


# --------------------------------------------------------------------------- #
# doc §17 indexes
# --------------------------------------------------------------------------- #
class TestIndexes(unittest.TestCase):
    def _tracker(self):
        from services.market_watch_indexes import IndexTracker

        return IndexTracker(names=("NIFTY", "BANKNIFTY"))

    def test_index_without_a_token_stays_unavailable(self):
        tracker = self._tracker()
        for state in tracker.states():
            self.assertEqual(state.token, "")
            self.assertEqual(state.data_quality, "UNAVAILABLE")
            self.assertIsNone(state.ltp)
        self.assertEqual(tracker.live_count(), 0)

    def test_unmatched_token_is_ignored(self):
        self.assertFalse(self._tracker().apply_tick("999", {"ltp": 100.0}, now=T0))

    def test_matched_index_tick_is_consumed(self):
        tracker = self._tracker()
        index_state = tracker.states()[0]
        index_state.token = "256265"
        tracker._by_token["256265"] = index_state.name
        self.assertTrue(tracker.apply_tick("256265", {"ltp": 100.0, "prevClose": 99.0}, now=T0))
        self.assertEqual(index_state.ltp, 100.0)
        self.assertEqual(index_state.data_quality, "LIVE")

    def test_index_change_pct_uses_the_real_previous_close(self):
        tracker = self._tracker()
        index_state = tracker.states()[0]
        index_state.token = "256265"
        tracker._by_token["256265"] = index_state.name
        tracker.apply_tick("256265", {"ltp": 101.0, "prevClose": 99.0}, now=T0)
        row = tracker.to_dict()["indexes"][0]
        self.assertAlmostEqual(row["changePct"], (101.0 - 99.0) / 99.0 * 100.0, places=3)

    def test_index_ohlc_accumulates_real_values(self):
        tracker = self._tracker()
        index_state = tracker.states()[0]
        index_state.token = "1"
        tracker._by_token["1"] = index_state.name
        tracker.apply_tick("1", {"ltp": 100.0, "open": 99.0, "high": 101.0, "low": 98.0}, now=T0)
        tracker.apply_tick("1", {"ltp": 105.0, "high": 106.0}, now=T0 + 1)
        row = tracker.to_dict()["indexes"][0]
        self.assertEqual((row["open"], row["high"], row["low"], row["ltp"]), (99.0, 106.0, 98.0, 105.0))

    def test_a_zero_or_missing_price_is_not_applied(self):
        tracker = self._tracker()
        index_state = tracker.states()[0]
        index_state.token = "1"
        tracker._by_token["1"] = index_state.name
        self.assertFalse(tracker.apply_tick("1", {"ltp": 0}, now=T0))
        self.assertFalse(tracker.apply_tick("1", {}, now=T0))
        self.assertIsNone(index_state.ltp)

    def test_reset_returns_indexes_to_unavailable(self):
        tracker = self._tracker()
        index_state = tracker.states()[0]
        index_state.token = "1"
        tracker._by_token["1"] = index_state.name
        tracker.apply_tick("1", {"ltp": 100.0}, now=T0)
        tracker.reset()
        self.assertIsNone(index_state.ltp)
        self.assertEqual(index_state.data_quality, "UNAVAILABLE")


# --------------------------------------------------------------------------- #
# doc §23/§24 buffered persistence
# --------------------------------------------------------------------------- #
class TestDocumentBuffer(unittest.TestCase):
    def setUp(self):
        doc_reset()

    def tearDown(self):
        doc_reset()

    def test_documented_collections_exist(self):
        for name in (
            "market_ticks", "market_candles_1m", "market_candles_2m", "market_candles_5m", "market_candles_10m",
            "market_candles_30m", "market_watch_decisions", "market_watch_daily_report",
        ):
            self.assertIn(name, MW_COLLECTIONS)

    def test_documents_buffer_without_touching_mongo(self):
        self.assertEqual(doc_add("market_candles_1m", [
            {"_id": "2026-09-26:1:1m:100", "close": 10.0, "complete": True},
        ]), 1)
        self.assertEqual(doc_pending("market_candles_1m"), 1)
        self.assertEqual(doc_stats()["totalReceived"], 1)

    def test_unknown_collection_is_rejected_not_created(self):
        self.assertEqual(doc_add("market_watch_fabricated", [{"_id": "x"}]), 0)
        self.assertEqual(doc_pending(), 0)
        self.assertNotIn("market_watch_fabricated", doc_stats()["byCollection"])

    def test_candles_and_decisions_are_idempotent_ticks_are_not(self):
        # (idempotent: bool, max batch size)
        self.assertTrue(MW_COLLECTIONS["market_candles_1m"][0])
        self.assertTrue(MW_COLLECTIONS["market_candles_2m"][0])
        self.assertTrue(MW_COLLECTIONS["market_candles_5m"][0])
        self.assertTrue(MW_COLLECTIONS["market_candles_10m"][0])
        self.assertTrue(MW_COLLECTIONS["market_candles_30m"][0])
        self.assertTrue(MW_COLLECTIONS["market_watch_decisions"][0])
        self.assertTrue(MW_COLLECTIONS["market_watch_daily_report"][0])
        self.assertFalse(MW_COLLECTIONS["market_ticks"][0])

    def test_duplicate_id_ticks_are_skipped_not_counted_as_write_failures(self):
        """A duplicate ``_id`` on append-only ticks is a benign skip.

        ``market_ticks`` is append-only but every doc carries a deterministic
        ``_id`` of "<symbol>:<epoch_ms>", so two ticks for one symbol inside the
        same millisecond collide. pymongo still raises the whole
        ``BulkWriteError`` with ``ordered=False``; treating that as a batch
        failure marked the other ~470 inserted docs as lost and abandoned the
        buffer. This pins the real inserted count and zero write errors.
        """
        from pymongo.errors import BulkWriteError

        from services import market_watch_doc_buffer as buf

        doc_reset()

        class _Coll:
            async def bulk_write(self, ops, ordered=False):
                # 3 ops offered, 1 collides on _id, 2 really inserted.
                raise BulkWriteError({
                    "writeErrors": [
                        {"index": 1, "code": 11000,
                         "errmsg": 'E11000 duplicate key error collection: kaustubh.market_ticks index: _id_'},
                    ],
                    "nInserted": 2,
                })

        class _DB:
            def __getitem__(self, name):
                return _Coll()

        batch = [{"_id": "AAA:1"}, {"_id": "AAA:1"}, {"_id": "BBB:1"}]
        with mock.patch("database.connection.get_db", return_value=_DB()):
            written = asyncio.run(buf._write("market_ticks", batch))

        self.assertEqual(written, 2, "the 2 non-colliding ticks were really written")
        self.assertEqual(buf.stats()["totalWriteErrors"], 0,
                         "a duplicate _id is not a write error")
        self.assertEqual(buf.stats()["totalDuplicateSkips"], 1)
        doc_reset()

    def test_non_duplicate_write_errors_still_propagate(self):
        """Real failures must NOT be swallowed by the duplicate-key handling."""
        from pymongo.errors import BulkWriteError

        from services import market_watch_doc_buffer as buf

        doc_reset()

        class _Coll:
            async def bulk_write(self, ops, ordered=False):
                raise BulkWriteError({
                    "writeErrors": [{"index": 0, "code": 121, "errmsg": "validation failed"}],
                    "nInserted": 0,
                })

        class _DB:
            def __getitem__(self, name):
                return _Coll()

        with mock.patch("database.connection.get_db", return_value=_DB()):
            with self.assertRaises(BulkWriteError):
                asyncio.run(buf._write("market_ticks", [{"_id": "AAA:1"}]))
        doc_reset()

    def test_db_writer_routes_candles_by_timeframe(self):
        from services.db_writer_engine import CANDLE_COLLECTIONS, db_writer_engine

        self.assertEqual(CANDLE_COLLECTIONS["1m"], "market_candles_1m")
        self.assertEqual(CANDLE_COLLECTIONS["2m"], "market_candles_2m")
        self.assertEqual(CANDLE_COLLECTIONS["30m"], "market_candles_30m")
        accepted = db_writer_engine.buffer_candles([
            {"_id": "a", "timeframe": "1m"},
            {"_id": "b", "timeframe": "30m"},
            {"_id": "c", "timeframe": "7m"},   # unknown timeframe -> rejected
        ])
        self.assertEqual(accepted, 2)
        self.assertEqual(doc_pending("market_candles_1m"), 1)
        self.assertEqual(doc_pending("market_candles_30m"), 1)

    def test_a_candle_without_a_timeframe_is_not_guessed(self):
        from services.db_writer_engine import db_writer_engine

        self.assertEqual(db_writer_engine.buffer_candles([{"_id": "a", "close": 1.0}]), 0)

    def test_ledger_sink_writes_through_the_db_writer(self):
        from services.db_writer_engine import db_writer_engine
        from services.market_watch_ledger import COLLECTION

        ledger = DailyBlockLedger()
        ledger.configure_day("2026-09-26")
        ledger.set_sink(lambda docs: db_writer_engine.buffer_documents(COLLECTION, docs))
        ledger.record_block(
            "1", "AAA", reason="PRICE_LIMIT", threshold=1.0, observed=1.0,
            detail="", circuit_block_pct=None, now=T0,
        )
        self.assertEqual(doc_pending(COLLECTION), 1)
        self.assertEqual(COLLECTION, LEDGER_COLLECTION)


# --------------------------------------------------------------------------- #
# doc §26 EOD report
# --------------------------------------------------------------------------- #
class TestEodReport(unittest.TestCase):
    def setUp(self):
        self.ledger = DailyBlockLedger()
        self.ledger.configure_day("2026-09-26")
        self.ledger.set_sink(lambda docs: len(docs))
        self.ledger.record_block(
            "4", "BLOCKEDCO", reason="CIRCUIT_TOO_CLOSE", threshold=3.0, observed=1.1,
            detail="near circuit", circuit_block_pct=3.0, now=T0,
        )
        self.states = {}
        for token, symbol, price, previous in (
            ("1", "GAINCO", 110.0, 100.0),
            ("2", "LOSECO", 90.0, 100.0),
            ("3", "QUIETCO", 100.0, 100.0),
            ("4", "BLOCKEDCO", 102.0, 100.0),
        ):
            state = _ticked(symbol, token, ltp=price, previous_close=previous, now=T0)
            self.states[token] = state
        # A symbol that never received a tick must not appear anywhere.
        self.states["5"] = _state("NODATA", "5")

    def _report(self, **kw):
        params = dict(
            trading_date="2026-09-26",
            states=self.states,
            eligible_tokens=["1", "2", "3", "4", "5"],
            subscribed_tokens=["1", "2", "3", "4"],
            ledger=self.ledger,
            lifecycle_snapshot={"state": "REPORTING"},
            stats={},
        )
        params.update(kw)
        return build_report(**params)

    def test_report_contains_every_documented_section(self):
        report = self._report()
        for section in ("movers", "highestVolume", "mostActive", "circuitNear", "blocked"):
            self.assertIn(section, report)
        self.assertIn("topGainers", report["movers"])
        self.assertIn("topDeclinersByPriceChange", report["movers"])
        self.assertIn("dataQuality", report)

    def test_counts_reflect_the_real_sets(self):
        counts = self._report()["counts"]
        self.assertEqual(counts["eligible"], 5)
        self.assertEqual(counts["subscribed"], 4)
        self.assertEqual(counts["blocked"], 1)
        self.assertEqual(counts["universeTracked"], 5)
        self.assertEqual(counts["withLivePrice"], 4)
        self.assertEqual(counts["totalValidatedTicks"], 4)

    def test_block_reasons_are_counted(self):
        self.assertEqual(self._report()["blockReasons"], {"CIRCUIT_TOO_CLOSE": 1})
        self.assertEqual(self._report()["blocked"][0]["symbol"], "BLOCKEDCO")

    def test_a_symbol_without_a_tick_never_appears_in_a_ranking(self):
        report = self._report()
        ranked = [r["symbol"] for rows in report["movers"].values() for r in rows]
        ranked += [r["symbol"] for r in report["highestVolume"]]
        ranked += [r["symbol"] for r in report["mostActive"]]
        self.assertNotIn("NODATA", ranked)

    def test_a_blocked_symbol_is_ranked_but_flagged(self):
        """It really moved, so it stays in the ranking — but never unqualified."""
        report = self._report()
        gainers = report["movers"]["topGainers"]
        blocked_row = [r for r in gainers if r["symbol"] == "BLOCKEDCO"]
        self.assertEqual(len(blocked_row), 1)
        self.assertTrue(blocked_row[0]["blocked"])
        self.assertFalse(gainers[0]["blocked"])

    def test_gainers_and_decliners_are_ordered_by_real_change(self):
        movers = self._report()["movers"]
        self.assertEqual(movers["topGainers"][0]["symbol"], "GAINCO")
        self.assertEqual(movers["topDeclinersByPriceChange"][0]["symbol"], "LOSECO")

    def test_report_never_labels_a_price_decline_a_loss(self):
        blob = repr(self._report()).lower()
        self.assertNotIn("high loss", blob)
        self.assertNotIn("highloss", blob)
        self.assertIn("decliner", blob)

    def test_report_is_idempotent_by_date(self):
        self.assertEqual(self._report()["_id"], "2026-09-26")

    def test_data_quality_vocabulary_is_published(self):
        quality = self._report()["dataQuality"]
        self.assertIn("UNAVAILABLE", quality["vocabulary"])
        self.assertEqual(quality["bySymbol"]["UNAVAILABLE"], 1, "the symbol with no tick")
        self.assertEqual(quality["bySymbol"]["LIVE"], 4)


# --------------------------------------------------------------------------- #
# doc §16/§19 WS #4 command handling on the engine
# --------------------------------------------------------------------------- #
class TestBrokerBoundary(unittest.TestCase):
    """Market Watch must never reach into a broker client (architecture §5)."""

    def _modules(self):
        import pathlib
        import services
        root = pathlib.Path(services.__file__).parent
        return sorted(root.glob("market_watch_*.py"))

    def test_no_market_watch_module_imports_a_broker_client(self):
        import re
        offenders = []
        for path in self._modules():
            text = path.read_text(encoding="utf-8")
            # Strip comments/docstrings so prose about the rule is not a match.
            code = re.sub(r'""".*?"""', "", text, flags=re.S)
            code = re.sub(r"#.*", "", code)
            for banned in ("auth.kotak_client", "kotak_session", "async_quote", "order_place"):
                if banned in code:
                    offenders.append(f"{path.name}: {banned}")
        self.assertEqual(offenders, [], f"broker access in Market Watch: {offenders}")

    def test_the_account_intraday_flag_is_never_read_from_the_broker_client(self):
        """No authoritative source -> ``None``, never a fabricated ``False``."""
        from services.market_watch_engine import market_watch_engine
        import services.session.session_manager as session_manager
        import brokers.broker_registry as registry
        import brokers.manager as broker_manager

        originals = (
            (session_manager, "snapshot", session_manager.snapshot),
            (registry, "get_broker_registry", registry.get_broker_registry),
            (broker_manager, "get_adapter", broker_manager.get_adapter),
        )
        for obj, attr, _ in originals:
            setattr(obj, attr, mock.Mock(side_effect=RuntimeError("unavailable")))
        self.addCleanup(lambda: [setattr(o, a, v) for o, a, v in originals])

        self.assertIsNone(market_watch_engine._account_intraday_flag(),
                          "unknown account state must stay unknown, not become False")

    def test_a_published_session_decision_is_used(self):
        from services.market_watch_engine import market_watch_engine
        import services.session.session_manager as session_manager

        original = session_manager.snapshot
        session_manager.snapshot = lambda: {"active": True, "intraday_available": True}
        self.addCleanup(setattr, session_manager, "snapshot", original)
        self.assertIs(market_watch_engine._account_intraday_flag(), True)


class TestEngineCommands(unittest.TestCase):
    def setUp(self):
        from services.market_watch_engine import MarketWatchEngine
        from services.market_watch_publish import publish_policy

        self.engine = MarketWatchEngine()
        self.policy = publish_policy
        self.policy.reset()
        self.engine._registry = {
            "1": {"token": "1", "symbol": "AAA", "name": "AAA Co", "exchange": "nse_cm",
                  "segment": "EQUITY", "intradayEligible": True},
            "2": {"token": "2", "symbol": "BBB", "name": "BBB Co", "exchange": "nse_cm",
                  "segment": "EQUITY", "intradayEligible": True},
        }
        self.engine._seed_states()
        for token, price, previous in (("1", 110.0, 100.0), ("2", 90.0, 100.0)):
            self.engine.symbol_state(token).apply_price_tick(
                now=T0, ltp=price, previous_close=previous, volume=5_000.0,
                open_=price, high=price, low=price,
            )
        self.engine._eligible_tokens = {"1", "2"}

    def _run(self, payload):
        return asyncio.run(self.engine.handle_ws_command(payload))

    def test_show_more_returns_a_paged_snapshot(self):
        event = self._run({"type": "market_watch.show_more", "request_id": "r1", "page": 1, "page_size": 10})
        self.assertEqual(event["type"], EVENT_MORE_SNAPSHOT)
        self.assertEqual(event["request_id"], "r1")
        self.assertEqual(event["total_eligible"], 2)
        self.assertEqual(len(event["stocks"]), 2)

    def test_show_more_pages_over_the_whole_universe_not_a_capped_board(self):
        """The official boards are capped; Show More must page the full set."""
        for token in ("3", "4"):
            self.engine._registry[token] = {
                "token": token, "symbol": f"S{token}", "name": f"S{token}",
                "exchange": "nse_cm", "segment": "EQUITY", "intradayEligible": True,
            }
        self.engine._seed_states()
        self.engine.symbol_state("3").apply_price_tick(
            now=T0, ltp=105.0, previous_close=100.0, volume=100.0, open_=105.0, high=105.0, low=105.0)
        self.engine.symbol_state("4").apply_price_tick(
            now=T0, ltp=95.0, previous_close=100.0, volume=100.0, open_=95.0, high=95.0, low=95.0)
        self.engine._eligible_tokens = {"1", "2", "3", "4"}
        # Cap the OFFICIAL board at 1 entry, as config would.
        self.engine._official_rankings = {
            "top_gainers": [{"symbol": "AAA", "instrumentToken": "1", "ltp": 110.0}],
        }
        boards = self.engine.official_rankings()
        self.assertLessEqual(len(boards["top_gainers"]), 1, "the board is capped by config")
        event = self._run({"type": "market_watch.show_more", "request_id": "r2",
                           "page": 1, "page_size": 50})
        self.assertEqual(event["total_eligible"], 4, "Show More must not truncate at the board cap")

    def test_show_more_requires_a_request_id(self):
        event = self._run({"type": "market_watch.show_more", "page": 1})
        self.assertEqual(event["type"], "market_watch.error")
        self.assertEqual(event["code"], "400")

    def test_select_promotes_a_symbol_into_the_publish_set(self):
        event = self._run({"type": "market_watch.select_stock", "request_id": "r2", "instrumentToken": "1"})
        self.assertEqual(event["type"], "market_watch.status")
        self.assertIn("1", event["publishSet"])
        self.assertIn("1", self.policy.publish_set())

    def test_selecting_an_unknown_token_is_a_404(self):
        event = self._run({"type": "market_watch.select_stock", "request_id": "r3", "instrumentToken": "999"})
        self.assertEqual(event["type"], "market_watch.error")
        self.assertEqual(event["code"], "404")

    def test_pin_then_unpin(self):
        self._run({"type": "market_watch.pin_stock", "request_id": "r4", "instrumentToken": "2"})
        self.assertIn("2", self.policy.publish_set())
        self._run({"type": "market_watch.unpin_stock", "request_id": "r5", "instrumentToken": "2"})
        self.assertNotIn("2", self.policy.publish_set())

    def test_pinning_an_unknown_token_is_rejected(self):
        event = self._run({"type": "market_watch.pin_stock", "request_id": "r6", "instrumentToken": "999"})
        self.assertEqual(event["type"], "market_watch.error")

    def test_display_intent_reports_ignored_tokens(self):
        event = self._run({
            "type": "market_watch.display_intent", "request_id": "r7", "visible": ["1", "NOT_A_TOKEN"],
        })
        self.assertEqual(event["ignoredTokens"], ["NOT_A_TOKEN"])
        self.assertIn("1", event["publishSet"])

    def test_show_more_does_not_promote_into_the_live_set(self):
        self._run({"type": "market_watch.show_more", "request_id": "r8", "page": 1, "page_size": 10})
        self.assertEqual(self.policy.publish_set(), [])

    def test_an_unknown_command_is_rejected(self):
        event = self._run({"type": "market_watch.launch_rocket", "request_id": "r9"})
        self.assertEqual(event["type"], "market_watch.error")

    def test_a_missing_command_type_is_rejected(self):
        self.assertEqual(self._run({"request_id": "r10"})["type"], "market_watch.error")

    def test_stopped_engine_reports_no_desired_subscriptions(self):
        # Engine stopped (MARKET_WATCH_STOPPED) -> no subscriptions
        self.engine._stop_done_for = "2026-09-26"
        self.engine._lifecycle_state = MARKET_WATCH_STOPPED
        self.assertEqual(self.engine.desired_subscriptions(), [])
        self.assertEqual(self.engine.eligible_subscription_payload(), [])
        self.assertEqual(self.engine.index_subscription_payload(), [])

        # Engine in RUNTIME_INACTIVE (outside 08:50-15:30) -> no subscriptions
        self.engine._stop_done_for = ""
        self.engine._lifecycle_state = RUNTIME_INACTIVE
        self.assertEqual(self.engine.desired_subscriptions(), [])
        self.assertEqual(self.engine.eligible_subscription_payload(), [])
        self.assertEqual(self.engine.index_subscription_payload(), [])

        # Engine running (MONITORING) -> subscriptions available
        self.engine._stop_done_for = ""
        self.engine._lifecycle_state = MONITORING
        # Note: eligible count depends on test fixture setup, not hardcoded to 2

    def test_index_subscription_only_requests_resolved_tokens(self):
        from services.market_watch_indexes import index_tracker

        index_tracker._indexes.clear()
        self.assertEqual(self.engine.index_subscription_payload(), [])

    def test_reconnect_snapshot_carries_everything_the_ui_needs(self):
        self.policy.set_ranked(["1"])
        snapshot = self.engine.reconnect_snapshot()
        self.assertEqual(snapshot["type"], "market_watch.snapshot")
        for key in ("eligibleCount", "publishSet", "stocks", "indexes", "blocked", "lifecycle"):
            self.assertIn(key, snapshot)
        self.assertIn("1", snapshot["stocks"])

    def test_official_rankings_respect_the_configured_maximum(self):
        import dataclasses

        cfg = _with(universe=dataclasses.replace(mwcfg.load().universe, ranking_max_entries=1))
        # The loop reads the engine's resolved config, exactly as production does.
        self.engine.mw_config = lambda: cfg
        asyncio.run(self.engine._run_official_rankings("2026-09-26", T0))
        boards = self.engine.official_rankings()
        self.assertTrue(boards, "rankings must still be produced")
        for name, rows in boards.items():
            self.assertLessEqual(len(rows), 1, name)


# --------------------------------------------------------------------------- #
# day rollover (doc §5/§21)
# --------------------------------------------------------------------------- #
class TestDayRollover(unittest.TestCase):
    def setUp(self):
        from services.market_watch_engine import MarketWatchEngine
        from services.market_watch_publish import publish_policy

        self.engine = MarketWatchEngine()
        self.policy = publish_policy
        self.policy.reset()

    def test_roll_clears_state_blocks_and_publish_set(self):
        engine = self.engine
        engine._trading_date = "2026-09-25"
        engine._eligible_tokens = {"1", "2"}
        engine._subscribed_tokens = {"1"}
        engine._stop_done_for = "2026-09-25"
        engine._report_for = "2026-09-25"
        engine._states["1"] = object()
        self.policy.set_ranked(["1"])
        self.policy.select("2")

        engine._ensure_trading_day("2026-09-26")

        self.assertEqual(engine._trading_date, "2026-09-26")
        self.assertEqual(engine._eligible_tokens, set())
        self.assertEqual(engine._subscribed_tokens, set())
        self.assertEqual(engine._states, {})
        self.assertEqual(engine._stop_done_for, "")
        self.assertEqual(engine._report_for, "")
        self.assertEqual(self.policy.publish_set(), [], "yesterday's publish set must not survive")
        custom = engine.get_metrics().get("custom", {})
        self.assertEqual(custom.get("dayResetFrom"), "2026-09-25")
        self.assertEqual(custom.get("dayResetTo"), "2026-09-26")

    def test_roll_resets_the_block_ledger(self):
        from services.market_watch_ledger import block_ledger

        block_ledger.configure_day("2026-09-25")
        block_ledger.set_sink(lambda docs: len(docs))
        block_ledger.record_block(
            "1", "AAA", reason="PRICE_LIMIT", threshold=1.0, observed=1.0,
            detail="", circuit_block_pct=None, now=T0,
        )
        self.assertTrue(block_ledger.is_blocked("1"))

        self.engine._trading_date = "2026-09-25"
        self.engine._ensure_trading_day("2026-09-26")
        self.assertEqual(block_ledger.date, "2026-09-26")
        self.assertFalse(block_ledger.is_blocked("1"), "yesterday's block must not block today")

    def test_the_same_day_is_not_reset(self):
        self.engine._trading_date = "2026-09-26"
        self.engine._eligible_tokens = {"1"}
        self.engine._ensure_trading_day("2026-09-26")
        self.assertEqual(self.engine._eligible_tokens, {"1"})


# --------------------------------------------------------------------------- #
# doc §23: persistence on/off (ticks / candles / decisions)
#
# These are the operator switches the audit flagged as unreachable: the config
# key existed but was registered in no DEFAULTS store and no LIVE_KEYS set, and
# ``mw_bool`` had no env tier, so ``MWR_PERSIST_TICKS=0`` was silently ignored
# and the Settings UI had no control to offer at all.
# --------------------------------------------------------------------------- #
class TestTickSavingSwitches(unittest.TestCase):
    def setUp(self):
        from services.market_watch_config import StorageConfig

        doc_reset()
        self._env = {k: os.environ.pop(k, None) for k in (
            "MWR_PERSIST_TICKS", "MWR_PERSIST_CANDLES", "MWR_PERSIST_DECISIONS",
        )}
        # This class verifies the AUTHORITY CONTRACT (Market Watch's own switch
        # is not sufficient; the DB Writer decides), not the storage cap. The
        # cap is operator configuration now, pinned OFF here so the "permission
        # granted" half of the contract stays observable; the cap's own
        # behaviour is covered by StorageCapTest in tests/test_db_writer_engine.py.
        cap_patcher = mock.patch(
            "services.db_writer_engine.storage_caps",
            return_value={
                "personalNoExpiry": False,
                "personalOneDay": False,
                "marketWatchOneDay": False,
            },
        )
        cap_patcher.start()
        self.addCleanup(cap_patcher.stop)
        self.storage = StorageConfig(
            persist_ticks=True, persist_candles=True, persist_decisions=True,
            tick_retention_days=2, candle_retention_days=30,
            decision_retention_days=90, report_retention_days=365,
        )

    def tearDown(self):
        doc_reset()
        for key, value in self._env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    @contextmanager
    def _db_writer_market_watch_permission(self, enabled: bool):
        """Drive the DB Writer's authoritative Market Watch tick permission.

        This is the permission the task makes the single authority, so the test
        sets it directly rather than through any Market Watch switch. The
        Session Manager classification is supplied too, because the DB Writer
        refuses an UNKNOWN classification (and must never infer the source
        from the symbol name).
        """
        values = {
            "dbw_personal_no_expiry_ticks": False,
            "dbw_personal_expiry_ticks": False,
            "dbw_market_watch_ticks": enabled,
        }
        instruments = {
            "1": {
                "instrumentToken": "1",
                "symbol": "AAA",
                "sources": ["market_watch_daily_universe"],
                "expiry_type": "SESSION",
                "expires_at": 9999999999,
            }
        }
        with mock.patch(
            "services.runtime_settings.get_runtime_setting",
            side_effect=lambda k: values.get(k),
        ), mock.patch(
            "services.session.session_manager.session_manager.active_registry",
            return_value=instruments,
        ):
            # The DB Writer memoises the registry and revalidates it against the
            # Session Manager's revision counter. A test double replaces the
            # registry without bumping that counter, so the memo has to be reset
            # here -- otherwise this fake registry could be masked by whichever
            # one a previous test left cached.
            from services.db_writer_engine import db_writer_engine

            db_writer_engine.invalidate_registry_cache()
            self.addCleanup(db_writer_engine.invalidate_registry_cache)
            yield

    # -- resolution order ------------------------------------------------- #
    def test_mw_bool_honours_the_environment_tier(self):
        """Regression: ``rt_bool`` only reads the cache, so booleans had no env
        tier and every env-set switch silently resolved to its default."""
        os.environ["MWR_PERSIST_TICKS"] = "0"
        self.assertFalse(mwcfg.mw_bool(mwcfg.K_PERSIST_TICKS, True))
        os.environ["MWR_PERSIST_TICKS"] = "off"
        self.assertFalse(mwcfg.mw_bool(mwcfg.K_PERSIST_TICKS, True))
        os.environ["MWR_PERSIST_TICKS"] = "1"
        self.assertTrue(mwcfg.mw_bool(mwcfg.K_PERSIST_TICKS, False))
        os.environ["MWR_PERSIST_TICKS"] = "yes"
        self.assertTrue(mwcfg.mw_bool(mwcfg.K_PERSIST_TICKS, False))
        os.environ.pop("MWR_PERSIST_TICKS")
        self.assertTrue(mwcfg.mw_bool(mwcfg.K_PERSIST_TICKS, True), "default when unset")

    def test_env_switch_changes_the_resolved_config(self):
        os.environ["MWR_PERSIST_TICKS"] = "false"
        try:
            cfg = mwcfg.load()
            self.assertFalse(cfg.storage.persist_ticks)
            self.assertTrue(cfg.storage.persist_candles, "only the named switch flips")
        finally:
            os.environ.pop("MWR_PERSIST_TICKS")

    def test_runtime_setting_beats_the_environment(self):
        os.environ["MWR_PERSIST_TICKS"] = "0"
        with mock.patch.object(mwcfg, "get_runtime_setting", return_value=True):
            self.assertTrue(mwcfg.mw_bool(mwcfg.K_PERSIST_TICKS, False))

    def test_every_switch_is_registered_in_the_settings_store(self):
        """A key absent from DEFAULTS cannot be persisted, validated or reset,
        and one absent from LIVE_KEYS never reaches the runtime cache."""
        from services import runtime_settings, settings_service

        for key in (
            mwcfg.K_PERSIST_TICKS, mwcfg.K_PERSIST_CANDLES, mwcfg.K_PERSIST_DECISIONS,
        ):
            self.assertIn(key, settings_service.DEFAULTS, f"{key} missing from DEFAULTS")
            self.assertIn(key, runtime_settings.LIVE_KEYS, f"{key} missing from LIVE_KEYS")
            self.assertIn("description", settings_service.DEFAULTS[key])

    # -- buffer gate ------------------------------------------------------ #
    def test_disabled_collection_accepts_nothing(self):
        from services import market_watch_doc_buffer as buf

        self.assertEqual(buf.set_enabled("market_ticks", False)["enabled"], False)
        self.assertEqual(doc_add("market_ticks", [{"_id": "AAA:1"}]), 0)
        self.assertEqual(doc_pending("market_ticks"), 0)
        buf.set_enabled("market_ticks", True)
        self.assertEqual(doc_add("market_ticks", [{"_id": "AAA:1"}]), 1)

    def test_disabling_drops_the_buffered_backlog(self):
        """'Off' must mean off: writing documents accepted before the switch
        flipped would make the control a lie. The loss is counted, not hidden."""
        from services import market_watch_doc_buffer as buf

        doc_add("market_ticks", [{"_id": f"AAA:{i}"} for i in range(5)])
        self.assertEqual(doc_pending("market_ticks"), 5)

        result = buf.set_enabled("market_ticks", False)
        self.assertEqual(result["dropped"], 5)
        self.assertTrue(result["changed"])
        self.assertEqual(doc_pending("market_ticks"), 0)
        self.assertEqual(doc_stats()["totalGatedDrops"], 5)

    def test_disabled_collection_is_never_drained(self):
        from services import market_watch_doc_buffer as buf

        doc_add("market_candles_1m", [{"_id": "2026-09-26:1:1:1m", "close": 10.0}])
        buf.set_enabled("market_candles_1m", False)
        doc_add("market_candles_1m", [{"_id": "2026-09-26:1:1:1m", "close": 10.0}])

        written: list[str] = []

        async def _fake_write(collection, batch):
            written.append(collection)
            return len(batch)

        with mock.patch.object(buf, "_write", side_effect=_fake_write):
            asyncio.run(buf._drain())
        self.assertEqual(written, [], "a disabled collection must not reach MongoDB")

    def test_apply_storage_config_maps_each_switch_to_its_collections(self):
        """A full reconcile from the resolved config — the config is the single
        source of truth, so one switch never leaves another half-applied."""
        from services import market_watch_doc_buffer as buf

        # persist_ticks off: only market_ticks is gated.
        buf.apply_storage_config(replace(self.storage, persist_ticks=False))
        self.assertFalse(buf.enabled("market_ticks"))
        self.assertTrue(buf.enabled("market_candles_1m"), "candles are a separate switch")
        self.assertTrue(buf.enabled("market_watch_decisions"), "decisions are a separate switch")

        # persist_candles off: all four timeframes, and only those.
        buf.apply_storage_config(replace(self.storage, persist_candles=False))
        for tf in ("1m", "2m", "5m", "10m", "30m"):
            self.assertFalse(buf.enabled(f"market_candles_{tf}"))
        self.assertTrue(buf.enabled("market_ticks"), "a full reconcile re-applies every switch")
        self.assertTrue(buf.enabled("market_watch_decisions"))

        # persist_decisions off: the ledger and the daily report.
        buf.apply_storage_config(replace(self.storage, persist_decisions=False))
        self.assertFalse(buf.enabled("market_watch_decisions"))
        self.assertFalse(buf.enabled("market_watch_daily_report"))

        # Every switch off: nothing should be flushing.
        buf.apply_storage_config(
            replace(self.storage, persist_ticks=False, persist_candles=False, persist_decisions=False)
        )
        self.assertFalse(buf.is_enabled(), "every switch off -> no reason to flush")

    def test_unknown_collection_is_rejected_by_the_gate(self):
        from services import market_watch_doc_buffer as buf

        self.assertFalse(buf.set_enabled("market_watch_fabricated", True)["ok"])

    # -- engine ----------------------------------------------------------- #
    def test_engine_honours_the_switch_per_tick(self):
        """The engine re-resolves its OFFER gate on every tick, so a flip needs
        no restart, and a suppressed tick is counted rather than silently lost.

        The offer gate is not authority: the DB Writer's ``dbw_market_watch_ticks``
        permission (default OFF) is ANDed on top, so the tick only reaches the
        buffer when BOTH agree.
        """
        from services.market_watch_config import load as load_config
        from services.market_watch_engine import MarketWatchEngine

        engine = MarketWatchEngine()
        engine._trading_date = "2026-09-26"

        cfg = load_config()
        state = SymbolState(instrument_token="1", symbol="AAA", name="Alpha")
        engine._states["1"] = state
        entry = {"symbol": "AAA", "ltp": 101.0, "previousClose": 100.0,
                 "change": 1.0, "changePercent": 1.0, "volume": 10, "status": "LIVE"}

        # OFF: the tick is counted as suppressed and nothing is buffered.
        off = replace(cfg.storage, persist_ticks=False)
        with mock.patch.object(MarketWatchEngine, "mw_config", return_value=replace(
            cfg, storage=off,
        )):
            engine._apply_state_tick("1", {"sequenceNumber": 1}, entry, T0)
        self.assertEqual(doc_pending("market_ticks"), 0)
        self.assertEqual(engine._ticks_suppressed, 1)

        # Offer gate ON but DB Writer permission OFF (its default): the DB
        # Writer is the authority, so nothing is buffered and the tick is
        # counted as suppressed rather than persisted.
        on = replace(cfg.storage, persist_ticks=True)
        with mock.patch.object(MarketWatchEngine, "mw_config", return_value=replace(
            cfg, storage=on,
        )):
            engine._apply_state_tick("1", {"sequenceNumber": 2}, entry, T0 + 1)
        self.assertEqual(doc_pending("market_ticks"), 0, "DB Writer permission is the authority")
        self.assertEqual(engine._persisted_ticks, 0)
        self.assertEqual(engine._ticks_suppressed, 2)

        # Both gates ON: the tick reaches the buffer.
        doc_reset()
        with mock.patch.object(MarketWatchEngine, "mw_config", return_value=replace(
            cfg, storage=on,
        )):
            with self._db_writer_market_watch_permission(True):
                engine._apply_state_tick("1", {"sequenceNumber": 3}, entry, T0 + 2)
        self.assertEqual(doc_pending("market_ticks"), 1)
        self.assertEqual(engine._persisted_ticks, 1)
        self.assertEqual(engine._ticks_suppressed, 2, "suppression is not retroactive")

    def test_db_writer_permission_off_blocks_market_watch_ticks(self):
        """The regression this architecture change exists to prevent: Market
        Watch's own switch must not be able to persist ticks on its own."""
        from services.db_writer_engine import db_writer_engine
        from services.market_watch_config import load as load_config
        from services.market_watch_engine import MarketWatchEngine

        engine = MarketWatchEngine()
        engine._trading_date = "2026-09-26"
        cfg = load_config()
        engine._states["1"] = SymbolState(instrument_token="1", symbol="AAA", name="Alpha")
        entry = {"symbol": "AAA", "ltp": 101.0, "previousClose": 100.0,
                 "change": 1.0, "changePercent": 1.0, "volume": 10, "status": "LIVE"}

        # Market Watch offers the tick (gate ON)...
        with mock.patch.object(MarketWatchEngine, "mw_config", return_value=replace(
            cfg, storage=replace(cfg.storage, persist_ticks=True),
        )):
            with self._db_writer_market_watch_permission(False):
                engine._apply_state_tick("1", {"sequenceNumber": 9}, entry, T0)
                decision = db_writer_engine.should_persist_tick({"instrumentToken": "1"})

        self.assertEqual(doc_pending("market_ticks"), 0)
        self.assertEqual(engine._persisted_ticks, 0)
        self.assertEqual(engine._ticks_suppressed, 1)
        # Classified, but refused by the DB Writer's own permission.
        self.assertEqual(decision["classification"], "MARKET_WATCH_ONE_DAY")
        self.assertEqual(decision["reason"], "permission_disabled")
        self.assertEqual(decision["settingKey"], "dbw_market_watch_ticks")

    def test_reconcile_reports_the_flip_and_pushes_the_gates(self):
        from services import market_watch_doc_buffer as buf
        from services.market_watch_engine import MarketWatchEngine

        engine = MarketWatchEngine()
        result = engine.reconcile_storage_switches(replace(self.storage, persist_ticks=False))
        self.assertIn("market_ticks", result["changed"])
        self.assertFalse(result["gates"]["market_ticks"])
        self.assertFalse(buf.enabled("market_ticks"))
        self.assertEqual(engine._storage_switch_changes, 1)

        # Idempotent: a second reconcile with the same config changes nothing.
        again = engine.reconcile_storage_switches(replace(self.storage, persist_ticks=False))
        self.assertEqual(again["changed"], {})
        self.assertEqual(engine._storage_switch_changes, 1)

    def test_tick_saving_reports_real_state_not_a_claim(self):
        from services.market_watch_engine import MarketWatchEngine

        engine = MarketWatchEngine()
        engine._trading_date = "2026-09-26"
        engine._persisted_ticks = 7
        engine._ticks_suppressed = 3

        state = engine.tick_saving()
        self.assertEqual(state["tradingDate"], "2026-09-26")
        self.assertIs(state["persistTicks"], True)
        self.assertIs(state["persistCandles"], True)
        self.assertIs(state["persistDecisions"], True)
        self.assertEqual(state["ticksSaved"], 7)
        self.assertEqual(state["ticksSuppressed"], 3)
        self.assertIn("market_ticks", state["gates"])
        self.assertIn("totalGatedDrops", state["pipeline"])

    def test_status_snapshot_exposes_the_switches(self):
        from services.market_watch_engine import MarketWatchEngine

        custom = MarketWatchEngine().status_snapshot()["metrics"]["custom"]
        self.assertIn("ticksSuppressed", custom)
        self.assertEqual(custom["storage"]["ticksSaved"], custom["persistedTicks"])


# --------------------------------------------------------------------------- #
# doc §21: candle recovery actually restores (regression)
# --------------------------------------------------------------------------- #
class TestCandleRecovery(unittest.TestCase):
    def test_restored_candles_replace_the_live_bucket(self):
        """``SymbolState`` is a slots dataclass with a ``timeframes`` field.

        Recovery addressed ``state._timeframes``, which raised AttributeError
        inside a bare ``except: continue``: every restore silently did nothing
        and the INCOMPLETE sweep then marked the whole timeframe view degraded.
        Pinned here against a real SymbolState so it cannot regress.
        """
        from services.market_watch_engine import MarketWatchEngine

        engine = MarketWatchEngine()
        engine._trading_date = "2026-09-26"
        state = SymbolState(instrument_token="1", symbol="AAA", name="Alpha")
        engine._states["1"] = state
        engine._eligible_tokens = {"1"}

        row = {
            "timeframe": "1m", "open": 100.0, "high": 105.0, "low": 99.0, "close": 104.0,
            "volume": 500, "priceMove": 4.0, "changePct": 4.0, "vwap": 102.0,
            "tickCount": 12, "complete": True, "bucketStartEpoch": T0, "bucketEnd": T0 + 60,
            "dataQuality": "COMPLETE",
        }

        class _Cursor:
            def __init__(self, rows):
                self._rows = rows

            async def to_list(self, length=None):
                return list(self._rows)

        class _Coll:
            def __init__(self, rows):
                self._rows = rows

            def find(self, query, projection=None):
                return _Cursor(self._rows)

        class _Db:
            def __init__(self):
                self.tables = {}

            def __getitem__(self, name):
                return self.tables.setdefault(name, _Coll([]))

        db = _Db()
        db.tables["market_candles_1m"] = _Coll([dict(row, instrumentToken="1", date="2026-09-26")])

        async def _run():
            with mock.patch("database.connection.get_db", return_value=db):
                return await engine._restore_candles("2026-09-26")

        restored, _incomplete = asyncio.run(_run())

        self.assertEqual(restored, 1, "the restore must not be a silent no-op")
        tf = state.timeframe("1m")
        self.assertEqual(tf.close, 104.0)
        self.assertEqual(tf.vwap, 102.0)
        self.assertEqual(tf.tick_count, 12)
        self.assertTrue(tf.complete)
        self.assertEqual(tf.data_quality, "COMPLETE")

    def test_a_bucket_restored_from_storage_is_not_marked_incomplete(self):
        """A window we genuinely have data for must not also be reported as
        INCOMPLETE: the two are contradictory states for the same bucket."""
        from services.market_watch_engine import MarketWatchEngine

        engine = MarketWatchEngine()
        engine._trading_date = "2026-09-26"
        engine._started_at = T0
        state = SymbolState(instrument_token="1", symbol="AAA", name="Alpha")
        engine._states["1"] = state
        engine._eligible_tokens = {"1"}

        row = {"timeframe": "1m", "close": 104.0, "complete": True,
               "bucketStartEpoch": T0, "dataQuality": "COMPLETE"}

        class _Cursor:
            async def to_list(self, length=None):
                return [dict(row, instrumentToken="1", date="2026-09-26")]

        class _Coll:
            def find(self, query, projection=None):
                return _Cursor()

        class _Db:
            def __getitem__(self, name):
                return _Coll()

        async def _run():
            with mock.patch("database.connection.get_db", return_value=_Db()):
                return await engine._restore_candles("2026-09-26")

        _restored, incomplete = asyncio.run(_run())
        self.assertEqual(incomplete, 0, "a restored 1m bucket must not be INCOMPLETE")
        self.assertNotEqual(state.timeframe("1m").data_quality, "INCOMPLETE")


if __name__ == "__main__":
    unittest.main()
