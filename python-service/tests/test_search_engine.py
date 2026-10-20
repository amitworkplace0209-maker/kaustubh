"""Tests for the Search Engine target contract (docs/engines/search-engine.md).

Covers normalization, deterministic ranking, dedupe, live-state enrichment
from the canonical tick store, authoritative-only margin, stale detection and
the scoped search response shape.

Run:  python -m pytest tests/test_search_engine.py -q
"""
from __future__ import annotations

import os
import sys
import time
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from core.engines.search_engine import SearchEngine, normalize_query  # noqa: E402


def _instrument(symbol: str, token: str, name: str = "") -> dict:
    return {
        "symbol": symbol,
        "tradingSymbol": f"{symbol}-EQ",
        "name": name or symbol,
        "token": token,
        "exchange": "NSE",
        "exchangeSegment": "nse_cm",
        "instrumentType": "EQ",
    }


class NormalizeQueryTest(unittest.TestCase):
    def test_empty(self):
        self.assertTrue(normalize_query("   ")["empty"])
        self.assertTrue(normalize_query(None)["empty"])

    def test_trims_and_lowercases(self):
        out = normalize_query("  RELIANCE  ")
        self.assertEqual(out["normalized"], "reliance")
        self.assertEqual(out["original"], "RELIANCE")

    def test_strips_punctuation(self):
        out = normalize_query("M&M!")
        self.assertIn("m&m", out["tokens"])
        self.assertNotIn("!", out["normalized"])

    def test_max_length(self):
        out = normalize_query("a" * 500)
        self.assertLessEqual(len(out["original"]), 64)


class SearchRankingTest(unittest.TestCase):
    def setUp(self):
        self.se = SearchEngine()
        self.se._instruments = [
            _instrument("RELIANCE", "2885", "Reliance Industries"),
            _instrument("REL", "999", "Rel Street Capital"),
            _instrument("HDFCBANK", "1333", "HDFC Bank"),
        ]
        self.se._build_index()

    def test_exact_symbol_ranks_first(self):
        results = self.se.search("REL")
        self.assertEqual(results[0]["symbol"], "REL")

    def test_prefix_match(self):
        results = self.se.search("relia")
        self.assertEqual([r["symbol"] for r in results], ["RELIANCE"])

    def test_empty_query_returns_nothing(self):
        self.assertEqual(self.se.search(""), [])
        self.assertEqual(self.se.search(None), [])

    def test_formatted_identity(self):
        r = self.se.search("RELIANCE")[0]
        self.assertEqual(r["type"], "stock")
        self.assertEqual(r["id"], "NSE:2885")
        self.assertEqual(r["symbol"], "RELIANCE")


