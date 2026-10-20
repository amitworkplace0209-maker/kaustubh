# 035 — Duplicate closed entries + race hardening (one order, one place)

Date: 2026-10-07 (user trading live in dummy all day)

## 1. Symptom (proved live)

Closed trail held MONEYVIEW x3, TCS x2, CUPID x2 — byte-identical groups
seconds apart (single corresponding order each). Account realizedPnl 144.32 vs
true 145.50: exactly one extra TCS -1.18 absorbed. Same "one order in two
places / miscalculation" complaint as 034, one layer deeper.

## 2. Root causes

- Fill path had no serialization: concurrent order requests / overlapping LTP
  funnels interleaved loads and saves (lost-update overwrites, double fills).
- Trail write not idempotent: every close-branch execution appended unconditionally.
- Double square-off could open a reverse leg on a stale read instead of an
  honest 404.

## 3. Fix (`api/demo.py`, `services/dummy_extras.py` only)

- `_FILL_LOCK` + reentrant `_with_fill_lock` (contextvar mark — the LTP funnel
  holds it while target square-offs re-enter on the same task; asyncio locks
  are not reentrant, the mark makes nesting safe).
- `_execute_order`, `_refill_resting_orders`, `apply_demo_ltp` all serialized.
- `squareoff_dummy_position` resolves its target INSIDE the lock; net-0 → 404
  (never a reverse leg off a stale/ghost read).
- `record_closed_position(..., order_id)`: skip when that order id already has
  an entry. `_apply_fill` builds the order BEFORE the close-record so the id
  exists (pure dict build, moved earlier, no behavior change).

## 4. Live cleanup (disclosed)

- Collapsed today's dup groups keeping earliest (MONEYVIEW x3→1, TCS x2→1) plus
  yesterday's CUPID x2→1: 16 → 12 entries.
- Account repair by the proven delta only: realizedPnl 144.32 → 145.50
  (+1.18 TCS over-credit; MONEYVIEW dupes provably never reached the account).
- Post-repair proof: today's 6 closed sum to exactly 145.50 == account 145.50;
  open empty (user squared all); zero ghosts; zero dup groups.

## 5. Checks

- New tests: concurrent double square-off (1 fill + 404, one trail entry),
  trail idempotency per order id. Suites: 50 passed (rollover + dummy +
  session). `tsc` clean, `eslint` 0 errors, build compiled, frontend 400/400.
  Backend restarted; `/health` 200.
