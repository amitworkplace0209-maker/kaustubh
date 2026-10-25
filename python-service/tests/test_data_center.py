"""Data Center service + API tests (no live MongoDB required).

Covers:
- ``collection_health`` threshold derivation (real collstats-shaped dicts)
- ``daily_write_history`` per-day real counts (mini aggregation engine)
- ``daily_symbols`` distinct-symbol grouping
- ``workers_snapshot`` real in-process signal sources
- snapshot persistence (``capture_snapshot``) + recent snapshots
- API export (CSV/JSON) rows

Run:  python -m pytest tests/test_data_center.py -q
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

NOW = datetime.now(timezone.utc)
IST_OFFSET = timedelta(hours=5, minutes=30)


def ist_day(dt: datetime) -> str:
    return dt.astimezone(timezone(IST_OFFSET)).strftime("%Y-%m-%d")


# --------------------------------------------------------------------------- #
# Mini aggregation engine supporting exactly the pipelines data_center uses
# --------------------------------------------------------------------------- #
def _compute(expr, doc):
    if isinstance(expr, str) and expr.startswith("$"):
        cur = doc
        for part in expr[1:].split("."):
            cur = cur.get(part) if isinstance(cur, dict) else None
        return cur
    if isinstance(expr, dict):
        if "$dateToString" in expr:
            d = expr["$dateToString"]
            val = _compute(d["date"], doc)
            if isinstance(val, datetime):
                return val.astimezone(timezone(IST_OFFSET)).strftime(d["format"])
            return ""
        if "$substrBytes" in expr:
            src, start, length = expr["$substrBytes"]
            val = str(_compute(src, doc) or "")
            return val[start:start + length]
        if "$sum" in expr:
            val = _compute(expr["$sum"], doc)
            return int(val or 0)
        if "$gte" in expr or "$lt" in expr:
            keys = list(expr.keys())
            key = [k for k in keys if k.startswith("$")][0]
            return {key: expr[key]}
    return expr


class FakeCursor:
    def __init__(self, items):
        self._items = list(items)
        self._sort = None

    def sort(self, *args, **kwargs):
        return self

    def limit(self, n):
        self._items = self._items[: int(n or 0)] if n else self._items
        return self

    async def to_list(self, length=None):
        return self._items[: int(length)] if length else list(self._items)

    def __aiter__(self):
        async def _gen():
            for item in self._items:
                yield item
        return _gen()


def _match(doc, q):
    for key, val in q.items():
        item = doc.get(key)
        if isinstance(val, dict):
            if "$gte" in val and item is not None and val["$gte"] > item:
                return False
            if "$lt" in val and item is not None and val["$lt"] <= item:
                return False
            if "$in" in val and item not in val["$in"]:
                return False
            continue
        if item != val:
            return False
    return True


def _group_key(g, doc):
    gid = g["_id"]
    if isinstance(gid, dict):
        if any(k.startswith("$") for k in gid):
            return _compute(gid, doc)
        out = {k: _compute(v, doc) for k, v in gid.items()}
        return tuple(sorted(out.items()))
    return _compute(gid, doc) if isinstance(gid, str) and gid.startswith("$") else gid


def _apply_group(items, g):
    grouped: dict = {}
    for doc in items:
        key = _group_key(g, doc)
        acc = grouped.setdefault(key, {})
        for k, expr in g.items():
            if k == "_id":
                continue
            if isinstance(expr, dict) and "$sum" in expr:
                acc[k] = acc.get(k, 0) + _compute(expr, doc)
    out = []
    for key, acc in grouped.items():
        if isinstance(g["_id"], dict) and not any(k.startswith("$") for k in g["_id"]):
            row = {"_id": {k: v for k, v in key}}
        else:
            row = {"_id": key}
        row.update(acc)
        out.append(row)
    return out


def _run_pipeline(items, pipeline):
    out = list(items)
    for stage in pipeline:
        if "$match" in stage:
            out = [d for d in out if _match(d, stage["$match"])]
        elif "$group" in stage:
            out = _apply_group(out, stage["$group"])
    return out


class FakeCollection:
    def __init__(self, name, docs):
        self.name = name
        self._docs = list(docs)
        self.upserts = []

    def aggregate(self, pipeline, allowDiskUse=False):
        return FakeCursor(_run_pipeline(self._docs, pipeline))

    async def count_documents(self, q):
        return sum(1 for d in self._docs if _match(d, q))

    async def estimated_document_count(self):
        return len(self._docs)

    def find(self, q=None, projection=None):
        q = q or {}
        return FakeCursor([d for d in self._docs if _match(d, q)])

    def find_one(self, q=None, projection=None):
        items = [d for d in self._docs if _match(d, q or {})]
        return items[0] if items else None

    async def update_one(self, q, update, upsert=False):
        self.upserts.append((q, update, upsert))

    async def insert_one(self, doc):
        self._docs.append(doc)

    async def list_collection_names(self):
        return ["ticks", "audit_trail"]


class FakeDB:
    def __init__(self, **colls):
        self._colls = {}
        for name, docs in colls.items():
            setattr(self, name, FakeCollection(name, docs))
            self._colls[name] = getattr(self, name)
        self.name = "kaustubh"
        self.client = mock.Mock()

    def __getitem__(self, key):
        if key in self._colls:
            return self._colls[key]
        raise KeyError(key)

    async def list_collection_names(self):
        return list(self._colls.keys())


def make_ticks(rows):
    docs = []
    for ts, symbol in rows:
        docs.append({"symbol": symbol, "ts": ts})
    return docs


TODAY = NOW.astimezone(timezone(IST_OFFSET)).date()
DAY1 = (TODAY - timedelta(days=1)).isoformat()
DAY0 = TODAY.isoformat()


def day_start(d: str) -> datetime:
    return datetime.strptime(d, "%Y-%m-%d").replace(
        tzinfo=timezone(IST_OFFSET)).astimezone(timezone.utc)


def _history_db():
    d0 = day_start(DAY0)
    d1 = day_start(DAY1)
    return FakeDB(
        ticks=make_ticks([
            (d0 + timedelta(hours=5), "A"),
            (d0 + timedelta(hours=6), "A"),
            (d0 + timedelta(hours=7), "B"),
            (d1 + timedelta(hours=5), "A"),
            (d1 + timedelta(hours=9), "C"),
        ]),
        scheduler_runs=[
            {"business_date": DAY0, "status": "COMPLETED"},
            {"business_date": DAY0, "status": "FAILED"},
            {"business_date": DAY0, "status": "COMPLETED"},
            {"business_date": DAY1, "status": "COMPLETED"},
        ],
        api_telemetry=[
            {"ts": d0 + timedelta(hours=6), "requests": 10, "errors": 1,
             "clientErrors": 0, "serverErrors": 1, "sum_latency_ms": 500, "num_latency": 10},
            {"ts": d0 + timedelta(hours=8), "requests": 2, "errors": 0,
             "clientErrors": 1, "serverErrors": 0, "sum_latency_ms": 30, "num_latency": 2},
            {"ts": d1 + timedelta(hours=7), "requests": 5, "errors": 0,
             "clientErrors": 0, "serverErrors": 0, "sum_latency_ms": 100, "num_latency": 5},
        ],
        download_history=[
            {"ts": d0 + timedelta(hours=6)},
            {"ts": d1 + timedelta(hours=9)},
        ],
        system_events=[
            {"ts": d0 + timedelta(hours=5)},
            {"ts": d0 + timedelta(hours=6)},
            {"ts": d1 + timedelta(hours=8)},
        ],
        audit_trail=[
            {"ts": (d0 + timedelta(hours=5)).isoformat()},
            {"ts": (d0 + timedelta(hours=6)).isoformat()},
        ],
        daily_summaries=[
            {"date": DAY0, "totalTicks": 99, "totalWrites": 3, "errorCount": 1},
        ],
        data_center_snapshots=[],
    )


class DataCenterServiceTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.db = _history_db()
        self.patchers = [
            mock.patch("services.data_center.get_db", return_value=self.db),
            mock.patch("services.data_center.is_mongo_connected", return_value=True),
        ]
        for p in self.patchers:
            p.start()
            self.addCleanup(p.stop)

    # ---- collection_health ----------------------------------------------- #
    def test_collection_health_healthy(self):
        from services.data_center import collection_health
        st = {"storageBytes": 1000, "dataSizeBytes": 1000, "indexSizeBytes": 100,
              "lastRecord": NOW.isoformat()}
        self.assertEqual(collection_health(st)["status"], "HEALTHY")

    def test_collection_health_stale(self):
        from services.data_center import collection_health
        st = {"storageBytes": 1000, "dataSizeBytes": 1000, "indexSizeBytes": 100,
              "lastRecord": (NOW - timedelta(days=30)).isoformat()}
        self.assertEqual(collection_health(st)["status"], "STALE")

    def test_collection_health_high_storage_priority_over_stale(self):
        from services.data_center import collection_health
        st = {"storageBytes": 200 * 1024 * 1024, "dataSizeBytes": 200 * 1024 * 1024,
              "indexSizeBytes": 1, "lastRecord": (NOW - timedelta(days=30)).isoformat()}
        # STALE (listed first in priority) wins over HIGH_STORAGE.
        self.assertEqual(collection_health(st)["status"], "STALE")
        st2 = {**st, "lastRecord": NOW.isoformat()}
        self.assertEqual(collection_health(st2)["status"], "HIGH_STORAGE")

    def test_collection_health_index_heavy(self):
        from services.data_center import collection_health
        st = {"storageBytes": 20 * 1024 * 1024, "dataSizeBytes": 20 * 1024 * 1024,
              "indexSizeBytes": 15 * 1024 * 1024, "lastRecord": NOW.isoformat()}
        self.assertEqual(collection_health(st)["status"], "INDEX_HEAVY")

    def test_collection_health_unknown_empty(self):
        from services.data_center import collection_health
        self.assertEqual(collection_health({})["status"], "UNKNOWN")

    # ---- daily_write_history -------------------------------------------- #
    async def test_daily_write_history_real_counts(self):
        from services.data_center import daily_write_history
        rows = await daily_write_history(days=2)
        by_date = {r["date"]: r for r in rows}
        row0 = by_date[DAY0]
        self.assertEqual(row0["ticksWritten"], 3)
        self.assertEqual(row0["schedulerRuns"], 3)
        self.assertEqual(row0["schedulerCompleted"], 2)
        self.assertEqual(row0["schedulerFailed"], 1)
        self.assertEqual(row0["apiRequests"], 12)
        self.assertEqual(row0["apiErrors"], 1)
        self.assertEqual(row0["apiServerErrors"], 1)
        self.assertEqual(row0["downloads"], 1)
        self.assertEqual(row0["systemEvents"], 2)
        self.assertEqual(row0["auditEntries"], 2)
        self.assertEqual(row0["summaryTotalWrites"], 3)
        self.assertEqual(row0["summaryTotalTicks"], 99)
        self.assertEqual(row0["summaryErrorCount"], 1)

        row1 = by_date[DAY1]
        self.assertEqual(row1["ticksWritten"], 2)
        self.assertEqual(row1["schedulerRuns"], 1)
        self.assertEqual(row1["apiRequests"], 5)
        self.assertEqual(row1["auditEntries"], 0)
        self.assertIsNone(row1["summaryTotalWrites"])

    async def test_daily_write_history_api_latency_average(self):
        from services.data_center import daily_write_history
        rows = await daily_write_history(days=2)
        by_date = {r["date"]: r for r in rows}
        self.assertAlmostEqual(by_date[DAY0]["apiAvgLatencyMs"], 530 / 12, places=2)

    async def test_daily_write_history_not_connected(self):
        with mock.patch("services.data_center.is_mongo_connected", return_value=False):
            from services.data_center import daily_write_history
            rows = await daily_write_history(days=3)
            self.assertEqual(len(rows), 3)
            self.assertIsNone(rows[0]["ticksWritten"])

    # ---- daily_symbols --------------------------------------------------- #
    async def test_daily_symbols_distinct(self):
        from services.data_center import daily_symbols
        out = await daily_symbols(days=2)
        self.assertEqual(out.get(DAY0), 2)   # A, B
        self.assertEqual(out.get(DAY1), 2)   # A, C

    # ---- workers_snapshot ------------------------------------------------ #
    async def test_workers_snapshot_real_sources(self):
        import services.data_center as dc
        ticks_stats = {
            "pipelineRunning": True, "pipelineStartedAt": 1000.0,
            "totalReceived": 10, "totalWritten": 9, "totalWriteErrors": 1,
            "bufferLength": 0, "ticksPerSecond": 1.5, "writesPerSecond": 1.0,
            "lastWriteAt": 2000.0, "activeTickStocks": 3,
        }
        ws_status = {
            "connected": True, "lifecycle_state": "WS_ACTIVE",
            "feed_state": "RECEIVING", "subscribed_symbols": 4,
            "reconnect_count": 0, "disconnect_reason": None,
            "last_message_at": "2026-09-08T10:00:00+00:00", "diagnostics": {},
        }
        import services.tick_buffer as tb
        import scheduler as sched_mod
        import importlib
        import api.export_jobs as exj
        import api.scheduled_downloads as sd
        import services.api_telemetry as at

        class _FakeWS:
            def status(self):
                return ws_status

        wsm_mod = importlib.import_module("ws_socket.ws_manager")
        with mock.patch.object(tb, "stats", return_value=ticks_stats), \
             mock.patch.object(sched_mod, "get_scheduler_info",
                               return_value={"running": True, "state": "RUNNING",
                                             "next_action": "login",
                                             "is_trading_day": True,
                                             "state_updated_at": "x"}), \
             mock.patch.object(wsm_mod, "ws_manager", _FakeWS()), \
             mock.patch.object(exj, "export_worker_status",
                               return_value={"running": True, "taskActive": True,
                                             "intervalSeconds": 15}), \
             mock.patch.object(sd, "scheduled_downloads_checker_status",
                               return_value={"running": True, "taskActive": True,
                                             "intervalSeconds": 10}), \
             mock.patch.object(at, "flusher_status",
                               return_value={"running": True, "taskActive": True,
                                             "lastFlushAt": "y"}):
            workers = await dc.workers_snapshot()

        ids = {w["id"] for w in workers}
        self.assertIn("tick_pipeline", ids)
        self.assertIn("scheduler", ids)
        self.assertIn("ws_supervisor", ids)
        self.assertIn("export_worker", ids)
        self.assertIn("downloads_checker", ids)
        self.assertIn("api_telemetry_flusher", ids)
        self.assertIn("data_center_snapshot", ids)
        tp = next(w for w in workers if w["id"] == "tick_pipeline")
        self.assertEqual(tp["status"], "RUNNING")
        self.assertEqual(tp["detail"]["totalWritten"], 9)
        ws = next(w for w in workers if w["id"] == "ws_supervisor")
        self.assertEqual(ws["status"], "RUNNING")
        self.assertEqual(ws["detail"]["connected"], True)

    # ---- snapshots ------------------------------------------------------- #
    async def test_capture_snapshot_persists_and_returns_point(self):
        with mock.patch("services.data_center._mongo_stats", new=mock.AsyncMock(
                return_value={"stats": {"totalStorageBytes": 1234,
                                        "totalIndexSizeBytes": 56,
                                        "totalObjects": 42}})), \
             mock.patch("services.data_center._system_snapshot", new=mock.AsyncMock(
                return_value={"node": {"diskUsedBytes": 999, "diskPercent": 12.5}})), \
             mock.patch("services.data_center._ping_mongo", new=mock.AsyncMock(
                return_value=3.2)):
            from services.data_center import capture_snapshot
            res = await capture_snapshot(manual=True)
            self.assertTrue(res["ok"])
            self.assertEqual(res["db"]["totalStorageBytes"], 1234)
            self.assertTrue(self.db.data_center_snapshots.upserts)

    async def test_recent_snapshots_serialized(self):
        import services.data_center as dc
        now = datetime.now(timezone.utc)
        self.db.data_center_snapshots._docs.append(
            {"ts": now, "istDay": "2026-09-08", "mode": "auto", "db": {}, "storage": {}})
        points = await dc.recent_snapshots(limit=10)
        self.assertEqual(len(points), 1)
        self.assertEqual(points[0]["istDay"], "2026-09-08")


class DataCenterApiTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.db = _history_db()
        self.patchers = [
            mock.patch("api.data_center.get_db", return_value=self.db),
            mock.patch("api.data_center.is_mongo_connected", return_value=True),
            mock.patch("services.data_center.get_db", return_value=self.db),
            mock.patch("services.data_center.is_mongo_connected", return_value=True),
        ]
        for p in self.patchers:
            p.start()
            self.addCleanup(p.stop)

    async def _run_builder(self, key, ttl, builder, *args):
        if asyncio.iscoroutinefunction(builder):
            return await builder(*args)
        return builder(*args)

    async def test_export_csv_rows_real(self):
        from api import data_center as api
        with mock.patch("api.data_center._get_or_build", new=self._run_builder):
            resp = await api.data_center_export(kind="daily", days="2")
        body = resp.body.decode()
        self.assertIn("date", body)
        self.assertIn(DAY0, body)
        self.assertIn("3", body)  # ticksWritten for DAY0
        self.assertIn("text/csv", resp.media_type)
        self.assertIn('attachment; filename="data-center-daily-', resp.headers["content-disposition"])

    async def test_export_json_rows_real(self):
        from api import data_center as api
        with mock.patch("api.data_center._get_or_build", new=self._run_builder):
            resp = await api.data_center_export(kind="daily", days="2", format="json")
        import json as _json
        rows = _json.loads(resp.body.decode())
        by_date = {r["date"]: r for r in rows}
        self.assertEqual(by_date[DAY0]["ticksWritten"], 3)

    async def test_export_invalid_format_rejected(self):
        from api import data_center as api
        with self.assertRaises(Exception):
            await api.data_center_export(kind="daily", days="2", format="xml")

    def test_mark_process_started_keeps_fn_callable(self):
        import services.data_center as dc
        dc.mark_process_started()
        started = dc._process_started_at()
        self.assertIsInstance(started, float)
        self.assertGreater(started, 0)

    async def test_overview_route_forwards_days_keyword_only(self):
        from api import data_center as api
        import services.data_center as dc

        calls = {}

        async def fake_snapshot(*, days):
            calls["days"] = days
            return {"mongo": {"connected": True}, "anything": {"a": 1}}

        with mock.patch.object(dc, "build_snapshot", new=fake_snapshot), \
                mock.patch("api.data_center._get_or_build", new=self._run_builder):
            resp = await api.data_center_overview(days="14")
        self.assertTrue(resp["ok"])
        self.assertEqual(resp["data"]["mongo"]["connected"], True)
        self.assertEqual(calls["days"], 14)

    async def test_overview_default_days_uses_trend_days(self):
        from api import data_center as api
        import services.data_center as dc

        calls = {}

        async def fake_snapshot(*, days):
            calls["days"] = days
            return {"mongo": {"connected": True}}

        with mock.patch.object(dc, "build_snapshot", new=fake_snapshot), \
                mock.patch("api.data_center._get_or_build", new=self._run_builder):
            resp = await api.data_center_overview()
        self.assertTrue(resp["ok"])
        self.assertEqual(calls["days"], dc.TREND_DAYS)

    async def test_collection_route_cache_key_no_collision(self):
        from api import data_center as api
        with mock.patch.object(api, "_collection_detail", new=mock.AsyncMock(
                return_value={"name": "ticks", "count": 7})), \
                mock.patch("api.data_center._get_or_build", new=self._run_builder):
            resp = await api.data_center_collection("ticks")
        self.assertTrue(resp["ok"])
        self.assertEqual(resp["data"]["count"], 7)

    # ---- plane cache keys -------------------------------------------------- #
    async def test_retention_plane_cache_key_includes_limit(self):
        """Two different `limit` values must not share one cached plane entry."""
        from api import data_center as api

        seen = {}

        async def _capture(key, ttl, builder, *args):
            seen[key] = args
            return {"ttlIndexCount": 0}

        with mock.patch("api.data_center._get_or_build", new=_capture):
            await api.data_center_retention_plane(limit="50")
            await api.data_center_retention_plane(limit="400")

        self.assertEqual(len(seen), 2, f"retention limit reused one cache key: {list(seen)}")
        self.assertEqual({a[0] for a in seen.values()}, {50, 400})

    async def test_retention_plane_clamps_and_passes_limit_to_builder(self):
        from api import data_center as api

        seen = []

        async def _capture(key, ttl, builder, *args):
            seen.append(args)
            return {}

        with mock.patch("api.data_center._get_or_build", new=_capture):
            await api.data_center_retention_plane(limit="99999")
            await api.data_center_retention_plane(limit="0")
            await api.data_center_retention_plane(limit=None)
        self.assertEqual(seen, [(2000,), (1,), (400,)])

    async def test_parameterless_planes_share_one_cache_entry(self):
        from api import data_center as api

        seen = set()

        async def _capture(key, ttl, builder, *args):
            seen.add(key)
            return {}

        with mock.patch("api.data_center._get_or_build", new=_capture):
            await api.data_center_database_plane()
            await api.data_center_database_plane()

        self.assertEqual(len(seen), 1)
        self.assertIn("name=database", next(iter(seen)))

    async def test_export_snapshots(self):
        from api import data_center as api
        import services.data_center as dc
        with mock.patch.object(dc, "recent_snapshots", new=mock.AsyncMock(
                return_value=[{"ts": "x", "istDay": DAY0, "mode": "auto",
                               "db": {"totalStorageBytes": 1}, "storage": {}}])):
            resp = await api.data_center_export(kind="snapshots", days="2")
        self.assertIn("db_storage_bytes", resp.body.decode())

    # ---- api-telemetry ---------------------------------------------------- #
    async def test_api_telemetry_endpoint_returns_summary(self):
        from api import data_center as api
        import services.ds_insights as insights

        async def fake_summary(*, range_hours):
            return {
                "requests": 100, "errors": 2, "success": 98, "successPct": 98.0,
                "errorPct": 2.0, "avgLatencyMs": 12.5, "p50Ms": 5.0, "p95Ms": 40.0,
                "p99Ms": 90.0, "clientErrors": 1, "serverErrors": 1,
                "endpoints": [{"route": "/api/system/x", "requests": 60, "errors": 1,
                               "clientErrors": 0, "serverErrors": 1,
                               "successPct": 98.33, "avgMs": 8.0}],
                "hasData": True, "dbRelatedFailures": 0,
            }

        async def fake_errors(limit=20):
            return [{"ts": "2026-09-10T10:00:00+00:00", "route": "/x",
                     "errors": 1, "clientErrors": 1, "serverErrors": 0,
                     "avgLatencyMs": 30.0, "dbRelated": False}]

        with mock.patch.object(insights, "api_telemetry_summary", new=fake_summary), \
                mock.patch.object(api, "_recent_telemetry_errors", new=fake_errors), \
                mock.patch("api.data_center._get_or_build", new=self._run_builder):
            resp = await api.data_center_api_telemetry(hours="24", limit="5")
        self.assertTrue(resp["ok"])
        data = resp["data"]
        self.assertEqual(data["hours"], 24)
        self.assertEqual(data["requests"], 100)
        self.assertEqual(data["p95Ms"], 40.0)
        self.assertEqual(data["endpoints"][0]["successPct"], 98.33)
        self.assertEqual(data["recentErrors"][0]["dbRelated"], False)

    async def test_api_telemetry_endpoint_bounds_limits(self):
        from api import data_center as api
        import services.ds_insights as insights
        calls = {}

        async def fake_summary(*, range_hours):
            calls["range_hours"] = range_hours
            return {"requests": 0, "errors": 0, "endpoints": [], "hasData": False}

        async def fake_errors(limit=20):
            calls["limit"] = limit
            return []

        with mock.patch.object(insights, "api_telemetry_summary", new=fake_summary), \
                mock.patch.object(api, "_recent_telemetry_errors", new=fake_errors), \
                mock.patch("api.data_center._get_or_build", new=self._run_builder):
            resp = await api.data_center_api_telemetry(hours="720", limit="999")
        self.assertEqual(calls["range_hours"], 720)
        self.assertEqual(calls["limit"], 100)
        self.assertTrue(resp["ok"])

    async def test_recent_telemetry_errors_serializes_real(self):
        from api import data_center as api
        d0 = day_start(DAY0)
        self.db.api_telemetry._docs.append(
            {"ts": d0 + timedelta(hours=6), "route": "/api/system/x",
             "errors": 2, "clientErrors": 0, "serverErrors": 2,
             "avg_latency_ms": 55.5, "db_related": True})
        out = await api._recent_telemetry_errors(limit=10)
        rows = [r for r in out if r.get("route") == "/api/system/x"]
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual(r["errors"], 2)
        self.assertTrue(r["dbRelated"])
        self.assertEqual(r["avgLatencyMs"], 55.5)
        self.assertEqual(
            r["ts"],
            (d0 + timedelta(hours=6)).astimezone(timezone.utc).isoformat())

    async def test_recent_telemetry_errors_not_connected(self):
        from api import data_center as api
        with mock.patch("api.data_center.is_mongo_connected", return_value=False):
            self.assertEqual(await api._recent_telemetry_errors(limit=5), [])

    def test_ts_iso_normalizes(self):
        from api import data_center as api
        aware = datetime(2026, 9, 10, 5, 0, tzinfo=timezone.utc)
        self.assertEqual(api._ts_iso(aware), "2026-09-10T05:00:00+00:00")
        naive = datetime(2026, 9, 10, 5, 0)
        self.assertEqual(api._ts_iso(naive), "2026-09-10T05:00:00+00:00")
        self.assertIsNone(api._ts_iso(None))
        self.assertEqual(api._ts_iso("raw"), "raw")


if __name__ == "__main__":
    unittest.main(verbosity=2)