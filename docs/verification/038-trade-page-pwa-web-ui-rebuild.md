# 038 — Trade Page PWA/Web UI Rebuild: Verification

- **Verification ID:** 038
- **Subject:** `docs/implementation/030-trade-page-pwa-web-ui-rebuild.md`
- **Date:** 2026-10-14
- **Agent:** OpenCode (Space Bunny Free)
- **Final Result:** **PARTIAL** — the UI rebuild is fully proven in a real browser on both
  breakpoints; a physical-device swipe feel, a production build, and an *accepted* Kotak
  order remain unproven. Details in §9.

---

## 1. Environment

| Item | Value |
|---|---|
| OS | Windows |
| Browser | Google Chrome (`--headless=new`), driven over raw CDP (no Playwright/Puppeteer in the repo) |
| Frontend | Next dev on `127.0.0.1:3000` (`next@16.3.4`, `react@19.2.8`) |
| Backend | Python service on `127.0.0.1:8000` |
| Node | `v24.18.0` |
| Market state | **CLOSED** (`Market CLOSED` in every capture) |
| Terminal state | Dummy (Kotak has **no broker session** in this environment) |
| Timezone | Asia/Kolkata |

## 2. What was verified

### V1 — the PWA gets the slide gesture, the web does not
### V2 — the slide really places an order, on the engine the mode dictates
### V3 — dummy → dummy engine, Kotak → Kotak engine (R5)
### V4 — the desktop confirm gate is intact
### V5 — the order bar is flush above the app's bottom navigation
### V6 — the complete order flow fits one phone screen
### V7 — no regression: runtime, console, types, lint, tests

## 3. Method

Headless Chrome over CDP via `docs/opencode/006-trade-page-pwa-web-ui-verify.mjs`
(re-runnable). Three scenarios:

1. `PWA / dummy` — 390×844, `mobile: true`, `Emulation.setTouchEmulationEnabled(true)`
2. `PWA / kotak-neo` — same viewport
3. `WEB / kotak-neo` — 1440×900, `mobile: false`, touch off

Per scenario:

- The active terminal is switched through the **app's own** endpoints
  (`PUT /api/settings/terminal_mode`, `POST /api/terminal/switch`).
- Logged in by clicking the **app's own** Login button — no cookie injection, no auth bypass
  (the same method as `docs/verification/019`).
- Waits until `/api/auth/session` reports `authenticated === true` **and** the trade page's
  search input is mounted.
- Types "reliance" into the real search box and clicks the first real suggestion.
- Measures layout geometry (`getBoundingClientRect` + `getComputedStyle`).
- Performs a **real** interaction: CDP `Input.dispatchTouchEvent` drag on the slider knob
  (phone) or a DOM click on the order button (desktop).
- Screenshots the page before and after.
- **Restores the original `terminal_mode` in a `finally` block.**

### 3.1 Safety control — no order was ever placed

`Fetch.enable` intercepts every order endpoint at the `Request` stage:

```
{ urlPattern: '*/api/trade/demo/order*' }  and  { urlPattern: '*/api/terminal/order*' }
```

Each `Fetch.requestPaused` is recorded (URL + POST body) and then answered with
`Fetch.failRequest … FailedByClient`. **Routing is proven from what the page tried to send;
nothing reached any engine and no paper order was created.**

## 4. Actual results

### V1 — PWA vs web affordance

| Scenario | `matchMedia('(pointer: coarse)')` | `[role="slider"]` present | Result |
|---|---|---|---|
| PWA / dummy | `true` | **yes** — `aria-label="Slide to BUY BUY RELIANCE"` | **PASS** |
| PWA / kotak-neo | `true` | **yes** | **PASS** |
| WEB / kotak-neo | `false` | **no** — plain button `BUY RELIANCE` | **PASS** |

The pointer media feature follows the emulation exactly, so the branch is taken on a real
`pointer: coarse` query, not on a guessed viewport width.

### V2 / V3 — the slide fires the correct engine (the decisive evidence)

```
================ PWA / dummy ================
terminal switch : {"ok":true,"mode":"dummy","message":"Already active","changed":false}
login           : CLICKED | session: true | page mounted: true
interaction     : touched-slide
ORDER REQUESTS (intercepted, never sent):
   -> /api/trade/demo/order
      {"symbol":"RELIANCE","tradingSymbol":"RELIANCE-EQ","exchange":"NSE",
       "exchangeSegment":"nse_cm","token":"2885","transactionType":"BUY","product":"MIS",
       "orderType":"MKT","quantity":1,"price":0,"triggerPrice":0,"validity":"DAY",
       "ltp":1174.6,"amount":0,"lotSize":1}

================ PWA / kotak-neo ================
terminal switch : {"ok":true,"mode":"kotak","broker":"Kotak Neo","current":"dummy","changed":true}
login           : CLICKED | session: true | page mounted: true
interaction     : touched-slide
ORDER REQUESTS (intercepted, never sent):
   -> http://127.0.0.1:8000/api/terminal/order
```

