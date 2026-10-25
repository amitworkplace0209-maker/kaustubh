"""Data Saver ``watch_scan`` full-market-scan channel — unit tests.

Covers, WITHOUT heavy deps:

  * ``tick_buffer.window_moves`` — TRUE window-boundary maths (the base price
    is the newest tick at least ``window`` old, not the oldest buffered tick),
    unwarm tokens stay absent, and unmeasurable windows are pairwise absent
    (never a fabricated near-zero move);
  * ``services.market_scan`` — a document built purely from seeded feed
    state: honest Nones for tokens without a tick, real breadth counts, real
    window movers, and the WS summary that carries no heavy ``rows``;
  * ``connection_engine.snapshots`` — the ``watch_scan`` channel registration,
    cadences, builder (serves the scan summary), and the state signature:
    per-strip ltp changes must NOT change it (they ride the batteries re-push
    + per-token overlay) while breadth counts / mover membership / index
    availability MUST.

Run:  python -m pytest tests/test_market_scan_channel.py -q
"""
from __future__ import annotations

import os
import sys
import unittest
from copy import deepcopy
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from services import tick_buffer
from services.market_scan import market_scan
from connection_engine import snapshots as snapshot_mod
from connection_engine.channels import STATE_CHANNELS

TOK_A = "26000"   # NIFTY-shaped token for meta rows
TOK_B = "12345"
TOK_C = "67890"


def _uni() -> dict:
    return {
        TOK_A: {"symbol": "NIFTY", "name": "Nifty 50 Index", "tradingSymbol": "NIFTY", "segment": "nse_cm"},
        TOK_B: {"symbol": "TICKETA", "name": "Ticket Alpha Ltd", "tradingSymbol": "TICKETA", "segment": "nse_cm"},
        TOK_C: {"symbol": "TICKETB", "name": "Ticket Beta Ltd", "tradingSymbol": "TICKETB", "segment": "nse_cm"},
    }


class WindowMoveMathTests(unittest.TestCase):
    """Pure tick_buffer window maths on seeded (age → ltp) real shapes."""

    def setUp(self) -> None:
        tick_buffer.seed_price_history("A", [(0, 100.0), (70, 99.0), (350, 101.0)])
        # B: newest tick (age 0) = 207, decaying 0.5/step backwards every 90s
        tick_buffer.seed_price_history("B", [(i * 90.0, 207.0 - i * 0.5) for i in range(15)])
        tick_buffer.seed_price_history("C", [(0, 250.0)])  # unwarm: 1 point

    def tearDown(self) -> None:
        with tick_buffer._PRICE_HISTORY_LOCK:
            for key in ("A", "B", "C"):
                tick_buffer._price_history.pop(key, None)

    def test_window_boundary_is_the_newest_tick_at_least_window_old(self):
        moves = tick_buffer.window_moves(tokens=["A"])
        one = moves["A"]["1m"]
        five = moves["A"]["5m"]
        # price 1m ago = 99 (70s old)  →  +1.0101%
        self.assertAlmostEqual(one["pct"], 1.0101, places=3)
        self.assertEqual(one["base"], 99.0)
        # price 5m ago = 101 (350s old) →  -0.9901%
        self.assertAlmostEqual(five["pct"], -0.9901, places=3)
        self.assertEqual(five["base"], 101.0)
        # history is only 350s deep — a 10m window is NOT measurable (no fake 0)
        self.assertNotIn("10m", moves["A"])

    def test_unwarm_tokens_are_absent_and_depth_is_reported(self):
        moves = tick_buffer.window_moves(tokens=["C"])
        self.assertNotIn("C", moves)
        depth = tick_buffer.history_depth_seconds()
        self.assertIsNotNone(depth)
        self.assertGreaterEqual(depth, 350.0)

    def test_multi_token_single_pass(self):
        moves = tick_buffer.window_moves(tokens=["A", "B"])
        self.assertIn("A", moves)
        self.assertIn("B", moves)
        # B: 15 points every 90s, current 207.0, 10m ago (630s back) = 203.5
        ten = moves["B"]["10m"]
        self.assertAlmostEqual(ten["pct"], ((207.0 - 203.5) / 203.5) * 100.0, places=3)


