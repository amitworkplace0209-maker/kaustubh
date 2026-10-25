"""Demo positions day-rollover tests — no live MongoDB.

One trading date per page: prior-date open intraday (MIS/CO/BO) positions are
auto-settled into the closed trail (AUTO_DAY_ROLLOVER, backdated to their own
date) while today's opens, delivery legs and legacy unstamped positions are
kept. Closed reads are scoped to one trading date.

Run:  python -m pytest tests/test_demo_positions_rollover.py -q
"""
import unittest
from unittest import mock


class FakeCollection:
    """Minimal async Mongo lookalike for app_settings key/value docs."""

    def __init__(self):
        self.docs = {}

    async def find_one(self, filt):
        return self.docs.get(filt.get("key"))

    async def update_one(self, filt, update, upsert=False):
        key = filt.get("key")
        doc = self.docs.get(key, {"key": key})
        doc.update(update.get("$set", {}))
        self.docs[key] = doc
        return {"ok": True}


class FakeDB:
    def __init__(self):
        self.app_settings = FakeCollection()


def _pos(symbol, product, qty, date, avg=100.0, ltp=110.0):
    return {
        "id": f"{symbol}_{product}_1",
        "symbol": symbol,
        "tradingSymbol": symbol,
        "exchange": "nse_cm",
        "exchangeSegment": "NSE_CM",
        "token": "9999",
        "product": product,
        "side": "LONG" if qty > 0 else "SHORT",
        "netQuantity": qty,
        "buyQuantity": qty if qty > 0 else 0,
        "sellQuantity": 0 if qty > 0 else -qty,
        "averageBuyPrice": avg if qty > 0 else 0,
        "averageSellPrice": 0 if qty > 0 else avg,
        "ltp": ltp,
        "realizedPnl": 0,
        "unrealizedPnl": 0,
        **({"tradingDate": date} if date else {}),
    }


class RolloverTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import api.demo as demo

        self.demo = demo
        self.fakedb = FakeDB()
        self.fakedb.app_settings.docs[demo.DEMO_ACCOUNT_KEY] = {
            "key": demo.DEMO_ACCOUNT_KEY,
            "value": {
                "balance": 100000, "usedMargin": 0, "freeMargin": 100000,
                "totalPnl": 0, "totalCharges": 0, "realizedPnl": 0,
                "unrealizedPnl": 0, "dailyOrders": 0,
            },
        }
        self._get_db = mock.patch.object(demo, "get_db", return_value=self.fakedb)
        self._get_db.start()
        self._today = mock.patch.object(
            demo, "_positions_trading_today", return_value="2026-10-08")
        self._today.start()
        self.closed_records = []

        async def _record(**kw):
            rec = dict(kw)
            # mirror the real function: tradingDate derived from closed_at
            from services.dummy_extras import trading_date
            rec["tradingDate"] = trading_date(kw["closed_at"])
            self.closed_records.append(rec)
            return rec

        self._record = mock.patch(
            "services.dummy_extras.record_closed_position", side_effect=_record)
        self._record.start()

    async def asyncTearDown(self):
        mock.patch.stopall()

    def _seed_positions(self, positions):
        self.fakedb.app_settings.docs[self.demo.DEMO_POSITIONS_KEY] = {
            "key": self.demo.DEMO_POSITIONS_KEY, "value": positions,
        }

    async def test_stale_mis_rolled_to_own_date(self):
        self._seed_positions([_pos("RELIANCE", "MIS", 10, "2026-10-07")])
        res = await self.demo.rollover_demo_positions("2026-10-08")
        self.assertEqual(res["rolled"], 1)
        self.assertEqual(res["symbols"], ["RELIANCE"])
        # (110-100)*10
        self.assertEqual(res["realized"], 100.0)
        # open list is clean
        self.assertEqual(await self.demo.get_dummy_positions(), [])
        # closed trail keeps the PREVIOUS date (never leaks into today)
        self.assertEqual(len(self.closed_records), 1)
        rec = self.closed_records[0]
        self.assertEqual(rec["reason"], "AUTO_DAY_ROLLOVER")
        self.assertEqual(rec["tradingDate"], "2026-10-07")
        self.assertEqual(rec["realized_pnl"], 100.0)

    async def test_today_open_and_delivery_kept(self):
        self._seed_positions([
            _pos("TCS", "MIS", 5, "2026-10-08"),
            _pos("INFY", "CNC", 5, "2026-10-07"),
            _pos("HDFCBANK", "NRML", -3, "2026-10-07"),
        ])
        res = await self.demo.rollover_demo_positions("2026-10-08")
        self.assertEqual(res["rolled"], 0)
        self.assertEqual(self.closed_records, [])
        remaining = await self.demo.get_dummy_positions()
        self.assertEqual(
            sorted(p["symbol"] for p in remaining), ["HDFCBANK", "INFY", "TCS"])

    async def test_legacy_unstamped_kept_and_stamped(self):
        self._seed_positions([_pos("SBIN", "MIS", 2, None)])
        res = await self.demo.rollover_demo_positions("2026-10-08")
        self.assertEqual(res["rolled"], 0)
        remaining = await self.demo.get_dummy_positions()
        self.assertEqual(len(remaining), 1)
        self.assertEqual(remaining[0]["tradingDate"], "2026-10-08")

    async def test_lazy_rollover_on_read(self):
        self._seed_positions([_pos("RELIANCE", "MIS", 10, "2026-10-07")])
        rows = await self.demo.get_dummy_positions()
        self.assertEqual(rows, [])
        self.assertEqual(len(self.closed_records), 1)

    async def test_idempotent_second_run(self):
        self._seed_positions([_pos("RELIANCE", "MIS", 10, "2026-10-07")])
        await self.demo.rollover_demo_positions("2026-10-08")
        res = await self.demo.rollover_demo_positions("2026-10-08")
        self.assertEqual(res["rolled"], 0)
        self.assertEqual(len(self.closed_records), 1)


