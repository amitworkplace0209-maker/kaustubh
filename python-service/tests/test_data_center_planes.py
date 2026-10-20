"""Data Center observability-plane tests (no live MongoDB required).

Covers the read-only contract of ``services/data_center_planes``:

- every plane reports ``available``/``error`` instead of a fabricated value
- the database plane never leaks a URI / credential and only copies an
  allow-listed subset out of ``serverStatus``
- the engines/topology planes read the Engine Registry, never a hard-coded list
- the DB Writer plane republishes the writer's OWN counters (no recomputation)
- the ownership plane marks unmapped collections ``UNMAPPED`` / ``NOT VERIFIED``
- the retention plane lists REAL TTL indexes and stays honest when there are none

Run:  python -m pytest tests/test_data_center_planes.py -q
"""
from __future__ import annotations

import asyncio
import os
import re
import sys
import unittest
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from services import data_center_planes as planes  # noqa: E402


def run(coro):
    return asyncio.get_event_loop_policy().new_event_loop().run_until_complete(coro)


# --------------------------------------------------------------------------- #
# Fakes
# --------------------------------------------------------------------------- #
class FakeCollection:
    def __init__(self, name, indexes=None):
        self.name = name
        self._indexes = indexes or {}

    async def index_information(self):
        if isinstance(self._indexes, Exception):
            raise self._indexes
        return self._indexes


class FakeDB:
    def __init__(self, name="kaustubh", collections=None, status=None):
        self.name = name
        self._collections = collections or {}
        self._status = status or {}

    def __getitem__(self, name):
        return self._collections.get(name, FakeCollection(name))

    async def list_collection_names(self):
        return list(self._collections)

    async def command(self, cmd, *args, **kwargs):
        if cmd == "serverStatus":
            if isinstance(self._status, Exception):
                raise self._status
            return self._status
        return {}


# --------------------------------------------------------------------------- #
# Database plane
# --------------------------------------------------------------------------- #
class DatabasePlaneTest(unittest.TestCase):
    def test_reports_unavailable_when_not_connected(self):
        info = {
            "source": "unknown",
            "database": None,
            "connected": False,
            "configured": False,
            "host": "",
            "error": "not connected",
            "connectedAt": None,
            "serverVersion": None,
            "pool": {},
        }
        with mock.patch.object(planes, "get_mongo_info", return_value=info), \
             mock.patch.object(planes, "is_mongo_connected", return_value=False):
            plane = run(planes.database_plane())

        self.assertFalse(plane["available"])
        self.assertEqual(plane["error"], "not connected")
        self.assertIsNone(plane["storage"])
        self.assertIsNone(plane["collections"])
        self.assertFalse(plane["serverStatus"]["available"])
        self.assertEqual(plane["serverStatus"]["error"], "MongoDB is not connected")

    def test_never_emits_a_uri_or_credential(self):
        info = {
            "source": "atlas",
            "database": "kaustubh",
            "connected": True,
            "configured": True,
            "host": "cluster0.example.mongodb.net",
            "error": None,
            "connectedAt": "2024-12-01T09:00:00+05:30",
            "serverVersion": "7.0.14",
            "pool": {"ready": 3, "created": 4},
        }
        db = FakeDB(status={"uptime": 100, "host": "internal-host", "localTime": "x",
                            "connections": {"current": 2, "available": 8}})
        stats = {
            "connected": True,
            "stats": {
                "dbName": "kaustubh",
                "collections": [],
                "collectionsCount": 0,
                "indexesCount": 0,
                "totalSizeBytes": 1,
                "totalStorageBytes": 1,
                "totalIndexSizeBytes": 1,
                "totalObjects": 1,
                "pingMs": 1.5,
                "lastUpdatedAt": "2024-12-01T10:00:00+05:30",
            },
        }
        fake_system = mock.MagicMock()
        fake_system.mongo_stats = mock.AsyncMock(return_value=stats)

        with mock.patch.object(planes, "get_mongo_info", return_value=info), \
             mock.patch.object(planes, "is_mongo_connected", return_value=True), \
             mock.patch.object(planes, "get_db", return_value=db), \
             mock.patch.dict(sys.modules, {"api.system": fake_system}):
            plane = run(planes.database_plane())

        self.assertTrue(plane["available"])
        self.assertEqual(plane["identity"]["host"], "cluster0.example.mongodb.net")
        self.assertEqual(plane["identity"]["sourceLabel"], "mongodb-atlas")
        # The whitelisted serverStatus subset only — `host` must not be copied out.
        self.assertEqual(plane["serverStatus"]["connections"], {"current": 2, "available": 8})
        self.assertNotIn("host", plane["serverStatus"])
        for banned in ("mongodb+srv://", "mongodb://", "password", "uri"):
            self.assertNotIn(banned, str(plane).lower())

    def test_server_status_unavailable_is_not_an_error_state(self):
        info = {
            "source": "atlas", "database": "d", "connected": True, "configured": True,
            "host": "h", "error": None, "connectedAt": None, "serverVersion": "7.0.14", "pool": {},
        }
        # serverStatus is restricted on some Atlas tiers — a real, expected case.
        db = FakeDB(status=Exception("not authorized on admin command"))
        fake_system = mock.MagicMock()
        fake_system.mongo_stats = mock.AsyncMock(
            return_value={"connected": True, "stats": {"dbName": "d", "collections": []}}
        )
        with mock.patch.object(planes, "get_mongo_info", return_value=info), \
             mock.patch.object(planes, "is_mongo_connected", return_value=True), \
             mock.patch.object(planes, "get_db", return_value=db), \
             mock.patch.dict(sys.modules, {"api.system": fake_system}):
            plane = run(planes.database_plane())

        self.assertFalse(plane["serverStatus"]["available"])
        self.assertIsNotNone(plane["serverStatus"]["error"])


