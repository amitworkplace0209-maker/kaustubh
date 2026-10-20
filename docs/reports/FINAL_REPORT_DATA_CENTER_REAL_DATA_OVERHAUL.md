# FINAL REPORT — Data Center Rebuild (Real Data, One Store, Split Cadence)

Date: 2026-09-10
Scope: `app/(phase2)/data-saver/data-center` page rebuilt so every number is a
real Mongo/backend measurement, the page renders exactly two meaningful charts,
polling is consolidated into one canonical store with per-section cadences, and
no fabricated data appears anywhere (missing values render `—`/N/A, never 0).

---

## 1. WHAT ACTUALLY WAS WRONG (found during this pass)

1. **Daily-history scheduler counts were silently always `0`.**
   The overview aggregation counted `schedule_runs`, but real documents live in
   `scheduler_runs` and carry the business-date in `business_date`
   (`schedule_runs` has no such field — it uses `runAt` + `idempotencyKey`
   like `…:2026-09-10`). Result: `_daily_write_history_impl` counted zero
   scheduler runs for every day; the page showed `0/0` regardless of the 16
   real `scheduler_runs` documents (indexed `business_date_-1_job_id_1`,
   `status_1_business_date_-1`).
2. **API telemetry had no consumer in Data Center** — the per-day request/error
   columns were backfilled from `api_telemetry` only inside daily history, and
   there was no overview of requests/errors/latency for the page.
3. **Three stub/quality issues in the page I inherited**: `s.days` referenced
   inside components with no `s` in scope (compile error), an invalid
   `legacyshim` prop on `<Link>`, and an expanded-day row emitted through a
   fragment of `<td>`s + `<tr>` directly under `<tbody>` (invalid DOM).
4. **Unused tick-volume aggregate kept being fetched** even though the page no
   longer renders it (the plan: "return only needed data").

---

## 2. FILES CHANGED

### Backend (python-service)
| File | Change |
|---|---|
| `services/data_center.py` | `_daily_write_history_impl` aggregates **`db.scheduler_runs`** by `business_date`/`status` (COMPLETED→completed; FAILED/ERROR/MISSED_EXPIRED→failed). Memoized TTL wall unchanged. |
| `api/data_center.py` | `TTL_OVERVIEW` 5.0→**20.0** (frontend live poll 15s now always hit the cache); new `TTL_API_TELEMETRY = 20.0`; new `GET /api/system/data-center/api-telemetry?hours=&limit=` returning the real `services/ds_insights.api_telemetry_summary` + `recentErrors`; helpers `_recent_telemetry_errors(limit)` and `_ts_iso()`. |

### Frontend (Next.js)
| File | Change |
|---|---|
| `app/api/phase2/data-center/route.ts` | `sections` query param (`parseSections`) → the proxy gathers only the requested group in one round-trip (`overview` for the live poll; the slow set for the 60s poll); per-section timeout map; `api-telemetry` section exposed with camelCased key `apiTelemetry`; `ms` metric. |
| `lib/data-center.ts` | New types `DcApiTelemetry`/`DcApiEndpoint`/`DcApiErrorRow`; `DcCanonicalStatus` + `canonicalTone`; `normalizeApiTelemetry`/`normalizeApiEndpoint`/`normalizeApiErrorRow`; `normalizeDcEnvelope` now also returns `present: DcSectionKey[]` (merge-in-place signal); `validSeries<T extends object>()` (drops bad-timestamp/all-invalid/duplicate-timestamp points, sorts ascending); `deriveStatusStrip(ov)` → 8 canonical-state tiles with real destinations. |
| `lib/data-center-store.ts` | Rewritten: **split cadence** — `POLL_LIVE_MS` 15s (overview only, backend-cache served) and `POLL_SLOW_MS` 60s (history/trend/snapshots/api-telemetry); `FETCH_SECTIONS` excludes the unrendered `ticks` aggregate; `setWindow(7\|14\|30)` refetches all; `setAutoRefresh(on)`; lazy start (poll only after first subscriber) + real cleanup (last unsubscribe → `stopTimers()` clears intervals **and aborts in-flight**, keeps last valid payload so a remount shows data instantly); `applyEnvelope` applies only `present` sections (a slow section never blanked by a live round). |
| `app/(phase2)/data-saver/data-center/page.tsx` | Fully rebuilt. New pieces: `StatusStrip` (8 tiles from `deriveStatusStrip`, Link-wrapped to real pages), `SystemSummary` (8 StatCards + last-event strip), `ControlBar` (7/14/30d range, auto-refresh pause, refresh, table search, clear filters, live-snapshot CSV/JSON export), `DailyHistoryChart` (bar + unique-symbols line) and `StorageTrendChart` (DB storage / indexes / disk) — the only two charts — both through `validSeries`, `DailyWriteTable` (sortable columns, "only days with data", expandable IST row details, honest `—` for not-measured API/scheduler days), `CollectionsMonitor` (health filter, sortable name/docs/storage, Show-all) + `CollectionDetailSheet` (radix Sheet, right side), `ApiTelemetryPanel` (requests/errors/error-rate/avg/p50/p95/p99 + per-endpoint table + recent erroring buckets), `WsPipelinePanel`, `WorkersTable`, `EventsList` (severity + source filters), `SnapshotsTable`. Fixed the three quality issues (§1.3). |

