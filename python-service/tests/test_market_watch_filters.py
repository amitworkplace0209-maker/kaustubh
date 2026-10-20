"""Unit tests for the Market Watch filter module (services/market_watch_filters).

A filter is a validated list of criteria over real engine fields. These tests
cover the catalog, criteria validation/normalization, AND-semantics application
and the "no fabricated data" rule: a row missing a field fails that criterion
naturally and is never given a synthetic pass.

Run:  python -m pytest tests/test_market_watch_filters.py -q
"""
from __future__ import annotations

import os
import sys
import unittest

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from services.market_watch_filters import (  # noqa: E402
    FILTER_CATALOG,
    apply_filters,
    catalog,
    validate_criteria,
    validate_filter_document,
)


def _row(**overrides) -> dict:
    base = {
        "token": "1",
        "symbol": "HDFCBANK",
        "exchange": "nse_cm",
        "segment": "EQUITY",
        "ltp": 1650.0,
        "changePercent": 1.5,
        "volume": 2_500_000,
        "oi": 35000,
        "spread": 0.25,
        "tradedValue": 4.1e9,
        "fiveMinPercent": 0.4,
        "tenMinPercent": 0.7,
        "status": "LIVE",
    }
    base.update(overrides)
    return base


class CatalogTest(unittest.TestCase):
    def test_all_keys_present_in_order(self):
        entries = catalog()
        self.assertEqual(
            [e["key"] for e in entries],
            list(FILTER_CATALOG.keys()),
        )
        for e in entries:
            self.assertIn("label", e)
            self.assertIn("type", e)

    def test_enum_entries_expose_options(self):
        by_key = {e["key"]: e for e in catalog()}
        self.assertIn("LIVE", by_key["freshness"]["options"])
        self.assertIn("nse_cm", by_key["exchange"]["options"])
        self.assertIn("EQUITY", by_key["segment"]["options"])

    def test_range_entries_have_no_options(self):
        by_key = {e["key"]: e for e in catalog()}
        self.assertNotIn("options", by_key["ltp"])


class ValidateCriteriaTest(unittest.TestCase):
    def test_empty_criteria_ok(self):
        ok, reason, normalized = validate_criteria(None)
        self.assertTrue(ok)
        self.assertEqual(normalized, [])
        ok, _, _ = validate_criteria([])
        self.assertTrue(ok)

    def test_non_list_rejected(self):
        ok, reason, _ = validate_criteria({"key": "ltp"})
        self.assertFalse(ok)
        self.assertIn("list", reason)

    def test_unknown_key_rejected(self):
        ok, reason, _ = validate_criteria([{"key": "trend", "op": "gte", "value": 1}])
        self.assertFalse(ok)
        self.assertIn("unknown filter key", reason)

    def test_bad_op_rejected(self):
        ok, reason, _ = validate_criteria([{"key": "ltp", "op": "approx", "value": 100}])
        self.assertFalse(ok)
        self.assertIn("invalid op", reason)

    def test_numeric_coercion(self):
        ok, _, normalized = validate_criteria([{"key": "ltp", "op": "gte", "value": "100"}])
        self.assertTrue(ok)
        self.assertEqual(normalized, [{"key": "ltp", "op": "gte", "value": 100.0}])

    def test_between_requires_pair(self):
        ok, reason, _ = validate_criteria([{"key": "change_pct", "op": "between", "value": [1]}])
        self.assertFalse(ok)
        self.assertIn("between needs [min, max]", reason)

    def test_between_swapped_bounds_rejected(self):
        ok, reason, _ = validate_criteria([{"key": "change_pct", "op": "between", "value": [5, 1]}])
        self.assertFalse(ok)

    def test_between_normalized(self):
        ok, _, normalized = validate_criteria(
            [{"key": "change_pct", "op": "between", "value": [1.0, "5"]}]
        )
        self.assertTrue(ok)
        self.assertEqual(normalized[0]["value"], [1.0, 5.0])

    def test_enum_value_list_required(self):
        ok, reason, _ = validate_criteria([{"key": "exchange", "op": "in", "value": []}])
        self.assertFalse(ok)
        self.assertIn("value list", reason)

    def test_enum_single_string_coerced(self):
        ok, _, normalized = validate_criteria(
            [{"key": "exchange", "op": "in", "value": "nse_cm"}]
        )
        self.assertTrue(ok)
        self.assertEqual(normalized[0]["value"], ["nse_cm"])

    def test_text_requires_query(self):
        ok, reason, _ = validate_criteria([{"key": "symbol", "op": "contains", "value": "  "}])
        self.assertFalse(ok)
        self.assertIn("non-empty query", reason)

    def test_minimum_op_whitelist(self):
        ok, reason, _ = validate_criteria([{"key": "liquidity", "op": "lt", "value": 1000}])
        self.assertFalse(ok)


