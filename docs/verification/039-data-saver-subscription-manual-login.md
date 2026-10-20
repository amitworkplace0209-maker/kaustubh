# 039 — Data Saver Subscription Manual Login: Verification

- **Verification ID:** 039
- **Subject:** `docs/implementation/031-data-saver-subscription-manual-login.md`
- **Date:** 2026-10-14
- **Agent:** OpenCode (Space Bunny Free)
- **Final Result:** **PASS**

---

## 1. Environment

| Item | Value |
|---|---|
| OS / Node | Windows · `v24.18.0` |
| Browser | Google Chrome `--headless=new`, driven over raw CDP |
| Frontend | Next dev, `127.0.0.1:3000` |
| Backend | Python service, `127.0.0.1:8000` |
| Active terminal | `dummy` (`mode: "dummy"`, `broker: "Dummy Mode"`) |
| Market state | **CLOSED** |
| Session before | `DISCONNECTED` / `active: false` |

## 2. Expected vs actual (the defect, before any fix)

**Expected:** clicking **Manual Login** performs a broker login, reports the backend's real
verdict, and the "Broker session is inactive" banner clears.

**Actual (before):**

```
POST http://localhost:3000/login   -> 200  body = "<!DOCTYPE html>…KAUSTUBH…"
```

The button POSTed to the **Next.js login page**. No broker login ran. The page then evaluated
`Boolean(res && res.ok !== false)` on an HTML string — `res.ok` is `undefined`, so the result
was **always true** and the UI showed a green success toast for a login that never happened.

## 3. Method

`docs/opencode/007-data-saver-subscription-login-verify.mjs` (re-runnable), headless Chrome
over CDP:

1. Read the backend session state and remember it.
2. Log in to the app through **its own** Login button (no cookie injection, no bypass).
3. Navigate to `/data-saver/subscription` and wait for it to mount.
4. Assert the Manual Login button exists inside the session banner.
5. Screenshot (**before**).
6. Click the page's **own** Manual Login button.
7. Capture every `POST` the browser issued.
8. Poll up to 35 s for the banner to clear; record how long it took.
9. Screenshot (**after**), read the backend session again.
10. Restore the original session state in a `finally` block.

## 4. Actual results

### V1 — the button issues the REAL backend login

```
POST requests observed by the browser:
  {"response":"200 http://127.0.0.1:3000/api/auth/login"}     <- app login (the test's own)
  {"url":"http://127.0.0.1:3000/api/login"}
  {"response":"200 http://127.0.0.1:3000/api/login"}           <- the broker manual login
```

`/api/login` → `next.config.js` rewrite → backend `POST /api/login` → `_login_impl()`. **PASS**

### V2 — the backend session genuinely transitions

```
BEFORE: {"status":"DISCONNECTED","active":false,"userId":"KAUSTUBH_DUMMY","reason":"logged out"}
AFTER : {"status":"SESSION_ACTIVE","active":true, "userId":"KAUSTUBH_DUMMY",
         "source":"manual","reason":"login success",
         "loginAt":"2026-10-14T17:04:39.117741+05:30",
         "expiresAt":"2026-10-14T18:04:39.117741+05:30"}
```

`source: "manual"`, `reason: "login success"` — the broker login really ran. **PASS**

### V3 — the page stops contradicting itself

```
banner visible (before) : true
banner still visible    : false | cleared after: 6528ms
visible toasts          : []      (the success toast had already auto-dismissed; no error toast)
```

Screenshots: `docs/verification/evidence/007-subscription-before.png` (orange banner + red
SESSION pill) and `007-subscription-after.png` (banner gone, SESSION pill green). **PASS**

### V4 — session authority precedence is corrected

Measured through the Next proxy while a session was active:

```
before the fix: {"active":false,"loggedIn":false,"user":"XBH6H",
                 "state":"DISCONNECTED","stateMessage":"logged out"}
after  the fix: {"active":true, "loggedIn":true, "user":"KAUSTUBH_DUMMY",
                 "state":"SESSION_ACTIVE","stateMessage":"login success",
                 "expiresAt":"...","remainingSeconds":3506.8}
```

