"""Unit tests for the Kotak margin-preview + trade-book correctness.

Covers: the SDK kwargs normalizer used by ``KotakClient.margin_required``
(exact-match aliases only, no guesswork), adapter-level margin behaviour, and
the trade_book fix — the Kotak trade book MUST come from the SDK's
``trade_report()`` (not a local estimate, and not ``order_report()`` which
returns the order book). Run with: python -m unittest tests.test_kotak_margin_tradebook
"""

from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import auth.kotak_client as kc  # noqa: E402
from brokers.kotak_adapter import KotakAdapter  # noqa: E402


class MarginNormalizerTest(unittest.TestCase):
    def test_maps_stable_shape_to_sdk_exact_match(self):
        out = kc._normalize_margin_kwargs(
            {
                "exchange": "nse_cm",
                "token": "2885",
                "product": "mis",
                "order_type": "LIMIT",
                "quantity": "5",
                "price": "1251.00",
                "transaction_type": "BUY",
            }
        )
        self.assertEqual(
            out,
            {
                "exchange_segment": "nse_cm",
                "price": "1251.00",
                "order_type": "L",
                "product": "MIS",
                "quantity": "5",
                "instrument_token": "2885",
                "transaction_type": "B",
                "trigger_price": None,
            },
        )

    def test_defaults_are_valid_sdk_values(self):
        out = kc._normalize_margin_kwargs({"quantity": "1", "token": "2885"})
        self.assertEqual(out["exchange_segment"], "nse_cm")
        self.assertEqual(out["order_type"], "MKT")
        self.assertEqual(out["product"], "MIS")
        self.assertEqual(out["transaction_type"], "B")

    def test_sl_keeps_trigger_price(self):
        out = kc._normalize_margin_kwargs(
            {"quantity": "1", "token": "2885", "order_type": "SL", "trigger_price": "1200"}
        )
        self.assertEqual(out["order_type"], "SL")
        self.assertEqual(out["trigger_price"], "1200")

    def test_numeric_token_variants_accepted(self):
        out = kc._normalize_margin_kwargs({"quantity": "1", "instrument_token": "2885"})
        self.assertEqual(out["instrument_token"], "2885")

    def test_rejects_zero_quantity(self):
        out = kc._normalize_margin_kwargs({"quantity": "0", "token": "2885"})
        self.assertIsInstance(out, str)

    def test_rejects_non_numeric_token(self):
        out = kc._normalize_margin_kwargs({"quantity": "1", "token": "INFY"})
        self.assertIsInstance(out, str)

    def test_rejects_unknown_exchange(self):
        out = kc._normalize_margin_kwargs(
            {"quantity": "1", "token": "2885", "exchange": "nonsense"}
        )
        self.assertIsInstance(out, str)

    def test_sdk_call_uses_exact_match_values(self):
        session = kc.KotakSession()
        session.session_active = True
        session.client = mock.Mock()
        session.client.margin_required = mock.Mock(
            return_value={"data": [{"TotalMargin": "1048.00", "TotalMarginUsed": "0.00"}]}
        )
        session.margin_required(
            exchange="nse_cm", token="2885", order_type="L", quantity="5",
            price="1251.00", product="MIS", transaction_type="BUY",
        )
        kwargs = session.client.margin_required.call_args.kwargs
        self.assertEqual(kwargs["exchange_segment"], "nse_cm")
        self.assertEqual(kwargs["order_type"], "L")
        self.assertEqual(kwargs["product"], "MIS")
        self.assertEqual(kwargs["quantity"], "5")
        self.assertEqual(kwargs["transaction_type"], "B")
        self.assertEqual(kwargs["instrument_token"], "2885")


