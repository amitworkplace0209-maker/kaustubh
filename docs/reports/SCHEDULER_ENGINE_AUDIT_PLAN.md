# SCHEDULER ENGINE — AUDIT & IMPLEMENTATION PLAN

> **Engine:** Scheduler (`scheduler_engine`, `engine_id="scheduler_engine"`, CONTROL, v1.0.0)
> **Audit basis:** source code = runtime truth (`python-service/scheduler/`, `api/routes.py`,
> `api/engine_control.py`, `services/legacy_engine_facades.py`); docs = intent
> (`docs/engines/scheduler-engine.md`, `docs/MASTER_ENGINE_LIFECYCLE_CONNECTION_FLOW.md`,
> `docs/architecture/SCHEDULER_LIFECYCLE.md`). UI = presentation layer only.
> **Status:** READ-EVERYTHING-FIRST phase complete; 70/70 scheduler tests pass (baseline).

---

## 1. Runtime truth (verified in source)

### State machine (15 states — implemented in `scheduler/__init__.py`)
`STARTING → WAITING_FOR_LOGIN → LOGGING_IN → SESSION_ACTIVE → WAITING_FOR_WS →
WS_CONNECTING → WS_ACTIVE (↔ WS_RECONNECTING) → TICK_COLLECTION → TICK_COLLECTION_RUNNING →
WS_DISCONNECTING → LOGGING_OUT → LOGGED_OUT → MARKET_CLOSED → WAITING_FOR_NEXT_TRADING_DAY`
Failure states: `LOGIN_FAILED`, `WS_FAILED`, `ERROR`.

### Phase machine (12 phases — implemented)
`CLOSED, READINESS, PRE_MARKET, LIMIT_ORDER_WINDOW, EQUILIBRIUM, BUFFER, LIVE_FEED,
SQUARE_OFF, FEED_STOPPING, WEBSOCKET_STOPPING, LOGOUT, DAY_COMPLETE`

### Daily timeline (IST, verified defaults == spec §3)
| Event | Time | Runtime setting |
|---|---|---|
| login | 08:50 | `sched_login_time` |
| ws connect | 08:55 | `sched_ws_start_time` |
| tick collection | 08:59 | `sched_tick_collection_start_time` |
| pre-market | 09:00 | `sched_pre_market_time` |
| limit-order window | 09:05 | `sched_limit_order_time` |
| equilibrium | 09:10 | `sched_equilibrium_time` |
| buffer | 09:12 | `sched_buffer_time` |
| live feed | 09:15 | `sched_feed_start_time` |
| square-off | 15:16 | `sched_square_off_time` |
| feed stop | 15:30 | `sched_feed_stop_time` |
| ws disconnect | 15:31 | `sched_ws_stop_time` |
| logout | 16:00 | `sched_logout_time` |

All live knobs (schema: `services/runtime_settings.py`); scheduler imports settings, never vice-versa.

### Persisted ledger (`scheduler/persist.py`, `scheduler_ledger`)
- Idempotent `execution_id = f"{job_id}:{business_date}:{scheduled_at_iso}"`.
- IST timezone authority (`IST = timezone(hours=5, minutes=30)`).
- Vocabulary: `PENDING / RUNNING / COMPLETED / FAILED / MISSED / CATCHING_UP /
  MISSED_EXPIRED / SKIPPED / ALREADY_SATISFIED / MISSED_WAITING_NETWORK`.
- Catch-up oracle = ws_stop instant (15:31), not a fixed look-back; afternoon restarts resume the
  same trading-day lifecycle; past ws_stop never blind-starts the feed.
- Emits via `record_event("scheduler", …)` (notification center → event_history `system_events`).

### Readiness (spec §6)
`readiness_snapshot()` probes session_manager, session, websocket_engine, subscriptions (>0 active),
feature_engine, storage_engine, db_writer_engine (critical), order/position/margin/connection_manager/
model_group (non-critical). Overall `READY`/`NOT_READY`; `SCHEDULER_READY`/`SCHEDULER_NOT_READY`
events emitted per toggle. On non-trading days: `overall=None, applicable=False`.

### API surface (all live in `api/routes.py`)
- `GET /api/scheduler/status` — state, phase, readiness, windows, today schedule, next events.
- `GET /api/scheduler/readiness` — phase + readiness report + phases.
- `GET /api/scheduler/summary` — authoritative today's ledger summary + executions (Phase 22/53).
- `GET /api/scheduler/history?limit&business_date` — persisted `scheduler_runs` ledger.
- `GET /api/services/engines/scheduler_engine` — facade snapshot (engine registry).
- `GET /api/schedule-events/stream` — SSE (15 s heartbeat).

