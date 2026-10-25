# 029 — Topbar Manual Login: Backend-Authoritative Terminal Resolution

Version: 1.0
Date: 2026-10-14
Agent: OpenCode

---

# Task

"Manual login add nahi kiya, topbar me add karo" — the Manual Login button
built in 028 never appeared in the real topbar. Make it reliably visible and
functional.

# Objective

The Manual Login button must appear in the topbar whenever the BACKEND genuinely
needs a broker login — regardless of the local UI mode and regardless of
whether the SSE snapshot has arrived.

# Scope

IN SCOPE

- `lib/topbar/context-registry.ts` — NEW pure `resolveEffectiveTerminalMode()`.
- `lib/topbar-status.ts` — NEW pure `systemPollBroker()` / `systemPollSessionActive()`.
- `components/layout/topbar/session-action.tsx` — backend-first terminal
  resolution + poll-backed login need.
- `tests/topbar-context.test.ts` (+6), `tests/topbar-status.test.ts` (+2).

OUT OF SCOPE

- Backend, engines, scheduler, session manager — untouched.
- Per-phase placement (trading-only session control) — unchanged; the registry
  documents it and this task does not relitigate it.
- SSE buffering — still pre-existing, still documented.
- The 3 pre-existing `trade-quote-fallback` failures.

# Source Documentation Read

- `PROJECT_IMPLEMENTATION_RULE.md`
- `docs/implementation/028-topbar-indicators-next-action-and-search-repair.md`
- `docs/verification/036-topbar-indicators-next-action-and-search-repair.md`
- `docs/pending/` — PENDING-001..004, all unrelated to this task
- `components/terminal/mode-reconciler.tsx` (trust order mirrored, not changed)
- Live backend: `/api/websocket/system/status`, `/api/system` (via Next),
  `/api/system/market`

# Existing State

028 added `ManualLoginButton` + `useSessionController`, gated on
`getTerminalContext(useTradingMode()) !== 'dummy'` plus
`isManualLoginState(canonical)`.

# Problems Found

1. **The button could never appear.** `TerminalModeReconciler` pins the LOCAL
   trading mode to `dummy` whenever no live broker session exists — which is
   exactly when Manual Login is needed. UI-mode-first resolution therefore
   suppressed the button at the exact moment it was required. Live state at the
   time: backend `terminal=kotak`, session `DISCONNECTED`, scheduler
   `WAITING_FOR_LOGIN` — login genuinely needed, button nowhere.
2. **Pre-hydration there was no second source.** Canonical state is UNKNOWN
   before the first SSE frame, and in this environment the stream is buffered
   (HTTP 200, zero frames — see 036), so the realtime path stayed silent
   forever. Meanwhile the existing `/api/system` poll (every 10s, zero new
   traffic) already carried `schedulerInfo.enabled_brokers: ["kotak"]` and
   `brokers.kotak.session.active: false` — everything needed, unused.

# Design Decision

Backend-authoritative terminal resolution, mirroring the reconciler's trust
order: `session.mode` → `state.terminal` → poll `enabled_brokers` (only when
exactly one unambiguous broker) → local UI mode last. The login endpoint
switches the backend terminal server-side when required, so offering the broker
login here never fabricates a session.

DUMMY suppression is kept but re-grounded: it applies when the BACKEND serves
no broker (dummy-only), not when the local UI happens to sit on dummy. A
backend on `kotak`/`shoonya` with no live session gets its real Manual Login
button (real `/api/auth/manual-login` endpoint, verified in the DOM).

Poll fallback is deliberately narrow: it can only SUPPRESS a login nobody needs
(live broker session in the poll) or ENABLE one the realtime path cannot see
yet (unhydrated + served broker + no active session). It can never claim ACTIVE.

# Files Changed

- `lib/topbar/context-registry.ts` (added resolver)
- `lib/topbar-status.ts` (added poll helpers)
- `components/layout/topbar/session-action.tsx` (backend-first terminal, poll need)

# Files Created

None.

# Backend Changes / Database Changes / API Changes / Realtime Changes / Scheduler Changes

None. No new endpoint, no new poll, no new frame. The controller reuses
`RealtimeProvider` + the existing `SystemProvider` 10s poll.

# Tests

- `tests/topbar-context.test.ts`: resolver — session.mode wins, snapshot
  terminal covers empty mode, poll covers pre-hydration, UI mode is last
  resort, garbage never invents a broker, resolved kotak carries the real
  `/api/auth/manual-login` endpoint.
- `tests/topbar-status.test.ts`: poll helpers — unambiguous/single vs
  zero/multi/garbage/absent broker; active vs inactive vs absent sessions.

# Test Results

```
npm test    -> tests 426 | pass 423 | fail 3
npx tsc --noEmit -> exit 0
npx eslint (changed files) -> exit 0, no warnings
npm run build -> Compiled successfully
```

Baseline before: 418/415/3. The 3 failures are the same pre-existing
`trade-quote-fallback` cases. +8 tests, all passing, zero regressions.

# Verification

See `docs/verification/037-topbar-manual-login-backend-terminal-resolution.md`.

# Remaining Issues

1. SSE buffering persists (pre-existing): without it the next-action lines show
   honest "—" until a frame lands; the login button itself no longer depends on it.
2. After a poll-backed login succeeds, the countdown chip still needs the
   realtime snapshot (SessionSyncProvider anchors on `expiresAt`); the button
   hides correctly via the poll refresh, but no MM:SS chip appears until SSE works.
3. Trading-only placement unchanged per the phase registry.

# Pending Work

None introduced.

# Final Status

COMPLETE (code) — VERIFIED_WITH_LIMITATIONS (see verification record).

---

## Existing

Login button existed in code, unreachable in practice.

## Completed

Backend-first terminal resolution; poll-backed login need; button verified
visible in a live browser with zero snapshot injection.

## Missing

Nothing in scope.

## Pending

None.

## Next

Fix SSE buffering so the full next-action model (not just the login button)
lights up without the poll fallback.