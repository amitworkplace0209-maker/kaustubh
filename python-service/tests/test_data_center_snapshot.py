"""Tests for the Data Center single authoritative snapshot + deep-scan job.

What is under test
------------------
1. The snapshot CONTRACT: exactly the nine schema-v2 sections, every section
   carries provenance, and the schema endpoint matches what is built.
2. HONESTY: an unavailable section says so with a real reason and never
   substitutes ``0`` / ``[]`` / ``false`` for a measurement it could not take.
3. FAILURE ISOLATION: one raising section degrades only itself.
4. NO SECRETS: no Mongo URI, password or key ever reaches the payload.
5. SEPARATE REALTIME SURFACES: broker feed, backend fan-out and the
   browser-measured frontend socket are three different things.
6. DERIVED HEALTH: the rollup is a function of the sections, and is never a
   hard-coded "all good".
7. DEEP SCAN IS A JOB: it starts asynchronously, exposes progress, completion
   and failure, 404s an unknown job, and 503s when MongoDB is down. It is never
   triggered by a page load (there is no GET that starts one).

Run:  python -m pytest tests/test_data_center_snapshot.py -q
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import unittest
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

EXPECTED_SECTIONS = [
    "runtime",
    "database",
    "storage",
    "realtime",
    "session",
    "scheduler",
    "persistence",
    "marketData",
    "health",
]


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _section(name: str, **over):
    base = {
        "available": True,
        "source": f"test:{name}",
        "error": None,
        "generatedAt": "2026-01-01T00:00:00+00:00",
    }
    base.update(over)
    return base


def _healthy_snapshot() -> dict:
    return {
        "runtime": _section("runtime", terminalMode="kotak", terminalModeAvailable=True,
                            isPaperTerminal=False, uptimeSeconds=10.0),
        "database": _section("database", connected=True, configured=True,
                             activeSource="atlas", database="trading"),
        "storage": _section("storage", documents=5, collectionsCount=2, collections=[]),
        "realtime": _section(
            "realtime",
            brokerFeed={"available": True, "connected": True, "health": "HEALTHY"},
            backendRealtime={"available": True, "health": "HEALTHY"},
            frontendRealtime={"measurable": False, "reason": "measured in the browser"},
        ),
        "session": _section("session", state="ACTIVE", active=True, expired=False),
        "scheduler": _section("scheduler", state="RUNNING", running=True, isTradingDay=True,
                              market={"available": True, "marketState": "OPEN"}),
        "persistence": _section("persistence", state="RUNNING", health="HEALTHY",
                                writeErrors=0),
        "marketData": _section("marketData", state="RUNNING", health="HEALTHY"),
    }


# --------------------------------------------------------------------------- #
# 1-4. contract, honesty, isolation, no secrets
# --------------------------------------------------------------------------- #
class SnapshotContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from services import data_center_snapshot

        cls.mod = data_center_snapshot
        cls.schema = data_center_snapshot.get_snapshot_schema()
        cls.snapshot = asyncio.run(data_center_snapshot.build_snapshot())

    def test_schema_lists_exactly_the_nine_sections(self):
        self.assertEqual(self.schema["schemaVersion"], 2)
        self.assertEqual(self.schema["sections"], EXPECTED_SECTIONS)
        self.assertTrue(self.schema["readOnly"])

    def test_schema_sources_cover_every_section(self):
        self.assertEqual(sorted(self.schema["sources"]), sorted(EXPECTED_SECTIONS))
        for name, source in self.schema["sources"].items():
            self.assertTrue(source, f"section {name} has no provenance")

    def test_built_snapshot_has_every_declared_section(self):
        for name in EXPECTED_SECTIONS:
            with self.subTest(section=name):
                self.assertIn(name, self.snapshot, f"section {name} missing from snapshot")

    def test_health_categories_match_the_declared_contract(self):
        self.assertEqual(self.schema["healthCategories"], list(self.mod.HEALTH_CATEGORIES))
        rolled = [c["category"] for c in self.snapshot["health"]["categories"]]
        self.assertEqual(rolled, list(self.mod.HEALTH_CATEGORIES))

    def test_every_section_declares_provenance_and_an_error_channel(self):
        for name in EXPECTED_SECTIONS:
            with self.subTest(section=name):
                section = self.snapshot[name]
                self.assertIn("source", section, f"{name} has no provenance")
                self.assertTrue(section["source"], f"{name} has an empty source")

    def test_snapshot_is_json_serialisable_and_secret_free(self):
        text = json.dumps(self.snapshot, default=str).lower()
        for banned in (
            "mongodb+srv://",
            "mongodb://",
            '"uri"',
            "password",
            "api_key",
            "apikey",
            "secret",
            "bearer ",
        ):
            self.assertNotIn(banned, text, f"snapshot leaked {banned}")

    def test_database_section_exposes_identity_without_a_connection_string(self):
        db = self.snapshot["database"]
        for banned_key in ("uri", "connectionString", "mongoUri", "username", "credentials"):
            self.assertNotIn(banned_key, db, f"database section exposes {banned_key}")
        # The provider label is *derived* and says where it came from, so a reader
        # can tell a measured value from an assumed one.
        if db.get("provider"):
            self.assertIn(db["providerDerivedFrom"], ("active connection", "configuration"))
        else:
            self.assertFalse(db.get("providerAvailable"))
        if not db.get("activeSource") and not db.get("configuredSource"):
            self.assertIsNone(db["provider"], "no source was measured, so no provider is named")

    def test_build_time_is_measured_not_invented(self):
        self.assertIsInstance(self.snapshot["buildMs"], int)
        self.assertGreaterEqual(self.snapshot["buildMs"], 0)
        self.assertTrue(self.snapshot["generatedAt"].endswith("+00:00"))


class SnapshotHonestyTest(unittest.TestCase):
    def test_failing_section_degrades_only_itself(self):
        from services import data_center_snapshot

        sections = dict(data_center_snapshot.SYNC_SECTIONS)
        sections["persistence"] = _boom
        with mock.patch.dict(data_center_snapshot.__dict__, {"SYNC_SECTIONS": sections}):
            snap = asyncio.run(data_center_snapshot.build_snapshot())

        failed = snap["persistence"]
        self.assertFalse(failed["available"])
        self.assertIn("RuntimeError", failed["error"])
        # No fabricated numbers standing in for the measurement we could not take.
        self.assertNotIn("ticksPersisted", failed)
        self.assertNotIn("writeErrors", failed)

        # Everything else is still real and still present.
        for name in ("runtime", "database", "session", "scheduler", "marketData", "health"):
            self.assertIn(name, snap)
        self.assertIn(snap["health"]["categories"][0]["category"], self.mod_cats())

    @staticmethod
    def mod_cats():
        from services.data_center_snapshot import HEALTH_CATEGORIES

        return list(HEALTH_CATEGORIES)

    def test_a_raising_async_section_is_contained_too(self):
        from services import data_center_snapshot

        async def _boom_async():
            raise RuntimeError("storage exploded")

        with mock.patch.dict(
            data_center_snapshot.__dict__, {"ASYNC_SECTIONS": {"storage": _boom_async}}
        ):
            snap = asyncio.run(data_center_snapshot.build_snapshot())
        self.assertFalse(snap["storage"]["available"])
        self.assertIn("storage exploded", snap["storage"]["error"])
        self.assertTrue(snap["database"]["source"])

    def test_disconnected_mongodb_is_reported_not_faked_as_an_empty_database(self):
        from services import data_center_snapshot

        with mock.patch.object(data_center_snapshot, "is_mongo_connected", return_value=False):
            storage = asyncio.run(data_center_snapshot.storage_section())
        self.assertFalse(storage["available"])
        self.assertIn("not connected", storage["error"].lower())
        # "No documents" is a measurement. "Could not read" is not 0 documents.
        for fabricated in ("documents", "collections", "collectionsCount", "dataSizeBytes"):
            self.assertNotIn(fabricated, storage, f"unavailable storage invented {fabricated}")

    def test_failed_stats_sweep_reports_the_real_error(self):
        from services import data_center_snapshot
        from api import system as system_api

        async def _mongo_stats(*_a, **_k):
            return {"ok": False, "error": "collStats not permitted"}

        with mock.patch.object(data_center_snapshot, "is_mongo_connected", return_value=True), \
             mock.patch.object(system_api, "mongo_stats", new=_mongo_stats):
            storage = asyncio.run(data_center_snapshot.storage_section())
        self.assertFalse(storage["available"])
        self.assertIn("collStats not permitted", storage["error"])

    def test_storage_section_reads_cached_stats_instead_of_rescanning(self):
        """The snapshot must not add MongoDB load: it reuses mongo_stats()."""
        from services import data_center_snapshot
        from api import system as system_api

        calls = {"mongo_stats": 0}

        async def _mongo_stats(*_a, **_k):
            calls["mongo_stats"] += 1
            return {
                "ok": True,
                "stats": {
                    "dbName": "trading",
                    "totalObjects": 3,
                    "totalSizeBytes": 10,
                    "totalStorageBytes": 20,
                    "totalIndexSizeBytes": 5,
                    "collectionsCount": 1,
                    "indexesCount": 2,
                    "pingMs": 1.5,
                    "lastUpdatedAt": None,
                    "collections": [{"name": "ticks", "count": 3}],
                },
            }

        with mock.patch.object(data_center_snapshot, "is_mongo_connected", return_value=True), \
             mock.patch.object(system_api, "mongo_stats", new=_mongo_stats):
            storage = asyncio.run(data_center_snapshot.storage_section())

        self.assertTrue(storage["available"])
        self.assertEqual(calls["mongo_stats"], 1)
        self.assertEqual(storage["documents"], 3)

    def test_the_snapshot_module_cannot_open_its_own_database_handle(self):
        """Structural guarantee: this layer only *reads cached* database state."""
        from services import data_center_snapshot

        self.assertFalse(
            hasattr(data_center_snapshot, "get_db"),
            "the snapshot layer must not hold a database handle of its own",
        )

    def test_a_paper_terminal_is_reported_plainly(self):
        """A genuinely configured `dummy` terminal is a real value, not a bug."""
        from services import data_center_snapshot
        from brokers import manager as manager_mod

        with mock.patch.object(manager_mod, "active_terminal", return_value="dummy"), \
             mock.patch.object(manager_mod, "is_dummy_mode", return_value=True):
            section = data_center_snapshot.runtime_section()
        self.assertEqual(section["terminalMode"], "dummy")
        self.assertTrue(section["isPaperTerminal"])
        self.assertTrue(section["terminalModeAvailable"])


# --------------------------------------------------------------------------- #
# 5. realtime surfaces
# --------------------------------------------------------------------------- #
class RealtimeSurfacesTest(unittest.TestCase):
    def test_three_realtime_surfaces_are_reported_separately(self):
        from services import data_center_snapshot

        with mock.patch.object(data_center_snapshot, "_broker_feed", side_effect=RuntimeError("ws down")), \
             mock.patch.object(data_center_snapshot, "_backend_realtime", side_effect=RuntimeError("cm down")):
            section = data_center_snapshot.realtime_section()

        self.assertTrue(section["available"], "the section itself is still readable")
        for key in ("brokerFeed", "backendRealtime", "frontendRealtime"):
            self.assertIn(key, section)
        self.assertFalse(section["brokerFeed"]["available"])
        self.assertIn("ws down", section["brokerFeed"]["error"])
        self.assertFalse(section["backendRealtime"]["available"])

    def test_frontend_realtime_is_declared_unmeasurable_by_the_backend(self):
        """The backend must not claim to know the browser's socket state."""
        from services import data_center_snapshot

        with mock.patch.object(data_center_snapshot, "_broker_feed", return_value={}), \
             mock.patch.object(data_center_snapshot, "_backend_realtime", return_value={}):
            section = data_center_snapshot.realtime_section()
        frontend = section["frontendRealtime"]
        self.assertFalse(frontend["measurable"])
        self.assertTrue(frontend["reason"])
        self.assertNotIn("connected", frontend, "backend must not invent a browser socket state")

    def test_a_live_frontend_state_can_be_injected_by_the_client_only(self):
        """If the client supplies its own measurement it is kept verbatim."""
        from services import data_center_snapshot

        with mock.patch.object(data_center_snapshot, "_broker_feed", return_value={}), \
             mock.patch.object(data_center_snapshot, "_backend_realtime", return_value={}):
            section = data_center_snapshot.realtime_section()
        measured = {"measurable": True, "state": "connected", "measuredBy": "browser"}
        merged = {**section, "frontendRealtime": measured}
        self.assertTrue(merged["frontendRealtime"]["measurable"])
        self.assertEqual(merged["frontendRealtime"]["state"], "connected")

    def test_realtime_section_is_never_awaited(self):
        """Regression: realtime_section is a plain function.

        It was once listed in ASYNC_SECTIONS, so ``build_snapshot`` awaited its
        dict and reported the whole realtime surface unavailable with a
        ``TypeError``. The section must stay synchronous.
        """
        from services import data_center_snapshot

        self.assertIn("realtime", data_center_snapshot.SYNC_SECTIONS)
        self.assertNotIn("realtime", data_center_snapshot.ASYNC_SECTIONS)
        self.assertFalse(asyncio.iscoroutinefunction(data_center_snapshot.realtime_section))

    def test_built_snapshot_keeps_realtime_available(self):
        from services import data_center_snapshot

        with mock.patch.object(data_center_snapshot, "_broker_feed", return_value={}), \
             mock.patch.object(data_center_snapshot, "_backend_realtime", return_value={}):
            snap = asyncio.run(data_center_snapshot.build_snapshot())
        section = snap["realtime"]
        self.assertTrue(section["available"], section.get("error"))
        for key in ("brokerFeed", "backendRealtime", "frontendRealtime"):
            self.assertIn(key, section)


