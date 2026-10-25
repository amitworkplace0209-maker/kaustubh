"""Daily full-market subscription intent tests (doc §5/§14).

Covers the Market Watch eligible-universe -> Session Manager daily intent
flow without any live broker / MongoDB:

- ``apply_daily_subscription_intent`` records rows as the canonical desired
  set with source=market_watch_daily_universe, tagged with trading
  date + session id (dedup, L8-equity classification, merge with pins)
- previous-day universe intents are expired when the new day's set is applied
  (revoked = desired False / inactive), while other consumers' claims survive
- the apply is merge/idempotent within a day and bumps revision only on real
  change
- ``daily_indicates_snapshot`` exposes real counts for verification
- ``ws_manager._reload_subscriptions_from_session_manager`` restores the
  current-day universe directly (never re-derives from db.stocks) when the
  intent is present, and falls back to ``refresh_desired_subscriptions`` only
  when no daily universe is recorded
- ``_send_subscribe`` / ``_send_unsubscribe`` chunk by broker feed family in
  deterministic bounded frames (``WS_SUBSCRIBE_BATCH_SIZE``)
- ``connection_engine._normalize_frame`` deserializes string/bytes bridge
  frames (fixes the state-bridge crash) and rejects malformed payloads

Run:  python -m pytest tests/test_daily_universe_subscription_intent.py -q
"""
from __future__ import annotations

import json
import os
import sys
import unittest
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

DAY1 = "2026-09-22"
DAY2 = "2026-09-23"


def _row(token, symbol="", segment="nse_cm"):
    return {
        "instrumentToken": str(token),
        "exchangeSegment": segment,
        "symbol": symbol or f"SYM{token}",
    }


class FakeStocks:
    def __init__(self, rows):
        self._rows = list(rows)

    def find(self, query=None, projection=None):
        return self

    async def to_list(self, length=None):
        return [dict(r) for r in self._rows]


class FakeDB:
    def __init__(self, stocks=None):
        self.stocks = FakeStocks(stocks or [])


class DailyUniverseIntentTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.db = FakeDB()
        self.get_db_patch = mock.patch(
            "database.connection.get_db", return_value=self.db
        )
        self.get_db_patch.start()
        self.addCleanup(self.get_db_patch.stop)
        from services.session.session_manager import CentralSessionManager
        self.mgr = CentralSessionManager()

    async def test_empty_rows_apply_nothing(self):
        snap = await self.mgr.apply_daily_subscription_intent(DAY1, "ses_1", [])
        self.assertTrue(snap["ok"])
        self.assertEqual(snap["daily_universe_desired"], 0)
        self.assertEqual(snap["desired"], 0)
        self.assertEqual(self.mgr.subscription_counts()["desired"], 0)

    def test_snapshot_before_first_apply_is_empty(self):
        """The read endpoint is valid before the first intent of the process.

        The attribute used to be created only inside the apply path, so a
        fresh backend returned 500 from the daily-intent read endpoint until
        something applied an intent. It must report an honest empty snapshot.
        """
        snap = self.mgr.daily_intent_snapshot()
        self.assertTrue(snap["ok"])
        self.assertIsNone(snap["market_date"])
        self.assertEqual(snap["rows_applied"], 0)
        self.assertEqual(snap["daily_universe_desired"], 0)
        self.assertEqual(snap["desired"], 0)

    async def test_snapshot_survives_restart_from_canonical_records(self):
        """A restored canonical set reports its real size, not zero.

        The in-memory ``_daily_intent`` summary is not persisted; the daily
        universe records are. After a restart the read endpoint must derive
        the applied date/count from those records.
        """
        await self.mgr.apply_daily_subscription_intent(DAY1, "ses_1", [_row(9)])
        from services.session.session_manager import CentralSessionManager
        restarted = CentralSessionManager()
        restarted._subs = dict(self.mgr._subs)
        snap = restarted.daily_intent_snapshot()
        self.assertTrue(snap["ok"])
        self.assertEqual(snap["market_date"], DAY1)
        self.assertEqual(snap["rows_applied"], 1)
        self.assertEqual(snap["daily_universe_desired"], 1)
        self.assertEqual(snap["desired"], 1)

    async def test_single_row_becomes_desired_l8_equity(self):
        snap = await self.mgr.apply_daily_subscription_intent(DAY1, "ses_1", [_row(11, "RELIANCE")])
        self.assertEqual(snap["market_date"], DAY1)
        self.assertEqual(snap["rows_applied"], 1)
        self.assertEqual(snap["daily_universe_desired"], 1)
        self.assertEqual(snap["desired"], 1)
        keys = self.mgr.subscription_desired_keys()
        self.assertEqual(len(keys), 1)
        rec = keys[0]
        self.assertEqual(rec["instrument_token"], "11")
        self.assertEqual(rec["exchange_segment"], "nse_cm")
        # L8 depth is the sanctioned default market-data feed for equities.
        self.assertTrue(rec.get("isDepth"))
        self.assertEqual(rec.get("feedLevel"), 8)
        self.assertEqual(rec.get("marketData"), "L8")

    async def test_many_rows_and_counts(self):
        rows = [_row(t) for t in range(1, 51)]
        snap = await self.mgr.apply_daily_subscription_intent(DAY1, "ses_1", rows)
        self.assertEqual(snap["rows_applied"], 50)
        self.assertEqual(snap["daily_universe_desired"], 50)
        self.assertEqual(snap["desired"], 50)
        self.assertEqual(snap["desired_by_source"].get("market_watch_daily_universe"), 50)
        self.assertEqual(len(self.mgr.subscription_desired_keys()), 50)

    async def test_duplicate_rows_dedup(self):
        rows = [_row(7), _row(7), _row(7)]
        snap = await self.mgr.apply_daily_subscription_intent(DAY1, "ses_1", rows)
        # rows_applied = records actually fused into the canonical set (deduped).
        self.assertEqual(snap["rows_applied"], 1)
        self.assertEqual(snap["daily_universe_desired"], 1)

    async def test_same_day_reapply_is_idempotent(self):
        await self.mgr.apply_daily_subscription_intent(DAY1, "ses_1", [_row(2)])
        rev_before = self.mgr.subscription_counts()["revision"]
        snap = await self.mgr.apply_daily_subscription_intent(DAY1, "ses_1", [_row(2)])
        self.assertEqual(snap["daily_universe_desired"], 1)
        self.assertEqual(self.mgr.subscription_counts()["revision"], rev_before)

    async def test_new_day_revokes_previous_day_without_new_claim(self):
        await self.mgr.apply_daily_subscription_intent(DAY1, "ses_1", [_row(1), _row(2)])
        snap = await self.mgr.apply_daily_subscription_intent(DAY2, "ses_2", [_row(2)])
        self.assertEqual(snap["daily_universe_desired"], 1)
        keys = self.mgr.subscription_desired_keys()
        self.assertTrue(any(k["instrument_token"] == "2" for k in keys))
        self.assertFalse(any(k["instrument_token"] == "1" for k in keys))
        rows = self.mgr.subscription_snapshot()["instruments"]
        revoked = next(r for r in rows if r["instrument_token"] == "1")
        self.assertNotEqual(revoked["state"], "SUBSCRIBED")

    async def test_revoked_rows_are_persisted_with_desired_false(self):
        """A shrinking intent must persist the revocations, not only new rows.

        The store is the crash-recovery source. Persisting only the incoming
        rows left yesterday's 2679-symbol universe desired, so a restart
        restored and subscribed the old, larger set.
        """
        persisted = []

        async def _capture(records):
            persisted.extend(
                (r["exchange_segment"], r["instrument_token"], bool(r.get("desired")))
                for r in records
            )

        with mock.patch.object(self.mgr, "_persist_many", side_effect=_capture):
            await self.mgr.apply_daily_subscription_intent(DAY1, "ses_1", [_row(1), _row(2)])
            await self.mgr.apply_daily_subscription_intent(DAY2, "ses_2", [_row(2)])

        self.assertIn(("nse_cm", "1", False), persisted)
        self.assertIn(("nse_cm", "2", True), persisted)

    async def test_pin_survives_revocation(self):
        await self.mgr.apply_daily_subscription_intent(DAY1, "ses_1", [_row(5)])
        self.mgr.set_pin_intents([{
            "instrument_key": "nse_cm|5",
            "symbol": "SYM5",
            "source": "watchlist",
        }])
        snap = await self.mgr.apply_daily_subscription_intent(DAY2, "ses_2", [])
        # The pinned instrument stays desired through the pin claim even
        # though the universe dropped it.
        self.assertEqual(snap["daily_universe_desired"], 0)
        self.assertTrue(any(
            k["instrument_token"] == "5" for k in self.mgr.subscription_desired_keys()
        ))
        rows = self.mgr.subscription_snapshot()["instruments"]
        pinned = next(r for r in rows if r["instrument_token"] == "5")
        self.assertIn("PINNED", pinned["state"])

    async def test_symbol_upgrade_on_reapply(self):
        await self.mgr.apply_daily_subscription_intent(DAY1, "ses_1", [_row(3, "OLD")])
        await self.mgr.apply_daily_subscription_intent(DAY1, "ses_1", [_row(3, "NEW")])
        keys = self.mgr.subscription_desired_keys()
        self.assertEqual(keys[0]["symbol"], "NEW")


