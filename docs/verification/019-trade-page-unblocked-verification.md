# 019 — Trade Page Unblocked: Verification

- **Subject:** `docs/implementation/019-trade-page-unblocked.md`
- **Date:** 2026-09-30
- **Environment:** Windows, `next@16.3.4`, `react@19.2.8`, Node `v24.18.0`,
  Next dev on `127.0.0.1:3000` (PID 23056), uvicorn `app:app` on `127.0.0.1:8000`
- **Method:** real HTTP against the running app + headless Chrome driven over
  CDP, logging in through the app's own Login button (no cookie injection, no
  auth bypass).

---

## 1. Before — the reported failure

`/trading/trade` returned HTTP 200 but rendered the login screen:

```
href: http://localhost:3000/login?from=%2Ftrading%2Ftrade
text: KAUSTUBH TRADING PLATFORM Welcome back Open the trading platform
      Login Secure local access only
DOM:  69 elements · 1 input · 0 buttons · 0 sections
      hasSearchInput: false
```

The trade component never mounted. There was no search box and nothing to
select a stock from.

The gate was **not** misconfigured — the session was genuinely missing at that
point. Proof the guard was also wrong for *valid* sessions came from logging in
through the real UI and re-navigating:

```
=== DEEPLINK LOGIN STEP ===
clicked
session: {"authenticated":true}          <-- valid session
=== URL ===
http://localhost:3000/trading/trade
  href: http://localhost:3000/login?from=%2Ftrading%2Ftrade   <-- still bounced
```

`/api/auth/session` (which uses `verifySessionToken`) said `authenticated: true`
while `proxy.ts` (which base64-decoded) said otherwise. Two verifiers, two
answers — the divergence pinpointed the defect.

## 2. Fix 1 — session gate

`proxy.ts` `isAuthenticated()` now calls `verifySessionToken`.

Automated (`tests/proxy-session-gate.test.ts`, 5 tests) — asserts the proxy
imports and delegates to `verifySessionToken`, and that the anti-patterns are
gone: no `Buffer.from(sessionCookie.value`, no `JSON.parse(Buffer.from(`,
no `'base64'`, no re-implemented `Date.now() > payload.exp`.

One test pins the regression behaviourally: a genuinely minted token
**throws** under the old bare-decode logic and **verifies** under
`verifySessionToken`. The unguarded-prefix and `?from=` behaviour is pinned too,
so the documented "screen goes black / request storm" fix cannot regress.

`tests/auth-session.test.ts` (7 pre-existing tests) still passes — forged
base64 cookies, tampered payloads, stripped signatures and expired sessions
remain rejected.

## 3. Fix 2 — deep link

Navigating to a guarded page, clicking the app's own Login button, and letting
the page act now returns to the original destination with no second navigation:

```
=== DEEPLINK LOGIN STEP ===
clicked
=== URL ===
http://localhost:3000/trading/trade
  href: http://localhost:3000/trading/trade        <-- landed on target
```

`safeFrom` rejects `//evil.com`, `/\evil.com`, non-absolute paths and `/login`,
so this is not an open redirect.

## 4. Fix 3 — stock selection and live data

Backend health and canonical search (via the Next proxy):

```json
GET http://localhost:8000/api/health
{ "status": "ok", "service": "kaustubh-python-service", "sdk_loaded": true }

GET http://localhost:3000/api/search?q=heromotors&limit=3
{ "symbol": "HEROMOTORS", "tradingSymbol": "HEROMOTORS-EQ", "token": "766171",
  "exchangeSegment": "nse_cm", "ltp": 152.58, "prevClose": 138.71,
  "change": 13.87, "changePct": 10, "upperCircuit": 152.58,
  "lowerCircuit": 124.84, "liveStatus": "LIVE", "source": "kotak_neo_sfeed",
  "oneQtyMargin": null, "marginStatus": "UNAVAILABLE",
  "marginSource": "not_requested" }
```

The market-watch snapshot — the fallback source that was dead code — returns
real data for the same token:

```json
GET http://localhost:8000/api/market-watch/tick-snapshot?tokens=766171
{ "exists": true, "ltp": 152.58, "open": 140.28, "high": 152.58, "low": 140.0,
  "prevClose": 138.71, "volume": 101777350, "hasData": true,
  "dataQuality": { "live": true, "stale": false, "quoteSource": "ws" },
  "circuit": { "upperCircuit": 152.58, "lowerCircuit": 124.84,
               "status": "UPPER_HIT", "circuitSafe": false } }
```

### Typed and selected through the real UI

