# 028 — Topbar Indicator Redesign, Next-Action Model, Market-Closed Manual Login, Search Repair

Version: 1.0
Date: 2026-10-14
Agent: OpenCode

---

# Task

Redesign the GlobalTopBar and its four status indicators so that:

1. Hovering an indicator shows the full "what happens next" picture — when the
   WebSocket connects/disconnects, what the scheduler does next, and when the
   broker session logs in and out.
2. When the market is closed (past the 16:00 IST boundary) the **SESSION
   indicator itself** offers a Manual Login button.
3. After a login, the time remaining until the session auto-logs-out is shown.
4. The topbar search section is repaired.
5. Everything is wired to the project's REAL backend data and its actual
   phases (DATA SAVER / TRADING / SERVICES / KHUMBHA AI).
6. Everything fits the PWA layout.

# Objective

Make the topbar answer "where is it, and what happens next, and when" from real
backend state, with the market-closed login action living in the indicator that
needs it — without inventing a single value.

# Scope

IN SCOPE

- `lib/topbar-status.ts` — the ONE canonical pure model: next-action timeline,
  WebSocket plan, session plan, market-closed login gate, duration formatters;
  repair of the scheduler's broken "next run" row.
- `components/layout/global-topbar.tsx` — bar layout, search trigger
  breakpoints, PWA indicator row.
- `components/layout/topbar/status-pill.tsx` — indicator redesign (rich hover
  tooltip, full diagnostics panel, inline session action).
- `components/layout/topbar/use-status-state.ts` — expose the shared timeline,
  canonical session state, manual-login need and market gate.
- `components/layout/topbar/session-action.tsx` — NEW: the one session
  controller + login/logout/countdown UI shared by the bar and the indicator.
- `components/layout/topbar/use-now-tick.ts` — NEW: local 1 Hz clock, active
  only while a panel is open.
- `components/layout/universal-search.tsx` — search repair.
- `lib/pending-symbol.ts` — NEW: global-search → Market Watch symbol handoff.
- `components/market-watch/market-watch-live.tsx` — consume that handoff.
- `components/ui/command.tsx` — PWA-sized palette surface.
- `tests/topbar-status.test.ts` — 18 new unit tests.

OUT OF SCOPE (deliberately not changed)

- Backend engines, scheduler, session manager, WebSocket Engine — none touched.
  The frontend only READS what they already publish.
- Engine ownership. Login/logout authority stays with the Session Manager +
  Scheduler Engine; the indicator only surfaces their real state.
- The `?search=` deep-link capability itself (still not implemented anywhere) —
  the handoff replaces the need for it instead of adding a second mechanism.
- The SSE stream buffering found during verification (pre-existing, see
  "Remaining Issues").
- The 3 pre-existing `tests/trade-quote-fallback.test.ts` failures.

# Source Documentation Read

- `PROJECT_IMPLEMENTATION_RULE.md` (rules 2, 4, 5, 7, 9, 12–18, 26–28, 31,
  33–35, 39–41, 46, 48–56, 62, 66–71)
- `docs/engines/scheduler-engine.md` (phase machine, job table, schedule windows)
- `docs/engines/session-manager.md` (session statuses, expiry, login/logout)
- `docs/engines/websocket-engine.md`
- `docs/frontend/FRONTEND_ARCHITECTURE.md`, `FRONTEND_CONTRACT.md`,
  `FRONTEND_DATA_FLOW.md`, `FRONTEND_ROUTE_MAP.md`
- `docs/audits/frontend/CONNECTION_MANAGER_UI_AUDIT.md` (format precedent)
- `docs/architecture/07_SESSION_ARCHITECTURE.md`, `08_WEBSOCKET_ARCHITECTURE.md`
- `docs/pending/PENDING-001..004` (checked — unrelated to this task)

Backend source read for the data contract (NOT modified):

- `python-service/scheduler/__init__.py` — `get_scheduler_info()`,
  `get_scheduler_state()`, `get_schedule()`, `_sched_times()`, `_market_slot()`
- `python-service/services/session/session_manager.py` — `snapshot()`,
  `remaining_seconds()`, `is_active()`, `MANUAL_SESSION_SECONDS`
- `python-service/services/market_calendar.py` — session buckets, hours
- `python-service/api/websocket.py` — `_build_snapshot()` (SSE frame shape)
- `python-service/api/auth.py` — manual-login / logout contracts

# Existing State

The bar already existed and worked, with four indicators, a session chip and a
command palette. Specific defects found:

1. **No "what happens next" anywhere.** `StatusPill` showed a state + a detail
   line + raw rows. Nothing told the user when the socket would come up, what
   the scheduler would do next, or when the session ends.
2. **`deriveScheduler`'s "Next run" row was meaningless.** It read
   `info.nextRunAt ?? info.next_run_at ?? info.schedule.next_event`. No such
   field exists; the chain fell through to `info.schedule.next_event`, which is
   an event NAME (`"ws_disconnect"`), and `fmtISTClock()` rendered it as a
   clock. `nextRunAt` belongs to the unrelated scheduled-downloads subsystem.
3. **MARKET indicator was permanently UNKNOWN.** `deriveMarket` read
   `rt.marketState` (= `state.market`), but the backend's SSE
   `state_snapshot` (`python-service/api/websocket.py::_build_snapshot`) has no
   `market` key — only session / terminal / scheduler / websocket / database /
   internet / services / notifications / metrics. Verified live: the snapshot
   key list has no `market`. The real calendar was already polled by
   `SystemProvider` (`/api/system/market`) and simply not used.
4. **Manual Login lived only in the right-hand cluster**, and was hidden in
   DUMMY with no explanation, leaving a red SESSION pill that could never
   respond to anything.
5. **Session countdown existed but was unexplained** — `[ MANUAL · 59:42 ]`
   with no statement of what happens at zero.
6. **Search selection was dead.** `UniversalSearch` linked a picked stock to
   `/trading/market-watch?search=<symbol>`. No route in `app/` reads a
   `search` param (verified by repo-wide grep for `useSearchParams` /
   `searchParams`: only `/login?from` and `/downloads/schedules/new?edit`).
   The selection was silently discarded on navigation.
7. **Search trigger was an unlabelled icon below `xl`** (1280px) — a tablet in
   landscape lost the search affordance entirely.
8. **Palette had no instrument empty-state** — a typed query matching pages but
   no instrument looked identical to "there are no stocks".
9. **Keyboard hints sat inside `CommandList`**, inside cmdk's scroll container.

# Problems Found

All of the above, plus two found during verification:

10. **"IST IST" duplication.** `fmtISTClock()` already appends `IST`; the new
    next-action line appended it again. Caught by the live render, not by
    tests — the model returns `fmtNextAt()` and the view added the suffix.
11. **Scheduler read healthy-green at 23:59.** The backend genuinely reports
    `running: true` with state `WAITING_FOR_NEXT_TRADING_DAY`. Painting that
    "actively running" to a user at midnight is misleading.

# Design Decision

**One model, one source, four views.** The next-action logic is pure and lives
in `lib/topbar-status.ts` beside the existing derivation model, so it is unit
testable and cannot drift from the indicator that renders it. No new engine, no
new provider, no parallel poll — `useStatusState` already receives the whole
snapshot.

**Prefer the phase machine over the lifecycle event.** The backend's
`next_event` covers only 5 events and deliberately omits `square_off` (15:16)
and `feed_stop` (15:30); `next_phase` covers all 10 boundaries. So
`nextSchedulerAction` prefers the phase and falls back to the event — which is
exactly what live data required (after the trading day, `next_phase` is null).

**Absolute instant always beats the HH:MM label.** All schedule times are live
Mongo settings (`sched_*`) re-read by the backend every tick, so the UI reads
them and never hardcodes 08:50 / 08:55 / 15:31 / 16:00. A bare `"HH:MM"` is
resolved against today in IST only as a last resort.

**No 1-second re-render of the whole bar.** A per-second tick in
`useStatusState` would re-render the entire topbar forever. Instead each pill
opts into `useNowTick` only while hovered/open, and the resting state renders
the backend's own `remaining_seconds`.

**The login button is duplicated as UI but not as logic.** `session-action.tsx`
owns one controller (busy state, error text, the real `POST
/api/auth/manual-login` / `/api/auth/logout` calls); the right cluster and the
indicator render different presentations of it. Rule 26/27 satisfied.

**Market-closed verdict comes from the backend's own calendar buckets.**
`market_session` POST_CLOSE (15:30–16:00) and CLOSED (after 16:00) are the real
buckets from `market_calendar.py`. The wording branch is driven by the bucket,
not by comparing against `next_logout` — because `next_logout` has already
rolled to the next trading day by then, so an instant comparison would wrongly
report "logout in 23h" at 16:20.

# Files Changed

