"""Scheduler summary + timezone-normalisation tests (no live MongoDB required).

Covers the Phase 22/53 canonical summary contract and the scheduled_at
UTC/IST round-trip bug:

- summary() normalises legacy statuses onto the canonical vocabulary
- summary() "today" block counts are real persisted values
- last_event reflects the most recent actual execution (never a fake timestamp)
- to_ist() treats naive (UTC-stored) datetimes as UTC and converts to IST, so
  comparisons survive the Motor naive-UTC round-trip
- executions() rows expose scheduled_at / actual_at in IST
"""
from __future__ import annotations

import asyncio
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

IST = timezone(timedelta(hours=5, minutes=30))


def _naive_utc(dt):
    """Simulate what Motor returns for an aware IST datetime stored naive-UTC."""
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


class DuplicateKey(Exception):
    pass


class FakeAgg:
    def __init__(self, items):
        self._items = items

    def __aiter__(self):
        async def _gen():
            if hasattr(self._items, "__anext__"):
                async for item in self._items:
                    yield item
            else:
                for item in (list(self._items) if not isinstance(self._items, list) else self._items):
                    yield item
        return _gen()

    def sort(self, *args, **kwargs):
        return self

    def limit(self, n):
        orig = self._items
        async def _limited():
            count = 0
            async for item in FakeAgg(orig):
                if count >= n:
                    break
                yield item
                count += 1
        self._items = _limited()
        return self


def _matches(item, q):
    if "$and" in q:
        return all(_matches(item, sub) for sub in q["$and"])
    for key, val in q.items():
        if key == "status" and isinstance(val, dict) and val.get("$in"):
            if item.get("status") not in val["$in"]:
                return False
            continue
        if key == "status" and isinstance(val, dict) and val.get("$nin"):
            if item.get("status") in val["$nin"]:
                return False
            continue
        if item.get(key) != val:
            return False
    return True


class FakeRuns:
    def __init__(self):
        self._items: list[dict] = []
        self._seq = 0

    async def create_index(self, *args, **kwargs):
        pass

    async def _find_all(self, q, projection=None):
        rows = [dict(it) for it in self._items if _matches(it, q)]
        if projection and projection.get("_id") == 0:
            for r in rows:
                r.pop("_id", None)
        return rows

    async def insert_one(self, doc):
        row = dict(doc)
        self._seq += 1
        row["_id"] = str(self._seq)
        self._items.append(row)
        return row

    async def find_one(self, q, projection=None, sort=None):
        rows = await self._find_all(q, projection)
        if not rows:
            return None
        if sort:
            key = sort[0][0]
            desc = sort[0][1] == -1
            rows.sort(key=lambda r: self._sortval(r.get(key)), reverse=desc)
        return rows[0]

    @staticmethod
    def _sortval(v):
        if v is None:
            return ""
        return v.isoformat() if isinstance(v, datetime) else str(v)

    async def update_one(self, filt, update):
        return mock.Mock(modified_count=1)

    def find(self, q, projection=None):
        return FakeAgg(self._loop(q, projection))

    def _loop(self, q, projection):
        async def _gen():
            for item in await self._find_all(q, projection):
                yield item
        return _gen()

    def aggregate(self, pipeline):
        match = pipeline[0].get("$match", {})
        rows = [r for r in self._items if _matches(r, match)]
        counts: dict[str, int] = {}
        for r in rows:
            counts[r.get("status") or "UNKNOWN"] = counts.get(r.get("status") or "UNKNOWN", 0) + 1
        return FakeAgg({"_id": k, "n": v} for k, v in counts.items())


class FakeDB:
    def __init__(self):
        self.scheduler_runs = FakeRuns()


class SummaryTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.db = FakeDB()
        self.patchers = [mock.patch("scheduler.persist.get_db", return_value=self.db)]
        for p in self.patchers:
            p.start()
            self.addCleanup(p.stop)
        from scheduler.persist import SchedulerLedger
        self.ledger = SchedulerLedger()

    def _add_run(self, *, job_id, status, business_date="2026-09-08",
                 scheduled, completed=None, started=None, trigger="scheduled",
                 execution_id=None, schedule_id="session_login"):
        scheduled_utc = _naive_utc(scheduled)
        completed_utc = _naive_utc(completed) if completed else None
        started_utc = _naive_utc(started) if started else None
        doc = {
            "execution_id": execution_id or f"{job_id}:{business_date}:{scheduled.isoformat()}",
            "occurrence_id": f"occ:{job_id}:{business_date}:{scheduled.isoformat()}",
            "schedule_id": schedule_id,
            "job_id": job_id,
            "job_type": "LOGIN_CHECK",
            "business_date": business_date,
            "scheduled_at": scheduled_utc,
            "timezone": "Asia/Kolkata",
            "status": status,
            "trigger": trigger,
            "started_at": started_utc,
            "completed_at": completed_utc,
            "failed_at": None,
            "attempt_count": 1,
            "last_error": None,
            "reason": "reason",
            "reason_code": "RC",
            "created_at": scheduled_utc,
            "updated_at": (completed_utc or started_utc or scheduled_utc),
            "owner_pid": 1,
        }
        self.db.scheduler_runs._items.append(doc)
        return doc

    # ------------------------------------------------------------------
    async def test_summary_today_counts_normalise_legacy_statuses(self):
        now = datetime(2026, 9, 8, 10, 0, 0, tzinfo=IST)
        self._add_run(job_id="login", status="COMPLETED",
                      scheduled=datetime(2026, 9, 8, 9, 0, tzinfo=IST),
                      started=datetime(2026, 9, 8, 9, 0, 4, tzinfo=IST),
                      completed=datetime(2026, 9, 8, 9, 0, 6, tzinfo=IST))
        self._add_run(job_id="ws_start", status="MISSED_WAITING_NETWORK",
                      scheduled=datetime(2026, 9, 8, 9, 13, tzinfo=IST))
        self._add_run(job_id="ws_stop", status="SKIPPED",
                      scheduled=datetime(2026, 9, 8, 15, 31, tzinfo=IST))
        self._add_run(job_id="logout", status="ALREADY_SATISFIED",
                      scheduled=datetime(2026, 9, 8, 15, 35, tzinfo=IST))
        summary = await self.ledger.summary(business_date="2026-09-08")
        today = summary["today"]
        self.assertEqual(today["total"], 4)
        self.assertEqual(today["completed"], 1)
        self.assertEqual(today["waiting"], 1)          # WAITING_NETWORK
        self.assertEqual(today["missed_expired"], 1)   # SKIPPED -> MISSED_EXPIRED
        self.assertEqual(today["already_satisfied"], 1)

    async def test_summary_last_event_uses_real_execution(self):
        now = datetime(2026, 9, 8, 10, 0, 0, tzinfo=IST)
        self._add_run(job_id="login", status="COMPLETED",
                      scheduled=datetime(2026, 9, 8, 9, 0, tzinfo=IST),
                      started=datetime(2026, 9, 8, 9, 0, 4, tzinfo=IST),
                      completed=datetime(2026, 9, 8, 9, 0, 6, tzinfo=IST))
        s = await self.ledger.summary(business_date="2026-09-08")
        le = s["last_event"]
        self.assertEqual(le["job_id"], "login")
        self.assertEqual(le["status"], "COMPLETED")
        self.assertEqual(le["actual_at"], "2026-09-08T09:00:06+05:30")
        self.assertEqual(le["scheduled_at"], "2026-09-08T09:00:00+05:30")

    async def test_summary_last_event_excludes_pure_pending(self):
        # A logout registered as PENDING (future occurrence) that never ran is
        # NOT an event. A MISSED_EXPIRED decision from reconciliation IS.
        self._add_run(job_id="logout", status="PENDING",
                      scheduled=datetime(2026, 9, 8, 15, 35, tzinfo=IST))
        self._add_run(job_id="ws_start", status="MISSED_EXPIRED",
                      scheduled=datetime(2026, 9, 8, 9, 13, tzinfo=IST),
                      started=None, trigger="MISSED_SCHEDULE_CATCHUP",
                      execution_id="e-ws")
        s = await self.ledger.summary(business_date="2026-09-08")
        le = s["last_event"]
        self.assertEqual(le["job_id"], "ws_start")
        self.assertEqual(le["status"], "MISSED_EXPIRED")

    async def test_summary_no_events_returns_none(self):
        s = await self.ledger.summary(business_date="2026-09-08")
        self.assertIsNone(s["last_event"])
        self.assertEqual(s["today"]["total"], 0)

    async def test_to_ist_naive_utc_round_trip(self):
        from scheduler.persist import to_ist
        sched_ist = datetime(2026, 9, 8, 9, 0, 0, tzinfo=IST)
        naive_stored = _naive_utc(sched_ist)  # what Motor returns
        self.assertEqual(naive_stored.tzinfo, None)
        norm = to_ist(naive_stored)
        self.assertEqual(norm, sched_ist)
        # epoch comparison must be identical to the true instant
        self.assertEqual(naive_stored.replace(tzinfo=timezone.utc).timestamp(),
                         sched_ist.timestamp())

    async def test_executions_rows_expose_ist_times(self):
        self._add_run(job_id="login", status="CATCH_UP",
                      scheduled=datetime(2026, 9, 8, 9, 0, tzinfo=IST),
                      started=datetime(2026, 9, 8, 9, 0, 4, tzinfo=IST),
                      trigger="MISSED_SCHEDULE_CATCHUP", execution_id="e1")
        rows = await self.ledger.executions(business_date="2026-09-08")
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual(r["status"], "CATCH_UP")
        self.assertEqual(r["scheduled_at"], "2026-09-08T09:00:00+05:30")
        self.assertEqual(r["actual_at"], "2026-09-08T09:00:04+05:30")
        self.assertEqual(r["trigger"], "MISSED_SCHEDULE_CATCHUP")
        self.assertEqual(r["schedule_id"], "session_login")


if __name__ == "__main__":
    unittest.main(verbosity=2)