# --------------------------------------------------------------------------- #
# Engines / topology planes
# --------------------------------------------------------------------------- #
class EnginePlaneTest(unittest.TestCase):
    def _registry(self):
        reg = mock.MagicMock()
        reg.summary.return_value = {"overall": "HEALTHY", "total": 2, "states": {"RUNNING": 2}, "healths": {"HEALTHY": 2}, "registeredAt": 1.0}
        reg.dependency_graph.return_value = {
            "storage_engine": {"name": "Storage Engine", "category": "storage", "state": "RUNNING",
                               "health": "HEALTHY", "dependencies": [], "dependents": ["db_writer_engine"]},
            "db_writer_engine": {"name": "DB Writer Engine", "category": "storage", "state": "RUNNING",
                                 "health": "HEALTHY", "dependencies": ["storage_engine"], "dependents": []},
        }
        reg.get_status.side_effect = lambda eid: {
            "engineName": eid, "engineCategory": "storage", "version": "1.0.0",
            "state": "RUNNING", "health": "HEALTHY", "lastHeartbeat": "2024-12-01T10:00:00+05:30",
            "uptimeSeconds": 60,
        }
        return reg

    def _patched(self, reg):
        mod = mock.MagicMock()
        mod.get_engine_registry.return_value = reg
        return mock.patch.dict(sys.modules, {"services.engine_registry": mod})

    def test_documented_engines_carry_their_owner(self):
        with self._patched(self._registry()):
            plane = run(planes.engines_plane())

        self.assertTrue(plane["available"])
        by_id = {e["engineId"]: e for e in plane["documented"]}
        self.assertEqual(by_id["db_writer_engine"]["owner"], "DB Writer Engine")
        self.assertIn("authoritative writer", by_id["db_writer_engine"]["plane"])
        self.assertEqual(by_id["storage_engine"]["dependencies"], [])

    def test_undocumented_registry_engines_are_reported_not_dropped(self):
        reg = self._registry()
        reg.dependency_graph.return_value["mystery"] = {
            "name": "Mystery", "category": "core", "state": "UNKNOWN",
            "health": "UNKNOWN", "dependencies": [], "dependents": [],
        }
        with self._patched(reg):
            plane = run(planes.engines_plane())

        mystery = [e for e in plane["documented"] if e["engineId"] == "mystery"]
        self.assertEqual(len(mystery), 1)
        self.assertFalse(mystery[0]["documented"])
        self.assertEqual(mystery[0]["owner"], "UNMAPPED")
        self.assertEqual(plane["undocumentedCount"], 1)

    def test_topology_edges_are_derived_from_the_registry(self):
        with self._patched(self._registry()):
            plane = run(planes.topology_plane())

        self.assertTrue(plane["available"])
        self.assertEqual(plane["nodeCount"], 2)
        self.assertEqual(plane["edgeCount"], 1)
        edge = plane["edges"][0]
        self.assertEqual(edge["from"], "storage_engine")
        self.assertEqual(edge["to"], "db_writer_engine")
        self.assertEqual(edge["kind"], "depends_on")

    def test_registry_failure_is_reported_not_swallowed(self):
        mod = mock.MagicMock()
        mod.get_engine_registry.side_effect = RuntimeError("registry down")
        with mock.patch.dict(sys.modules, {"services.engine_registry": mod}):
            plane = run(planes.engines_plane())
        self.assertFalse(plane["available"])
        self.assertIn("registry down", plane["error"])


