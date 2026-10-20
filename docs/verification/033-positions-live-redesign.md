# 033 — Positions page live redesign (Total/Open/Closed/Charges/Total/Net)

Date: 2026-10-07, market hours
Page: `/trading/positions` → dummy `DummyPositions` (standard `_pages` untouched)

## 1. Live-LTP diagnosis

- SSE tick stream carries the broad universe live (spot-checked 8 frames: LTP +
  token + bare/trading symbols). Matching was symbol-only on both sides, so any
  suffixed/renamed identifier silently missed its live price.
- Fix: `useLatestTicks` now indexes every tick by bare symbol + trading symbol
  + instrument token (`MAX_TRACKED` 500 → 1500 for the 3 keys); positions page
  looks up all identifiers the position carries.

## 2. Redesign (live cards)

Summary is now exactly 6 cards, open leg tick-driven every second:

- **Total Positions** (count open + closed today)
- **Open Positions** (count L/S + live unreal sub)
- **Closed Positions** (count + realized sub)
- **Charges** (own card: total, sub open vs closed; expense tone)
- **Total P&L** (gross = live open gross + closed realized, live-tagged sub)
- **Net P&L** (gross − charges, sub shows both legs)

Day badge from 030 unchanged ("Today · date IST · resets 08:50").

## 3. Live verification (paper round-trip, dummy terminal)

- BUY 1 RELIANCE MIS @ snapshot 1208.3 → COMPLETE; open row stamped
  `tradingDate 2026-10-07`; pre-existing user position MONEYVIEW x60 untouched.
- MONEYVIEW snapshot: `hasData true`, LTP 57.25, tickAge 0.5 s — live feed
  confirmed for non-universe stocks too.
- Squared off test RELIANCE → open 0 (mine), closed `EXECUTED` under today's
  date. Left state: user's MONEYVIEW open as found + one test closed entry in
  today's history (disclosed).

## 4. Checks

- `tsc` clean; `eslint` 0 errors (3 pre-existing warnings); `next build`
  compiled; frontend 400/400; backend dummy/demo/positions/ticks 133 passed.
