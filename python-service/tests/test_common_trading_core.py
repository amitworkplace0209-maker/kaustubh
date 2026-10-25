"""Common Trading Core tests — risk/order/position/target/basket/pnl/audit,
broker manager isolation, JWT auth and the Dummy execution contract.

No live MongoDB or broker credentials required: adapter reads are mocked,
session state is in-memory, and the paper engine's DB-backed store is patched.

Run:  python -m pytest tests/test_common_trading_core.py -q
"""
from __future__ import annotations

import asyncio
import os
import sys
import unittest
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

_DUMMY_ACCOUNT = {
    "balance": 100000, "usedMargin": 0, "freeMargin": 100000,
    "totalPnl": 0, "realizedPnl": 0, "unrealizedPnl": 0, "dailyOrders": 0,
}


class RiskEngineTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from core.engines.risk_engine import risk_engine
        risk_engine._recent_orders.clear()
        self.risk = risk_engine

    async def test_rejects_empty_symbol(self):
        d = await self.risk.validate_order(terminal="dummy", symbol="", order_type="MKT")
        self.assertFalse(d.accepted)
        self.assertTrue(any("symbol or token" in r for r in d.reasons))

    async def test_rejects_zero_quantity(self):
        d = await self.risk.validate_order(terminal="dummy", symbol="TATA", quantity="0", order_type="MKT")
        self.assertFalse(d.accepted)
        self.assertTrue(any("quantity" in r for r in d.reasons))

    async def test_rejects_sl_bare(self):
        d = await self.risk.validate_order(terminal="dummy", symbol="TATA", order_type="SL")
        self.assertFalse(d.accepted)
        self.assertTrue(any("trigger" in r for r in d.reasons))

    async def test_rejects_limit_without_price(self):
        d = await self.risk.validate_order(terminal="dummy", symbol="TATA", order_type="L")
        self.assertFalse(d.accepted)
        self.assertTrue(any("limit price" in r for r in d.reasons))

    async def test_rejects_unusable_order_type_for_terminal(self):
        # kotakneoapi 3.0.6 SDK supports SL/SL-M (order types L|MKT|SL|SL-M),
        # so Kotak accepts them. Use a capability that is genuinely unsupported
        # (historical data is NOT an order type) — instead assert that the risk
        # engine still rejects a bogus type for a real terminal.
        d = await self.risk.validate_order(terminal="kotak", symbol="TATA", order_type="GTC", trigger_price="100")
        self.assertFalse(d.accepted)
        self.assertTrue(any("unsupported order type" in r for r in d.reasons))

    async def test_accepts_valid_dummy_mkt(self):
        d = await self.risk.validate_order(
            terminal="dummy", symbol="TATA", token="123", order_type="MKT",
            quantity="1", product="MIS",
        )
        self.assertTrue(d.accepted, d.reasons)

    async def test_shoonya_supports_sl(self):
        from core.engines.risk_engine import risk_engine
        d = await risk_engine.validate_order(
            terminal="shoonya", symbol="TATA", order_type="SL-M", trigger_price="100",
            quantity="1", product="MIS",
        )
        self.assertNotIn("does not support", " ".join(d.reasons))

    async def test_duplicate_suppression(self):
        kw = dict(terminal="dummy", symbol="INFY", token="999", order_type="MKT", quantity="1", product="MIS")
        first = await self.risk.validate_order(**kw)
        self.assertTrue(first.accepted, first.reasons)
        second = await self.risk.validate_order(**kw)
        self.assertFalse(second.accepted)
        self.assertTrue(any("duplicate" in r for r in second.reasons))

    async def test_preview_phase_does_not_record_an_order_intent(self):
        """A read-only pre-check must not poison the execution path.

        The trade page pre-checks the ticket while the operator is still
        editing it. When the preview ALSO recorded the intent, the real
        placement a moment later was rejected as "duplicate order (same intent
        within suppression window)" — the UI's own safety check made the order
        impossible to send.
        """
        kw = dict(terminal="dummy", symbol="TCS", token="11536", order_type="MKT", quantity="1", product="MIS")
        preview = await self.risk.validate_order(**kw, phase="preview")
        self.assertTrue(preview.accepted, preview.reasons)
        execution = await self.risk.validate_order(**kw)
        self.assertTrue(execution.accepted, execution.reasons)

    async def test_preview_phase_still_reports_a_recent_real_order(self):
        """The preview reads the duplicate ring, so it stays honest."""
        kw = dict(terminal="dummy", symbol="LT", token="11421", order_type="MKT", quantity="1", product="MIS")
        first = await self.risk.validate_order(**kw)
        self.assertTrue(first.accepted, first.reasons)
        preview = await self.risk.validate_order(**kw, phase="preview")
        self.assertFalse(preview.accepted)
        self.assertTrue(any("duplicate" in r for r in preview.reasons))

    async def test_preview_phase_ignores_a_different_trigger_price(self):
        """Two stop orders with different triggers are two different intents."""
        base = dict(terminal="dummy", symbol="SBIN", token="3045", order_type="SL-M", quantity="1", product="MIS")
        first = await self.risk.validate_order(trigger_price="500", **base)
        self.assertTrue(first.accepted, first.reasons)
        second = await self.risk.validate_order(trigger_price="600", **base)
        self.assertTrue(second.accepted, second.reasons)

    async def test_margin_insufficient_rejects(self):
        with mock.patch(
            "core.engines.risk_engine.RiskEngine._check_margin",
            new=mock.AsyncMock(return_value=False),
        ):
            d = await self.risk.validate_order(
                terminal="dummy", symbol="HDFCBANK", token="55", order_type="MKT",
                quantity="1000", product="MIS", expected_ltp=500,
            )
        self.assertFalse(d.accepted)
        self.assertTrue(any("margin" in r for r in d.reasons))

    async def test_recent_decisions_feed_records_each_validation(self):
        self.risk._recent_decisions.clear()
        d = await self.risk.validate_order(
            terminal="dummy", symbol="TATA", token="123", order_type="MKT",
            quantity="1", product="MIS",
        )
        feed = self.risk.recent_decisions()
        self.assertTrue(len(feed) >= 1)
        latest = feed[0]
        self.assertEqual(latest["accepted"], d.accepted)
        self.assertEqual(latest["symbol"], "TATA")
        self.assertEqual(latest["terminal"], "dummy")

    async def test_recent_decisions_feed_is_bounded(self):
        self.risk._recent_decisions.clear()
        for i in range(self.risk._recent_decisions_max + 5):
            await self.risk.validate_order(
                terminal="dummy", symbol=f"SYM{i}", token=str(i),
                order_type="MKT", quantity="1", product="MIS",
            )
        self.assertEqual(len(self.risk.recent_decisions()), self.risk._recent_decisions_max)
        self.assertEqual(len(self.risk.recent_decisions(limit=5)), 5)