class ScanDocumentTests(unittest.TestCase):
    """Full document built from seeded feed state (universe mocked to 3 rows)."""

    def setUp(self) -> None:
        tick_buffer.seed_price_history(TOK_A, [(0, 100.0), (70, 99.0), (350, 101.0)])
        tick_buffer.seed_price_history(TOK_B, [(0, 50.0), (65, 49.0), (400, 52.0)])
        # TOK_C: no ticks at all — every price field must stay None (honest —)
        self._populate_latest()
        self.doc = self._compute()

    def tearDown(self) -> None:
        with tick_buffer._PRICE_HISTORY_LOCK:
            for key in (TOK_A, TOK_B, TOK_C):
                tick_buffer._price_history.pop(key, None)
        tick_buffer._latest_ticks.clear()

    def _populate_latest(self) -> None:
        tick_buffer._latest_ticks[TOK_A] = {
            "ltp": 100.0, "close": 98.5, "open": 99.0, "high": 101.5, "low": 97.5,
            "volume": 123456, "bp": 99.9, "sp": 100.1,
        }
        tick_buffer._latest_ticks[TOK_B] = {"ltp": 50.0, "close": 51.0}

    def _compute(self) -> dict:
        with mock.patch.object(market_scan, "_universe", new=_uni):
            return market_scan.compute()

    def test_rows_are_honest(self):
        by_token = {r["token"]: r for r in self.doc["rows"]}
        a = by_token.get(TOK_A) or {}
        self.assertEqual(len(self.doc["rows"]), 3)
        # A: real feed → real day change (+1.52% over prev close 98.5)
        self.assertEqual(a.get("dayChangePct"), 1.5228)  # type: ignore[arg-type]
        self.assertEqual(a.get("status"), "stale")       # no receivedAt → stale, not live
        # window moves are present for the seeded history
        self.assertAlmostEqual(a.get("pct1m"), 1.0101, places=3)
        self.assertAlmostEqual(a.get("chg1m"), 1.0, places=3)
        # C: NO feed → every measured field is None (the UI renders —)
        c = by_token[TOK_C]
        self.assertIsNone(c["ltp"])
        self.assertIsNone(c["dayChangePct"])
        self.assertIsNone(c["dayChange"])
        self.assertEqual(c["status"], "no_data")
        self.assertIsNone(c["pct1m"])
        self.assertIsNone(c["pct10m"])

    def test_breadth_counts_measured_rows_only(self):
        b = self.doc["breadth"]
        # A: +1.52% (advance, ≥1% up), B: −1.96% (decline, ≥1% down), C: unmeasurable
        self.assertEqual(b["measurable"], 2)
        self.assertEqual(b["advances"], 1)
        self.assertEqual(b["declines"], 1)
        self.assertEqual(b["pct1Up"], 1)
        self.assertEqual(b["pct1Down"], 1)

    def test_movers_membership_by_strip(self):
        m = self.doc["movers"]
        self.assertEqual([r["token"] for r in m["dayUpPct"]], [TOK_A])
        self.assertEqual([r["token"] for r in m["dayDownPct"]], [TOK_B])
        # 1m movers: A +1.0101%, B +2.0408% (both up — B ahead of A)
        self.assertEqual([r["token"] for r in m["m1mUp"]], [TOK_B, TOK_A])
        self.assertEqual(m["m1mDown"], [])
        # window movers carry the strip fields the UI chips need
        self.assertAlmostEqual(m["m1mUp"][0]["stripPct"], 2.0408, places=3)
        self.assertAlmostEqual(m["m1mUp"][0]["stripChg"], 1.0, places=3)

    def test_summary_has_no_rows_block(self):
        summary = market_scan.summary_copy()
        self.assertNotIn("rows", summary)
        self.assertIn("breadth", summary)
        self.assertIn("movers", summary)
        self.assertIn("scan", summary)
        self.assertIn("indexes", summary)

    def test_scan_meta_is_real(self):
        s = self.doc["scan"]
        self.assertEqual(s["universeSize"], 3)
        # liveTokens counts price histories with ≥2 real points (A,B warm; C is 1-pt unwarm)
        self.assertEqual(s["liveTokens"], 2)
        self.assertIn(s["feed"], {"idle", "stale", "live"})
        self.assertEqual(s["source"], "backend WS tick store (tick_buffer) — no third-party fetch")