# --------------------------------------------------------------------------- #
# DB Writer plane
# --------------------------------------------------------------------------- #
class DbWriterPlaneTest(unittest.TestCase):
    def test_republishes_the_writers_own_snapshot(self):
        mod = mock.MagicMock()
        engine = mock.MagicMock()
        engine.status_snapshot.return_value = {
            "state": "RUNNING", "health": "HEALTHY", "version": "1.0.0",
            "pipeline": {"totalWritten": 500, "bufferLength": 3},
            "dataLossAccounting": {"received": 10, "reconciliation": {"receivedEqualsSum": True}},
            "tickPersistence": {"personalOneDay": True},
        }
        engine.is_tick_persistence_hard_capped = lambda key: False
        engine.storage_caps = lambda: {"personalOneDay": False}
        engine.storage_cap_reason = lambda: None
        # The plane imports these constants from the MODULE, not the instance.
        mod.TICK_PERSISTENCE_PERMISSIONS = {"personalOneDay": "dbw_personal_expiry_ticks"}
        mod.TICK_PERSISTENCE_LABELS = {"personalOneDay": "Personal — 1-Day"}
        mod.db_writer_engine = engine
        with mock.patch.dict(sys.modules, {"services.db_writer_engine": mod}):
            plane = run(planes.db_writer_plane())

        self.assertTrue(plane["available"])
        self.assertTrue(plane["authoritative"])
        self.assertEqual(plane["pipeline"]["totalWritten"], 500)
        self.assertEqual(plane["permissions"][0]["collection"], "dbw_personal_expiry_ticks")
        self.assertTrue(plane["permissions"][0]["enabled"])

    def test_writer_failure_is_reported(self):
        mod = mock.MagicMock()
        mod.db_writer_engine.status_snapshot.side_effect = RuntimeError("boom")
        with mock.patch.dict(sys.modules, {"services.db_writer_engine": mod}):
            plane = run(planes.db_writer_plane())
        self.assertFalse(plane["available"])
        self.assertIn("boom", plane["error"])


# --------------------------------------------------------------------------- #
# Ownership + retention planes
# --------------------------------------------------------------------------- #
class OwnershipPlaneTest(unittest.TestCase):
    def test_unmapped_collection_is_flagged_not_guessed(self):
        fake_system = mock.MagicMock()
        fake_system.mongo_stats = mock.AsyncMock(return_value={
            "connected": True,
            "stats": {
                "dbName": "kaustubh",
                "collections": [{"name": "mystery_collection", "count": 5, "storageBytes": 16,
                                 "indexSizeBytes": 0, "indexes": 1}],
            },
        })
        with mock.patch.object(planes, "is_mongo_connected", return_value=True), \
             mock.patch.dict(sys.modules, {"api.system": fake_system}):
            plane = run(planes.ownership_plane())

        self.assertTrue(plane["available"])
        row = plane["collections"][0]
        self.assertEqual(row["owner"], "UNMAPPED")
        self.assertEqual(row["retention"], "NOT VERIFIED")
        self.assertFalse(row["documented"])
        self.assertEqual(plane["undocumented"], ["mystery_collection"])

    def test_documented_but_absent_collection_is_listed_as_absent(self):
        fake_system = mock.MagicMock()
        fake_system.mongo_stats = mock.AsyncMock(return_value={
            "connected": True, "stats": {"dbName": "kaustubh", "collections": []},
        })
        with mock.patch.object(planes, "is_mongo_connected", return_value=True), \
             mock.patch.dict(sys.modules, {"api.system": fake_system}):
            plane = run(planes.ownership_plane())

        absent = {c["name"]: c for c in plane["collections"] if not c["present"]}
        self.assertIn("ticks", absent)
        self.assertEqual(absent["ticks"]["owner"], "DB Writer Engine")
        self.assertIsNone(absent["ticks"]["documents"])


