"""Unit tests for the Kotak session-field parser used by intraday eligibility.

The broker login's validate envelope delivers product/exchange lists as
comma-joined STRINGS (e.g. ``"MIS,CNC"``); the parser must accept every real
shape so the scanner's "session products confirm MIS" branch actually fires.
Run with:  python -m unittest tests.test_kotak_parse
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import auth.kotak_client as kc  # noqa: E402


class ExtractStrListTest(unittest.TestCase):
    def test_comma_joined_string(self):
        self.assertEqual(
            kc._extract_str_list({"product": "MIS,CNC"}, "product", "products"),
            ["MIS", "CNC"],
        )

    def test_list_of_strings(self):
        self.assertEqual(
            kc._extract_str_list({"product": ["MIS", "CNC"]}, "product", "products"),
            ["MIS", "CNC"],
        )

    def test_nested_under_data_envelope(self):
        resp = {"data": {"product": "MIS", "exch": "NSE"}}
        self.assertEqual(kc._extract_str_list(resp, "product", "products"), ["MIS"])
        self.assertEqual(kc._extract_str_list(resp, "exch", "exchange", "exchanges"), ["NSE"])

    def test_list_of_dicts(self):
        resp = {"data": {"products": [{"code": "MIS"}, {"code": "CNC"}]}}
        self.assertEqual(kc._extract_str_list(resp, "product", "products"), ["MIS", "CNC"])

    def test_aliases_normalised(self):
        self.assertEqual(kc._extract_str_list({"product": "Cash and Carry,Normal"}, "product"), ["CNC", "NRML"])
        self.assertEqual(kc._extract_str_list({"product": "INTRADAY"}, "product"), ["INTRADAY"])

    def test_pipe_and_space_joined(self):
        self.assertEqual(kc._extract_str_list({"product": "MIS | CNC"}, "product"), ["MIS", "CNC"])

    def test_missing_is_empty(self):
        self.assertEqual(kc._extract_str_list({}, "product", "products"), [])
        self.assertEqual(kc._extract_str_list({"Data": {"token": "x"}}, "product"), [])

    def test_uppercase_stable_and_deduped(self):
        self.assertEqual(kc._extract_str_list({"product": "mis,cnc,MIS"}, "product"), ["MIS", "CNC"])


class ExtractLimitsTest(unittest.TestCase):
    def test_rows_by_exchange_segment_product(self):
        resp = {
            "data": [
                {"exch": "NSE", "seg": "CM", "product": "MIS", "limit": "100"},
                {"exch": "NSE", "seg": "CM", "product": "CNC", "limit": "100"},
                {"exch": "BSE", "seg": "CM", "product": "MIS", "limit": "100"},
            ]
        }
        products, exchanges, segments = kc._extract_limits(resp)
        self.assertEqual(products, ["MIS", "CNC"])
        self.assertEqual(exchanges, ["NSE", "BSE"])
        self.assertEqual(segments, ["CM"])

    def test_list_style_lists(self):
        resp = {"data": {"productList": ["MIS", "CNC"], "exchangeList": ["NSE"], "segmentList": ["CM"]}}
        products, exchanges, segments = kc._extract_limits(resp)
        self.assertEqual(products, ["MIS", "CNC"])
        self.assertEqual(exchanges, ["NSE"])
        self.assertEqual(segments, ["CM"])

    def test_empty_is_safe(self):
        self.assertEqual(kc._extract_limits({"error": "x"}), ([], [], []))


if __name__ == "__main__":
    unittest.main()