- `lib/topbar-status.ts` (extended — `StatusEntry.next/after`, `NextActionInfo`,
  `SchedulerTimeline`, `marketLoginGate`, `schedulerTimeline`,
  `nextSchedulerAction`, `nextWebSocketAction`, `nextSessionAction`,
  `fmtSpan`, `fmtNextIn`, `fmtNextAt`, `fmtDurationUntil`, `PHASE_LABELS`,
  `EVENT_LABELS`, `IDLE_BY_DESIGN`; repaired `deriveWebSocket`,
  `deriveScheduler`, `deriveSession`; `StatusInput.nowMs`)
- `components/layout/global-topbar.tsx` (rewritten)
- `components/layout/topbar/status-pill.tsx` (rewritten)
- `components/layout/topbar/use-status-state.ts` (rewritten)
- `components/layout/universal-search.tsx` (rewritten)
- `components/ui/command.tsx` (`contentClassName`, PWA list height)
- `components/market-watch/market-watch-live.tsx` (consume handoff)

# Files Created

- `components/layout/topbar/session-action.tsx`
- `components/layout/topbar/use-now-tick.ts`
- `lib/pending-symbol.ts`

# Backend Changes

None. No Python file was modified.

# Database Changes

None.

# API Changes

None. No endpoint was added, changed or removed. The indicators read existing
`GET /api/websocket/system/status` / SSE `state_snapshot` data and the existing
`GET /api/system/market` poll. No new backend capability is assumed.

# Realtime Changes

No new frame type and no new channel. The indicators consume the ONE existing
`state_snapshot` / `state_changed` stream through the ONE `RealtimeProvider`.

One correction to an assumption: the `market` calendar is NOT in the SSE
snapshot. `useStatusState` now sources it from the existing
`SystemProvider.market` (`/api/system/market`) and prefers a realtime
`state.market` if the backend ever starts publishing one.

# Scheduler/Lifecycle Changes

None. The Scheduler Engine remains the sole owner of the trading-day lifecycle;
the indicator only reports what it publishes.

# Tests

- `tests/topbar-status.test.ts` — extended with 18 tests for the next-action
  model, timeline resolution, WebSocket plan, session plan, market gate,
  duration formatters, and an end-to-end post-close snapshot assertion.

# Test Results

```
npm test    -> tests 418 | pass 415 | fail 3
npx tsc --noEmit -> exit 0
npx eslint  -> exit 0 (0 errors, 0 warnings)
npm run build -> Compiled successfully
```

The 3 failures are the pre-existing, unrelated `tests/trade-quote-fallback.test.ts`
cases (lines 70, 100, 142) which fail identically on the untouched baseline.

Baseline before this task: `tests 400 | pass 397 | fail 3`.
After: `tests 418 | pass 415 | fail 3` — +18 tests, all passing, zero
regressions.

# Verification

See `docs/verification/036-topbar-indicators-next-action-and-search.md`.

# Remaining Issues

1. **SSE frames are buffered in this dev environment.** `GET
   /api/websocket/system/stream` through the Next origin returns HTTP 200 but
   delivers no frames, so the browser never hydrates and every indicator
   correctly shows `CHECKING`/amber. Pre-existing, outside this task's scope,
   and it degrades honestly (amber "check in progress", never a fake green).
   The hydrated path was verified by intercepting only that one request and
   answering it with the real backend snapshot.
2. **Backend active terminal is `dummy`**, so on a fresh profile the SESSION
   indicator correctly shows no broker login. The indicator now says so
   ("Simulated terminal — the dummy engine has no broker session") instead of
   being inert. Verified on the Kotak path separately.
3. **`?search=` deep links remain unimplemented.** The handoff store makes the
   UI work; programmatic deep links to a symbol are still not a capability.

# Pending Work

None introduced by this task.

# Final Status

COMPLETE (code) — VERIFIED_WITH_LIMITATIONS (runtime; see verification record
for exactly what was proven against the live backend and what was not).

---

## Existing

Four-indicator topbar, session countdown chip, universal search, per-phase
context registry.

## Completed

Next-action model wired to real scheduler/session/WebSocket state; hover
tooltip + diagnostics panel; market-closed Manual Login inside the SESSION
indicator; live auto-logout countdown; search selection now opens the real
symbol detail; PWA layout verified at 390px.

## Missing

Nothing in this scope. See "Remaining Issues" for out-of-scope findings.

## Pending

None.

## Next

1. Fix the SSE buffering so the topbar hydrates without a fallback poll in
   production-like environments.
2. If deep-linked symbols are ever needed, add `?search=` support to
   `market-watch-live` and deprecate the handoff store.