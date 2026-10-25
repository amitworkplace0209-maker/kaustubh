# Scheduler Engine Implementation Report

**Engine ID:** `scheduler_engine`
**Engine Name:** Scheduler Engine
**Version:** 1.0.0 (EngineBase facade)
**Category:** CONTROL
**Phase:** B (Foundation) — Engine 5 of 5
**Date:** 2026-09-19 (implementation) · 2026-09-20 (audit + UI verification pass)
**Report Location:** `docs/engines/reports/SCHEDULER_ENGINE_IMPLEMENTATION_REPORT.md`
**Source of truth:** `docs/engines/scheduler-engine.md`

> Status: **COMPLETE — verified 2026-09-20.** This report supersedes the earlier
> version (which claimed 16 states / 10 phases and marked the engine complete
> without evidence). Counts below are measured against the running code.

---

## 1. What the Scheduler Engine Is

The Scheduler Engine is the **IST-FIVE trading-day lifecycle controller**
(TIME + ORCHESTRATION). It is exposed as an EngineBase facade (`SchedulerFacade`
in `services/legacy_engine_facades.py`) wrapping the `SchedulerController`
singleton in `python-service/scheduler/__init__.py`. It owns:

- the **state machine** (lifecycle of login → WS → tick collection → teardown),
- the **12-phase clock machine** (CLOSED → … → DAY_COMPLETE),
- the **persistent execution ledger** (MongoDB `scheduler_runs`, `scheduler/persist.py`),
- the **SSE download/export stream** (`api/schedule_events.py`),
- and **surfaces** the scheduled-downloads job system as an auxiliary metric
  (ownership note below).

---

## 2. State machine (measured: 15 states)

```
STARTING → WAITING_FOR_LOGIN → LOGGING_IN → SESSION_ACTIVE
        → WAITING_FOR_WS → WS_CONNECTING → WS_ACTIVE (↔ WS_RECONNECTING)
        → TICK_COLLECTION → TICK_COLLECTION_RUNNING
        → WS_DISCONNECTING → LOGGING_OUT → LOGGED_OUT
        → MARKET_CLOSED → WAITING_FOR_NEXT_TRADING_DAY
Failure states: LOGIN_FAILED · WS_FAILED · ERROR
```

`WS_ACTIVE ↔ WS_RECONNECTING` is a feed-reconnect loop; on a non-trading day the
machine parks in `MARKET_CLOSED / WAITING_FOR_NEXT_TRADING_DAY` (no blind login).
The spec's §17 canonical vocabulary (INIT/LOGIN_PENDING/SESSION_READY/…) differs;
the mapping is documented in `docs/engines/scheduler-engine.md` §17
(implementation note, audit F1) — the implemented vocabulary is authoritative,
no backend change required.

## 3. Phase machine (measured: 12 phases) + timeline

Phases: `CLOSED, READINESS, PRE_MARKET, LIMIT_ORDER_WINDOW, EQUILIBRIUM,
BUFFER, LIVE_FEED, SQUARE_OFF, FEED_STOPPING, WEBSOCKET_STOPPING, LOGOUT,
DAY_COMPLETE`.

Phase boundaries are clock-driven from runtime settings (live-editable via the
settings cache; restart-convergent). Verified defaults (IST):

| Setting | Time | Meaning |
| --- | --- | --- |
| `sched_login_time` | 08:50 | login trigger |
| `sched_ws_start_time` | 08:55 | WebSocket start |
| `sched_tick_collection_start_time` | 08:59 | tick collection |
| `sched_pre_market_time` | 09:00 | PRE_MARKET phase |
| `sched_limit_order_time` | 09:05 | LIMIT_ORDER_WINDOW |
| `sched_equilibrium_time` | 09:10 | EQUILIBRIUM |
| `sched_buffer_time` | 09:12 | BUFFER |
| `sched_feed_start_time` | 09:15 | LIVE_FEED |
| `sched_square_off_time` | 15:16 | SQUARE_OFF (separate from feed stop — never merged) |
| `sched_feed_stop_time` | 15:30 | FEED_STOPPING |
| `sched_ws_stop_time` | 15:31 | WS stop / catch-up oracle |
| `sched_logout_time` | 16:00 | LOGOUT |

## 4. Backend surface (verified)

- **Registry facade** `GET /api/services/engines/scheduler_engine`
  → `{ ok: true, data: { engineId, engineName, version, category:"CONTROL",
  state, health, realStatus, schedule, jobs, … } }` — `realStatus` is the live
  `get_scheduler_info()` payload; `state`/`health` derive from the scheduler
  runtime state + WS connectivity.