---

## 3. ARCHITECTURE AFTER

```
page (/data-saver/data-center)          ONE canonical store (lib/data-center-store)
  └─ useSyncExternalStore subscription     live  : overview ................ 15s   (TTL 20s cached)
      liveTimer / slowTimer                slow  : history/trend/snapshots/api-telemetry  60s
      lazy start, stop+abort on leave      initial: full snapshot (FETCH_SECTIONS, no ticks)
        └─ /api/phase2/data-center?sections=… (single round-trip per cadence)
            └─ parallel backendFetch per section (per-section timeouts)
                └─ backend data-center API (TTL cache: overview 20s, api-telemetry 20s, history/trend memoized)
```

- One shared store per page; each cadence merges only its own group (never
  blanks another), single-flight on the proxy, backend TTLs make the 15s live
  poll a cached read (10–14ms).
- Every time value on page and in charts is rendered through `fmtIst`/`shortDate`
  (Asia/Kolkata); a pointer line labels the whole page "Generated … IST".
- Real-time channel stays the shared SSE elsewhere; this page uses timed
  polling only (live 15s / slow 60s) and creates **no** page WebSocket/SSE.

---

## 4. DATA VERIFICATION (live, unauthenticated API surface)

### 4.1 The scheduler-count bug is fixed (real rows now populate)
`GET /api/system/data-center/overview?days=14` → 14 real daily rows:

```
2026-08-28 ticks=56,585  sched=0/0           2026-09-05 ticks=0     apiReq=20,611  ev=611   (Saturday, telemetry starts 09-05)
2026-08-31 ticks=91,938  sched=0/0           2026-09-07 ticks=71,973 sched=1/4              (scheduler runs now REAL)
2026-09-01 ticks=172,757 sched=0/0           2026-09-08 ticks=137,380 sched=4/4
2026-09-02 ticks=140,135 sched=0/0           2026-09-09 ticks=117,410 sched=4/4
2026-09-04 ticks=52,820  sched=0/0           2026-09-10 ticks=33,167  sched=2/4   apiReq=4,035
```

- Ticks written match per-day persistence; weekend days are honestly `0` ticks
  with real event counts; `api` columns are honest zeros until the telemetry
  collection goes live on 2026-09-05 (pre-09-05 rows render `—`, never fake 0).

### 4.2 api-telemetry endpoint (new, real field names confirmed)
`GET /api/system/data-center/api-telemetry?hours=24&limit=5` → 200.
Top: `hasData=true requests=11,473 errors=242 p95Ms=2000 dbRelatedFailures=0`.
`endpoints[0]` keys: `route, requests, errors, clientErrors, serverErrors,
success, successPct, avgMs` (real: `/api/system` req=2286 successPct=100
avgMs=557.19). `recentErrors[0]` keys: `ts, route, errors, clientErrors,
serverErrors, avgLatencyMs, dbRelated` (ts `2026-09-09T20:08:41Z`).
**These match `normalizeApiTelemetry`/`normalizeApiEndpoint`/`normalizeApiErrorRow`
one-to-one — the earlier "unverified field-name" risk is closed.**

