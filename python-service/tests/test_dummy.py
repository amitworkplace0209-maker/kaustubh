"""Dummy Trading Terminal tests (no live MongoDB required).

Covers ``services.dummy_extras`` and the ``api/dummy`` router surface:
- IST trading-date partition (08:30 cutoff)
- basket validation / expiry / execution audit
- price-alert dedup by cooldown
- target idempotent auto square-off
- daily-history snapshot upsert (one per trading date)
- notification read / dismiss / clear
- router route presence

Run:  python -m pytest tests/test_dummy.py -q
"""
from __future__ import annotations

import os
import sys
import unittest
from datetime import datetime, time, timedelta, timezone
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

IST = timezone(timedelta(hours=5, minutes=30))


def utc(y, mo, d, h=0, mi=0, s=0):
    return datetime(y, mo, d, h, mi, s, tzinfo=timezone.utc)


class FakeCursor:
    def __init__(self, docs):
        self._docs = list(docs)

    async def to_list(self, length=None):
        return list(self._docs)


class FakeCollection:
    def __init__(self, docs=None):
        self._docs = list(docs or [])

    async def find_one(self, q=None):
        q = q or {}
        for d in self._docs:
            if all(d.get(k) == v for k, v in q.items()):
                return dict(d)
        return None

    def find(self, q=None, sort=None):
        docs = [d for d in self._docs
                if all(d.get(k) == v for k, v in (q or {}).items())]
        if sort:
            for key, order in reversed(sort):
                docs.sort(key=lambda d: d.get(key, ""), reverse=(order == -1))
        return FakeCursor(docs)

    async def update_one(self, q, update, upsert=False):
        key = q.get("key")
        for d in self._docs:
            if d.get("key") == key:
                if "$set" in update:
                    d.update(update["$set"])
                if "$push" in update:
                    d.setdefault("value", []).append(update["$push"]["$each"][0])
                return key
        if upsert:
            doc = {"key": key}
            doc.update({k: v for k, v in update.get("$set", {}).items() if k != "key"})
            self._docs.append(doc)
        return key

    def seed(self, docs):
        self._docs[:] = list(docs or self._docs)


class FakeDB:
    def __init__(self, **colls):
        for name, docs in colls.items():
            setattr(self, name, FakeCollection(docs))

    def app_settings(self):
        return getattr(self, "app_settings")

    def __getitem__(self, name):
        coll = getattr(self, name, None)
        if coll is None:
            coll = FakeCollection([])
            setattr(self, name, coll)
        return coll


class DummyExtrasTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.db = FakeDB(app_settings=[])
        self.patchers = [
            mock.patch("services.dummy_extras.get_db", return_value=self.db),
            mock.patch("api.demo.get_db", return_value=self.db),
            mock.patch("services.dummy_extras._now_utc",
                       return_value=utc(2026, 2, 2, 6, 0)),
        ]
        for p in self.patchers:
            p.start()
            self.addCleanup(p.stop)

    # ---- trading-date partition ------------------------------------------ #
    def test_trading_date_before_midnight(self):
        from services.dummy_extras import trading_date
        ist = utc(2026, 2, 1, 18, 0)          # 23:30 IST on Feb 1
        self.assertEqual(trading_date(ist), "2026-02-01")

    def test_trading_date_after_midnight(self):
        from services.dummy_extras import trading_date
        ist = utc(2026, 2, 1, 19, 0)          # 00:30 IST on Feb 2
        self.assertEqual(trading_date(ist), "2026-02-02")

    def test_trading_date_exact_boundary_is_new_day(self):
        from services.dummy_extras import trading_date
        ist = utc(2026, 2, 1, 18, 30)         # exactly 00:00 IST Feb 2
        self.assertEqual(trading_date(ist), "2026-02-02")

    # ---- baskets ---------------------------------------------------------- #
    async def test_create_and_fetch_basket(self):
        from services.dummy_extras import create_basket, get_basket
        b = await create_basket(
            "Test basket", [
                {"symbol": "INFY", "transactionType": "BUY", "quantity": 10, "orderType": "MKT"},
                {"symbol": "TCS", "transactionType": "SELL", "quantity": 5, "orderType": "LMT", "price": 100},
            ],
            {"mode": "MIN", "minimum": 1},
        )
        self.assertEqual(b["policy"]["mode"], "MIN")
        fetched = await get_basket(b["id"])
        self.assertEqual(fetched["name"], "Test basket")
        self.assertEqual(len(fetched["legs"]), 2)

    async def test_basket_validation_rejects_bad_leg(self):
        from services.dummy_extras import create_basket
        with self.assertRaises(ValueError):
            await create_basket("Bad", [{"symbol": "X", "transactionType": "HOLD", "quantity": 0}])

    async def test_basket_expiry(self):
        from services.dummy_extras import create_basket, execute_basket, get_basket
        b = await create_basket("Expiring", [
            {"symbol": "RELIANCE", "transactionType": "BUY", "quantity": 1, "orderType": "MKT"},
        ], expirySeconds=10)
        self.db.app_settings.seed([{"key": "dummy_baskets", "value": [b]}])
        with mock.patch("services.dummy_extras._now_utc",
                        return_value=utc(2026, 2, 2, 6, 0) + timedelta(days=1)):
            with self.assertRaises(ValueError):
                await execute_basket(b["id"])

    async def test_execute_basket_records_audit(self):
        from services.dummy_extras import create_basket, execute_basket, get_basket, get_dummy_notifications
        b = await create_basket("Audited", [
            {"symbol": "INFY", "transactionType": "BUY", "quantity": 10, "orderType": "MKT"},
            {"symbol": "TCS", "transactionType": "BUY", "quantity": 5, "orderType": "MKT"},
        ])
        self.db.app_settings.seed([{"key": "dummy_baskets", "value": [b]}])
        async def _ok(**params):
            from api.demo import _build_order
            import time
            charges = {"total": 1.0}
            return {"stat": "Ok", "demoOrder": {**_build_order(
                __import__("api.demo", fromlist=["DemoPlaceOrderRequest"]).DemoPlaceOrderRequest(
                    symbol=params.get("symbol"), transactionType=params.get("transactionType"),
                    product="MIS", orderType="MKT", quantity=int(params.get("quantity", 0)),
                ), params.get("symbol"), "COMPLETE", int(params.get("quantity", 0)), 100.0, charges)}}
        with mock.patch("api.demo.execute_dummy_order", side_effect=_ok):
            result = await execute_basket(b["id"], {"INFY": 100.0, "TCS": 100.0})
        self.assertTrue(result["ok"])
        self.assertEqual(result["summary"]["filled"], 2)
        refreshed = await get_basket(b["id"])
        self.assertEqual(len(refreshed["audit"]), 1)
        notifications = await get_dummy_notifications()
        self.assertTrue(any(n.get("category") == "basket" for n in notifications))

    # ---- alerts ----------------------------------------------------------- #
    async def test_alert_cooldown_dedup(self):
        from services.dummy_extras import create_alert, evaluate_dummy_alerts, get_dummy_notifications
        await create_alert("INFY", "ABOVE", 100, cooldownSec=60)
        triggered = await evaluate_dummy_alerts({"INFY": 105.0})
        self.assertEqual(len(triggered), 1)
        again = await evaluate_dummy_alerts({"INFY": 110.0})
        self.assertEqual(len(again), 0)
        notifications = await get_dummy_notifications()
        self.assertEqual(sum(1 for n in notifications if n.get("category") == "alert"), 1)

    async def test_alert_below_condition(self):
        from services.dummy_extras import create_alert, evaluate_dummy_alerts
        await create_alert("TCS", "BELOW", 50, cooldownSec=0)
        triggered = await evaluate_dummy_alerts({"TCS": 45.0})
        self.assertEqual(len(triggered), 1)

    # ---- targets ---------------------------------------------------------- #
    async def test_target_auto_execute_once(self):
        from services.dummy_extras import set_target, evaluate_dummy_targets
        await set_target("RELIANCE", "PERCENT", 5, "PROFIT", autoExecute=True)
        position = {
            "symbol": "RELIANCE", "netQuantity": 10, "averageBuyPrice": 100.0,
            "product": "MIS", "ltp": 105.0,
        }
        async def _squareoff(*args, **kwargs):
            return {"stat": "Ok", "demoOrder": {"orderId": "DEMO123"}}
        with mock.patch("api.demo.squareoff_dummy_position", side_effect=_squareoff):
            executed = await evaluate_dummy_targets({"RELIANCE": 110.0}, [position])
        self.assertEqual(len(executed), 1)
        self.assertEqual(executed[0]["status"], "EXECUTED")
        # Second evaluation must not re-execute (PENDING guard).
        with mock.patch("api.demo.squareoff_dummy_position", side_effect=_squareoff) as sq:
            await evaluate_dummy_targets({"RELIANCE": 115.0}, [position])
            sq.assert_not_called()

    async def test_target_not_crossed_stays_pending(self):
        from services.dummy_extras import set_target, evaluate_dummy_targets
        await set_target("RELIANCE", "PERCENT", 5, "PROFIT", autoExecute=True)
        position = {"symbol": "RELIANCE", "netQuantity": 10, "averageBuyPrice": 100.0, "product": "MIS", "ltp": 101.0}
        executed = await evaluate_dummy_targets({"RELIANCE": 102.0}, [position])
        self.assertEqual(executed, [])

    # ---- daily history / portfolio ---------------------------------------- #
    async def test_daily_history_one_entry_per_day(self):
        from services.dummy_extras import ensure_today_snapshot, portfolio_summary
        first = await ensure_today_snapshot()
        second = await ensure_today_snapshot()
        self.assertEqual(first["date"], "2026-02-02")
        self.assertEqual(first["date"], second["date"])
        summary = await portfolio_summary()
        self.assertEqual(len(summary["history"]), 1)

    async def test_retention_purges_old_orders(self):
        from services.dummy_extras import apply_retention
        old = utc(2026, 1, 2, 4, 0)
        self.db.app_settings.seed([{
            "key": "demo_orders",
            "value": [
                {"orderId": "OLD", "orderDate": old.isoformat()},
                {"orderId": "NEW", "orderDate": utc(2026, 2, 2, 5, 0).isoformat()},
            ],
        }])
        purged = await apply_retention(cutoff_days=7)
        self.assertEqual(purged, 1)
        remaining = next((d for d in self.db.app_settings._docs if d["key"] == "demo_orders"), None)
        self.assertEqual([o["orderId"] for o in remaining["value"]], ["NEW"])

    # ---- notifications ---------------------------------------------------- #
    async def test_notification_read_dismiss_clear(self):
        from services.dummy_extras import notify, list_notifications, mark_notification_read, delete_notification, clear_notifications
        n1 = await notify("order", "Placed", "INFY BUY 10")
        n2 = await notify("order", "Filled", "INFY BUY 10")
        got = await list_notifications()
        self.assertEqual(got["unread"], 2)
        self.assertTrue(await mark_notification_read(n1["id"]))
        got = await list_notifications()
        self.assertEqual(got["unread"], 1)
        self.assertTrue(await delete_notification(n1["id"]))
        got = await list_notifications()
        self.assertEqual(got["total"], 1)
        self.assertEqual(await clear_notifications(), 1)
        got = await list_notifications()
        self.assertEqual(got["total"], 0)

    # ---- calendar payload -------------------------------------------------- #
    def test_calendar_payload_sorted_holidays_and_keys(self):
        from services.dummy_extras import calendar_payload
        payload = calendar_payload()
        self.assertIn("snapshot", payload)
        self.assertIn("sessions", payload)
        self.assertIn("holidays", payload)
        dates = [h["date"] for h in payload["holidays"]]
        self.assertEqual(dates, sorted(dates))
        for session in payload["sessions"]:
            self.assertIn("id", session)
            self.assertIn("label", session)
        self.assertIn("next_trading_day", payload)
        self.assertIn("constraints", payload)

    def test_market_snapshot_includes_trading_date(self):
        from services.dummy_extras import market_snapshot
        snap = market_snapshot()
        self.assertIn("tradingDate", snap)
        self.assertIn("market_status", snap)
        self.assertIn("next_market_open", snap)

    # ---- closed positions ------------------------------------------------ #
    async def test_closed_position_record_and_list(self):
        from services.dummy_extras import record_closed_position, list_closed_positions, clear_closed_positions
        await record_closed_position(
            symbol="INFY", trading_symbol="INFY-EQ", exchange="nse_cm", exchange_segment="NSE_CM",
            token="1594", product="MIS", side="LONG", quantity=10, average_price=1500.0,
            exit_price=1560.0, realized_pnl=600.0, charges=18.5, reason="SQUAREOFF",
        )
        closed = await list_closed_positions()
        self.assertEqual(len(closed), 1)
        record = closed[0]
        self.assertEqual(record["symbol"], "INFY")
        self.assertEqual(record["realizedPnl"], 600.0)
        self.assertEqual(record["netPnl"], 581.5)
        self.assertEqual(record["tradingDate"], "2026-02-02")
        self.assertEqual(await clear_closed_positions(), 1)
        self.assertEqual(await list_closed_positions(), [])

    # ---- audit trail ------------------------------------------------------ #
    async def test_audit_record_filter_list(self):
        from services.dummy_extras import record_audit, list_audit
        await record_audit("order", "place", {"symbol": "INFY"})
        await record_audit("prefs", "update", {"slippageBps": 30})
        all_events = await list_audit(limit=100)
        self.assertEqual(len(all_events), 2)
        only_orders = await list_audit(category="order", limit=100)
        self.assertEqual([e["category"] for e in only_orders], ["order"])

    # ---- watchlists ------------------------------------------------------- #
    async def test_watchlist_crud_and_active(self):
        from services.dummy_extras import (
            list_watchlists, create_watchlist, delete_watchlist, set_active_watchlist,
            add_watchlist_symbol, remove_watchlist_symbol, watchlist_symbols,
        )
        first = await list_watchlists()
        self.assertEqual(first["items"], [])
        created = await create_watchlist("Favourites", [{"symbol": "INFY", "exchange": "nse_cm"}])
        second = await create_watchlist("Open", [])
        payload = await list_watchlists()
        self.assertEqual(len(payload["items"]), 2)
        self.assertEqual(payload["activeId"], created["id"])
        # Dedup: adding the same symbol twice keeps one entry.
        self.assertTrue(await add_watchlist_symbol(created["id"], {"symbol": "INFY", "exchange": "nse_cm"}))
        self.assertTrue(await add_watchlist_symbol(created["id"], {"symbol": "TCS", "exchange": "nse_cm"}))
        syms = await watchlist_symbols(created["id"])
        self.assertEqual([s["symbol"] for s in syms], ["INFY", "TCS"])
        self.assertTrue(await remove_watchlist_symbol(created["id"], "infy"))
        syms = await watchlist_symbols(created["id"])
        self.assertEqual([s["symbol"] for s in syms], ["TCS"])
        self.assertTrue(await set_active_watchlist(second["id"]))
        payload = await list_watchlists()
        self.assertEqual(payload["activeId"], second["id"])
        self.assertTrue(await delete_watchlist(created["id"]))
        self.assertEqual(len((await list_watchlists())["items"]), 1)

    async def test_watchlist_cannot_delete_last(self):
        from services.dummy_extras import create_watchlist, delete_watchlist
        wl = await create_watchlist("Only", [])
        with self.assertRaises(ValueError):
            await delete_watchlist(wl["id"])

    # ---- calendar events --------------------------------------------------- #
    async def test_calendar_event_crud(self):
        from services.dummy_extras import (
            create_calendar_event, list_calendar_events, update_calendar_event, delete_calendar_event,
        )
        ev = await create_calendar_event("2026-02-20", "TRADING", "Result day", note="TCS", pinned=True)
        self.assertEqual(ev["category"], "TRADING")
        with self.assertRaises(ValueError):
            await create_calendar_event("2026-02-20", "BOGUS", "Bad")
        updated = await update_calendar_event(ev["id"], {"pinned": False, "note": "Updated"})
        self.assertFalse(updated["pinned"])
        self.assertEqual(updated["note"], "Updated")
        events = await list_calendar_events("2026-02-01", "2026-02-28")
        self.assertEqual(len(events), 1)
        self.assertEqual(await list_calendar_events("2026-03-01", "2026-03-31"), [])
        self.assertTrue(await delete_calendar_event(ev["id"]))
        self.assertEqual(await list_calendar_events(), [])

    # ---- prefs ------------------------------------------------------------- #
    async def test_prefs_extended_defaults_and_delivery_merge(self):
        from services.dummy_extras import get_prefs, update_prefs
        prefs = await get_prefs()
        self.assertEqual(prefs["slippageBps"], 10)
        self.assertEqual(prefs["maxDailyOrders"], 0)
        self.assertIn("notificationDelivery", prefs)
        merged = await update_prefs({"notificationDelivery": {"popup": True, "sound": True}})
        delivery = merged["notificationDelivery"]
        self.assertTrue(delivery["popup"])
        self.assertTrue(delivery["sound"])
        self.assertTrue(delivery["inApp"])  # preserved
        self.assertFalse(delivery["push"])  # preserved from defaults