class WsManagerDailyRestoreTest(unittest.IsolatedAsyncioTestCase):
    def test_restores_universe_when_daily_intent_present(self):
        from ws_socket.ws_manager import WebSocketManager
        mgr = WebSocketManager()
        fake_session = mock.MagicMock()
        fake_session.daily_intent_snapshot.return_value = {
            "ok": True,
            "daily_universe_desired": 42,
        }
        fake_tokens = [{"instrument_token": str(i), "exchange_segment": "nse_cm"} for i in range(42)]
        fake_session.subscription_desired_keys.return_value = fake_tokens
        with mock.patch(
            "services.session.session_manager.session_manager", fake_session
        ):
            asyncio_run = self._run(mgr._reload_subscriptions_from_session_manager())
        self.assertEqual(asyncio_run, fake_tokens)
        # The db.stocks re-derivation path MUST NOT run when the daily intent
        # is present (it would silently shrink the universe).
        fake_session.refresh_desired_subscriptions.assert_not_called()
        self.assertEqual(len(mgr._subscription_registry), 42)

    def test_falls_back_to_refresh_without_daily_intent(self):
        from ws_socket.ws_manager import WebSocketManager
        mgr = WebSocketManager()
        fake_session = mock.MagicMock()
        fake_session.daily_intent_snapshot.return_value = {
            "ok": True,
            "daily_universe_desired": 0,
        }
        fake_session.refresh_desired_subscriptions = mock.AsyncMock()
        fake_session.subscription_desired_keys.return_value = []
        with mock.patch(
            "services.session.session_manager.session_manager", fake_session
        ):
            result = self._run(mgr._reload_subscriptions_from_session_manager())
        self.assertEqual(result, [])
        fake_session.refresh_desired_subscriptions.assert_awaited_once()

    @staticmethod
    def _run(awaitable):
        import asyncio
        return asyncio.get_event_loop_policy().new_event_loop().run_until_complete(awaitable)


class _FakeSFeed:
    def __init__(self):
        self.calls = []

    async def subscribe_scrips(self, tokens):
        self.calls.append(("scrips", [t.instrument_token for t in tokens]))

    async def subscribe_index(self, tokens):
        self.calls.append(("index", [t.instrument_token for t in tokens]))

    async def subscribe_full_depth(self, tokens):
        self.calls.append(("full_depth", [t.instrument_token for t in tokens]))

    async def subscribe_depth(self, tokens):
        self.calls.append(("depth", [t.instrument_token for t in tokens]))

    async def unsubscribe_scrips(self, tokens):
        self.calls.append(("unsub_scrips", [t.instrument_token for t in tokens]))

    async def unsubscribe_index(self, tokens):
        self.calls.append(("unsub_index", [t.instrument_token for t in tokens]))

    async def unsubscribe_full_depth(self, tokens):
        self.calls.append(("unsub_full_depth", [t.instrument_token for t in tokens]))

    async def unsubscribe_depth(self, tokens):
        self.calls.append(("unsub_depth", [t.instrument_token for t in tokens]))


def _broker_token(t, is_index=False, feed_level=8):
    if is_index:
        market_data = "INDEX"
    elif feed_level == 16:
        market_data = "L16"
    elif feed_level in (1, 2, 4):
        market_data = "L4"
    else:
        market_data = "L8"
    return {
        "instrument_token": str(t),
        "exchange_segment": "nse_cm",
        "isIndex": is_index,
        "isDepth": not is_index and not market_data == "L4",
        "feedLevel": feed_level if not is_index else None,
        "marketData": market_data,
    }


