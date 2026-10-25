"""Unit tests for the manual Market Watch pins service (services/market_watch_pins).

Covers trading-day scoping (a pin only applies on the day it was created),
idempotent add, the MAX_MANUAL_PINS cap, remove/clear and the "no fabricated
metadata" rule (add_pin only records caller-provided registry data).

Run:  python -m pytest tests/test_market_watch_pins.py -q
"""
from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from services import market_watch_pins as pins  # noqa: E402


class FakeCollection:
    def __init__(self):
        self._docs: list[dict] = []
        self._seq = 0

    def _matches(self, doc: dict, query: dict) -> bool:
        return all(doc.get(k) == v for k, v in query.items())

    def find(self, query: dict | None = None):
        q = query or {}
        return _Cursor(self, [d for d in self._docs if self._matches(d, q)])

    async def find_one(self, query: dict | None = None, projection: dict | None = None):
        q = query or {}
        for d in self._docs:
            if self._matches(d, q):
                doc = dict(d)
                if projection:
                    doc = {k: doc[k] for k in projection if k != "_id" and k in doc}
                return doc
        return None

    async def count_documents(self, query: dict | None = None):
        q = query or {}
        return sum(1 for d in self._docs if self._matches(d, q))

    async def insert_one(self, doc: dict):
        self._seq += 1
        clone = dict(doc)
        clone["_id"] = self._seq
        self._docs.append(clone)
        return type("Res", (), {"inserted_id": self._seq})()

    async def delete_many(self, query: dict | None = None):
        q = query or {}
        before = len(self._docs)
        self._docs = [d for d in self._docs if not self._matches(d, q)]
        return type("Res", (), {"deleted_count": before - len(self._docs)})()


class _Cursor:
    def __init__(self, coll: FakeCollection, rows: list[dict]):
        self._rows = rows

    def sort(self, key: str, direction: int = 1):
        self._rows = list(sorted(self._rows, key=lambda d: d.get(key) is not None, reverse=False))
        self._rows = list(sorted(
            self._rows, key=lambda d: str(d.get(key)) or ""
        )) if direction == 1 else list(sorted(self._rows, key=lambda d: str(d.get(key)) or "", reverse=True))
        return self

    async def to_list(self, length: int | None = None):
        return [dict(d) for d in self._rows[:length]]


class FakeDB:
    def __init__(self):
        self._collections: dict[str, FakeCollection] = {}
        self._collections[pins.COLLECTION] = FakeCollection()

    def __getitem__(self, name: str) -> FakeCollection:
        if name not in self._collections:
            self._collections[name] = FakeCollection()
        return self._collections[name]


def _cal(day: str = "2026-09-21"):
    return {"market_status": "OPEN", "market_date": day, "tradeDay": True}


class PinsServiceTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.db = FakeDB()
        self.patches = [
            mock.patch.object(pins, "get_db", return_value=self.db),
            mock.patch.object(pins, "market_calendar_snapshot", side_effect=lambda: self._cal_snap),
        ]
        self._cal_snap = _cal()
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)

    async def test_add_and_list(self):
        res = await pins.add_pin("1", symbol="RELIANCE", name="Reliance Inds")
        self.assertTrue(res["ok"])
        listed = await pins.list_pins()
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["token"], "1")
        self.assertEqual(listed[0]["symbol"], "RELIANCE")
        self.assertEqual(listed[0]["tradingDate"], "2026-09-21")

    async def test_add_idempotent_per_token(self):
        await pins.add_pin("1", symbol="RELIANCE")
        res2 = await pins.add_pin("1", symbol="OTHER")
        self.assertTrue(res2["ok"])
        self.assertTrue(res2["alreadyPinned"])
        self.assertNotEqual(res2["pin"]["symbol"], "OTHER")
        self.assertEqual(len(await pins.list_pins()), 1)

    async def test_pin_limit_reached(self):
        for i in range(pins.MAX_MANUAL_PINS):
            await pins.add_pin(str(i), symbol=f"S{i}")
        res = await pins.add_pin("999", symbol="REJECTED")
        self.assertFalse(res["ok"])
        self.assertEqual(res["reason"], "pin_limit_reached")
        self.assertEqual(len(await pins.list_pins()), pins.MAX_MANUAL_PINS)

    async def test_missing_token(self):
        res = await pins.add_pin("  ")
        self.assertFalse(res["ok"])
        self.assertEqual(res["reason"], "missing_token")

    async def test_no_trading_date(self):
        self._cal_snap = {"market_status": "OPEN", "market_date": "", "tradeDay": True}
        res = await pins.add_pin("1", symbol="RELIANCE")
        self.assertFalse(res["ok"])
        self.assertEqual(res["reason"], "no_trading_date")

    async def test_remove_pin(self):
        await pins.add_pin("1", symbol="RELIANCE")
        res = await pins.remove_pin("1")
        self.assertTrue(res["ok"])
        self.assertEqual(res["removed"], 1)
        self.assertEqual(await pins.list_pins(), [])

    async def test_clear_pins(self):
        await pins.add_pin("1", symbol="A")
        await pins.add_pin("2", symbol="B")
        res = await pins.clear_pins()
        self.assertTrue(res["ok"])
        self.assertEqual(res["removed"], 2)
        self.assertEqual(await pins.list_pins(), [])

    async def test_is_pinned(self):
        self.assertFalse(await pins.is_pinned("1"))
        await pins.add_pin("1", symbol="A")
        self.assertTrue(await pins.is_pinned("1"))
        self.assertFalse(await pins.is_pinned("2"))

    async def test_day_scoping(self):
        await pins.add_pin("1", symbol="A")
        # Next trading day: yesterday's pins must not leak into today.
        self._cal_snap = _cal("2026-09-22")
        self.assertEqual(await pins.list_pins(), [])
        self.assertFalse(await pins.is_pinned("1"))
        # Adding today works after the rollover.
        res = await pins.add_pin("2", symbol="B")
        self.assertTrue(res["ok"])
        listed = await pins.list_pins()
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["token"], "2")

    async def test_no_fabricated_metadata(self):
        res = await pins.add_pin("7")
        self.assertTrue(res["ok"])
        pin = res["pin"]
        self.assertEqual(pin["symbol"], "")
        self.assertEqual(pin["exchange"], "nse_cm")
        self.assertEqual(pin["segment"], "EQUITY")

    async def test_db_error_handled(self):
        class BoomDB(FakeDB):
            def __getitem__(self, name):
                raise RuntimeError("db down")

        with mock.patch.object(pins, "get_db", return_value=BoomDB()):
            self.assertEqual(await pins.list_pins(), [])
            res = await pins.add_pin("1", symbol="A")
            self.assertFalse(res["ok"])
            self.assertEqual(res["reason"], "persist_failed")
            self.assertFalse(await pins.is_pinned("1"))


if __name__ == "__main__":
    unittest.main()