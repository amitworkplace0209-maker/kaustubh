# 024 — Tick Analytics: operational + historical tick analytics (0-to-1)

- **Task:** Rebuild `/data-saver/analytics` from zero into a real operational
  **and** historical tick-analytics surface: live pipeline health from real
  telemetry, per-trading-day historical rollups from a pre-aggregated
  collection, an honest completeness report per day, CSV/JSON export, and a
  coalesced realtime feed — with no fake, sample, default or inferred data.
- **Status:** `IMPLEMENTED_AND_VERIFIED_WITH_LIMITATIONS` — backend + frontend
  implemented, unit/contract suites green, and every new REST endpoint driven
  end-to-end against the **real MongoDB** through a scratch FastAPI app (see
  `docs/verification/023-*`). The already-running backend on port 8000 still
  serves the **old** code and was deliberately not restarted (§17).
- **Serial predecessor:** `docs/implementation/023-data-center-full-redesign.md`
- **Date:** 2026-10-02
- **Agent:** OpenCode

---

## 1. Task

Turn the Tick Analytics page into a genuine 0-to-1 system: what the tick
pipeline is doing *right now*, what it did on *each trading day*, and whether
the data behind those numbers is actually complete — backed by the backend,
not by a chart full of zeros.

## 2. Objective

- One page answering: is the feed alive, at what rate, is persistence keeping
  up, where does latency sit, how big is storage, is data quality holding —
  and, historically, what did each trading day look like.
- Every number produced by the backend engine, labelled with its provenance.
- Every unmeasurable metric rendered as `—` and listed in `missing[]`.
- Every report carries an explicit `COMPLETE | PARTIAL | NO_DATA | UNAVAILABLE`
  status; a non-complete report names exactly what is missing.
- Realtime delivered as **one coalesced frame per second** on the existing
  system SSE — never one frame per tick, never a new socket.

## 3. Scope

**Backend**

- `services/tick_analytics_daily.py` (new) — daily rollup, report, backfill.
- `services/tick_analytics.py` — composition layer for the live snapshot.
- `api/tick_analytics.py` — 14 new routes + CSV/JSON export (8 legacy kept).
- `app.py` — backfill loop, realtime publisher, startup/shutdown wiring.
- `tests/test_tick_analytics_daily.py` (new).

**Frontend**

- `app/(phase2)/data-saver/analytics/page.tsx` — rebuilt 0-to-1.
- `app/api/phase2/analytics/route.ts` — section-scoped BFF proxy (rewritten).
- `lib/tick-analytics.ts` (new) — shared section contract + pure helpers.
- `lib/backend.ts` — `backendText()` for raw CSV passthrough.
- `components/realtime-provider.tsx` — `tickAnalytics` / `tickAnalyticsEpoch`.
- `tests/tick-analytics.test.ts` (new).

**Documentation**

- `docs/engines/TICK_ANALYTICS.md` (new), this record, the verification record,
  `docs/logs/LOG-006-*`, `docs/opencode/004-*`, `docs/api/API_CATALOG.md`,
  `docs/FINAL_REPORT.md`.

## 4. Out of Scope

- **No broker feed change, no WebSocket Engine change, no DB Writer change, no
  tick write, no order/session/subscription change.** This engine is a
  read-only consumer of their telemetry.
- **No new WebSocket and no new broker socket.** Realtime rides the existing
  system SSE.
- No raw-`ticks` aggregation on any request path (the table reads
  `tick_analytics_daily` only).
- No new navigation entry, no new page, no tab redesign beyond this route.
- Not restarting the live backend (§17).

## 5. Source Documentation Read

- `PROJECT_IMPLEMENTATION_RULE.md` — honesty contract (§21), no fake data,
  architecture-first, trace-before-change, implementation/verification record
  formats (§14, §16).
- `docs/implementation/022-*`, `023-*` — record format, Data Center contract,
  "read the real contract before mapping".
