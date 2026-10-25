# TRADE PAGE UI AUDIT

**What this document is:** the CURRENT state of `/trading/trade`, as verified on
2026-10-21. It is an *audit*, not a specification.

- **Subject:** `docs/implementation/033-trade-page-full-rebuild.md`
- **Verified by:** `docs/verification/041-trade-page-full-rebuild.md`
- **Baseline:** this audit previously described the PREVIOUS implementation
  (v1.0, 2026-10-14). The page was deleted and rebuilt; this is the new reality.

---

## 1. Route and component tree

```
app/(trading)/trading/trade/page.tsx        'use client'
  └─ TradeErrorBoundary
       └─ Suspense → TradePageSkeleton
            └─ components/trading/trade-page.tsx        ← the truth boundary
                 ├─ TerminalRail            session · market · feed · engines · caps
                 ├─ SafeRegion "Search"    InstrumentSearch (canonical, shared with the basket)
                 ├─ grid (lg: 2 columns)
                 │   ├─ SafeRegion "Quote"     QuoteHeader
                 │   ├─ SafeRegion "Order ticket"
                 │   │    ├─ AuthGate (only when there is no broker session)
                 │   │    ├─ OrderTicketCard    side · type · product · validity · qty · prices
                 │   │    ├─ MarginStrip        margin · available · after · value
                 │   │    └─ ExecutionPanel     the broker's own result
                 │   └─ SafeRegion "Inspector" TradeInspector
                 │        ├─ RiskPanel      ├─ ChargesPanel   ├─ TargetsPanel
                 │        └─ BasketPanel    └─ PositionPanel
                 ├─ SafeRegion "Action bar"  OrderActions (slide-to-confirm / tap + summary)
                 └─ SafeRegion "Confirm dialog" ConfirmOrderDialog
```

There is exactly ONE implementation. The two previous ones
(`components/orders/trade/trade-page.tsx` and `components/trading/trade-page-client.tsx`)
and their duplicated children were deleted.

## 2. Actual UI structure today

