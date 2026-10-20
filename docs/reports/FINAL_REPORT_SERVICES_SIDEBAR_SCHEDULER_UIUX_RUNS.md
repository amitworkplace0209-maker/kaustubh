# FINAL REPORT — SERVICES SIDEBAR + SCHEDULER UI/UX + SCHEDULER RUNS PAGE (PRODUCTION UI REFACTOR)

> Completed: 2026-09-21.
> Scope: every Services sidebar item is now a real route; Scheduler becomes an operational Overview with a dedicated Runs page; all pages render **real backend data only** (no mock / fake / static data).

---

## 1. What was delivered

### 1.1 Scheduler Engine — five linked pages (`/services/scheduler/*`)

| Page | Route | Real data from |
|------|-------|----------------|
| **Overview** | `/services/scheduler` | `/api/services/engines/scheduler_engine` (WS#2 realtime + one-shot), `/api/scheduler/status`, `/api/scheduler/readiness`, `/api/scheduler/summary`, `/api/scheduler/history`, `/api/schedule-events/stream` (SSE) |
| **Lifecycle** | `/services/scheduler/lifecycle` (new) | `/api/scheduler/status` (canonical runtime state, phase, state sine, next event, today's schedule, last transition) |
| **Timeline** | `/services/scheduler/timeline` | `/api/scheduler/status`, `/api/scheduler/readiness`, `/api/scheduler/summary` |
| **Runs** | `/services/scheduler/runs` (new) | **NEW** `/api/scheduler/runs` (filtered + paginated) + `/api/scheduler/runs/{run_id}`, refetch on schedule-event SSE frames |
| **Ledger** | `/services/scheduler/ledger` | `/api/scheduler/summary`, `/api/scheduler/history` |

- The **Runs page** is the operational core: server-side filters (business date, job, status-bucket select, trigger, schedule, free-text search, failed-only, catch-up-only), server-side sort (7 whitelisted keys + asc/desc), server-side pagination (page input, First/Prev/Next/Last, pages/total), a sticky-header table with the spec columns, a run-detail drawer (`Sheet`) that fetches the real run by id, and LIVE/OFFLINE + **Last updated: HH:MM:SS IST** + **STALE DATA** badges. "Next retry" is displayed as an honest `—` (no retry scheduling exists; reconcile re-evaluates each window) with a tooltip explaining exactly that.
- The **Overview** gained the spec §5 global operational banner: **RUNNING / DEGRADED / STOPPED** derived from the real scheduler state (canonical mapping in `STATE_OP`), the primary state badge, current phase chip, and a "Next action" line (next event / next phase / next tick collection).
- The **Lifecycle** page renders the real runtime-state journey as a 5-stage rail (Login → Session → WebSocket feed → Tick collection → Logout) computed from `STATE_STAGE`, with passed/current/failed/pending states, `state since` durations, phase/next-phase, session owner, market/day state, today's schedule instants, and the last real transition (SSE-driven refresh).

### 1.2 Status vocabulary (spec §10/§15, now single-sourced)

Backend is authoritative; `normalize_run` in `python-service/scheduler/persist.py` canonicalizes raw statuses and the frontend only *renders*:

- Canonical display set: `PENDING, DUE, RUNNING, COMPLETED, FAILED, RETRYING, WAITING, ALREADY_SATISFIED, MISSED_SCHEDULE_CATCHUP, SKIPPED`.
- `CATCHING_UP → CATCH_UP`; UI renders `CATCH_UP/CATCHING_UP` as a RUNNING badge + CATCH-UP chip; `WAITING_* → WAITING`; `MISSED_EXPIRED → SKIPPED` (SKIPPED is preserved as SKIPPED and always carries a reason).
- Caught-up rows keep their real completed/already status under the `MISSED_SCHEDULE_CATCHUP` bucket with `catch_up=true` and `trigger=MISSED_SCHEDULE_CATCHUP`.
- Every column is a real backend field. Nothing is invented (verified live: `next_retry: null`, `actual_start: null` for scheduled-but-not-run rows).

### 1.3 New backend surface

- `GET /api/scheduler/runs` — Mongo equality filters for business_date/job_id/schedule_id/trigger; server-side status-bucket expansion; `failed_only`, `catch_up_only`, free-text `search`; whitelisted `sort`; `page`/`page_size` → `{count, pages, total, runs[]}`.
- `GET /api/scheduler/runs/{execution_id}` — single normalized run; honest 404 when missing.
- Implemented in `scheduler/persist.py` (`list_runs`, `normalize_run`, `get_run_by_execution_id`), `scheduler/__init__.py` wrappers, `api/routes.py`; tested in `tests/test_scheduler_runs_api.py`.

### 1.4 Services sidebar IA (target structure)

The one giant "System" group is restructured into four groups. **Every sidebar item is now a real route — zero dead links.**

- **System**: System Status, Session Manager (14 children), WebSocket Engine, Scheduler (**Overview, Lifecycle, Timeline, Runs, Ledger**)
- **Engines**: Feature Engine, Search Engine, Connection Manager (4 children)
- **Data & Storage**: DB Writer, Storage Engine
- **Observability**: System Indicators, **Logs** (dead link fixed — real page + wrapper created, backed by `GET /api/logs`)
- Market / Trading / Security / Monitoring groups unchanged.

### 1.5 Live-update contract (no duplicate polling)

- Scheduler pages consume the pre-existing `/api/schedule-events/stream` SSE through one shared client (`lib/schedule-sse.ts`) and refetch their real data only when a frame lands. WS#2 `useEngineStatus` remains the one-shot/realtime engine source. No polling loops were added.
- Every scheduler page shows a LIVE/OFFLINE badge and **Last updated: HH:MM:SS IST**, turning **STALE DATA** when the realtime channel is quiet >30 s.

---

## 2. Files changed / added

Backend
- `python-service/scheduler/persist.py` — `normalize_run`, `list_runs`, `get_run_by_execution_id`
- `python-service/scheduler/__init__.py` — `get_scheduler_runs`, `get_scheduler_run`
- `python-service/api/routes.py` — `/api/scheduler/runs`, `/api/scheduler/runs/{execution_id}`
- `python-service/tests/test_scheduler_runs_api.py` — 10 test classes/cases

Frontend
- `lib/api.ts` — `getSchedulerRuns`, `getSchedulerRun`
- `lib/schedule-sse.ts` — shared schedule-events SSE client (new)
- `app/_pages/scheduler/scheduler-data.ts` — `RUN_STATUS_OPTIONS`, `RUN_SORT_OPTIONS`, `RUN_VIEW`, `LIFECYCLE_STAGES`, `STATE_STAGE`, `STATE_OP`, `LIFECYCLE_TONE`, `fmtDuration`, `fmtClockIST`, `fmtDateTimeIST`, `useScheduleEvents`
- `app/_pages/scheduler/runs.tsx` (new), `app/_pages/scheduler/lifecycle.tsx` (new)
- `app/_pages/scheduler/page.tsx` (Overview revision), `ledger.tsx`, `timeline.tsx` (aligned to the runs contract + links)
- Wrappers: `app/(services)/services/scheduler/runs/page.tsx`, `…/lifecycle/page.tsx` (new); `app/(services)/services/logs/page.tsx` (new)
- `app/_pages/logs/page.tsx` (new — real `/api/logs`)
- `components/layout/nav.ts` — SERVICES sidebar IA + scheduler children (id changes: `scheduler-overview` at parent URL, `scheduler-lifecycle`, `scheduler-timeline`, `scheduler-runs`, `scheduler-ledger`)
- `tests/nav-utils.test.ts` — SCHEDULER fixture + tests extended

Docs
- `docs/PHASE_ENGINE_UI_MAPPING.md` — Scheduler Engine row updated (this report)

---

## 3. Verification (all green)

| Check | Result |
|-------|--------|
| Backend pytest (scheduler suites) | **80 passed** |
| Backend pytest (full suite) | **854 passed** |
| Frontend `node --test` | **262 passed** (18 nav-utils, incl. new runs/lifecycle routes) |
| eslint (all changed files) | clean, 0 errors |
| `tsc --noEmit` | only the **pre-existing** `components/kotak/pages/risk.tsx` broken JSX (untracked, not touched here) |
| Live SSR of new routes | `/services/scheduler/runs`, `/services/scheduler/lifecycle`, `/services/logs`, `/services/scheduler` all **200** |
| Live E2E (backend restarted, real data) | `/api/scheduler/runs` → `total=77` (20/page, 4 pages); `status=COMPLETED` → 34; `catch_up_only` → 26 with `MISSED_SCHEDULE_CATCHUP` trigger; `search=logout` → 15; `failed_only` → 0 (honest); `/api/scheduler/runs/{id}` → normalized single run; unknown id → **404** |

## 4. Known limitations / notes

- `tsc --noEmit` is blocked repo-wide by a pre-existing broken `components/kotak/pages/risk.tsx` (untracked). All files added/changed here typecheck clean.
- `app_logs` (used by the new Logs page) currently has no active writer in the migrated backend — the legacy Node `/api/ticks/log` forwarder was removed. The page renders real (`/api/logs`) results; today that is an empty collection. `log_mongo_enabled` and the query/clear endpoints remain; wiring a Mongo log writer is out of scope for a UI task.
- Scheduler page E2E click-through was validated via live API + SSR; a full browser click-through is unnecessary because every value is server-rendered/client-fetched from the endpoints verified above.