# PENDING-005-trade-page-remaining-verification.md

## Task ID

PENDING-005

## Date Created

2026-10-14

## Priority

**P2 — MEDIUM** (does not block the implemented UI; blocks a `COMPLETE` verdict)

## Title

Close the remaining verification gaps on the rebuilt `/trading/trade` PWA/web UI

## Status

`PENDING`

## Source

- Implementation: `docs/implementation/030-trade-page-pwa-web-ui-rebuild.md`
- Verification: `docs/verification/038-trade-page-pwa-web-ui-rebuild.md`
- Frontend audit: `docs/audits/frontend/TRADE_PAGE_UI_AUDIT.md`

## Context

The trade page UI rebuild is `IMPLEMENTED`, typechecked, linted and runtime-verified in a
real headless Chrome on both breakpoints, including the real touch gesture and the terminal
routing. Three things could **not** be proven in that environment and are recorded honestly
rather than claimed.

## Open items

### 1. Physical-device swipe feel — NOT_VERIFIED

**What is unproven:** the damping, velocity curve and commit haptic of
`components/orders/trade/slide-to-order.tsx` were tuned by reasoning and exercised only
through CDP `Input.dispatchTouchEvent` in headless Chrome.

**How to close it:**

1. Open `/trading/trade` on a real handset (installed PWA).
2. Terminal = Dummy. Search and select a liquid instrument.
3. Confirm the confirm setting is ON (`Settings → confirm buy/sell`).
4. Drag the knob slowly across the whole track. Expected: it follows the finger 1:1, springs
   back if released below the commit line, and fires only past ~82 %.
5. Drag past the commit line and release quickly. Expected: it commits and the order reaches
   the dummy engine.
6. Press `Escape` mid-drag, and rotate the device mid-drag. Expected: the knob snaps back and
   never ends up off-track.

**Tune if needed:** `COMMIT_RATIO` and the snap-back duration (`160 ms` / `130 ms` / `420 ms`)
in `slide-to-order.tsx`.

### 2. Production build — NOT_VERIFIED (delegated)

**What is unproven:** `npm run build` was not run during the UI task because the operator's
`next dev` is live and shares the same `.next` directory.

**How to close it:** stop the dev server, run `npm run build`, confirm `/trading/trade` is
emitted with no route collision, then restart dev.

**Delegated to:** `PENDING-002-build-and-test-verification.md`. Do not duplicate the record
here — close that file and cross-reference back.

### 3. Accepted Kotak order end to end — NOT_VERIFIED

**What is proven:** in Kotak Neo mode a swipe fires
`POST /api/terminal/order` (the Kotak engine). Routing is proven.

**What is not:** this environment has **no Kotak broker session**, so the Risk Engine returns
`EMERGENCY_BLOCK` (`RISK LOCKED`) and rejects the order server-side. Acceptance by a live
broker is unproven.

**How to close it:** with a real Kotak Neo session connected, place one MIS market order and
one resting limit order from the slide gesture; record the broker order id and the resulting
status in a new verification record.

### 4. Stale pre-existing test — NOT_OWNED_HERE

`tests/trade-quote-fallback.test.ts` has **3 pre-existing failures** that assert against an
older revision of the quote memo in `trade-page.tsx`. Baseline
`426 tests / 423 pass / 3 fail` is recorded in
`docs/verification/037-topbar-manual-login-backend-terminal-resolution.md` and is unchanged by
the UI work.

**How to close it:** either update the three assertions to the current memo variable names, or
restore the memo to the shape the guard describes. Not started — unrelated to the UI task and
deliberately left untouched rather than silently rewritten.

## Explicitly NOT pending (verified)

- Slide gesture renders on touch, does not render on desktop — **PASS**
- Dummy order reaches the dummy engine — **PASS** (request intercepted, never sent)
- Kotak order reaches the Kotak engine — **PASS** (request intercepted, never sent)
- Desktop confirm dialog still gates the order — **PASS**
- Order bar sits flush above the app bottom nav — **PASS** (780 vs 779)
- Order flow fits one 390×844 screen — **PASS**
- No console errors, no exceptions, no type/lint/test regression — **PASS**

