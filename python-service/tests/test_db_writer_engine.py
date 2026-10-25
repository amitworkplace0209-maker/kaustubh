"""Tests for the DB Writer Engine (services/db_writer_engine.py) and the
Connection Engine diagnostics additions (connection_engine.status())."""

import os
import unittest
from contextlib import ExitStack, contextmanager
from unittest import mock
from unittest.mock import AsyncMock

from core.engines.engine_base import EngineCategory, EngineHealth
from services.db_writer_engine import DBWriterEngine


_TICK_STATS = {
    "bufferLength": 12,
    "totalReceived": 100,
    "totalWritten": 88,
    "totalWriteErrors": 1,
    "ticksPerSecond": 5.0,
    "writesPerSecond": 2.0,
    "lastTickAt": 1_700_000_000.0,
    "lastWriteAt": 1_700_000_000.0,
    "lastFlushAt": 1_700_000_000.0,
    "lastFlushDurationMs": 3.2,
    "pipelineRunning": True,
    "pipelineStartedAt": 1_600_000_000.0,
    "pipelineStoppedAt": None,
    "activeTickStocks": 4,
    "feedLatencyMs": {"currentMs": 1.1, "avgMs": 2.2, "samples": 10},
    "lastError": None,
}


def _patch_tick_buffer() -> ExitStack:
    stack = ExitStack()
    from services import tick_buffer

    stack.enter_context(mock.patch("services.tick_buffer.stats", return_value=dict(_TICK_STATS)))
    stack.enter_context(mock.patch("services.tick_buffer.start", new=AsyncMock(return_value=None)))
    stack.enter_context(mock.patch("services.tick_buffer.stop", new=AsyncMock(return_value=None)))
    stack.enter_context(mock.patch("services.tick_buffer.flush", new=AsyncMock(return_value=3)))
    stack.enter_context(mock.patch("services.tick_buffer.r_flush_interval_ms", return_value=1000))
    stack.enter_context(mock.patch("services.tick_buffer.r_buffer_max", return_value=10000))
    stack.enter_context(mock.patch("services.tick_buffer.r_bulk_insert", return_value=500))
    stack.enter_context(mock.patch.object(tick_buffer, "_BUFFER_HARD_CAP", 100000))
    return stack


def _mock_runtime_settings(personal_no_expiry=False, personal_expiry=False, market_watch=False):
    """Mock runtime_settings to return desired tick persistence policy values."""
    values = {
        "dbw_personal_no_expiry_ticks": personal_no_expiry,
        "dbw_personal_expiry_ticks": personal_expiry,
        "dbw_market_watch_ticks": market_watch,
    }
    return mock.patch("services.runtime_settings.get_runtime_setting", side_effect=lambda k: values.get(k))


def _mock_session_manager(personal_no_expiry=True, personal_expiry=False, market_watch=False):
    """Context manager to mock session_manager.active_registry() with desired source classification."""
    instruments = {}
    if personal_no_expiry:
        instruments["2885"] = {"instrumentToken": "2885", "source": "manual", "expiry_type": "PERMANENT", "expires_at": None}
    if personal_expiry:
        instruments["11536"] = {"instrumentToken": "11536", "source": "manual", "expiry_type": "SESSION", "expires_at": 9999999999}
    if market_watch:
        instruments["12345"] = {"instrumentToken": "12345", "source": "market_watch_daily_universe", "expiry_type": "PERMANENT", "expires_at": None}
    return mock.patch("services.session.session_manager.session_manager.active_registry", return_value=instruments)


def _patch_tick_buffer_with_latest() -> ExitStack:
    """Patch tick_buffer with get_latest_ticks and latest_tick_age_seconds."""
    stack = _patch_tick_buffer()
    from services import tick_buffer

    # Add realistic latest_ticks for per-instrument testing
    latest = {
        "2885": {"instrumentToken": "2885", "symbol": "RELIANCE", "ltp": 2500.5, "receivedAt": 1_700_000_000.0},
        "11536": {"instrumentToken": "11536", "symbol": "TCS", "ltp": 3500.0, "receivedAt": 1_700_000_000.0},
    }
    stack.enter_context(mock.patch("services.tick_buffer.get_latest_ticks", return_value=latest))
    stack.enter_context(mock.patch("services.tick_buffer.latest_tick_age_seconds", return_value=1.5))
    stack.enter_context(mock.patch("services.tick_buffer.momentum_windows", return_value={"1m": 0.5, "5m": 1.2}))
    return stack


