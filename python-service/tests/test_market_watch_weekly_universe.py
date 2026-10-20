"""Weekly locked-universe tests — docs/engines/MARKET_WATCH.md §2, §6, §7, §16, §32, §33.

These lock in the NON-NEGOTIABLE rules (doc §35) that were previously
unimplemented:

* a locked week is the ONLY membership source;
* a locked week cannot be mutated;
* ADD / REMOVE / KEEP only ever touch the DRAFT;
* crossing the ₹800 threshold never changes membership;
* missing data stays ``None`` / ``UNKNOWN``.

No MongoDB is required: the persistence helpers are monkeypatched with async
fakes (the services talk to motor, so every DB call is awaited) and the pure
logic is exercised directly.
"""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta
from unittest.mock import patch

from services import market_watch_config as mw_config
from services import market_watch_universe as mw_u
from services.market_watch_state import SymbolState
from services import market_watch_weekly as mw_w


# --------------------------------------------------------------------------- #
# §2 / §6 — week identity + versioned lock document
# --------------------------------------------------------------------------- #
class WeekIdentityTest(unittest.TestCase):
    def test_week_id_is_iso_form(self):
        d = datetime(2026, 10, 9)  # a Friday
        self.assertEqual(mw_u.week_id_for(d), "2026-W41")

    def test_week_start_is_monday(self):
        friday = datetime(2026, 10, 9)
        self.assertEqual(mw_u.week_start(friday).date(), datetime(2026, 10, 5).date())

    def test_week_start_same_monday_across_the_week(self):
        monday = mw_u.week_start(datetime(2026, 10, 5))
        for offset in range(5):
            self.assertEqual(mw_u.week_start(datetime(2026, 10, 5) + timedelta(days=offset)), monday)

    def test_lock_document_carries_every_spec_field(self):
        """doc §6: week_id, version, effective_from/to, symbols, added, removed,
        kept, locked_at, locked_by, status."""
        u = mw_u.WeeklyUniverse(
            week_id="2026-W41", version=3, status=mw_config.WEEK_STATUS_LOCKED,
            symbols=["A", "B"], added=["B"], removed=["C"], kept=["A"],
            effective_from="2026-10-05T00:00:00", effective_to="2026-10-12T00:00:00",
            locked_at="2026-10-10T18:00:00+00:00", locked_by="operator",
        )
        doc = u.to_doc()
        for field in (
            "weekId", "week_id", "version", "status", "symbols", "added", "removed",
            "kept", "effectiveFrom", "effectiveTo", "lockedAt", "lockedBy",
        ):
            self.assertIn(field, doc)
        self.assertEqual(doc["symbolCount"], 2)
        self.assertTrue(u.locked)
        # Round-trips without loss.
        back = mw_u.WeeklyUniverse.from_doc(doc)
        self.assertEqual(back.week_id, "2026-W41")
        self.assertEqual(back.version, 3)
        self.assertEqual(back.added, ["B"])


# --------------------------------------------------------------------------- #
# §32 / §33 — ADD / REMOVE / KEEP and the LOCK
# --------------------------------------------------------------------------- #
class _FakeCursor:
    """Async cursor mirroring the motor API surface the services use."""

    def __init__(self, docs):
        self._docs = list(docs)

    def sort(self, spec):
        for key, direction in reversed(list(spec)):
            self._docs.sort(key=lambda d: d.get(key), reverse=direction < 0)
        return self

    def limit(self, count):
        self._docs = self._docs[: max(0, int(count))]
        return self

    def __aiter__(self):
        async def _gen():
            for doc in self._docs:
                yield doc

        return _gen()


class _FakeCollection:
    def __init__(self):
        self.docs: list[dict] = []

    async def count_documents(self, query, **kw):
        return sum(1 for d in self.docs if all(d.get(k) == v for k, v in query.items()))

    async def find_one(self, query=None, *args, **kwargs):
        query = query or {}
        for d in self.docs:
            if all(d.get(k) == v for k, v in query.items()):
                return d
        return None

    async def create_index(self, *args, **kwargs):
        return str(kwargs.get("name") or "idx")

    def upsert(self, doc):
        """Mirror ``buffer_documents`` + Mongo upsert semantics for the fake db.

        The doc buffer writes idempotent collections with
        ``ReplaceOne({"_id": ...}, upsert=True)``, so ``_id`` is the real key.
        Decision documents carry ``_id == "<weekId>:<symbol>"`` and no ``status``;
        keying them on ``(weekId, status)`` alone would collapse every decision of
        a week into one document and hide real audit-trail bugs.
        """
        doc_id = doc.get("_id")
        if doc_id is not None:
            for i, existing in enumerate(self.docs):
                if existing.get("_id") == doc_id:
                    self.docs[i] = doc
                    return
            self.docs.append(doc)
            return
        key = (doc.get("weekId"), doc.get("status"))
        for i, existing in enumerate(self.docs):
            if (existing.get("weekId"), existing.get("status")) == key:
                self.docs[i] = doc
                return
        self.docs.append(doc)

    async def update_many(self, query, update):
        for d in self.docs:
            if all(d.get(k) == v for k, v in query.items()):
                d.update(update.get("$set", {}))

    def find(self, query=None, *args, **kwargs):
        return _FakeCursor(self.docs)


class _FakeDb:
    def __init__(self):
        self.market_watch_universe = _FakeCollection()
        self.market_watch_universe_history = _FakeCollection()
        self.market_watch_review_decisions = _FakeCollection()
        self.market_watch_weekly_reports = _FakeCollection()
        self.market_candles_1m = _FakeCollection()
        self.market_candles_5m = _FakeCollection()
        self.market_candles_10m = _FakeCollection()
        self.market_candles_30m = _FakeCollection()
        self.market_watch_daily_report = _FakeCollection()

    def __getitem__(self, name):
        # pymongo attribute access + subscript access both appear in the services.
        return getattr(self, name)


class ReviewCommandTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.db = _FakeDb()
        universe_col = self.db.market_watch_universe

        def _persist(u):
            """Stand in for the DB Writer hand-off: buffer then upsert."""
            universe_col.upsert(u.to_doc())
            return True

        def _buffer(collection, docs):
            """Stand in for ``db_writer_engine.buffer_documents``."""
            target = getattr(self.db, collection, None)
            if target is None:
                return True
            for doc in docs:
                target.upsert(doc)
            return True

        class _FakeWriter:
            """The DB Writer hand-off target used by ``lock_universe``."""

            @staticmethod
            def buffer_documents(collection, docs):
                return _buffer(collection, list(docs))

        self._patches = [
            patch.object(mw_u, "_db", lambda: self.db),
            patch.object(mw_u, "_buffer", _buffer),
            patch.object(mw_u, "_sink", lambda: _FakeWriter),
            patch.object(mw_u, "persist_universe", _persist),
            patch.object(mw_u, "invalidate_cache", lambda: None),
        ]
        for p in self._patches:
            p.start()
        mw_u.invalidate_cache()
        self.addCleanup(lambda: [p.stop() for p in self._patches])

    async def test_add_puts_symbol_in_draft(self):
        await mw_u.record_decision("2026-W41", "SBIN", "ADD")
        draft = await mw_u.get_draft("2026-W41")
        self.assertIn("SBIN", draft.symbols)
        self.assertIn("SBIN", draft.added)

    async def test_remove_takes_symbol_out(self):
        await mw_u.record_decision("2026-W41", "SBIN", "ADD")
        await mw_u.record_decision("2026-W41", "SBIN", "REMOVE")
        draft = await mw_u.get_draft("2026-W41")
        self.assertNotIn("SBIN", draft.symbols)
        self.assertIn("SBIN", draft.removed)
        self.assertNotIn("SBIN", draft.added)

    async def test_keep_adds_without_marking_as_new(self):
        await mw_u.record_decision("2026-W41", "INFY", "KEEP")
        draft = await mw_u.get_draft("2026-W41")
        self.assertIn("INFY", draft.symbols)
        self.assertIn("INFY", draft.kept)
        self.assertNotIn("INFY", draft.added)

    async def test_invalid_action_rejected(self):
        with self.assertRaises(ValueError):
            await mw_u.record_decision("2026-W41", "SBIN", "SELL")

    async def test_locked_week_rejects_decision(self):
        """doc §33 — no automatic mid-week membership change."""
        self.db.market_watch_universe.docs.append(
            {"weekId": "2026-W41", "status": mw_config.WEEK_STATUS_LOCKED, "symbols": ["A"], "version": 1}
        )
        with self.assertRaises(PermissionError):
            await mw_u.record_decision("2026-W41", "ZZZ", "ADD")

    async def test_lock_assigns_version_and_freezes(self):
        await mw_u.record_decision("2026-W41", "SBIN", "ADD")
        result = await mw_u.lock_universe("2026-W41", locked_by="tester")
        self.assertEqual(result["version"], 1)
        self.assertEqual(result["status"], mw_config.WEEK_STATUS_LOCKED)
        self.assertIn("SBIN", result["universe"].symbols)
        self.assertEqual(result["universe"].locked_by, "tester")
        self.assertIsNotNone(result["universe"].effective_from)
        self.assertIsNotNone(result["universe"].effective_to)

    async def test_double_lock_is_refused(self):
        await mw_u.record_decision("2026-W41", "SBIN", "ADD")
        await mw_u.lock_universe("2026-W41")
        with self.assertRaises(PermissionError):
            await mw_u.lock_universe("2026-W41")

    async def test_lock_respects_configured_symbol_override(self):
        await mw_u.record_decision("2026-W41", "SBIN", "ADD")
        result = await mw_u.lock_universe("2026-W41", symbols=["A", "B"])
        self.assertEqual(result["universe"].symbols, ["A", "B"])

    async def test_lock_disabled_by_config(self):
        import dataclasses

        cfg = mw_config.load()
        locked_off = dataclasses.replace(cfg, weekly=dataclasses.replace(cfg.weekly, lock_enabled=False))
        # ``mw_u`` holds its own module-level reference to the loader.
        with patch.object(mw_u, "load_config", lambda: locked_off):
            with self.assertRaises(PermissionError):
                await mw_u.lock_universe("2026-W42")

    async def test_verify_week_reports_honestly_when_nothing_locked(self):
        verdict = await mw_u.verify_week("2026-W41")
        self.assertFalse(verdict["ok"])
        self.assertEqual(verdict["reason"], "NO_LOCKED_UNIVERSE")

    async def test_verify_week_detects_mismatch(self):
        self.db.market_watch_universe.docs.append(
            {"weekId": "2026-W40", "status": mw_config.WEEK_STATUS_LOCKED, "symbols": ["A"], "version": 2}
        )
        verdict = await mw_u.verify_week("2026-W41")
        self.assertFalse(verdict["ok"])
        self.assertEqual(verdict["reason"], "WEEK_MISMATCH")

    async def test_active_symbols_empty_without_lock(self):
        self.assertEqual(await mw_u.active_symbols(), frozenset())

    def test_engine_state_offline_without_lock(self):
        self.assertEqual(mw_u.engine_state_for(None), mw_config.ENGINE_STATE_OFFLINE)

    async def test_lock_document_carries_a_deterministic_id(self):
        """doc §6/§31 — the buffer upserts on ``_id``, so a LOCK can never
        produce two rows for the same week."""
        await mw_u.record_decision("2026-W41", "SBIN", "ADD")
        result = await mw_u.lock_universe("2026-W41", locked_by="tester")
        stored = self.db.market_watch_universe.docs[-1]
        self.assertEqual(stored["_id"], "2026-W41:LOCKED")
        self.assertEqual(
            self.db.market_watch_universe_history.docs[-1]["_id"], f"2026-W41:v{result['version']}"
        )

    async def test_version_is_monotonic_for_the_week(self):
        """doc §6 — the version continues from what is already stored for the
        week, so a re-lock never resets it to 1. doc §33 still refuses a second
        LOCK of a live week, so the prior row here is SUPERSEDED."""
        self.db.market_watch_universe.docs.append(
            {
                "_id": "2026-W41:LOCKED_SUPERSEDED",
                "weekId": "2026-W41",
                "status": mw_config.WEEK_STATUS_SUPERSEDED,
                "version": 7,
                "symbols": ["SBIN"],
            }
        )
        await mw_u.record_decision("2026-W41", "SBIN", "ADD")
        locked = await mw_u.lock_universe("2026-W41")
        self.assertEqual(locked["version"], 8)

    async def test_weekly_collections_are_registered_with_the_db_writer(self):
        """doc §13/§31 — every Market Watch write is DB-Writer owned, so the
        weekly collections must exist in the writer's document buffer."""
        from services import market_watch_doc_buffer

        for name in (
            mw_u.COLLECTION_UNIVERSE,
            mw_u.COLLECTION_HISTORY,
            mw_u.COLLECTION_DECISIONS,
            "market_watch_weekly_reports",
        ):
            self.assertIn(name, market_watch_doc_buffer.COLLECTIONS)