class NoGhostRowsTest(unittest.IsolatedAsyncioTestCase):
    """One order in exactly one place: a full close must remove the row from
    stored positions (in-place, so the caller's later save cannot resurrect
    it), and reads must never serve zero-net rows as open."""

    async def asyncSetUp(self):
        import api.demo as demo
        import services.dummy_session as ds

        self.demo = demo
        self.fakedb = FakeDB()
        self.fakedb.app_settings.docs[demo.DEMO_ACCOUNT_KEY] = {
            "key": demo.DEMO_ACCOUNT_KEY,
            "value": {
                "balance": 100000, "usedMargin": 100000, "freeMargin": 0,
                "totalPnl": 0, "totalCharges": 0, "realizedPnl": 0,
                "unrealizedPnl": 0, "dailyOrders": 0,
            },
        }
        self._get_db = mock.patch.object(demo, "get_db", return_value=self.fakedb)
        self._get_db.start()
        self._today = mock.patch.object(
            demo, "_positions_trading_today", return_value="2026-10-07")
        self._today.start()
        # Also patch dummy_session to return the test date for tradingDate stamps
        self._ds_date = mock.patch.object(ds, "session_date_for", return_value="2026-10-07")
        self._ds_date.start()
        self.closed_records = []

        async def _record(**kw):
            self.closed_records.append(dict(kw))
            return kw

        self._record = mock.patch(
            "services.dummy_extras.record_closed_position", side_effect=_record)
        self._record.start()

    async def asyncTearDown(self):
        mock.patch.stopall()

    async def test_full_close_removes_row_in_place(self):
        # BUY 10 then SELL 10 through the real fill path with margin disabled.
        from api.demo import DemoPlaceOrderRequest

        async def _orders():
            return []

        async def _save_orders(orders):
            return None

        with mock.patch.object(self.demo, "get_dummy_orders", side_effect=_orders), \
             mock.patch.object(self.demo, "_save_orders", side_effect=_save_orders), \
             mock.patch.object(self.demo, "_publish_order_frame", return_value=None), \
             mock.patch.object(self.demo, "_term_notify", return_value=None), \
             mock.patch.object(self.demo, "margin_per_share", return_value=0.0):
            buy = DemoPlaceOrderRequest(
                symbol="RELIANCE", tradingSymbol="RELIANCE-EQ", exchange="nse_cm",
                exchangeSegment="NSE_CM", token="2885", transactionType="BUY",
                product="MIS", orderType="MKT", quantity=10, price=0,
                triggerPrice=0, disclosedQty=0, validity="DAY", source="MANUAL",
                ltp=100.0, amount=0, lotSize=1, marginPerShare=0,
            )
            positions = await self.demo.get_dummy_positions()
            account = await self.demo.get_dummy_account()
            await self.demo._apply_fill(
                buy, {"price": 100.0, "fill": 10}, [], positions, account)
            await self.demo._save_positions(positions)
            self.assertEqual(len(positions), 1)

            sell = DemoPlaceOrderRequest(
                symbol="RELIANCE", tradingSymbol="RELIANCE-EQ", exchange="nse_cm",
                exchangeSegment="NSE_CM", token="2885", transactionType="SELL",
                product="MIS", orderType="MKT", quantity=10, price=0,
                triggerPrice=0, disclosedQty=0, validity="DAY", source="MANUAL",
                ltp=110.0, amount=0, lotSize=1, marginPerShare=0,
            )
            await self.demo._apply_fill(
                sell, {"price": 110.0, "fill": 10}, [], positions, account)
            # In-place removal: the caller's list must be empty BEFORE save.
            self.assertEqual(positions, [])
            await self.demo._save_positions(positions)
            stored = self.fakedb.app_settings.docs[
                self.demo.DEMO_POSITIONS_KEY]["value"]
            self.assertEqual(stored, [])
            self.assertEqual(len(self.closed_records), 1)

    async def test_concurrent_squareoff_single_close(self):
        """Two simultaneous square-offs: exactly one fill, one trail entry,
        second gets an honest failure — never a double close or a reverse leg."""
        import asyncio

        from api.demo import DemoPlaceOrderRequest

        async def _noop(*a, **k):
            return None

        with mock.patch.object(self.demo, "get_dummy_orders", return_value=[]), \
             mock.patch.object(self.demo, "_save_orders", side_effect=_noop), \
             mock.patch.object(self.demo, "_publish_order_frame", return_value=None), \
             mock.patch.object(self.demo, "_term_notify", return_value=None), \
             mock.patch.object(self.demo, "margin_per_share", return_value=0.0):
            buy = DemoPlaceOrderRequest(
                symbol="TCS", tradingSymbol="TCS", exchange="nse_cm",
                exchangeSegment="NSE_CM", token="11536", transactionType="BUY",
                product="MIS", orderType="MKT", quantity=5, price=0,
                triggerPrice=0, disclosedQty=0, validity="DAY", source="MANUAL",
                ltp=100.0, amount=0, lotSize=1, marginPerShare=0,
            )
            positions = await self.demo.get_dummy_positions()
            account = await self.demo.get_dummy_account()
            await self.demo._apply_fill(
                buy, {"price": 100.0, "fill": 5}, [], positions, account)
            await self.demo._save_positions(positions)

            from fastapi import HTTPException

            results = await asyncio.gather(
                self.demo.squareoff_dummy_position("TCS", "MIS"),
                self.demo.squareoff_dummy_position("TCS", "MIS"),
                return_exceptions=True,
            )
            oks = [r for r in results if not isinstance(r, Exception)]
            fails = [r for r in results if isinstance(r, HTTPException)]
            self.assertEqual(len(oks), 1)
            self.assertEqual(len(fails), 1)
            self.assertEqual(fails[0].status_code, 404)
            self.assertEqual(len(self.closed_records), 1)
            self.assertEqual(await self.demo.get_dummy_positions(), [])

    async def test_trail_idempotent_per_order(self):
        """Same order id recorded twice collapses to one trail entry."""
        # Drop the class-level record_closed_position stub: this test drives
        # the real function against a fake doc store.
        mock.patch.stopall()
        import services.dummy_extras as dex

        store: dict = {}

        async def _get_doc(key, default):
            return list(store.get(key, default))

        async def _set_doc(key, value):
            store[key] = value

        with mock.patch.object(dex, "_get_doc", side_effect=_get_doc), \
             mock.patch.object(dex, "_set_doc", side_effect=_set_doc):
            kw = dict(symbol="X", trading_symbol="X", exchange="nse_cm",
                      exchange_segment="NSE_CM", token="1", product="MIS",
                      side="LONG", quantity=2, average_price=10.0,
                      exit_price=11.0, realized_pnl=2.0, charges=0.1,
                      reason="EXECUTED", order_id="ORD1")
            first = await dex.record_closed_position(**kw)
            second = await dex.record_closed_position(**kw)
            self.assertEqual(first["id"], second["id"])
            self.assertEqual(len(store[dex.KEY_CLOSED_POSITIONS]), 1)

    async def test_ghost_purge_on_read(self):
        ghost = {
            "id": "X_MIS_1", "symbol": "X", "product": "MIS", "netQuantity": 0,
            "tradingDate": "2026-10-07",
        }
        self.fakedb.app_settings.docs[self.demo.DEMO_POSITIONS_KEY] = {
            "key": self.demo.DEMO_POSITIONS_KEY, "value": [ghost],
        }
        rows = await self.demo.get_dummy_positions()
        self.assertEqual(rows, [])
        stored = self.fakedb.app_settings.docs[
            self.demo.DEMO_POSITIONS_KEY]["value"]
        self.assertEqual(stored, [])


class ClosedDateScopeTest(unittest.IsolatedAsyncioTestCase):
    async def test_closed_scoped_to_date(self):
        import services.dummy_extras as dex

        store = {
            dex.KEY_CLOSED_POSITIONS: [
                {"id": "c1", "symbol": "A", "tradingDate": "2026-10-08"},
                {"id": "c2", "symbol": "B", "tradingDate": "2026-10-07"},
            ]
        }

        async def _get_doc(key, default):
            return store.get(key, default)

        async def _set_doc(key, value):
            store[key] = value

        with mock.patch.object(dex, "_get_doc", side_effect=_get_doc), \
             mock.patch.object(dex, "_set_doc", side_effect=_set_doc):
            today_only = await dex.list_closed_positions(date="2026-10-08")
            self.assertEqual([c["id"] for c in today_only], ["c1"])
            everything = await dex.list_closed_positions()
            self.assertEqual(len(everything), 2)


if __name__ == "__main__":
    unittest.main()