class RetentionPlaneTest(unittest.TestCase):
    def test_lists_real_ttl_indexes(self):
        db = FakeDB(collections={
            "dbw_personal_expiry_ticks": FakeCollection("dbw_personal_expiry_ticks", {
                "_id_": {"key": [("_id", 1)]},
                "expiry_1": {"key": [("expiry", 1)], "expireAfterSeconds": 86400},
            }),
            "ticks": FakeCollection("ticks", {"_id_": {"key": [("_id", 1)]}}),
        })
        cleanup = mock.MagicMock()
        cleanup.get_cleanup_status = mock.AsyncMock(return_value={"ok": True, "enabled": True})
        with mock.patch.object(planes, "is_mongo_connected", return_value=True), \
             mock.patch.object(planes, "get_db", return_value=db), \
             mock.patch.dict(sys.modules, {"services.atlas_cleanup": cleanup}):
            plane = run(planes.retention_plane())

        self.assertTrue(plane["available"])
        self.assertEqual(plane["ttlIndexCount"], 1)
        self.assertEqual(plane["ttlIndexes"][0]["collection"], "dbw_personal_expiry_ticks")
        self.assertEqual(plane["ttlIndexes"][0]["field"], "expiry")
        self.assertEqual(plane["ttlIndexes"][0]["expireAfterSeconds"], 86400)

    def test_no_ttl_indexes_is_an_empty_list_not_an_error(self):
        db = FakeDB(collections={"ticks": FakeCollection("ticks", {"_id_": {"key": [("_id", 1)]}})})
        cleanup = mock.MagicMock()
        cleanup.get_cleanup_status = mock.AsyncMock(return_value={"ok": True})
        with mock.patch.object(planes, "is_mongo_connected", return_value=True), \
             mock.patch.object(planes, "get_db", return_value=db), \
             mock.patch.dict(sys.modules, {"services.atlas_cleanup": cleanup}):
            plane = run(planes.retention_plane())

        self.assertEqual(plane["ttlIndexes"], [])
        self.assertEqual(plane["ttlIndexCount"], 0)

    def test_one_failing_index_scan_does_not_abort_the_plane(self):
        db = FakeDB(collections={
            "broken": FakeCollection("broken", RuntimeError("not authorized")),
            "ok": FakeCollection("ok", {"exp_1": {"key": [("ts", 1)], "expireAfterSeconds": 60}}),
        })
        cleanup = mock.MagicMock()
        cleanup.get_cleanup_status = mock.AsyncMock(return_value={"ok": True})
        with mock.patch.object(planes, "is_mongo_connected", return_value=True), \
             mock.patch.object(planes, "get_db", return_value=db), \
             mock.patch.dict(sys.modules, {"services.atlas_cleanup": cleanup}):
            plane = run(planes.retention_plane())

        self.assertTrue(plane["available"])
        self.assertEqual(plane["ttlIndexCount"], 1)
        self.assertEqual(plane["ttlIndexes"][0]["collection"], "ok")


# --------------------------------------------------------------------------- #
# Map integrity
# --------------------------------------------------------------------------- #
class OwnershipMapTest(unittest.TestCase):
    def test_every_documented_engine_and_collection_is_fully_attributed(self):
        for engine_id, meta in planes.DOCUMENTED_ENGINES.items():
            self.assertTrue(meta["owner"], f"{engine_id} has no owner")
            self.assertTrue(meta["plane"], f"{engine_id} has no plane")
            self.assertTrue(meta["endpoint"].startswith("/api/"), engine_id)
        for name, meta in planes.COLLECTION_OWNERS.items():
            self.assertTrue(meta["owner"], f"{name} has no owner")
            self.assertTrue(meta["module"], f"{name} has no module")
            self.assertTrue(meta["retention"], f"{name} has no retention")
            self.assertTrue(meta["basis"], f"{name} has no basis")

    def test_ticks_are_owned_by_db_writer(self):
        self.assertEqual(planes.COLLECTION_OWNERS["ticks"]["owner"], "DB Writer Engine")


