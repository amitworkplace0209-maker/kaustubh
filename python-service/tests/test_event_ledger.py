"""Event ledger integrity tests.

Two groups:

1. Pure-Python tests (no DB):
   - ``_next_event_id()`` collision resistance (volume, threads, subprocesses).
   - ``record_event`` canonical event model + never uses a caller-supplied
     ``event_id`` as its own id (duplicate root cause regression guard).

2. MongoDB-backed tests (skipped when MongoDB is not reachable):
   - duplicate event_id detection + idempotent repair on a throwaway db.
   - unique index creation after repair; old duplicate ids can no longer be
     inserted; duplicate-free rows still can.
   - ``ensure_system_events_unique_index`` reuse / idempotency.
   - ``run_startup_migrations`` rerunnable (repair skipped when already applied).

Run:  python -m pytest tests/test_event_ledger.py -q
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import unittest

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from services.event_history import _next_event_id, record_event  # noqa: E402


# MongoDB-backed tests run against MongoDB — controlled by MONGODB_URI.
# Point them somewhere with TEST_MONGODB_URI to override; otherwise the live
# cluster from MONGODB_URI is used. The tests create and drop only
# the throwaway TEST_DB, never the application database. When no server is
# reachable every Mongo-backed test below is skipped, so the suite stays green
# offline.
MONGO_URI = os.getenv("TEST_MONGODB_URI") or os.getenv("MONGODB_URI") or ""
TEST_DB = "kaustubh_ledger_test"


def _mongo_available() -> bool:
    if not MONGO_URI:
        return False
    try:
        from motor.motor_asyncio import AsyncIOMotorClient
    except ImportError:
        return False
    try:
        async def _probe():
            client = AsyncIOMotorClient(MONGO_URI, serverSelectionTimeoutMS=2000)
            try:
                await client.admin.command("ping")
            finally:
                client.close()
        asyncio.run(_probe())
        return True
    except Exception:
        return False


_EVENT_ID_RE = re.compile(r"^evt_[0-9a-f]{32}$")


class EventIdGenerationTest(unittest.TestCase):
    def test_format(self):
        for _ in range(100):
            self.assertRegex(_next_event_id(), _EVENT_ID_RE)

    def test_unique_across_volume(self):
        ids = {_next_event_id() for _ in range(50000)}
        self.assertEqual(len(ids), 50000)

    def test_unique_across_threads(self):
        results: list[list[str]] = [[] for _ in range(8)]

        def _worker(idx: int):
            for _ in range(5000):
                results[idx].append(_next_event_id())

        threads = [threading.Thread(target=_worker, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        all_ids = [i for r in results for i in r]
        self.assertEqual(len(set(all_ids)), len(all_ids))

    def test_unique_across_process_restarts(self):
        """Two fresh interpreters (no shared _SEQ) must not collide."""
        script = (
            "import sys; sys.path.insert(0, r'" + _PY_ROOT + "');"
            "import json; from services.event_history import _next_event_id;"
            "print(json.dumps([_next_event_id() for _ in range(20000)]))"
        )
        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as fh:
            fh.write(script)
            helper = fh.name
        try:
            ids: set[str] = set()
            for _ in range(2):
                out = subprocess.run(
                    [sys.executable, helper],
                    capture_output=True, text=True, timeout=120,
                )
                self.assertEqual(out.returncode, 0, out.stderr)
                batch = json.loads(out.stdout.strip())
                self.assertEqual(len(batch), 20000)
                ids.update(batch)
            # Local process IDs must also be collision-free vs subprocess IDs.
            ids.update(_next_event_id() for _ in range(20000))
            self.assertEqual(len(ids), 60000)
        finally:
            os.unlink(helper)


class RecordEventModelTest(unittest.TestCase):
    def test_caller_event_id_is_demoted_not_reused(self):
        """Regression guard: meta['event_id'] must never become the own id."""
        e1 = record_event("pipeline", "QUALITY_BREACH", "warning", "first",
                          {"reason_code": "quality_bad", "component": "quality"})
        e2 = record_event("pipeline", "ALERT_CREATED", "warning", "alert",
                          {"reason_code": "quality_bad", "component": "quality",
                           "event_id": e1["event_id"], "alert_id": "x"})
        self.assertNotEqual(e1["event_id"], e2["event_id"])
        self.assertEqual(e2["related_event_id"], e1["event_id"])
        self.assertRegex(e2["event_id"], _EVENT_ID_RE)

    def test_related_event_id_is_hoisted(self):
        e = record_event("pipeline", "ALERT_RESOLVED", "info", "cleared",
                         {"related_event_id": "evt_ref_123", "duration": 4.0})
        self.assertEqual(e["related_event_id"], "evt_ref_123")
        self.assertNotEqual(e["event_id"], "evt_ref_123")

    def test_canonical_event_model_fields(self):
        e = record_event("websocket", "connected", "info", "feed up",
                         {"reason_code": "ok", "component": "ws"})
        for required in ("event_id", "event", "severity", "source", "message", "ts", "meta"):
            self.assertIn(required, e)
        self.assertEqual(e["source"], "websocket")
        self.assertEqual(e["event"], "connected")

    def test_no_secrets_hoisted_to_meta(self):
        e = record_event("auth", "LOGIN_SUCCESS", "info", "ok",
                         {"reason_code": "ok", "password": "p@ss", "authorization": "Bearer x",
                          "benign": 1})
        self.assertNotIn("password", e["meta"])
        self.assertNotIn("authorization", e["meta"])
        self.assertEqual(e["meta"]["benign"], 1)


class _AsyncTestCase(unittest.TestCase):
    _loop = None

    @classmethod
    def setUpClass(cls):
        cls._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(cls._loop)

    @classmethod
    def tearDownClass(cls):
        if cls._loop is not None and not cls._loop.is_closed():
            try:
                cls._loop.run_until_complete(
                    asyncio.gather(*asyncio.all_tasks(cls._loop), return_exceptions=True)
                )
            except Exception:
                pass
            cls._loop.close()

    def _run(self, coro):
        return self._loop.run_until_complete(coro)


class LedgerRepairMongoTest(_AsyncTestCase):
    """DB-backed: detection, repair, unique index, idempotency, rerun safety."""

    _client = None
    _db = None

    @classmethod
    def setUpClass(cls):
        if not _mongo_available():
            raise unittest.SkipTest(f"MongoDB not reachable at {MONGO_URI}")
        super().setUpClass()
        from motor.motor_asyncio import AsyncIOMotorClient
        cls._client = AsyncIOMotorClient(MONGO_URI, serverSelectionTimeoutMS=3000)
        cls._db = cls._client[TEST_DB]

    @classmethod
    def tearDownClass(cls):
        if cls._client is not None:
            cls._loop.run_until_complete(cls._client.drop_database(TEST_DB))
            cls._client.close()
        super().tearDownClass()

    def _fresh_collection(self, name):
        return self._db[name].drop()

    def test_detect_and_repair(self):
        from database.migrations import (  # noqa: PLC0415
            reconcile_system_event_ids,
            detect_duplicate_event_ids,
        )
        coll_name = "events_dup"
        self._run(self._fresh_collection(coll_name))
        coll = self._db[coll_name]
        docs = []
        for i in range(10):
            docs.append({"event_id": "dup_a", "source": "pipeline", "event": f"E{i}", "message": f"m{i}"})
        for i in range(3):
            docs.append({"event_id": "dup_b", "source": "websocket", "event": f"F{i}", "message": f"n{i}"})
        docs.append({"event_id": "unique_1", "source": "process", "event": "started", "message": "x"})
        self._run(coll.insert_many(docs))

        groups = self._run(detect_duplicate_event_ids(self._db, coll_name))
        self.assertEqual(len(groups), 2)
        count_by_id = {g["event_id"]: g["count"] for g in groups}
        self.assertEqual(count_by_id, {"dup_a": 10, "dup_b": 3})

        report = self._run(reconcile_system_event_ids(self._db, coll_name))
        self.assertEqual(report["duplicate_groups"], 2)
        self.assertEqual(report["repaired"], 11)
        self.assertEqual(report["canonical_kept"], 2)
        self.assertEqual(report["failed"], 0)

        # All ids now distinct.
        remaining = self._run(coll.distinct("event_id"))
        total = self._run(coll.count_documents({}))
        self.assertEqual(len(remaining), total)
        self.assertEqual(total, 14)
        # Original info preserved (messages all present).
        msgs = set(self._run(coll.distinct("message")))
        self.assertEqual(len(msgs), 14)
        # Repaired rows are tagged and traceable.
        tagged = self._run(coll.count_documents(
            {"repaired_from_event_id": {"$in": ["dup_a", "dup_b"]}}))
        self.assertEqual(tagged, 11)

        # Idempotent: a second pass repairs nothing and never double-tags.
        report2 = self._run(reconcile_system_event_ids(self._db, coll_name))
        self.assertEqual(report2["repaired"], 0)
        self.assertEqual(report2["duplicate_groups"], 0)

    def test_unique_index_blocks_reinsertion_of_old_ids(self):
        from database.migrations import (  # noqa: PLC0415
            ensure_system_events_unique_index,
            reconcile_system_event_ids,
        )
        from pymongo.errors import DuplicateKeyError

        coll_name = "events_uniq"
        self._run(self._fresh_collection(coll_name))
        coll = self._db[coll_name]
        self._run(coll.insert_many([
            {"event_id": "legacy_1", "source": "a", "event": "x", "message": ""},
            {"event_id": "legacy_1", "source": "a", "event": "y", "message": ""},
            {"event_id": "legacy_1", "source": "a", "event": "z", "message": ""},
        ]))
        self._run(reconcile_system_event_ids(self._db, coll_name))
        res = self._run(ensure_system_events_unique_index(self._db, coll_name))
        self.assertTrue(res["created"])

        # The exact duplicate that previously broke startup can no longer be inserted.
        with self.assertRaises(DuplicateKeyError):
            self._run(coll.insert_one({"event_id": "legacy_1", "source": "new", "event": "w"}))
        # Fresh ids + new unique ids insert fine.
        self._run(coll.insert_one({"event_id": "brand_new_ok", "source": "new"}))
        self._run(coll.insert_one({"event_id": "evt_" + "f" * 32, "source": "new"}))

        # Idempotent: second call reuses the existing unique index.
        res2 = self._run(ensure_system_events_unique_index(self._db, coll_name))
        self.assertTrue(res2["reused"])
        self.assertFalse(res2["created"])

    def test_startup_migrations_rerunnable(self):
        from database.migrations import (  # noqa: PLC0415
            run_startup_migrations,
            is_migration_applied,
        )
        coll_name = "events_startup"
        migration_name = "test.ledger_repair"
        self._run(self._fresh_collection(coll_name))
        coll = self._db[coll_name]
        self._run(coll.insert_one({"event_id": "dup_only", "event": "b", "source": "s"}))
        self._run(coll.insert_one({"event_id": "dup_only", "event": "a", "source": "s"}))

        try:
            rep1 = self._run(run_startup_migrations(
                self._db, collection=coll_name, migration_name=migration_name))
            summary = rep1[0]
            self.assertEqual(summary["repair"]["repaired"], 1)
            self.assertEqual(summary["repair"]["duplicate_groups"], 1)
            self.assertTrue(summary["index"]["created"] or summary["index"]["reused"])
            self.assertTrue(self._run(is_migration_applied(self._db, migration_name)))

            # Rerun: repair skipped (already-applied), index reused.
            rep2 = self._run(run_startup_migrations(
                self._db, collection=coll_name, migration_name=migration_name))
            self.assertEqual(rep2[0]["repair"], {"skipped": "already-applied"})
            self.assertTrue(rep2[0]["index"]["reused"] or rep2[0]["index"]["created"])
        finally:
            self._run(self._db["_migrations"].delete_many({"_id": migration_name}))


if __name__ == "__main__":
    unittest.main()