# --------------------------------------------------------------------------- #
# §13 / §35.9 — the DB Writer hand-off is the real writer
# --------------------------------------------------------------------------- #
class DbWriterHandOffTest(unittest.TestCase):
    """doc §13/§35.9 — DB Writer is the only MongoDB owner for Market Watch writes.

    These run against the real module (no fakes): the regression was importing
    the ``db_writer_engine`` **module** and calling ``buffer_documents`` on it,
    which raised ``AttributeError`` every time, so every weekly write reported
    ``persisted: false`` and the LOCK was silently never stored.
    """

    def test_universe_sink_is_the_writer_instance(self):
        sink = mw_u._sink()
        self.assertTrue(hasattr(sink, "buffer_documents"), "sink must expose buffer_documents")
        from services.db_writer_engine import db_writer_engine as writer

        self.assertIs(sink, writer)

    def test_weekly_report_buffer_reaches_the_document_buffer(self):
        accepted = mw_w._buffer([{"_id": "2026-W41:probe", "weekId": "2026-W41"}])
        self.assertTrue(accepted)
        from services import market_watch_doc_buffer

        self.assertGreaterEqual(
            market_watch_doc_buffer.stats()["byCollection"]["market_watch_weekly_reports"]["received"], 1
        )


# --------------------------------------------------------------------------- #
# §3 / §7 — the engine only monitors the LOCKED list
# --------------------------------------------------------------------------- #
class LockedUniverseBuildTest(unittest.TestCase):
    def _engine(self):
        from services.market_watch_engine import MarketWatchEngine

        return MarketWatchEngine()

    def _instruments(self):
        return [
            {"symbol": "A", "token": "1", "companyName": "A Ltd", "exchangeSegment": "nse_cm",
             "instrumentType": "EQ", "tradingStatus": "ACTIVE"},
            {"symbol": "B", "token": "2", "companyName": "B Ltd", "exchangeSegment": "nse_cm",
             "instrumentType": "EQ", "tradingStatus": "ACTIVE"},
            {"symbol": "C", "token": "3", "companyName": "C Ltd", "exchangeSegment": "nse_cm",
             "instrumentType": "EQ", "tradingStatus": "ACTIVE"},
        ]

    def test_only_locked_symbols_are_monitored(self):
        """doc §35.2/§35.4 — Instrument Master availability does NOT authorise a
        subscription."""
        engine = self._engine()
        engine._build_locked_universe(self._instruments(), frozenset({"A", "B"}))
        self.assertEqual(set(engine._universe), {"1", "2"})
        self.assertNotIn("3", engine._universe)

    def test_unresolvable_locked_symbol_is_reported_not_swapped(self):
        engine = self._engine()
        engine._build_locked_universe(self._instruments(), frozenset({"A", "TYPO"}))
        self.assertEqual(set(engine._universe), {"1"})
        self.assertEqual(engine._universe_unresolved, ["TYPO"])

    def test_empty_lock_yields_empty_universe(self):
        engine = self._engine()
        engine._build_locked_universe(self._instruments(), frozenset())
        self.assertEqual(engine._universe, set())

    def test_universe_source_defaults_to_locked(self):
        """doc §7 — LOCKED is the only mode that satisfies §35."""
        self.assertEqual(mw_config.load().weekly.universe_source, mw_config.UNIVERSE_SOURCE_LOCKED)
        self.assertTrue(mw_config.load().weekly.locked_universe_required)

    def test_records_outside_the_universe_are_pruned(self):
        """doc §3/§7 — a live record for a non-member is not Market Watch state.

        Before this existed the engine kept serving merged master-derived rows,
        so ``/rank`` returned thousands of stocks that were not in the lock.
        """
        engine = self._engine()
        engine._records = {"1": {"token": "1"}, "3": {"token": "3"}}
        engine._tick_cache = {"1": {}, "3": {}}
        engine._build_locked_universe(self._instruments(), frozenset({"A", "B"}))
        self.assertEqual(sorted(engine._records), ["1"])
        self.assertNotIn("3", engine.full_universe_rows() and [r["token"] for r in engine.full_universe_rows()])

    def test_tick_for_a_symbol_outside_the_universe_is_not_accepted(self):
        """doc §3/§7/§35.2 — Instrument Master availability is not a subscription."""
        engine = self._engine()
        engine._build_locked_universe(self._instruments(), frozenset({"A", "B"}))
        self.assertTrue(engine._accepts_tick("1"))
        self.assertFalse(engine._accepts_tick("3"))

    def test_tick_outside_the_universe_creates_no_record_and_is_counted(self):
        """doc §12/§30 — an out-of-universe tick is counted, never silently kept."""
        from services.market_watch_engine import MarketWatchEngine

        engine = MarketWatchEngine()
        engine._build_locked_universe(self._instruments(), frozenset({"A"}))
        engine._seed_states()
        engine._process_tick("3", {"symbol": "C", "ltp": 100.0, "prevClose": 99.0})
        self.assertNotIn("3", engine._records)
        self.assertEqual(engine._tick_count, 0)
        self.assertEqual(engine._out_of_universe_tick_count, 1)
        self.assertEqual(engine._received_tick_count, 1)

    def test_locked_tick_does_enter_records(self):
        engine = self._engine()
        engine._build_locked_universe(self._instruments(), frozenset({"A", "B"}))
        engine._seed_states()
        engine._process_tick("1", {"symbol": "A", "ltp": 100.0, "prevClose": 99.0})
        self.assertIn("1", engine._records)
        self.assertEqual(engine._out_of_universe_tick_count, 0)

    def test_out_of_universe_metric_is_exposed(self):
        from services.market_watch_engine import MarketWatchEngine

        custom = MarketWatchEngine().status_snapshot()["metrics"]["custom"]
        self.assertIn("out_of_universe_tick_count", custom)