class RiskEngineApiTest(unittest.IsolatedAsyncioTestCase):
    async def test_validate_request_defaults_terminal_to_kotak(self):
        from api.risk_engine import ValidateOrderRequest

        req = ValidateOrderRequest(symbol="TATA")
        self.assertEqual(req.terminal, "kotak")

    async def test_validate_endpoint_is_a_preview_and_leaves_the_ring_empty(self):
        """`POST /api/services/risk/validate` must not record an order intent."""
        from api.risk_engine import ValidateOrderRequest, validate_order
        from core.engines.risk_engine import risk_engine

        risk_engine._recent_orders.clear()
        res = await validate_order(ValidateOrderRequest(
            terminal="dummy", symbol="WIPRO", token="3787", order_type="MKT",
            quantity="1", product="MIS",
        ))
        self.assertTrue(res["ok"])
        self.assertTrue(res["data"]["accepted"], res["data"])
        self.assertEqual(risk_engine._recent_orders, [])

    async def test_config_patch_rejects_negative_limits(self):
        from api.risk_engine import UpdateConfigRequest, update_config

        res = await update_config(UpdateConfigRequest(maxQtyPerSymbol=-5))
        self.assertFalse(res["ok"])

    async def test_config_patch_normalizes_blocked_symbols_to_uppercase(self):
        import core.engines.risk_engine as re_mod
        from api.risk_engine import UpdateConfigRequest, update_config

        before = set(re_mod._BLOCKED_SYMBOLS)
        try:
            res = await update_config(UpdateConfigRequest(blockedSymbols=["  relcap-eq ", ""]))
            self.assertTrue(res["ok"])
            self.assertIn("RELCAP-EQ", re_mod._BLOCKED_SYMBOLS)
        finally:
            re_mod._BLOCKED_SYMBOLS = before

    async def test_config_patch_rejects_empty_whitelist(self):
        from api.risk_engine import UpdateConfigRequest, update_config

        res = await update_config(UpdateConfigRequest(orderTypeWhitelist=[]))
        self.assertFalse(res["ok"])

    async def test_get_config_includes_live_stats(self):
        from api.risk_engine import get_config

        res = await get_config()
        self.assertTrue(res["ok"])
        stats = res["data"]["stats"]
        self.assertIn("validations", stats)
        self.assertIn("blocks", stats)
        self.assertIn("recentDecisions", stats)


