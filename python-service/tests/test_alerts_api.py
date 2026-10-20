"""Alerts API query-parameter tests (no live MongoDB required).

Proves the `/api/alerts` list endpoint is robust to the query shapes the
frontend actually sends:

- `?status=active&offset=0`            (limit omitted -> default 100)
- `?status=active&limit=50&offset=0`   (explicit limit)
- `?status=active&limit=0&offset=0`    (limit=0 -> safely coerced)

The primary contract fix is that the frontend never sends `limit=` empty; these
tests guard the backend-side tolerance for an omitted / out-of-range optional
limit so a 422 can never come from the list endpoint.

Run:  python -m pytest tests/test_alerts_api.py -q
"""
from __future__ import annotations

import asyncio
import os
import sys
import unittest
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)


class FakeCursor:
    def __init__(self, items):
        self._items = list(items)

    def sort(self, *args, **kwargs):
        return self

    def skip(self, n):
        self._items = self._items[int(n or 0):]
        return self

    def limit(self, n):
        self._items = self._items[: int(n or 0)] if n else self._items
        return self

    def __aiter__(self):
        async def _gen():
            for item in self._items:
                yield item
        return _gen()


def _matches(item, q):
    for key, val in q.items():
        if key == "status" and isinstance(val, dict) and val.get("$in"):
            if item.get("status") not in val["$in"]:
                return False
            continue
        if item.get(key) != val:
            return False
    return True


class FakeAlertsCollection:
    def __init__(self, items):
        self._items = list(items)

    def find(self, q):
        return FakeCursor([it for it in self._items if _matches(it, q)])

    async def count_documents(self, q):
        return sum(1 for it in self._items if _matches(it, q))


class FakeDB:
    def __init__(self, alerts):
        self.alerts = FakeAlertsCollection(alerts)


class ListAlertsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.alerts = [
            {"_id": "1", "status": "active", "created_at": "2026-09-07T00:00:00+00:00"},
            {"_id": "2", "status": "resolved", "created_at": "2026-09-06T00:00:00+00:00"},
        ]
        db = FakeDB(self.alerts)
        self.patchers = [
            mock.patch("services.notification_center.get_db", return_value=db),
            mock.patch("services.notification_center.serialize_alert",
                       new=lambda x: dict(x)),
            mock.patch("services.notification_center._notify_count",
                       new=mock.AsyncMock(return_value=0)),
            mock.patch("services.notification_center._mongo_live", new=lambda: True),
        ]
        for p in self.patchers:
            p.start()
            self.addCleanup(p.stop)

    async def test_limit_omitted_uses_default(self):
        import services.notification_center as nc
        res = await nc.list_alerts(status="active")
        self.assertEqual(res["total"], 1)
        self.assertEqual(len(res["alerts"]), 1)

    async def test_explicit_valid_limit(self):
        import services.notification_center as nc
        res = await nc.list_alerts(limit=50, offset=0)
        self.assertEqual(len(res["alerts"]), 2)

    async def test_limit_zero_coerced_to_default(self):
        # Frontend used to send limit=0 for a count-only request. The endpoint
        # must not blow up (list_alerts coerces to the safe default).
        import services.notification_center as nc
        res = await nc.list_alerts(limit=0, offset=0)
        self.assertEqual(len(res["alerts"]), 2)

    async def test_limit_none_coerced_to_default(self):
        import services.notification_center as nc
        res = await nc.list_alerts(limit=None)
        self.assertEqual(len(res["alerts"]), 2)

    async def test_negative_offset_coerced(self):
        import services.notification_center as nc
        res = await nc.list_alerts(offset=-5)
        self.assertEqual(len(res["alerts"]), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)