# --------------------------------------------------------------------------- #
# §14 / §16 / §17 / §19 / §20 / §21 / §23 — per-symbol state
# --------------------------------------------------------------------------- #
class SpecStateTest(unittest.TestCase):
    def setUp(self):
        self.cfg = mw_config.load()
        self.state = SymbolState(symbol="A", instrument_token="1")
        self.state.apply_price_tick(
            now=1000.0, ltp=800.0, previous_close=799.0,
            volume=1000.0, open_=799.0, high=801.0, low=798.0,
        )

    # ---- §14 circuit ----
    def test_circuit_unknown_without_real_prices(self):
        """doc §35.12/§14 — never fabricate safety."""
        self.state.recompute_circuit_status(self.cfg)
        self.assertEqual(self.state.circuit_status, "UNKNOWN")
        self.assertIsNone(self.state.min_circuit_distance_pct())

    def test_circuit_safe_from_real_prices(self):
        self.state.apply_circuits(840.0, 780.0)
        self.state.recompute_circuit_status(self.cfg)
        self.assertEqual(self.state.circuit_status, "SAFE")

    def test_circuit_danger_below_two_percent(self):
        """doc §14 — minimum valid circuit distance < 2% is DANGER."""
        self.state.apply_circuits(812.0, 792.0)  # ~1.5% away from LTP 800
        self.state.recompute_circuit_status(self.cfg)
        self.assertEqual(self.state.circuit_status, "DANGER")

    def test_circuit_hit_at_boundary(self):
        self.state.apply_circuits(800.0, 792.0)
        self.state.recompute_circuit_status(self.cfg)
        self.assertEqual(self.state.circuit_status, "HIT")

    def test_missing_side_is_not_treated_as_zero_distance(self):
        self.state.apply_circuits(816.0, None)
        self.state.recompute_circuit_status(self.cfg)
        self.assertEqual(self.state.circuit_status, "UNKNOWN")

    # ---- §16 ₹800 ----
    def test_threshold_observation_sampled_at_interval(self):
        now = 1000.0
        self.assertTrue(self.state.observe_threshold(850.0, 800.0, now, 60.0))
        # Inside the sampling interval a second observation is ignored.
        self.assertFalse(self.state.observe_threshold(850.0, 800.0, now + 10.0, 60.0))
        self.assertEqual(self.state.observations_above_threshold, 1)

    def test_threshold_observations_split_above_and_below(self):
        self.state.observe_threshold(850.0, 800.0, 1000.0, 0.0)
        self.state.observe_threshold(750.0, 800.0, 1001.0, 0.0)
        self.assertEqual(self.state.observations_above_threshold, 1)
        self.assertEqual(self.state.observations_at_or_below_threshold, 1)

    def test_threshold_crossing_does_not_change_membership(self):
        """doc §33/§35.15 — observation only, never a membership mutation."""
        before = [self.state.symbol]
        self.state.observe_threshold(5000.0, 800.0, 1000.0, 0.0)
        self.state.evaluate_stock_state(now=1000.0, stale_after=30, cfg=self.cfg)
        self.assertEqual([self.state.symbol], before)
        # A SymbolState has no universe/membership handle at all, so a price
        # crossing structurally cannot mutate membership.
        self.assertFalse(hasattr(self.state, "universe"))
        self.assertEqual(self.state.observations_above_threshold, 1)

    # ---- §17 margin ----
    def test_margin_unavailable_when_broker_published_nothing(self):
        status = self.state.apply_margin(value=None, multiplier=None, threshold=5.0)
        self.assertEqual(status, "UNAVAILABLE")
        self.assertIsNone(self.state.margin_value)
        self.assertIsNone(self.state.margin_multiplier)

    def test_margin_below_threshold(self):
        status = self.state.apply_margin(value=1000.0, multiplier=3.0, threshold=5.0)
        self.assertEqual(status, "BELOW_THRESHOLD")

    def test_margin_authoritative_above_threshold(self):
        status = self.state.apply_margin(value=1000.0, multiplier=8.0, threshold=5.0)
        self.assertEqual(status, "AUTHORITATIVE")

    # ---- §21 movers ----
    def test_movement_flags_are_backend_computed(self):
        self.state.timeframes["1m"].open = 100.0
        self.state.timeframes["1m"].close = 102.0
        self.state.timeframes["1m"]._recompute(1000.0)
        flags = self.state.evaluate_movement_flags(1.0)
        self.assertTrue(flags["1m"])
        self.assertFalse(flags["5m"])

    def test_timeframe_without_data_is_never_a_mover(self):
        flags = self.state.evaluate_movement_flags(1.0)
        self.assertFalse(flags["30m"])

    # ---- §20 / §27 classification ----
    def test_normal_below_one_percent(self):
        self.state.change = 2.0
        self.state.change_pct = 0.25
        self.state.evaluate_stock_state(now=1000.0, stale_after=30, cfg=self.cfg)
        self.assertEqual(self.state.classification, "NORMAL")
        self.assertEqual(self.state.stock_state, "ACTIVE")

    def test_gainer_and_loser(self):
        self.state.change = 12.0
        self.state.change_pct = 1.5
        self.state.evaluate_stock_state(now=1000.0, stale_after=30, cfg=self.cfg)
        self.assertEqual(self.state.classification, "GAINER")
        self.state.change = -12.0
        self.state.change_pct = -1.5
        self.state.evaluate_stock_state(now=1000.0, stale_after=30, cfg=self.cfg)
        self.assertEqual(self.state.classification, "LOSER")

    def test_danger_beats_everything(self):
        """doc §20 precedence: DANGER > INTRADAY_UNAVAILABLE > GAINER/LOSER > NORMAL."""
        self.state.apply_circuits(812.0, 792.0)
        self.state.recompute_circuit_status(self.cfg)
        self.state.change_pct = 5.0
        self.state.evaluate_stock_state(now=1000.0, stale_after=30, cfg=self.cfg)
        self.assertEqual(self.state.classification, "DANGER")
        self.assertEqual(self.state.stock_state, "DANGER")

    def test_intraday_unavailable_beats_movement(self):
        from services.market_watch_config import ELIGIBILITY_UNAVAILABLE

        self.state.intraday_status = ELIGIBILITY_UNAVAILABLE
        self.state.change_pct = 9.0
        self.state.evaluate_stock_state(now=1000.0, stale_after=30, cfg=self.cfg)
        self.assertEqual(self.state.classification, "INTRADAY_UNAVAILABLE")
        self.assertEqual(self.state.stock_state, "INTRADAY_UNAVAILABLE")

    def test_stale_symbol_never_reports_active(self):
        self.state.change_pct = 0.1
        self.state.status = "STALE"
        self.state.evaluate_stock_state(now=1000.0, stale_after=30, cfg=self.cfg)
        self.assertEqual(self.state.stock_state, "STALE")

    def test_no_price_is_no_data(self):
        s = SymbolState(symbol="B", instrument_token="2")
        s.evaluate_stock_state(now=1000.0, stale_after=30, cfg=self.cfg)
        self.assertEqual(s.stock_state, "NO_DATA")

    # ---- §23 frontend contract ----
    def test_public_payload_exposes_every_contract_field(self):
        self.state.apply_circuits(840.0, 780.0)
        self.state.recompute_circuit_status(self.cfg)
        self.state.timeframes["1m"].open = 799.0
        self.state.timeframes["1m"].close = 800.0
        self.state.timeframes["1m"]._recompute(1000.0)
        self.state.evaluate_movement_flags(self.cfg.weekly.mover_threshold_pct)
        self.state.evaluate_stock_state(now=1000.0, stale_after=30, cfg=self.cfg)
        out = self.state.to_public()
        for field in (
            "symbol", "ltp", "change", "changePercent",
            "upperCircuit", "lowerCircuit", "circuitDistancePct", "circuitStatus",
            "marginValue", "marginMultiplier", "marginStatus",
            "change_1m", "change_1m_pct", "change_2m", "change_2m_pct",
            "change_5m", "change_5m_pct",
            "change_10m", "change_10m_pct", "change_30m", "change_30m_pct",
            "classification", "movementFlags", "lastTickAt", "dataQuality",
        ):
            self.assertIn(field, out)

    def test_missing_values_stay_null_not_zero(self):
        """doc §35.11 — missing data is never fabricated."""
        s = SymbolState(symbol="C", instrument_token="3")
        out = s.to_public()
        self.assertIsNone(out["ltp"])
        self.assertIsNone(out["marginValue"])
        self.assertIsNone(out["marginMultiplier"])
        self.assertIsNone(out["change_1m_pct"])
        self.assertEqual(out["circuitStatus"], "UNKNOWN")
        self.assertEqual(out["marginStatus"], "UNAVAILABLE")