class WatchScanChannelTests(unittest.IsolatedAsyncioTestCase):
    """Channel registration + signature + builder semantics (async builder)."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.summary = {
            "generatedAt": "2026-10-25T06:00:00Z",
            "scan": {"generatedAt": "2026-10-25T06:00:00Z", "cadenceSeconds": 10.0,
                     "universeSize": 2600, "liveTokens": 512, "historyDepthSeconds": 700.0,
                     "feed": "live", "cycleMs": 180.0},
            "indexes": [
                {"name": "NIFTY", "token": "26000", "ltp": 25000.0, "dayChange": 150.0,
                 "dayChangePct": 0.6, "quality": "OK", "lastTickAt": "2026-10-25T10:00:00Z"},
                {"name": "SENSEX", "token": "", "ltp": None, "dayChange": None,
                 "dayChangePct": None, "quality": "UNAVAILABLE", "lastTickAt": None},
            ],
            "breadth": {"measurable": 1800, "advances": 900, "declines": 800, "unchanged": 100,
                        "pct1Up": 120, "pct1Down": 90, "pct2Up": 40, "pct2Down": 30,
                        "pct3Up": 12, "pct3Down": 9, "pct5Up": 3, "pct5Down": 2},
            "windows": {"1m": {"measurable": 1800, "up1": 35, "down1": 22}},
            "movers": {
                "dayUpPct": [{"token": "1"}, {"token": "2"}],
                "dayDownPct": [{"token": "3"}],
            },
        }

    def test_channel_registered_with_snapshot_and_cadence(self):
        self.assertIn("watch_scan", STATE_CHANNELS)
        self.assertTrue(snapshot_mod.supports_snapshot("watch_scan"))
        self.assertEqual(snapshot_mod.CHANNEL_REFRESH_INTERVALS.get("watch_scan"), 5.0)
        self.assertEqual(snapshot_mod.CHANNEL_FORCE_REFRESH_INTERVALS.get("watch_scan"), 10.0)

    def _sig(self, doc: dict) -> str:
        return snapshot_mod.channel_signature("watch_scan", doc)

    def test_signature_ignores_ltp_and_counts_real_state(self):
        base = deepcopy(self.summary)

        # ltp-only churn across strips/indexes → same signature (rides re-push)
        volatile = deepcopy(base)
        volatile["indexes"][0]["ltp"] = 25123.0
        volatile["movers"]["dayUpPct"][0]["ltp"] = 999.0
        volatile["movers"]["dayUpPct"][0]["stripPct"] = 12.345
        volatile["scan"]["cycleMs"] = 400.0
        volatile["scan"]["historyDepthSeconds"] = 720.0
        volatile["generatedAt"] = "2026-10-25T06:00:05Z"
        self.assertEqual(self._sig(base), self._sig(volatile))

        # breadth crossing counts are real changes
        d2 = deepcopy(base)
        d2["breadth"]["pct1Up"] = 121
        self.assertNotEqual(self._sig(base), self._sig(d2))

        # mover membership reshuffle is a real change
        d3 = deepcopy(base)
        d3["movers"]["dayDownPct"].append({"token": "9"})
        self.assertNotEqual(self._sig(base), self._sig(d3))

        # index availability is a real change
        d4 = deepcopy(base)
        d4["indexes"][1]["ltp"] = 81000.0
        self.assertNotEqual(self._sig(base), self._sig(d4))

        # window mover count is a real change
        d5 = deepcopy(base)
        d5["windows"]["1m"]["up1"] = 36
        self.assertNotEqual(self._sig(base), self._sig(d5))

    async def test_builder_serves_scan_summary_without_rows(self):
        fake = dict(self.summary)
        fake["rows"] = [{"token": "1", "ltp": 1.0}]
        with mock.patch.object(market_scan, "_doc", fake), \
             mock.patch.object(market_scan, "wait_document",
                               mock.AsyncMock(return_value=fake)):
            doc = await snapshot_mod.build_snapshot("watch_scan")
            self.assertIsNotNone(doc)
            self.assertNotIn("rows", doc)
            self.assertIn("breadth", doc)

    async def test_builder_returns_none_when_no_scan_yet(self):
        with mock.patch.object(market_scan, "wait_document",
                               mock.AsyncMock(return_value=None)):
            self.assertIsNone(await snapshot_mod.build_snapshot("watch_scan"))


if __name__ == "__main__":
    unittest.main()
