# 037 — Topbar Manual Login via Backend Terminal Resolution

Verification ID: 037
Date: 2026-10-14
Agent: OpenCode
Related Implementation: `docs/implementation/029-topbar-manual-login-backend-terminal-resolution.md`
Prior Record: `docs/verification/036-topbar-indicators-next-action-and-search-repair.md`

---

# Verification ID

037

# Date / Time

2026-10-14, ~00:20 IST.

# Agent

OpenCode (automated agent).

# Task / Feature

029 — make the topbar Manual Login button actually appear when the backend
needs a broker login.

# Expected Behavior

1. Backend on `kotak`, session `DISCONNECTED`, local UI mode `dummy` → the
   topbar shows `Manual Login — KOTAK NEO` (right cluster + inside the SESSION
   indicator), calling the real `/api/auth/manual-login`.
2. No new network traffic for the decision (reuse SSE snapshot + /api/system poll).
3. No console errors; typecheck, lint, build, no test regressions.

# Verification Method

- unit test (`node --test tests/topbar-context.test.ts tests/topbar-status.test.ts`)
- full suite (`npm test`), typecheck, lint, production build
- **live browser render** — installed Chromium headless shell over CDP, real
  application, real backend, **zero snapshot injection** (SSE left in its real
  buffered state to prove the poll fallback path)

# Environment

- Frontend: Next.js 16 dev on `127.0.0.1:3000`; backend Python on `:8000` (live)
- Backend at run time: `terminal=kotak`, session `DISCONNECTED/active=false`,
  scheduler `WAITING_FOR_LOGIN`; `schedulerInfo.enabled_brokers=["kotak"]`,
  `brokers.kotak.session.active=false`
- Browser: fresh profile → local trading mode `dummy` (the exact failing case)

# Questions / Checks

1. Does the button render with no SSE frames at all?
2. Which endpoint does the resolved terminal carry?
3. Any console errors?
4. Regressions?

# Expected Results

1. ≥1 `Manual Login — KOTAK NEO` button, incl. inside `[data-indicator="sess"]`.
2. `/api/auth/manual-login`.
3. None.
4. None.

# Actual Results

```
TOPBAR: {"path":"/trading/dashboard",
  "loginButtons":["Manual Login — KOTAK NEO",
                   "Manual Login — KOTAK NEO",
                   "Manual Login — KOTAK NEO"],
  "sessInline":"Manual Login — KOTAK NEO",
  "sessPill":"warning"}
SESSION PANEL: ["SESSION CHECKING Next: Broker login · — · — Then: Broker
  logout · — · — State UNKNOWN Login time — Validated at — Expires at —
  Manual Login Open details"]
ERRORS: (none)
```

Three buttons: right cluster, desktop SESSION pill inline, mobile SESSION pill
inline. The panel also carries the login action. Unit test proves the resolved
context's `loginEndpoint === '/api/auth/manual-login'` (never `/api/demo/login`).

# Evidence

```
Command: node --test tests/topbar-context.test.ts tests/topbar-status.test.ts
Expected: all pass
Actual: tests 78 | pass 78 | fail 0
Status: PASS

Command: npm test
Expected: no regressions vs 418/415/3
Actual: tests 426 | pass 423 | fail 3 (same pre-existing trade-quote-fallback)
Status: PASS

Command: npx tsc --noEmit → exit 0 — PASS
Command: npx eslint (changed files) → exit 0, no warnings — PASS
Command: npm run build → Compiled successfully — PASS
Command: live CDP render (no injection) → 3 login buttons, no errors — PASS
```

# Problems Found

None new. The two known limitations from 036 persist (SSE buffering; countdown
chip needs realtime `expiresAt`).

# Fixes Applied

This verification covers the 029 fix itself (backend-first terminal resolution
+ poll-backed login need). No additional fixes were required during
verification.

# Re-verification

Not required — first live run passed on all checks.

# Final Result

PASS with the same stated limitations as 036:

- proven: button visible + correctly wired without SSE, via the existing poll
- not proven: an actual `POST /api/auth/manual-login` (starts a real broker login)

# Remaining Risks

1. If the backend ever serves multiple brokers in `enabled_brokers`, the poll
   leg yields null and the button depends on SSE/UI mode again (honest
   ambiguity, by design).
2. Poll-backed login hides correctly after login (SystemProvider refetches on
   `kotak-session-changed`), but the MM:SS chip still needs a working stream.