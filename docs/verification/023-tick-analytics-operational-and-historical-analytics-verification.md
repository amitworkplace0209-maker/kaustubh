# 023 — Tick Analytics: operational + historical tick analytics — Verification Record

## Verification ID

`023` (implementation: `docs/implementation/024-tick-analytics-operational-and-historical-analytics.md`)

## Date / Time

2026-10-02, 12:54 IST (verification run window; all timestamps below are IST).

## Agent

OpenCode.

## Task / Feature

1. Deliver `/data-saver/analytics` as a real 0-to-1 operational + historical
   tick analytics surface backed by the backend.
2. Add the daily rollup engine, the 14 new REST routes, CSV/JSON export, the
   background backfill loop and the coalesced realtime publisher.
3. Prove the honesty contract on **real data**, not only in unit tests.

## Expected Behavior

1. Every one of the 14 new routes answers `200` with a JSON-safe object; none
   returns `500`, `NaN` or `Infinity`.
2. `GET /summary` carries `status.code`, `today`, `rate`, `persistence`,
   `quality`, `storage`, `latency`, `sources`, `backfill`; a metric that could
   not be measured is `null`, never `0`.
3. `GET /daily` returns `rows[]`, `missingDates[]` and `backfill{queued,
   completed, running}`; no raw-tick scan happens on the request path.
4. `GET /report?date=` returns `COMPLETE|PARTIAL|NO_DATA` and a **non-empty**
   `missing[]` whenever the status is not `COMPLETE`.
5. `GET /export?format=csv` returns CSV with the documented header row;
   `format=json` returns a report object.
6. An invalid date answers honestly (`NO_DATA` + `missing`) instead of
   crashing.
7. A queued historical day is actually rebuilt (not re-served) by
   `get_day(refresh=True)`.
8. A day where the writer recorded activity but `ticks` holds no documents is
   `PARTIAL` with `storedTickDocuments` in `missing[]` — **not** `NO_DATA`.
9. The 8 legacy routes keep working (redesign must not break the live surface).
10. No regression in the backend/frontend suites beyond pre-existing failures.

## Verification Method

- static code inspection (ownership boundaries, lifecycle wiring, cache keys)
- **REST drive-over-real-HTTP**: a scratch FastAPI app that mounts *only*
  `api.tick_analytics.router`, with a lifespan that connects to the **real
  MongoDB**, driven through `fastapi.testclient.TestClient`
- **real-data rollup verification**: a script that queues 7 IST days, runs
  `backfill_once()` exactly as the background loop does, then re-reads the
  stored documents and the derived report
- unit test (backend `68`, frontend `28`)
- type check and lint (frontend)
- **not performed:** browser rendering/responsive inspection; restarting the
  live backend process on port 8000

## Environment

- Windows 11, development build.
- Backend venv: `C:\project\python-service\.venv\Scripts\python.exe`.
- Real MongoDB reached through `python-service/.env` (`MONGODB_URI`); the
  scratch app connected successfully (`mongo_connected = True`).
- Node v24.x, Next 16.3.4, React 19.2.8; `node --test`, `tsc`, `eslint`.
- Timezone IST. **2026-10-02 is a `NORMAL_MARKET_DAY` and the market was open
  (09:15–15:30) during the run.** No broker session was logged in, so the feed
  is genuinely idle — `daily_summaries` for today reads `0` and `ticks` holds
  `0` documents. Those are real measurements and were left as-is.
- The already-running backend on `127.0.0.1:8000` predates this change and
  serves the old code; it was **not** restarted.

## Questions / Checks

1. Are all 14 new routes registered on the router?
2. Does every endpoint answer `200` with a JSON-safe body over real HTTP?
3. Does `/summary` expose every contract block, and does it stay honest when
   nothing is measurable?
4. Does `/daily` expose `rows`, `missingDates` and `backfill`?
5. Does a `NO_DATA`/`PARTIAL` report always name what is missing?
6. Is the CSV export header exactly as documented?
7. Does an invalid date degrade honestly instead of raising?
8. Do the 8 legacy routes still answer?
9. Does a 7-day backfill complete in bounded time and produce honest rows?
10. With `ticks` empty but `daily_summaries` recording activity, is the day
    reported `PARTIAL` (gap named) rather than `NO_DATA` (gap hidden)?