class SearchScopedTest(unittest.TestCase):
    def setUp(self):
        self.se = SearchEngine()
        self.se._instruments = [_instrument("RELIANCE", "2885", "Reliance Industries")]
        self.se._build_index()

    def test_empty_query_shape(self):
        out = self.se.search_scoped("", scopes=["stocks"])
        self.assertEqual(out["errorCode"], "EMPTY_QUERY")
        self.assertEqual(out["results"], [])

    def test_no_live_tick_is_unavailable(self):
        with mock.patch("services.tick_buffer.get_latest_ticks", return_value={}):
            out = self.se.search_scoped("reliance", scopes=["stocks"])
        self.assertEqual(out["total"], 1)
        self.assertEqual(out["results"][0]["liveStatus"], "UNAVAILABLE")
        self.assertEqual(out["results"][0]["marginStatus"], "UNAVAILABLE")
        self.assertIsNone(out["results"][0]["oneQtyMargin"])

    def test_live_tick_enrichment(self):
        tick = {
            "ltp": 2500.0, "prevClose": 2400.0, "volume": 1000,
            "receivedAt": time.time(),
        }
        with mock.patch("services.tick_buffer.get_latest_ticks", return_value={"2885": tick}):
            out = self.se.search_scoped("reliance", scopes=["stocks"])
        r = out["results"][0]
        self.assertEqual(r["liveStatus"], "LIVE")
        self.assertEqual(r["ltp"], 2500.0)
        self.assertEqual(r["change"], 100.0)
        self.assertAlmostEqual(r["changePct"], 100.0 / 2400.0 * 100.0, places=3)

    def test_stale_tick_flagged(self):
        tick = {"ltp": 10.0, "receivedAt": time.time() - 120}
        with mock.patch("services.tick_buffer.get_latest_ticks", return_value={"2885": tick}):
            out = self.se.search_scoped("reliance", scopes=["stocks"])
        self.assertEqual(out["results"][0]["liveStatus"], "STALE")

    def test_margin_provider_available(self):
        self.se.set_margin_provider(lambda _r: {"margin": 1234.5, "status": "AVAILABLE"})
        with mock.patch("services.tick_buffer.get_latest_ticks", return_value={}):
            out = self.se.search_scoped("reliance", scopes=["stocks"], with_margin=True)
        r = out["results"][0]
        self.assertEqual(r["oneQtyMargin"], 1234.5)
        self.assertEqual(r["marginStatus"], "AVAILABLE")

    def test_no_margin_provider_never_fabricates(self):
        with mock.patch("services.tick_buffer.get_latest_ticks", return_value={}):
            out = self.se.search_scoped("reliance", scopes=["stocks"], with_margin=True)
        r = out["results"][0]
        self.assertIsNone(r["oneQtyMargin"])
        self.assertEqual(r["marginStatus"], "UNAVAILABLE")

    def test_dedupe_by_exchange_token(self):
        self.se._instruments.append(_instrument("RELIANCE", "2885", "Reliance Industries"))
        self.se._build_index()
        with mock.patch("services.tick_buffer.get_latest_ticks", return_value={}):
            out = self.se.search_scoped("reliance", scopes=["stocks"])
        self.assertEqual(out["total"], 1)


class ProductionTickShapeTest(unittest.TestCase):
    """Regression cover for the shape ``to_storage_doc`` actually produces.

    The canonical tick document stores ``receivedAt``/``ts`` as timezone-aware
    ``datetime`` objects and names the legacy surface ``close``/``change``/
    ``changePercent``/``upper_circuit_limit``. The freshness path used to accept
    only numeric epochs, so STALE was unreachable in production while the
    existing float-based test still passed.
    """

    def setUp(self):
        self.se = SearchEngine()
        self.se._instruments.append(_instrument("RELIANCE", "2885", "Reliance Industries"))
        self.se._build_index()

    def _search(self, tick):
        with mock.patch("services.tick_buffer.get_latest_ticks", return_value={"2885": tick}):
            return self.se.search_scoped("reliance", scopes=["stocks"])["results"][0]

    def test_datetime_received_at_is_detected_as_stale(self):
        tick = {
            "ltp": 1400.0,
            "close": 1380.0,
            "receivedAt": datetime.now(timezone.utc) - timedelta(seconds=120),
        }
        r = self._search(tick)
        self.assertEqual(r["liveStatus"], "STALE")
        self.assertEqual(r["dataStatus"], "STALE")
        self.assertIsNotNone(r["tickAgeSeconds"])
        self.assertGreater(r["tickAgeSeconds"], 60)

    def test_datetime_received_at_is_live_when_fresh(self):
        tick = {"ltp": 1400.0, "receivedAt": datetime.now(timezone.utc)}
        r = self._search(tick)
        self.assertEqual(r["liveStatus"], "LIVE")
        self.assertLess(r["tickAgeSeconds"], 5)

    def test_naive_datetime_received_at_is_read_as_utc(self):
        # Production always writes tz-aware UTC (storage.py::_dt). A naive value
        # is a defensive fallback and is interpreted as UTC.
        naive_utc = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=90)
        self.assertEqual(self._search({"ltp": 1400.0, "receivedAt": naive_utc})["liveStatus"], "STALE")

    def test_ts_field_is_used_when_received_at_missing(self):
        tick = {"ltp": 1400.0, "ts": datetime.now(timezone.utc) - timedelta(seconds=200)}
        self.assertEqual(self._search(tick)["liveStatus"], "STALE")

    def test_epoch_milliseconds_are_normalised(self):
        stale_ms = (time.time() - 300) * 1000
        self.assertEqual(self._search({"ltp": 10.0, "receivedAt": stale_ms})["liveStatus"], "STALE")

    def test_price_without_any_clock_is_not_claimed_live(self):
        self.assertEqual(self._search({"ltp": 1400.0})["liveStatus"], "STALE")

    def test_canonical_change_fields_win_over_recomputation(self):
        tick = {
            "ltp": 1400.0, "close": 1380.0,
            "change": 7.5, "changePercent": 0.54,
            "receivedAt": datetime.now(timezone.utc),
        }
        r = self._search(tick)
        self.assertEqual(r["change"], 7.5)
        self.assertEqual(r["changePct"], 0.54)

    def test_circuit_bands_are_read_from_the_tick(self):
        tick = {
            "ltp": 1400.0,
            "upper_circuit_limit": 1512.0,
            "lower_circuit_limit": 1232.0,
            "receivedAt": datetime.now(timezone.utc),
        }
        r = self._search(tick)
        self.assertEqual(r["upperCircuit"], 1512.0)
        self.assertEqual(r["lowerCircuit"], 1232.0)

    def test_circuits_are_null_when_absent_never_derived(self):
        r = self._search({"ltp": 1400.0, "receivedAt": datetime.now(timezone.utc)})
        self.assertIsNone(r["upperCircuit"])
        self.assertIsNone(r["lowerCircuit"])

    def test_timestamp_is_iso_8601(self):
        r = self._search({"ltp": 1400.0, "receivedAt": datetime.now(timezone.utc)})
        self.assertIsInstance(r["timestamp"], str)
        self.assertTrue(r["timestamp"].endswith("+00:00"))

    def test_source_is_reported(self):
        tick = {"ltp": 1400.0, "source": "kotak_ws", "receivedAt": datetime.now(timezone.utc)}
        self.assertEqual(self._search(tick)["source"], "kotak_ws")