class CapabilitiesTest(unittest.TestCase):
    def test_kotak_has_sl(self):
        from brokers.capabilities import capabilities_for
        caps = capabilities_for("kotak")
        # kotakneoapi 3.0.6 order-type surface is L|MKT|SL|SL-M → fully supported.
        for ot in ("MKT", "L", "SL", "SL-M"):
            self.assertIn(ot, caps.order_types)
        # SDK 3.0.6 adds HistoricalDataAPI → capability must reflect it (True).
        self.assertTrue(caps.supports_historical_data)
        self.assertTrue(caps.supports_margin_preview)

    def test_shoonya_has_sl(self):
        from brokers.capabilities import capabilities_for
        caps = capabilities_for("shoonya")
        self.assertIn("SL", caps.order_types)
        self.assertIn("SL-M", caps.order_types)

    def test_dummy_simulated_auth(self):
        from brokers.capabilities import capabilities_for
        self.assertEqual(capabilities_for("dummy").auth_flow, "simulated")
        self.assertTrue(capabilities_for("dummy").virtual_currency)

    def test_unknown_defaults_to_kotak(self):
        from brokers.capabilities import capabilities_for
        self.assertEqual(capabilities_for("nonsense").terminal, "kotak")


class ModelsTest(unittest.TestCase):
    def test_normalize_status_mapping(self):
        from brokers.models import normalize_status
        self.assertEqual(normalize_status("TRIGGER_PENDING"), "TRIGGER_PENDING")
        self.assertEqual(normalize_status("FILLED"), "COMPLETE")
        self.assertEqual(normalize_status("REJECT"), "REJECTED")
        self.assertEqual(normalize_status("CANCELED"), "CANCELLED")
        self.assertEqual(normalize_status("PARTFULL"), "PARTIALLY_FILLED")

    def test_broker_error_normalizes_code(self):
        from brokers.models import BrokerError
        err = BrokerError("NOT_A_CODE", "x")
        self.assertEqual(err.code, "UNKNOWN")
        err2 = BrokerError("ORDER_REJECTED", "no margin")
        self.assertEqual(err2.to_dict()["code"], "ORDER_REJECTED")

    def test_safe_float(self):
        from brokers.models import safe_float
        self.assertEqual(safe_float("1,234.5"), 1234.5)
        self.assertEqual(safe_float("oops"), 0.0)
        self.assertEqual(safe_float(""), 0.0)


class PnlEngineTest(unittest.TestCase):
    def test_long_position_normalization(self):
        from core.engines.pnl_engine import normalize_position, compute_totals
        row = {
            "sym": "RELIANCE", "exSeg": "nse_cm", "prod": "MIS",
            "flBuyQty": 10, "cfBuyQty": 0, "buyAmt": 250000,
            "flSellQty": 0, "cfSellQty": 0, "sellAmt": 0,
            "qty": 10, "ltp": 25100,
        }
        pos = normalize_position(row)
        self.assertEqual(pos["symbol"], "RELIANCE")
        self.assertEqual(pos["netQuantity"], 10)
        self.assertEqual(pos["positionType"], "LONG")
        self.assertAlmostEqual(pos["averageBuyPrice"], 25000.0, places=2)
        self.assertGreater(pos["unrealizedPnl"], 0)

    def test_short_position_and_totals(self):
        from core.engines.pnl_engine import normalize_position, compute_totals
        long_row = {"sym": "A", "qty": 5, "buyAmt": 1000, "ltp": 210}
        short_row = {"sym": "B", "qty": -3, "sellAmt": 600, "ltp": 190}
        rows = [normalize_position(long_row), normalize_position(short_row)]
        totals = compute_totals(rows)
        self.assertEqual(totals["openPositions"], 2)
        self.assertEqual(round(totals["unrealizedPnl"] + totals["realizedPnl"], 2), totals["grossPnl"])