# --------------------------------------------------------------------------- #
# §30 — observability contract
# --------------------------------------------------------------------------- #
class ObservabilityContractTest(unittest.TestCase):
    REQUIRED = (
        "locked_universe_count", "active_subscription_count", "received_tick_count",
        "validated_tick_count", "invalid_tick_count", "danger_count",
        "intraday_unavailable_count", "top_gainers_count", "top_losers_count",
        "movers_1m_count", "movers_2m_count", "movers_5m_count", "movers_10m_count", "movers_30m_count",
        "last_tick_at", "processing_latency_ms", "publish_latency_ms", "websocket_status",
    )

    def test_every_required_metric_is_present_at_the_top_level(self):
        from services.market_watch_engine import MarketWatchEngine

        custom = MarketWatchEngine().status_snapshot()["metrics"]["custom"]
        for name in self.REQUIRED:
            self.assertIn(name, custom)

    def test_stock_state_vocabularies_are_zero_filled(self):
        from services.market_watch_engine import MarketWatchEngine

        custom = MarketWatchEngine().status_snapshot()["metrics"]["custom"]
        for name in mw_config.STOCK_STATES:
            self.assertIn(name, custom["stockStates"])
            self.assertEqual(custom["stockStates"][name], 0)
        for name in mw_config.CLASSIFICATIONS:
            self.assertIn(name, custom["classificationCounts"])

    def test_weekly_block_reports_verify_verdict(self):
        from services.market_watch_engine import MarketWatchEngine

        weekly = MarketWatchEngine().status_snapshot()["metrics"]["custom"]["weekly"]
        self.assertEqual(weekly["universeSource"], mw_config.UNIVERSE_SOURCE_LOCKED)
        self.assertIn("verify", weekly)
        self.assertIn("engineState", weekly)

    def test_invalid_ticks_are_counted_not_silently_dropped(self):
        """doc §12/§30."""
        from services.market_watch_engine import MarketWatchEngine

        engine = MarketWatchEngine()
        engine._process_tick("T1", {"symbol": "A", "ltp": None, "prevClose": 10.0})
        self.assertEqual(engine.status_snapshot()["metrics"]["custom"]["invalid_tick_count"], 1)
        self.assertEqual(engine._received_tick_count, 1)

    def test_valid_tick_counts_as_validated(self):
        from services.market_watch_engine import MarketWatchEngine

        engine = MarketWatchEngine()
        engine._process_tick("T1", {"symbol": "A", "ltp": 100.0, "prevClose": 99.0})
        self.assertEqual(engine._received_tick_count, 1)
        self.assertEqual(engine._invalid_tick_count, 0)


