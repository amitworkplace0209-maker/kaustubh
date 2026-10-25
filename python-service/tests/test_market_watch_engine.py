"""Unit tests for Market Watch engine correctness rules (broker-free logic).

Covers the "Absolute Rule" — unknown circuit data must NEVER be reported as
SAFE — plus direction-aware filtering, circuit proximity/hit detection and
normalization. Run with:  python -m unittest tests.test_market_watch_engine
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.market_watch_engine import (  # noqa: E402
    CIRCUIT_SAFE,
    CIRCUIT_UNKNOWN,
    CIRCUIT_UPPER_HIT,
    CIRCUIT_LOWER_HIT,
    CIRCUIT_NEAR_UPPER,
    CIRCUIT_NEAR_LOWER,
    INTRADAY_SUPPORTED,
    INTRADAY_NOT_SUPPORTED,
    INTRADAY_UNKNOWN,
    TRADING_AVAILABLE,
    TRADING_NOT_AVAILABLE,
    TRADING_SUSPENDED,
    TRADING_INACTIVE,
    TRADING_CLOSED,
    TRADING_RESTRICTED_STATE,
    TRADING_UNKNOWN,
    evaluate_circuit_safety,
    evaluate_intraday_eligibility,
    evaluate_trading_eligibility,
    normalize_quote,
    passes_filters,
    circuit_excludes,
    max_change_eligible,
)


class CircuitSafetyTest(unittest.TestCase):
    def test_upper_hit(self):
        # Test: upper=100, lower=80, LTP=100 -> UPPER_HIT, excluded
        r = evaluate_circuit_safety(
            {"ltp": 100, "upperCircuit": 100, "lowerCircuit": 80},
            settings={"enabled": True, "bufferPct": 2},
        )
        self.assertEqual(r["status"], CIRCUIT_UPPER_HIT)
        self.assertTrue(r["isUpperCircuitHit"])
        self.assertTrue(circuit_excludes(r))

    def test_lower_hit(self):
        r = evaluate_circuit_safety(
            {"ltp": 80, "upperCircuit": 100, "lowerCircuit": 80},
            settings={"enabled": True, "bufferPct": 2},
        )
        self.assertEqual(r["status"], CIRCUIT_LOWER_HIT)
        self.assertTrue(r["isLowerCircuitHit"])
        self.assertTrue(circuit_excludes(r))

    def test_near_upper_within_buffer(self):
        # upper=100, LTP=99, buffer=2 -> NEAR_UPPER, excluded
        r = evaluate_circuit_safety(
            {"ltp": 99, "upperCircuit": 100, "lowerCircuit": 80},
            settings={"enabled": True, "bufferPct": 2},
        )
        self.assertEqual(r["status"], CIRCUIT_NEAR_UPPER)
        # distance uses boundary denominator: (100-99)/100 = 1%
        self.assertAlmostEqual(r["distanceToUpperPct"], 1.0, places=4)
        self.assertTrue(r["isNearUpperCircuit"])
        self.assertTrue(circuit_excludes(r))

    def test_safe_beyond_buffer(self):
        # upper=100, LTP=97, buffer=2 -> SAFE, distance 3%, allowed
        r = evaluate_circuit_safety(
            {"ltp": 97, "upperCircuit": 100, "lowerCircuit": 80},
            settings={"enabled": True, "bufferPct": 2},
        )
        self.assertEqual(r["status"], CIRCUIT_SAFE)
        self.assertAlmostEqual(r["distanceToUpperPct"], 3.0, places=4)
        self.assertFalse(circuit_excludes(r))

    def test_near_lower(self):
        # lower=80, LTP=81, buffer=2 -> NEAR_LOWER
        r = evaluate_circuit_safety(
            {"ltp": 81, "upperCircuit": 100, "lowerCircuit": 80},
            settings={"enabled": True, "bufferPct": 2},
        )
        self.assertEqual(r["status"], CIRCUIT_NEAR_LOWER)
        self.assertAlmostEqual(r["distanceToLowerPct"], 1.25, places=4)
        self.assertTrue(r["isNearLowerCircuit"])
        self.assertTrue(circuit_excludes(r))

    def test_missing_circuit_never_safe(self):
        # upper=null, lower=null -> UNKNOWN, excluded when safety ON
        r = evaluate_circuit_safety(
            {"ltp": 100, "upperCircuit": None, "lowerCircuit": None},
            settings={"enabled": True, "bufferPct": 2},
        )
        self.assertEqual(r["status"], CIRCUIT_UNKNOWN)
        self.assertFalse(r["circuitDataAvailable"])
        self.assertTrue(circuit_excludes(r))

    def test_missing_circuit_with_safety_off_reports_unknown_not_safe(self):
        # Even with the filter OFF, missing data must be UNKNOWN, never SAFE.
        r = evaluate_circuit_safety(
            {"ltp": 100, "upperCircuit": None, "lowerCircuit": None},
            settings={"enabled": False, "bufferPct": 2},
        )
        self.assertEqual(r["status"], CIRCUIT_UNKNOWN)
        self.assertFalse(r["circuitDataAvailable"])

    def test_null_ltp(self):
        r = evaluate_circuit_safety(
            {"ltp": None, "upperCircuit": 100, "lowerCircuit": 80},
            settings={"enabled": True, "bufferPct": 2},
        )
        self.assertEqual(r["status"], CIRCUIT_UNKNOWN)
        self.assertTrue(circuit_excludes(r))

    def test_near_upper_boundary_case(self):
        # boundary denominator example from spec: upper=100, LTP=98 -> distance 2%
        r = evaluate_circuit_safety(
            {"ltp": 98, "upperCircuit": 100, "lowerCircuit": 70},
            settings={"enabled": True, "bufferPct": 2},
        )
        self.assertAlmostEqual(r["distanceToUpperPct"], 2.0, places=4)
        # At exactly the buffer boundary we are NEAR (<= buffer) and excluded.
        self.assertEqual(r["status"], CIRCUIT_NEAR_UPPER)
        self.assertTrue(circuit_excludes(r))

    def test_invalid_bounds_unknown(self):
        r = evaluate_circuit_safety(
            {"ltp": 50, "upperCircuit": 80, "lowerCircuit": 90},  # upper < lower invalid
            settings={"enabled": True, "bufferPct": 2},
        )
        self.assertEqual(r["status"], CIRCUIT_UNKNOWN)
        self.assertTrue(circuit_excludes(r))


class IntradayEligibilityTest(unittest.TestCase):
    def test_mis_session_and_quote_eligible(self):
        r = evaluate_intraday_eligibility(
            {}, {"misAvailable": True}, ["MIS", "CNC"],
        )
        self.assertTrue(r["eligible"])
        self.assertEqual(r["product"], "MIS")
        self.assertEqual(r["reason"], INTRADAY_SUPPORTED)

    def test_no_mis_product(self):
        r = evaluate_intraday_eligibility(
            {}, {"misAvailable": True}, ["CNC"],
        )
        self.assertFalse(r["eligible"])
        self.assertEqual(r["reason"], INTRADAY_NOT_SUPPORTED)

    def test_no_session_unknown_not_eligible(self):
        r = evaluate_intraday_eligibility(
            {}, {"misAvailable": True}, [],
        )
        self.assertFalse(r["eligible"])
        self.assertEqual(r["reason"], INTRADAY_UNKNOWN)

    def test_quote_mis_false_not_eligible(self):
        r = evaluate_intraday_eligibility(
            {}, {"misAvailable": False}, ["MIS"],
        )
        self.assertFalse(r["eligible"])

    def test_inactive_not_eligible(self):
        r = evaluate_intraday_eligibility(
            {"tradingStatus": "INACTIVE"}, {"misAvailable": True}, ["MIS"],
        )
        self.assertFalse(r["eligible"])
        self.assertEqual(r["reason"], "INSTRUMENT_INACTIVE")

    def test_account_margin_confirms_eligible_without_products(self):
        r = evaluate_intraday_eligibility({}, {}, [], account_intraday=True)
        self.assertTrue(r["eligible"])
        self.assertEqual(r["product"], "MIS")
        self.assertEqual(r["reason"], INTRADAY_SUPPORTED)
        self.assertEqual(r["basis"], "account")

    def test_account_confirm_overridden_by_quote_false(self):
        r = evaluate_intraday_eligibility({}, {"misAvailable": False}, [], account_intraday=True)
        self.assertFalse(r["eligible"])
        self.assertEqual(r["reason"], INTRADAY_NOT_SUPPORTED)


class NormalizeQuoteTest(unittest.TestCase):
    def test_real_field_names(self):
        raw = {
            "last_traded_price": 797.25,
            "open_price": 795.0,
            "high_price": 799.0,
            "low_price": 793.0,
            "close_price": 784.8,
            "volume_traded_today": 1234567,
            "net_change": 12.45,
            "net_change_percent": 1.58,
            "upper_circuit_limit": 860.0,
            "lower_circuit_limit": 710.0,
            "total_traded_value": 9.8e8,
        }
        n = normalize_quote(raw, {"symbol": "RELIANCE"})
        self.assertEqual(n["ltp"], 797.25)
        self.assertEqual(n["open"], 795.0)
        self.assertEqual(n["high"], 799.0)
        self.assertEqual(n["low"], 793.0)
        self.assertEqual(n["previousClose"], 784.8)
        self.assertEqual(n["volume"], 1234567)
        self.assertEqual(n["change"], 12.45)
        self.assertEqual(n["changePercent"], 1.58)
        self.assertEqual(n["upperCircuit"], 860.0)
        self.assertEqual(n["lowerCircuit"], 710.0)
        self.assertEqual(n["turnover"], 9.8e8)

    def test_null_values_stay_null(self):
        n = normalize_quote({"ltp": 100}, {})
        self.assertIsNone(n["changePercent"])
        self.assertIsNone(n["upperCircuit"])
        self.assertIsNone(n["lowerCircuit"])


class DirectionalFilterTest(unittest.TestCase):
    def _row(self, change, pct, mom=0.0, symbol="X"):
        return {
            "change": change, "changePercent": pct,
            "momentum": {"5m": mom}, "symbol": symbol,
            "tradingSymbol": symbol, "companyName": "", "token": "1", "isin": "",
        }

    def test_gainers_positive(self):
        r = self._row(5, 1.0, mom=1.0)
        self.assertTrue(passes_filters(
            r, direction="gainers", window="5m",
            rupee_min=5, pct_min=1, mom_min=1,
        ))
        # fails % filter
        self.assertFalse(passes_filters(
            self._row(5, 0.5, mom=1.0), direction="gainers", window="5m", pct_min=1,
        ))

    def test_losers_direction_aware(self):
        # Loser losing 5 rupees, -1%, 5m -1% must pass "min loss" filters.
        r = self._row(-5, -1.0, mom=-1.0)
        self.assertTrue(passes_filters(
            r, direction="losers", window="5m",
            rupee_min=5, pct_min=1, mom_min=1,
        ))
        # A loser losing 3 rupees must FAIL a min loss of 5 (change <= -5).
        self.assertFalse(passes_filters(
            self._row(-3, -0.5, mom=-0.5), direction="losers", window="5m", rupee_min=5,
        ))
        # A gainer must not appear as a loser.
        self.assertFalse(passes_filters(self._row(5, 1.0), direction="losers", window="5m"))

    def test_losers_momentum_direction(self):
        # Loser with -2% 5m should fail a momentum min of 1 (needs <= -1).
        self.assertFalse(passes_filters(
            self._row(-5, -1.0, mom=2.0), direction="losers", window="5m", mom_min=1,
        ))
        self.assertTrue(passes_filters(
            self._row(-5, -1.5, mom=-2.0), direction="losers", window="5m", pct_min=1, mom_min=1,
        ))

    def test_search_symbol(self):
        r = self._row(5, 1.0, symbol="RELIANCE")
        self.assertTrue(passes_filters(r, direction="gainers", window="5m", q="RELIANCE"))
        self.assertFalse(passes_filters(r, direction="gainers", window="5m", q="TCS"))

    def test_all_direction_absolute(self):
        self.assertTrue(passes_filters(self._row(-5, -1.0), direction="all", window="5m", rupee_min=5, pct_min=1))
        self.assertTrue(passes_filters(self._row(5, 1.0), direction="all", window="5m", rupee_min=5, pct_min=1))


class MaxChangeLimitTest(unittest.TestCase):
    """Server-side daily-change cap: abs(changePercent) > max => excluded."""

    def test_over_limit_excluded(self):
        # TBZ-like +19.99% with an 18% cap must be EXCLUDED.
        self.assertFalse(max_change_eligible(19.99, 18))

    def test_at_limit_eligible(self):
        self.assertTrue(max_change_eligible(18.0, 18))

    def test_under_limit_eligible(self):
        self.assertTrue(max_change_eligible(17.99, 18))
        self.assertTrue(max_change_eligible(-15.0, 18))

    def test_negative_magnitude_respected(self):
        # A -19% loser is also excluded.
        self.assertFalse(max_change_eligible(-19.0, 18))

    def test_unknown_change_with_limit_excluded(self):
        # If the change is unknown while a limit is configured, do not pass.
        self.assertFalse(max_change_eligible(None, 18))

    def test_no_limit_always_eligible(self):
        self.assertTrue(max_change_eligible(999.0, None))
        self.assertTrue(max_change_eligible(None, None))


class TradingEligibilityTest(unittest.TestCase):
    def test_active_available(self):
        r = evaluate_trading_eligibility({"tradingStatus": "ACTIVE"})
        self.assertTrue(r["available"])
        self.assertEqual(r["tradingStatus"], TRADING_AVAILABLE)
        self.assertEqual(r["reason"], "ACTIVE")

    def test_inactive_not_available(self):
        r = evaluate_trading_eligibility({"tradingStatus": "INACTIVE"})
        self.assertFalse(r["available"])
        self.assertEqual(r["tradingStatus"], TRADING_INACTIVE)

    def test_suspended_not_available(self):
        r = evaluate_trading_eligibility({"tradingStatus": "SUSPENDED"})
        self.assertFalse(r["available"])
        self.assertEqual(r["tradingStatus"], TRADING_SUSPENDED)

    def test_restricted_state(self):
        r = evaluate_trading_eligibility({"tradingStatus": "TRADING_RESTRICTED"})
        self.assertFalse(r["available"])
        self.assertEqual(r["tradingStatus"], TRADING_RESTRICTED_STATE)

    def test_closed_market_overrides_active(self):
        r = evaluate_trading_eligibility({"tradingStatus": "ACTIVE"}, market_state="CLOSED")
        self.assertFalse(r["available"])
        self.assertEqual(r["tradingStatus"], TRADING_CLOSED)

    def test_unknown_status_is_honest(self):
        # No status at all => UNKNOWN (never a fake AVAILABLE).
        r = evaluate_trading_eligibility({})
        self.assertEqual(r["tradingStatus"], TRADING_UNKNOWN)

    def test_empty_instrument_no_crash(self):
        r = evaluate_trading_eligibility(None)
        self.assertIn("tradingStatus", r)


class NormalizeOiAndCircuitPercentTest(unittest.TestCase):
    def test_real_field_names(self):
        n = normalize_quote(
            {"last_traded_price": 100, "open_interest": 5000,
             "oi_change": 200, "circuit_percent": 20.0},
            {},
        )
        self.assertEqual(n["oiChange"], 200)
        self.assertEqual(n["circuitPercent"], 20.0)

    def test_null_when_absent(self):
        n = normalize_quote({"ltp": 100}, {})
        self.assertIsNone(n["oiChange"])
        self.assertIsNone(n["circuitPercent"])

    def test_never_invented_from_ltp(self):
        # oiChange / circuitPercent must stay null even when LTP is present.
        n = normalize_quote({"last_traded_price": 100, "high_price": 120}, {})
        self.assertIsNone(n["circuitPercent"])
        self.assertIsNone(n["oiChange"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