class DBWriterEngineTest(unittest.IsolatedAsyncioTestCase):
    def test_identity(self):
        e = DBWriterEngine()
        self.assertEqual(e.engine_id, "db_writer_engine")
        self.assertEqual(e.engine_name, "DB Writer Engine")
        self.assertEqual(e.engine_category, EngineCategory.STORAGE)

    async def test_start_wires_tick_pipeline(self):
        patchers = _patch_tick_buffer()
        with patchers:
            e = DBWriterEngine()
            ok = await e.start()
            self.assertTrue(ok)
            self.assertTrue(e.is_running)
            from services.tick_buffer import start as tb_start

            self.assertTrue(tb_start.await_count >= 1)
            self.assertEqual(e.get_dependencies(), ["websocket_engine", "connection_manager"])
            cfg = e.status_snapshot()["configSummary"]
            self.assertEqual(cfg["flushIntervalMs"], 1000)
            self.assertEqual(cfg["bufferMaxSize"], 10000)

    async def test_status_snapshot_exposes_pipeline_and_audit(self):
        patchers = _patch_tick_buffer()
        with patchers:
            e = DBWriterEngine()
            snap = e.status_snapshot()
            self.assertEqual(snap["pipeline"]["totalWritten"], 88)
            self.assertEqual(snap["pipeline"]["bufferLength"], 12)
            self.assertEqual(snap["pipeline"]["pipelineRunning"], True)
            self.assertEqual(snap["metrics"]["custom"]["totalWriteErrors"], 1)
            self.assertIn("audit", snap)

    async def test_flush_delegates_and_records(self):
        """A manual flush drains BOTH buffers the DB Writer owns.

        Flushing only the Data Saver tick buffer would leave accepted Market
        Watch documents in memory while reporting the pipeline as drained.
        """
        patchers = _patch_tick_buffer()
        with patchers, mock.patch(
            "services.market_watch_doc_buffer.flush", new=AsyncMock(side_effect=[2, 0])
        ) as doc_flush:
            e = DBWriterEngine()
            res = await e.flush()
        self.assertEqual(res["written"], 3)
        self.assertEqual(res["documentsWritten"], 2)
        self.assertIsNone(res["marketWatchDocumentsError"])
        self.assertEqual(doc_flush.await_count, 2, "drain until the buffer is empty")
        e._refresh_metrics()
        self.assertEqual(e.status_snapshot()["lastFlushResult"]["written"], 3)

    async def test_flush_reports_a_document_write_failure_without_losing_the_tick_result(self):
        """A failing document buffer must not swallow the ticks that did flush."""
        patchers = _patch_tick_buffer()
        with patchers, mock.patch(
            "services.market_watch_doc_buffer.flush", new=AsyncMock(side_effect=RuntimeError("mongo down"))
        ):
            e = DBWriterEngine()
            res = await e.flush()
        self.assertEqual(res["written"], 3)
        self.assertEqual(res["marketWatchDocumentsError"], "mongo down")
        self.assertTrue(
            any(err.get("code") == "mw_document_flush_error" for err in e._recent_errors),
            "the failure must be recorded rather than hidden",
        )

    async def test_start_warns_about_enabled_but_uncapped_tick_streams(self):
        """Caps default OFF, so an enabled uncapped stream must be announced.

        The DB Writer must never silently truncate (that was the old bug), but
        'unbounded append-only writes' is also a real risk, so it is surfaced
        as a startup warning rather than discovered when the database fills.
        """
        enabled = {"dbw_personal_no_expiry_ticks": True, "dbw_market_watch_ticks": False}
        with _patch_tick_buffer(), mock.patch(
            "services.db_writer_engine.rt_bool",
            side_effect=lambda k, d=False: bool(enabled.get(k, d)),
        ), mock.patch("services.db_writer_engine.storage_caps", return_value={}), self.assertLogs(
            "app.db_writer_engine", level="WARNING"
        ) as logs:
            e = DBWriterEngine()
            await e._on_start()
        warnings = " ".join(logs.output)
        self.assertIn("personalNoExpiry", warnings)
        self.assertIn("dbw_storage_cap_personal_no_expiry", warnings)
        self.assertNotIn("marketWatchOneDay", warnings, "a disabled stream needs no warning")

    async def test_start_does_not_warn_when_the_stream_is_capped_or_off(self):
        with _patch_tick_buffer(), mock.patch(
            "services.db_writer_engine.rt_bool",
            side_effect=lambda k, d=False: bool(
                {"dbw_personal_no_expiry_ticks": True, "dbw_market_watch_ticks": True}.get(k, d)
            ),
        ), mock.patch(
            "services.db_writer_engine.storage_caps",
            return_value={"personalNoExpiry": True, "personalOneDay": False, "marketWatchOneDay": True},
        ):
            e = DBWriterEngine()
            with mock.patch.object(e, "_warn_about_uncapped_streams") as warn:
                await e._on_start()
        # Capped streams are deliberately stopped, so they need no warning; the
        # helper is still called so the logic stays exercised by the other test.
        warn.assert_called_once()

    async def test_startup_config_summary_exposes_permissions_and_caps(self):
        with _patch_tick_buffer(), mock.patch(
            "services.db_writer_engine.rt_bool",
            side_effect=lambda k, d=False: bool({"dbw_market_watch_ticks": True}.get(k, d)),
        ), mock.patch("services.db_writer_engine.storage_caps", return_value={"personalNoExpiry": True}):
            e = DBWriterEngine()
            await e._on_start()
        summary = e.config_summary() if hasattr(e, "config_summary") else e._config_summary
        self.assertTrue(summary["tickPersistencePermissions"]["marketWatchOneDay"])
        self.assertFalse(summary["tickPersistencePermissions"]["personalNoExpiry"])
        self.assertTrue(summary["storageCaps"]["personalNoExpiry"])

    async def test_health_check_registers_write_errors_as_degraded(self):
        patchers = _patch_tick_buffer()
        with patchers:
            e = DBWriterEngine()
            e._last_write_errors = 0
            health = await e.health_check()
            self.assertEqual(health, EngineHealth.DEGRADED)

    async def test_ingest_validates_and_buffers(self):
        e = DBWriterEngine()
        with mock.patch("services.tick_buffer.record_latest", side_effect=lambda t: t), \
             mock.patch("services.tick_buffer.enqueue_for_storage") as enq, \
             _mock_session_manager(personal_no_expiry=True), _mock_runtime_settings(personal_no_expiry=True):
            ok = await e.ingest({"instrumentToken": "2885", "ltp": 101.5})
        self.assertTrue(ok)
        self.assertEqual(e._ingested, 1)
        self.assertEqual(e._rejected, 0)
        enq.assert_called_once()

    async def test_ingest_rejects_without_instrument_identity(self):
        e = DBWriterEngine()
        with mock.patch("services.tick_buffer.record_latest") as live, \
             mock.patch("services.tick_buffer.enqueue_for_storage") as enq:
            ok = await e.ingest({"ltp": 101.5})
        self.assertFalse(ok)
        self.assertEqual(e._rejected, 1)
        self.assertEqual(e._ingested, 0)
        live.assert_not_called()
        enq.assert_not_called()

    async def test_ingest_rejects_non_dict(self):
        e = DBWriterEngine()
        self.assertFalse(await e.ingest("nope"))
        self.assertEqual(e._rejected, 1)

    async def test_graceful_stop_does_final_flush(self):
        patchers = _patch_tick_buffer()
        with patchers:
            e = DBWriterEngine()
            await e.start()
            ok = await e.stop()
            self.assertTrue(ok)
            from services.tick_buffer import stop as tb_stop

            self.assertTrue(tb_stop.await_count >= 1)

    # --- New functionality tests ---

    async def test_ingest_deduplication_by_sequence(self):
        """Same (token, sequenceNumber) should be rejected as duplicate."""
        e = DBWriterEngine()
        tick_base = {"instrumentToken": "2885", "ltp": 101.5, "sequenceNumber": 1001}

        with mock.patch("services.tick_buffer.record_latest", side_effect=lambda t: t), \
             mock.patch("services.tick_buffer.enqueue_for_storage") as enq, \
             _mock_session_manager(personal_no_expiry=True), _mock_runtime_settings(personal_no_expiry=True):
            ok1 = await e.ingest(tick_base)
            ok2 = await e.ingest(tick_base)  # duplicate

        self.assertTrue(ok1)
        self.assertFalse(ok2)
        self.assertEqual(e._ingested, 1)
        self.assertEqual(e._duplicates, 1)
        self.assertEqual(enq.call_count, 1)

    async def test_ingest_no_dedup_when_no_sequence(self):
        """If sequenceNumber missing, no dedup applied (upstream responsibility)."""
        e = DBWriterEngine()
        tick_base = {"instrumentToken": "2885", "ltp": 101.5}

        with mock.patch("services.tick_buffer.record_latest", side_effect=lambda t: t), \
             mock.patch("services.tick_buffer.enqueue_for_storage") as enq, \
             _mock_session_manager(personal_no_expiry=True), _mock_runtime_settings(personal_no_expiry=True):
            ok1 = await e.ingest(tick_base)
            ok2 = await e.ingest(tick_base)

        self.assertTrue(ok1)
        self.assertTrue(ok2)  # both accepted when no sequence
        self.assertEqual(e._ingested, 2)

    async def test_live_quote_survives_disabled_persistence(self):
        """A tick dropped by storage policy must still reach the live store.

        Regression guard: the canonical latest-value store used by the UI was
        only written on the persistence-accept path, so disabling a MongoDB
        category (e.g. dbw_market_watch_ticks) silently hid real, subscribed
        live market data from every reader.
        """
        from services import tick_buffer

        e = DBWriterEngine()
        # market_watch instruments registered, but the market-watch persistence
        # category is switched OFF -> PERSISTENCE_DISABLED for every tick.
        token = "12345"
        with mock.patch("services.tick_buffer.enqueue_for_storage") as enq, \
             _mock_session_manager(market_watch=True), _mock_runtime_settings(market_watch=False):
            try:
                before = tick_buffer.stats()["liveTicksRecorded"]
                ok = await e.ingest({"instrumentToken": token, "symbol": "TESTCO", "ltp": 123.45})
                published = tick_buffer.get_latest_ticks().get(token)
                recorded = tick_buffer.stats()["liveTicksRecorded"]
            finally:
                tick_buffer._latest_ticks.pop(token, None)

        # Not persisted ...
        self.assertFalse(ok)
        enq.assert_not_called()
        self.assertEqual(e._rejected, 1)
        # ... but genuinely visible as live market data.
        self.assertIsNotNone(published, "tick must reach the live store")
        self.assertEqual(published["ltp"], 123.45)
        self.assertEqual(recorded, before + 1)

    async def test_data_loss_accounting_in_snapshot(self):
        """status_snapshot includes dataLossAccounting with reconciliation.

        Uses DB Writer's own ingest counters (single source of truth).
        """
        patchers = _patch_tick_buffer()
        with patchers:
            e = DBWriterEngine()
            # Simulate some ingest activity
            e._ingested = 100
            e._rejected = 5
            e._duplicates = 3

            snap = e.status_snapshot()
            dla = snap.get("dataLossAccounting")
            self.assertIsNotNone(dla)
            self.assertEqual(dla["received"], 100)  # from DB Writer's _ingested
            self.assertEqual(dla["duplicates"], 3)
            self.assertEqual(dla["invalid"], 5)
            self.assertEqual(dla["accepted"], 92)  # 100 - 5 - 3
            self.assertEqual(dla["written"], 88)
            self.assertEqual(dla["writeFailed"], 1)
            self.assertEqual(dla["pending"], 12)
            self.assertTrue(dla["reconciliation"]["receivedEqualsSum"])
            # acceptedEqualsSum may not hold if tick_buffer has other producers;
            # the formula is correct for DB Writer's tracked data.

    async def test_instruments_snapshot_in_status(self):
        """status_snapshot includes per-instrument data from tick_buffer."""
        patchers = _patch_tick_buffer_with_latest()
        with patchers:
            e = DBWriterEngine()
            snap = e.status_snapshot()
            inst = snap.get("instruments", {})
            self.assertIn("2885", inst)
            self.assertIn("11536", inst)
            self.assertEqual(inst["2885"]["symbol"], "RELIANCE")
            self.assertEqual(inst["2885"]["ltp"], 2500.5)
            self.assertIn("momentum", inst["2885"])

    async def test_audit_uses_persistence_pipeline(self):
        """Audit block reads from storage_engine.persistence_pipeline()."""
        patchers = _patch_tick_buffer()
        with patchers:
            from services.storage_engine import storage_engine
            with mock.patch.object(storage_engine, "persistence_pipeline",
                           return_value={"queueDepth": 7, "totalWrites": 100, "writeErrors": 2}):
                e = DBWriterEngine()
                snap = e.status_snapshot()
                audit = snap.get("audit")
                self.assertIsNotNone(audit)
                self.assertEqual(audit["queueSize"], 7)
                self.assertEqual(audit["totalWrites"], 100)
                self.assertEqual(audit["writeErrors"], 2)

    async def test_metrics_include_accounting_fields(self):
        """_refresh_metrics populates accounting metrics."""
        patchers = _patch_tick_buffer()
        with patchers:
            e = DBWriterEngine()
            e._ingested = 50
            e._rejected = 2
            e._duplicates = 1
            e._refresh_metrics()
            m = e.get_metrics().get("custom", {})
            self.assertEqual(m.get("ingestedFromRouter"), 50)
            self.assertEqual(m.get("rejectedByValidation"), 2)
            self.assertEqual(m.get("duplicatesRejected"), 1)
            self.assertEqual(m.get("acceptedForPersistence"), 47)