# --------------------------------------------------------------------------- #
# §22 — the 1% boards and Circuit Danger are actually produced
# --------------------------------------------------------------------------- #
class BoardNameTest(unittest.TestCase):
    """doc §21/§22 — the 1% boards, Circuit Danger and their exclusion rules."""

    def _seeded_engine(self):
        from services.market_watch_engine import MarketWatchEngine

        engine = MarketWatchEngine()
        cfg = mw_config.load()
        now = 1000.0
        prev = 100.0
        #  symbol  daily%  upper  lower   expected
        plan = (
            ("1", "AAA", +3.0, 105.0, 101.0),   # ltp 103 → upper distance 1.9% → DANGER
            ("2", "BBB", -3.0, 99.5, 95.0),    # ltp 97  → upper distance 2.5% → SAFE
            ("3", "CCC", +0.2, 105.0, 95.0),    # ltp 100.2 → SAFE, below the 1% mover band
        )
        for token, symbol, pct, upper, lower in plan:
            ltp = prev * (1 + pct / 100.0)
            state = SymbolState(symbol=symbol, instrument_token=token)
            state.apply_price_tick(
                now=now, ltp=ltp, previous_close=prev, volume=1000.0,
                open_=prev, high=ltp * 1.02, low=ltp * 0.98,
            )
            state.apply_circuits(upper, lower)
            state.recompute_circuit_distance()
            state.recompute_circuit_status(cfg)
            # Seed ALL FOUR timeframes so every per-timeframe board is exercised.
            for tf_name in mw_config.TIMEFRAMES:
                tf = state.timeframes[tf_name]
                tf.open, tf.close, tf.tick_count, tf.volume = prev, ltp, 5, 100.0
                tf.data_quality = "COMPLETE"
                tf._recompute(now)
            state.evaluate_movement_flags(cfg.weekly.mover_threshold_pct)
            state.evaluate_stock_state(
                now=now, stale_after=cfg.cadence.stale_threshold_seconds, cfg=cfg
            )
            engine._states[token] = state
            engine._eligible_tokens.add(token)
        return engine

    def _boards(self):
        import asyncio

        engine = self._seeded_engine()
        asyncio.run(engine._run_official_rankings("2026-10-09", 1000.0))
        return engine, engine.official_rankings()

    def test_seeded_states_classified_as_expected(self):
        engine = self._seeded_engine()
        self.assertEqual(engine._states["1"].circuit_status, "DANGER")
        self.assertEqual(engine._states["1"].stock_state, "DANGER")
        self.assertEqual(engine._states["2"].circuit_status, "SAFE")
        self.assertEqual(engine._states["2"].stock_state, "ACTIVE")
        self.assertEqual(engine._states["3"].classification, "NORMAL")

    def test_one_percent_and_circuit_danger_boards_exist(self):
        _, boards = self._boards()
        names = set(boards.keys())
        for tf in mw_config.TIMEFRAMES:
            self.assertIn(f"movers_1pct_{tf}", names)
            self.assertIn(f"decliners_1pct_{tf}", names)
        self.assertIn("circuit_danger", names)
        self.assertIn("circuit_near", names)
        self.assertIn("most_active", names)

    def test_danger_stock_is_excluded_from_the_1pct_boards(self):
        """doc §14/§15 — a DANGER stock leaves the active calculation set."""
        _, boards = self._boards()
        for tf in mw_config.TIMEFRAMES:
            for name in (f"movers_1pct_{tf}", f"decliners_1pct_{tf}"):
                symbols = {r.get("symbol") for r in boards[name]}
                self.assertNotIn("AAA", symbols, f"{name} must exclude the DANGER symbol")

    def test_one_percent_boards_honour_the_threshold(self):
        """doc §21 — a stock below 1% must not appear on a 1% board."""
        _, boards = self._boards()
        for tf in mw_config.TIMEFRAMES:
            for name in (f"movers_1pct_{tf}", f"decliners_1pct_{tf}"):
                for row in boards[name]:
                    pct = row[f"change_{tf}_pct"]
                    self.assertIsNotNone(pct)
                    self.assertGreaterEqual(abs(pct), 1.0)
                    self.assertNotEqual(row.get("symbol"), "CCC")

    def test_decliner_board_carries_the_negative_mover(self):
        _, boards = self._boards()
        symbols = {r.get("symbol") for r in boards["decliners_1pct_5m"]}
        self.assertIn("BBB", symbols)

    def test_circuit_danger_board_holds_the_danger_symbol(self):
        _, boards = self._boards()
        symbols = {r.get("symbol") for r in boards["circuit_danger"]}
        self.assertIn("AAA", symbols)
        self.assertNotIn("BBB", symbols)

    def test_board_rows_carry_the_frontend_contract_fields(self):
        """doc §23."""
        _, boards = self._boards()
        row = boards["top_gainers"][0]
        for field in (
            "circuitDistancePct", "circuitStatus", "marginValue", "marginMultiplier",
            "marginStatus", "intradayStatus", "classification", "stockState",
            "movementFlags", "change_1m", "change_1m_pct", "change_2m", "change_2m_pct",
            "change_30m", "change_30m_pct",
        ):
            self.assertIn(field, row)

    def test_unknown_circuit_symbols_are_absent_from_circuit_boards(self):
        """doc §14 — UNKNOWN circuit must not be presented as near or danger."""
        _, boards = self._boards()
        for name in ("circuit_danger", "circuit_near"):
            for row in boards[name]:
                self.assertNotEqual(row.get("circuitStatus"), "UNKNOWN")


# --------------------------------------------------------------------------- #
# §5 — weekly report field list
# --------------------------------------------------------------------------- #
class WeeklyReportTest(unittest.IsolatedAsyncioTestCase):
    async def test_report_runs_without_data_and_stays_honest(self):
        with patch.object(mw_w, "_db", lambda: _FakeDb()):
            report = await mw_w.build_weekly_report("2026-W41", symbols=["A", "B"])
        self.assertEqual(report["weekId"], "2026-W41")
        self.assertEqual(report["counts"]["reviewed"], 2)
        self.assertEqual(report["counts"]["withoutData"], 2)
        for row in report["rows"]:
            # doc §35.11 — nothing fabricated when there is no saved data.
            self.assertIsNone(row["latestLtp"])
            self.assertIsNone(row["weeklyMinLtp"])
            self.assertIsNone(row["weeklyChangePercent"])
            self.assertIsNone(row["marginValue"])
            self.assertIsNone(row["upperCircuit"])
            self.assertEqual(row["recommendation"], mw_config.RECOMMENDATION_REVIEW)

    async def test_report_uses_backend_threshold_and_is_advisory(self):
        with patch.object(mw_w, "_db", lambda: _FakeDb()):
            report = await mw_w.build_weekly_report("2026-W41", symbols=["A"])
        self.assertEqual(report["threshold"], mw_config.load().weekly.rupee_threshold)
        # doc §5 — the report advises, it never mutates.
        self.assertIn("advisory", " ".join(report["notes"]).lower())

    def test_trading_days_exclude_the_weekend(self):
        days = mw_w.trading_days_for(datetime(2026, 10, 5))
        self.assertTrue(all(datetime.fromisoformat(d).weekday() < 5 for d in days))


