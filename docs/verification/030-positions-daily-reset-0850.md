# 030 — Positions page daily reset at 08:50 IST

Date: 2026-10-07
Ask: `/trading/positions` must refresh every day — clean at 08:50, one day's
data must never appear on the next day.

## 1. Root cause

- Demo/paper mode: open positions persist dateless in
  `app_settings[demo_positions]`; closed trail `list_closed_positions(limit=200)`
  returned **all dates**. Yesterday's opens AND settlements stayed on the page.
- Standard/API mode: broker book is intraday by nature, but charges were priced
  from **all-days** order history and the page had no date badge or day-flip
  refetch, so stale values survived overnight.

## 2. Built

Backend (day partition = IST with the codebase's 08:30 cutoff, so the page is
clean well before the 08:50 sweep):

- `api/demo.py`: `rollover_demo_positions()` — prior-date open MIS/CO/BO settle
  into the closed trail at last LTP (avg-price fallback) with reason
  `AUTO_DAY_ROLLOVER`, backdated to their own date (today's closed list and Day
  P&L stay clean). CNC/CASH/NRML delivery-carry legs untouched. Legacy
  dateless positions are stamped today (kept, never nuked). Idempotent per date.
- `api/demo.py::get_dummy_positions()`: lazy rollover on every read — every
  consumer (state, fills, LTP funnel, square-off) only ever sees the current date.
- `services/dummy_extras.py::list_closed_positions(limit, date="")`: optional
  one-date scope; empty keeps the full trail for history callers.
- `api/dummy.py::GET /positions`: `?date=` (default today) + `tradingDate` in
  the response; closed scoped to that date.
- `scheduler/__init__.py`: `_ensure_positions_day_rollover` — deterministic
  08:50+ IST sweep once per trading date (rollover + `broker_cache.invalidate(
  "positions")` so the API-mode page re-reads live).

Frontend:

- `components/dummy/pages/positions.tsx`: "Today · {date} IST · resets 08:50"
  badge; IST day-flip in the clock tick drops rows and refetches immediately.
- `app/_pages/positions/page.tsx`: same date badge; 5 s poll detects day flip
  (clears rows/charges/ticks, refetches); charge breakdowns now use **today's**
  executions only (`kotakRowToTrade(...).ts` IST-filtered).
- `lib/dummy.ts`: `BracketedPositions.tradingDate`.

## 3. Verification

- New `tests/test_demo_positions_rollover.py` (fake Mongo, no live DB): 6 passed —
  stale MIS rolled to its own date with correct realized P&L, today/delivery kept,
  legacy stamped, lazy-on-read, idempotent, closed date-scope.
- Backend touched-area suites: **621 passed** (dummy/demo/scheduler/positions/
  trading/market_watch). `tsc` clean, `eslint` clean (only pre-existing warnings),
  `next build` compiled, frontend tests 400/400.
- Live (fresh backend): `GET /api/dummy/positions` → 200 with
  `tradingDate: 2026-10-07`, open 0, closed 0, zero cross-date rows;
  `/api/demo/positions`, `/api/trading/positions`, `/api/dummy/state` all 200.