11. Does `get_day(refresh=True)` rebuild instead of re-serving the stored doc?
12. Do the suites, typecheck and lint stay clean?

## Expected Results / Actual Results

| # | Expected | Actual |
| --- | --- | --- |
| 1 | 14 routes | **22 routes** on the prefix (14 new + 8 legacy) — `@router.get` enumeration matches the list in §14 of the implementation record |
| 2 | 200 + JSON-safe | **all 16 probed endpoints → 200**, each body an object and `json.dumps(allow_nan=False)` clean |
| 3 | contract blocks + honesty | `status.code`, `today`, `rate`, `persistence`, `quality`, `storage`, `latency`, `sources`, `backfill` all present; `today.ticksReceived = 0` (real counter), `rate.current = 0.0` (real empty window), `generatedInMs = 485.0`; `status.code = DISCONNECTED` (no feed) |
| 4 | rows/missing/backfill | `rows=1`, `missingDates=6`, `backfill={'queued': 6, 'completed': 0, 'running': False}` |
| 5 | missing[] non-empty | today's report `status=NO_DATA`, `missing=['firstTick','lastTick','avgTickRate','peakTickRate','persistenceSuccessRate','tickTimeline']` |
| 6 | documented header | `Date,Trading Day,Status,Ticks Received,Ticks Persisted,Failed,Skipped,Symbols,Avg Tick Rate,Peak Tick Rate,First Tick,Last Tick,Active Duration (s),Storage Added,Persistence Success %` |
| 7 | honest degradation | `GET /daily/not-a-date` → **200**, `status=NO_DATA` + `missing` (no crash, no fabricated row) |
| 8 | legacy intact | `GET /state`, `/metrics`, `/market-wide` → **200** |
| 9 | bounded honest backfill | 7 days queued → `built 6 day(s) in 1.1 s` (limit 3/pass, today skipped by design), `queued 0 / completed 6`; all 7 rows returned, `missingDates=[]` |
| 10 | `PARTIAL` not `NO_DATA` | `2026-10-01 received=15811 stored=0` → **`status=PARTIAL`**, `missing` contains `storedTickDocuments`; `2026-09-26 received=None stored=0` → **`status=NO_DATA`** (genuinely no activity) |
| 11 | rebuild on refresh | after the fix, `get_day('2026-10-01', refresh=True)` rebuilt the document; without the fix it returned the stored doc unchanged |
| 12 | clean | see **Evidence** |

## Evidence

```
== REST surface ==            (scratch app, real MongoDB, mongo_connected = True)
  ok   /summary /daily /daily/2026-10-02 /top-symbols /symbol-stats/RELIANCE
  ok   /rate /persistence /sources /storage /quality /latency
  ok   /report /reports
  ok   /state /metrics /market-wide        (legacy preserved)
  all bodies JSON-safe (json.dumps(..., allow_nan=False))

== daily honesty ==
  info rows=1 missing=6 backfill={'queued': 6, 'completed': 0, 'running': False}
  row 2026-10-02 status=NO_DATA (zero stored docs, zero writer activity)

== export ==
  Date,Trading Day,Status,Ticks Received,Ticks Persisted,Failed,Skipped,Symbols,...

== bad input ==
  ok   /daily/not-a-date -> 200, reports NO_DATA/missing instead of crashing
```

```
== real-data rollup ==
  mongo: ticks=0 daily_summaries=3 tick_analytics_daily=7
  queued: {'queued': 7, 'completed': 0, 'running': False}
  built 6 day(s) in 1.1s | {'queued': 0, 'completed': 6, 'running': False}
  ok   2026-10-01 PARTIAL  received=15811 stored=0  missing contains storedTickDocuments
  ok   2026-09-30 PARTIAL  received=14109 stored=0  missing contains storedTickDocuments
  ok   2026-09-29 PARTIAL  received=5562  stored=0  missing contains storedTickDocuments
  ok   2026-09-28/27/26   NO_DATA (no writer activity, no stored docs)
  ok   periods tile 09:15 -> 15:30 without gaps
  ok   non-COMPLETE report names missing (...)
  info storage: bytes=None reason=AVG_OBJ_SIZE_UNAVAILABLE   (null, not 0)
  all daily-rollup checks passed
```