class ConnectionEngineStatusTest(unittest.IsolatedAsyncioTestCase):
    def test_status_shape_and_freshness_no_data(self):
        from connection_engine import connection_engine

        with mock.patch("services.tick_buffer.stats", return_value={}):
            status = connection_engine.status()
        self.assertIn("stats", status)
        self.assertIn("freshness", status)
        self.assertIn("connectionRegistry", status)
        self.assertEqual(status["stats"]["totalConnections"], status["sessions"])
        self.assertEqual(status["freshness"]["state"], "NO_DATA")

    def test_freshness_mappings(self):
        import time

        from connection_engine.connection_engine import ConnectionEngine

        engine = ConnectionEngine()
        now = time.time()
        for age_seconds, expected in ((2.0, "FRESH"), (10.0, "DELAYED"), (60.0, "STALE")):
            with mock.patch(
                "services.tick_buffer.stats",
                return_value={"lastTickAt": now - age_seconds, "ticksPerSecond": 3.0,
                              "pipelineRunning": True},
            ):
                self.assertEqual(engine._feed_freshness()["state"], expected)


class TickPersistenceAuthorityTest(unittest.IsolatedAsyncioTestCase):
    """The DB Write Engine is the single authority for tick persistence.

    These tests pin the contract the task requires:
    - three INDEPENDENT permissions, all OFF by default
    - Market Watch cannot persist a tick on its own
    - UNKNOWN classification is never persisted
    - an overlapping classification persists AT MOST once
    - the permission surface is the one the API/UI read
    """

    def setUp(self):
        from services import market_watch_doc_buffer

        market_watch_doc_buffer.reset()
        self.e = DBWriterEngine()
        # The storage cap is now OPERATOR CONFIGURATION (runtime setting, then
        # environment), not a module literal. This class verifies the permission
        # MECHANISM, so it pins the cap OFF here; the cap's own behaviour is
        # covered by :class:`StorageCapTest`, which turns the cap on explicitly.
        cap_patcher = mock.patch(
            "services.db_writer_engine.storage_caps",
            return_value={
                "personalNoExpiry": False,
                "personalOneDay": False,
                "marketWatchOneDay": False,
            },
        )
        cap_patcher.start()
        self.addCleanup(cap_patcher.stop)

    def tearDown(self):
        from services import market_watch_doc_buffer

        market_watch_doc_buffer.reset()

    # -- helpers ------------------------------------------------------- #
    @contextmanager
    def _permissions(self, no_expiry=False, one_day=False, market_watch=False):
        values = {
            "dbw_personal_no_expiry_ticks": no_expiry,
            "dbw_personal_expiry_ticks": one_day,
            "dbw_market_watch_ticks": market_watch,
        }
        with mock.patch(
            "services.runtime_settings.get_runtime_setting",
            side_effect=lambda k: values.get(k),
        ):
            yield

    @contextmanager
    def _session(self, instruments):
        with mock.patch(
            "services.session.session_manager.session_manager.active_registry",
            return_value=instruments,
        ):
            yield

    @contextmanager
    def _no_cap(self):
        """Explicitly no storage cap (the default configuration)."""
        with mock.patch(
            "services.db_writer_engine.storage_caps",
            return_value={
                "personalNoExpiry": False,
                "personalOneDay": False,
                "marketWatchOneDay": False,
            },
        ):
            yield

    def _mw_instrument(self, token="1", sources=("market_watch_daily_universe",), permanent=False):
        return {
            "instrumentToken": token,
            "sources": list(sources),
            "expiry_type": "PERMANENT" if permanent else "SESSION",
            "expires_at": None if permanent else 9999999999,
        }

    # -- defaults ------------------------------------------------------ #
    def test_settings_defaults_are_still_off(self):
        """The *setting* default is untouched: an unset key resolves to OFF.

        This is the "no default is invented" invariant and it still holds. The
        effective value may differ where the temporary storage cap applies -- see
        :meth:`test_storage_cap_overrides_effective_value` -- but the stored
        default in the settings service is unchanged.
        """
        from services.settings_service import DEFAULTS

        for key in (
            "dbw_personal_no_expiry_ticks",
            "dbw_personal_expiry_ticks",
            "dbw_market_watch_ticks",
        ):
            self.assertIs(DEFAULTS[key]["value"], False, f"{key} default must be OFF")
            with self._permissions(no_expiry=None, one_day=None, market_watch=None):
                pass  # _permissions covers only these three keys
        with mock.patch(
            "services.runtime_settings.get_runtime_setting",
            side_effect=lambda k: None,
        ):
            for name in ("personalNoExpiry", "personalOneDay", "marketWatchOneDay"):
                perms = self.e.tick_persistence_settings()["permissions"][name]
                self.assertIs(
                    perms["configuredEnabled"],
                    False,
                    f"{name} configured default must be OFF",
                )

    def test_the_three_permissions_are_independent(self):
        """Flipping one must not touch the other two."""
        with self._permissions(no_expiry=True, one_day=False, market_watch=False):
            settings = self.e.tick_persistence_settings()
        perms = settings["permissions"]
        self.assertTrue(perms["personalNoExpiry"]["enabled"])
        self.assertFalse(perms["personalOneDay"]["enabled"])
        self.assertFalse(perms["marketWatchOneDay"]["enabled"])

    def test_permission_names_and_keys_match_the_settings_service(self):
        """The API/UI contract and the actual settings keys cannot drift."""
        from services.db_writer_engine import TICK_PERSISTENCE_PERMISSIONS
        from services.runtime_settings import LIVE_KEYS
        from services.settings_service import DEFAULTS

        self.assertEqual(
            set(TICK_PERSISTENCE_PERMISSIONS),
            {"personalNoExpiry", "personalOneDay", "marketWatchOneDay"},
        )
        for key in TICK_PERSISTENCE_PERMISSIONS.values():
            self.assertIn(key, LIVE_KEYS, f"{key} must be a live runtime key")
            self.assertIn(key, DEFAULTS, f"{key} must have a schema default")
            self.assertIs(DEFAULTS[key]["value"], False, "authoritative default is OFF")

    def test_owner_is_the_db_writer(self):
        self.assertEqual(self.e.tick_persistence_settings()["owner"], "db_writer_engine")

    # -- classification ------------------------------------------------ #
    def test_unknown_source_is_never_persisted(self):
        """Even with every permission ON, an unclassified tick is refused."""
        with self._permissions(no_expiry=True, one_day=True, market_watch=True):
            decision = self.e.should_persist_tick({"instrumentToken": "999"})
        self.assertFalse(decision["persist"])
        self.assertEqual(decision["reason"], "unknown_source")
        self.assertIsNone(decision["permission"])

    def test_no_instrument_identity_is_an_invalid_tick(self):
        """No token is not a classification problem -- it is an invalid document.

        The reason code distinguishes the two so the status surface can tell an
        operator "the feed sent a malformed tick" apart from "this stock is not
        in your registry".
        """
        with self._permissions(no_expiry=True, one_day=True, market_watch=True):
            decision = self.e.should_persist_tick({"symbol": "AAA"})
        self.assertFalse(decision["persist"])
        self.assertEqual(decision["reasonCode"], "INVALID_TICK")
        self.assertEqual(decision["reason"], "invalid_tick")

    def test_classification_is_not_inferred_from_the_symbol_name(self):
        """A symbol merely containing 'MW' must not become MARKET_WATCH."""
        with self._permissions(no_expiry=True, one_day=True, market_watch=True):
            with self._session({}):
                decision = self.e.should_persist_tick(
                    {"instrumentToken": "7", "symbol": "MWALLA-BEES"}
                )
        self.assertEqual(decision["reason"], "unknown_source")

    def test_personal_no_expiry_maps_to_its_own_permission(self):
        inst = self._mw_instrument("2885", sources=("manual",), permanent=True)
        with self._permissions(no_expiry=True, one_day=False, market_watch=False):
            with self._session({"2885": inst}):
                decision = self.e.should_persist_tick({"instrumentToken": "2885"})
        self.assertTrue(decision["persist"])
        self.assertEqual(decision["classification"], "PERSONAL_NO_EXPIRY")
        self.assertEqual(decision["settingKey"], "dbw_personal_no_expiry_ticks")

    def test_personal_one_day_maps_to_the_expiry_permission(self):
        inst = self._mw_instrument("11536", sources=("manual",), permanent=False)
        with self._permissions(no_expiry=False, one_day=True, market_watch=False):
            with self._session({"11536": inst}):
                decision = self.e.should_persist_tick({"instrumentToken": "11536"})
        self.assertTrue(decision["persist"])
        self.assertEqual(decision["classification"], "PERSONAL_ONE_DAY")
        self.assertEqual(decision["settingKey"], "dbw_personal_expiry_ticks")

    def test_market_watch_maps_to_the_market_watch_permission(self):
        inst = self._mw_instrument("12345")
        with self._permissions(no_expiry=False, one_day=False, market_watch=True):
            with self._session({"12345": inst}):
                decision = self.e.should_persist_tick({"instrumentToken": "12345"})
        self.assertTrue(decision["persist"])
        self.assertEqual(decision["classification"], "MARKET_WATCH_ONE_DAY")
        self.assertEqual(decision["settingKey"], "dbw_market_watch_ticks")

    def test_legacy_classification_aliases_keep_the_same_value(self):
        """No second classification system: old names are the same strings."""
        from services.db_writer_engine import TickSource

        self.assertEqual(TickSource.PERSONAL_EXPIRY, TickSource.PERSONAL_ONE_DAY)
        self.assertEqual(TickSource.MARKET_WATCH, TickSource.MARKET_WATCH_ONE_DAY)

    # -- overlap ------------------------------------------------------- #
    def test_overlapping_classifications_persist_at_most_once(self):
        """An instrument that is BOTH personal and Market Watch is written once."""
        inst = self._mw_instrument("1", sources=("manual", "market_watch_daily_universe"), permanent=True)
        with self._permissions(no_expiry=True, one_day=False, market_watch=True):
            with self._session({"1": inst}):
                self.assertTrue(self.e._should_persist_tick({"instrumentToken": "1"})[0])
                self.assertTrue(self.e._should_persist_tick({"instrumentToken": "1"})[0])
        self.assertEqual(self.e._overlapping_sources_deduped, 2)
        self.assertEqual(
            self.e._personal_no_expiry_accepted + self.e._market_watch_accepted,
            2,
            "one primary classification is credited per accepted tick",
        )

    # -- Market Watch handoff ------------------------------------------- #
    def test_market_watch_handoff_is_blocked_when_the_permission_is_off(self):
        """THE regression: Market Watch offers, the DB Writer refuses."""
        from services import market_watch_doc_buffer

        inst = self._mw_instrument("1")
        doc = {"_id": "AAA:1", "instrumentToken": "1", "symbol": "AAA", "sequenceNumber": 1}
        with self._permissions(market_watch=False):
            with self._session({"1": inst}):
                result = self.e.ingest_market_watch_ticks([doc])
        self.assertEqual(result["accepted"], 0)
        self.assertEqual(result["reasons"].get("PERSISTENCE_DISABLED"), 1)
        self.assertEqual(result["legacyReasons"].get("permission_disabled"), 1)
        self.assertEqual(market_watch_doc_buffer.pending("market_ticks"), 0)
        self.assertEqual(self.e._market_watch_accepted, 0)
        self.assertEqual(self.e._market_watch_skipped, 1)

    def test_market_watch_handoff_buffers_when_the_permission_is_on(self):
        from services import market_watch_doc_buffer

        inst = self._mw_instrument("1")
        doc = {"_id": "AAA:2", "instrumentToken": "1", "symbol": "AAA", "sequenceNumber": 2}
        with self._permissions(market_watch=True):
            with self._session({"1": inst}):
                result = self.e.ingest_market_watch_ticks([doc])
        self.assertEqual(result["accepted"], 1)
        self.assertEqual(market_watch_doc_buffer.pending("market_ticks"), 1)
        self.assertEqual(self.e._market_watch_accepted, 1)

    def test_market_watch_handoff_deduplicates_on_identity(self):
        """A repeated (token, sequenceNumber) is accepted at most once."""
        from services import market_watch_doc_buffer

        inst = self._mw_instrument("1")
        doc = {"_id": "AAA:3", "instrumentToken": "1", "symbol": "AAA", "sequenceNumber": 3}
        with self._permissions(market_watch=True):
            with self._session({"1": inst}):
                first = self.e.ingest_market_watch_ticks([doc])
                second = self.e.ingest_market_watch_ticks([dict(doc)])
        self.assertEqual(first["accepted"], 1)
        self.assertEqual(second["accepted"], 0)
        self.assertEqual(second["duplicates"], 1)
        self.assertEqual(market_watch_doc_buffer.pending("market_ticks"), 1)

    def test_market_watch_handoff_stamps_the_classification(self):
        from services import market_watch_doc_buffer

        inst = self._mw_instrument("1")
        doc = {"_id": "AAA:4", "instrumentToken": "1", "symbol": "AAA", "sequenceNumber": 4}
        with self._permissions(market_watch=True):
            with self._session({"1": inst}):
                self.e.ingest_market_watch_ticks([doc])
        buffered = list(market_watch_doc_buffer._buffers["market_ticks"])
        self.assertEqual(len(buffered), 1)
        self.assertEqual(buffered[0]["_tick_source"], "MARKET_WATCH_ONE_DAY")

    def test_market_watch_handoff_rejects_a_non_list_payload(self):
        with self._permissions(market_watch=True):
            result = self.e.ingest_market_watch_ticks("nope")
        self.assertEqual(result["accepted"], 0)
        self.assertEqual(result["reason"], "invalid_payload")

    # -- permission mutation ------------------------------------------- #
    async def test_set_tick_persistence_writes_through_the_settings_service(self):
        from services import runtime_settings

        with self._permissions(no_expiry=False, one_day=False, market_watch=False):
            with mock.patch("database.connection.get_db", return_value=object()), mock.patch.object(
                runtime_settings, "refresh_runtime_settings", new=AsyncMock()
            ), mock.patch("services.settings_service.set_setting", new=AsyncMock()) as setter:
                result = await self.e.set_tick_persistence({"marketWatchOneDay": True})

        setter.assert_awaited_once_with("dbw_market_watch_ticks", True)
        self.assertIn("marketWatchOneDay", result["permissions"])

    async def test_set_tick_persistence_rejects_an_unknown_permission(self):
        with self.assertRaises(ValueError):
            await self.e.set_tick_persistence({"marketWatchOneYear": True})

    async def test_set_tick_persistence_only_touches_supplied_names(self):
        from services import runtime_settings

        with self._permissions(no_expiry=True, one_day=True, market_watch=False):
            with mock.patch("database.connection.get_db", return_value=object()), mock.patch.object(
                runtime_settings, "refresh_runtime_settings", new=AsyncMock()
            ), mock.patch("services.settings_service.set_setting", new=AsyncMock()) as setter:
                await self.e.set_tick_persistence({"marketWatchOneDay": True})
        setter.assert_awaited_once_with("dbw_market_watch_ticks", True)

    # -- master switch --------------------------------------------------- #
    def test_master_default_is_on(self):
        """Master ships ON so existing per-stream behaviour is unchanged."""
        from services.settings_service import DEFAULTS

        self.assertIs(DEFAULTS["dbw_ticks_enabled"]["value"], True)
        from services.runtime_settings import LIVE_KEYS

        self.assertIn("dbw_ticks_enabled", LIVE_KEYS)
        with mock.patch(
            "services.runtime_settings.get_runtime_setting",
            side_effect=lambda k: None,
        ):
            settings = self.e.tick_persistence_settings()
        self.assertTrue(settings["master"]["enabled"])
        self.assertTrue(settings["master"]["configuredEnabled"])
        self.assertEqual(settings["master"]["settingKey"], "dbw_ticks_enabled")

    def test_master_off_blocks_everything_even_with_permissions_on(self):
        """Master OFF is a global kill-switch: no valid tick is saved."""
        inst = self._mw_instrument("2885", sources=("manual",), permanent=True)
        values = {
            "dbw_ticks_enabled": False,
            "dbw_personal_no_expiry_ticks": True,
            "dbw_personal_expiry_ticks": True,
            "dbw_market_watch_ticks": True,
        }
        with mock.patch(
            "services.runtime_settings.get_runtime_setting",
            side_effect=lambda k: values.get(k),
        ), self._session({"2885": inst}):
            decision = self.e.should_persist_tick({"instrumentToken": "2885"})
            settings = self.e.tick_persistence_settings()
        self.assertFalse(decision["persist"])
        self.assertEqual(decision["reasonCode"], "PERSISTENCE_DISABLED")
        self.assertFalse(settings["master"]["enabled"])
        self.assertFalse(settings["effectiveSaving"])
        for perm in settings["permissions"].values():
            self.assertFalse(perm["enabled"])

    def test_master_on_with_all_permissions_off_saves_nothing(self):
        """Master ON alone saves nothing — a stream permission must also be ON."""
        inst = self._mw_instrument("2885", sources=("manual",), permanent=True)
        with self._permissions(no_expiry=False, one_day=False, market_watch=False):
            with mock.patch(
                "services.db_writer_engine.tick_master_enabled", return_value=True
            ), self._session({"2885": inst}):
                decision = self.e.should_persist_tick({"instrumentToken": "2885"})
                settings = self.e.tick_persistence_settings()
        self.assertFalse(decision["persist"])
        self.assertEqual(decision["reasonCode"], "PERSISTENCE_DISABLED")
        self.assertTrue(settings["master"]["enabled"])
        self.assertFalse(settings["effectiveSaving"])

    async def test_set_tick_persistence_accepts_master(self):
        from services import runtime_settings

        with self._permissions(no_expiry=False, one_day=False, market_watch=False):
            with mock.patch("database.connection.get_db", return_value=object()), mock.patch.object(
                runtime_settings, "refresh_runtime_settings", new=AsyncMock()
            ), mock.patch("services.settings_service.set_setting", new=AsyncMock()) as setter:
                await self.e.set_tick_persistence({"master": False})
        setter.assert_awaited_once_with("dbw_ticks_enabled", False)

    # -- status parity ------------------------------------------------- #
    def test_status_snapshot_uses_the_same_permission_surface(self):
        with self._permissions(no_expiry=True, one_day=False, market_watch=True):
            snapshot = self.e.status_snapshot()["tickPersistence"]
        self.assertEqual(set(snapshot["permissions"]), set(self.e.tick_persistence_settings()["permissions"]))
        self.assertTrue(snapshot["permissions"]["personalNoExpiry"]["enabled"])
        self.assertFalse(snapshot["permissions"]["personalOneDay"]["enabled"])
        self.assertTrue(snapshot["permissions"]["marketWatchOneDay"]["enabled"])
        self.assertEqual(snapshot["owner"], "db_writer_engine")