### 4.3 Proxy honours `sections` (exact store URL)
`/api/phase2/data-center?days=14&sections=overview,history,trend,snapshots,api-telemetry`
→ body keys `ok, generatedAt, params, ms, overview, history, trend, snapshots, apiTelemetry`
(no `ticks`). URL-encoded comma form (what `URLSearchParams` produces) also
works. `apiTelemetry.ok=true hasData=true`.

### 4.4 Performance (cadences cannot stack)
- Live poll (overview only): first cold call 10.6s (TTL cache empty) → **10–14ms
  warm** (backend overview TTL 20s serves the 15s poll).
- Slow poll (history/trend/snapshots/api-telemetry): **~50ms** warm.
- CSV export: 200, `text/csv`, attachment `data-center-daily-20260910-080512.csv`,
  truthful header + real rows. JSON export: 200, 14 real rows.
- Collection detail: `/api/phase2/data-center/collections/ticks` → count 1,463,986, indexes 4.

### 4.5 Status-strip destinations all resolve
- `mongo → #collections` (on-page anchor), `websocket → /data-saver/websocket`,
  `pipeline → /data-saver/ticks`, `scheduler → /data-saver/schedules`,
  `api → /data-saver/insights/activity`, `storage → /data-saver/settings/storage`
  — every route directory exists. `internet`/`backend` intentionally have no
  page (`href: null`), so they render as plain tiles.
- Page route resolves (unauthenticated request → 307 to `/login?from=…`, i.e.
  the PIN gate — **not** a 500/compile error).

---

## 5. TESTS

| Check | Result |
|---|---|
| Frontend `npm run typecheck` | **PASS** (0 errors) |
| Frontend `npm run lint` | **PASS** (0 errors; the 4 warnings I introduced were removed: unused `canonicalTone`/`q`/`FilterState`/`force`) |
| Frontend `npm test` | **PASS 64/64** (+5 new: `validSeries` ×2, `normalizeApiTelemetry` ×2, envelope `present` section-merge) |
| Frontend `npm run build` | **PASS** — `✓ Compiled successfully`; `/data-saver/data-center` built, all `/api/phase2/data-center*` routes built |
| Backend `pytest tests/test_data_center.py` | **PASS 25/25** (fixture `schedule_runs`→`scheduler_runs`; +5 new api-telemetry tests incl. `_recent_telemetry_errors` + `_ts_iso`) |
| Backend full `pytest` | **345 PASS / 1 FAIL** — the only failure is the documented pre-existing `test_dummy_session.py::test_order_is_session_stamped` (fails identically without any of these changes) |
| Runtime (backend restarted on port 8000, verified) | backend single instance PID 17896; overview/api-telemetry/export/collections all 200 with real data (§4); frontend dev server restarted on port 3000 |

---

## 6. REMAINING / NOT VERIFIED

- **Browser visual/interaction pass** (charts render, collection drawer,
  sortable columns, mobile/PWA, live 15s/60s tick visible) — the page sits
  behind the PIN gate (`/login?from=…`), so headless verification is not
  possible without the user's authenticated session. All data layers feeding
  the page are verified above; the in-browser check is the one remaining
  manual step.
- **Live Kotak broker end-to-end** — credential-gated; system/Mongo data is
  verified, broker-triggered trading flows remain NOT VERIFIED (out of scope
  for this Data Center pass).

## 7. SERVERS LEFT RUNNING

- Backend: `python start_backend.py run` — PID **17896**, port **8000**
  (logs `%TEMP%\opencode\backend_stdout3.log` / `backend_stderr3.log`).
- Frontend: `npm run dev` — PID **29972**, port **3000**
  (logs `%TEMP%\opencode\frontend_stdout3.log` / `frontend_stderr3.log`).
```