class TradeBookTest(unittest.TestCase):
    def _fake_cache(self):
        async def fake_get(*_a, **_kw):
            return await _a[1]()

        cached = mock.AsyncMock()
        cached.side_effect = fake_get
        return cached

    def test_trade_book_uses_trade_report_not_order_report(self):
        adapter = KotakAdapter.__new__(KotakAdapter)
        adapter._engine = mock.Mock()
        adapter._engine.async_trade_report = mock.AsyncMock(
            return_value={"data": [{"ScripName": "INFY", "OrderType": "MKT"}]}
        )

        with mock.patch("brokers.kotak_adapter.broker_cache.get", self._fake_cache()):
            result = _call_trade_book(adapter)
        adapter._engine.async_trade_report.assert_awaited_once()
        adapter._engine.async_order_history.assert_not_called()
        self.assertIsInstance(result, dict)

    def test_margin_unavailable_never_fabricates(self):
        adapter = KotakAdapter.__new__(KotakAdapter)
        adapter._engine = mock.Mock()
        adapter._engine.async_margin_required = mock.AsyncMock(
            return_value={"Error Message": "Session expired"}
        )

        with mock.patch("brokers.kotak_adapter.broker_cache.get", self._fake_cache()):
            result = _call_margin(adapter)
        self.assertTrue(result.get("unavailable"))
        self.assertNotIn("TotalMargin", result)


class OrderChokePointTest(unittest.TestCase):
    def test_place_rejection_maps_to_honest_NotOk_envelope(self):
        from api.trading import PlaceOrderRequest, place_order

        req = PlaceOrderRequest(exchange="nse_cm", token="2885", symbol="INFY",
                                quantity="5", product="MIS", order_type="MKT")
        rejected = {
            "ok": False, "accepted": False, "terminal": "kotak",
            "reasons": ["insufficient funds/margin for this order"],
            "error": {"code": "ORDER_REJECTED", "message": "insufficient funds/margin for this order"},
        }
        with mock.patch("api.trading.order_engine.place", new=mock.AsyncMock(return_value=rejected)):
            with mock.patch("api.trading._require_session", return_value=None):
                out = _run_sync(place_order(req))
        self.assertEqual(out["data"]["stat"], "NotOk")
        self.assertIn("insufficient", out["data"]["remarks"])

    def test_place_success_preserves_broker_envelope(self):
        from api.trading import PlaceOrderRequest, place_order

        req = PlaceOrderRequest(exchange="nse_cm", token="2885", symbol="INFY",
                                quantity="5", product="MIS", order_type="MKT")
        broker_envelope = {"data": {"n_ord_no": "200", "stat": "Ok"}, "stat": "Ok"}
        ok_result = {"ok": True, "accepted": True, "terminal": "kotak", "data": broker_envelope}
        with mock.patch("api.trading.order_engine.place", new=mock.AsyncMock(return_value=ok_result)):
            with mock.patch("api.trading._require_session", return_value=None):
                out = _run_sync(place_order(req))
        self.assertEqual(out, broker_envelope)