- `docs/verification/022-*` — verification method (scratch app + real HTTP).
- `docs/opencode/003-data-quality-forensic-trace.md` — the
  `_cache_key` collision class (§10.7).
- `docs/engines/db_writer_engine_detailed.md`, `docs/engines/DATA_QUALITY.md`,
  `docs/engines/websocket-engine.md` — ownership boundaries.
- `docs/api/API_CATALOG.md`, `docs/FINAL_REPORT.md`.

## 6. Existing State

- Route `/data-saver/analytics` existed but was a thin, partly synthetic
  surface: no historical layer, no per-day completeness, no export, no
  section-scoped failure isolation.
- `services/tick_analytics.py` already held the *live* piece
  (`live_state`/`metrics`/`timeseries`/`symbol`/`depth`/`market-wide`) and the
  8 legacy routes still had to keep working.
- `daily_summaries` already carried restart-safe per-IST-day counters — the
  natural restart-safe source for "how many ticks arrived today".
- `market_calendar` already defined OPEN 09:15 / CLOSE 15:30, so session
  boundaries were never to be hardcoded.
- Frontend already had `components/realtime-provider.tsx` consuming the system
  SSE, and a TopBar indicator contract
  (`lib/topbar/context-registry.ts` → `[net, api, feed, ws, pipeline, db]`,
  actions `['refresh']`) that the page must satisfy.

## 7. Problems Found

1. **No historical layer.** Nothing pre-aggregated per trading day; building a
   day on the request path would have meant scanning raw `ticks`.
2. **`data_quality._cache_key(hours, symbol, extra_match)` does not include
   `start_override`/`end_override`.** Building two *different* days inside the
   60 s `_METRIC_CACHE_TTL` would silently return the other day's metrics.
3. **`get_day(refresh=True)` did not refresh.** For a past day it returned the
   stored document, so a queued backfill would "rebuild" by re-serving the
   stale document it was queued to rebuild.
4. **Zero stored documents was reported as `NO_DATA` even when the writer had
   recorded activity** (real case in this environment: `daily_summaries` shows
   15 811 ticks on 2026-10-01 while `ticks` holds 0 documents). `NO_DATA`
   hides the fact that data arrived.
5. **A legacy `/api/ticks/recent` fallback in the BFF** would have presented
   unlabelled numbers alongside engine metrics — a provenance violation.
6. **Per-section failure coupling**: a single fetch failure took down the whole
   page, which invites a "show 0 instead" fallback.
7. **Unbounded/serial HTTP fan-out** on the page: every poll hit every endpoint
   together.

## 8. Design Decision

- **Two layers, one contract.** `tick_analytics_daily` (stored per-day
  documents, built in the background) for history; `tick_analytics` (live
  composition over telemetry) for now. Both surface through one section
  vocabulary declared in `lib/tick-analytics.ts` and shared by page, BFF and
  backend (`backendPath`/`sectionQuery`), so a section name can never drift
  between the three.
- **Backfill, never on-request.** `list_days()` reads stored documents only and
  queues what is absent; a background loop builds ≤2 days every 8 s.
- **`refresh=True` means rebuild.** The stored document is skipped entirely.
- **`NO_DATA` ⇔ zero stored docs AND zero writer activity.** Otherwise the day
  is `PARTIAL` with `storedTickDocuments` in `missing[]`, plus a
  `NO_STORED_DOCUMENTS_FOR_DAY` anomaly.
- **Realtime = coalesced, gated, existing channel.** ~1 Hz
  `{"type":"tick_analytics"}` on the system SSE, built only while
  `state_store.client_count() > 0`.
- **Conservative merge.** `mergeLive()` drops explicit nulls/undefined from a
  realtime frame and never writes `0` over a REST value.
- **Single-flight BFF.** Concurrent requests for the same section share one
  upstream call (`inflight` map), and an upstream failure returns
  `status: 'UNAVAILABLE'` + `missing: [reason]` — never a fabricated payload.

## 9. Files Changed