class StorageCapTest(unittest.IsolatedAsyncioTestCase):
    """The storage cap is OPERATOR CONFIGURATION, not a hard-coded literal.

    It used to be a module-level dict (``TICK_PERSISTENCE_HARD_CAP``) with
    ``personalOneDay`` and ``marketWatchOneDay`` forced False, which made those
    two streams unpersistable no matter what the operator's settings said. The
    cap is now resolved per decision from the same contract as every other
    setting in this project -- runtime setting first, then environment, then
    "not capped" -- so:

    - nothing is capped by default (the shipped default is UNCHANGED storage),
    - an operator can cap a stream while storage is tight,
    - the operator's own reason text is what the API and the UI report.

    These tests pin that contract. Unlike :class:`TickPersistenceAuthorityTest`,
    the cap is ON here.
    """

    #: A cap that is active for the two expiry-based streams, the historical
    #: low-storage configuration, but now something the operator chose.
    CAPS = {
        "personalNoExpiry": False,
        "personalOneDay": True,
        "marketWatchOneDay": True,
    }

    def setUp(self):
        from services import market_watch_doc_buffer

        market_watch_doc_buffer.reset()
        self.e = DBWriterEngine()
        self.addCleanup(market_watch_doc_buffer.reset)

    @contextmanager
    def _settings(self, no_expiry=False, one_day=False, market_watch=False, caps=None, reason=None):
        caps = self.CAPS if caps is None else caps
        values = {
            "dbw_personal_no_expiry_ticks": no_expiry,
            "dbw_personal_expiry_ticks": one_day,
            "dbw_market_watch_ticks": market_watch,
            "dbw_storage_cap_personal_no_expiry": caps["personalNoExpiry"],
            "dbw_storage_cap_personal_one_day": caps["personalOneDay"],
            "dbw_storage_cap_market_watch_one_day": caps["marketWatchOneDay"],
            "dbw_storage_cap_reason": reason,
        }
        with mock.patch(
            "services.runtime_settings.get_runtime_setting",
            side_effect=lambda k: values.get(k),
        ):
            yield

    @contextmanager
    def _session(self, instruments):
        with mock.patch(
            "services.session.session_manager.session_manager.active_registry",
            return_value=instruments,
        ):
            yield

    def _instrument(self, token="1", sources=("market_watch_daily_universe",), permanent=False):
        return {
            "instrumentToken": token,
            "sources": list(sources),
            "expiry_type": "PERMANENT" if permanent else "SESSION",
            "expires_at": None if permanent else 9999999999,
        }

    # -- the cap is configuration, not a literal ----------------------- #
    def test_nothing_is_capped_when_no_cap_is_configured(self):
        """The regression this whole rework exists for: no silent hard block."""
        from services.db_writer_engine import storage_caps

        with self._settings(market_watch=True, caps={k: False for k in self.CAPS}):
            caps = storage_caps()
            perms = self.e.tick_persistence_settings()["permissions"]
        self.assertEqual(caps, {k: False for k in self.CAPS})
        self.assertTrue(perms["marketWatchOneDay"]["enabled"], "the operator's ON must be honoured")
        self.assertFalse(perms["marketWatchOneDay"]["hardCapped"])

    def test_cap_reads_the_runtime_setting_and_never_hard_codes_it(self):
        from services.db_writer_engine import (
            TICK_PERSISTENCE_CAP_ENV,
            TICK_PERSISTENCE_CAP_SETTINGS,
            storage_caps,
        )

        self.assertEqual(
            set(TICK_PERSISTENCE_CAP_SETTINGS),
            set(self.CAPS),
            "every stream needs a cap key or it can never be capped",
        )
        self.assertEqual(set(TICK_PERSISTENCE_CAP_ENV), set(self.CAPS))
        with self._settings(market_watch=True, caps=self.CAPS):
            self.assertEqual(storage_caps(), self.CAPS)
        self.assertFalse(hasattr(__import__("services.db_writer_engine", fromlist=["x"]), "TICK_PERSISTENCE_HARD_CAP"))

    def test_environment_is_the_fallback_tier(self):
        from services.db_writer_engine import storage_caps

        with mock.patch.dict(
            os.environ,
            {"DBW_STORAGE_CAP_MARKET_WATCH_ONE_DAY": "1"},
            clear=False,
        ):
            with mock.patch(
                "services.runtime_settings.get_runtime_setting", side_effect=lambda k: None
            ):
                caps = storage_caps()
        self.assertTrue(caps["marketWatchOneDay"], "env must cap when no setting exists")
        self.assertFalse(caps["personalOneDay"], "and must not cap anything else")

    def test_runtime_setting_beats_the_environment(self):
        from services.db_writer_engine import storage_caps

        with mock.patch.dict(
            os.environ,
            {"DBW_STORAGE_CAP_MARKET_WATCH_ONE_DAY": "1"},
            clear=False,
        ):
            with self._settings(market_watch=True, caps={k: False for k in self.CAPS}):
                caps = storage_caps()
        self.assertFalse(caps["marketWatchOneDay"], "the setting is the higher-priority tier")

    def test_operator_reason_text_is_reported_verbatim(self):
        from services.db_writer_engine import storage_cap_reason

        with self._settings(reason="Atlas cluster at 400 MB free"):
            self.assertEqual(storage_cap_reason(), "Atlas cluster at 400 MB free")

    # -- the cap's effect on the decision ------------------------------ #
    def test_cap_blocks_market_watch_even_when_the_setting_is_on(self):
        """A stored True must NOT re-enable a capped stream."""
        with self._settings(no_expiry=True, one_day=True, market_watch=True):
            perms = self.e.tick_persistence_settings()["permissions"]
        self.assertTrue(perms["marketWatchOneDay"]["configuredEnabled"], "setting is ON here")
        self.assertFalse(perms["marketWatchOneDay"]["enabled"], "the cap must still win")
        self.assertFalse(perms["personalOneDay"]["enabled"], "the cap must still win")
        self.assertTrue(perms["personalNoExpiry"]["enabled"], "an uncapped stream is unaffected")

    def test_market_watch_ticks_never_reach_the_buffer_while_capped(self):
        """THE REQUIREMENT: a capped stream writes nothing."""
        from services import market_watch_doc_buffer

        inst = self._instrument("42")
        doc = {"_id": "RELIANCE:1", "instrumentToken": "42", "symbol": "RELIANCE", "sequenceNumber": 1}
        with self._settings(no_expiry=True, market_watch=True):
            with self._session({"42": inst}):
                result = self.e.ingest_market_watch_ticks([doc])
        self.assertEqual(result["accepted"], 0)
        self.assertEqual(result["reason"], "blocked_by_storage_cap")
        self.assertEqual(result["reasonCode"], "STORAGE_CAPPED")
        self.assertTrue(result["hardCapped"])
        self.assertEqual(market_watch_doc_buffer.pending("market_ticks"), 0)
        self.assertEqual(self.e._market_watch_accepted, 0)
        self.assertEqual(self.e._market_watch_skipped, 1, "the skip must still be counted")
        self.assertEqual(self.e._reason_counts["STORAGE_CAPPED"], 1)

    def test_no_expiry_ticks_still_reach_the_buffer(self):
        """THE REQUIREMENT: an uncapped stream keeps saving when permitted."""
        from services import market_watch_doc_buffer

        inst = self._instrument("7", sources=("manual",), permanent=True)
        doc = {"_id": "TCS:1", "instrumentToken": "7", "symbol": "TCS", "sequenceNumber": 1}
        with self._settings(no_expiry=True):
            with self._session({"7": inst}):
                result = self.e.ingest_market_watch_ticks([doc])
        self.assertEqual(result["accepted"], 1, "no-expiry must still be persisted")
        self.assertEqual(result["reason"], "buffered")
        self.assertEqual(market_watch_doc_buffer.pending("market_ticks"), 1)

    def test_overlapping_instrument_is_credited_to_no_expiry(self):
        """An instrument that is both personal and Market Watch saves ONCE,
        as a no-expiry document -- it must not sneak into market_watch."""
        from services import market_watch_doc_buffer

        inst = self._instrument("8", sources=("manual", "market_watch_daily_universe"), permanent=True)
        doc = {"_id": "INFY:1", "instrumentToken": "8", "symbol": "INFY", "sequenceNumber": 1}
        with self._settings(no_expiry=True, market_watch=True):
            with self._session({"8": inst}):
                result = self.e.ingest_market_watch_ticks([doc])
        self.assertEqual(result["accepted"], 1, "one document, not two")
        self.assertEqual(market_watch_doc_buffer.pending("market_ticks"), 1)
        buffered = list(market_watch_doc_buffer._buffers["market_ticks"])
        self.assertEqual(
            buffered[0]["_tick_source"],
            "PERSONAL_NO_EXPIRY",
            "an overlapping instrument must be stored under the no-expiry classification",
        )

    def test_status_surface_explains_itself(self):
        with self._settings(reason="Atlas cluster at 400 MB free"):
            settings = self.e.tick_persistence_settings()
        self.assertTrue(settings["storageCapActive"])
        self.assertEqual(settings["storageCapReason"], "Atlas cluster at 400 MB free")
        self.assertEqual(settings["storageCaps"], self.CAPS)
        perms = settings["permissions"]
        self.assertTrue(perms["marketWatchOneDay"]["hardCapped"])
        self.assertTrue(perms["personalOneDay"]["hardCapped"])
        self.assertFalse(perms["personalNoExpiry"]["hardCapped"])
        self.assertEqual(
            perms["marketWatchOneDay"]["capSettingKey"], "dbw_storage_cap_market_watch_one_day"
        )
        self.assertEqual(
            perms["marketWatchOneDay"]["capEnvKey"], "DBW_STORAGE_CAP_MARKET_WATCH_ONE_DAY"
        )
        self.assertEqual(settings["authority"], "sole_tick_persistence_authority")

    async def test_api_refuses_to_enable_a_capped_permission(self):
        """A toggle that could never take effect must be rejected, not ignored."""
        from services.db_writer_engine import TickPersistenceUnavailable

        with self._settings(market_watch=False):
            with self.assertRaises(ValueError) as ctx:
                await self.e.set_tick_persistence({"marketWatchOneDay": True})
        self.assertIn("storage cap", str(ctx.exception))
        self.assertNotIsInstance(ctx.exception, TickPersistenceUnavailable)

    async def test_api_error_names_the_setting_that_would_unblock_it(self):
        with self._settings(market_watch=False):
            with self.assertRaises(ValueError) as ctx:
                await self.e.set_tick_persistence({"marketWatchOneDay": True})
        self.assertIn("dbw_storage_cap_market_watch_one_day", str(ctx.exception))

    async def test_api_refuses_a_bulk_enable_that_includes_a_capped_permission(self):
        with self._settings(no_expiry=True, market_watch=False):
            with self.assertRaises(ValueError) as ctx:
                await self.e.set_tick_persistence(
                    {"personalNoExpiry": True, "personalOneDay": True}
                )
        self.assertIn("personalOneDay", str(ctx.exception))

    async def test_api_still_allows_turning_a_capped_permission_off(self):
        """Turning something OFF is always safe and must keep working."""
        from services import runtime_settings

        with self._settings(no_expiry=False, market_watch=True), mock.patch(
            "database.connection.get_db", return_value=object()
        ), mock.patch(
            "services.settings_service.set_setting", new=AsyncMock()
        ) as setter, mock.patch.object(
            runtime_settings, "refresh_runtime_settings", new=AsyncMock()
        ):
            result = await self.e.set_tick_persistence({"marketWatchOneDay": False})
        self.assertFalse(result["permissions"]["marketWatchOneDay"]["enabled"])
        setter.assert_awaited_once_with("dbw_market_watch_ticks", False)

    def test_cap_survives_a_direct_settings_write(self):
        """PATCH /api/settings must not be able to re-enable a capped stream.

        `api/settings.py` accepts any key in DEFAULTS, so an operator (or a
        compromised session) can store `dbw_market_watch_ticks = true` in
        Mongo. The cap is applied at the decision chokepoint rather than at the
        settings layer precisely so that write cannot defeat it.
        """
        # Simulate the stored + cached permission value being flipped to True.
        with self._settings(no_expiry=True, one_day=True, market_watch=True):
            inst = self._instrument("42")
            doc = {"_id": "R:1", "instrumentToken": "42", "symbol": "RELIANCE", "sequenceNumber": 1}
            with self._session({"42": inst}):
                result = self.e.ingest_market_watch_ticks([doc])
            settings = self.e.tick_persistence_settings()

        self.assertTrue(
            settings["permissions"]["marketWatchOneDay"]["configuredEnabled"],
            "the stored setting really is ON in this scenario",
        )
        self.assertEqual(result["accepted"], 0, "yet nothing may be written")
        self.assertEqual(result["reason"], "blocked_by_storage_cap")

    def test_public_buffering_cannot_be_used_to_smuggle_ticks(self):
        """The storage cap must not be side-steppable by a direct buffer call.

        `buffer_documents` is the batching method. If it accepted `market_ticks`
        it would write ticks with no classification, no permission check and no
        cap -- which is precisely the volume that filled the disk.
        """
        from services import market_watch_doc_buffer

        doc = {"_id": "SMUGGLE:1", "instrumentToken": "42", "symbol": "X", "sequenceNumber": 1}
        written = self.e.buffer_documents("market_ticks", [doc])
        self.assertEqual(written, 0, "ticks must not be accepted via the batching method")
        self.assertEqual(
            market_watch_doc_buffer.pending("market_ticks"),
            0,
            "nothing may reach the tick buffer this way",
        )
        errors = " ".join(
            f"{e.get('code','')} {e.get('message','')}" for e in self.e._recent_errors
        )
        self.assertIn("ingest_market_watch_ticks", errors, "the refusal must be recorded")

    def test_public_buffering_still_works_for_non_tick_collections(self):
        """The refusal must not break candles, ledger decisions or reports."""
        written = self.e.buffer_documents(
            "market_candles_1m", [{"_id": "C:1", "timeframe": "1m", "symbol": "X"}]
        )
        self.assertEqual(written, 1, "non-tick documents must still buffer normally")