class TargetEngineTest(unittest.IsolatedAsyncioTestCase):
    async def test_set_evaluate_remove(self):
        from core.engines.target_engine import set_target, evaluate, remove_target
        pos = {"symbol": "TATA", "netQuantity": 20, "ltp": 1000}
        await set_target("dummy", "TATA", 500000.0)   # current value 20*1000=20000
        eval_ = await evaluate("dummy", pos)
        self.assertIsNotNone(eval_)
        self.assertFalse(eval_["achieved"])
        self.assertTrue(await remove_target("dummy", "TATA"))
        await set_target("dummy", "TATA", 15000.0)
        eval_ = await evaluate("dummy", pos)
        self.assertTrue(eval_["achieved"])
        self.assertEqual(eval_["remaining"], 0.0)
        self.assertTrue(await remove_target("dummy", "TATA"))
        self.assertIsNone(await evaluate("dummy", pos))


class BrokerManagerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self):
        # Always restore the live context to the default terminal so an
        # explicit terminal switch made by a test cannot leak into later
        # tests (scheduler reconcile, watchlist, ws engine, ...) and make
        # them run against a Dummy broker.
        from brokers.manager import active_terminal, switch_terminal
        if active_terminal() != "kotak":
            await switch_terminal("kotak")

    async def test_three_terminals_registered(self):
        from brokers.manager import TERMINALS, get_adapter
        self.assertEqual(list(TERMINALS), ["kotak", "shoonya", "dummy"])
        for term in TERMINALS:
            adapter = get_adapter(term)
            self.assertEqual(adapter.mode, term)
            self.assertTrue(adapter.broker_name)

    async def test_switch_rejects_unknown(self):
        from brokers.manager import switch_terminal
        with self.assertRaises(ValueError):
            await switch_terminal("paper")

    async def test_switch_same_terminal_idempotent(self):
        from brokers.manager import switch_terminal
        await switch_terminal("dummy")
        second = await switch_terminal("dummy")
        self.assertTrue(second["ok"])
        self.assertFalse(second["changed"])


