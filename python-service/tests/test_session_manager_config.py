"""Session Manager configuration service tests (no live MongoDB required).

Covers:
- built-in defaults are the honest fallback when MongoDB is unavailable
- unknown keys / bad values / out-of-range numbers are rejected
- set_config persists to Mongo and live-applies to the sync runtime accessors
- reset_config restores built-in defaults
- refresh_config loads persisted values into the cache at startup
- the session lifetime knob drives NEW sessions (mark_login_success default)

Run:  python -m pytest tests/test_session_manager_config.py -q
"""
from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)


class FakeMongoCollection:
    def __init__(self):
        self._docs: dict[str, dict] = {}

    def find(self, query=None):
        async def _gen():
            for d in self._docs.values():
                yield dict(d)
        return _gen()

    async def update_one(self, filter_doc, update, upsert=False):
        key = filter_doc.get("key")
        doc = dict(self._docs.get(key) or {})
        doc.update({"key": key, **update.get("$set", {})})
        self._docs[key] = doc
        return {"modified": 1, "upserted": upsert}

    async def delete_one(self, filter_doc):
        key = filter_doc.get("key")
        deleted = 1 if self._docs.pop(key, None) is not None else 0
        return {"deleted": deleted}

    async def delete_many(self, filter_doc=None):
        count = len(self._docs)
        self._docs.clear()
        return {"deleted": count}

    def rows(self):
        return [dict(d) for d in self._docs.values()]


class FakeDB:
    def __init__(self):
        self._collections: dict[str, FakeMongoCollection] = {}

    def __getitem__(self, name):
        if name not in self._collections:
            self._collections[name] = FakeMongoCollection()
        return self._collections[name]


class ConfigServiceTest(unittest.IsolatedAsyncioTestCase):
    def _patch_mongo(self, connected):
        self.db = FakeDB()
        self.patches = (
            mock.patch("database.connection.get_db", return_value=self.db),
            mock.patch("database.connection.is_mongo_connected", return_value=connected),
        )
        for p in self.patches:
            p.start()
        self.addCleanup(lambda: [p.stop() for p in self.patches])

    async def test_defaults_when_mongo_down(self):
        self._patch_mongo(connected=False)
        from services.session import session_manager_config as cfg
        cfg._apply_cache_reset(None)
        cfg._cache_source = cfg.CACHE_SOURCE_DEFAULTS
        self.assertEqual(cfg.session_lifetime_seconds(), 3600)
        self.assertEqual(cfg.expiry_warning_seconds(), 900)
        self.assertEqual(cfg.tick_active_window_seconds(), 60.0)
        config = await cfg.get_config()
        self.assertEqual(config["session_lifetime_seconds"]["persisted"], False)
        self.assertEqual(
            config["session_lifetime_seconds"]["value"],
            config["session_lifetime_seconds"]["default"],
        )
        state = await cfg.state()
        self.assertEqual(state["cacheSource"], cfg.CACHE_SOURCE_DEFAULTS)

    async def test_validation_rejects_unknown_keys_and_bad_values(self):
        self._patch_mongo(connected=True)
        from services.session import session_manager_config as cfg
        with self.assertRaises(ValueError):
            await cfg.set_config({"not_a_real_key": 1})
        with self.assertRaises(ValueError):
            await cfg.set_config({"session_lifetime_seconds": "lots"})
        with self.assertRaises(ValueError):
            await cfg.set_config({"session_lifetime_seconds": True})
        with self.assertRaises(ValueError):
            await cfg.set_config({"session_lifetime_seconds": 30})
        with self.assertRaises(ValueError):
            await cfg.set_config({"session_lifetime_seconds": 120000})

    async def test_set_persists_and_applies_live(self):
        self._patch_mongo(connected=True)
        from services.session import session_manager_config as cfg
        config = await cfg.set_config(
            {"session_lifetime_seconds": 7200, "tick_active_window_seconds": 30},
            updated_by="test",
        )
        self.assertEqual(config["session_lifetime_seconds"]["value"], 7200)
        self.assertEqual(config["session_lifetime_seconds"]["persisted"], True)
        self.assertEqual(config["tick_active_window_seconds"]["value"], 30)
        # Live runtime accessors reflect the change immediately.
        self.assertEqual(cfg.session_lifetime_seconds(), 7200)
        self.assertEqual(cfg.tick_active_window_seconds(), 30)
        # Persisted in the collection.
        rows = self.db[cfg.CONFIG_COLLECTION].rows()
        self.assertEqual({r["key"]: r["value"] for r in rows},
                         {"session_lifetime_seconds": 7200,
                          "tick_active_window_seconds": 30})
        self.assertTrue(all(r["updatedBy"] == "test" for r in rows))

    async def test_reset_restores_defaults(self):
        self._patch_mongo(connected=True)
        from services.session import session_manager_config as cfg
        await cfg.set_config({"session_lifetime_seconds": 7200})
        await cfg.reset_config()
        self.assertEqual(cfg.session_lifetime_seconds(), 3600)
        config = await cfg.get_config()
        self.assertEqual(config["session_lifetime_seconds"]["persisted"], False)
        self.assertEqual(self.db[cfg.CONFIG_COLLECTION].rows(), [])

    async def test_reset_single_key(self):
        self._patch_mongo(connected=True)
        from services.session import session_manager_config as cfg
        await cfg.set_config({"session_lifetime_seconds": 7200, "expiry_warning_seconds": 300})
        await cfg.reset_config(key="session_lifetime_seconds")
        self.assertEqual(cfg.session_lifetime_seconds(), 3600)
        self.assertEqual(cfg.expiry_warning_seconds(), 300)
        config = await cfg.get_config()
        self.assertEqual(config["session_lifetime_seconds"]["persisted"], False)
        self.assertEqual(config["expiry_warning_seconds"]["persisted"], True)

    async def test_refresh_config_loads_persisted_values(self):
        self._patch_mongo(connected=True)
        from services.session import session_manager_config as cfg
        await cfg.set_config({"session_lifetime_seconds": 5400})
        # Simulate a restart: cache reset to defaults, then refresh from Mongo.
        cfg._apply_cache_reset(None)
        cfg._cache_source = cfg.CACHE_SOURCE_DEFAULTS
        self.assertEqual(cfg.session_lifetime_seconds(), 3600)
        state = await cfg.refresh_config()
        self.assertEqual(cfg.session_lifetime_seconds(), 5400)
        self.assertEqual(state["cacheSource"], cfg.CACHE_SOURCE_MONGO)
        self.assertEqual(state["effective"]["session_lifetime_seconds"], 5400)

    async def test_lifetime_knob_drives_new_session(self):
        self._patch_mongo(connected=True)
        from services.session import session_manager_config as cfg
        await cfg.set_config({"session_lifetime_seconds": 300})
        from services.session.session_manager import CentralSessionManager
        mgr = CentralSessionManager()
        snap = mgr.mark_login_success(
            mode="dummy", broker="Dummy Broker", user_id="u", session_ref="r",
        )
        self.assertTrue(snap["active"])
        self.assertEqual(snap["sessionDurationSeconds"], 300)
        self.assertAlmostEqual(snap["remainingSeconds"], 300, delta=2.0)
        # Only NEW sessions use the new lifetime: a manual override still wins.
        snap2 = mgr.mark_login_success(
            mode="dummy", broker="Dummy Broker", user_id="u",
            session_ref="r", lifetime_seconds=3600,
        )
        self.assertEqual(snap2["sessionDurationSeconds"], 3600)


if __name__ == "__main__":
    unittest.main(verbosity=2)