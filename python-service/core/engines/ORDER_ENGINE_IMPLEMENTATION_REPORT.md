# Order Engine — Implementation Report

**Engine ID:** `order_engine` (OrderFacade — registered engine facade)
**Date:** 2026-09-20
**Status:** Backend verified, Service Phase Overview + Orders + History + Basket pages live.

---

## 1. Implementation overview

Order Engine is the single authoritative trading-order orchestration engine.
Every order (manual / AI / single / basket) passes through one controlled path:
validation → Risk Engine integration → broker submission → execution/status
response → audit. Basket Engine is NOT separate — basket functionality is part
of Order Engine (`basket_engine.py` → `order_engine.place()`; CRUD in
`api/baskets.py`).

The backend surface is the Kotak SDK cache (`api/trading.py`), the basket
router (`api/baskets.py`: GET/POST "" , PUT/DELETE `/{id}`,
POST `/{basket_id}/push`), and the OrderFacade control-plane entry in the
engine registry.

---

## 2. Backend surface

| Endpoint | Source | Status |
|---|---|---|
| `GET /api/services/engines/order_engine` | OrderFacade registry | LIVE |
| `GET /api/trading/orders` | broker order book (cache) | LIVE |
| `GET /api/trading/order/history` | broker order history | LIVE |
| `GET /api/trading/trades` | SDK trade_report (executed trades) | LIVE |
| `POST /api/trading/order/{place,modify,cancel}` | order actions | LIVE |
| `GET /api/baskets` | stored baskets | LIVE |
| `POST /api/baskets/{id}/push` | sequential OCO execution | LIVE |
| `GET /api/trading/dashboard` | normalized orders + funds | LIVE |

---

## 3. Frontend

- `app/_pages/order-engine/page.tsx` — Overview: engine snapshot + real order
  book aggregates (open/filled/rejected buckets computed from live rows) +
  basket count + account daily orders/charges.
- `app/_pages/order-engine/orders.tsx` — Orders: full broker order book
  (canonical columns).
- `app/_pages/order-engine/history.tsx` — History: real order-history rows.
- `app/_pages/order-engine/basket.tsx` — Basket: stored baskets CRUD (delete)
  + push-to-engine action (real `POST /api/baskets/{id}/push`), expandable legs.
- `app/(services)/services/order-engine/{,orders,history,basket}/page.tsx` —
  wrappers.
- `components/layout/nav.ts` — `order-engine` nav item with Overview / Orders /
  History / Basket children.

---

## 4. Data integrity verdict

All rows are broker-cached reality. Honest empty states ("No orders (honest
zero)", "Not logged in to the active terminal."). Push/delete fire real backend
requests and report the real outcome/error.

---

## 5. Known limitations

- Order rows normalize broker-native field names; any broker shape changes flow
  through the same canonical extraction the dashboard uses.
- Basket creation (POST "") is exercised elsewhere (Orders UI); this page
  manages the stored basket library and push execution.