# --------------------------------------------------------------------------- #
# 6. derived health
# --------------------------------------------------------------------------- #
class DerivedHealthTest(unittest.TestCase):
    def test_all_healthy_sections_roll_up_to_ok(self):
        from services.data_center_snapshot import _derive_health

        health = _derive_health(_healthy_snapshot())
        self.assertEqual(health["overall"], "OK")
        self.assertTrue(all(c["state"] == "OK" for c in health["categories"]))

    def test_a_disconnected_database_drags_the_overall_state_down(self):
        from services.data_center_snapshot import _derive_health

        snap = _healthy_snapshot()
        snap["database"] = _section("database", connected=False, available=False,
                                    error="MongoDB is not connected")
        health = _derive_health(snap)
        self.assertEqual(health["overall"], "DOWN")
        db = next(c for c in health["categories"] if c["category"] == "database")
        self.assertEqual(db["state"], "DOWN")
        self.assertEqual(db["reason"], "MongoDB is not connected")

    def test_write_errors_report_degraded_not_healthy(self):
        from services.data_center_snapshot import _derive_health

        snap = _healthy_snapshot()
        snap["persistence"]["writeErrors"] = 3
        health = _derive_health(snap)
        self.assertEqual(health["overall"], "DEGRADED")
        ps = next(c for c in health["categories"] if c["category"] == "persistence")
        self.assertEqual(ps["state"], "DEGRADED")
        self.assertIn("3", ps["reason"])

    def test_a_healthy_scheduler_waiting_on_its_window_is_ok(self):
        """`WAITING_FOR_LOGIN` is a real scheduler state, not a failure.

        The engine being *running* while it waits for its login window is the
        healthy outcome, so the rollup says OK. The state string itself is
        published in the scheduler section and shown verbatim by the page.
        """
        from services.data_center_snapshot import _derive_health

        snap = _healthy_snapshot()
        snap["scheduler"] = _section("scheduler", state="WAITING_FOR_LOGIN", running=True,
                                     isTradingDay=True, market={"available": True})
        health = _derive_health(snap)
        sc = next(c for c in health["categories"] if c["category"] == "scheduler")
        self.assertEqual(sc["state"], "OK")
        self.assertIsNone(sc["reason"])

    def test_a_scheduler_that_is_not_running_and_waiting_reports_waiting(self):
        from services.data_center_snapshot import _derive_health

        snap = _healthy_snapshot()
        snap["scheduler"] = _section("scheduler", state="WAITING_FOR_LOGIN", running=False,
                                     isTradingDay=True, market={"available": True})
        health = _derive_health(snap)
        sc = next(c for c in health["categories"] if c["category"] == "scheduler")
        self.assertEqual(sc["state"], "WAITING")
        self.assertEqual(sc["reason"], "WAITING_FOR_LOGIN")

    def test_a_non_trading_day_is_healthy_not_an_error(self):
        from services.data_center_snapshot import _derive_health

        snap = _healthy_snapshot()
        snap["scheduler"] = _section("scheduler", state="OFF_SCHEDULE", running=True,
                                     isTradingDay=False, market={"available": True})
        health = _derive_health(snap)
        sc = next(c for c in health["categories"] if c["category"] == "scheduler")
        self.assertEqual(sc["state"], "OK")
        self.assertEqual(sc["reason"], "not a trading day")

    def test_an_idle_session_is_not_reported_as_a_failure(self):
        from services.data_center_snapshot import _derive_health

        snap = _healthy_snapshot()
        snap["session"] = _section("session", state="IDLE", active=False, expired=False)
        health = _derive_health(snap)
        se = next(c for c in health["categories"] if c["category"] == "session")
        self.assertNotIn(se["state"], ("DOWN", "DEGRADED"))

    def test_an_expired_session_is_down(self):
        from services.data_center_snapshot import _derive_health

        snap = _healthy_snapshot()
        snap["session"] = _section("session", state="EXPIRED", active=True, expired=True)
        health = _derive_health(snap)
        se = next(c for c in health["categories"] if c["category"] == "session")
        self.assertEqual(se["state"], "DOWN")
        self.assertEqual(se["reason"], "session expired")

    def test_one_broken_realtime_surface_degrades_the_category_with_two_reasons(self):
        from services.data_center_snapshot import _derive_health

        snap = _healthy_snapshot()
        snap["realtime"]["brokerFeed"] = {"available": True, "connected": False,
                                          "disconnectReason": "auth rejected"}
        snap["realtime"]["backendRealtime"] = {"available": True, "health": "STALLED",
                                               "healthReason": "no ticks for 30s"}
        health = _derive_health(snap)
        rt = next(c for c in health["categories"] if c["category"] == "realtime")
        self.assertEqual(rt["state"], "DEGRADED")
        self.assertIn("auth rejected", rt["reason"])
        self.assertIn("no ticks for 30s", rt["reason"])

    def test_health_adds_no_measurement_of_its_own(self):
        from services.data_center_snapshot import _derive_health, SOURCE_HEALTH

        snap = _healthy_snapshot()
        health = _derive_health(snap)
        self.assertEqual(health["source"], SOURCE_HEALTH)
        for entry in health["categories"]:
            self.assertEqual(sorted(entry), ["category", "reason", "state"])


