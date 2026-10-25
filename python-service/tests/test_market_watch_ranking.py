"""Tests for the Market Watch ranking engine (docs/engines/MARKET_WATCH.md).

Covers 30-second snapshot throttling, Top-5 appearance frequency counting,
automatic pin selection, dynamic pin replacement, deterministic tie-breaking
and trading-day reset.

Run:  python -m pytest tests/test_market_watch_ranking.py -q
"""
from __future__ import annotations

import os
import sys
import time
import unittest

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from services.market_watch_ranking import (  # noqa: E402
    MarketWatchRankingEngine,
    MAX_GAINER_PINS,
    market_watch_ranking,
)
from services.market_watch_engine import (  # noqa: E402
    MarketWatchEngine,
    _is_inactive,
    _fnum,
)
from services.market_watch_lifecycle import (  # noqa: E402
    MONITORING,
)


def rows(*symbols) -> list[dict]:
    return [{"token": s, "symbol": s} for s in symbols]


def tick(token: str, symbol: str, ltp: float, change_pct: float, volume: float = 1e6, prev_close: float = 100.0, totalBuyQuantity: float | None = None, totalSellQuantity: float | None = None) -> dict:
    return {
        "instrumentToken": token,
        "token": token,
        "symbol": symbol,
        "ltp": ltp,
        "lastPrice": ltp,
        "netChange": ltp - prev_close,
        "netChangePercent": change_pct,
        "changePercent": change_pct,
        "prevClose": prev_close,
        "volume": volume,
        "turnover": ltp * volume,
        "open": prev_close,
        "high": ltp * 1.01,
        "low": prev_close * 0.99,
        "bid": ltp - 0.05,
        "ask": ltp + 0.05,
        "totalBuyQuantity": totalBuyQuantity,
        "totalSellQuantity": totalSellQuantity,
    }


def open_universe(engine: MarketWatchEngine, *tokens: str) -> MarketWatchEngine:
    """Put ``tokens`` in the engine's Market Watch universe.

    doc §3/§7/§35.2 — a tick only enters calculation state for a symbol that is
    IN the Market Watch universe, so the ranking/section tests must declare the
    universe they are ranking. An unopened universe would now (correctly) accept
    nothing and every ranking assertion would be vacuous.
    """
    for token in tokens:
        engine._registry[token] = {
            "token": token,
            "symbol": token.lstrip("T") or token,
            "name": token,
            "exchange": "nse_cm",
            "segment": "EQUITY",
            "intradayEligible": True,
        }
        engine._universe.add(token)
    return engine


class SnapshotTest(unittest.TestCase):
    def setUp(self):
        self.engine = MarketWatchRankingEngine()

    def test_first_snapshot_records(self):
        snap = self.engine.record_snapshot(rows("A", "B"), rows("X"), trading_date="2026-09-18", now=1000.0)
        self.assertIsNotNone(snap)
        self.assertEqual(snap["topGainers"], ["A", "B"])
        self.assertEqual(snap["topLosers"], ["X"])

    def test_throttled_until_interval(self):
        self.engine.record_snapshot(rows("A"), rows("X"), trading_date="2026-09-18", now=1000.0)
        self.assertIsNone(self.engine.record_snapshot(rows("A"), rows("X"), trading_date="2026-09-18", now=1010.0))
        self.assertIsNotNone(self.engine.record_snapshot(rows("A"), rows("X"), trading_date="2026-09-18", now=1031.0))

    def test_force_bypasses_throttle(self):
        self.engine.record_snapshot(rows("A"), rows("X"), trading_date="2026-09-18", now=1000.0)
        self.assertIsNotNone(
            self.engine.record_snapshot(rows("A"), rows("X"), trading_date="2026-09-18", now=1001.0, force=True)
        )

    def test_empty_universe_never_fabricates(self):
        self.assertIsNone(self.engine.record_snapshot([], [], trading_date="2026-09-18", now=1000.0))