| File | Change |
| --- | --- |
| `python-service/services/tick_analytics.py` | composition helpers: `_buf_stats`, `_ws_status`, `_telemetry_minutes`, `_telemetry_rate`, `rate_analytics`, `persistence_analytics`, `_write_latency`, `source_analytics`, `storage_analytics`, `quality_analytics`, `symbol_tick_stats`, 5 s `summary()` cache, `latency_block`, `live_event`, `invalidate_summary_cache`; added `timedelta` import |
| `python-service/services/tick_analytics_daily.py` | daily rollup engine; honesty fix §10.3–10.4; `refresh` fix §10.2 |
| `python-service/api/tick_analytics.py` | +14 routes, CSV/JSON export helpers |
| `python-service/app.py` | holder, `_tick_analytics_publish_loop`, `_tick_analytics_backfill_loop`, startup registration, shutdown cancel |
| `app/api/phase2/analytics/route.ts` | rewritten as section-scoped single-flight BFF proxy; legacy fallback removed |
| `lib/backend.ts` | `backendText()` |
| `components/realtime-provider.tsx` | `tickAnalytics`, `tickAnalyticsEpoch` |
| `app/(phase2)/data-saver/analytics/page.tsx` | rebuilt 0-to-1 |
| `docs/api/API_CATALOG.md`, `docs/FINAL_REPORT.md` | route count / change history |

## 10. Files Created

- `python-service/services/tick_analytics_daily.py`
- `python-service/tests/test_tick_analytics_daily.py`
- `lib/tick-analytics.ts`
- `tests/tick-analytics.test.ts`
- `docs/engines/TICK_ANALYTICS.md`
- `docs/implementation/024-tick-analytics-operational-and-historical-analytics.md`
- `docs/verification/023-tick-analytics-operational-and-historical-analytics-verification.md`
- `docs/logs/LOG-006-2026-10-02-tick-analytics.md`
- `docs/opencode/004-tick-analytics-trace.md`

### Files Removed

None.

## 11. Backend Changes

### 11.1 Daily rollup (`tick_analytics_daily`)

Public surface: `day_window`, `recent_days`, `is_today`, `_iso/_fnum/_int/
_safe_div/_pct`, `ensure_indexes`, `session_boundaries`, `build_periods`,
`_minute_index`, `reduce_seconds`, `_sorted_percentile`, `minute_rollup`,
`fold_periods`, `fold_minute_symbols`, `build_report`, `_writer_counters`,
`db_writer_session_counters`, `quality_slice`, `latency_slice`, `storage_slice`,
`_aggregate_day`, `_empty_doc`, `build_day`, `_persist`, `get_day`,
`list_days`, `top_symbols`, `symbol_day`, `queue_backfill`, `backfill_once`,
`backfill_state`, `reset_state`.

- Unique index on `date`; `TODAY_TTL_SEC = 45`;
  `EXPENSIVE_DAY_DOC_LIMIT = 1_500_000`; `DEFAULT_DAYS = 30`; `MAX_DAYS = 366`;
  `SUMMARY_FIELDS` projection.
- `build_day` returns `status: "UNAVAILABLE"` +
  `missing: ["MONGO_NOT_CONNECTED"]` when Mongo is down.
- `backfill_once` re-queues on `UNAVAILABLE`/exception; a day is marked
  `completed` only after a successful build.

### 11.2 Problems fixed

1. *(§7.2)* `quality_slice` passes
   `extra_match={"ts": {"$gte": start, "$lt": end}}` so the cache key varies
   with the window even though `start_override`/`end_override` are not part of
   it.
2. *(§7.3)* `get_day` now skips the stored-document read entirely when
   `refresh=True`.
3. *(§7.4)* Writer activity without stored documents ⇒ `PARTIAL` +
   `storedTickDocuments` in `missing[]` + `NO_STORED_DOCUMENTS_FOR_DAY`
   anomaly; `build_report` mirrors the same rule and always returns `reason`.

### 11.3 Composition layer