---

## 2. Audit findings (doc vs code)

| # | Finding | Severity | Decision |
|---|---|---|---|
| F1 | Spec §17 canonical vocabulary (`INIT/LOGIN_PENDING/SESSION_READY/CONNECTION_STARTING/CONNECTION_READY/PRE_MARKET/…/DAY_COMPLETE`) differs from implemented state names. | Medium | Keep implemented vocabulary (runtime truth rule). Add documented mapping table (§17 note) + changelog entry. No code change. |
| F2 | `docs/engines/reports/SCHEDULER_ENGINE_IMPLEMENTATION_REPORT.md` claims "16 states / 10 phases" and "✅ COMPLETE — Ready for Phase E". Verified: 15 states, 12 phases. Misleading claims. | High | Fix the report: correct counts, state/phase lists, timeline, evidence refs, honest status. |
| F3 | `app/_pages/scheduler/page.tsx` CONFLATES the lifecycle ledger with the scheduled-downloads job system (`/api/scheduled-downloads/health` + `/runs`) and labels lifecycle jobs as "Jobs (scheduled downloads)". Two distinct job systems must not mix. | High | Redesign UI. Scheduler page shows lifecycle: state, phase, timeline, readiness, ledger `scheduler_runs`, engine health, SSE events. Drop scheduled-downloads from this page (it belongs to Data Saver Schedules). |
| F4 | Sidebar has one flat Scheduler row under Services→System; `NavItem.children` exists in the type but `phase-sidebar.tsx` does not render nested rows. Task requires Service Phase scheduler entry with sub-navigation backed by real routes. | Medium | Implement nested-row rendering in `phase-sidebar.tsx`; give Scheduler real child routes backed by the verified APIs. |
| F5 | `ENGINE_IMPLEMENTATION_STATUS.md` marks Scheduler COMPLETE (✅ all columns) and the 2026-09-19 changelog entry mentions "scheduled downloads job system" as a scheduler facet — inconsistent with the lifecycle-only ownership in `MASTER_ENGINE_LIFECYCLE_CONNECTION_FLOW.md`. | Low | Add a clarifying changelog entry + ownership note. |
| F6 | SSE stream only re-broadcasts download/export events (`services.event_bus`); scheduler lifecycle events land in `event_history` (ring + `system_events`), not the SSE stream. UI must read lifecycle events from `/api/scheduler/history` + `event_history`, not the download SSE. | Low | UI consumes ledger history + status; no backend change required (16 s: keep SSE for downloads only). |
| F7 | Report/status/docs previously claimed completion without evidence (spec §41 violation). | High | All completion claims in this work get evidence: test run IDs, API payload samples, route registration proof. |

---

## 3. Implementation plan (one deliverable at a time)

1. **Audit & plan** (this file) — evidence-backed matrix.
2. **API-to-frontend plumbing verification** — confirm `/api/services/engines/scheduler_engine`,
   `/api/scheduler/*` route registration and JSON shapes; fix any mismatch found.
3. **Backend extension** — only if a real gap is proven (current audit shows none required beyond F1 device).
4. **Frontend redesign** — rebuild `app/_pages/scheduler/page.tsx`:
   - State machine card (real `schedulerState`, `phase`, since-timestamps, windows).
   - Trading-day timeline (today's lifecycle instants, IST, next-event, countdown from backend `remaining_seconds`).
   - Readiness report (§6 checks grid, critical vs non-critical).
   - Ledger: today's bank (completions/failures/missed) + `history` table (`scheduler_runs`).
   - Engine status header (facade snapshot: version, health, connectionState).
   - Real data only; missing → `—` / `NOT AVAILABLE` / `NOT APPLICABLE`; no scheduled-downloads content.
   - Sidebar: nested Scheduler sub-nav backed by real routes.
5. **Tests** — add/adjust scheduler UI-facing API contract tests if backend touched (keep 70 passing;
   add coverage for any new endpoint); run full suite + `npm run lint` + `npm run typecheck`.
6. **Docs** — reconcile `scheduler-engine.md` (§17 mapping, timeline, routes), fix the implementation
   report (F2), update `ENGINE_IMPLEMENTATION_STATUS.md` changelog + ownership notice (F5).
7. **Report** — re-write `docs/engines/reports/SCHEDULER_ENGINE_IMPLEMENTATION_REPORT.md` with
   evidence, per spec §41 (hard completion rule: never claim completion without evidence).