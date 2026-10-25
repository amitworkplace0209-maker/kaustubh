"""Storage budget guard — verifies the guard never crosses its own rules.

The guard is the last line of defence between a live trading session and a
write-blocked MongoDB cluster, so the properties that matter are: it only ever
deletes the oldest data, only from the regenerable collections, only while
over budget, and it never raises into the application.
"""
from __future__ import annotations

import asyncio
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

from services import storage_guard


class _Result:
    def __init__(self, deleted_count: int = 0) -> None:
        self.deleted_count = deleted_count


class _Cursor:
    """Async cursor over a fixed list of ids."""

    def __init__(self, ids):
        self._ids = list(ids)

    def limit(self, _n):
        return self

    def __aiter__(self):
        async def _gen():
            for _id in self._ids:
                yield {"_id": _id}

        return _gen()


class _Coll:
    def __init__(self, docs=None, error=None):
        self.docs = list(docs or [])
        self.error = error
        self.deleted: list = []

    def find(self, query, _proj=None):
        matched = [d for d in self.docs if all(d.get(k) == v for k, v in query.items())]
        return _Cursor([d["_id"] for d in matched])

    async def distinct(self, field):
        if self.error:
            raise self.error
        return list({d.get(field) for d in self.docs})

    async def delete_many(self, query):
        if self.error:
            raise self.error
        ids = set(query.get("_id", {}).get("$in", []))
        before = len(self.docs)
        self.docs = [d for d in self.docs if d["_id"] not in ids]
        self.deleted.append(set(ids))
        return _Result(before - len(self.docs))


class _DB:
    def __init__(self, collections=None, stats=None, stats_error=None):
        self.collections = collections or {}
        self._stats = stats if stats is not None else {"storageSize": 0, "indexSize": 0}
        self._stats_error = stats_error

    def __getitem__(self, name):
        return self.collections.get(name) or _Coll()

    async def command(self, _name):
        if self._stats_error:
            raise self._stats_error
        return self._stats


def _settings(**over):
    base = SimpleNamespace(
        storage_guard_enabled=True,
        storage_budget_mb=300,
        storage_guard_interval_sec=300,
        storage_capacity_mb=512,
        storage_autoclean_pct=90,
    )
    for key, value in over.items():
        setattr(base, key, value)
    return base


def _reset_auto_cooldown():
    storage_guard._last_auto_clean_mono = None
    storage_guard._last_auto_clean_at = None


def _candle_rows(days: int = 3, per_day: int = 5, collection: str = "market_candles_1m") -> list[dict]:
    rows = []
    for d in range(days):
        date = f"2026-09-{20 + d:02d}"
        for i in range(per_day):
            rows.append({"_id": f"{date}:{i}:1m", "date": date, "instrumentToken": "1"})
    return rows


def _patch_db(db):
    return mock.patch.dict(sys.modules, {"database.connection": SimpleNamespace(get_db=lambda: db)})


def _usage_until_trimmed(coll, over_mb: int = 400, after_mb: int = 100):
    """Fake dbStats: stays over budget until `coll` has actually been trimmed.

    The guard re-checks usage at the top of every trim pass, so a fixed value
    list would let it exit before doing any work. Deriving usage from whether
    a delete happened models a real cluster that shrinks as data is removed.
    """
    def _used(_db=None):
        return (after_mb if coll.deleted else over_mb) * 1048576
    return _used


