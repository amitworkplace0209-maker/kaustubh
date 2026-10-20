# 006 — Trade Page PWA/Web UI Rebuild Plan

OpenCode working document.

**Purpose:** plan + traceability for the `/trading/trade` UI rebuild requested in chat.
**Date:** 2026-10-14
**Status:** working reference (converted to permanent records at the end of the task)

---

## 1. Task (as requested in chat)

> "http://localhost:3000/trading/trade page ka ui best bnao jisse pwa or web me best look wo
> or pwa me ak hi page me veiw wo jab oder from use kru mtlb or page ka logic same rkaho
> bus ui thik kro mordern or fit or pwa me by sell button ko swip krne ka option do thik kro
> page ko or dummy ka oder dummy engin ko or kotak ka kotak ke"

Decomposed requirements:

| # | Requirement | Interpretation |
|---|---|---|
| R1 | UI best / modern for PWA **and** web | Modern, dense, terminal-grade visual language on both breakpoints |
| R2 | PWA: order flow visible in **one page / one screen** | No drawer, no modal, no hidden sections for the order itself |
| R3 | Page **logic unchanged** | Same APIs, same hooks, same risk precheck, same order placement, same routing |
| R4 | PWA: **swipe** the BUY/SELL button | Slide-to-confirm gesture replacing the confirm modal on touch |
| R5 | Dummy order → **dummy engine**; Kotak order → **Kotak engine** | Verify terminal routing; fix only if broken |

## 2. Decisions taken (user-confirmed via interactive question)

| Decision | Choice |
|---|---|
| Desktop layout | **Single column (current), tighter** — not a 2-column split |
| Swipe behaviour | **Slide-to-confirm, replaces the modal on PWA** |
| Secondary panels | **Compact inline chips + bottom sheet** |
| Scope | **UI + dummy/kotak routing verification** |

## 3. Existing state (traced, not assumed)

Route → `app/(trading)/trading/trade/page.tsx`

```
TerminalRouteGate(path="/trading/trade", allowed=['dummy','kotak-neo','shoonya'])
  └── mode === 'shoonya' ? <ShoonyaTradePage/> : <TradePage mode={mode}/>
        └── SafeRegion → TradePageInner(key={mode})
```

`TradePageInner` (62 KB) owns:
- realtime subscription (`trading` / `orders` / `positions` channels)
- quote precedence merge (tick stream → WS trading → on-demand broker → market-watch REST → search seed)
- bucketed risk precheck (`bucketLtp` ~0.25% grid, 450 ms debounce)
- positions poll, funds fetch, trigger lookup
- validation + margin math (`marginPerShare`, `quantityFromMargin`)
- `handlePlaceOrder()` — the single order-placement function
- `requestPlace()` — confirm-setting gate → modal or direct place

Child components (all already independent + memoized):
`instrument-search`, `order-ticket`, `charges-panel`, `risk-margin-panel`,
`target-panel`, `execution-state`, `selected-stock-card`, `capabilities`, `lifecycle`, `types`.

### 3.1 Order routing (R5) — VERIFIED CORRECT, no change needed

| Mode | Branch | Call | Chain |
|---|---|---|---|
| `dummy` | `isDemo === true` | `placeDemoOrder()` (`lib/api.ts:1081`) | `POST /api/trade/demo/order` (Next proxy, `app/api/trade/demo/order/route.ts`) → `POST /api/demo/order/place` (paper/dummy engine) |
| `kotak-neo` | `isDemo === false` | `placeTerminalOrder('kotak-neo', base)` (`lib/terminal-service.ts:293`) | `POST /api/terminal/order` with `terminal: toTerminalId('kotak-neo') === 'kotak'` → Common Trading Core (Risk→Audit→Adapter) → Kotak adapter |
| `shoonya` | separate page component | — | `/api/terminal/*` with `terminal: 'shoonya'` |

`toTerminalId()` (`lib/settings-store.ts:36`) is the single mapping authority.
**Conclusion:** R5 is already satisfied. The task is to prove it, not rewrite it.

## 4. Problems found in the current UI

