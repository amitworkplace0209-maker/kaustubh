# 030 — Trade Page PWA/Web UI Rebuild

- **Date:** 2026-10-14
- **Agent:** OpenCode (Space Bunny Free)
- **Route:** `http://localhost:3000/trading/trade`
- **Status:** see [§14 Final Status](#14-final-status)

---

## 1. Task

Requested in chat (verbatim):

> "http://localhost:3000/trading/trade page ka ui best bnao jisse pwa or web me best look wo
> or pwa me ak hi page me veiw wo jab oder from use kru mtlb or page ka logic same rakaho
> bus ui thik kro mordern or fit or pwa me by sell button ko swip krne ka option do thik kro
> page ko or dummy ka oder dummy engin ko or kotak ka kotak ke"

Decomposed (and confirmed interactively with the user before any code was written):

| # | Requirement | Decision taken |
|---|---|---|
| R1 | Modern, well-fitting UI for **PWA and web** | Full presentation rebuild of the trade page |
| R2 | PWA: the whole order flow in **one screen** | Secondary panels leave the flow; order bar is viewport-fixed |
| R3 | **Page logic unchanged** | Same APIs, hooks, risk precheck, order placement, routing |
| R4 | PWA: **swipe** the BUY/SELL button | New `SlideToOrder` control |
| R5 | Dummy order → dummy engine, Kotak order → Kotak engine | Verify; change only if broken |

User-confirmed choices:

- **Desktop layout:** single column (current), tighter — not a two-column split.
- **Swipe:** slide-to-confirm, replacing the modal on PWA.
- **Secondary panels:** compact inline chips + a bottom sheet.
- **Scope:** UI + dummy/kotak routing verification.

---

## 2. Objective

Make `/trading/trade` look and behave like a modern trading terminal on both a 390 px phone
and a 1440 px desktop, with the complete order flow reachable without scrolling and without a
fourth modal surface — **without touching a single line of order, risk or routing logic**.

## 3. Scope

**In scope**

- Presentation of `components/orders/trade/*`.
- One supporting change outside that directory (mobile topbar indicator grid) — see §9.
- Runtime proof of R5.

**Out of scope (deliberately untouched)**

- All backend / engine code, API routes, `lib/terminal-service.ts`, `lib/api.ts`,
  `lib/settings-store.ts`, `app/api/trade/demo/order/route.ts`, `app/api/terminal/**`.
- `components/shoonya/pages/trade.tsx` (a separate broker page with its own surface).
- The stale assertions in `tests/trade-quote-fallback.test.ts` (pre-existing; see §11).
- The Risk Engine's authority over order acceptance. The UI does **not** pre-judge risk —
  it renders the verdict and the server still decides (PROJECT_IMPLEMENTATION_RULE §5).

## 4. Source documentation read

- `PROJECT_IMPLEMENTATION_RULE.md` (full)
- `docs/pending/` — PENDING-001…004 read; none of them cover this task and none conflict
- `docs/frontend/FRONTEND_ROUTE_MAP.md` — confirms `/trading/trade` →
  `(trading)/trading/trade/page.tsx` (route unchanged by this task)
- `docs/frontend/FRONTEND_ARCHITECTURE.md`, `FRONTEND_CONTRACT.md`, `FRONTEND_DATA_FLOW.md`
- `docs/audits/frontend/` — no trade-page audit existed; one is created by this task
- `docs/implementation/019`, `021` and `docs/verification/019`, `024`, `032` (prior trade-page
  work), `docs/verification/037` (the recorded test baseline)
- `docs/engines/ENGINE_INVENTORY.md`, `docs/broker/BROKER_INTEGRATION_MAP.md`,
  `docs/engines/DUMMY_MODE_ARCHITECTURE.md` (terminal switching + routing)
- `docs/opencode/006-trade-page-pwa-web-ui-rebuild-plan.md` (this task's working plan)

## 5. Existing state

`TradePageInner` (62 KB) already owned the whole truth boundary correctly: realtime
subscription, the five-level quote merge, bucketed risk precheck, positions/funds polling,
validation and margin math, and a single `handlePlaceOrder()`. Its children were already
independent, memoised and individually wrapped in `SafeRegion` error boundaries.

The UI around that logic was the problem.

### 5.1 Order routing (R5) — traced, found already correct

| Mode | Branch | Client call | Chain |
|---|---|---|---|
| `dummy` | `isDemo` | `placeDemoOrder()` — `lib/api.ts:1081` | `POST /api/trade/demo/order` (Next proxy `app/api/trade/demo/order/route.ts`) → `POST /api/demo/order/place` → paper/dummy engine |
| `kotak-neo` | `!isDemo` | `placeTerminalOrder('kotak-neo', base)` — `lib/terminal-service.ts:293` | `POST /api/terminal/order` with `terminal: toTerminalId('kotak-neo') === 'kotak'` → Common Trading Core (Risk→Audit→Adapter) → Kotak adapter |
| `shoonya` | separate page component | — | `/api/terminal/*` with `terminal: 'shoonya'` |

`toTerminalId()` (`lib/settings-store.ts:36`) is the single mapping authority and
`isDemo = mode === 'dummy'` is the only selector. **R5 needed no code change** — only proof
(§11, §12).

## 6. Problems found

1. **P2 — the PWA order flow was not one screen.** Search → stock card → ticket → a collapsed
   "Insights" toggle → a sticky action bar, with the confirm dialog as a fourth surface on
   top. Placing an order needed at least one extra tap before the risk verdict was even
   readable, and the modal and the sticky bar fought for the same ~120 px.
2. **P2 — the sticky action bar sat behind the app's own bottom tab bar.** `sticky bottom-0`
   inside `PhaseContent` pins to the scrollport, but `PhaseMobileNavigation` is
   `fixed bottom-0 h-16` on top of it.
3. **P3 — the "Insights" toggle carried no data.** It was a grey full-width button; the risk
   verdict, the charge estimate, the armed bracket and the basket count were all hidden
   behind it.
4. **P3 — the mobile topbar wrapped its indicator grid into two rows below 640 px**, burning
   ~110 px of a phone viewport before the page started (measured 165 px, now 115 px).
5. **P4 — no shared type scale in the trade components.** `text-[8px]` … `text-[17px]`
   literals were chosen ad hoc and the header's money snapshot was hidden below `sm`.
6. **P4 — Dummy Mode printed `₹` for virtual Coin.** Recorded as a known cosmetic defect in
   `docs/verification/019-trade-page-unblocked-verification.md` §8 ("not changed"). The
   ticket already labelled it `C`; the header did not. The two disagreed.
7. **P4 — the amount input was squeezed to ~44 px** by an unconstrained quantity field.
8. **P4 — the side-flip duplicated the ticket's own BUY/SELL control** and burned a whole
   extra row in the action bar.

## 7. Design decision

Keep `TradePageInner` as the orchestration and truth boundary, unchanged. Change only
presentation, and add exactly two new presentation components.

### 7.1 Confirm-parity rule (how the swipe stays a *replacement*, not a *bypass*)

`confirm.buy` / `confirm.sell` (per-mode, per-terminal settings) already decide whether a
confirmation step exists. The slide **replaces the review modal 1:1**:

| confirm setting | Web (mouse) | PWA (finger) |
|---|---|---|
| ON (default) | review modal → Confirm | **slide to confirm** → place |
| OFF | direct place | direct place (tap button) |

A user who explicitly turned confirmation off is never forced to swipe; a user who left it
on always gets exactly one deliberate gesture on either platform. The setting remains the
single authority — it is read through one helper, `confirmRequired(side)`.

### 7.2 Order-bar positioning

`position: sticky` **cannot** solve the bottom-nav collision here. Measured in Chrome:
a sticky bottom offset resolves against the scroll container's *content* box, so
`PhaseContent`'s `pb-24` silently ate 96 px and left a dead gap above the nav
(bar bottom 684 px vs nav top 779 px). The bar is therefore **`fixed` on mobile**
(`bottom: calc(4rem + env(safe-area-inset-bottom))`, `inset-x-0`) and falls back to
`sticky bottom-0` from `md:` up where no bottom nav exists. Measured after the fix:
bar bottom **780 px**, nav top **779 px**.

### 7.3 Secondary panels

Charges / Risk / Targets / Basket keep their **existing components and props**. Only their
*location* changed: a summary chip that is always on screen, plus a sheet for the detail.
The chip values are read from the same state the panels read from — nothing is recomputed,
cached or invented.

## 8. Files created

| File | Purpose |
|---|---|
| `components/orders/trade/slide-to-order.tsx` | Slide-to-confirm order control (touch) / plain tap button (desktop) |
| `components/orders/trade/insight-sheet.tsx` | Always-visible live chips + bottom sheet (mobile) / side drawer (desktop) |
| `hooks/use-media-query.ts` | SSR-safe `matchMedia` hook; `useTouchPointer()` gates the PWA affordances |
| `docs/audits/frontend/TRADE_PAGE_UI_AUDIT.md` | Frontend audit — none existed for this page |
| `docs/opencode/006-trade-page-pwa-web-ui-rebuild-plan.md` | Working plan for this task |
| `docs/opencode/006-trade-page-pwa-web-ui-verify.mjs` | Headless-Chrome CDP verification probe (re-runnable) |

## 9. Files changed

| File | Change |
|---|---|
| `components/orders/trade/trade-page.tsx` | New composition: insight chips, fixed/sticky order bar, `confirmRequired` helper, single `unit` for all money, `max-w-5xl`, `pb-24` clear for the fixed bar |
| `components/orders/trade/selected-stock-card.tsx` | Modern header: 24 px LTP, day-range bar with a live marker, money tiles visible at every breakpoint, account currency from `caps` |
| `components/orders/trade/order-ticket.tsx` | Segmented side / type / product / validity (one tap instead of a dropdown), 40 px thumb-sized rows, balanced qty + amount, currency glyph from `caps` |
| `components/layout/global-topbar.tsx` | Mobile indicator grid `grid-cols-2 sm:grid-cols-4` → `grid-cols-4` (one row). **Supporting change outside the trade directory**, impact-analysed: it is app-global chrome, presentational only, no state, no API, no props. It was the single largest obstacle to R2. Measured effect: topbar 165 px → 115 px. |

No files removed.

## 10. Backend / API / database / realtime / scheduler changes

**None.** No engine, route, service, schema or scheduler was touched. Realtime channels,
the quote merge, the risk precheck debounce and bucketing, and order placement are
byte-for-byte the same logic.

## 11. Tests

```
npx tsc --noEmit                                  -> exit 0, clean
npx eslint <8 touched files>                      -> exit 0, 0 errors, 0 warnings
npm test                                          -> 426 tests | 423 pass | 3 fail
```

The 3 failures are **pre-existing and unchanged**:

- All three live in `tests/trade-quote-fallback.test.ts` (lines 70, 100, 142).
- `426 / 423 / 3` is exactly the baseline recorded in
  `docs/verification/037-topbar-manual-login-backend-terminal-resolution.md` §"tests".
- They assert against an **older** revision of the quote memo (`const snap = streamed || view
  ? null : circuitSnap`, `stream?.ltp ?? view?.ltp`) and against a margin-arithmetic line in
  the stock card that the pre-existing header never had. This task did not touch the quote
  memo at all.
- Recorded as already known in `docs/implementation/028` and `029`, and in
  `docs/verification/036` and `037`.

`npm run build` was **not** re-run: the operator's `next dev` is live on the same `.next`
directory and a concurrent production build would corrupt the running dev server. Build
verification remains tracked by `docs/pending/PENDING-002-build-and-test-verification.md`.

## 12. Verification

Full evidence in `docs/verification/038-trade-page-pwa-web-ui-rebuild.md`. Summary:

- Headless Chrome over CDP, real login through the app's own Login button.
- **Every order endpoint was intercepted with `Fetch.requestPaused` and deliberately failed**,
  so no order reached any engine — routing is proven from the request URL and POST body.
- Dummy + phone → touch-drag fired `POST /api/trade/demo/order` (dummy payload).
- Kotak Neo + phone → touch-drag fired `POST /api/terminal/order` (Kotak engine).
- Desktop → no slider; tap opens the "Review order" dialog (confirm gate intact).
- 0 uncaught exceptions, 0 console errors in all three scenarios.
- `terminal_mode` read before and restored after — the operator's environment was verified
  back at `dummy` (`GET /api/terminal/state` → `{"terminal":"dummy"}`).

## 13. Remaining issues

- The slide's damping/velocity feel is tuned by reasoning, not by physical-device testing.
- The Kotak scenario runs with **no broker session**, so the Risk Engine reports `LOCKED` and
  the order request is rejected server-side. That is correct behaviour, but it means the
  *accepted* Kotak path is unproven end-to-end.
- The mobile topbar's "Manual Login" control still overflows its row at 390 px (pre-existing,
  outside this task).
- `tests/trade-quote-fallback.test.ts` remains stale (3 failures, pre-existing).

## 14. Final Status

**VERIFIED_WITH_LIMITATIONS**

- The UI change is `IMPLEMENTED`, `TYPECHECKED`, `LINTED` and `RUNTIME_VERIFIED` in a real
  browser on both breakpoints, including the real touch gesture.
- `RUNTIME_VERIFIED` for R5 routing (request target proven, nothing actually placed).
- **Not** verified: physical-device swipe feel, production build, an accepted Kotak order.
- Pre-existing failures and the pre-existing mobile topbar overflow are unchanged and
  explicitly not addressed.

---

## Cross-references

- Related working plan: `docs/opencode/006-trade-page-pwa-web-ui-rebuild-plan.md`
- Related verification: `docs/verification/038-trade-page-pwa-web-ui-rebuild.md`
- Related session log: `docs/logs/LOG-012-2026-10-14-trade-page-pwa-web-ui.md`
- Frontend audit: `docs/audits/frontend/TRADE_PAGE_UI_AUDIT.md`
- Pending: `docs/pending/PENDING-005-trade-page-remaining-verification.md`
- Prior trade-page work: `docs/implementation/019-trade-page-unblocked.md`,
  `docs/implementation/021-trade-page-realtime-performance.md`
- Prior verification: `docs/verification/019-trade-page-unblocked-verification.md`,
  `docs/verification/024-trade-page-live-verification.md`,
  `docs/verification/032-trade-page-select-realtime.md`
- Test baseline: `docs/verification/037-topbar-manual-login-backend-terminal-resolution.md`