| Region | Rendering |
|---|---|
| Status rail | terminal name + mode chip, session, market, feed state, engine health (`n/4`), and a `caps mirror` chip while the live capability registry has not answered. A closed exchange reads `NO FEED`, never a red OFFLINE. |
| Search | sticky, canonical Search Engine results, live/stale badge, lot, per-share margin, LTP and change; the same component the basket page uses. |
| Instrument header | symbol, exchange, live/snapshot badge, company, instrument type, lot, **LTP at 28 px**, change + change %, open/high/low/prev close/volume/circuits, and a day-range bar with the live LTP marker. The source line states where the price came from. |
| Ticket | BUY/SELL segmented · order type (from the registry) · product (from the registry) · validity · lot-aware quantity stepper · margin-amount field that sizes the quantity · limit/trigger inputs (only when the type needs them) · a live marketability line. |
| Money strip | four tiles: required margin (labelled `est` when derived locally, `broker` when the broker API answered), available, after, order value. Unknown values render as `—`, never `0`. |
| Inspector | five always-visible tabs: **Risk · Charges · Targets · Basket · Position**. Risk shows the server's verdict, its reasons and its per-check results; Charges shows the canonical charge engine's breakdown; Targets shows the engine-backed target + any armed auto square-off; Basket shows the queued legs; Position shows the net position and the reported unrealised P&L. |
| Order bar | viewport-fixed on mobile (above the app's bottom navigation), sticky on desktop. Slide-to-confirm on a touch build, a BUY/SELL button on a mouse build, plus a one-line order summary and a labelled side-flip control. |
| Confirm dialog | the exact order that will be sent: instrument, side, product, type, quantity, price, trigger, LTP, order value, margin, validity. |
| Execution panel | the broker's / paper engine's own status: `Filled` (with qty + average price), `Working` (with the reason and the price it waits for) or `Order not placed` (with the server's message). |
| Empty state | "Pick a stock to start". |
| Error containment | every region has its own `SafeRegion` with a `resetKey`, so one crash cannot blank the page or the order card. |

## 3. Data sources (real, never fabricated)

| Value | Source |
|---|---|
| LTP / OHLC / circuits / volume | four-level chain: shared SSE tick stream → central tick-store snapshot (`/api/market-watch/tick-snapshot`) → on-demand broker quote → search seed. The source label names the level that won. |
| Order types / products / margin API / charge model / currency | the BACKEND capability registry (`GET /api/terminal/list` → `capabilities`), with a static mirror as the pre-fetch fallback. |
| Risk verdict | `POST /api/services/risk/validate` — a **preview**: it reads the duplicate-suppression window and never records an order intent. |
| Margin | the broker margin API when the terminal supports it, otherwise a locally derived estimate that is labelled `est`. |
| Charges | the app's canonical charge engine (`lib/charge-engine.ts`) with the statutory rates in `config/`. |
| Position / funds | the terminal's own position + funds reads, polled every 8 s while the tab is visible. |
| Live price freshness | the backend receive time of the tick (`receivedAt`), not the broker's feed event time (which lags by minutes). |

## 4. Realtime channels

The page subscribes to the **shared browser SSE tick channel** (`/api/ticks/stream`) —
same-origin, already used by every other live surface, and it works from a phone. The
`/ws/realtime` socket is NOT used for prices: the browser socket points at the page
origin, which cannot proxy a WebSocket upgrade (proven in
`docs/verification/041-trade-page-full-rebuild.md` §3.3).

## 5. Order routing (current, verified)

| Mode | Endpoint reached | Engine |
|---|---|---|
| `dummy` | `POST /api/trade/demo/order` → `/api/demo/order/place` | Dummy / paper engine (Risk → Audit → Adapter) |
| `kotak-neo` | `POST /api/terminal/order` (`terminal: "kotak"`) | Common Trading Core → Kotak adapter |
| `shoonya` | `POST /api/terminal/order` (`terminal: "shoonya"`) | Common Trading Core → Shoonya adapter |

The backend accepts an order only for its ACTIVE terminal (`require_active`), so the
terminal identity is the backend's, not the browser's.

## 6. Confirmation behaviour today

| confirm.* setting | Web (mouse) | PWA (finger) |
|---|---|---|
| ON (default) | review dialog → Confirm | slide to confirm → place |
| OFF | direct place | direct place (tap) |

The setting is the single authority; the gesture is its implementation, never a bypass.

## 7. Responsive behaviour today (measured, 390×844)

| Measurement | Value |
|---|---|
| Order bar (fixed) | `top 655 · h 125 · bottom 780` |
| Bottom nav | `top 779 · h 65` |
| Commit gesture | slide control present (48 px knob) |
| Horizontal overflow | 0 px |
| Desktop | two columns (ticket + 400 px inspector), content max width 1400 px |
| Type scale | 11 px floor; body 12-14 px; symbol 18 px; LTP 28 px; all prices tabular-nums mono |

## 8. Tests

- No component-test runner exists (`node --test` only, no jsdom/testing-library).
- `tests/trade-quote-fallback.test.ts` — 12 assertions pinning the quote chain, the
  honest source labels, the snapshot polling and the "unknown is `—`, never `0`" rule.
- `tests/trading-session-hydration.test.ts` — the session-hydration invariants.
- `python-service/tests/test_demo_order_intent.py` — the paper order-intent mapping.
- `python-service/tests/test_common_trading_core.py` — the Risk Engine phases.
- Re-runnable browser probes:
  `docs/opencode/008-trade-page-rebuild/trade-page-verify.mjs` and `…/trade-page-mobile.mjs`.

## 9. Known defects / limitations

| # | Issue | State |
|---|---|---|
| 1 | Swipe damping/velocity feel is untuned — the gesture MECHANICS are proven with real touch events (spring-back below the commit line, commit above it, no order on the short drag), but never on a handset. | Open (PENDING-005 / PENDING-008 V1) |
| 2 | No accepted Kotak order has been proven end to end (the probe never sends one to a live broker; the broker account also holds Net ₹10 today). The routing and the payload ARE proven. | Open (PENDING-005 / PENDING-008 V2) |
| 3 | The backend loses its HTTP listener on Windows; a listener doctor in the launcher now re-binds the socket in place (~10 s per event, was 2-4 minutes). The underlying network-stack defect is not fixed. | Mitigated (PENDING-007) |
| 4 | `lib/charge-engine.ts` treats every product except CNC/CO/MARGIN as intraday equity, while this platform treats CASH as full-payment delivery. The trade page maps CASH onto the engine's delivery vocabulary locally; the shared engine is unchanged (it drives historical snapshots). **Verified**: CASH → delivery STT (0.1 %), MIS → intraday STT (0 % on a buy). | Documented limitation |
| 5 | The terminal's own charges are not available for Kotak/Shoonya (no broker charges API); the panel shows the configured-rules estimate and says so. | By design, honest |
| 6 | The first search after a cold backend restart used to exceed the shared 8 s ceiling and show a hard "Search unavailable". The order page now uses a 15 s ceiling and one automatic retry. | Fixed (2026-10-22) |

## 10. Change history

| Version | Date | Change | Agent |
|---|---|---|---|
| 1.0 | 2026-10-14 | Initial audit — first frontend audit for `/trading/trade`, written after the PWA/web UI rebuild | OpenCode |
| 2.0 | 2026-10-21 | Rewritten after the delete-and-rebuild: the audited implementation was the wrong one, the page now has a single implementation, an SDK-driven capability surface, an SSE price source and a two-column layout | OpenCode |
| 3.0 | 2026-10-22 | Live verification pass: the gesture mechanics, the production build, the LAN path and the charge segments are proven; the search resilience and the backend listener are fixed | OpenCode |

## 11. Cross-references

- Implementation: `docs/implementation/033-trade-page-full-rebuild.md`
- Verification: `docs/verification/041-trade-page-full-rebuild.md`,
  `docs/verification/042-trade-page-live-verification.md`
- Session log: `docs/logs/LOG-014-20261021-trade-page-full-rebuild.md`,
  `docs/logs/LOG-015-20261022-trade-page-live-verification.md`
- Pending: `docs/pending/PENDING-005-trade-page-remaining-verification.md`,
  `docs/pending/PENDING-007-backend-listener-loss.md`,
  `docs/pending/PENDING-008-trade-page-live-verification.md`
- Previous implementation record: `docs/implementation/030-trade-page-pwa-web-ui-rebuild.md`
- Route map: `docs/frontend/FRONTEND_ROUTE_MAP.md`