1. **P2 — the order flow is not one screen.** The page is a vertical stack: sticky search →
   stock card → ticket → margin strip → *collapsed* "Insights" toggle → sticky action bar.
   Placing an order requires at minimum one extra tap to open Insights, and the confirm
   dialog is a fourth surface (modal) on top of that.
2. **P3 — two confirm surfaces on a phone.** The full-screen preview modal competes with the
   sticky action bar for the same ~120 px of a small viewport.
3. **P3 — the Insights toggle is a generic grey button.** It carries no live summary, so the
   user cannot see the risk verdict or the charge estimate without opening it.
4. **P4 — typography scale is ad-hoc.** `text-[9px]` / `text-[10px]` / `text-[11px]` /
   `text-[13px]` / `text-[15px]` / `text-[17px]` appear inline with no shared token, and the
   stock card hides its money snapshot below `sm`.
5. **P4 — the action bar duplicates the side toggle** ("Flip to SELL") that already exists in
   the ticket, and burns a row of vertical space doing it.

## 5. Design decision

Keep `TradePageInner` as the orchestration + truth boundary (unchanged), and change only
**presentation**:

- **New** `slide-to-order.tsx` — the touch confirmation gesture.
- **New** `insight-sheet.tsx` — chips (always visible, live) + sheet (on demand).
- **Modernized** `selected-stock-card.tsx` + `order-ticket.tsx` — one type scale, tighter grid,
  money snapshot visible at every breakpoint.
- `trade-page.tsx` — new composition, same state/effects/calls.

### 5.1 Confirm-parity rule (important, to honour R3 + R5)

`confirm.buy` / `confirm.sell` (per-mode settings) already decide whether a confirmation step
is required. The swipe **replaces the modal 1:1**, it does not bypass it:

| confirm setting | Web | PWA |
|---|---|---|
| ON (default) | review modal → confirm | **slide to confirm** → place |
| OFF | direct place | direct place (tap button) |

So a user who explicitly disabled confirmation is never forced to swipe, and a user who left
it on gets exactly one deliberate gesture either way.

### 5.2 Invariants that must not change

- `handlePlaceOrder()` remains the **only** function that talks to an engine.
- `isDemo` remains the **only** switch that chooses dummy vs broker routing (R5).
- The risk precheck, its debounce, its bucketing and its verdicts are untouched.
- No fabricated prices/quotes — `—` / `UNAVAILABLE` stay honest.
- Every panel stays inside its own `SafeRegion`.

## 6. Files

### Created
- `components/orders/trade/slide-to-order.tsx`
- `components/orders/trade/insight-sheet.tsx`
- `hooks/use-media-query.ts`

### Changed
- `components/orders/trade/trade-page.tsx`
- `components/orders/trade/selected-stock-card.tsx`
- `components/orders/trade/order-ticket.tsx`

### Untouched (deliberately)
- engine code, API routes, `lib/terminal-service.ts`, `lib/api.ts`, `lib/settings-store.ts`
- `app/api/trade/demo/order/route.ts`, `app/api/terminal/**`
- `components/shoonya/pages/trade.tsx` (separate broker page, out of scope)

## 7. Verification plan

- `npx tsc --noEmit`
- `npx eslint` on every touched file
- `npm test` (existing suite must stay green)
- `GET /trading/trade` → 200, HTML renders
- Route assertions proving R5 (no behavioural change expected)
- **NOT** verified here: real drag gesture on a physical device, live broker acceptance.

## 8. Related documentation

- Related implementation: `docs/implementation/030-trade-page-pwa-web-ui-rebuild.md`
- Related verification: `docs/verification/038-trade-page-pwa-web-ui-rebuild.md`
- Related session log: `docs/logs/LOG-012-2026-10-14-trade-page-pwa-web-ui.md`
- Related prior work: `docs/implementation/019-trade-page-unblocked.md`,
  `docs/implementation/021-trade-page-realtime-performance.md`
- Related verification of the same page: `docs/verification/024-trade-page-live-verification.md`,
  `docs/verification/032-trade-page-select-realtime.md`

## 9. Known limitations of this plan

- "Best looking" is subjective; no screenshot baseline exists in the repo, so the visual
  result cannot be objectively proven, only rendered + typechecked + linted.
- Touch gesture feel (velocity/damping) is tuned by reasoning, not by device testing here.