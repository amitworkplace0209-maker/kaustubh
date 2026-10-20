# TICK ANALYTICS — operational + historical tick analytics

> **Owner of what:** analytics/observability *consumer* only.
> **Never owns:** the broker feed, the WebSocket Engine, the DB Writer, tick
> writes, orders, sessions, subscriptions, retention.

The Tick Analytics engine turns raw tick-persistence telemetry into an
operator-facing view of *how the tick pipeline is behaving* — live (this
session) and historically (per trading day) — without ever recomputing
anything on a request path and without ever inventing a number.

Route: `/data-saver/analytics` (frontend) → `app/api/phase2/analytics/route.ts`
(BFF) → `/api/data-saver/tick-analytics/*` (backend).

---

## 1. Responsibility boundary

| Does | Does not |
| --- | --- |
| Read tick-buffer, writer, calendar, latency, quality, storage telemetry | Produce ticks or write to `ticks` |
| Read the pre-aggregated `tick_analytics_daily` collection | Scan raw `ticks` on a request path |
| Publish a coalesced ~1 Hz analytics frame on the **existing** system SSE | Open a WebSocket, a broker socket or a second feed |
| Queue historical days for a background backfill loop | Rebuild a day synchronously inside an HTTP request |
| Label the provenance of every metric in `sources` | Guess, interpolate or default a missing metric to `0` |

This is the same discipline as the Data Center page: the page is read-only,
the backend is the single source of truth, and a value that could not be
measured renders as `—` plus an entry in `missing[]`.

---

## 2. Collections and inputs

| Input | What is read from it | Provenance label |
| --- | --- | --- |
| `tick_buffer` | rolling receive/write window, recent tick samples, live session counters | `tick_buffer.stats()` / `get_recent()` |
| `daily_summaries` | restart-safe per-IST-day `totalTicks` / `totalWrites` counters | `daily_summaries.totalTicks` |
| `data_saver_telemetry` | per-minute ingest/write/error buckets (24 h) | `data_saver_telemetry` |
| `data_quality` | duplicate/error rates for a bounded window | `data_quality._compute_metrics` |
| `db_writer_engine` | permission caps, rejection/loss counters | `db_writer_engine.status_snapshot()` |
| `pipeline_latency` | stage histograms incl. `ws_recv_to_mongo` | `pipeline_latency.stats()` |
| `market_calendar` | OPEN 09:15 / CLOSE 15:30, `NORMAL_MARKET_DAY` | `market_calendar` |
| `db.command("collstats", "ticks")` | stored bytes / doc count / avg object size | `collstats(ticks)` |
| **`tick_analytics_daily`** | pre-aggregated per-day document (counts, ticks, rate, persistence, storage, quality, latency, periods, symbolStats, anomalies, missing) | `tick_analytics_daily` |

`tick_analytics_daily` is the **only** collection this engine writes. It is an
analytics rollup, never a source of market truth.

---

## 3. Section contract

The BFF proxy (`app/api/phase2/analytics/route.ts`) and the page share one
section vocabulary, defined once in `lib/tick-analytics.ts`
(`SECTIONS` / `backendPath` / `sectionQuery`):

| Section | Backend path |
| --- | --- |
| `summary` | `GET /summary` |
| `daily` | `GET /daily?days=` |
| `day` | `GET /daily/{date}` |
| `top` | `GET /top-symbols?date=&limit=` |
| `symbolStats` | `GET /symbol-stats/{symbol}?date=` |
| `report` | `GET /report?date=` |
| `reports` | `GET /reports?days=` |
| `export` | `GET /export?format=csv\|json` |
| `live` | server-side assembly of `state`+`metrics`+`timeseries`+`symbol`+`anomalies`+`market-wide` |

`rate`, `persistence`, `sources`, `storage`, `quality` and `latency` are **not**
separate page sections: they are delivered inside the single `summary` snapshot
(`summary.raw.rate|persistence|sources|storage|quality|latency`) so the page
renders its Today / Tick Rate / Persistence / Quality-Storage sections from one
lightweight fetch instead of six. The backend still exposes them as standalone
endpoints (`GET /rate`, `/persistence`, `/sources`, `/storage`, `/quality?date=`)
for direct consumers and for the API catalog.

Each section is fetched **independently** by `useSection()` on the page: one
failure degrades exactly one card and is surfaced with its own retry. There is
no "if it failed show 0" path anywhere.

---

## 4. Honesty contract (non-negotiable)

1. **Never default a missing metric to `0`.** An unmeasurable metric is `null`
   on the wire and `—` in the UI, and it is named in `missing[]`.
2. **Provenance is always carried.** `sources` records which subsystem
   produced each value (`daily_summaries.totalTicks` vs `tick_buffer` vs
   `collstats` vs …).
3. **Status is reported, never implied.** Every report/row carries
   `COMPLETE | PARTIAL | NO_DATA | UNAVAILABLE` (the UI additionally derives
   `BACKFILLING` for a day still queued).
