"""Paper order intent mapping — regression guard for the trade page.

`POST /api/demo/order/place` (the Dummy terminal's order entry point, used by
the trade page) translates the browser's paper payload into the ONE order
intent shape the Order Engine understands (`core/engines/order_engine.py`:
`_order_kwargs` / `_adapter_kwargs`).

The translator `_to_engine_order_intent` was MISSING from `api/demo.py` — it
was called but never defined, so every paper order died with
`NameError: name '_to_engine_order_intent' is not defined` → HTTP 500. The
trade page could therefore never place a paper order at all.

These tests pin the mapping contract so the function cannot disappear again
and so the key names stay aligned with the Order Engine / Dummy adapter.

Run:  python -m pytest tests/test_demo_order_intent.py -q
"""
from __future__ import annotations

import os
import sys
import unittest

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)


class DemoOrderIntentTest(unittest.TestCase):
    def _intent(self, **overrides):
        from api.demo import DemoPlaceOrderRequest, _to_engine_order_intent

        payload = dict(
            symbol="RELIANCE",
            tradingSymbol="RELIANCE-EQ",
            exchange="NSE",
            exchangeSegment="NSE_CM",
            token="2885",
            transactionType="BUY",
            product="MIS",
            orderType="MKT",
            quantity=3,
            price=0,
            triggerPrice=0,
            disclosedQty=0,
            validity="DAY",
            ltp=1208.9,
            source="MANUAL",
            amount=0,
            lotSize=1,
            marginPerShare=241.78,
        )
        payload.update(overrides)
        return _to_engine_order_intent(DemoPlaceOrderRequest(**payload))

    def test_translator_exists_and_maps_the_core_order_fields(self):
        intent = self._intent()
        self.assertEqual(intent["symbol"], "RELIANCE")
        self.assertEqual(intent["trading_symbol"], "RELIANCE-EQ")
        self.assertEqual(intent["token"], "2885")
        self.assertEqual(intent["exchange"], "NSE")
        self.assertEqual(intent["exchange_segment"], "NSE_CM")
        self.assertEqual(intent["transaction_type"], "BUY")
        self.assertEqual(intent["product"], "MIS")
        self.assertEqual(intent["order_type"], "MKT")
        self.assertEqual(intent["quantity"], "3")
        self.assertEqual(intent["validity"], "DAY")

    def test_scalars_are_strings_for_the_adapter_contract(self):
        # The Dummy adapter declares str parameters; the intent must not hand
        # it floats/ints that would break the adapter's own signature filter.
        intent = self._intent()
        for key in ("quantity", "price", "trigger_price", "expected_ltp",
                    "amount", "lot_size", "margin_per_share"):
            self.assertIsInstance(intent[key], str, key)

    def test_paper_only_fields_are_forwarded(self):
        intent = self._intent()
        self.assertEqual(intent["expected_ltp"], "1208.9")
        self.assertEqual(intent["margin_per_share"], "241.78")
        self.assertEqual(intent["lot_size"], "1")

    def test_trigger_and_disclosed_quantity_are_carried(self):
        intent = self._intent(orderType="SL-M", triggerPrice=1150.5, disclosedQty=2)
        self.assertEqual(intent["trigger_price"], "1150.5")
        self.assertEqual(intent["disclosed_quantity"], "2")

    def test_malformed_numbers_degrade_to_zero_instead_of_raising(self):
        # The pydantic model already rejects malformed input at the edge, but
        # the mapper itself must never raise on a stray value.
        from types import SimpleNamespace
        from api.demo import _to_engine_order_intent

        req = SimpleNamespace(
            symbol="RELIANCE", tradingSymbol="RELIANCE-EQ", exchange="NSE",
            exchangeSegment="NSE_CM", token="2885", transactionType="buy",
            product="mis", orderType="mkt", quantity=3, price="abc",
            triggerPrice=None, disclosedQty=0, validity="day", ltp=None,
            source=None, amount="x", lotSize=None, marginPerShare=None,
        )
        intent = _to_engine_order_intent(req)
        self.assertEqual(intent["quantity"], "3")
        self.assertEqual(intent["price"], "0.0")
        self.assertEqual(intent["trigger_price"], "0.0")
        self.assertEqual(intent["expected_ltp"], "0.0")
        self.assertEqual(intent["transaction_type"], "BUY")
        self.assertEqual(intent["validity"], "DAY")

    def test_every_mapped_key_is_known_to_the_order_engine(self):
        """The intent must only use keys the Order Engine actually reads."""
        from core.engines.order_engine import _order_kwargs

        intent = self._intent()
        forwarded = set(_order_kwargs(intent))
        # `_order_kwargs` keeps the core fields; the richer paper fields are
        # optional extras the Dummy adapter declares by name.
        self.assertIn("symbol", forwarded)
        self.assertIn("transaction_type", forwarded)
        self.assertIn("order_type", forwarded)
        extras = {"expected_ltp", "source", "trading_symbol", "exchange_segment",
                  "amount", "lot_size", "margin_per_share"}
        self.assertTrue((set(intent) - forwarded).issubset(extras))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
