# TRADE PAGE UI AUDIT

**What this document is:** the CURRENT state of `/trading/trade`, as verified on
2026-10-14. It is an *audit*, not a specification.

- **Subject:** `docs/implementation/030-trade-page-pwa-web-ui-rebuild.md`
- **Verified by:** `docs/verification/038-trade-page-pwa-web-ui-rebuild.md`
- **Baseline:** this is the **first** frontend audit for this page.

---

## 1. Route and component tree

```
app/(trading)/trading/trade/page.tsx        'use client'
  └─ TerminalRouteGate(path="/trading/trade", allowed=['dummy','kotak-neo','shoonya'])
       ├─ mode === 'shoonya'  → components/shoonya/pages/trade.tsx
       └─ else                → components/orders/trade/trade-page.tsx  <TradePage mode>
            └─ SafeRegion "Trade page" (resetKey = mode)
                 └─ TradePageInner  (key = mode)
                      ├─ status strip          (session · market · data · engines)
                      ├─ SafeRegion "Search" → InstrumentSearch   (sticky top)
                      ├─ SafeRegion "Order card"
                      │    ├─ SelectedStockCard
                      │    ├─ OrderTicket
                      │    ├─ margin strip (margin · avail · after · position)
                      │    ├─ SafeRegion "Execution" → ExecutionState
                      │    └─ SafeRegion "Insights" → InsightSheet (chips + sheet)
                      │         └─ ChargesPanel · RiskMarginPanel · TargetPanel · basket
                      ├─ SafeRegion "Action bar" → SlideToOrder + summary line
                      └─ SafeRegion "Confirm dialog" (desktop only)
```

## 2. Actual UI structure today

| Region | Rendering |
|---|---|
| Status strip | Terminal name + session/market/data `StatusBadge`s + engine-health pill. Horizontally scrollable. |
| Search | Sticky. Real Search Engine results only — no synthetic quotes. |
| Instrument header | Symbol, exchange, company, live/stale badge, LTP (24 px), change/change %, day range **with a live LTP marker**, LC/UC, and Margin / Value / Avail tiles — **visible at every breakpoint**. |
| Ticket | BUY/SELL segmented · order type segmented (MKT/L/SL/SL-M) · product + validity segmented · quantity stepper with a margin-amount field (either one drives the other) · limit/trigger inputs (only when the type needs them) · live marketability line. |
| Margin strip | Required margin (with `est` marker) · available · remaining · net position. |
| Insight chips | **Four always-visible chips**: Risk verdict, Charges, Targets, Basket. Each opens the matching panel in a sheet. |
| Order bar | Viewport-fixed on mobile, sticky on desktop. Slide-to-confirm (touch) or BUY/SELL button (desktop) + a one-line order summary + a side-flip control. |
| Confirm dialog | Desktop only. Not reachable on a touch build when confirmation is on — the slide is that step. |
| Empty state | "Pick a stock to start". |
| Error containment | Every region has its own `SafeRegion` with a `resetKey`, so one crash cannot blank the page or the order card. |

## 3. Data sources (real, never fabricated)

| Value | Source |
|---|---|
| LTP / OHLC / circuits | Five-level merge: shared tick stream → WS#3 `trading` view → on-demand broker quote → market-watch REST snapshot → search seed. Provenance is exposed on `quote.source`. |
| Order type / product options | `caps.orderTypes` / `caps.products`, mirroring the backend `BrokerCapabilities` registry |
| Risk verdict | `POST` risk precheck (450 ms debounce, ~0.25 % LTP bucketing) + broker margin preview |
| Charges | Dummy → `POST /api/demo/preview`; Kotak/Shoonya → honestly "no backend charges API" |
| Margin | Broker margin API (Kotak) or backend dummy preview; falls back to a local estimate clearly labelled `est` |
| Currency | `caps.virtualCurrency` — Dummy prints `C` (Coin), real terminals print `₹` |

## 4. Realtime channels

`trading` (per selected instrument), `orders`, `positions` — WS#3 via
`useFrontendRealtime()`. Positions additionally poll every 8 s while the tab is visible.

## 5. Order routing (current, verified)

| Mode | Endpoint reached | Engine |
|---|---|---|
| `dummy` | `POST /api/trade/demo/order` → `/api/demo/order/place` | Dummy / paper engine |
| `kotak-neo` | `POST /api/terminal/order` (`terminal: "kotak"`) | Common Trading Core → Kotak adapter |
| `shoonya` | separate page component, `/api/terminal/*` | Common Trading Core → Shoonya adapter |

`isDemo = mode === 'dummy'` is the **only** selector. `toTerminalId()` in
`lib/settings-store.ts` is the only mapping authority.

## 6. Confirmation behaviour today

| confirm.* setting | Web (mouse) | PWA (finger) |
|---|---|---|
| ON (default) | review dialog → Confirm | slide to confirm → place |
| OFF | direct place | direct place (tap) |

The setting is the single authority; the gesture is its implementation, not a bypass.

## 7. Responsive behaviour today (measured, 390×844 and 1440×900)

| Measurement | Value |
|---|---|
| Mobile topbar height | 115 px |
| Scroll container | 729 px |
| Order bar (fixed) | `top 676 · h 104 · bottom 780` |
| Bottom nav | `top 779 · h 65` |
| Desktop topbar | 56 px |
| Desktop order bar | `sticky bottom-0`, rect `690…794` |
| Content max width | `max-w-5xl`, centred |
| Touch target floor | `.dense-ui` opts out of the global 44 px rule so the ticket can stay dense; primary controls are 40–44 px anyway |

## 8. Tests

- No component-test runner exists (`node --test` only, no jsdom/testing-library).
- Regression guard for this page's UI: `docs/opencode/006-trade-page-pwa-web-ui-verify.mjs`
  (headless Chrome over CDP; asserts routing, affordance split, geometry and console health).
- `tests/trade-quote-fallback.test.ts` covers the quote-merge chain but has **3 pre-existing
  stale failures** against an older revision of the quote memo.

## 9. Known defects / limitations

| # | Issue | State |
|---|---|---|
| 1 | Swipe damping/velocity feel is untuned — verified only via CDP touch events in headless Chrome, never on a handset. | Open |
| 2 | No accepted Kotak order has been proven end to end (no broker session in this environment). Routing is proven; acceptance is not. | Open |
| 3 | `tests/trade-quote-fallback.test.ts` — 3 stale assertions against an older quote memo. | Pre-existing, unrelated |
| 4 | The mobile topbar's "Manual Login" control overflows its row at 390 px. | Pre-existing, out of scope |
| 5 | The charge estimate is `—` until its panel is opened in the sheet (the preview only runs when the panel mounts). Same as the previous collapsible behaviour. | By design, honest |
| 6 | Charges have no backend API for Kotak/Shoonya; the panel says so rather than inventing rates. | Documented limitation |

## 10. Change history

| Version | Date | Change | Agent |
|---|---|---|---|
| 1.0 | 2026-10-14 | Initial audit — first frontend audit for `/trading/trade`, written after the PWA/web UI rebuild | OpenCode |

## 11. Cross-references

- Implementation: `docs/implementation/030-trade-page-pwa-web-ui-rebuild.md`
- Verification: `docs/verification/038-trade-page-pwa-web-ui-rebuild.md`
- Session log: `docs/logs/LOG-012-2026-10-14-trade-page-pwa-web-ui.md`
- Pending: `docs/pending/PENDING-005-trade-page-remaining-verification.md`
- Working plan: `docs/opencode/006-trade-page-pwa-web-ui-rebuild-plan.md`
- Route map: `docs/frontend/FRONTEND_ROUTE_MAP.md`