| Assertion | Result |
|---|---|
| Dummy mode + slide reaches the **dummy** engine (`/api/trade/demo/order`) | **PASS** |
| Kotak mode + slide reaches the **Kotak** engine (`/api/terminal/order`) | **PASS** |
| The two modes never cross over | **PASS** |
| Desktop never touches an order endpoint without the modal | **PASS** (no request captured; modal captured instead) |

The `kotak` request body is empty in the capture because `terminalFetch` is a
cross-origin `fetch` from the browser to `:8000`; its body is not visible to the CDP
`Network` domain for that origin. The **URL** is, and the URL is the routing decision. This
limitation is recorded rather than papered over.

### V4 — the desktop confirm gate is intact

```
interaction   : CLICKED
review modal  : true          ("Review order" dialog present after one tap)
ORDER REQUESTS (intercepted, never sent):
   (none)
```

One tap on a desktop button opens the review dialog and **places nothing**. The swipe
replaced the modal on touch; it did not remove it on desktop. **PASS**

### V5 — the order bar clears the app's bottom navigation

Measured on the PWA (`main` = the scroll container, `nav` = `PhaseMobileNavigation`):

```
viewportH              844
topbar                 top 0    h 115   bottom 115
main                   top 115  h 729   bottom 844
order bar (fixed)      top 676  h 104   bottom 780     computed bottom: 64px
nav                    top 779  h 65    bottom 844
```

Order-bar bottom **780** vs nav top **779** — flush, 1 px overlap. **PASS**

Before the fix, the same measurement showed the bar bottom at **684** (a 95 px dead gap
above the nav). Root cause and rationale are in
`docs/implementation/030` §7.2.

Desktop, for comparison: `position: sticky`, `bottom: 0px`, rect `690…794`, no nav present.

### V6 — the order flow fits one phone screen

Rendered page text on the PWA (390×844), read directly from the live DOM:

```
Dummy Mode  Session  Market CLOSED  LIVE
LIVE  RELIANCE  NSE CM  RELIANCE INDUSTRIES LTD  C1,174.60  +7.90 (+0.68%)
L —  V —  H —   LC 1,143.5  UC 1,214.1
MARGIN C235est   VALUE C1,175   AVAIL C1.00L
BUY   SELL
ORDER TYPE  MKT L SL SL-M
PRODUCT  MIS CASH        VALIDITY  DAY IOC
QUANTITY  − 1 +   C Amt 235        1 qty × C1.2K = C1.2K · mgn/qty C235
MARGIN C235EST   AVAIL C1,00,000   AFTER C99,765
RISK PASS   CHARGES —   TARGETS off   BASKET 0 legs
SLIDE TO BUY   BUY RELIANCE
MKT · MIS · DAY   LTP C1174.60   SELL
```

Every control needed to place an order is inside the viewport, the order bar is pinned, and
the four insight chips carry live values without being opened. **PASS**

Visible in the captures: `docs/verification/evidence/006-pwa-dummy-before.png`,
`006-pwa-dummy-after.png`, `006-pwa-kotak-neo-before.png`, `006-pwa-kotak-neo-after.png`,
`006-web-kotak-neo-before.png`, `006-web-kotak-neo-after.png`.

### V7 — no regression

| Check | Command | Result |
|---|---|---|
| Types | `npx tsc --noEmit` | exit 0, clean |
| Lint | `npx eslint` on the 8 touched files | exit 0, 0 errors, 0 warnings |
| Suite | `npm test` | **426 tests, 423 pass, 3 fail** |
| Baseline | `docs/verification/037` | **426 tests, 423 pass, 3 fail** |
| Route | `GET http://localhost:3000/trading/trade` | HTTP 200 |
| Console | 3 scenarios | **0** uncaught exceptions, **0** console errors |
| Boundary | 3 scenarios | `could not render` = false (no `SafeRegion` tripped) |

The 3 failures are all in `tests/trade-quote-fallback.test.ts` and are **pre-existing**:
they assert against an older revision of the quote memo
(`const snap = streamed || view ? null : circuitSnap`, `stream?.ltp ?? view?.ltp`) that this
task never touched. **No regression introduced. PASS**

### 3.2 Environment restoration

```
terminal_mode restored to: dummy
GET /api/terminal/state -> {"ok":true,"terminal":"dummy","broker":"Dummy Mode","isLoggedIn":true,"mode":"dummy"}
```

The probe records the operator's terminal mode once, before any scenario mutates anything,
and restores it in a `finally`. **Verified back at `dummy`.** PASS

## 5. Honest UI state captured (not masked)