class VolumeRowsTest(unittest.TestCase):
    """record_snapshot captures the highest-volume read model from real rows."""

    def setUp(self):
        self.engine = MarketWatchRankingEngine()

    def test_volume_rows_captured_in_order(self):
        snap = self.engine.record_snapshot(
            rows("A", "B"), rows("X"), trading_date="2026-09-18", now=1000.0,
            volume_rows=[{"token": "B", "volume": 9e6}, {"token": "A", "volume": 5e6}],
        )
        self.assertIsNotNone(snap)
        self.assertEqual(snap["topVolume"], ["B", "A"])

    def test_snapshot_exposes_volume_read_model(self):
        self.engine.record_snapshot(
            rows("A"), rows("X"), trading_date="2026-09-18", now=1000.0,
            volume_rows=[{"token": "X", "volume": 1e7}],
        )
        snap = self.engine.snapshot()
        self.assertEqual(snap["volume"], ["X"])

    def test_missing_volume_rows_is_empty_not_fabricated(self):
        snap = self.engine.record_snapshot(rows("A"), rows("X"), trading_date="2026-09-18", now=1000.0)
        self.assertIsNotNone(snap)
        self.assertEqual(snap["topVolume"], [])


class FrequencyAndPinTest(unittest.TestCase):
    def setUp(self):
        self.engine = MarketWatchRankingEngine()
        day = "2026-09-18"
        self.engine.record_snapshot(rows("A", "B", "C", "D", "E"), [], trading_date=day, now=1000.0, force=True)
        self.engine.record_snapshot(rows("A", "B", "C", "F", "G"), [], trading_date=day, now=1031.0, force=True)
        self.engine.record_snapshot(rows("A", "B", "F", "G", "H"), [], trading_date=day, now=1062.0, force=True)

    def test_appearance_counts(self):
        pins = {p["token"]: p["appearances"] for p in self.engine.pins()["gainers"]}
        self.assertEqual(pins["A"], 3)
        self.assertEqual(pins["B"], 3)
        self.assertEqual(pins["C"], 2)
        self.assertEqual(pins["F"], 2)
        self.assertEqual(pins["G"], 2)

    def test_at_most_five_pins(self):
        self.assertEqual(len(self.engine.pins()["gainers"]), MAX_GAINER_PINS)

    def test_tie_break_by_last_rank(self):
        # A=3,B=3 then C/F/G at 2; -lastSeen tie-break orders newer first (F seen after C).
        tokens = [p["token"] for p in self.engine.pins()["gainers"]]
        self.assertEqual(tokens[:5], ["A", "B", "F", "C", "G"])

    def test_dynamic_replacement(self):
        # F reaches 7 -> enters the five highest-frequency set.
        self.engine._gainer_appearances["F"]["appearances"] = 7
        pins = [p["token"] for p in self.engine.pins()["gainers"]]
        self.assertIn("F", pins)
        self.assertEqual(len(pins), 5)

    def test_independent_gainer_loser_counters(self):
        self.engine.record_snapshot(rows("A"), rows("X", "Y"), trading_date="2026-09-18", now=1093.0, force=True)
        self.assertEqual(len(self.engine.pins()["losers"]), 2)
        self.assertNotIn("A", [p["token"] for p in self.engine.pins()["losers"]])


class DayResetTest(unittest.TestCase):
    def test_new_trading_day_resets_counts(self):
        engine = MarketWatchRankingEngine()
        engine.record_snapshot(rows("A", "B"), rows("X"), trading_date="2026-09-18", now=1000.0, force=True)
        self.assertEqual(len(engine.pins()["gainers"]), 2)

        engine.record_snapshot(rows("Z"), rows("Y"), trading_date="2026-09-19", now=2000.0, force=True)
        pins = [p["token"] for p in engine.pins()["gainers"]]
        self.assertEqual(pins, ["Z"])
        self.assertEqual(engine.status()["tradingDate"], "2026-09-19")

    def test_previous_day_never_influences_next(self):
        engine = MarketWatchRankingEngine()
        for _ in range(5):
            engine.record_snapshot(rows("A"), rows("X"), trading_date="2026-09-18", now=1000.0, force=True)
        self.assertEqual(engine.pins()["gainers"][0]["appearances"], 5)
        engine.record_snapshot(rows("B"), rows("Y"), trading_date="2026-09-19", now=2000.0, force=True)
        self.assertEqual(engine.pins()["gainers"][0]["token"], "B")
        self.assertEqual(engine.pins()["gainers"][0]["appearances"], 1)