`summary()` (5 s cache) assembles `status.code`, `today`, `rate`,
`persistence`, `quality`, `storage`, `latency`, `sources`, `backfill`,
`generatedInMs`. `live_event()` is the coalesced frame payload.

## 12. Frontend Changes

- **`lib/tick-analytics.ts`** — `SECTIONS`/`SectionId`/`PATH_PARAM_KEYS`/
  `QUERY_PARAM_KEYS`/`backendPath`/`sectionQuery`/`isSectionId`; honesty
  helpers `num`, `honest`, `fmtNumber`, `fmtCompactNum`, `fmtRate`, `fmtBytes`,
  `fmtIST*`, `ageSec`; `missingChips` + `MISSING_LABELS`, `statusTone`,
  `statusLabel`, `dailyRowStatus`, `persistenceTone`, `duplicateTone`;
  chart mappers `dailyChartSeries`, `periodChartSeries`, `topSymbolSeries`;
  `reportSummary`, `sourceChips`, `mergeLive`.
- **Page** — `useSection<T>()` (independent fetch/error/loading/reload +
  AbortController per section), `buildSnapshot()` conservative merge, and:
  `ControlsCard`, `SnapshotCards`, `SessionHealth`, `DailySection`,
  `PeriodsSection`, `TopSymbolsSection`, `SelectedSymbolSection`,
  `ReportSection`, `ReportHistorySection`, `Methodology`, `MiniBarChart`.
  The daily table renders a `PARTIAL` row's `missing[]` chips inline so a day
  that received ticks but stored none is visibly explained.
- **BFF** — sections `summary|daily|day|top|symbolStats|report|reports|export|live`,
  `400` on `UNKNOWN_SECTION`, `upstreamError → status:'UNAVAILABLE' +
  missing:[reason]`, `backendText` passthrough with `Content-Disposition` for
  CSV.
- **No fake controls**: the TopBar action set stays `['refresh']` — no invented
  Live/Pause action.

## 13. Database Changes

- **New collection `tick_analytics_daily`** (analytics rollup), unique index on
  `date`. Written only by this engine.
- No change to `ticks`, `daily_summaries`, `data_saver_telemetry`, or any
  writer collection. No TTL/expiry change.

## 14. API Changes

14 new routes under `/api/data-saver/tick-analytics`:
`GET /summary`, `/daily`, `/daily/{date}`, `/top-symbols`,
`/symbol-stats/{symbol}`, `/rate`, `/persistence`, `/sources`, `/storage`,
`/quality`, `/latency`, `/report`, `/reports`, `/export?format=csv|json`.

The 8 legacy routes are unchanged and remain mounted (total 22).

## 15. Realtime Changes

- New frame `{"type":"tick_analytics","timestamp":...,"data":{...}}` published
  on the **existing** system SSE at ~1 Hz, gated on
  `state_store.client_count() > 0`.
- No new WebSocket, no new route, no broker socket.

## 16. Scheduler / Lifecycle Changes

- `app.py`: `_tick_analytics_task_holder = {"backfill": None, "publish": None}`,
  `_TICK_ANALYTICS_INTERVAL_SEC = 1.0`, `_TICK_ANALYTICS_BACKFILL_SEC = 8.0`.
- Startup: queue `recent_days(30)`, then create both tasks (wrapped, logs
  `Tick Analytics backfill + realtime publisher: STARTED`).
- Shutdown: cancel both tasks with `contextlib.suppress(CancelledError)` and a
  3 s `wait_for(asyncio.shield(...))`, then clear the holder.

## 17. Documentation Changes

- Created `docs/engines/TICK_ANALYTICS.md`, this record, `verification/023-*`,
  `logs/LOG-006-*`, `opencode/004-*`.
- Updated `docs/api/API_CATALOG.md` (router registry count 9 → 22, route
  index) and `docs/FINAL_REPORT.md`.

## 18. Tests

