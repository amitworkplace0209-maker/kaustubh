"""Unit tests for Connection Manager field-requirement resolution (§10/§24)."""
import unittest

from connection_engine import field_requirements as fr


class AvailableFieldsTests(unittest.TestCase):
    def test_catalog_exposes_real_sources(self):
        catalog = fr.available_fields()
        self.assertIn("MARKET_DATA_WEBSOCKET", catalog["sources"])
        self.assertIn("FEATURE_ENGINE", catalog["sources"])
        self.assertIn("ltp", catalog["ws"])
        self.assertIn("prev_close", catalog["ws"])
        self.assertIn("change", catalog["features"])
        self.assertEqual(catalog["aliases"]["close"], "prev_close")


class ResolveRequirementsTests(unittest.TestCase):
    def test_ws_field_available(self):
        result = fr.resolve_requirements(["ltp", "volume"])
        self.assertEqual(result["status"], fr.AVAILABLE)
        self.assertEqual(result["resolvedFields"], ["ltp", "volume"])
        self.assertEqual(result["fieldRequirements"][0]["source"], fr.SOURCE_WS)

    def test_alias_resolves_against_canonical_field(self):
        result = fr.resolve_requirements(["close"])
        self.assertEqual(result["status"], fr.AVAILABLE)
        self.assertEqual(result["resolvedFields"], ["close"])

    def test_unproduced_feature_is_unavailable(self):
        result = fr.resolve_requirements(["ema20", "rsi14"])
        self.assertEqual(result["status"], fr.UNAVAILABLE)
        self.assertEqual(result["unavailableFields"], ["ema20", "rsi14"])

    def test_mixed_availability_is_partial(self):
        result = fr.resolve_requirements(["ltp", "ema20"])
        self.assertEqual(result["status"], fr.PARTIAL)
        self.assertEqual(result["resolvedFields"], ["ltp"])
        self.assertEqual(result["unavailableFields"], ["ema20"])

    def test_feature_not_ready_without_output(self):
        result = fr.resolve_requirements(["vwap"], feature_source_ok=True)
        self.assertEqual(result["status"], fr.NOT_READY)
        self.assertEqual(result["notReadyFields"], ["vwap"])

    def test_feature_available_with_output(self):
        output = {"calculationStatus": {"vwap": "AVAILABLE"}}
        result = fr.resolve_requirements(["vwap"], feature_output=output)
        self.assertEqual(result["status"], fr.AVAILABLE)
        self.assertEqual(result["resolvedFields"], ["vwap"])

    def test_feature_source_down_is_source_error(self):
        result = fr.resolve_requirements(["vwap"], feature_source_ok=False)
        self.assertEqual(result["status"], fr.SOURCE_ERROR)
        self.assertEqual(result["fieldRequirements"][0]["source"], fr.SOURCE_FEATURE)

    def test_empty_request_is_available(self):
        result = fr.resolve_requirements([])
        self.assertEqual(result["status"], fr.AVAILABLE)
        self.assertEqual(result["resolvedFields"], [])


class ProjectFieldsTests(unittest.TestCase):
    def test_projects_only_requested_and_present_fields(self):
        raw = {"ltp": 101.5, "prev_close": 100.0, "volume": 5000, "open": 99.0}
        projected, req = fr.project_fields(raw, ["ltp", "close", "ema20"])
        self.assertEqual(projected, {"ltp": 101.5, "close": 100.0})
        self.assertNotIn("volume", projected)
        self.assertNotIn("ema20", projected)
        self.assertEqual(req["status"], fr.PARTIAL)

    def test_omits_missing_values_never_fabricates(self):
        projected, _ = fr.project_fields({"ltp": 101.5}, ["ltp", "volume"])
        self.assertEqual(projected, {"ltp": 101.5})

    def test_feature_value_read_from_feature_output(self):
        feature_output = {
            "calculationStatus": {"vwap": "AVAILABLE"},
            "features": {"vwap": 100.25},
        }
        projected, _ = fr.project_fields(
            {"ltp": 101.5}, ["ltp", "vwap"], feature_output=feature_output
        )
        self.assertEqual(projected, {"ltp": 101.5, "vwap": 100.25})

    def test_bid_ask_alias_from_buy_sell_depth(self):
        raw = {"buy": [{"price": 100.0}], "sell": [{"price": 101.0}]}
        projected, _ = fr.project_fields(raw, ["bid", "ask"])
        self.assertEqual(projected["bid"], [{"price": 100.0}])
        self.assertEqual(projected["ask"], [{"price": 101.0}])


if __name__ == "__main__":
    unittest.main()