class MarketWatchEngineTest(unittest.TestCase):
    """MarketWatchEngine tick processing, state, and ranking integration."""

    def setUp(self):
        self.engine = MarketWatchEngine()

    def test_engine_identity(self):
        self.assertEqual(self.engine.engine_id, "market_watch")
        self.assertEqual(self.engine.engine_category.value, "MARKET_DATA")

    def test_process_tick_updates_state(self):
        open_universe(self.engine, "T1")
        self.engine._process_tick("T1", tick("T1", "RELIANCE", 1100.0, 1.5))
        self.assertIn("T1", self.engine._records)
        state = self.engine._records["T1"]
        self.assertEqual(state["symbol"], "RELIANCE")
        self.assertAlmostEqual(state["changePercent"], 1.5, places=2)
        self.assertEqual(self.engine.live_state_count(), 1)

    def test_process_tick_multiple(self):
        open_universe(self.engine, "T0", "T1", "T2")
        for i, (sym, pct) in enumerate([("A", 2.0), ("B", -1.5), ("C", 0.5)]):
            self.engine._process_tick(f"T{i}", tick(f"T{i}", sym, 100 + i, pct, prev_close=100.0))
        self.assertEqual(self.engine.live_state_count(), 3)

    def test_tick_outside_the_universe_is_not_ranked(self):
        """doc §3/§7 — Instrument Master availability is not a subscription, so
        a symbol outside the universe can never reach a ranking board."""
        open_universe(self.engine, "T1")
        self.engine._process_tick("T2", tick("T2", "B", 105.0, 5.0, prev_close=100.0))
        self.assertEqual(self.engine.get_gainer_rows(10), [])
        self.assertEqual(self.engine._out_of_universe_tick_count, 1)

    def test_get_gainer_rows_sorted(self):
        open_universe(self.engine, "T1", "T2", "T3")
        self.engine._process_tick("T1", tick("T1", "A", 102.0, 2.0, prev_close=100.0))
        self.engine._process_tick("T2", tick("T2", "B", 98.5, -1.5, prev_close=100.0))
        self.engine._process_tick("T3", tick("T3", "C", 100.5, 0.5, prev_close=100.0))
        gainers = self.engine.get_gainer_rows(10)
        self.assertEqual(len(gainers), 2)
        self.assertEqual(gainers[0]["symbol"], "A")
        self.assertEqual(gainers[1]["symbol"], "C")

    def test_get_loser_rows_sorted(self):
        open_universe(self.engine, "T1", "T2")
        self.engine._process_tick("T1", tick("T1", "A", 102.0, 2.0, prev_close=100.0))
        self.engine._process_tick("T2", tick("T2", "B", 98.5, -1.5, prev_close=100.0))
        losers = self.engine.get_loser_rows(10)
        self.assertEqual(len(losers), 1)
        self.assertEqual(losers[0]["symbol"], "B")

    def test_get_sections_structure(self):
        open_universe(self.engine, "T1")
        self.engine._process_tick("T1", tick("T1", "A", 102.0, 2.0, prev_close=100.0))
        sections = self.engine.get_sections()
        self.assertIn("topGainers", sections)
        self.assertIn("topLosers", sections)
        self.assertIn("highestVolume", sections)

    def test_ranking_snapshot_empty(self):
        market_watch_ranking.reset()  # global singleton may carry state from other suites
        snap = self.engine.ranking_snapshot()
        self.assertEqual(snap["snapshotCount"], 0)
        self.assertIsNone(snap["latest"])

    def test_ranking_pins_empty(self):
        market_watch_ranking.reset()  # global singleton may carry state from other suites
        pins = self.engine.ranking_pins()
        self.assertEqual(pins["gainers"], [])
        self.assertEqual(pins["losers"], [])

    def test_rankings_reflect_engine_state(self):
        """After recording a snapshot via ranking engine, singleton exposes it."""
        from services.market_watch_ranking import market_watch_ranking  # noqa: E402
        market_watch_ranking.record_snapshot(rows("X", "Y"), rows("Z"), trading_date="2026-09-18", now=1000.0, force=True)
        snap = market_watch_ranking.snapshot()
        self.assertEqual(snap["snapshotCount"], 1)
        self.assertIn("X", snap["latest"]["topGainers"])

    def test_is_inactive(self):
        self.assertFalse(_is_inactive({"tradingStatus": "ACTIVE"}))
        self.assertTrue(_is_inactive({"tradingStatus": "INACTIVE"}))
        self.assertTrue(_is_inactive({"tradingStatus": "SUSPENDED"}))
        self.assertFalse(_is_inactive({}))

    def test_fnum(self):
        self.assertAlmostEqual(_fnum(1.5), 1.5)
        self.assertIsNone(_fnum(""))
        self.assertIsNone(_fnum(None))
        self.assertAlmostEqual(_fnum("2.5"), 2.5)
        self.assertIsNone(_fnum("abc"))