**Backend — `tests/test_tick_analytics_daily.py` (36 tests):** numeric honesty
(`_fnum` rejects non-finite, `_safe_div`/`_pct` never return 0 on an empty
denominator), `day_window`, `recent_days`, `is_today`, `session_boundaries`
(from `market_calendar`, including a closed day), `build_periods` tiling,
`_minute_index` leniency, `reduce_seconds`, `_sorted_percentile`,
`minute_rollup`, `fold_periods` (incl. zero only for genuinely empty periods),
`fold_minute_symbols`, report honesty (`NO_DATA`/`PARTIAL`/`COMPLETE` +
exact `missing[]`, writer-activity-without-docs ⇒ `PARTIAL`, no-activity ⇒
`NO_DATA`), `get_day(refresh=True)` rebuilds, `db_writer_session_counters`,
`latency_slice`, `storage_slice`, backfill bookkeeping, router route surface,
CSV helpers.

**Backend — `tests/test_tick_analytics.py` (32 tests)** must stay green.

**Frontend — `tests/tick-analytics.test.ts` (28 tests):** section contract,
path/query param separation, honesty contract (`num`/`honest`/`fmt*`), tones,
`dailyRowStatus` (BACKFILLING vs NO_DATA vs PARTIAL), `missingChips` labels,
chart series null preservation, `reportSummary`, `sourceChips`, `mergeLive`
never zero-filling.

## 19. Test Results

| Suite | Result |
| --- | --- |
| `pytest tests/test_tick_analytics_daily.py tests/test_tick_analytics.py` | **68 passed** |
| `pytest tests -q` (full backend) | **1417 passed, 1 failed** — the failure is the pre-existing unrelated `tests/test_ws_engine.py::test_storage_doc_flattens_full_scrip_surface` (`'3.0.2' != '3.0.7'`) |
| `python -m compileall` (touched modules) | exit 0 |
| `node --test tests/tick-analytics.test.ts` | **28/28** |
| `npm test` (all frontend) | 393 tests, **392 passed / 1 failure** — pre-existing unrelated `tests/topbar-status.test.ts:331` (`INACTIVE` vs `AUTHENTICATING`) |
| `tsc --noEmit` | exit 0 |
| `eslint` (touched files) | 0 errors, 0 warnings |
| `eslint .` | 0 errors (327 pre-existing warnings, none in touched files) |
| REST smoke over real MongoDB (scratch FastAPI app) | **all checks passed** — see `verification/023` |
| Daily backfill against real MongoDB | 7 days queued → built in ~1 s, all statuses honest |

## 20. Verification

Full record: `docs/verification/023-tick-analytics-operational-and-historical-analytics-verification.md`.

Verified: route registration (22), every new endpoint answering 200 over real
HTTP with JSON-safe bodies, honesty of `summary`/`daily`/`report`/`export`,
invalid-date degradation, CSV header, real backfill run against the live
MongoDB, `refresh` rebuild, and the `PARTIAL`-not-`NO_DATA` rule on real data.

## 21. Remaining Issues

- The backend process running on port 8000 (`pid` from `start_backend.py`)
  still executes the pre-change code, so `/api/data-saver/tick-analytics/*`
  answers **404 in the live process** until it is restarted. `start_backend.py`
  refuses a second instance (named mutex + port-8000 probe), so restarting
  requires stopping the current process — **deliberately not done here**.
- `ticks` currently holds 0 documents while `daily_summaries` records real
  activity. That is an existing environment/pipeline condition, surfaced
  honestly as `PARTIAL` + `storedTickDocuments`; it is *not* caused by this
  change and is not fixed by it.
- Browser-level rendering and responsive behaviour were not inspected in a
  browser in this session.

## 22. Pending Work