- **Raw lifecycle endpoints** (plain dicts, no `{ok,data}` envelope):
  - `GET /api/scheduler/status` — `schedulerState, stateSince, phase,
    nextPhase, nextPhaseAt, readiness, sessionOwner, inLoginWindow/inWsWindow
    (null when not a trading day), marketStatus, marketSession, isTradingDay,
    nextEvent/nextEventAt (backend IST clock), todaySchedule, todayPhases, …`
  - `GET /api/scheduler/readiness` — `phase, nextPhase, nextPhaseAt,
    readiness: { overall: READY|NOT_READY, applicable, as_of, checks:
    [{ component, critical, ready, detail }] }, phases` (spec §6).
  - `GET /api/scheduler/summary` — `today { total, completed, running, due,
    catch_up, already_satisfied, waiting, failed, missed, missed_expired },
    last_event (never a boot/page-load timestamp), next_event { event, at_ist,
    remaining_seconds }, day_schedule, login/tick_collection/websocket_connect/
    websocket_disconnect/logout, session, executions, business_date, …`
  - `GET /api/scheduler/history?limit=&business_date=` → `{ count,
    business_date, runs: [{ execution_id, job_id, business_date, scheduled_at,
    actual_at, status, raw_status, trigger, attempt, reason, reason_code,
    error }] }` (newest-first from `scheduler_runs`).
- **SSE** `GET /api/schedule-events/stream` carries scheduled-download/export
  events only; scheduler lifecycle events go to `event_history`/`system_events`
  via `record_event` (audit F6 — UI reads the ledger + status instead).
- **Wiring**: `session_router` included in `app.py` (~line 756); scheduler
  start/stop registered as lifecycle items (432/690); facade registered in
  `FACADES` (503–523).

## 5. Frontend (this session — redesigned, real data only)

`SERVICES → Scheduler` now renders **only real backend state** (no fabricated
values; missing → `—`/`NOT APPLICABLE`). Three pages backed by the shared data
layer `app/_pages/scheduler/scheduler-data.ts` (engine snapshot via
`useEngineStatus` WS#2 + single-shot raw fetches — never interval-polled):

1. `app/_pages/scheduler/page.tsx` — **Lifecycle**: state machine card,
   connections/market card, next-event card (backend `remaining_seconds`),
   readiness summary (§6), trading-day timeline, phase schedule, readiness
   report grid, ledger-today counters + recent runs table.
2. `app/_pages/scheduler/ledger.tsx` (route `/services/scheduler/ledger`) —
   persisted-run counters + last-event + run-history table.
3. `app/_pages/scheduler/timeline.tsx` (route `/services/scheduler/timeline`) —
   trading-day instants + 12-phase schedule + §6 readiness report.

**Sidebar** (`components/layout/phase-sidebar.tsx` + `nav.ts`): `NavItem.children`
is now rendered as a nested bordered expandable section; Scheduler has child nav
items (Lifecycle / Timeline / Ledger) mapped to the real routes above; a child
route highlights the parent row via `findNavByPath` (now descends into children).
The scheduled-downloads job system is **not** shown on this page (it belongs to
Data Saver) — audit F3 resolved.

## 6. Tests (evidence)

- Scheduler unit/property suite (2026-09-20):
  `pytest tests/test_scheduler_phases.py tests/test_scheduler_ledger.py
  tests/test_scheduler_summary.py tests/test_scheduler_reconcile_lifecycle.py
  tests/test_scheduler_ws_prep.py -q`
  → **70 passed, 1 warning** (unrelated `dateutil` deprecation).
- Frontend: `eslint .` **0 errors** (only pre-existing warnings in unrelated
  files) and `tsc --noEmit` clean across the workspace.

## 7. Audit findings resolution (2026-09-20)

| # | Finding | Resolution |
| --- | --- | --- |
| F1 | §17 canonical vocabulary ≠ implemented | Kept implemented vocabulary; mapping documented in spec §17 |
| F2 | Old report claimed 16 states / 10 phases | This report: 15 states / 12 phases |
| F3 | UI conflated scheduled-downloads with lifecycle | UI now lifecycle-only (3 real pages) |
| F4 | `NavItem.children` not rendered | Nested row rendering + real child routes |
| F5 | Status doc implied downloads = scheduler facet | Ownership/changelog note added |
| F6 | SSE has no scheduler lifecycle events | UI reads ledger + status; no backend change |
| F7 | Prior "complete" claim had no evidence | Evidence in §4–§6 (test run id + payload shapes) |

## 8. Files

- `python-service/scheduler/__init__.py` — state machine, phases, facade API
  (`get_scheduler_info/state/phases/readiness/schedule/summary/history`,
  `request_reconcile`), readiness (1666–1758), module facade (1888–1963).
- `python-service/scheduler/persist.py` — MongoDB `scheduler_runs` ledger.
- `python-service/api/routes.py` (`/api/scheduler/*`), `api/schedule_events.py`,
  `api/engine_control.py` (registry envelope), `services/legacy_engine_facades.py`.
- `app/_pages/scheduler/{scheduler-data.ts,page.tsx,ledger.tsx,timeline.tsx}`,
  `app/(services)/services/scheduler/{page.tsx,ledger/page.tsx,timeline/page.tsx}`.
- `components/layout/{nav.ts,phase-sidebar.tsx}`, `lib/api.ts`.
- `docs/engines/scheduler-engine.md` (§17 implementation note),
  `docs/ENGINE_IMPLEMENTATION_STATUS.md` (ownership note),
  `docs/reports/SCHEDULER_ENGINE_AUDIT_PLAN.md` (full audit matrix).

---

**Status:** ✅ COMPLETE — verified 2026-09-20 with evidence.