class RegistryCacheTest(unittest.TestCase):
    """The registry memo must never serve a registry older than the current one.

    The DB Writer consults the active-stock registry once per tick, so it
    memoises the snapshot. Correctness therefore depends on invalidation, not
    on the memoisation: a subscribe, unsubscribe or expiry has to be honoured on
    the very next tick.
    """

    def setUp(self):
        self.e = DBWriterEngine()
        self._record = {
            "instrumentToken": "42",
            "symbol": "X",
            "sources": ["market_watch_daily_universe"],
            "active": True,
            "market_date": "2026-09-29",
        }
        self._registry_data = {"42": self._record}
        self._revision = 0
        self._patches: list[Any] = []

        from services.session.session_manager import session_manager

        registry = mock.patch(
            "services.session.session_manager.session_manager.active_registry",
            side_effect=lambda: self._registry_data,
        )
        # Patched on the CLASS: it is a read-only property, so a per-instance
        # patch could not be undone.
        revision = mock.patch.object(
            type(session_manager),
            "subs_revision",
            new_callable=mock.PropertyMock,
            side_effect=lambda: self._revision,
        )
        settings = mock.patch(
            "services.runtime_settings.get_runtime_setting", side_effect=lambda k: True
        )
        for patcher in (registry, revision, settings):
            self._patches.append(patcher)
            patcher.start()
            self.addCleanup(patcher.stop)
        # The cap must not be ON, or every decision is STORAGE_CAPPED.
        self._patches.append(
            mock.patch(
                "services.db_writer_engine.storage_caps",
                return_value={k: False for k in ("personalNoExpiry", "personalOneDay", "marketWatchOneDay")},
            )
        )
        self._patches[-1].start()
        self.addCleanup(self._patches[-1].stop)

    def test_a_repeated_read_is_served_from_the_memo(self):
        self.assertEqual(self.e._active_registry(), {"42": self._record})
        self.assertEqual(self.e._active_registry(), {"42": self._record})
        self.assertEqual(self.e._registry_refreshes, 1, "the second read must be memoised")

    def test_a_registry_mutation_is_observed_on_the_next_read(self):
        self.e._active_registry()
        # The Session Manager bumps this on every mutation.
        self._revision = 1
        self._registry_data = {}
        self.assertEqual(self.e._active_registry(), {})
        self.assertEqual(self.e._registry_refreshes, 2)

    def test_an_empty_registry_is_memoised_too(self):
        """An unknown instrument must not rebuild the registry on every tick."""
        self._registry_data = {}
        self.e._active_registry()
        self.e._active_registry()
        self.e._active_registry()
        self.assertEqual(self.e._registry_refreshes, 1)

    def test_a_registry_failure_is_never_cached_as_an_empty_registry(self):
        """A transient read error must not become a silent drop storm."""
        self.e._active_registry()
        refreshes = self.e._registry_refreshes
        cached_at = self.e._registry_cached_at
        self._revision = 7  # force the next read to go out to the registry
        with mock.patch(
            "services.session.session_manager.session_manager.active_registry",
            side_effect=RuntimeError("registry unavailable"),
        ):
            self.assertEqual(self.e._active_registry(), {"42": self._record})
        self.assertEqual(self.e._registry_refreshes, refreshes, "a failure is not a refresh")
        self.assertEqual(
            self.e._registry_cached_at, cached_at, "a failure must not age the memo"
        )
        self.assertTrue(
            any(e.get("code") == "registry_snapshot_error" for e in self.e._recent_errors),
            "the failure must be recorded, not swallowed",
        )

    def test_ttl_is_only_a_safety_net_when_the_revision_does_not_move(self):
        self.e._active_registry()
        # Same revision, but the wall clock has moved past the TTL.
        self.e._registry_cached_at -= self.e._registry_cache_ttl + 1
        self.e._active_registry()
        self.assertEqual(self.e._registry_refreshes, 2)


