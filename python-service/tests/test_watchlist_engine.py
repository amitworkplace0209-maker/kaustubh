"""Tests for the Watchlist Engine (docs/engines/watchlist-engine.md).

Covers state management, dedupe, the normalized stock-card model, 5/10-minute
metrics, live/stale/connecting status, dynamic ranking, screening and the
Connection Manager subscription contract.

Run:  python -m pytest tests/test_watchlist_engine.py -q
"""
from __future__ import annotations

import os
import sys
import time
import unittest
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from services.watchlist_engine import (  # noqa: E402
    WatchlistEngine,
    CARD_STATUS_CONNECTING,
    CARD_STATUS_DISCONNECTED,
    CARD_STATUS_LIVE,
    CARD_STATUS_STALE,
)


class _Patched:
    """Patch the canonical tick store + momentum for deterministic tests."""

    def __init__(self, ticks=None, momentum=None):
        self.ticks = ticks or {}
        self.momentum = momentum or {}

    def __enter__(self):
        self._t = mock.patch("services.tick_buffer.get_latest_ticks", return_value=self.ticks)
        self._m = mock.patch("services.tick_buffer.momentum_windows", side_effect=lambda tok, ltp: self.momentum.get(str(tok), {}))
        self._t.start()
        self._m.start()
        return self

    def __exit__(self, *exc):
        self._m.stop()
        self._t.stop()


class WatchlistStateTest(unittest.TestCase):
    def setUp(self):
        self.we = WatchlistEngine()
        self.we.add_stock("my-stocks", "RELIANCE", "2885")
        self.we.add_stock("my-stocks", "TCS", "11536")

    def test_add_and_list(self):
        self.assertEqual(len(self.we.get_watchlist("my-stocks")), 2)

    def test_duplicate_rejected(self):
        result = self.we.add_stock("my-stocks", "RELIANCE", "2885")
        self.assertFalse(result["ok"])
        self.assertEqual(len(self.we.get_watchlist("my-stocks")), 2)

    def test_remove(self):
        self.assertTrue(self.we.remove_stock("my-stocks", "2885")["ok"])
        self.assertEqual(len(self.we.get_watchlist("my-stocks")), 1)

    def test_create_rename_delete(self):
        created = self.we.create_watchlist("Banking", watchlist_id="banking")
        self.assertTrue(created["ok"])
        self.assertTrue(self.we.rename_watchlist("banking", "Banks")["ok"])
        self.assertTrue(self.we.delete_watchlist("banking")["ok"])
        self.assertNotIn("banking", self.we.list_watchlists())

    def test_cannot_delete_default(self):
        self.assertFalse(self.we.delete_watchlist("my-stocks")["ok"])

    def test_reorder(self):
        self.we.reorder("my-stocks", ["11536", "2885"])
        tokens = [s["token"] for s in self.we.get_watchlist("my-stocks")]
        self.assertEqual(tokens, ["11536", "2885"])


class WatchlistCardTest(unittest.TestCase):
    def setUp(self):
        self.we = WatchlistEngine()
        self.we.add_stock("my-stocks", "RELIANCE", "2885", exchange="nse_cm")

    def test_no_live_data_is_disconnected_and_never_fake(self):
        with _Patched():
            card = self.we.get_cards("my-stocks")[0]
        self.assertIsNone(card["ltp"])
        self.assertEqual(card["status"], CARD_STATUS_DISCONNECTED)

    def test_connecting_when_session_active(self):
        with _Patched():
            with mock.patch("auth.kotak_client.kotak_session") as ks:
                ks.session_active = True
                card = self.we.get_cards("my-stocks")[0]
        self.assertEqual(card["status"], CARD_STATUS_CONNECTING)

    def test_live_card_fields_and_metrics(self):
        tick = {"ltp": 2500.0, "prevClose": 2400.0, "volume": 1000,
                "bp": 2499.5, "sp": 2500.5, "receivedAt": time.time()}
        with _Patched(ticks={"2885": tick}, momentum={"2885": {"5m": 0.42, "10m": 0.71}}):
            card = self.we.get_cards("my-stocks")[0]
        self.assertEqual(card["status"], CARD_STATUS_LIVE)
        self.assertEqual(card["ltp"], 2500.0)
        self.assertEqual(card["change"], 100.0)
        self.assertAlmostEqual(card["changePercent"], 100.0 / 2400.0 * 100, places=3)
        self.assertEqual(card["bid"], 2499.5)
        self.assertEqual(card["ask"], 2500.5)
        self.assertAlmostEqual(card["spread"], 1.0, places=4)
        self.assertEqual(card["fiveMinPercent"], 0.42)
        self.assertEqual(card["tenMinPercent"], 0.71)

    def test_stale_status(self):
        tick = {"ltp": 100.0, "receivedAt": time.time() - 120}
        with _Patched(ticks={"2885": tick}):
            card = self.we.get_cards("my-stocks")[0]
        self.assertEqual(card["status"], CARD_STATUS_STALE)