class BasketChokePointTest(unittest.TestCase):
    """Every basket leg must flow through order_engine (Risk → Audit → Adapter).
    The legacy push endpoint never calls the broker SDK directly."""

    def _accepted(self, n_ord_no="200"):
        return {
            "ok": True, "accepted": True, "terminal": "kotak",
            "orderId": n_ord_no, "data": {"data": {"n_ord_no": n_ord_no, "stat": "Ok"}},
        }

    def _rejected(self, msg="insufficient funds/margin for this order"):
        return {
            "ok": False, "accepted": False, "terminal": "kotak",
            "reasons": [msg], "error": {"code": "ORDER_REJECTED", "message": msg},
        }

    def _leg(self, symbol="INFY", token="2885", tx="BUY") -> dict:
        return {
            "symbol": symbol, "token": token, "exchange": "nse_cm",
            "transactionType": tx, "product": "MIS", "orderType": "MKT",
            "quantity": "5", "price": "0", "triggerPrice": "0",
            "status": "pending", "orderId": None, "error": None,
        }

    class _FakeColl:
        def __init__(self, basket):
            self._basket = dict(basket)

        async def find_one(self, *_a, **_k):
            return dict(self._basket)

        async def update_one(self, _f, update, *_a, **_k):
            for k, v in update.get("$set", {}).items():
                self._basket[k] = v

    def _push(self, basket, orders):
        from api import baskets as mod

        fake_db = mock.Mock()

        def fake_get_db():
            return fake_db

        coll = self._FakeColl({**basket, "_id": "ffffffffffffffffffffffff", "orders": list(orders)})
        fake_db.basket_orders = coll
        with mock.patch("api.baskets.get_db", fake_get_db):
            return _run_sync(mod.push_basket("ffffffffffffffffffffffff"))

    def test_legs_route_through_order_engine_not_sdk(self):
        from api import baskets as mod

        self.assertFalse(hasattr(mod, "kotak_session"), "basket push must not import the SDK anymore")
        mapped = mod._basket_leg_to_order({
            "symbol": "INFY", "token": "2885", "exchange": "nse_cm",
            "transactionType": "SELL", "product": "MIS", "orderType": "SL",
            "quantity": "5", "price": "0", "triggerPrice": "1200",
        })
        self.assertEqual(mapped["exchange"], "nse_cm")
        self.assertEqual(mapped["token"], "2885")
        self.assertEqual(mapped["transaction_type"], "SELL")
        self.assertEqual(mapped["order_type"], "SL")
        self.assertEqual(mapped["quantity"], "5")
        self.assertEqual(mapped["trigger_price"], "1200")

    def test_cancel_on_fill_cancels_remaining_legs_without_placing(self):
        from api import baskets as mod

        legs = [self._leg("INFY"), self._leg("TCS", token="5460")]
        with mock.patch("api.baskets.order_engine.place", new=mock.AsyncMock(
            side_effect=[self._accepted("100"), self._accepted("101")]
        )) as place:
            out = self._push({"name": "B", "status": "active", "cancelOnFill": True}, legs)

        place.assert_awaited_once()
        self.assertEqual(len(out["results"]), 2)
        self.assertEqual(out["results"][0]["status"], "executed")
        self.assertEqual(out["results"][1]["status"], "cancelled")
        self.assertEqual(out["basket"]["status"], "completed")
        self.assertEqual(out["basket"]["orders"][1]["status"], "cancelled")

    def test_cancel_on_fill_off_places_every_leg(self):
        from api import baskets as mod

        legs = [self._leg("INFY"), self._leg("TCS", token="5460")]
        with mock.patch("api.baskets.order_engine.place", new=mock.AsyncMock(
            side_effect=[self._accepted("100"), self._accepted("101")]
        )) as place:
            out = self._push({"name": "B", "status": "active", "cancelOnFill": False}, legs)

        self.assertEqual(place.await_count, 2)
        statuses = [r["status"] for r in out["results"]]
        self.assertEqual(statuses, ["executed", "executed"])

    def test_rejected_leg_is_failed_not_placed_again(self):
        from api import baskets as mod

        legs = [self._leg("INFY"), self._leg("TCS", token="5460")]
        with mock.patch("api.baskets.order_engine.place", new=mock.AsyncMock(
            side_effect=[self._rejected(), self._accepted("101")]
        )) as place:
            out = self._push({"name": "B", "status": "active", "cancelOnFill": False}, legs)

        self.assertEqual(place.await_count, 2)
        self.assertEqual(out["results"][0]["status"], "failed")
        self.assertEqual(out["results"][1]["status"], "executed")
        self.assertIn("insufficient", out["results"][0]["error"])


class BasketEngineTest(unittest.TestCase):
    def test_place_basket_never_touches_adapter_directly(self):
        import core.engines.basket_engine as be

        accepted = {"ok": True, "accepted": True, "data": {"n_ord_no": "1"}}
        with mock.patch("core.engines.basket_engine.order_engine.place",
                        new=mock.AsyncMock(return_value=accepted)):
            out = _run_sync(be.place_basket("kotak", [{"symbol": "INFY", "quantity": "1"}]))
        self.assertTrue(out["ok"])
        self.assertEqual(out["total"], 1)
        self.assertEqual(out["accepted"], 1)


def _run_sync(coro_or_value):
    import asyncio

    async def run():
        return await coro_or_value if hasattr(coro_or_value, "__await__") else coro_or_value

    return asyncio.new_event_loop().run_until_complete(run())


def _call_trade_book(adapter):
    import asyncio

    async def run():
        return await adapter.trade_book()

    return asyncio.new_event_loop().run_until_complete(run())


def _call_margin(adapter):
    import asyncio

    async def run():
        return await adapter.margin_required(
            exchange="nse_cm", token="2885", product="MIS",
            order_type="MKT", quantity="1", price="0", transaction_type="BUY",
        )

    return asyncio.new_event_loop().run_until_complete(run())


if __name__ == "__main__":
    unittest.main()