# Squareoff Engine — Implementation Report

**Engine ID:** `squareoff_engine` (registered on-demand registry engine)
**Date:** 2026-09-20
**Status:** Backend verified, Service Phase Overview page live.

---

## 1. Implementation overview

Squareoff Engine is the end-of-trading safety and position-closure engine:
freeze new activity → cancel pending orders → fetch broker-side positions →
close eligible positions with MARKET exits → verify fills → safe 15s retry →
SQUAREOFF_COMPLETE / SQUAREOFF_INCOMPLETE. Source-independent (AI + manual).

The closure path lives in `api/trading.py`
`POST /api/trading/positions/squareoff` (→ `order_engine.square_off`, real
MARKET exit through the single order choke point) and `GET /api/trading/positions`.

---

## 2. Backend surface

| Endpoint | Source | Status |
|---|---|---|
| `GET /api/services/engines/squareoff_engine` | registry on-demand engine | LIVE |
| `GET /api/trading/positions` | broker net positions | LIVE |
| `POST /api/trading/positions/squareoff` | MARKET exit per position | LIVE |
| `GET /api/trading/dashboard` | normalized positions + funds | LIVE |

---

## 3. Frontend

- `app/_pages/squareoff/page.tsx` — Overview: squareoff state machine
  (COMPLETE / IN_PROGRESS / INCOMPLETE), schedule (default 15:16 IST / freeze
  15:15 / 15s retry), real open-positions table with selectable rows, and a
  confirm-gated square-off action (`POST /api/trading/positions/squareoff`)
  that reports the real broker `stat` / remarks.
- `app/(services)/services/squareoff/page.tsx` — wrapper.
- `lib/api.ts` — `squareOffTradingPosition()`.
- `components/layout/nav.ts` — `squareoff` nav item (flat Overview).

---

## 4. Data integrity verdict

No fabricated closures. Positions are broker reality; the exit order goes
through the real order path and the page shows the real Ok/NotOk response.
Engine snapshot (state/health/retries) comes from the real engine.

---

## 5. Known limitations

- Schedule defaults (15:16 / 15:15 / 15s) come from the engine snapshot when
  populated; otherwise the documented defaults are labelled as such on the card.
- A full "squareoff all" bulk action is not exposed here — rows are exited
  individually so remains source-accurate with per-order confirmation.