- Restart the backend (with the operator's confirmation) and re-run the REST
  smoke against the live port so the page is served by the new code.
- Browser inspection of `/data-saver/analytics` at 375 / 768 / 1440 / 1920 px.
- Investigate why `ticks` is empty despite writer counters (outside this
  change's scope; tracked as an observation, not a fix).

## 23. Final Status

`IMPLEMENTED_AND_VERIFIED_WITH_LIMITATIONS` — implemented across backend and
frontend, unit/contract suites green, end-to-end REST verified against the
real MongoDB through a scratch app; live-process restart and browser
inspection outstanding (§21–§22).

---

## 24. Round 2 � page redesign (working search + real detail density)

Second pass on the same feature, requested as: *"page ko update kro redesign kro
search kam krna chye or details bhi aane chye"* � the page must actually search
and must show real detail instead of placeholders.

### 24.1 Section order (page now renders in task-spec order)

Controls + status ? **Today** ? **Tick Rate** ? **Daily Tick Analytics** ?
**Session & Time-Period Activity** ? **Top Symbols** ? **Selected Symbol** ?
**Tick Persistence** ? **Quality & Storage** ? **Report** ? **Report history** ?
**Provenance footer**.

`SnapshotCards` and `SessionHealth` were folded into `TodaySection` /
`ProvenanceFooter`; the old `Methodology` block was deleted (its content lives
in `ProvenanceFooter`), so no panel renders twice.

### 24.2 What was fixed

| Problem | Fix |
| --- | --- |
| Top Symbols showed `�` for First/Last/Avg | field mapping corrected to `firstTickAt` / `lastTickAt` / `avgRate` (the actual `symbolStats` keys) |
| No way to widen the ranking | Top **10 / 25 / 50** selector wired to `useSection('top', { limit })`; backend clamps to `1..50` |
| Daily table hid Skipped / Active duration / Trading Day | three columns added (`counts.skipped`, `ticks.activeDurationSec`, `tradingDay` + `closureReason`) |
| Selected Symbol showed an always-empty **Depth** card | removed (depth is not in the tick-analytics payload); replaced with **Share of Day** + `exchange` / `instrumentToken` in the header |
| `PER-SYMBOL persisted/failed` was requested but is not measured | not faked � a footnote states day-level persistence is the authority |
| Session facts only appeared for "today" | session-analysis strip (market open / first tick / peak / lowest / last tick / market close / active duration) added to the day section so it works for any selected date |
| `allowed[]` in the BFF 400 body was a stale hard-coded list | now derived from `SECTIONS` |

### 24.3 Field verification (source-read, not guessed)

Every field the new sections read was checked against the backend source:
`summary().today|rate|persistence|quality|storage|session|lastTick`,
`rate_analytics()`, `persistence_analytics()`, `quality_analytics()`,
`storage_analytics()`, `top_symbols()` and `symbol_tick_stats()`. Fields that do
not exist (`symbolStats[].peakTickRate`, `symbolStats[].persisted`,
`summary.wsConnected`, per-source `received`/`persisted`) are either not
rendered or rendered as `�` � never as 0.

### 24.4 Round-2 files changed

- `app/(phase2)/data-saver/analytics/page.tsx` � restructured sections, new
  `TodaySection` / `TickRateSection` / `PersistenceSection` /
  `QualityStorageSection` / `ProvenanceFooter`, `topLimit` state, `TODAY_STATUS`
  + `FEED_TONE` constants, `MiniStat.sub`, Top/Selected/Daily fixes.
- `app/api/phase2/analytics/route.ts` � `allowed[]` derived from `SECTIONS`.
- `docs/engines/TICK_ANALYTICS.md` � section table corrected.

### 24.5 Round-2 test results

- `tsc --noEmit` ? 0 errors.
- `eslint` on touched files ? 0 errors, 0 warnings; `eslint .` ? 0 errors
  (327 pre-existing warnings).
- `npm test` ? 393 tests, 392 pass, 1 pre-existing unrelated failure
  (`tests/topbar-status.test.ts:331`).
- `pytest tests/test_tick_analytics.py tests/test_tick_analytics_daily.py` ?
  68 passed.

### 24.6 Still outstanding

Identical to �21��22: live-process restart, browser inspection at
375 / 768 / 1440 / 1920 px, and the pre-existing empty-`ticks` observation.