class DummyExecutionModelTest(unittest.TestCase):
    """Pure-logic tests for the paper engine's real-LTP execution rules."""

    @staticmethod
    def _req(**overrides):
        from api.demo import DemoPlaceOrderRequest
        params = dict(
            symbol="SBIN", tradingSymbol="SBIN", exchange="nse_cm",
            exchangeSegment="NSE_CM", token="3045", transactionType="BUY",
            product="MIS", orderType="MKT", quantity=2, price=0,
            triggerPrice=0, disclosedQty=0, validity="DAY", ltp=800.0,
        )
        params.update(overrides)
        return DemoPlaceOrderRequest(**params)

    def test_mkt_fills_with_slippage(self):
        from api.demo import _execution_decision
        d = _execution_decision(self._req(ltp=800.0, transactionType="BUY"))
        self.assertEqual(d["kind"], "FULL")
        self.assertAlmostEqual(d["price"], 800.0 * 1.001, places=2)
        self.assertEqual(d["status"], "COMPLETE")

    def test_mkt_sell_slippage_down(self):
        from api.demo import _execution_decision
        d = _execution_decision(self._req(ltp=800.0, transactionType="SELL"))
        self.assertAlmostEqual(d["price"], round(800.0 * 0.999, 2), places=2)

    def test_mkt_rejects_without_ltp(self):
        from api.demo import _execution_decision
        d = _execution_decision(self._req(ltp=0.0))
        # Market order without LTP is PARKED (RESTING/PENDING), not rejected -
        # a real broker queues it until a live price arrives
        self.assertEqual(d["kind"], "RESTING")
        self.assertEqual(d["status"], "PENDING")
        self.assertIn("Waiting for live market price", d["reason"])

    def test_limit_rests_when_not_marketable(self):
        from api.demo import _execution_decision
        d = _execution_decision(self._req(orderType="L", price=750.0, ltp=800.0))
        self.assertEqual(d["kind"], "RESTING")
        self.assertEqual(d["status"], "OPEN")

    def test_limit_fills_when_marketable(self):
        from api.demo import _execution_decision
        d = _execution_decision(self._req(orderType="L", price=800.0, ltp=790.0))
        self.assertEqual(d["kind"], "FULL")
        self.assertEqual(d["price"], 800.0)

    def test_sl_trigger_pending_until_crossed(self):
        from api.demo import _execution_decision
        # SELL SL below LTP → not hit yet. SELL SL-M at trigger 790 when ltp 800 → resting.
        d = _execution_decision(self._req(orderType="SL-M", triggerPrice=790.0, ltp=800.0, transactionType="SELL"))
        self.assertEqual(d["status"], "TRIGGER_PENDING")
        # ltp falls to 780 → SL-M fires at market 780.
        d2 = _execution_decision(self._req(orderType="SL-M", triggerPrice=790.0, ltp=780.0, transactionType="SELL"))
        self.assertEqual(d2["kind"], "FULL")

    def test_known_ltp_fallback_registry(self):
        from api.demo import remember_ltp, known_ltp
        remember_ltp("TATAMOTORS", 740.5)
        self.assertEqual(known_ltp("TATAMOTORS"), 740.5)
        self.assertEqual(known_ltp("UNKNOWN_SYMBOL"), 0.0)


class JwtAuthTest(unittest.TestCase):
    def _set_secret(self):
        from config import settings
        settings.jwt_secret = "test-secret"
        settings.jwt_issuer = "kaustubh-backend"
        settings.jwt_audience = "kaustubh-terminal"

    def test_roundtrip_and_verify(self):
        self._set_secret()
        from services.jwt_auth import issue_token, verify_token
        token = issue_token("kaustubh")
        payload = verify_token(token)
        self.assertEqual(payload["sub"], "kaustubh")
        self.assertTrue(payload["exp"] > payload["iat"])

    def test_tampered_signature_rejected(self):
        self._set_secret()
        from services.jwt_auth import issue_token, verify_token
        token = issue_token("kaustubh")
        bad = token[:-2] + ("aa" if not token.endswith("aa") else "bb")
        with self.assertRaises(ValueError):
            verify_token(bad)

    def test_authenticate_user_constant_time(self):
        self._set_secret()
        from config import settings
        settings.app_username = "kaustubh"
        settings.app_password = "hunter2"
        from services.jwt_auth import authenticate_user
        self.assertTrue(authenticate_user("kaustubh", "hunter2"))
        self.assertFalse(authenticate_user("kaustubh", "wrong"))
        self.assertFalse(authenticate_user("other", "hunter2"))


class OrderEngineTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from core.engines.risk_engine import risk_engine
        risk_engine._recent_orders.clear()
        from brokers import dummy as dummy_mod
        self.dummy_mod = dummy_mod
        self.adapter = dummy_mod.dummy_adapter
        if not self.adapter.is_logged_in:
            await self.adapter.login()
        self.patchers = [
            mock.patch("api.demo.get_dummy_account", new=mock.AsyncMock(return_value=dict(_DUMMY_ACCOUNT))),
        ]
        for p in self.patchers:
            p.start()
            self.addCleanup(p.stop)

    async def asyncTearDown(self):
        # dummy_adapter.login() calls session_manager.set_mode("dummy", ...),
        # which would leak the live context into every later test (scheduler
        # reconcile, watchlist, ...). Restore the default terminal.
        from brokers.manager import active_terminal, switch_terminal
        if active_terminal() != "kotak":
            await switch_terminal("kotak")

    async def test_place_not_logged_in_rejected(self):
        from core.engines.order_engine import place
        had = self.adapter._logged_in
        self.adapter._logged_in = False
        try:
            result = await place("dummy", {"symbol": "TATA", "token": "1", "quantity": "1", "order_type": "MKT"})
        finally:
            self.adapter._logged_in = had
        self.assertTrue(result["error"]["code"] == "NOT_LOGGED_IN")

    async def test_place_rejected_before_adapter(self):
        from core.engines.order_engine import place
        with mock.patch.object(self.adapter, "place_order", new=mock.AsyncMock(side_effect=AssertionError("should not call adapter"))):
            result = await place("dummy", {"symbol": "", "quantity": "0", "order_type": "SL"})
        self.assertFalse(result["accepted"])
        self.assertEqual(result["error"]["code"], "ORDER_REJECTED")

    async def test_place_flows_through_adapter_when_accepted(self):
        from core.engines.order_engine import place
        fake = mock.AsyncMock(return_value={"data": {"n_ord_no": "DEMO-1", "stat": "Ok"}})
        with mock.patch.object(self.adapter, "place_order", new=fake):
            result = await place("dummy", {
                "symbol": "TATAMOTORS", "token": "1023", "quantity": "1",
                "order_type": "MKT", "product": "MIS", "transaction_type": "BUY",
            })
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["orderId"], "DEMO-1")
        fake.assert_awaited_once()

    async def test_basket_all_or_nothing_result_shape(self):
        from core.engines.basket_engine import place_basket
        fake = mock.AsyncMock(return_value={"data": {"n_ord_no": "B-1", "stat": "Ok"}})
        with mock.patch.object(self.adapter, "place_order", new=fake):
            result = await place_basket("dummy", [
                {"symbol": "SBIN", "token": "3", "quantity": "2", "order_type": "MKT"},
                {"symbol": "TATAMOTORS", "token": "4", "quantity": "1", "order_type": "MKT"},
            ])
        self.assertTrue(result["ok"])
        self.assertEqual(result["accepted"], 2)
        self.assertEqual(result["total"], 2)


class AuditEngineTest(unittest.IsolatedAsyncioTestCase):
    async def test_record_decision_and_ring(self):
        from core.engines import audit_engine
        from core.engines.risk_engine import RiskDecision
        audit_engine._RECENT.clear()
        decision = RiskDecision(accepted=True, reasons=[])
        doc = await audit_engine.record_decision(
            terminal="dummy", decision=decision,
            order={"symbol": "TATA", "quantity": "1", "terminal": "dummy"},
        )
        self.assertTrue(doc["accepted"])
        recent = audit_engine.recent_audit(terminal="dummy")
        self.assertEqual(len(recent), 1)
        self.assertEqual(recent[0]["event_id"], doc["event_id"])

    async def test_record_action_error_preserved(self):
        from core.engines import audit_engine
        audit_engine._RECENT.clear()
        doc = await audit_engine.record_action(
            terminal="dummy", action="place", status="failed", error="rejected by test",
        )
        self.assertEqual(doc["error"], "rejected by test")
        self.assertEqual(audit_engine.recent_audit(terminal="dummy")[0]["action"], "place")


class TerminalApiContractTest(unittest.IsolatedAsyncioTestCase):
    async def test_routes_registered_on_router(self):
        from api.terminal import router, user_router
        paths = {getattr(r, "path", "") for r in router.routes}
        for expected in (
            "/api/terminal/list", "/api/terminal/state",
            "/api/terminal/switch", "/api/terminal/connect", "/api/terminal/disconnect",
            "/api/terminal/account/{terminal}", "/api/terminal/positions/{terminal}",
            "/api/terminal/order", "/api/terminal/order/basket",
        ):
            self.assertIn(expected, paths)
        user_paths = {getattr(r, "path", "") for r in user_router.routes}
        self.assertIn("/api/user/login", user_paths)

    async def test_mutating_routes_require_jwt(self):
        from api.terminal import require_jwt
        from starlette.requests import Request
        req = Request({"type": "http", "method": "POST", "headers": []})
        with self.assertRaises(Exception):
            require_jwt(req)


if __name__ == "__main__":
    unittest.main(verbosity=2)