```
== suites ==
  pytest tests/test_tick_analytics_daily.py tests/test_tick_analytics.py -> 68 passed
  pytest tests -q                    -> 1417 passed, 1 failed (pre-existing)
      FAILED tests/test_ws_engine.py::EngineFacadeTest::test_storage_doc_flattens_full_scrip_surface
      ('3.0.2' != '3.0.7', sdk_version)  -- unrelated to this change
  compileall (4 touched modules)      -> exit 0
  node --test tests/tick-analytics.test.ts -> 28/28
  npm test                            -> 393 tests, 392 passed, 1 failure: pre-existing
      tests/topbar-status.test.ts:331 'INACTIVE' vs 'AUTHENTICATING' (unrelated)
  tsc --noEmit                        -> exit 0
  eslint (lib/tick-analytics.ts, tests/tick-analytics.test.ts, page.tsx) -> 0 errors 0 warnings
  eslint .                            -> 0 errors, 327 pre-existing warnings (none in touched files)
```

## Problems Found

1. **`quality_slice` could serve another day's metrics.**
   `data_quality._cache_key(hours, symbol, extra_match)` does not include
   `start_override`/`end_override`, so two different days built within the
   60 s `_METRIC_CACHE_TTL` collided.
2. **`get_day(refresh=True)` did not rebuild.** For a past day it returned the
   stored document, so `backfill_once()` was re-serving the very document it
   was queued to rebuild. The 7-day backfill was therefore a no-op on stored
   history.
3. **Zero stored documents was reported as `NO_DATA` even with writer
   activity.** Reproduced on real data (`2026-10-01 received=15811
   stored=0`): the day was labelled `NO_DATA`, hiding the gap.
4. **The BFF's legacy `/api/ticks/recent` fallback** would have shown
   unlabelled numbers next to engine metrics.

## Fixes Applied

1. `quality_slice` now passes
   `extra_match={"ts": {"$gte": start, "$lt": end}}` so the cache key varies
   with the requested window.
2. `get_day` skips the stored-document read entirely when `refresh=True`.
3. Added `writer_activity` to `build_day`: activity + no stored docs ⇒
   `PARTIAL`, `missing += storedTickDocuments`, anomaly
   `NO_STORED_DOCUMENTS_FOR_DAY`; `NO_DATA` only when there is no stored doc
   **and** no writer activity. `build_report` mirrors the rule and always
   returns `reason`.
4. Removed the legacy fallback from the BFF `live` section; it now returns
   `PARTIAL` + `missing[]` if any sub-call fails.
5. Frontend: `MISSING_LABELS.storedTickDocuments`, and the daily table renders
   a `PARTIAL` row's `missing[]` chips inline.

## Re-verification

| Fix | Re-run | Result |
| --- | --- | --- |
| 1 cache key | `pytest tests/test_tick_analytics.py tests/test_tick_analytics_daily.py` | 68 passed |
| 2 `refresh` | new test `test_get_day_refresh_rebuilds_instead_of_serving_the_stored_doc` | passed; real 7-day backfill now rebuilds (statuses changed from stale `NO_DATA` to correct `PARTIAL`) |
| 3 `PARTIAL` | new tests `test_report_writer_activity_without_stored_ticks_is_partial_not_no_data` + `test_report_is_no_data_only_when_there_was_no_activity_at_all`; real-data script | passed; `2026-10-01` now `PARTIAL` with `storedTickDocuments` |
| 4 BFF fallback | `tsc` + `eslint` + contract tests | exit 0 / 0 errors / 28-28 |
| 5 UI chips | `node --test tests/tick-analytics.test.ts` (new `a day with writer activity but no stored documents is PARTIAL, not empty`) | 28/28 |
| all | full backend `pytest tests -q` | 1417 passed, 1 pre-existing unrelated failure |

## Final Result