class ApplyFiltersTest(unittest.TestCase):
    def test_no_criteria_returns_all(self):
        rows = [_row(), _row(token="2", symbol="TCS", changePercent=-0.2)]
        self.assertEqual(apply_filters(rows, None), rows)
        self.assertEqual(apply_filters(rows, []), rows)

    def test_range_gte(self):
        rows = [_row(), _row(token="2", symbol="TCS", ltp=120.0)]
        out = apply_filters(rows, [{"key": "ltp", "op": "gte", "value": 1000}])
        self.assertEqual([r["symbol"] for r in out], ["HDFCBANK"])

    def test_between_inclusive(self):
        rows = [
            _row(token="1", symbol="A", changePercent=1.0),
            _row(token="2", symbol="B", changePercent=5.0),
            _row(token="3", symbol="C", changePercent=15.0),
        ]
        out = apply_filters(rows, [{"key": "change_pct", "op": "between", "value": [0, 10]}])
        self.assertEqual([r["symbol"] for r in out], ["A", "B"])

    def test_and_semantics(self):
        rows = [
            _row(token="1", symbol="A", ltp=100.0, changePercent=8.0),
            _row(token="2", symbol="B", ltp=100.0, changePercent=3.0),
        ]
        out = apply_filters(rows, [
            {"key": "ltp", "op": "gte", "value": 50},
            {"key": "change_pct", "op": "gte", "value": 5},
        ])
        self.assertEqual([r["symbol"] for r in out], ["A"])

    def test_enum_in(self):
        rows = [
            _row(token="1", symbol="A", status="LIVE"),
            _row(token="2", symbol="B", status="STALE"),
        ]
        out = apply_filters(rows, [{"key": "freshness", "op": "in", "value": ["LIVE"]}])
        self.assertEqual([r["symbol"] for r in out], ["A"])

    def test_enum_neq(self):
        rows = [
            _row(token="1", symbol="A", status="LIVE"),
            _row(token="2", symbol="B", status="STALE"),
        ]
        out = apply_filters(rows, [{"key": "freshness", "op": "neq", "value": ["LIVE"]}])
        self.assertEqual([r["symbol"] for r in out], ["B"])

    def test_text_contains_case_insensitive(self):
        rows = [_row(token="1", symbol="HDFCBANK"), _row(token="2", symbol="TCS")]
        out = apply_filters(rows, [{"key": "symbol", "op": "contains", "value": "hdfc"}])
        self.assertEqual([r["symbol"] for r in out], ["HDFCBANK"])

    def test_missing_field_fails_criterion_naturally(self):
        # NO_DATA row has no ltp/volume/changePercent -> every numeric criterion
        # must reject it; it must never be fabricated into a pass.
        rows = [
            _row(token="1", symbol="A"),
            {"token": "2", "symbol": "NODATA", "exchange": "nse_cm", "segment": "EQUITY"},
        ]
        for criteria in (
            [{"key": "ltp", "op": "gte", "value": 1}],
            [{"key": "volume", "op": "between", "value": [1, 1e12]}],
            [{"key": "change_pct", "op": "lt", "value": 99}],
        ):
            out = apply_filters(rows, criteria)
            self.assertEqual([r["symbol"] for r in out], ["A"])

    def test_invalid_criteria_returns_empty(self):
        out = apply_filters([_row()], [{"key": "bogus", "op": "gte", "value": 1}])
        self.assertEqual(out, [])


class ValidateFilterDocumentTest(unittest.TestCase):
    def test_name_required(self):
        ok, reason, _ = validate_filter_document({"criteria": []})
        self.assertFalse(ok)
        self.assertIn("name", reason)

    def test_valid_document_normalized(self):
        ok, _, doc = validate_filter_document({
            "name": "  Liquidity  ",
            "description": "High turnover",
            "criteria": [{"key": "ltp", "op": "gte", "value": "1000"}],
            "limit": 250,
        })
        self.assertTrue(ok)
        self.assertEqual(doc["name"], "Liquidity")
        self.assertEqual(doc["limit"], 250)
        self.assertEqual(doc["criteria"][0]["value"], 1000.0)

    def test_limit_clamped(self):
        _, _, doc = validate_filter_document({"name": "x", "criteria": [], "limit": 5000})
        self.assertEqual(doc["limit"], 1000)
        _, _, doc2 = validate_filter_document({"name": "x", "criteria": [], "limit": 0})
        self.assertEqual(doc2["limit"], 1)
        _, _, doc3 = validate_filter_document({"name": "x", "criteria": [], "limit": "abc"})
        self.assertEqual(doc3["limit"], 100)

    def test_bad_criteria_fails_document(self):
        ok, reason, _ = validate_filter_document({"name": "x", "criteria": [{"key": "nope"}]})
        self.assertFalse(ok)


if __name__ == "__main__":
    unittest.main()