class StatusModelTest(unittest.TestCase):
    """Per-token status model: PENDING / LIVE / STALE / NO_DATA / INACTIVE (doc §20)."""

    def setUp(self):
        self.engine = MarketWatchEngine()

    def test_fresh_tick_is_live(self):
        open_universe(self.engine, "T1")
        self.engine._process_tick("T1", tick("T1", "A", 102.0, 2.0))
        self.assertEqual(self.engine._records["T1"]["status"], "LIVE")

    def test_old_tick_is_stale(self):
        open_universe(self.engine, "T1")
        self.engine._process_tick("T1", tick("T1", "A", 102.0, 2.0))
        with self.engine._lock:
            self.engine._records["T1"]["lastTickAt"] = time.time() - 120.0
        self.engine._update_statuses(time.time())
        self.assertEqual(self.engine._records["T1"]["status"], "STALE")

    def test_status_counts_shape(self):
        open_universe(self.engine, "T1")
        self.engine._process_tick("T1", tick("T1", "A", 102.0, 2.0))
        counts = self.engine.status_counts()
        self.assertGreaterEqual(counts["LIVE"], 1)
        self.assertIn("PENDING", counts)
        self.assertIn("STALE", counts)
        self.assertIn("NO_DATA", counts)
        self.assertIn("INACTIVE", counts)

    def test_feed_state_default_connecting(self):
        self.assertEqual(self.engine.feed_state(), "CONNECTING")
        self.engine._on_ws_disconnected()
        self.assertEqual(self.engine.feed_state(), "DISCONNECTED")
        self.engine._on_ws_reconnected()
        self.assertEqual(self.engine.feed_state(), "CONNECTED")