`PASSED_WITH_LIMITATIONS` — every expected behavior above was observed either
against the real MongoDB through real HTTP or in the unit/contract suites.
Limitations: the live backend process on port 8000 still runs the old code
(the endpoint returns 404 there), and browser rendering/responsive behaviour
was not inspected.

## Remaining Risks

- **GAP (restart):** `start_backend.py` holds a named mutex and refuses a
  duplicate instance, so the new routes are not reachable on the live port
  until the operator restarts the backend. Until then `/data-saver/analytics`
  will report its sections as unavailable against the running process.
- **GAP (browser):** no visual/interaction verification was performed.
- **Observation (pre-existing):** `ticks` holds 0 documents while
  `daily_summaries` records real per-day activity. Correctly surfaced as
  `PARTIAL` + `storedTickDocuments`, but the underlying reason was not
  investigated here.

---

## Round 2 � page redesign verification

Scope: *"page ko update kro redesign kro search kam krna chye or details bhi
aane chye"* � verify the redesigned page uses real data, correct field names,
and a working symbol search.

### Method

Static verification against backend source (no guessing of payload keys), then
the compiler/linter/test gates that can run without the restarted live process.

| # | Check | Method | Result |
| --- | --- | --- | --- |
| R1 | New section order matches the task spec | read `page.tsx` render order | pass � Controls ? Today ? Tick Rate ? Daily ? Session/Periods ? Top Symbols ? Selected Symbol ? Persistence ? Quality/Storage ? Report ? History ? Provenance |
| R2 | `symbolStats` field mapping | read `tick_analytics_daily.py:913-921` | pass after fix � `firstTickAt`/`lastTickAt`/`avgRate`/`sharePct` (was `firstAt`/`lastAt`/`avgTickRate`, which always rendered `�`) |
| R3 | Top 10/25/50 actually reaches the backend | `useSection('top',{limit})` ? BFF `collectParams` ? `backendPath` ? `GET /top-symbols?limit=` with `Query(10, ge=1, le=50)` | pass |
| R4 | Daily table shows Skipped / Active duration / Trading Day | new `<th>`+`<td>` wired to `counts.skipped`, `ticks.activeDurationSec`, `tradingDay`/`closureReason` | pass |
| R5 | Selected Symbol no longer shows an empty Depth card | `Depth` StatCard deleted; `Share of Day` + header `exchange`/`token` added | pass |
| R6 | No fabricated per-symbol persisted/failed | footnote states it is not measured; day-level persistence shown elsewhere | pass |
| R7 | Session strip works for any selected date | reads `day.session.*` from `GET /daily/{date}` | pass |
| R8 | `summary`-fed sections read real keys | checked `today`, `rate`, `persistence`, `quality`, `storage`, `session`, `lastTick` against `tick_analytics.summary()` and the four `*_analytics()` functions | pass � `rate.measured`, `sources.current/peak`, `persistence.p95WriteLatencyMs`/`lastFlushAt`/`dropReasons`/`sources.day`, `storage.bytesToday`/`collectionStorageBytes`/`avgBytesPerTick`/`collectionCount`/`indexBytes`, `quality.freshness.ageSec` all exist |
| R9 | Symbol search | `useInstrumentSearch` (debounced) + dropdown + `searchInstruments` exact-match fallback on Enter | pass (wired, unchanged by this round) |
| R10 | No regression from the rewrite | `tsc --noEmit` | 0 errors |
| R11 | No unused/undefined identifiers left behind | `eslint` touched files / `eslint .` | 0 errors, 0 warnings on touched files; 0 errors project-wide (327 pre-existing warnings) |
| R12 | Contract + page tests | `npm test`, `node --test tests/tick-analytics.test.ts` | 393 tests ? 392 pass, 1 pre-existing unrelated failure; tick-analytics 28/28 |
| R13 | Backend suites still green | `pytest tests/test_tick_analytics.py tests/test_tick_analytics_daily.py` | 68 passed |

### Round 2 Final Result

`PASSED_WITH_LIMITATIONS` � every claim above is compiler- or source-verified.
Same two limitations as round 1: the live process still serves old code
(restart outstanding), and no browser inspection was performed.