class BatchingTest(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def _mod():
        import importlib
        return importlib.import_module("ws_socket.ws_manager")

    def test_batched_chunking(self):
        mod = self._mod()
        self.assertEqual(mod._batched([], 200), [])
        self.assertEqual(mod._batched([1, 2, 3], 200), [[1, 2, 3]])
        self.assertEqual(
            mod._batched(list(range(5)), 2),
            [[0, 1], [2, 3], [4]],
        )

    def test_subscribe_chunks_per_feed_family(self):
        mod = self._mod()
        sfeed = _FakeSFeed()
        tokens = [_broker_token(t) for t in range(7)]  # 7x L8 depth
        tokens += [_broker_token(1000, is_index=True)]
        tokens += [_broker_token(2000, feed_level=16)]
        tokens += [_broker_token(3000, feed_level=4)]
        with mock.patch.dict(os.environ, {"WS_SUBSCRIBE_BATCH_SIZE": "2"}):
            asyncio_run = self._run(mod._send_subscribe(sfeed, tokens))
        self.assertIsNone(asyncio_run)
        depth_calls = [c for c in sfeed.calls if c[0] == "depth"]
        self.assertEqual(len(depth_calls), 4)  # 7 tokens / 2 = 4 frames
        self.assertEqual(depth_calls[0][1], ["0", "1"])
        self.assertEqual(depth_calls[-1][1], ["6"])
        self.assertEqual([c for c in sfeed.calls if c[0] == "index"], [("index", ["1000"])])
        self.assertEqual([c for c in sfeed.calls if c[0] == "full_depth"], [("full_depth", ["2000"])])
        self.assertEqual([c for c in sfeed.calls if c[0] == "scrips"], [("scrips", ["3000"])])

    def test_single_batch_for_small_set(self):
        mod = self._mod()
        sfeed = _FakeSFeed()
        with mock.patch.dict(os.environ, {"WS_SUBSCRIBE_BATCH_SIZE": "200"}):
            asyncio_run = self._run(mod._send_subscribe(sfeed, [_broker_token(9)]))
        self.assertIsNone(asyncio_run)
        self.assertEqual(len([c for c in sfeed.calls if c[0] == "depth"]), 1)

    def test_unsubscribe_chunks(self):
        mod = self._mod()
        sfeed = _FakeSFeed()
        tokens = [_broker_token(t) for t in range(5)]
        with mock.patch.dict(os.environ, {"WS_SUBSCRIBE_BATCH_SIZE": "2"}):
            asyncio_run = self._run(mod._send_unsubscribe(sfeed, tokens))
        self.assertIsNone(asyncio_run)
        unsub = [c for c in sfeed.calls if c[0] == "unsub_depth"]
        self.assertEqual(len(unsub), 3)

    @staticmethod
    def _run(awaitable):
        import asyncio
        return asyncio.get_event_loop_policy().new_event_loop().run_until_complete(awaitable)


class BridgeNormalizeTest(unittest.TestCase):
    def setUp(self):
        import importlib
        self.mod = importlib.import_module("connection_engine.connection_engine")

    def test_dict_passes_through(self):
        frame = {"type": "market_watch.pins", "data": {}}
        self.assertEqual(self.mod._normalize_frame(frame), frame)

    def test_json_string_parsed(self):
        frame = {"type": "market_watch.pins", "data": {"count": 3}}
        self.assertEqual(self.mod._normalize_frame(json.dumps(frame)), frame)

    def test_bytes_parsed(self):
        frame = {"type": "state_changed", "entity": "websocket"}
        self.assertEqual(
            self.mod._normalize_frame(json.dumps(frame).encode("utf-8")), frame
        )

    def test_malformed_dropped(self):
        self.assertIsNone(self.mod._normalize_frame("not json {"))
        self.assertIsNone(self.mod._normalize_frame("[1, 2]"))
        self.assertIsNone(self.mod._normalize_frame(12345))
        self.assertIsNone(self.mod._normalize_frame(None))


if __name__ == "__main__":
    unittest.main()