class MarginStatusDetailTest(unittest.TestCase):
    def setUp(self):
        self.se = SearchEngine()
        self.se._instruments.append(_instrument("RELIANCE", "2885", "Reliance Industries"))
        self.se._build_index()

    def _row(self, **kwargs):
        with mock.patch("services.tick_buffer.get_latest_ticks", return_value={}):
            return self.se.search_scoped("reliance", scopes=["stocks"], **kwargs)["results"][0]

    def test_margin_not_requested_is_distinguishable_from_missing_provider(self):
        self.assertEqual(self._row()["marginSource"], "not_requested")
        self.assertEqual(self._row(with_margin=True)["marginSource"], "unavailable")

    def test_requires_order_context_status_passes_through(self):
        self.se.set_margin_provider(
            lambda _r: {"margin": None, "status": "REQUIRES_ORDER_CONTEXT",
                        "source": "margin_engine", "reason": "product/order_type not supplied"}
        )
        r = self._row(with_margin=True)
        self.assertEqual(r["marginStatus"], "REQUIRES_ORDER_CONTEXT")
        self.assertIsNone(r["oneQtyMargin"])
        self.assertEqual(r["marginSource"], "margin_engine")

    def test_provider_returning_none_is_unavailable_not_fabricated(self):
        self.se.set_margin_provider(lambda _r: None)
        r = self._row(with_margin=True)
        self.assertIsNone(r["oneQtyMargin"])
        self.assertEqual(r["marginStatus"], "UNAVAILABLE")

    def test_provider_error_is_reported_not_swallowed(self):
        def boom(_r):
            raise RuntimeError("broker down")

        self.se.set_margin_provider(boom)
        r = self._row(with_margin=True)
        self.assertIsNone(r["oneQtyMargin"])
        self.assertEqual(r["marginStatus"], "UNAVAILABLE")
        self.assertIn("broker down", r["marginReason"])


