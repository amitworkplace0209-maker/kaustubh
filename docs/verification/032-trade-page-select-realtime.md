# 032 — Trade page stock-select + realtime fix

Date: 2026-10-07, market hours
Route: `/trading/trade` (`TradePage`, dummy + kotak-neo; shoonya separate)

## 1. Diagnosis (all links probed live)

- `GET /api/search?q=RELIANCE` (backend): 200, 6 results, real LTP — engine fine.
- `GET :3000/api/search` (Next proxy): 200, same rows — browser path fine.
- `GET /api/market-watch/tick-snapshot?tokens=2885`: 200 — fallback price fine.
- `GET /api/realtime/token` without app session: **401** — the WS#3 realtime
  socket (live ticks, order/position frames) only exists for a logged-in app
  session. Without it the page sat on seed + one-shot snapshot: selection
  painted once, LTP never went LIVE, MKT orders had no moving price.

## 2. Built (`components/orders/trade/trade-page.tsx` only)

- **Tap-to-trade quick picks**: "Tap to trade — live now" strip under search,
  fed by `GET /api/market-watch/sections` top gainers/losers (currently ticking
  tokens with board LTP). Tap enriches via Search Engine (company, lot, margin)
  and selects exactly like a typed row; search failure falls back to the minimal
  board row (snapshot-by-token still prices it).
- **15 s snapshot polling fallback**: the tick snapshot re-pulls while no live
  tick owns the quote (was one-shot on selection). Failures keep the last good
  snapshot; live stream still wins the moment it arrives. Chain unchanged:
  stream → WS view → snapshot → seed, null when nothing exists.
- **Honest offline banner** in the order section when the socket is down:
  snapshot-every-15s notice + `/login` link for live ticks (was silent WAITING).

## 3. Verification

- `npx tsc --noEmit` clean; `eslint` 0 errors (1 pre-existing warning);
  `npm run build` compiled; `npm test` 400/400 (quote-fallback test extended to
  pin the 15 s poll, same count).
- Live via Next proxy: `/api/market-watch/sections` → 3 gainers + 12 losers
  with token/LTP (quick-pick data confirmed end to end).
