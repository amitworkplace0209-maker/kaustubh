"""Records-mode duplicate cleanup must report what was ACTUALLY deleted.

The 'group' and 'all' modes already used the count returned by
``DBWriterEngine.delete_duplicate_ticks``. 'records' used ``len(ids)`` — the
number of ids the operator ASKED for — so supplying 5 ids where only 3 existed
reported "removed 5". That makes a successful cleanup look broken and hides
real failures, so the count has to come from the DB Writer.
"""

from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bson import ObjectId  # noqa: E402
from api import quality  # noqa: E402


class _FakeCollection:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def find(self, *a, **kw):  # pragma: no cover - not used in records mode
        raise AssertionError("records mode must not scan the collection")

    def delete_many(self, *a, **kw):  # pragma: no cover - bypass guard
        raise AssertionError("quality must not delete ticks directly")


class DuplicateDeleteCountTest(unittest.IsolatedAsyncioTestCase):
    async def test_records_mode_reports_the_actual_deletion_count(self):
        wanted = [str(ObjectId()) for _ in range(5)]
        db = mock.MagicMock()
        db.ticks = _FakeCollection()

        async def _delete(ids):
            # Only 3 of the 5 supplied ids actually existed and were duplicates.
            return 3

        with mock.patch.object(quality, "get_db", return_value=db), mock.patch.object(
            quality.db_writer_engine, "delete_duplicate_ticks", side_effect=_delete
        ) as deleter, mock.patch.object(
            quality, "record_event", return_value={"event_id": "EV1", "ts": None}
        ), mock.patch("services.event_bus.publish_event", new=mock.AsyncMock()):
            result = await quality.quality_duplicates_delete(
                quality.DuplicatesDeleteRequest(mode="records", records=wanted)
            )

        self.assertEqual(deleter.await_count, 1)
        self.assertEqual(result["deleted"], 3)
        self.assertEqual(result["groupsHandled"], 1)
        self.assertEqual(result["auditEventId"], "EV1")
        self.assertNotEqual(result["deleted"], 5)

    async def test_records_mode_rejects_an_empty_id_list(self):
        db = mock.MagicMock()
        db.ticks = _FakeCollection()
        with mock.patch.object(quality, "get_db", return_value=db):
            with self.assertRaises(Exception):
                await quality.quality_duplicates_delete(
                    quality.DuplicatesDeleteRequest(mode="records", records=[])
                )

    async def test_records_mode_rejects_a_malformed_id(self):
        db = mock.MagicMock()
        db.ticks = _FakeCollection()
        with mock.patch.object(quality, "get_db", return_value=db):
            with self.assertRaises(Exception):
                await quality.quality_duplicates_delete(
                    quality.DuplicatesDeleteRequest(mode="records", records=["not-an-objectid"])
                )


if __name__ == "__main__":
    unittest.main()