# --------------------------------------------------------------------------- #
# §24 — the frontend contract the UI must be able to render
# --------------------------------------------------------------------------- #
class FrontendContractTest(unittest.TestCase):
    def test_no_market_arithmetic_on_the_frontend_row(self):
        """doc §24 — the TS row type carries values, it has no calculator.

        This is a structural guard: the previous UI derived gainer/loser tone
        and a "movers" ranking from raw ticks. The contract is that the shared
        module exposes only formatters and accessors.
        """
        import pathlib
        import re

        root = pathlib.Path(__file__).resolve().parents[2]
        shared = (root / "app" / "_pages" / "market-watch" / "mw-shared.tsx").read_text(encoding="utf-8")
        # No division by a previous close and no abs()-based ranking sort.
        self.assertNotIn("prevClose) * 100", shared)
        self.assertNotRegex(shared, r"Math\.abs\(\s*\w+\.changePercent\s*\)\s*\)?\s*-")
        self.assertIsNone(re.search(r"\.sort\(.*changePercent", shared))


# --------------------------------------------------------------------------- #
# doc 2 review-window targeting — the Saturday review reads the week that
# FINISHED and locks the week that is ABOUT TO START.
#
# Regression cover for the defect where every draft/decision/lock defaulted to
# the current ISO week. During and after a trading week that week is already
# LOCKED, so ADD / REMOVE / KEEP and the LOCK all answered ``WEEK_LOCKED`` and
# the review flow could never be completed from the UI.
# --------------------------------------------------------------------------- #
class ReviewWindowTargetTest(unittest.TestCase):
    #: Saturday 2026-10-10, the review moment (doc 2).
    SATURDAY = datetime(2026, 10, 10, 18, 0)
    #: The trading week that finished: Mon 2026-10-05 .. Fri 2026-10-09.
    FINISHED_WEEK = "2026-W41"
    #: The week that starts next: Mon 2026-10-12.
    UPCOMING_WEEK = "2026-W42"

    def test_saturday_report_reads_the_week_that_finished(self):
        self.assertEqual(mw_u.week_id_for(self.SATURDAY), self.FINISHED_WEEK)

    def test_saturday_lock_targets_the_upcoming_week(self):
        self.assertEqual(mw_u.review_target_week_id(self.SATURDAY), self.UPCOMING_WEEK)
        self.assertEqual(mw_u.next_week_id_for(self.SATURDAY), self.UPCOMING_WEEK)

    def test_review_target_differs_from_the_being_reviewed_week(self):
        """The two must never collapse to one id, or the lock is a no-op."""
        self.assertNotEqual(
            mw_u.review_target_week_id(self.SATURDAY),
            mw_u.week_id_for(self.SATURDAY),
        )

    def test_next_week_start_is_the_monday_after_the_review(self):
        self.assertEqual(mw_u.next_week_start(self.SATURDAY).date(), datetime(2026, 10, 12).date())

    def test_a_weekday_also_targets_the_upcoming_week(self):
        """Mid-week the operator is still preparing next week's membership."""
        friday = datetime(2026, 10, 9, 15, 0)
        self.assertEqual(mw_u.review_target_week_id(friday), self.UPCOMING_WEEK)

    def test_monday_targets_the_current_week(self):
        """On Monday the week being entered may not be locked yet."""
        monday = datetime(2026, 10, 12, 9, 0)
        self.assertEqual(mw_u.review_target_week_id(monday), self.UPCOMING_WEEK)

    def test_next_review_at_is_a_saturday(self):
        at = mw_u.next_review_at()
        if at is None:
            self.skipTest("weekly review disabled by configuration")
        self.assertEqual(datetime.fromisoformat(at).weekday(), 5)