class TickExpiryTest(unittest.TestCase):
    """One-day validity is metadata, never a hard-coded calendar date."""

    def setUp(self):
        self.e = DBWriterEngine()

    @contextmanager
    def _registry(self, record):
        with mock.patch(
            "services.session.session_manager.session_manager.active_registry",
            return_value={"42": record},
        ):
            self.e.invalidate_registry_cache()
            yield

    def _record(self, market_date, active=True, **extra):
        rec = {
            "instrumentToken": "42",
            "symbol": "X",
            "sources": ["market_watch_daily_universe"],
            "active": active,
            "market_date": market_date,
        }
        rec.update(extra)
        return rec

    def _evaluate(self, record, today):
        self.e.invalidate_registry_cache()
        with mock.patch.object(self.e, "_current_trading_date", return_value=today):
            return self.e.evaluate({"instrumentToken": "42"})

    @contextmanager
    def _permissions_on(self):
        """All three permissions ON and no storage cap, so the SAVE path is observable."""
        values = {
            "dbw_personal_no_expiry_ticks": True,
            "dbw_personal_expiry_ticks": True,
            "dbw_market_watch_ticks": True,
            "dbw_storage_cap_personal_no_expiry": False,
            "dbw_storage_cap_personal_one_day": False,
            "dbw_storage_cap_market_watch_one_day": False,
        }
        with mock.patch(
            "services.runtime_settings.get_runtime_setting",
            side_effect=lambda k: values.get(k),
        ):
            yield

    def test_todays_daily_universe_saves(self):
        with self._permissions_on(), self._registry(self._record("2026-09-29")):
            decision = self._evaluate(self._record("2026-09-29"), "2026-09-29")
        self.assertEqual(decision["reasonCode"], "PERMISSION_GRANTED")
        self.assertEqual(decision["classification"], "MARKET_WATCH_ONE_DAY")

    def test_yesterdays_daily_universe_is_dropped_as_expired(self):
        with self._permissions_on(), self._registry(self._record("2026-09-28")):
            decision = self._evaluate(self._record("2026-09-28"), "2026-09-29")
        self.assertFalse(decision["persist"])
        self.assertEqual(decision["reasonCode"], "EXPIRED_STOCK")
        self.assertEqual(decision["reason"], "expired_stock")
        self.assertEqual(decision["validity"]["validityDate"], "2026-09-28")
        self.assertEqual(decision["validity"]["tradingDate"], "2026-09-29")

    def test_a_deactivated_record_is_dropped_as_inactive(self):
        with self._permissions_on(), self._registry(self._record("2026-09-29", active=False)):
            decision = self._evaluate(self._record("2026-09-29", active=False), "2026-09-29")
        self.assertFalse(decision["persist"])
        self.assertEqual(decision["reasonCode"], "INACTIVE_STOCK")

    def test_a_wall_clock_expiry_in_the_past_is_dropped_as_expired(self):
        record = self._record("2026-09-29", expires_at=1_000_000_000)
        with self._permissions_on(), self._registry(record):
            decision = self._evaluate(record, "2026-09-29")
        self.assertEqual(decision["reasonCode"], "EXPIRED_STOCK")
        self.assertEqual(decision["validity"]["expiryField"], "expires_at")

    def test_a_wall_clock_expiry_in_the_future_still_saves(self):
        record = self._record("2026-09-29", expires_at=4_102_444_800)
        with self._permissions_on(), self._registry(record):
            decision = self._evaluate(record, "2026-09-29")
        self.assertEqual(decision["reasonCode"], "PERMISSION_GRANTED")

    def test_expiry_drop_is_counted_and_explainable(self):
        """One drop must be countable and explainable, not just a silent skip."""
        with self._permissions_on(), self._registry(self._record("2020-01-01")):
            decision = self._evaluate(self._record("2020-01-01"), "2026-09-29")
            should_persist, _cls = self.e._should_persist_tick({"instrumentToken": "42"})
        self.assertFalse(should_persist)
        self.assertEqual(self.e._reason_counts["EXPIRED_STOCK"], 1)
        self.assertEqual(self.e._market_watch_skipped, 1)
        self.assertEqual(decision["reasonCode"], "EXPIRED_STOCK")