class StorageGuardStatusTests(unittest.IsolatedAsyncioTestCase):
    async def test_status_reports_real_usage_without_deleting(self):
        coll = _Coll(_candle_rows())
        db = _DB({"market_candles_1m": coll}, stats={"storageSize": 10 * 1048576, "indexSize": 1048576})
        with mock.patch.object(storage_guard, "_storage_bytes", return_value=11 * 1048576), \
                mock.patch("config.settings.settings", _settings()), _patch_db(db):
            status = await storage_guard.storage_guard_status()
        self.assertTrue(status["ok"])
        self.assertEqual(status["usedMb"], 11.0)
        self.assertFalse(status["overBudget"])
        self.assertEqual(coll.docs, _candle_rows())

    async def test_status_flags_over_budget(self):
        db = _DB(stats={"storageSize": 400 * 1048576, "indexSize": 0})
        with mock.patch("config.settings.settings", _settings()), _patch_db(db):
            status = await storage_guard.storage_guard_status()
        self.assertTrue(status["overBudget"])
        self.assertEqual(status["reason"], "over_budget")

    async def test_status_never_raises_when_dbstats_fails(self):
        db = _DB(stats_error=RuntimeError("not authorised"))
        with mock.patch("config.settings.settings", _settings()), _patch_db(db):
            status = await storage_guard.storage_guard_status()
        self.assertFalse(status["ok"])
        self.assertEqual(status["reason"], "storage_unknown")


class StorageGuardRunTests(unittest.IsolatedAsyncioTestCase):
    async def test_within_budget_deletes_nothing(self):
        coll = _Coll(_candle_rows())
        db = _DB({"market_candles_1m": coll})
        with mock.patch("config.settings.settings", _settings()), _patch_db(db), \
                mock.patch.object(storage_guard, "_storage_bytes", return_value=100 * 1048576):
            report = await storage_guard.run_storage_guard(trigger="test")
        self.assertTrue(report["reason"] if "reason" in report else True)
        self.assertEqual(report.get("deleted"), {})
        self.assertEqual(len(coll.docs), 15)

    async def test_over_budget_deletes_oldest_day_first(self):
        rows = _candle_rows()
        coll = _Coll(rows)
        db = _DB({"market_candles_1m": coll})
        # Over budget until the oldest day is actually gone.
        with mock.patch("config.settings.settings", _settings()), _patch_db(db), \
                mock.patch.object(storage_guard, "_storage_bytes", side_effect=_usage_until_trimmed(coll)):
            report = await storage_guard.run_storage_guard(trigger="test")
        self.assertEqual(report["deleted"].get("market_candles_1m"), 5)
        remaining = {d["date"] for d in coll.docs}
        self.assertNotIn("2026-09-20", remaining)

    async def test_only_prunable_collections_are_touched(self):
        rows = _candle_rows()
        candles = _Coll(rows)
        decisions = _Coll([{"_id": "d1", "date": "2026-09-20"}])
        db = _DB({"market_candles_1m": candles, "market_watch_decisions": decisions})
        with mock.patch("config.settings.settings", _settings()), _patch_db(db), \
                mock.patch.object(storage_guard, "_storage_bytes", side_effect=_usage_until_trimmed(candles)):
            await storage_guard.run_storage_guard(trigger="test")
        self.assertEqual(len(candles.docs), 10)
        self.assertEqual(len(decisions.docs), 1, "non-regenerable collection must survive")

    async def test_disabled_guard_is_a_noop(self):
        coll = _Coll(_candle_rows())
        db = _DB({"market_candles_1m": coll})
        with mock.patch("config.settings.settings", _settings(storage_guard_enabled=False)), _patch_db(db):
            report = await storage_guard.run_storage_guard(trigger="test")
        self.assertEqual(report["reason"], "disabled")
        self.assertEqual(len(coll.docs), 15)

    async def test_missing_database_is_reported_not_raised(self):
        with mock.patch("config.settings.settings", _settings()), _patch_db(None):
            report = await storage_guard.run_storage_guard(trigger="test")
        self.assertEqual(report["reason"], "no_database")

    async def test_delete_failure_is_bounded_and_non_fatal(self):
        coll = _Coll(_candle_rows(), error=RuntimeError("write blocked"))
        db = _DB({"market_candles_1m": coll})
        with mock.patch("config.settings.settings", _settings()), _patch_db(db), \
                mock.patch.object(storage_guard, "_storage_bytes", return_value=400 * 1048576):
            report = await storage_guard.run_storage_guard(trigger="test")
        self.assertEqual(report["deleted"], {})
        self.assertEqual(report["reason"], "nothing_left_to_trim")


class StorageGuardAutoCleanupTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        _reset_auto_cooldown()

    async def asyncTearDown(self):
        _reset_auto_cooldown()

    async def test_at_threshold_auto_runs_safe_cleanup(self):
        # 90% of 512 MB = 460.8 MB -> auto cleanup must fire, nothing trimmed.
        candles = _Coll(_candle_rows())
        db = _DB({"market_candles_1m": candles})
        fake_clean = mock.AsyncMock(return_value={"ok": True, "status": "SUCCESS", "totalDeleted": 120})
        fake_module = SimpleNamespace(run_cleanup=fake_clean)
        with mock.patch("config.settings.settings", _settings()), _patch_db(db), \
                mock.patch.object(storage_guard, "_storage_bytes", return_value=int(0.92 * 512 * 1048576)), \
                mock.patch.dict(sys.modules, {"services.atlas_cleanup": fake_module}):
            # ensure the lazy `from services import atlas_cleanup` resolves
            import services as _services_pkg
            with mock.patch.object(_services_pkg, "atlas_cleanup", fake_module, create=True):
                report = await storage_guard.run_storage_guard(trigger="test")
        fake_clean.assert_awaited_once()
        kwargs = fake_clean.await_args.kwargs
        self.assertEqual(kwargs.get("trigger"), "auto-storage-pct")
        self.assertEqual(report["reason"], "auto_cleanup")
        self.assertEqual(len(candles.docs), 15, "auto path wipes via cleanup pass, not trim")

    async def test_below_threshold_no_auto_cleanup(self):
        db = _DB()
        fake_clean = mock.AsyncMock()
        fake_module = SimpleNamespace(run_cleanup=fake_clean)
        import services as _services_pkg
        with mock.patch("config.settings.settings", _settings()), _patch_db(db), \
                mock.patch.object(storage_guard, "_storage_bytes", return_value=100 * 1048576), \
                mock.patch.object(_services_pkg, "atlas_cleanup", fake_module, create=True):
            report = await storage_guard.run_storage_guard(trigger="test")
        fake_clean.assert_not_awaited()
        self.assertEqual(report["reason"], "within_budget")

    async def test_auto_cleanup_cooldown_blocks_repeat(self):
        db = _DB()
        fake_clean = mock.AsyncMock(return_value={"ok": True, "status": "SUCCESS", "totalDeleted": 5})
        fake_module = SimpleNamespace(run_cleanup=fake_clean)
        import services as _services_pkg
        with mock.patch("config.settings.settings", _settings()), _patch_db(db), \
                mock.patch.object(storage_guard, "_storage_bytes", return_value=int(0.95 * 512 * 1048576)), \
                mock.patch.object(_services_pkg, "atlas_cleanup", fake_module, create=True):
            first = await storage_guard.run_storage_guard(trigger="test")
            second = await storage_guard.run_storage_guard(trigger="test")
        self.assertEqual(first["reason"], "auto_cleanup")
        self.assertEqual(second["reason"], "auto_cooldown")
        fake_clean.assert_awaited_once()

    async def test_status_reports_pct_and_threshold(self):
        db = _DB()
        with mock.patch("config.settings.settings", _settings()), _patch_db(db), \
                mock.patch.object(storage_guard, "_storage_bytes", return_value=int(0.5 * 512 * 1048576)):
            status = await storage_guard.storage_guard_status()
        self.assertEqual(status["usagePct"], 50.0)
        self.assertEqual(status["capacityMb"], 512)
        self.assertEqual(status["thresholdPct"], 90)
        self.assertTrue(status["autoArmed"])
        self.assertFalse(status["overThreshold"])


class StorageGuardLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_start_is_idempotent_and_stop_cancels(self):
        async def slow():
            await asyncio.sleep(3600)

        with mock.patch("config.settings.settings", _settings(storage_guard_interval_sec=30)):
            first = storage_guard.start_storage_guard()
            second = storage_guard.start_storage_guard()
            self.assertIs(first, second)
            self.assertIsNotNone(first)
            await storage_guard.stop_storage_guard()
            self.assertTrue(first.done() or first.cancelled() or first._cancelled)
            # A second stop must not raise.
            await storage_guard.stop_storage_guard()


if __name__ == "__main__":
    unittest.main()