# --------------------------------------------------------------------------- #
# Review-command composition + audit trail.
#
# Regression cover for two real data-loss defects:
#
# 1. ``persist_universe`` hands the draft to the DB Writer BUFFER (flushed a few
#    seconds later) while ``get_draft`` read straight from Mongo. A second
#    decision therefore read a state predating the first, and the next upsert
#    keyed ``weekId:DRAFT`` silently discarded the earlier decision.
# 2. The decision document carried no ``_id``, and the doc buffer DROPS
#    idempotent documents without one — so the whole operator decision audit
#    trail was discarded without a word.
# --------------------------------------------------------------------------- #
class ReviewCommandCompositionTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.db = _FakeDb()
        universe_col = self.db.market_watch_universe
        decisions_col = self.db.market_watch_review_decisions

        def _persist(u):
            """Stand in for the DB Writer hand-off: buffer then upsert."""
            universe_col.upsert(u.to_doc())
            return True

        def _buffer(collection, docs):
            target = getattr(self.db, collection, None)
            if target is None:
                return True
            for doc in docs:
                target.upsert(doc)
            return True

        class _FakeWriter:
            @staticmethod
            def buffer_documents(collection, docs):
                return _buffer(collection, list(docs))

        self.decisions = decisions_col
        # Capture the real hand-off BEFORE patching, so the locked-week guard can
        # be exercised even though ``persist_universe`` is patched for the
        # decision flow.
        self._real_persist = mw_u.persist_universe
        self._patches = [
            patch.object(mw_u, "_db", lambda: self.db),
            patch.object(mw_u, "_buffer", _buffer),
            patch.object(mw_u, "_sink", lambda: _FakeWriter),
            patch.object(mw_u, "persist_universe", _persist),
        ]
        for p in self._patches:
            p.start()
        mw_u.invalidate_cache()
        self.addCleanup(lambda: [p.stop() for p in self._patches])

    async def test_consecutive_decisions_compose(self):
        """Every command must survive into the next read-modify-write cycle.

        ADD SBIN -> REMOVE SBIN -> ADD TATAMOTORS has to end with TATAMOTORS in
        the draft, SBIN recorded as removed and both facts still visible. Before
        the in-process draft overlay each read hit Mongo while the previous write
        was still sitting unflushed in the DB Writer buffer, so the last command
        silently overwrote the earlier ones.
        """
        await mw_u.record_decision("2026-W42", "SBIN", "ADD")
        await mw_u.record_decision("2026-W42", "SBIN", "REMOVE")
        await mw_u.record_decision("2026-W42", "TATAMOTORS", "ADD")

        draft = await mw_u.get_draft("2026-W42")
        self.assertIn("TATAMOTORS", draft.symbols)
        self.assertNotIn("SBIN", draft.symbols)
        self.assertEqual(draft.removed, ["SBIN"])
        self.assertEqual(draft.added, ["TATAMOTORS"])

    async def test_sequential_decisions_accumulate_symbol_count(self):
        """Each ADD must survive into the next read-modify-write cycle."""
        await mw_u.record_decision("2026-W42", "SBIN", "ADD")
        for symbol in ("TCS", "INFY", "HDFCBANK"):
            await mw_u.record_decision("2026-W42", symbol, "ADD")
        draft = await mw_u.get_draft("2026-W42")
        for symbol in ("SBIN", "TCS", "INFY", "HDFCBANK"):
            self.assertIn(symbol, draft.symbols)
        self.assertEqual(len(draft), 4)
        self.assertEqual(sorted(draft.added), ["HDFCBANK", "INFY", "SBIN", "TCS"])

    async def test_decision_document_carries_a_deterministic_id(self):
        """The doc buffer silently drops idempotent documents with no ``_id``."""
        doc = await mw_u.record_decision("2026-W42", "SBIN", "ADD")
        self.assertEqual(doc.get("_id"), "2026-W42:SBIN")

    async def test_decision_audit_trail_is_stored(self):
        await mw_u.record_decision("2026-W42", "SBIN", "ADD")
        await mw_u.record_decision("2026-W42", "TCS", "REMOVE")
        stored = {d.get("symbol"): d for d in self.decisions.docs}
        self.assertEqual(sorted(stored), ["SBIN", "TCS"])
        self.assertEqual(stored["SBIN"].get("action"), "ADD")
        self.assertEqual(stored["TCS"].get("action"), "REMOVE")

    async def test_reseeding_draft_discards_the_staged_overlay(self):
        await mw_u.record_decision("2026-W42", "TATAMOTORS", "ADD")
        await mw_u.seed_draft_from_locked("2026-W42")
        draft = await mw_u.get_draft("2026-W42")
        self.assertNotIn("TATAMOTORS", draft.added)

    async def test_locked_week_overlay_is_dropped(self):
        """doc 33 — a locked week is immutable, so nothing may stay editable."""
        await mw_u.record_decision("2026-W42", "SBIN", "ADD")
        locked = mw_u.WeeklyUniverse(
            week_id="2026-W42",
            status=mw_u.WEEK_STATUS_LOCKED,
            symbols=["SBIN"],
        )
        self.assertFalse(self._real_persist(locked))
        with mw_u._cache_lock:
            self.assertNotIn("2026-W42", mw_u._draft_overlay)

    async def test_empty_draft_keeps_its_audit_state(self):
        """A zero-symbol draft must not be treated as "no draft".

        ``WeeklyUniverse`` defines ``__len__``, so an empty draft is falsy. Code
        written as ``await get_draft(...) or WeeklyUniverse(...)`` therefore threw
        away a real draft the moment its last symbol was removed, losing the whole
        added/removed/kept audit trail.
        """
        await mw_u.record_decision("2026-W42", "SBIN", "ADD")
        await mw_u.record_decision("2026-W42", "SBIN", "REMOVE")

        draft = await mw_u.get_draft("2026-W42")
        self.assertIsNotNone(draft)
        self.assertEqual(len(draft), 0)
        self.assertEqual(draft.removed, ["SBIN"])

        # A further decision must build on that state, not on a fresh universe.
        await mw_u.record_decision("2026-W42", "TCS", "ADD")
        after = await mw_u.get_draft("2026-W42")
        self.assertEqual(after.symbols, ["TCS"])
        self.assertEqual(after.removed, ["SBIN"])


# --------------------------------------------------------------------------- #
# doc 6 validity window + falsy-universe guards.
# --------------------------------------------------------------------------- #
class LockValidityWindowTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.db = _FakeDb()
        universe_col = self.db.market_watch_universe
        history_col = self.db.market_watch_universe_history

        def _persist(u):
            universe_col.upsert(u.to_doc())
            return True

        def _buffer(collection, docs):
            target = getattr(self.db, collection, None)
            if target is None:
                return True
            for doc in docs:
                target.upsert(doc)
            return True

        class _FakeWriter:
            @staticmethod
            def buffer_documents(collection, docs):
                return _buffer(collection, list(docs))

        self._patches = [
            patch.object(mw_u, "_db", lambda: self.db),
            patch.object(mw_u, "_buffer", _buffer),
            patch.object(mw_u, "_sink", lambda: _FakeWriter),
            patch.object(mw_u, "persist_universe", _persist),
        ]
        for p in self._patches:
            p.start()
        mw_u.invalidate_cache()
        self.addCleanup(lambda: [p.stop() for p in self._patches])
        self.history = history_col

    def test_week_start_from_id_round_trips(self):
        self.assertEqual(
            mw_u.week_start_from_id("2026-W42").date(), datetime(2026, 10, 12).date()
        )

    def test_week_start_from_id_rejects_garbage(self):
        self.assertIsNone(mw_u.week_start_from_id("not-a-week"))

    async def test_lock_window_matches_the_locked_week_not_today(self):
        """doc 6 — the validity window belongs to the week being locked."""
        await mw_u.seed_draft_from_locked("2026-W42")
        result = await mw_u.lock_universe("2026-W42", symbols=["SBIN"], locked_by="tester")
        universe = result.get("universe")
        self.assertIsNotNone(universe)
        self.assertTrue(universe.effective_from.startswith("2026-10-12"))
        self.assertTrue(universe.effective_to.startswith("2026-10-19"))

    async def test_empty_locked_universe_is_still_reported_as_locked(self):
        """A zero-symbol LOCKED week is valid (doc 2) and must not read as absent.

        ``WeeklyUniverse.__len__`` makes it falsy, so any truthiness-based check
        would report "no locked universe" and the engine would widen itself.
        """
        await mw_u.lock_universe("2026-W42", symbols=[], locked_by="tester")
        self.assertTrue(await mw_u.is_locked("2026-W42"))
        loaded = await mw_u.load_locked_universe(refresh=True)
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded.week_id, "2026-W42")
        self.assertEqual(len(loaded), 0)


if __name__ == "__main__":
    unittest.main()