class WatchlistRankingTest(unittest.TestCase):
    def setUp(self):
        self.we = WatchlistEngine()
        self.we.add_stock("my-stocks", "A", "1")
        self.we.add_stock("my-stocks", "B", "2")
        self.we.add_stock("my-stocks", "C", "3")
        now = time.time()
        self.ticks = {
            "1": {"ltp": 110.0, "prevClose": 100.0, "receivedAt": now},
            "2": {"ltp": 90.0, "prevClose": 100.0, "receivedAt": now},
            "3": {"ltp": 105.0, "prevClose": 100.0, "receivedAt": now},
        }

    def test_top_gainers_sorted(self):
        with _Patched(ticks=self.ticks):
            ranked = self.we.dynamic_list("top_gainers", limit=10)
        self.assertEqual([c["symbol"] for c in ranked], ["A", "C", "B"])

    def test_top_losers_sorted(self):
        with _Patched(ticks=self.ticks):
            ranked = self.we.dynamic_list("top_losers", limit=10)
        self.assertEqual(ranked[0]["symbol"], "B")

    def test_price_losers_uses_absolute_change(self):
        with _Patched(ticks=self.ticks):
            ranked = self.we.dynamic_list("price_losers", limit=10)
        self.assertEqual(ranked[0]["symbol"], "B")

    def test_movers_up_threshold(self):
        with _Patched(ticks=self.ticks):
            ranked = self.we.dynamic_list("movers_up", limit=10)
        self.assertEqual([c["symbol"] for c in ranked], ["A", "C"])

    def test_m5_gainers_uses_five_min_metric(self):
        momentum = {"1": {"5m": 0.1}, "2": {"5m": 0.9}, "3": {"5m": 0.5}}
        with _Patched(ticks=self.ticks, momentum=momentum):
            ranked = self.we.dynamic_list("m5_gainers", limit=10)
        self.assertEqual([c["symbol"] for c in ranked], ["B", "C", "A"])

    def test_screen_and_rules(self):
        rules = [{"field": "changePercent", "op": "gt", "value": 1.0}]
        with _Patched(ticks=self.ticks):
            matched = self.we.screen(rules, limit=10)
        self.assertEqual([c["symbol"] for c in matched], ["A", "C"])


class WatchlistSubscriptionTest(unittest.TestCase):
    def test_desired_subscriptions_deduped(self):
        we = WatchlistEngine()
        we.add_stock("my-stocks", "RELIANCE", "2885")
        we.create_watchlist("Intraday", watchlist_id="intraday")
        we.add_stock("intraday", "RELIANCE", "2885")
        we.add_stock("intraday", "TCS", "11536")
        subs = we.desired_subscriptions()
        tokens = sorted(s["token"] for s in subs)
        self.assertEqual(tokens, ["11536", "2885"])

    def test_active_tokens(self):
        we = WatchlistEngine()
        we.add_stock("my-stocks", "RELIANCE", "2885")
        self.assertEqual(we.active_tokens(), {"2885"})


if __name__ == "__main__":
    unittest.main()