| Observation | Why it is correct |
|---|---|
| Kotak scenario shows `No session` and `RISK LOCKED` | No Kotak broker session exists here. The Risk Engine reports `EMERGENCY_BLOCK`; the UI shows it instead of inventing one. |
| `CHARGES —` | The charges preview only fetches when its panel mounts (inside the sheet). Same as before this task — the panel was previously unmounted until "Insights" was opened. |
| `L —  V —  H —` with an empty range bar | The feed had no day high/low at capture time (market closed). The bar renders only when both exist; otherwise a neutral placeholder. No fabricated range. |
| Dummy shows `C` (Coin), Kotak shows `₹` | `caps.virtualCurrency`. Fixes the defect recorded in `docs/verification/019` §8. |

## 6. Problems found during verification

| # | Problem | Fix |
|---|---|---|
| P1 | First attempt: the order bar used `sticky bottom-[calc(4rem+env(safe-area-inset-bottom))]`. Measured bar bottom **684** vs nav top **779** — a 95 px dead gap. Chrome resolves a sticky bottom offset against the scroll container's *content* box, and `PhaseContent`'s `pb-24` ate the offset. | Bar is now `fixed` on mobile (`inset-x-0`, `bottom: calc(4rem + env(safe-area-inset-bottom))`), `sticky bottom-0` from `md:`. Re-measured: bottom **780**. |
| P2 | The mobile topbar's indicator grid was `grid-cols-2 sm:grid-cols-4`, wrapping to two rows below 640 px — 165 px of chrome before the page started. | `grid-cols-4`. Re-measured topbar **165 → 115 px**. |
| P3 | Probe bug (not an app bug): the insight chips appeared to be missing. Chrome's `innerText` returns the **rendered** text, and the chip label is CSS-uppercased, so it arrives as `"RISK PASS"`, not `"Risk PASS"`. The probe regex was case-sensitive. | Probe regex made case-insensitive. Chips confirmed present in all three scenarios. |
| P4 | Probe flakiness: the desktop scenario twice ran its login step before the Suspense fallback resolved and silently ended on the login screen. | The probe now waits for the Login button, then for `/api/auth/session`, then for the search input to mount. Three consecutive clean runs afterwards. |
| P5 | The margin-amount input was squeezed to ~44 px by an unconstrained quantity field, and showed a `₹` glyph in Dummy Mode. | Quantity input is `flex-1 min-w-0`; the glyph is now the account `unit`. |

## 7. Commands executed

```powershell
npx tsc --noEmit                                   # exit 0
npx eslint components/orders/trade/*.tsx hooks/use-media-query.ts components/layout/global-topbar.tsx
                                                    # exit 0
npm test                                           # 426 / 423 / 3 (baseline 426 / 423 / 3)
node docs/opencode/006-trade-page-pwa-web-ui-verify.mjs
                                                    # exit 0, 3 scenarios
Invoke-WebRequest http://localhost:3000/trading/trade   # 200
Invoke-WebRequest http://127.0.0.1:8000/api/terminal/state   # terminal: dummy
```

## 8. Re-verification

After every fix in §6 the full three-scenario probe was re-run from scratch (fresh browser
profile per scenario), and the geometry, routing, console and layout assertions were all
re-checked. The final run is the one reported above.

## 9. Remaining risks / not proven

1. **Physical-device swipe feel.** The drag was driven by CDP touch events in headless
   Chrome. Damping, velocity and the commit haptic were tuned by reasoning; they were not
   felt on a real handset.
2. **No production build.** `next dev` is live on the same `.next` directory; a concurrent
   `next build` would corrupt the operator's running server. Build verification stays with
   `docs/pending/PENDING-002`.
3. **An accepted Kotak order is unproven.** The Kotak scenario has no broker session, so the
   Risk Engine returns `LOCKED` and the order is rejected server-side. The **routing** is
   proven; the **acceptance** is not.
4. **No automated component test.** The repo has `node --test` only (no jsdom, no
   testing-library), so `SlideToOrder` and `InsightSheet` have no unit coverage — the CDP
   probe is the regression guard.
5. **Stale pre-existing test.** `tests/trade-quote-fallback.test.ts` (3 failures) was left
   untouched; it is unrelated to this task and recorded as pre-existing.

## 10. Final result

**PARTIAL**

| Verification | Result |
|---|---|
| V1 PWA/web affordance split | PASS |
| V2 slide places an order | PASS |
| V3 dummy → dummy engine, Kotak → Kotak engine | PASS |
| V4 desktop confirm gate intact | PASS |
| V5 order bar clears the bottom nav | PASS (after fix) |
| V6 one-screen order flow on a 390 px phone | PASS |
| V7 no runtime/console/types/lint/test regression | PASS |
| Physical-device swipe feel | NOT_VERIFIED |
| Production build | NOT_VERIFIED |
| Accepted Kotak order end-to-end | NOT_VERIFIED |