class ScopedErrorCodeTest(unittest.TestCase):
    def setUp(self):
        self.se = SearchEngine()
        self.se._instruments.append(_instrument("RELIANCE", "2885", "Reliance Industries"))
        self.se._build_index()

    def test_invalid_scope_is_reported_not_silently_defaulted(self):
        out = self.se.search_scoped("reliance", scopes=["bonds"])
        self.assertEqual(out["errorCode"], "SEARCH_INVALID_SCOPE")
        self.assertEqual(out["results"], [])

    def test_partially_valid_scope_keeps_the_valid_ones(self):
        out = self.se.search_scoped("reliance", scopes=["bonds", "stocks"])
        self.assertEqual(out["scopes"], ["stocks"])
        self.assertIsNone(out["errorCode"])

    def test_empty_index_reports_index_unavailable(self):
        se = SearchEngine()
        se._instruments = []
        se._built = True
        se._index = {}
        out = se.search_scoped("reliance", scopes=["stocks"])
        self.assertEqual(out["errorCode"], "SEARCH_INDEX_UNAVAILABLE")


class SearchLtpCompatTest(unittest.TestCase):
    def test_ltp_cache(self):
        se = SearchEngine()
        self.assertIsNone(se.get_ltp("1"))
        se.update_ltp("1", 1234.5)
        self.assertEqual(se.get_ltp("1"), 1234.5)


class StaleRejectionTest(unittest.TestCase):
    def test_reject_stale(self):
        se = SearchEngine()
        self.assertTrue(se.reject_stale(1, 2))
        self.assertFalse(se.reject_stale(2, 2))


class LegacyAdapterTest(unittest.TestCase):
    """The deprecated instrument-search routes must resolve through the one
    canonical index, keep their legacy envelopes, and never fabricate values."""

    def setUp(self):
        from api.search import DEPRECATION_TARGET, canonical_instrument_rows, legacy_row

        self.target = DEPRECATION_TARGET
        self.rows_fn = canonical_instrument_rows
        self.legacy_row = legacy_row
        self.se = SearchEngine()
        self.se._instruments.append(_instrument("HEROMOTORS", "766171", "Hero MotoCorp"))
        self.se._build_index()

    def _patched(self):
        return mock.patch("api.search.search_engine", self.se)

    def test_legacy_rows_come_from_the_canonical_index(self):
        with self._patched():
            rows, meta = self.rows_fn("heromotors", 10, eq_only=True)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["token"], "766171")
        self.assertTrue(meta["indexAvailable"])

    def test_legacy_row_keeps_legacy_field_names(self):
        with self._patched():
            rows, _ = self.rows_fn("heromotors", 10, eq_only=True)
        projected = self.legacy_row(rows[0])
        for key in (
            "symbol", "tradingSymbol", "companyName", "exchange",
            "exchangeSegment", "instrumentToken", "token", "isin",
            "instrumentType", "liveStatus",
        ):
            self.assertIn(key, projected)
        self.assertEqual(projected["token"], "766171")
        self.assertEqual(projected["instrumentToken"], "766171")

    def test_missing_live_state_stays_null_with_a_status(self):
        with self._patched():
            rows, _ = self.rows_fn("heromotors", 10, eq_only=True)
        projected = self.legacy_row(rows[0])
        self.assertIsNone(projected["ltp"])
        self.assertIsNone(projected["change"])
        self.assertNotEqual(projected["ltp"], 0)
        self.assertEqual(projected["liveStatus"], "UNAVAILABLE")

    def test_unavailable_index_is_reported_not_hidden(self):
        se = SearchEngine()
        se._instruments = []
        se._built = True
        se._index = {}
        with mock.patch("api.search.search_engine", se):
            rows, meta = self.rows_fn("heromotors", 10)
        self.assertEqual(rows, [])
        self.assertFalse(meta["indexAvailable"])

    def test_deprecation_target_is_the_canonical_route(self):
        self.assertEqual(self.target, "/api/search")


if __name__ == "__main__":
    unittest.main()
