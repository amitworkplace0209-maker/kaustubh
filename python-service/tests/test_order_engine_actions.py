"""Order Engine — order-action regression tests.

`cancel()` used to reference an `order` local that only existed in `modify()`,
so every cancel raised NameError AFTER the broker had already accepted it: the
order was really cancelled but the engine reported a 500 and never published the
`CANCELLED` realtime event. These tests pin the fix — cancel must publish and
notify without touching broker state, and must not invent a symbol it never got.
"""
from __future__ import annotations

import unittest
from unittest import mock

from core.engines import order_engine


class CancelTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_publishes_and_notifies_without_name_error(self):
        adapter = mock.MagicMock()
        adapter.is_logged_in = True
        adapter.broker_name = "dummy"
        adapter.cancel_order = mock.AsyncMock(return_value={"status": "complete"})

        with mock.patch.object(order_engine, "get_adapter", return_value=adapter), \
             mock.patch.object(order_engine.audit_engine, "record_action", new=mock.AsyncMock()), \
             mock.patch.object(order_engine, "_publish_order_event", new=mock.AsyncMock()) as publish, \
             mock.patch.object(order_engine, "_notify_order", new=mock.AsyncMock()) as notify:
            result = await order_engine.cancel("dummy", "ORD123")

        self.assertTrue(result["ok"])
        self.assertEqual(result["orderId"], "ORD123")
        adapter.cancel_order.assert_awaited_once_with("ORD123")
        publish.assert_awaited_once()
        notify.assert_awaited_once()

        # The published event carries the order id and an EMPTY symbol — cancel()
        # is not given a symbol, so none may be invented.
        published_order, status = publish.await_args.args[0], publish.await_args.args[1]
        self.assertEqual(published_order["order_id"], "ORD123")
        self.assertEqual(published_order["symbol"], "")
        self.assertEqual(status, "CANCELLED")

    async def test_cancel_requires_login(self):
        adapter = mock.MagicMock()
        adapter.is_logged_in = False
        adapter.broker_name = "kotak"
        with mock.patch.object(order_engine, "get_adapter", return_value=adapter):
            result = await order_engine.cancel("kotak", "ORD1")

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "NOT_LOGGED_IN")
        adapter.cancel_order.assert_not_called()

    async def test_cancel_requires_order_id(self):
        adapter = mock.MagicMock()
        adapter.is_logged_in = True
        with mock.patch.object(order_engine, "get_adapter", return_value=adapter):
            result = await order_engine.cancel("dummy", "")

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "INVALID_REQUEST")
        adapter.cancel_order.assert_not_called()

    async def test_cancel_broker_failure_is_reported_not_raised(self):
        adapter = mock.MagicMock()
        adapter.is_logged_in = True
        adapter.broker_name = "kotak"
        adapter.cancel_order = mock.AsyncMock(side_effect=RuntimeError("socket closed"))

        with mock.patch.object(order_engine, "get_adapter", return_value=adapter), \
             mock.patch.object(order_engine.audit_engine, "record_action", new=mock.AsyncMock()), \
             mock.patch.object(order_engine, "_publish_order_event", new=mock.AsyncMock()):
            result = await order_engine.cancel("kotak", "ORD9")

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "BROKER_UNAVAILABLE")
        self.assertIn("socket closed", result["error"]["message"])