The `user` field alone proves the precedence flipped from the Kotak SDK session module to the
Session Manager. **PASS**

### V5 — console hygiene

```
exceptions     : []
console errors : []
```

The `In HTML, <div> cannot be a descendant of <p>` hydration warning that fired on every
render before the fix is **gone**. **PASS**

### V6 — no regressions

| Check | Command | Result |
|---|---|---|
| Types | `npx tsc --noEmit` | exit 0 |
| Lint | `npx eslint` on the 5 touched files | 0 errors (3 pre-existing warnings on unrelated lines) |
| Suite | `npm test` | **426 tests / 423 pass / 3 fail** |
| Baseline | `docs/verification/037` | **426 tests / 423 pass / 3 fail** |

The same 3 pre-existing `tests/trade-quote-fallback.test.ts` failures (lines 70, 100, 142).
**No regression introduced. PASS**

### V7 — the operator's environment was restored

```
RESTORING: session was inactive before, active now -> logging out
SESSION AFTER RESTORE : {"status":"DISCONNECTED","active":false,"reason":"logged out"}
```

The probe captures the session before it mutates anything and restores it in a `finally`.
**PASS**

## 5. Commands executed

```powershell
Invoke-WebRequest http://localhost:3000/login      -Method POST    # -> 200, HTML (the bug)
Invoke-WebRequest http://127.0.0.1:8000/login      -Method POST    # -> 200, {"ok":true}
Invoke-WebRequest http://localhost:3000/api/login  -Method POST    # -> 200, {"ok":true}
npx tsc --noEmit ; npx eslint <5 files> ; npm test
node docs/opencode/007-data-saver-subscription-login-verify.mjs
```

## 6. Problems found and fixed during verification

| # | Problem | Fix |
|---|---|---|
| P1 | `triggerLogin` POSTed to the Next login page | `/api/login` alias |
| P2 | `res && res.ok !== false` was true for an HTML string → false success | require an object with `ok === true`; surface the backend's `message` |
| P3 | `triggerLogout` and `getPythonSession` had the identical defect | `/api/logout`, `/api/session/status` |
| P4 | Dashboard read the Kotak SDK session before the Session Manager | Session Manager first (owner-approved; matches `session-manager.md` §41) |
| P5 | `refresh()` claimed to be forced but bypassed no cache | real `force` through client cache + Next proxy |
| P6 | `<div>` (Badge) nested inside `<p>` → hydration warning | `<p>` → `<div>` |
| P7 | Probe sampled the banner at 6 s, shorter than the backend's own 15 s aggregation cache | probe now polls up to 35 s and records the real clear time |

## 7. Remaining risks

1. **Banner clear latency is bounded by the backend's 15 s `/api/system/dashboard` cache.**
   Measured 6.5 s in a warm run. Removing that bound needs a backend cache-bypass parameter —
   deliberately not done (backend ownership; the 15 s TTL is a deliberate Mongo-pressure guard).
2. **A rejected login now shows the backend's real failure message** — but no broker session
   exists in this environment beyond `dummy`, so the Kotak/Shoonya failure paths were not
   exercised.
3. **`npm run build` not re-run** — the operator's `next dev` shares the same `.next`
   directory. Tracked by `PENDING-002`.
4. **No automated test** covers `triggerLogin`'s endpoint: the repo has `node --test` only and
   no component runner. The CDP probe is the regression guard.

## 8. Final result

**PASS**

| Check | Result |
|---|---|
| V1 real backend login endpoint | PASS |
| V2 backend session DISCONNECTED → SESSION_ACTIVE (source: manual) | PASS |
| V3 banner clears, real verdict reported | PASS (6.5 s) |
| V4 session authority precedence corrected | PASS |
| V5 no exceptions, no console errors | PASS |
| V6 no type/lint/test regression | PASS (426/423/3 = baseline) |
| V7 environment restored | PASS |