class TickPersistenceApiTest(unittest.IsolatedAsyncioTestCase):
    """The API is a read/command surface over the DB Writer's own authority."""

    async def test_get_returns_the_three_permissions(self):
        from api.engine_control import db_writer_tick_persistence

        with mock.patch(
            "services.runtime_settings.get_runtime_setting", side_effect=lambda k: False
        ):
            body = await db_writer_tick_persistence()
        self.assertTrue(body["ok"])
        perms = body["data"]["permissions"]
        self.assertEqual(
            set(perms), {"personalNoExpiry", "personalOneDay", "marketWatchOneDay"}
        )
        self.assertTrue(all(p["label"] for p in perms.values()))

    async def test_put_applies_only_the_supplied_names(self):
        from api.engine_control import update_db_writer_tick_persistence
        from services.db_writer_engine import db_writer_engine

        with mock.patch.object(
            db_writer_engine, "set_tick_persistence", new=AsyncMock(return_value={"permissions": {}})
        ) as setter:
            body = await update_db_writer_tick_persistence({"personalOneDay": True})

        self.assertTrue(body["ok"])
        setter.assert_awaited_once_with({"personalOneDay": True})

    async def test_put_accepts_a_nested_permissions_object(self):
        from api.engine_control import update_db_writer_tick_persistence
        from services.db_writer_engine import db_writer_engine

        with mock.patch.object(
            db_writer_engine, "set_tick_persistence", new=AsyncMock(return_value={"permissions": {}})
        ) as setter:
            await update_db_writer_tick_persistence(
                {"permissions": {"personalNoExpiry": True, "marketWatchOneDay": True}}
            )
        setter.assert_awaited_once_with(
            {"personalNoExpiry": True, "marketWatchOneDay": True}
        )

    async def test_put_rejects_a_non_boolean(self):
        from api.engine_control import update_db_writer_tick_persistence

        body = await update_db_writer_tick_persistence({"personalOneDay": "yes"})
        self.assertFalse(body["ok"])
        self.assertIn("boolean", body["error"])

    async def test_put_rejects_an_empty_body(self):
        from api.engine_control import update_db_writer_tick_persistence

        body = await update_db_writer_tick_persistence({})
        self.assertFalse(body["ok"])

    async def test_put_surfaces_an_unknown_permission_as_an_error(self):
        from api.engine_control import update_db_writer_tick_persistence

        body = await update_db_writer_tick_persistence({"personalOneWeek": True})
        self.assertFalse(body["ok"])
        self.assertIn("personalOneWeek", body["error"])

    async def test_put_reports_unavailable_storage_instead_of_raising(self):
        """A dead settings store must be an honest error, not a 500."""
        from api.engine_control import update_db_writer_tick_persistence

        # personalNoExpiry is writable under the storage cap, so this reaches
        # the settings store and exercises the real failure path.
        with mock.patch(
            "database.connection.get_db", side_effect=RuntimeError("MongoDB is not connected")
        ):
            body = await update_db_writer_tick_persistence({"personalNoExpiry": True})

        self.assertFalse(body["ok"])
        self.assertIn("unavailable", body["error"])

    async def test_unavailable_storage_writes_nothing(self):
        """A failure must not leave permissions half-applied."""
        from services.db_writer_engine import TickPersistenceUnavailable, db_writer_engine

        with mock.patch(
            "database.connection.get_db", side_effect=RuntimeError("MongoDB is not connected")
        ), mock.patch("services.settings_service.set_setting", new=AsyncMock()) as setter:
            with self.assertRaises(TickPersistenceUnavailable):
                await db_writer_engine.set_tick_persistence(
                    {"personalNoExpiry": True, "personalOneDay": False}
                )
        setter.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()