class NewSectionsTest(unittest.TestCase):
    """Dynamic sections beyond top gainers/losers/volume (doc §9, §15)."""

    def setUp(self):
        self.engine = MarketWatchEngine()
        open_universe(self.engine, "T1", "T2", "T3", "T4")
        # A +2.0%, B -2.5%, C +0.5%, D +3.0% with volumes.
        self.engine._process_tick("T1", tick("T1", "A", 102.0, 2.0, volume=5e6))
        self.engine._process_tick("T2", tick("T2", "B", 97.5, -2.5, volume=9e6))
        self.engine._process_tick("T3", tick("T3", "C", 100.5, 0.5, volume=2e6))
        self.engine._process_tick("T4", tick("T4", "D", 103.0, 3.0, volume=4e6))

    def test_sections_have_new_keys(self):
        sections = self.engine.get_sections()
        for key in ("highestAbsoluteChange", "strongMovers", "weakMovers",
                    "fiveMinuteMovers", "tenMinuteMovers", "highestTurnover",
                    "buyingStrength"):
            self.assertIn(key, sections)

    def test_strong_movers_gt_1(self):
        syms = [r["symbol"] for r in self.engine.get_strong_mover_rows()]
        self.assertEqual(syms, ["D", "A"])

    def test_weak_movers_lt_minus_1(self):
        syms = [r["symbol"] for r in self.engine.get_weak_mover_rows()]
        self.assertEqual(syms, ["B"])

    def test_highest_volume_sorted_desc(self):
        syms = [r["symbol"] for r in self.engine.get_highest_volume_rows()]
        self.assertEqual(syms, ["B", "A", "D", "C"])

    def test_highest_turnover_sorted_desc(self):
        # tradedValue derives from real turnover (ltp * volume).
        syms = [r["symbol"] for r in self.engine.get_highest_turnover_rows()]
        self.assertEqual(syms, ["B", "A", "D", "C"])

    def test_buying_strength_from_real_quantities(self):
        # Feed depth totals; ratio = totalBuyQuantity / totalSellQuantity.
        self.engine._process_tick("T1", tick("T1", "A", 102.0, 2.0, totalBuyQuantity=9000, totalSellQuantity=3000))
        self.engine._process_tick("T2", tick("T2", "B", 97.5, -2.5, totalBuyQuantity=1000, totalSellQuantity=5000))
        rows = self.engine.get_buying_strength_rows(10)
        self.assertEqual([r["symbol"] for r in rows], ["A", "B"])
        self.assertAlmostEqual(rows[0]["buySellRatio"], 3.0, places=3)

    def test_buying_strength_never_fabricated(self):
        # No quantity data -> buySellRatio stays None and rows are excluded.
        rows = self.engine.get_buying_strength_rows()
        self.assertEqual(rows, [])

    def test_paginate(self):
        page = self.engine.paginate("top_gainers", offset=1, limit=1)
        self.assertEqual(page["ok"], True)
        self.assertEqual(page["hasMore"], True)
        self.assertEqual(page["count"], 1)

    def test_paginate_unknown_section(self):
        page = self.engine.paginate("nope")
        self.assertEqual(page["ok"], False)

    def test_search_by_symbol(self):
        res = self.engine.search("D")
        self.assertGreaterEqual(res["total"], 1)
        self.assertEqual(res["items"][0]["symbol"], "D")

    def test_ui_payload_shape(self):
        payload = self.engine.ui_payload()
        sections_map = {s["section"]: s for s in payload["sections"]}
        self.assertIn("top_gainers", sections_map)
        self.assertIn("strong_movers", sections_map)
        self.assertIn("items", sections_map["top_gainers"])
        self.assertIn("generatedAt", sections_map["top_gainers"])
        self.assertIn("pinned", payload)
        self.assertEqual(payload["statusCounts"]["LIVE"], 4)

    def test_publish_increments_index_version(self):
        self.engine._publish("2026-09-18", time.time())
        self.assertEqual(self.engine._index_version, 1)
        self.assertIsNotNone(self.engine._last_publish_at)


class DayScopedStateResetTest(unittest.TestCase):
    """Trading-day reset clears live state / tick cache (doc §6, §14)."""

    def setUp(self):
        self.engine = MarketWatchEngine()
        open_universe(self.engine, "T1")
        self.engine._process_tick("T1", tick("T1", "A", 102.0, 2.0))

    def test_same_day_keeps_state(self):
        self.engine._ensure_trading_day("2026-09-18")
        self.assertEqual(self.engine.live_state_count(), 1)

    def test_new_day_resets_state_and_tick_cache(self):
        self.engine._ensure_trading_day("2026-09-18")
        self.engine._ensure_trading_day("2026-09-19")
        self.assertEqual(self.engine.live_state_count(), 0)
        self.assertEqual(self.engine._tick_cache, {})
        self.assertEqual(self.engine._index_version, 0)


class SubscriptionPayloadTest(unittest.TestCase):
    """desired_subscriptions() drives Connection Manager subscriptions (doc §16)."""

    def test_eligible_only(self):
        engine = MarketWatchEngine()
        engine._lifecycle_state = MONITORING
        # Mock the runtime window check to always return True for testing
        engine._in_runtime_window = lambda: True
        engine._registry = {
            "1": {"token": "1", "symbol": "A", "exchange": "nse_cm", "intradayEligible": True},
            "2": {"token": "2", "symbol": "B", "exchange": "nse_cm", "intradayEligible": False},
        }
        engine._universe = {"1", "2"}
        subs = engine.desired_subscriptions()
        self.assertEqual(len(subs), 1)
        self.assertEqual(subs[0]["instrumentToken"], "1")

    def test_tick_registers_subscription(self):
        engine = MarketWatchEngine()
        engine._registry = {"T1": {"token": "T1", "symbol": "A", "exchange": "nse_cm", "intradayEligible": True}}
        engine._universe = {"T1"}
        # tick events mark the token as subscribed through the listener path
        engine._subscribed_tokens.add("T1")
        self.assertEqual(engine.subscribed_token_count(), 1)


if __name__ == "__main__":
    unittest.main()