class DummyEngineControlTest(unittest.IsolatedAsyncioTestCase):
    """The paper engine honours the simulation prefs (slippage / caps)."""

    def setUp(self):
        self.db = FakeDB(app_settings=[])
        self.patchers = [
            mock.patch("services.dummy_extras.get_db", return_value=self.db),
            mock.patch("api.demo.get_db", return_value=self.db),
            mock.patch("services.dummy_extras._now_utc",
                       return_value=utc(2026, 2, 2, 6, 0)),
        ]
        for p in self.patchers:
            p.start()
            self.addCleanup(p.stop)

    async def test_order_uses_configured_slippage(self):
        from api.demo import _execute_order, DemoPlaceOrderRequest
        self.db.app_settings.seed([{"key": "dummy_prefs", "value": {"slippageBps": 40, "maxDailyOrders": 0, "maxOrderValue": 0}}])
        result = await _execute_order(DemoPlaceOrderRequest(
            symbol="INFY", tradingSymbol="INFY-EQ", exchange="nse_cm", exchangeSegment="NSE_CM",
            token="1594", transactionType="BUY", product="MIS", orderType="MKT", quantity=10, ltp=100.0,
        ))
        self.assertEqual(result["stat"], "Ok")
        order = result["demoOrder"]
        self.assertEqual(order["status"], "COMPLETE")
        self.assertEqual(order["averageTradedPrice"], 100.4)

    async def test_daily_order_cap_rejects(self):
        from api.demo import _execute_order, DemoPlaceOrderRequest
        self.db.app_settings.seed([
            {"key": "dummy_prefs", "value": {"slippageBps": 10, "maxDailyOrders": 1, "maxOrderValue": 0}},
            {"key": "demo_account", "value": {"balance": 100000, "usedMargin": 0, "freeMargin": 100000,
                                              "dailyOrders": 1, "realizedPnl": 0, "unrealizedPnl": 0,
                                              "totalPnl": 0, "totalCharges": 0}},
        ])
        result = await _execute_order(DemoPlaceOrderRequest(
            symbol="INFY", exchange="nse_cm", exchangeSegment="NSE_CM", token="1594",
            transactionType="BUY", product="MIS", orderType="MKT", quantity=10, ltp=100.0,
        ))
        self.assertEqual(result["stat"], "NotOk")
        self.assertEqual(result["demoOrder"]["status"], "REJECTED")

    async def test_max_order_value_cap_rejects(self):
        from api.demo import _execute_order, DemoPlaceOrderRequest
        self.db.app_settings.seed([
            {"key": "dummy_prefs", "value": {"slippageBps": 10, "maxDailyOrders": 0, "maxOrderValue": 500}},
        ])
        result = await _execute_order(DemoPlaceOrderRequest(
            symbol="INFY", exchange="nse_cm", exchangeSegment="NSE_CM", token="1594",
            transactionType="BUY", product="MIS", orderType="MKT", quantity=10, ltp=100.0,
        ))
        self.assertEqual(result["stat"], "NotOk")
        self.assertEqual(result["demoOrder"]["status"], "REJECTED")
        self.assertEqual(result["demoOrder"]["errorMessage"], "Order value 1,000 exceeds the max order value cap (500)")

    async def test_full_roundtrip_records_closed_position_and_audit(self):
        from api.demo import _execute_order, DemoPlaceOrderRequest, squareoff_dummy_position
        from services.dummy_extras import list_closed_positions, list_audit
        buy = await _execute_order(DemoPlaceOrderRequest(
            symbol="TCS", exchange="nse_cm", exchangeSegment="NSE_CM", token="1594",
            transactionType="BUY", product="MIS", orderType="MKT", quantity=5, ltp=200.0,
        ))
        self.assertEqual(buy["stat"], "Ok")
        sell = await squareoff_dummy_position("TCS", "MIS")
        self.assertEqual(sell["stat"], "Ok")
        closed = await list_closed_positions()
        self.assertEqual(len(closed), 1)
        self.assertEqual(closed[0]["symbol"], "TCS")
        self.assertEqual(closed[0]["quantity"], 5)
        audit = await list_audit(category="order", limit=100)
        self.assertTrue(any(a["action"] == "place" for a in audit))


