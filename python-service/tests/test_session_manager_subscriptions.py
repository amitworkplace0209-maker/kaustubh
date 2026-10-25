"""Session Manager subscription-state tests (no live MongoDB required).

Covers the authoritative "what is subscribed" vocabulary on the Session
Manager:

- active ``stocks`` become DESIRED subscriptions (NOT_SUBSCRIBED until ack)
- removed / deactivated stocks become INACTIVE and leave the desired set
- pins are independent of subscriptions (a pin-only instrument is PINNED and
  still desired)
- broker acks flip NOT_SUBSCRIBED -> SUBSCRIBED (and SUBSCRIBED+PINNED when
  both a pin and an ack exist)
- real expiries produce EXPIRED (never fabricated) and are excluded from the
  broker desired set while still reported in the snapshot
- the snapshot exposes revision, counts, routing and per-instrument detail
- revision increments on every real state change

Run:  python -m pytest tests/test_session_manager_subscriptions.py -q
"""
from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)


class FakeStocks:
    def __init__(self, rows):
        self._rows = list(rows)

    def find(self, query=None, projection=None):
        return self

    async def to_list(self, length=None):
        return [dict(r) for r in self._rows]


class FakeDB:
    def __init__(self, stocks):
        self.stocks = FakeStocks(stocks)


def _stock(token, segment="nse_cm", symbol="", active=True):
    return {
        "instrumentToken": str(token),
        "exchangeSegment": segment,
        "symbol": symbol or f"SYM{token}",
        "tradingSymbol": symbol or f"SYM{token}",
        "active": active,
    }


class SubscriptionStateTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.db = FakeDB([_stock(1, symbol="RELIANCE"), _stock(2, symbol="HDFC")])
        self.get_db_patch = mock.patch(
            "database.connection.get_db", return_value=self.db
        )
        self.get_db_patch.start()
        self.addCleanup(self.get_db_patch.stop)
        from services.session.session_manager import CentralSessionManager
        self.mgr = CentralSessionManager()

    async def test_active_stocks_are_desired_until_ack(self):
        await self.mgr.refresh_desired_subscriptions(force=True)
        counts = self.mgr.subscription_counts()
        self.assertEqual(counts["desired"], 2)
        self.assertEqual(counts["not_subscribed"], 2)
        keys = self.mgr.subscription_desired_keys()
        self.assertEqual(len(keys), 2)
        self.assertTrue(any(k["instrument_token"] == "1" for k in keys))

    async def test_removed_stock_becomes_inactive_and_undesired(self):
        await self.mgr.refresh_desired_subscriptions(force=True)
        # stock 2 removed from the DB; stock 1 stays
        self.db.stocks = FakeStocks([_stock(1, symbol="RELIANCE")])
        await self.mgr.refresh_desired_subscriptions(force=True)
        counts = self.mgr.subscription_counts()
        self.assertEqual(counts["desired"], 1)
        self.assertEqual(counts["inactive"], 1)
        keys = self.mgr.subscription_desired_keys()
        self.assertFalse(any(k["instrument_token"] == "2" for k in keys))
        rows = self.mgr.subscription_snapshot()["instruments"]
        self.assertTrue(any(r["instrument_token"] == "2" and r["state"] == "INACTIVE"
                            for r in rows))

    async def test_pin_of_unlisted_instrument_is_pinned_and_desired(self):
        self.mgr.set_pin_intents([{
            "instrument_key": "nse_cm|999",
            "symbol": "PINCO",
            "source": "manual",
            "priority": 2,
            "profile_id": "PINNED_HIGH",
            "consumers": ["ai_pinned"],
            "reason": "test",
        }])
        counts = self.mgr.subscription_counts()
        self.assertEqual(counts["pinned"], 1)
        keys = self.mgr.subscription_desired_keys()
        self.assertTrue(any(k["instrument_token"] == "999" for k in keys))
        rows = self.mgr.subscription_snapshot()["instruments"]
        row = next(r for r in rows if r["instrument_token"] == "999")
        self.assertEqual(row["state"], "PINNED")

    async def test_broker_ack_sets_subscribed_then_pinned_combo(self):
        await self.mgr.refresh_desired_subscriptions(force=True)
        self.mgr.mark_broker_subscribed([{"instrument_token": "1", "exchange_segment": "nse_cm"}])
        counts = self.mgr.subscription_counts()
        self.assertEqual(counts["subscribed"], 1)
        rows = self.mgr.subscription_snapshot()["instruments"]
        self.assertEqual(next(r for r in rows if r["instrument_token"] == "1")["state"], "SUBSCRIBED")
        # now pin the same instrument -> SUBSCRIBED+PINNED
        self.mgr.set_pin_intents([{
            "instrument_key": "nse_cm|1",
            "symbol": "RELIANCE",
            "source": "manual",
        }])
        rows = self.mgr.subscription_snapshot()["instruments"]
        self.assertEqual(next(r for r in rows if r["instrument_token"] == "1")["state"],
                         "SUBSCRIBED+PINNED")
        self.assertEqual(self.mgr.subscription_counts()["subscribed"], 1)

    async def test_unsubscribe_returns_to_not_subscribed(self):
        await self.mgr.refresh_desired_subscriptions(force=True)
        self.mgr.mark_broker_subscribed([{"instrument_token": "1", "exchange_segment": "nse_cm"}])
        self.mgr.mark_broker_unsubscribed(
            [{"instrument_token": "1", "exchange_segment": "nse_cm"}], reason="test"
        )
        counts = self.mgr.subscription_counts()
        self.assertEqual(counts["subscribed"], 0)
        self.assertEqual(counts["not_subscribed"], 2)

    async def test_expired_is_reported_but_never_desired(self):
        await self.mgr.refresh_desired_subscriptions(force=True)
        self.mgr.expire_subscription(
            {"instrument_token": "1", "exchange_segment": "nse_cm", "symbol": "RELIANCE"},
            expires_at=1000000000.0,  # a real (past) expiry instant
        )
        counts = self.mgr.subscription_counts()
        self.assertEqual(counts["expired"], 1)
        keys = self.mgr.subscription_desired_keys()
        self.assertFalse(any(k["instrument_token"] == "1" for k in keys))
        rows = self.mgr.subscription_snapshot()["instruments"]
        row = next(r for r in rows if r["instrument_token"] == "1")
        self.assertEqual(row["state"], "EXPIRED")
        from services.session.session_manager import _iso
        self.assertEqual(row["expires_at"], _iso(1000000000.0))

    async def test_deactivated_never_desired(self):
        await self.mgr.refresh_desired_subscriptions(force=True)
        self.mgr.deactivate_subscription(
            {"instrument_token": "2", "exchange_segment": "nse_cm"}
        )
        counts = self.mgr.subscription_counts()
        self.assertEqual(counts["inactive"], 1)
        keys = self.mgr.subscription_desired_keys()
        self.assertFalse(any(k["instrument_token"] == "2" for k in keys))

    async def test_routing_and_required_fields(self):
        await self.mgr.refresh_desired_subscriptions(force=True)
        self.mgr.mark_subscription_routing("CONNECTED", owner="ws_manager")
        self.mgr.set_required_fields([{
            "instrument_token": "1",
            "exchange_segment": "nse_cm",
            "required_fields": ["ltp", "volume"],
        }])
        snap = self.mgr.subscription_snapshot()
        self.assertEqual(snap["routing"]["state"], "CONNECTED")
        self.assertEqual(snap["routing"]["owner"], "ws_manager")
        row = next(r for r in snap["instruments"] if r["instrument_token"] == "1")
        self.assertEqual(sorted(row["required_fields"]), ["ltp", "volume"])

    async def test_revision_increments_on_state_change(self):
        await self.mgr.refresh_desired_subscriptions(force=True)
        rev0 = self.mgr.subscription_counts()["revision"]
        self.mgr.mark_broker_subscribed([{"instrument_token": "1", "exchange_segment": "nse_cm"}])
        self.assertGreater(self.mgr.subscription_counts()["revision"], rev0)

    async def test_snapshot_shape(self):
        await self.mgr.refresh_desired_subscriptions(force=True)
        snap = self.mgr.subscription_snapshot()
        self.assertIn("revision", snap)
        self.assertIn("counts", snap)
        self.assertIn("routing", snap)
        self.assertIsInstance(snap["instruments"], list)
        for row in snap["instruments"]:
            for key in ("exchange_segment", "instrument_token", "instrument_key",
                        "symbol", "state", "desired", "active", "subscribed", "pin",
                        "expires_at", "routing", "required_fields", "last_update_at"):
                self.assertIn(key, row, key)

    async def test_depth_flag_enriched_from_instrument_master(self):
        # A stock doc persisted with stale/hardcoded isDepth False must still
        # become an L8 depth intent when the SANCTIONED instrument master says
        # the instrument is feedLevel=8 / isDepth=True.
        self.db.stocks = FakeStocks([_stock(2475, symbol="ONGC")])
        master_inst = {
            "token": "2475",
            "symbol": "ONGC",
            "feedLevel": 8,
            "isDepth": True,
            "isIndex": False,
            "marketData": "L8",
        }
        import services.instrument_cache as _ic
        with mock.patch.object(_ic.instrument_cache, "_loaded", True), \
             mock.patch.object(
                 _ic.instrument_cache, "lookup_by_token", return_value=master_inst
             ):
            await self.mgr.refresh_desired_subscriptions(force=True)
        keys = self.mgr.subscription_desired_keys()
        row = next(k for k in keys if k["instrument_token"] == "2475")
        self.assertTrue(row["isDepth"])
        self.assertEqual(row["feedLevel"], 8)
        self.assertEqual(row["marketData"], "L8")
        rows = self.mgr.subscription_snapshot()["instruments"]
        snap_row = next(r for r in rows if r["instrument_token"] == "2475")
        self.assertTrue(snap_row["is_depth"])
        self.assertEqual(snap_row["feed_level"], 8)
        self.assertEqual(snap_row["market_data"], "L8")

    async def test_depth_flag_kept_when_master_lookup_misses(self):
        # No master -> the equity STILL defaults to the L8 depth feed (the
        # market-data default is depth; L4 touch-line is no longer the feed).
        self.db.stocks = FakeStocks([_stock(1, symbol="RELIANCE")])
        import services.instrument_cache as _ic
        with mock.patch.object(_ic.instrument_cache, "_loaded", True), \
             mock.patch.object(
                 _ic.instrument_cache, "lookup_by_token", return_value=None
             ):
            await self.mgr.refresh_desired_subscriptions(force=True)
        row = next(k for k in self.mgr.subscription_desired_keys()
                   if k["instrument_token"] == "1")
        self.assertTrue(row["isDepth"])
        self.assertEqual(row["feedLevel"], 8)
        self.assertEqual(row["marketData"], "L8")


if __name__ == "__main__":
    unittest.main(verbosity=2)