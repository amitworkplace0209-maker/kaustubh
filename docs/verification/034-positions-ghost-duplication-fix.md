# 034 — Positions ghost rows + double counting fix

Date: 2026-10-07, market hours (user trading live in dummy)

## 1. Symptom (proved live)

`/api/dummy/state` positions held **2 rows** while `/api/dummy/positions` open
held 1: a fully squared-off RELIANCE (net 0) ghost sat in state → the page's
OPEN section showed a closed position, AND the closed trail showed it too. One
order in two places, totals/P&L polluted.

## 2. Root cause

`api/demo.py::_apply_fill` removes the row on full close via list **rebinding**
(`positions = [...]`), but every caller saves **its own** list object afterwards
— the removal never reached storage. Ghost zero-net rows accumulated forever.

## 3. Fix

- `_apply_fill`: in-place removal (`positions[:] = ...`) — the single real fix.
- `get_dummy_positions`: lazy purge of any stored net-0 rows (bug-era cleanup).
- `dummy_state` positions: strictly net≠0 (matches `/positions` open).
- Frontend open section: strictly net≠0 filter (belt and braces).
- Regression tests added (`test_demo_positions_rollover.py::NoGhostRowsTest`):
  full BUY→SELL leaves storage empty; ghost purge on read. 8/8 pass.

## 4. Live data repair (disclosed)

My earlier paper-test trade exposed the bug in the user's live book: its ghost
buy leg (1 @1209.51) merged into the user's next RELIANCE buy, and its -1.21
realized rode the open row while also sitting in the closed trail + account.
Repaired from blotter truth (all MANUAL today: my BUY 1209.51 + SELL 1208.3;
user BUY 1208.71 + BUY 1208.81): open row → buy=2, avg=1208.76, charges minus
my buy charge (2.38 → 1.85), realizedPnl → 0.0. Verified post-repair: 4 clean
open rows (all net≠0, no symbol duplicated across open/closed except today's
disclosed test entry), live MTM ticking (MONEYVIEW unreal +25.2).

## 5. Checks

- Backend rollover/ghost suites 8/8; `tsc` clean; `eslint` 0 errors; `next
  build` compiled; frontend 400/400. Backend restarted for the fix; `/health`
  200 afterwards.