# --------------------------------------------------------------------------- #
# Engine id drift guard
# --------------------------------------------------------------------------- #
class DocumentedEngineIdTest(unittest.TestCase):
    """``DOCUMENTED_ENGINES`` keys must be the ids the registry really registers.

    The key of that map is looked up directly in the Engine Registry's dependency
    graph, so a key that does not match the engine class' declared ``engine_id``
    can never resolve: the documented entry is permanently ``NOT_REGISTERED``
    while the live engine shows up as ``UNDOCUMENTED`` / ``UNMAPPED``. That
    regression shipped three times (``market_watch_engine`` vs ``market_watch``,
    ``connection_manager_engine`` vs ``connection_manager``,
    ``session_manager_engine`` vs ``session_manager``), so the ids are asserted
    against the source of truth here.

    The ids are read with a regex instead of importing every engine module
    because importing them would pull in the Mongo connection and the whole
    engine bootstrap; this test must stay a pure source-level check.
    """

    #: Files that declare ``engine_id`` for a class registered with the registry.
    #: ``core/engines/engine_base.py`` is deliberately absent: it only declares
    #: the abstract placeholder ``engine_id = "base"`` that nothing registers.
    _ENGINE_SOURCES = (
        "core/engines/feature_engine.py",
        "core/engines/search_engine.py",
        "core/engines/squareoff_engine.py",
        # Risk Engine became a first-class EngineBase so it is registered.
        "core/engines/risk_engine.py",
        "services/watchlist_engine.py",
        "services/market_watch_engine.py",
        "services/market_coach.py",
        "services/storage_engine.py",
        "services/db_writer_engine.py",
        "services/notification_engine.py",
        "services/audit_engine.py",
        "services/session_manager_engine.py",
        "services/connection_manager_engine.py",
        "services/websocket_engine.py",
        "services/legacy_engine_facades.py",
    )

    _DECLARED = re.compile(r'^\s*engine_id\s*(?::\s*[^=]+)?=\s*["\']([a-z_]+)["\']', re.M)

    @classmethod
    def _declared_engine_ids(cls):
        found: dict[str, str] = {}
        for rel in cls._ENGINE_SOURCES:
            path = os.path.join(_PY_ROOT, rel)
            if not os.path.exists(path):
                continue
            with open(path, "r", encoding="utf-8") as fh:
                for match in cls._DECLARED.finditer(fh.read()):
                    found[match.group(1)] = rel
        return found

    def test_documented_keys_are_real_declared_engine_ids(self):
        declared = self._declared_engine_ids()
        self.assertTrue(declared, "no engine_id declarations were parsed")
        bogus = sorted(set(planes.DOCUMENTED_ENGINES) - set(declared))
        self.assertEqual(
            bogus, [],
            "DOCUMENTED_ENGINES holds ids no engine declares: "
            f"{bogus} — these render permanently as NOT_REGISTERED",
        )

    def test_every_declared_engine_is_connected(self):
        """An engine that exists but is not in the map renders as UNMAPPED."""
        declared = self._declared_engine_ids()
        missing = sorted(set(declared) - set(planes.DOCUMENTED_ENGINES))
        self.assertEqual(
            missing, [],
            "engines are registered but not connected to the Data Center: "
            f"{missing} — add them to DOCUMENTED_ENGINES",
        )

    def test_documented_endpoints_match_the_engine_id(self):
        """The published endpoint must address the same id as the registry key."""
        for engine_id, meta in planes.DOCUMENTED_ENGINES.items():
            endpoint = meta["endpoint"]
            self.assertTrue(endpoint.startswith("/api/"), engine_id)
            if endpoint.startswith("/api/services/engines/"):
                self.assertEqual(endpoint.rsplit("/", 1)[-1], engine_id)

    def test_known_engine_ids_use_their_real_registry_ids(self):
        """Guards the three ids that historically drifted."""
        self.assertIn("market_watch", planes.DOCUMENTED_ENGINES)
        self.assertIn("connection_manager", planes.DOCUMENTED_ENGINES)
        self.assertIn("session_manager", planes.DOCUMENTED_ENGINES)
        for stale in (
            "market_watch_engine",
            "connection_manager_engine",
            "session_manager_engine",
        ):
            self.assertNotIn(stale, planes.DOCUMENTED_ENGINES)


if __name__ == "__main__":
    unittest.main()