---

## Update 2026-10-21 — the page was deleted and rebuilt

The page was rebuilt from zero (`docs/implementation/033-trade-page-full-rebuild.md`,
verified in `docs/verification/041-trade-page-full-rebuild.md`). The two backend defects
that made the page unable to place an order were fixed in the same task:

- `python-service/api/demo.py` — the missing `_to_engine_order_intent()` (every paper order
  answered HTTP 500).
- `python-service/core/engines/risk_engine.py` — the risk **preview** no longer records an
  order intent, so the page's own pre-check can no longer make the following real order be
  rejected as a duplicate.

What this changes for the items above:

| Item | New state |
|---|---|
| 1. Physical-device swipe feel | still **NOT_VERIFIED** — unchanged; headless touch emulation only. The rebuilt control is a fresh implementation (`components/trading/order-actions.tsx`), so the tuning note must be applied to IT, not to the deleted `slide-to-order.tsx`. |
| 2. Production build | unchanged — delegated to `PENDING-002-build-and-test-verification.md`. |
| 3. Accepted Kotak order end to end | still **NOT_VERIFIED** — the routing and the payload are proven (the request is intercepted and aborted; the captured body is the real broker body), but no order was ever sent to the live broker. |
| 4. `tests/trade-quote-fallback.test.ts` | **CLOSED** — the guard was rewritten against the new quote chain and passes (12 assertions). |

Newly verified in the rebuilt page (2026-10-21):

- A **paper order placed from the page FILLED** — `Filled · FILLED, Qty 1, id DEMO1792576469294469`
  (`--allow-order` run against the Dummy terminal).
- The risk verdict is the server's verdict (`PASS — Order passes the active risk policy`).
- The price is served by the shared SSE tick channel and labelled `LIVE TICK STREAM`.
- The capabilities (order types, products, currency) come from the BACKEND registry.
- The risk pre-check fires ONCE per order intent (it used to fire every ~2.5 s).
- 0 uncaught exceptions, 0 console errors, 0 failed responses.

## Runbook for the items that are still open

**`docs/pending/PENDING-008-trade-page-live-verification.md`** is the single executable
runbook for everything that is still unverified (items 1 and 3 above, plus the production
build, the PWA on a phone and the CASH charge check). It carries the environment
preflight, the exact commands, the expected results, the evidence to capture, the safety
rules and the restore procedure. This file (PENDING-005) keeps the item list; PENDING-008
owns the execution.

**Update 2026-10-22 — the runbook was executed** (`docs/verification/042-trade-page-live-verification.md`):

| Item | New state |
|---|---|
| 1. Physical-device swipe feel | The gesture **mechanics** are proven with real touch events (a short drag springs back and places NOTHING; a drag past the commit line sends the order with the correct payload). The **feel** on a handset is still unverified — it needs a device. |
| 2. Production build | **CLOSED** — `next build` compiled successfully (10.9 s), TypeScript clean, `/trading/trade` emitted, no route collision. Run in an isolated copy so the operator's dev server was never stopped. |
| 3. Accepted Kotak order end to end | Still **NOT_VERIFIED** — the routing and the payload are proven (the request is intercepted and aborted; the captured body is the real broker body). Sending a real order needs the operator's written authorization, and the broker account currently holds Net ₹10. |
| 4. `tests/trade-quote-fallback.test.ts` | **CLOSED** — the guard was rewritten against the new quote chain and passes (12 assertions). |
| — | The phone's network path is **proven** (the page, the APIs and the SSE tick stream all answer on the host's LAN address) — the on-screen PWA check still needs a handset. |
| — | The **CASH charge** check is **closed**: CASH uses the delivery STT (0.1 %), MIS the intraday STT (0 % on a buy). |

## Final status of the parent task

`VERIFIED_WITH_LIMITATIONS` until items 1 and 3 close.
