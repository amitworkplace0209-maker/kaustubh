"""Scheduler-run ledger query + API tests (no live MongoDB required).

Covers the paginated/filterable run surface used by the SERVICES -> Scheduler
-> Runs page:

- normalize_run: canonical statuses, duration_ms, legacy alias handling,
  catch-up flag, IST ISO timestamps, real next_retry:null semantics
- list_runs filters: business_date / job_id / schedule_id / trigger
- status bucket expansion (PENDING/RUNNING/WAITING/MISSED_SCHEDULE_CATCHUP)
- failed_only + catch_up_only semantic filters
- free-text search over the real run fields
- server-side pagination (page/page_size/total/pages)
- ascending/descending sort on the requested field
- run detail lookup by execution_id (+ 404-style None)

Run:  python -m pytest tests/test_scheduler_runs_api.py -q
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
    """Storage convention: aware IST is persisted through Motor as naive UTC."""
    return (dt.astimezone(timezone.utc) if dt.tzinfo else dt).replace(tzinfo=None)


def _matches(item, q):
    for key, val in q.items():
        if key == "status" and isinstance(val, dict) and val.get("$in"):
            if item.get("status") not in val["$in"]:
                return False
            continue
        if item.get(key) != val:
            return False
    return True


class FakeRuns:
    def __init__(self):
        self._items: list[dict] = []

    async def _find_all(self, q, projection=None):
        rows = [dict(it) for it in self._items if _matches(it, q)]
        if projection and projection.get("_id") == 0:
            for r in rows:
                r.pop("_id", None)
        return rows

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

    def find(self, q, projection=None):
        async def _gen():
            for item in await self._find_all(q, projection):
                yield item
        return _gen()


class FakeDB:
    def __init__(self):
        self.scheduler_runs = FakeRuns()


class RunsQueryTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.db = FakeDB()
        self.patchers = [mock.patch("scheduler.persist.get_db", return_value=self.db)]
        for p in self.patchers:
            p.start()
            self.addCleanup(p.stop)
        from scheduler.persist import SchedulerLedger
        self.ledger = SchedulerLedger()

    # ------------------------------------------------------------------
    def _add(self, *, job_id="login", status="COMPLETED", business_date="2026-09-08",
             scheduled=None, started=None, completed=None, failed=None,
             trigger="scheduled", attempt=1, reason="reason", reason_code="RC",
             error=None, schedule_id="session_login", created=None, updated=None):
        if scheduled is None:
            scheduled = datetime(2026, 9, 8, 9, 0, 0, tzinfo=IST)
        scheduled_u = _naive_utc(scheduled)
        started_u = _naive_utc(started) if started else None
        completed_u = _naive_utc(completed) if completed else None
        failed_u = _naive_utc(failed) if failed else None
        doc = {
            "execution_id": f"{job_id}:{business_date}:{scheduled.isoformat()}",
            "occurrence_id": f"occ:{job_id}:{business_date}:{scheduled.isoformat()}",
            "schedule_id": schedule_id,
            "job_id": job_id,
            "job_type": "JOB",
            "business_date": business_date,
            "scheduled_at": scheduled_u,
            "timezone": "Asia/Kolkata",
            "status": status,
            "trigger": trigger,
            "started_at": started_u,
            "completed_at": completed_u,
            "failed_at": failed_u,
            "attempt_count": attempt,
            "last_error": error,
            "reason": reason,
            "reason_code": reason_code,
            "created_at": _naive_utc(created) if created else scheduled_u,
            "updated_at": _naive_utc(updated) if updated else (completed_u or started_u or scheduled_u),
            "owner_pid": 1,
        }
        self.db.scheduler_runs._items.append(doc)
        return doc

    def _seed(self):
        self._add(job_id="login", status="COMPLETED",
                  scheduled=datetime(2026, 9, 8, 9, 0, tzinfo=IST),
                  started=datetime(2026, 9, 8, 9, 0, 4, tzinfo=IST),
                  completed=datetime(2026, 9, 8, 9, 0, 6, tzinfo=IST),
                  trigger="scheduled", schedule_id="session_login")
        self._add(job_id="ws_start", status="COMPLETED",
                  scheduled=datetime(2026, 9, 8, 9, 5, tzinfo=IST),
                  started=datetime(2026, 9, 8, 9, 5, 1, tzinfo=IST),
                  completed=datetime(2026, 9, 8, 9, 5, 3, tzinfo=IST),
                  trigger="MISSED_SCHEDULE_CATCHUP", schedule_id="session_ws_start")
        self._add(job_id="tick_collection", status="CATCHING_UP",
                  scheduled=datetime(2026, 9, 8, 9, 10, tzinfo=IST),
                  started=datetime(2026, 9, 8, 9, 10, 0, tzinfo=IST),
                  trigger="MISSED_SCHEDULE_CATCHUP", schedule_id="session_tick_collection")
        self._add(job_id="ws_stop", status="MISSED_WAITING_NETWORK",
                  scheduled=datetime(2026, 9, 8, 15, 31, tzinfo=IST),
                  reason="Network unavailable", reason_code="NETWORK_OFFLINE",
                  schedule_id="session_ws_stop")
        self._add(job_id="logout", status="SKIPPED",
                  scheduled=datetime(2026, 9, 8, 15, 35, tzinfo=IST),
                  reason="Not a trading day", reason_code="NOT_TRADING_DAY",
                  schedule_id="session_logout")
        self._add(job_id="square_off", status="FAILED",
                  scheduled=datetime(2026, 9, 8, 15, 16, tzinfo=IST),
                  failed=datetime(2026, 9, 8, 15, 16, 2, tzinfo=IST),
                  reason="Order placement failed", reason_code="ORDER_FAILED",
                  error="req rejected", schedule_id="session_square_off")
        self._add(job_id="login", status="PENDING",
                  scheduled=datetime(2026, 9, 9, 9, 0, tzinfo=IST),
                  business_date="2026-09-09", schedule_id="session_login")

    # ------------------------------------------------------------------
    async def test_normalize_run_canonical_and_duration(self):
        self._seed()
        res = await self.ledger.list_runs(job_id="login")
        by = {r["job_id"]: r for r in res["runs"]}
        comp = by["login"]
        self.assertEqual(comp["status"], "COMPLETED")
        self.assertEqual(comp["duration_ms"], 2000)
        self.assertEqual(comp["attempt"], 1)
        self.assertEqual(comp["scheduled_at"], "2026-09-08T09:00:00+05:30")
        self.assertEqual(comp["actual_start"], "2026-09-08T09:00:04+05:30")
        self.assertEqual(comp["actual_completion"], "2026-09-08T09:00:06+05:30")
        self.assertEqual(comp["catch_up"], False)
        self.assertIsNone(comp["next_retry"])
        self.assertIsNone(comp["error"])

    async def test_normalize_run_legacy_aliases_and_catch_up(self):
        self._seed()
        res = await self.ledger.list_runs()
        by = {r["job_id"]: r for r in res["runs"]}
        self.assertEqual(by["logout"]["status"], "SKIPPED")
        self.assertEqual(by["logout"]["raw_status"], "SKIPPED")
        self.assertEqual(by["ws_start"]["status"], "COMPLETED")
        self.assertEqual(by["ws_start"]["catch_up"], True)  # trigger MISSED_SCHEDULE_CATCHUP
        self.assertEqual(by["tick_collection"]["status"], "CATCH_UP")
        self.assertEqual(by["tick_collection"]["catch_up"], True)
        self.assertEqual(by["ws_stop"]["status"], "WAITING_NETWORK")
        self.assertEqual(by["ws_stop"]["reason_code"], "NETWORK_OFFLINE")

    async def test_equality_filters(self):
        self._seed()
        self.assertEqual((await self.ledger.list_runs(business_date="2026-09-09"))["total"], 1)
        self.assertEqual((await self.ledger.list_runs(job_id="ws_start"))["total"], 1)
        self.assertEqual((await self.ledger.list_runs(schedule_id="session_login"))["total"], 2)
        self.assertEqual((await self.ledger.list_runs(schedule_id="session_logout"))["total"], 1)
        self.assertEqual((await self.ledger.list_runs(trigger="MISSED_SCHEDULE_CATCHUP"))["total"], 2)

    async def test_status_bucket_expansion(self):
        self._seed()
        runs = await self.ledger.list_runs(status="RUNNING")
        self.assertEqual([r["job_id"] for r in runs["runs"]], ["tick_collection"])
        runs = await self.ledger.list_runs(status="WAITING")
        self.assertEqual([r["job_id"] for r in runs["runs"]], ["ws_stop"])
        runs = await self.ledger.list_runs(status="PENDING")
        self.assertEqual([r["job_id"] for r in runs["runs"]], ["login"])
        self.assertEqual(runs["runs"][0]["business_date"], "2026-09-09")

    async def test_missed_schedule_catchup_bucket_includes_completed_catchup(self):
        self._seed()
        runs = await self.ledger.list_runs(status="MISSED_SCHEDULE_CATCHUP")
        jobs = {r["job_id"] for r in runs["runs"]}
        # ws_start (COMPLETED with catch-up trigger) + tick_collection (active).
        self.assertEqual(jobs, {"ws_start", "tick_collection"})

    async def test_failed_only_and_catch_up_only(self):
        self._seed()
        failed = await self.ledger.list_runs(failed_only=True)
        self.assertEqual([r["job_id"] for r in failed["runs"]], ["square_off"])
        catch_up = await self.ledger.list_runs(catch_up_only=True)
        self.assertEqual({r["job_id"] for r in catch_up["runs"]},
                         {"ws_start", "tick_collection"})

    async def test_search_over_real_fields(self):
        self._seed()
        res = await self.ledger.list_runs(search="square")
        self.assertEqual([r["job_id"] for r in res["runs"]], ["square_off"])
        res = await self.ledger.list_runs(search="network unavailable")
        self.assertEqual([r["job_id"] for r in res["runs"]], ["ws_stop"])
        res = await self.ledger.list_runs(search="nope-xyz")
        self.assertEqual(res["total"], 0)

    async def test_pagination_total_and_pages(self):
        self._seed()  # 7 runs total after no filters
        res = await self.ledger.list_runs(page=1, page_size=3)
        self.assertEqual(res["total"], 7)
        self.assertEqual(res["pages"], 3)
        self.assertEqual(res["count"], 3)
        res = await self.ledger.list_runs(page=3, page_size=3)
        self.assertEqual(res["count"], 1)
        res = await self.ledger.list_runs(page=99, page_size=3)
        self.assertEqual(res["count"], 0)
        self.assertEqual(res["page"], 99)

    async def test_sort_order(self):
        self._seed()
        asc = await self.ledger.list_runs(sort="scheduled_at", order="asc")
        times = [r["scheduled_at"] for r in asc["runs"]]
        self.assertEqual(times, sorted(times))
        desc = await self.ledger.list_runs(sort="scheduled_at", order="desc")
        times = [r["scheduled_at"] for r in desc["runs"]]
        self.assertEqual(times, sorted(times, reverse=True))
        # Invalid sort key falls back safely.
        ok = await self.ledger.list_runs(sort="bogus")
        self.assertEqual(ok["total"], 7)

    async def test_run_detail_lookup(self):
        self._seed()
        doc = await self.ledger.get_run_by_execution_id(
            "login:2026-09-08:2026-09-08T09:00:00+05:30")
        self.assertIsNotNone(doc)
        self.assertEqual(doc["job_id"], "login")
        self.assertEqual(doc["status"], "COMPLETED")
        missing = await self.ledger.get_run_by_execution_id("nonexistent")
        self.assertIsNone(missing)


if __name__ == "__main__":
    unittest.main()