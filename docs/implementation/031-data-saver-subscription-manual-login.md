# 031 — Data Saver Subscription: Manual Login Repair

- **Date:** 2026-10-14
- **Agent:** OpenCode (Space Bunny Free)
- **Route:** `http://localhost:3000/data-saver/subscription`
- **Status:** COMPLETE (verified; one documented residual latency bound)

---

## 1. Task

> "http://localhost:3000/data-saver/subscription manual login working kro"

## 2. Objective

Make the page's **Manual Login** button actually perform a broker login, report the real
outcome, and stop contradicting itself afterwards.

## 3. Root cause (found, not guessed)

`lib/api.ts` defined:

```ts
export const triggerLogin = () => apiFetch(API_BASE, '/login', { method: 'POST' });
```

`API_BASE` is deliberately `''` in the browser (`lib/api.ts:16-19`) so every request is
same-origin. That made the call resolve to **`http://localhost:3000/login` — the Next.js
login PAGE**, not a backend endpoint. Measured:

```
POST http://localhost:3000/login      -> 200, body = "<!DOCTYPE html>…KAUSTUBH…"
POST http://127.0.0.1:8000/login      -> 200, body = {"ok":true,"message":"Login successful"}
```

So **no broker login ever ran**, and the page's success check made it worse:

```ts
const ok = Boolean(res && res.ok !== false);   // res is an HTML STRING
```

`res.ok` on a string is `undefined`, `undefined !== false` is `true`, so `ok` was **always
true** — the user got a green *"Login initiated"* toast for a login that never happened.

## 4. Design decision

The backend already exposes the correct same-origin-reachable aliases of its own login
handlers (`python-service/api/routes.py:151-160`):

```python
@router.post("/login")      async def login():       return await _login_impl()
@router.post("/api/login")  async def login_alias(): ...  # "same REAL manual login as POST /login (phase2 proxy)"
```

and `next.config.js` forwards `/api/:path*` to the Python service. So the fix is to call the
`/api/*` alias — one code path that works from both the browser and SSR. No new proxy route,
no cross-origin call, no duplicated login implementation.

## 5. Changes

### 5.1 `lib/api.ts` — correct endpoints + honest responses

| Function | Before (broken) | After |
|---|---|---|
| `triggerLogin` | `POST /login` → the Next login page | `POST /api/login` → the real backend login |
| `triggerLogout` | `POST /logout` (same class of bug) | `POST /api/logout` |
| `getPythonSession` | `GET /session` (no `/api` alias exists → 404) | `GET /api/session/status` (the alias the backend actually publishes) |

This repairs **three** live callers at once: `app/(phase2)/data-saver/subscription`,
`app/(dashboard)/dashboard`, `app/_pages/funds`.

### 5.2 `app/(phase2)/data-saver/subscription/page.tsx` — honest verdict

`handleManualLogin` now requires `res.ok === true` on an actual object and surfaces the
backend's own `message`. A non-object response (HTML, error page) is a **failure**, never a
green toast. It also calls the workspace `refresh()` after success so the banner reflects the
new state without waiting out the poll cycle.

### 5.3 `app/api/phase2/dashboard/route.ts` — session authority precedence (owner-approved)

The route read the **Kotak SDK** session module *before* the **Session Manager**:

```ts
active: Boolean(python.session_active ?? sessionSnap.active),   // false ?? true -> false
```

`docs/engines/session-manager.md` §41 states the **Session Manager is the authoritative
manager for broker session lifecycle**. `pythonStatus` is `kotak_session.session_info()`,
which is legitimately "not logged in" whenever the active terminal is `dummy`/`shoonya` —
there is no Kotak broker session to have. So a **successful Dummy-Mode login** was reported
as "session inactive".

Corrected to read Session Manager first, with the Kotak view only filling a field the Session
Manager does not publish. Measured before/after while logged in:

```
before: {"active":false,"user":"XBH6H",      "state":"DISCONNECTED"}
after : {"active":true, "user":"KAUSTUBH_DUMMY","state":"SESSION_ACTIVE","stateMessage":"login success"}
```

**No engine responsibility moved.** The backend still owns and publishes both; only the
*read precedence in the frontend proxy* was corrected to match the documented authority.
The owner explicitly approved this scope before it was changed.

### 5.4 `refresh()` now genuinely forces (three layers)

`refresh()`'s own comment claimed it was "Forced", but it could not bypass any cache:

| Layer | Before | After |
|---|---|---|
| Client `getCached` | 12 s fresh / 30 s SWR, always | new `force` option skips the age checks (still honours an in-flight single-flight) |
| Next proxy `/api/phase2/dashboard` | 30 s TTL + 5 min stale-serve | honours `?refresh=1` |
| Provider | always `/api/data-saver/dashboard` | appends `?refresh=1` when forced |

### 5.5 Invalid HTML nesting (React hydration error)

`<Badge>` renders a `<div>` and was placed inside a `<p>` in the subscription list, producing
`In HTML, <div> cannot be a descendant of <p>` on every render. That `<p>` is now a `<div>`.

## 6. Files changed

| File | Change |
|---|---|
| `lib/api.ts` | `triggerLogin`/`triggerLogout`/`getPythonSession` → real backend `/api/*` aliases |
| `lib/request-cache.ts` | new `CacheOptions.force` |
| `app/(phase2)/data-saver/subscription/page.tsx` | honest login verdict + workspace refresh + `<p>`→`<div>` |
| `app/api/phase2/dashboard/route.ts` | Session-Manager-first session derivation + `?refresh=1` cache bypass |
| `components/phase2/data-saver-provider.tsx` | `refresh()` truly forces |

**Backend: unchanged.** No engine, route, service or schema was touched.

## 7. Tests

```
npx tsc --noEmit    -> exit 0
npx eslint (5 files)-> 0 errors (3 pre-existing warnings on unrelated lines of the dashboard route)
npm test            -> 426 tests | 423 pass | 3 fail
```

Baseline is also `426 / 423 / 3` (`docs/verification/037`). The 3 failures are the known
pre-existing stale assertions in `tests/trade-quote-fallback.test.ts` (lines 70, 100, 142).
**No regression introduced.**

## 8. Verification

Full evidence: `docs/verification/039-data-saver-subscription-manual-login.md`.

Headless Chrome over CDP, real login through the app's own button, real click on the page's
own Manual Login button, real backend session read before and after, screenshots before and
after, and the session restored in a `finally` block.

## 9. Remaining

- The banner cannot clear faster than the **backend's own 15 s** `/api/system/dashboard`
  aggregation cache. Measured clear time after the fix: **6.5 s** in a warm-cache run.
  Making that faster would require a backend cache-bypass parameter — deliberately not done
  (backend ownership, and it is a load-bearing guard against the 502 flood its own comment
  describes).
- `npm run build` not re-run: the operator's `next dev` shares the same `.next` directory
  (tracked by `PENDING-002`).

## 10. Final Status

**COMPLETE** — verified end to end in a real browser: the button issues a real broker login,
the backend session transitions `DISCONNECTED → SESSION_ACTIVE` with `source: manual` /
`reason: "login success"`, the page reports the backend's real verdict, and the
"session inactive" banner clears.

## Cross-references

- Verification: `docs/verification/039-data-saver-subscription-manual-login.md`
- Session log: `docs/logs/LOG-013-2026-10-14-data-saver-subscription-login.md`
- Frontend audit: `docs/audits/frontend/DATA_SAVER_SESSION_UI_AUDIT.md`
- Probe: `docs/opencode/007-data-saver-subscription-login-verify.mjs`
- Engine spec governing the precedence fix: `docs/engines/session-manager.md` §41
- Test baseline: `docs/verification/037-topbar-manual-login-backend-terminal-resolution.md`