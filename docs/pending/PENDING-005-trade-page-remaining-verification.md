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

## Final status of the parent task

`VERIFIED_WITH_LIMITATIONS` until items 1 and 3 close.