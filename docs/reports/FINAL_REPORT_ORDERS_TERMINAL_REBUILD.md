# Final Report — Orders/Trading Terminal Rebuild (Trade · Basket · Suggestion · History)

**Date:** 2026-09-20
**Scope:** Replace the mock trading dashboard with a real PWA terminal wired to the
Python backend engines over one unified order-domain surface, for the Kotak Neo
(backend-only) and Dummy (paper engine) terminals.

---

## Legend

| Mark | Meaning |
|------|---------|
| ✅ VERIFIED | Confirmed via `tsc --noEmit`, `eslint`, `npm test`, or `next build` |
| ⚠️ WARNING | Works but has a known, documented limitation |
| 🔶 UNTESTED | Requires a live Kotak SDK session / broker book to observe |

---

## 1. What was removed (the "no fake actions" mandate)

| Old behavior | Why removed |
|---|---|
| DummyTrade/KotakTrade mock dashboards | Fabricated/placeholder trading, no real exercise path |
| "Wait for System" toast, fake "Auto-Execute Settings", fake LIVE pulse (Suggestion) | Toasts/invented auto-exec settings simulate actions the engine never performs |
| DummyHistory Modify / Cancel / Re-Order buttons that only closed their dialog | No-op actions — never called the backend |
| Client-invented order timeline ("Submitted"/"Acknowledged" sharing one timestamp) | Timeline must reflect the server record |
| Invented "Net P&L" (`totalValue × 0.001 − charges`) and fabricated margin/charges | Numbers the engine never produced |
| Dead "View Details" link | Button did nothing |

## 2. What was built

### 2.1 Shared layer
- `components/orders/trade/lifecycle.ts` — canonical order status vocabulary
  (FILLED / PARTIALLY_FILLED / OPEN / CANCELLED / REJECTED / verbatim passthrough),
  `execTone`, validity list.
- `components/orders/trade/capabilities.ts` — `TRADE_CAPS` mirror + `SIDE_CLASS` +
  `fmtMoney` (₹ vs Coin per terminal).
- `lib/terminal-service.ts` — in-memory JWT auth gate + terminal surface client;
  added `placeTerminalBasket`, `getTerminalOrderHistory`, `modifyTerminalOrder`,
  `cancelTerminalOrder`.
- Nested **Orders** sidebar (`NavItem.children`) wired into all four terminal shells.

### 2.2 Trade page — `components/orders/trade/*` (12 files)
- Instrument search via `/api/terminal/search` (debounced), quote polling (2.5 s),
  precheck debounce (350 ms) → Risk Engine verdict, positions polling (5 s),
  preview dialog, JWT `AuthGate`, paper-style live quote badges derived from real
  quote state, `placeTerminalOrder` through Risk→Audit→Adapter.

### 2.3 Basket page — `components/orders/basket/*` (3 files)
- Leg editor + per-leg `riskPrecheck` (all must PASS), `/api/baskets` CRUD as a
  stored-definition library, `placeTerminalBasket` → `basket_engine` → per-leg
  single-order pipe; partial failures surfaced from HTTP 400 `detail.results`.

### 2.4 Suggestion page — `components/orders/suggestion/*` (3 files)
- Real engine = `/api/dummy/suggestions*` (receiver → validate → duplicate →
  expiry → risk → order engine → dummy broker). Server-authoritative status/
  pipeline/checks; JWT-gated receive/process/reject/delete with confirm dialogs;
  honest dormant "Dummy only" card for Kotak.

### 2.5 History page — `components/orders/history/*` (2 files)
- Adapter order book via `/api/terminal/orders/{terminal}` with tolerant
  normalizer (demo + Kotak shapes), canonical status + buckets, IST grouping,
  real per-order attempt history, **real** Cancel/Modify through the Common
  Trading Core (JWT-gated), CSV export, honest metric cards (no invented P&L).

## 3. Testing added

| Suite | Covers | Count |
|---|---|---|
| `tests/history-orders.test.ts` | normalizer, buckets, canCancel/canModify, IST date keys | 8 |
| `tests/suggestion-pipeline.test.ts` | `suggestionStageState` + terminal stages | 6 |

## 4. Verification matrix

| Check | Result |
|---|---|
| `npm run typecheck` (`tsc --noEmit`) | ✅ VERIFIED — 0 errors |
| `npx eslint` (all new files) | ✅ VERIFIED — 0 errors / warnings |
| `npm test` (`node --test tests/*.test.ts`) | ✅ VERIFIED — **257/257 pass** (243 pre-existing + 14 new) |
| `npm run build` (`next build`, Turbopack) | ✅ VERIFIED — compiled, TS clean, **131 routes** incl. `/trading/{trade,basket-orders,suggestion,history}` |

## 5. Known limitations (honest)

| Item | Status |
|---|---|
| Kotak fills / margin depend on a **live broker session**; page shows "not connected" honestly when absent | 🔶 UNTESTED (SDK session) |
| Suggestion engine is Dummy-only by design; Kotak shows dormant card | ⚠️ WARNING (documented) |
| Shoonya remains Trade-only on this surface (adapter supports orders; suggestion/history restricted at the route gate) | ⚠️ WARNING |
| Legacy suggestion `process_suggestion` executes via `execute_dummy_order` (demo simulator) with its own dummy-funds risk gate — same demo book as Trade, but not through `order_engine.place` | ⚠️ WARNING (flagged in page body copy) |
| History "notional value" is price × quantity of fetched rows, labeled as such; nothing else is derived | ⚠️ documented |
| CSV export is client-generated from fetched rows (comma-joined; broker text not escaped) | ⚠️ documented |

## 6. Files touched

- New: `components/orders/{trade,basket,suggestion,history}/…` (~20 files),
  `tests/history-orders.test.ts`, `tests/suggestion-pipeline.test.ts`.
- Edited: `app/(trading)/trading/{trade,basket-orders,suggestion,history}/page.tsx`,
  `lib/terminal-service.ts`, `components/layout/nav.ts` (Orders submenu),
  all terminal shell navs.
- Backend (already present): `python-service/api/terminal.py`,
  `core/engines/{order_engine,basket_engine,risk_engine,audit_engine,target_engine}.py`,
  `services/dummy_extras.py`.