4. **`PARTIAL` must name its gap.** A day where the writer recorded activity
   but no tick documents were retained is `PARTIAL` with
   `storedTickDocuments` in `missing[]` — *not* `NO_DATA`, which would hide
   the fact that data arrived.
   Rule: `NO_DATA` ⇔ zero stored documents **and** zero writer activity.
5. **A non-`COMPLETE` report always has a non-empty `missing[]`.**
6. **The browser clock is never market data.** CURRENT IST is shown only as a
   clock strip, explicitly labelled as such.
7. **Cache keys must include every dimension you vary on.** (`quality_slice`
   passes `extra_match={"ts": ...}` because `data_quality._cache_key` does not
   include `start_override`/`end_override` — omitting it would collide two
   different days inside the 60 s TTL.)

---

## 5. Daily rollup + backfill

`services/tick_analytics_daily.py`

- `build_day(date, persist=True)` builds one day's document:
  counts (writer + `daily_summaries`), tick timeline/reduce, per-minute
  buckets, session periods (09:15→15:30 from `market_calendar`), symbolStats,
  persistence, storage, quality, latency, anomalies, `missing[]`, `status`.
- `get_day(date, *, refresh=False)`:
  - normal read → in-memory cache (today: `TODAY_TTL_SEC = 45`), else the
    stored document;
  - **`refresh=True` skips the stored document entirely and rebuilds.**
    Without this a queued backfill day would silently re-serve the stale
    document it was queued to rebuild.
- `list_days(days, build_missing=True)` reads stored documents only (projection
  `SUMMARY_FIELDS`) and queues anything absent — it **never aggregates on the
  call path**.
- Backfill bookkeeping: `queue_backfill`, `backfill_once(limit)` (re-queues on
  `UNAVAILABLE`/exception, never silently marks a day done), `backfill_state`
  (`queued` / `completed` / `running`), `reset_state`.
- Guard rails: `MAX_DAYS = 366`, `EXPENSIVE_DAY_DOC_LIMIT = 1_500_000`,
  unique index on `date`.

`app.py` runs `_tick_analytics_backfill_loop` every **8 s**, building at most
**2** days per pass, and queues `recent_days(30)` at startup.

---

## 6. Realtime delivery (no new socket)

`app.py::_tick_analytics_publish_loop` (~**1 s**):

```json
{ "type": "tick_analytics", "timestamp": "...", "data": { ... } }
```

- Transport: the **existing** system SSE
  (`/api/websocket/system/stream`, consumed by `components/realtime-provider.tsx`
  `useRealtime()`), not a new WebSocket and not a broker socket.
- Gated: the frame is only built and published when
  `state_store.client_count() > 0`. No subscriber ⇒ no work.
- Coalesced: one frame per second, **never one frame per tick**.

The page reads it as `tickAnalytics` / `tickAnalyticsEpoch` and merges with
`mergeLive()`, which **drops** explicit nulls/undefined and never overwrites a
REST value with `0`.

---

## 7. REST surface (`api/tick_analytics.py`)

Prefix `/api/data-saver/tick-analytics` — 22 routes.

**Redesigned analytics (14):**
`GET /summary` · `/daily` · `/daily/{date}` · `/top-symbols` ·
`/symbol-stats/{symbol}` · `/rate` · `/persistence` · `/sources` ·
`/storage` · `/quality` · `/latency` · `/report` · `/reports` ·
`/export?format=csv|json`

**Preserved live surface (8):**
`GET /state` · `/metrics` · `POST /timeseries` · `GET /symbol/{symbol}` ·
`GET /depth/{symbol}` · `GET /market-wide` · `POST /history` ·
`POST /anomalies`

`/summary` is cached for 5 s (`invalidate_summary_cache()` on demand).

---

## 8. File map

| File | Role |
| --- | --- |
| `python-service/services/tick_analytics_daily.py` | daily rollup + report + backfill |
| `python-service/services/tick_analytics.py` | live composition layer (`summary`, `live_event`, `latency_block`) |
| `python-service/api/tick_analytics.py` | 22 REST routes + CSV/JSON export |
| `python-service/app.py` | backfill loop + realtime publisher lifecycle |
| `python-service/tests/test_tick_analytics_daily.py` | honesty/report/rollup/backfill tests |
| `app/api/phase2/analytics/route.ts` | section-scoped BFF proxy (single-flight) |
| `lib/tick-analytics.ts` | shared section contract + pure helpers |
| `components/realtime-provider.tsx` | `tickAnalytics` / `tickAnalyticsEpoch` |
| `app/(phase2)/data-saver/analytics/page.tsx` | the page |
| `tests/tick-analytics.test.ts` | frontend contract tests |

---

## 9. Related documents

- `docs/implementation/024-tick-analytics-operational-and-historical-analytics.md`
- `docs/verification/023-tick-analytics-operational-and-historical-analytics-verification.md`
- `docs/logs/LOG-006-2026-10-02-tick-analytics.md`
- `docs/opencode/004-tick-analytics-trace.md`
- `docs/engines/DATA_QUALITY.md`, `docs/engines/db_writer_engine_detailed.md`