class PnlReportsTest(unittest.IsolatedAsyncioTestCase):
    """Daily / weekly / monthly P&L reports read permanent MongoDB stores."""

    def setUp(self):
        self.db = FakeDB(app_settings=[], dummy_daily_sessions=[])
        self.patchers = [
            mock.patch("services.dummy_extras.get_db", return_value=self.db),
            mock.patch("api.demo.get_db", return_value=self.db),
        ]
        for p in self.patchers:
            p.start()
            self.addCleanup(p.stop)

    def _seed_session(self, trading_date, account, orders, status="CLOSED", starting=100000):
        self.db.dummy_daily_sessions._docs.append({
            "terminal": "dummy",
            "trading_date": trading_date,
            "status": status,
            "starting_capital": starting,
            "archive": {"account": account, "orders": orders,
                        "positions": [], "transactions": []},
        })

    async def test_daily_rows_from_archive(self):
        from services.dummy_extras import build_pnl_reports
        self._seed_session(
            "2026-02-02",
            {"balance": 101000, "realizedPnl": 1200, "totalCharges": 200},
            [{"orderId": "D1", "status": "COMPLETE",
              "averageTradedPrice": 100.0, "filledQuantity": 10},
             {"orderId": "D2", "status": "CANCELLED",
              "averageTradedPrice": 0, "filledQuantity": 0}],
        )
        res = await build_pnl_reports("daily", 60)
        self.assertEqual(res["range"], "daily")
        row = next(r for r in res["rows"] if r["date"] == "2026-02-02")
        self.assertEqual(row["realizedPnl"], 1200)
        self.assertEqual(row["charges"], 200)
        self.assertEqual(row["netPnl"], 1000)
        self.assertEqual(row["orders"], 2)
        self.assertEqual(row["filled"], 1)
        self.assertEqual(row["turnover"], 1000)
        self.assertEqual(row["closingBalance"], 101000)
        self.assertEqual(row["status"], "CLOSED")

    async def test_weekly_and_monthly_aggregation(self):
        from services.dummy_extras import build_pnl_reports
        self._seed_session(
            "2026-02-02",  # Monday
            {"balance": 101000, "realizedPnl": 1200, "totalCharges": 200},
            [{"orderId": "D1", "status": "COMPLETE",
              "averageTradedPrice": 100.0, "filledQuantity": 10}],
        )
        self._seed_session(
            "2026-02-04",  # Wednesday, same ISO week
            {"balance": 99500, "realizedPnl": -400, "totalCharges": 100},
            [{"orderId": "D3", "status": "COMPLETE",
              "averageTradedPrice": 50.0, "filledQuantity": 4}],
        )
        weekly = await build_pnl_reports("weekly", 26)
        feb_week = next(r for r in weekly["rows"] if r["days"] == 2)
        self.assertEqual(feb_week["realizedPnl"], 800)
        self.assertEqual(feb_week["charges"], 300)
        self.assertEqual(feb_week["netPnl"], 500)
        self.assertEqual(feb_week["orders"], 2)
        monthly = await build_pnl_reports("monthly", 26)
        feb = next(r for r in monthly["rows"] if r["key"] == "2026-02")
        self.assertEqual(feb["label"], "Feb 2026")
        self.assertEqual(feb["netPnl"], 500)
        self.assertEqual(feb["filled"], 2)

    async def test_session_counter_fallback_without_archive(self):
        from services.dummy_extras import build_pnl_reports
        self.db.dummy_daily_sessions._docs.append({
            "terminal": "dummy", "trading_date": "2026-02-09", "status": "CLOSED",
            "starting_capital": 100000, "realized_pnl": 700, "charges": 70,
            "order_count": 4, "trade_count": 3, "turnover": 5000,
            "available_capital": 100630,
        })
        res = await build_pnl_reports("daily", 60)
        row = next(r for r in res["rows"] if r["date"] == "2026-02-09")
        self.assertEqual(row["netPnl"], 630)
        self.assertEqual(row["orders"], 4)
        self.assertEqual(row["filled"], 3)