```
=== SEARCH STEP ===
typed:HEROMOTORS
options: [ "HEROMOTORS NSE CM LIVE EQ HERO MOTORS LIMITED Lot 1 2s ₹152.58 +10.00%" ]

=== SELECT STEP ===
clicked:HEROMOTORS NSE CM LIVE EQ HERO MOTORS LIMITED Lot 1 2s ₹152.58 +10.00%
```

### Before vs after on the same instrument

| Field | Before | After |
| --- | --- | --- |
| Data status badge | `STALE` | `LIVE` |
| LTP | `₹152.58` (card) but `—` in ticket | `₹152.58` everywhere |
| Change | `+13.87 +10.00%` | `+13.87 +10.00%` |
| Margin / 1 qty | `—` with `1 × — = ₹0.00` | `₹30.52` with `1 × ₹30.52 = ₹152.58` |
| Circuit | Upper `₹152.58` / Lower `₹124.84` | unchanged |
| Order value | `—` | `₹152.58` |
| `1 qty @` | `₹—` | `₹152.58` |
| Required margin | `UNAVAILABLE` | `₹30.52` |
| Available / Remaining | `₹1,00,000` / `—` | `₹1,00,000` / `₹99,969.48` |
| Top-bar data state | `WAITING` | `LIVE` |

Top-bar arithmetic ties out: `1,00,000 − 30.52 = 99,969.48`.

Margin provenance: Dummy Mode declares `supportsMarginPreview: false`, so this
figure comes from the backend dummy engine (`POST /api/dummy/preview`), which is
where the 20 % MIS heuristic was deliberately moved — not from a client-side
guess. It is labelled `DUMMY · Coin` throughout.

### Console hygiene

```
=== CONSOLE (2) ===  React DevTools notice + HMR connected
=== ERRORS (0) ===   (none)
=== FAILED REQUESTS (0) === (none)
```

`nextjs-portal-present` is the Next.js dev-tools overlay, not an error.

## 5. Automated suites

```
npx tsc --noEmit -p tsconfig.json          ->  exit 0, clean

npm test                                   ->  326 tests, 325 pass, 1 fail
  tests/proxy-session-gate.test.ts         ->    5 pass   (new)
  tests/trade-quote-fallback.test.ts       ->    8 pass   (new)
  tests/auth-session.test.ts               ->    7 pass   (pre-existing, unchanged)
```

The single failure is **pre-existing and unrelated**:

```
tests/topbar-status.test.ts:331  canonical session state never invents ACTIVE
  actual:   'INACTIVE'
  expected: 'AUTHENTICATING'
```

It was failing before this work (baseline: 313 tests / 312 pass / 1 fail) and
is untouched. The count moved 313 → 326, exactly the 13 tests added here.

There is no component-test runner in this repo (`node --test` only, no jsdom or
testing-library), so `proxy.ts` cannot be imported directly (no `@/*` alias or
`next/server` resolution under bare `node --test`) and the trade memo cannot be
rendered. Both regression guards therefore combine source-level structural
assertions with behavioural pins. `trade-quote-fallback.test.ts` strips comments
before its structural assertions — the in-place fix notes legitimately quote the
old `if (!view) return null;` line — and self-checks the stripper so it cannot
silently pass everything.

## 6. Operational note

During verification the Python backend was found **hung**: two `uvicorn` PIDs
alive but nothing listening on `127.0.0.1:8000`, which surfaced in the browser as
`net::ERR_CONNECTION_REFUSED` plus a 502 on `/api/realtime/token`, and made
search read `Search unavailable: 502 Bad Gateway`. Killing those PIDs and
restarting uvicorn restored it. The 502s seen before the backend restart are
explained by this and are not related to the code changes.

## 7. No live order was placed

Order placement was not exercised. It remains behind the authenticated order
engine and requires a real broker session. The verified flow stops at a
populated, consistent, non-executing order ticket.

## 8. Open items (pre-existing, untouched)

- `tests/topbar-status.test.ts` — `INACTIVE` vs `AUTHENTICATING`.
- `tests/test_timezones.py::test_production_modules_do_not_redefine_the_offset`
  (backend) — caused by untouched `python-service/api/quality.py`.
- R-37 / R-38 direct-login and browser-reachable operator-token findings.
  `proxy.ts` was changed, but only to make it *verify signatures correctly*; no
  login flow, session lifetime or operator-token path was altered.
- Instrument master holds 9,909 `nse_cm` instruments only; BSE/MCX is not live
  verifiable.
- Dummy Mode renders amounts with `₹` in the selected-stock card although
  `caps.accountCurrency` is `Coin`. Cosmetic, pre-existing, not changed.