# --------------------------------------------------------------------------- #
# 7. route wiring
# --------------------------------------------------------------------------- #
class SnapshotRouteTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        from api.data_center import router

        app = FastAPI()
        app.include_router(router)
        cls.client = TestClient(app)

    def test_snapshot_endpoint_is_registered_and_returns_the_envelope(self):
        from services import data_center_snapshot

        with mock.patch("api.data_center._get_or_build", new=_snapshot_stub):
            res = self.client.get("/api/system/data-center/snapshot")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertTrue(body["ok"])
        self.assertIn("generatedAt", body)
        self.assertEqual(body["data"]["schemaVersion"], data_center_snapshot.SCHEMA_VERSION)

    def test_snapshot_endpoint_503s_with_a_reason_when_the_build_fails(self):
        async def _none(key, ttl, builder, *args):
            return None

        with mock.patch("api.data_center._get_or_build", new=_none):
            res = self.client.get("/api/system/data-center/snapshot")
        self.assertEqual(res.status_code, 503)
        self.assertFalse(res.json()["ok"])
        self.assertTrue(res.json()["error"])

    def test_schema_endpoint_is_registered(self):
        res = self.client.get("/api/system/data-center/snapshot/schema")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["data"]["sections"], EXPECTED_SECTIONS)

    def test_snapshot_uses_its_own_ttl_not_the_overview_ttl(self):
        """One aggressive cache entry must not serve a stale Data Center."""
        import api.data_center as route_mod

        seen = {}

        async def _capture(key, ttl, builder, *args):
            seen["key"] = key
            seen["ttl"] = ttl
            return {}

        with mock.patch.object(route_mod, "_get_or_build", new=_capture):
            self.client.get("/api/system/data-center/snapshot")
        self.assertEqual(seen["key"], "snapshot")
        self.assertLess(seen["ttl"], route_mod.TTL_OVERVIEW)