class DummyApiSurfaceTest(unittest.TestCase):
    def test_router_prefix_and_routes(self):
        from api.dummy import router
        self.assertEqual(router.prefix, "/api/dummy")
        paths = {r.path for r in router.routes}
        for expected in (
            "/api/dummy/state",
            "/api/dummy/portfolio",
            "/api/dummy/holdings",
            "/api/dummy/risk",
            "/api/dummy/history",
            "/api/dummy/market-session",
            "/api/dummy/calendar",
            "/api/dummy/baskets",
            "/api/dummy/baskets/execute",
            "/api/dummy/alerts",
            "/api/dummy/targets",
            "/api/dummy/notifications",
            "/api/dummy/prefs",
            "/api/dummy/order/modify",
            "/api/dummy/preview",
            "/api/dummy/positions",
            "/api/dummy/reports",
            "/api/dummy/comparison",
            "/api/dummy/audit",
            "/api/dummy/watchlists",
            "/api/dummy/calendar-events",
        ):
            self.assertIn(expected, paths)


class MarketCalendarTest(unittest.TestCase):
    def test_calendar_snapshot_uses_real_classifiers(self):
        from services.market_calendar import snapshot, is_trading_day, day_class
        snap = snapshot(now=datetime(2026, 1, 26, 4, 0, tzinfo=IST))  # Republic Day 2026 (Mon)
        self.assertFalse(snap["trading_day"])
        self.assertEqual(snap["day_class"], "EXCHANGE_HOLIDAY")
        self.assertEqual(snap["market_status"], "CLOSED")
        snap_open = snapshot(now=datetime(2026, 2, 3, 10, 0, tzinfo=IST))  # Tue, 10:00 IST
        self.assertTrue(snap_open["trading_day"])
        self.assertEqual(snap_open["market_status"], "OPEN")
        self.assertEqual(snap_open["market_session"], "OPEN")


if __name__ == "__main__":
    unittest.main()