class BrokerVerdictTests(unittest.IsolatedAsyncioTestCase):
    """A broker's verdict must be read at the level the broker actually put it.

    Kotak Neo answers a refusal as ``{"stat": "Ok", "data": {"stat": "Not_Ok"}}``.
    `place()` read only the top level, so a REFUSED Kotak order came back
    ``accepted: True`` with an empty order id — the order engine and the audit
    trail disagreed, and the UI showed a rejection as an executed leg.
    """

    def _patches(self, adapter):
        return (
            mock.patch.object(order_engine, "get_adapter", return_value=adapter),
            mock.patch.object(order_engine.risk_engine.risk_engine, "validate_order", new=mock.AsyncMock(
                return_value=mock.MagicMock(accepted=True, reasons=[]))),
            mock.patch.object(order_engine.audit_engine, "record_action", new=mock.AsyncMock()),
            mock.patch.object(order_engine.audit_engine, "record_decision", new=mock.AsyncMock()),
            mock.patch.object(order_engine, "_publish_order_event", new=mock.AsyncMock()),
            mock.patch.object(order_engine, "_notify_order", new=mock.AsyncMock()),
        )

    def _adapter(self, broker_result):
        adapter = mock.MagicMock()
        adapter.is_logged_in = True
        adapter.broker_name = "Kotak Neo"
        adapter.place_order = mock.AsyncMock(return_value=broker_result)
        return adapter

    async def test_nested_not_ok_is_a_rejection(self):
        adapter = self._adapter(
            {"stat": "Ok", "data": {"stat": "Not_Ok", "remarks": "insufficient margin"}})
        patches = self._patches(adapter)
        for p in patches:
            p.start()
        try:
            result = await order_engine.place("kotak", {"symbol": "SBIN", "quantity": "1"})
        finally:
            for p in patches:
                p.stop()

        self.assertFalse(result["accepted"])
        self.assertEqual(result["error"]["code"], "ORDER_REJECTED")
        self.assertIn("insufficient margin", result["error"]["message"])

    async def test_top_level_not_ok_is_a_rejection(self):
        adapter = self._adapter({"stat": "Not_Ok", "remarks": "bad scrip"})
        patches = self._patches(adapter)
        for p in patches:
            p.start()
        try:
            result = await order_engine.place("kotak", {"symbol": "SBIN", "quantity": "1"})
        finally:
            for p in patches:
                p.stop()

        self.assertFalse(result["accepted"])
        self.assertIn("bad scrip", result["error"]["message"])

    async def test_accepted_without_an_order_id_is_not_confirmed(self):
        """A real broker confirms a placement with an order number. Without one
        the state is unverified and must never be reported as executed."""
        adapter = self._adapter({"stat": "Ok", "data": {"stat": "Ok"}})
        patches = self._patches(adapter)
        for p in patches:
            p.start()
        try:
            result = await order_engine.place("kotak", {"symbol": "SBIN", "quantity": "1"})
        finally:
            for p in patches:
                p.stop()

        self.assertFalse(result["accepted"])
        self.assertEqual(result["error"]["code"], "ORDER_NOT_CONFIRMED")

    async def test_accepted_with_an_order_id_is_accepted(self):
        adapter = self._adapter({"stat": "Ok", "data": {"stat": "Ok", "n_ord_no": "K123"}})
        patches = self._patches(adapter)
        for p in patches:
            p.start()
        try:
            result = await order_engine.place("kotak", {"symbol": "SBIN", "quantity": "1"})
        finally:
            for p in patches:
                p.stop()

        self.assertTrue(result["accepted"])
        self.assertEqual(result["orderId"], "K123")

    async def test_observed_ltp_reaches_the_adapter_but_only_when_real(self):
        """The observed LTP is forwarded only when it is a real positive price,
        so an adapter never receives a 0 placeholder or an invented number."""
        for sent, expected_present in (("1402.35", True), ("0", False), (None, False)):
            adapter = self._adapter({"stat": "Ok", "data": {"n_ord_no": "K1"}})
            patches = self._patches(adapter)
            for p in patches:
                p.start()
            try:
                order = {"symbol": "SBIN", "quantity": "1"}
                if sent is not None:
                    order["expected_ltp"] = sent
                await order_engine.place("kotak", order)
            finally:
                for p in patches:
                    p.stop()
            kwargs = adapter.place_order.await_args.kwargs
            self.assertEqual("expected_ltp" in kwargs, expected_present, f"expected_ltp={sent!r}")
            if expected_present:
                self.assertEqual(kwargs["expected_ltp"], "1402.35")

    def test_stat_is_rejection_covers_broker_spellings(self):
        for stat in ("Not_Ok", "notok", "NOT_OK", "FAIL", "error", "rejected"):
            self.assertTrue(order_engine._stat_is_rejection(stat), stat)
        for stat in ("Ok", "OK", "complete", "COMPLETE", "", None):
            self.assertFalse(order_engine._stat_is_rejection(stat), stat)


if __name__ == "__main__":
    unittest.main()