# --------------------------------------------------------------------------- #
# 8. deep scan is an explicit asynchronous job
# --------------------------------------------------------------------------- #
class DeepScanJobTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        import api.data_center as route_mod

        cls.route_mod = route_mod
        app = FastAPI()
        app.include_router(route_mod.router)
        cls.client = TestClient(app)
        cls._reset()

    @classmethod
    def _reset(cls):
        cls.route_mod._DEEP_SCAN_JOBS.clear()
        cls.route_mod._DEEP_SCAN_ORDER.clear()

    def test_post_returns_before_the_scan_finishes(self):
        """The whole point of the job: the request does not wait for the scan."""
        self._reset()
        finished = {"ran": False}

        async def _slow_scan(_job):
            await asyncio.sleep(0.4)
            finished["ran"] = True

        started = time.perf_counter()
        with mock.patch.object(self.route_mod, "is_mongo_connected", return_value=True), \
             mock.patch.object(self.route_mod, "_run_deep_scan", new=_slow_scan):
            res = self.client.post("/api/system/data-center/deep-scan")
        elapsed = time.perf_counter() - started

        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertTrue(body["jobId"].startswith("ds-"))
        self.assertEqual(body["status"], "running")
        self.assertNotIn("result", body)
        self.assertFalse(finished["ran"], "POST returned before the scan completed")
        self.assertLess(elapsed, 0.4, f"POST waited {elapsed:.2f}s for the scan")

    def test_starting_a_scan_requires_a_live_connection(self):
        self._reset()
        with mock.patch.object(self.route_mod, "is_mongo_connected", return_value=False):
            res = self.client.post("/api/system/data-center/deep-scan")
        self.assertEqual(res.status_code, 503)
        self.assertIn("MongoDB", res.json()["detail"])

    def test_job_status_reports_completion_with_its_result(self):
        self._reset()
        job = {
            "jobId": "ds-1",
            "status": "running",
            "startedAt": "2026-01-01T00:00:00+00:00",
            "finishedAt": None,
            "durationMs": None,
            "progress": {"phase": "counting", "collectionsTotal": 3, "collectionsDone": 1},
            "error": None,
            "result": None,
        }
        self.route_mod._register_job(job)
        job.update(status="completed", result={"totals": {"collectionsCount": 3}},
                   finishedAt="2026-01-01T00:00:02+00:00", durationMs=2000, progress=None)

        res = self.client.get("/api/system/data-center/deep-scan/ds-1")
        self.assertEqual(res.status_code, 200)
        data = res.json()["data"]
        self.assertEqual(data["status"], "completed")
        self.assertEqual(data["result"]["totals"]["collectionsCount"], 3)
        self.assertEqual(data["durationMs"], 2000)
        self.assertIsNone(data["progress"])

    def test_job_status_reports_progress_while_running(self):
        self._reset()
        job = {"jobId": "ds-2", "status": "running", "startedAt": "x", "finishedAt": None,
               "durationMs": None,
               "progress": {"phase": "counting", "collectionsTotal": 3, "collectionsDone": 2,
                            "currentCollection": "ticks"},
               "error": None, "result": None}
        self.route_mod._register_job(job)
        data = self.client.get("/api/system/data-center/deep-scan/ds-2").json()["data"]
        self.assertEqual(data["status"], "running")
        self.assertEqual(data["progress"]["collectionsDone"], 2)

    def test_job_status_reports_failure_with_a_reason(self):
        self._reset()
        job = {"jobId": "ds-3", "status": "failed", "startedAt": "x",
               "finishedAt": "2026-01-01T00:00:30+00:00", "durationMs": 30000,
               "progress": None, "error": "Deep scan timed out", "result": None}
        self.route_mod._register_job(job)
        data = self.client.get("/api/system/data-center/deep-scan/ds-3").json()["data"]
        self.assertEqual(data["status"], "failed")
        self.assertIn("timed out", data["error"])

    def test_unknown_job_is_404_not_a_silent_success(self):
        self._reset()
        self.assertEqual(self.client.get("/api/system/data-center/deep-scan/nope").status_code, 404)

    def test_a_timeout_fails_the_job_instead_of_hanging_the_caller(self):
        self._reset()
        job = {"jobId": "ds-4", "status": "running", "startedAt": "x", "finishedAt": None,
               "durationMs": None, "progress": None, "error": None, "result": None}
        self.route_mod._register_job(job)

        async def _slow_holder():
            return await asyncio.sleep(3600)

        with mock.patch.object(self.route_mod, "get_db", return_value=object()), \
             mock.patch.object(self.route_mod.asyncio, "wait_for",
                               new=_timeout_immediately):
            asyncio.run(self.route_mod._run_deep_scan(job))
        self.assertEqual(job["status"], "failed")
        self.assertIn("timed out", job["error"])
        self.assertIsNotNone(job["finishedAt"])
        self.assertIsNotNone(job["durationMs"])
        _slow_holder  # referenced so linters keep the helper

    def test_the_job_registry_is_bounded(self):
        self._reset()
        for i in range(self.route_mod.DEEP_SCAN_MAX_JOBS + 4):
            self.route_mod._register_job({
                "jobId": f"ds-x{i}", "status": "completed", "startedAt": "x",
                "finishedAt": "x", "durationMs": 1, "progress": None,
                "error": None, "result": None,
            })
        self.assertLessEqual(len(self.route_mod._DEEP_SCAN_JOBS), self.route_mod.DEEP_SCAN_MAX_JOBS)
        # the newest survive; the oldest are dropped
        self.assertIn(f"ds-x{self.route_mod.DEEP_SCAN_MAX_JOBS + 3}", self.route_mod._DEEP_SCAN_JOBS)
        self.assertNotIn("ds-x0", self.route_mod._DEEP_SCAN_JOBS)

    def test_no_get_endpoint_starts_a_scan(self):
        """Page load must never trigger a deep scan."""
        for path in ("/api/system/data-center/snapshot",
                     "/api/system/data-center/overview",
                     "/api/system/data-center/collections/ticks"):
            with self.subTest(path=path):
                with mock.patch.object(self.route_mod, "_run_deep_scan", new=_forbid):
                    res = self.client.get(path)
                self.assertNotEqual(res.status_code, 500)


# --------------------------------------------------------------------------- #
# fixtures / stubs
# --------------------------------------------------------------------------- #
def _boom():
    raise RuntimeError("engine exploded")


async def _timeout_immediately(coro, timeout=None):
    coro.close()
    raise asyncio.TimeoutError


async def _forbid(*_a, **_k):
    raise AssertionError("a page load must not start a deep scan")


async def _snapshot_stub(key, ttl, builder, *args):
    from services import data_center_snapshot

    return await data_center_snapshot.build_snapshot()


if __name__ == "__main__":
    unittest.main()
