# 033 — Trade Page Full Rebuild (delete → rebuild → new UI) + the two backend defects that made it dead

- **Date:** 2026-10-21
- **Agent:** OpenCode
- **Route:** `http://localhost:3000/trading/trade`
- **Status:** see [§15 Final Status](#15-final-status)

---

## 1. Task

Requested in chat (verbatim):

> "http://localhost:3000/trading/trade page kam nhi kar kitne bar upadte kru sdk sacn kro use hisab se bnao
> page full delete kro or 0 se fir se bnao or ui chnege kro full"

Decomposed:

| # | Requirement | Decision |
|---|---|---|
| R1 | The page does not work — find out why | Diagnose against the live stack, fix the root causes (not the symptoms) |
| R2 | "How many times have I updated it?" | Answer with the real history (§4) and stop the duplication loop |
| R3 | Scan the SDK and build the page from it | The page's capabilities must come from the BACKEND capability registry (`GET /api/terminal/list`), not from a hand-written table |
| R4 | Delete the page fully and rebuild from zero | One implementation, deleted and rewritten (§7) |
| R5 | Change the UI fully | New layout, new type scale, new components (§8) |

---

## 2. Objective

Make `/trading/trade` actually place orders again, and replace the accumulated UI with ONE
implementation that is driven by the real broker SDK capability registry instead of a
hand-maintained copy of it.

---

## 3. Scope

**In scope**

- The `/trading/trade` route and every component it renders.
- The two backend defects that made the page unable to place an order
  (`_to_engine_order_intent` missing; the Risk Engine preview poisoning the execution path).
- The browser realtime source of the trade page (the WebSocket the page pointed at cannot
  upgrade behind the Next.js dev server).
- The trade page's request cadence (it was firing a risk pre-check every ~2.5 s).
- One operational defect found while verifying: the backend watchdog killed the backend
  during its own cold start (45 s grace vs a ~100-140 s boot).

**Out of scope (deliberately untouched)**

- Broker SDKs, adapters, the Order Engine's placement pipeline, the Risk Engine's policy.
- Every other route, component and engine.
- The Market Watch / AI work that was already in the working tree (unrelated, uncommitted).

---

## 4. Existing state — how many times this page had been rebuilt

The chat question "kitne bar update kru" is answered by the repository itself. The trade
page had been **rewritten four times**, and the rewrite loop had produced **three parallel
implementations** of the same screen:

| # | Implementation | Size | State before this task |
|---|---|---|---|
| 1 | `components/orders/trade/trade-page.tsx` | 1168 lines | Documented in `docs/audits/frontend/TRADE_PAGE_UI_AUDIT.md`, but **unreachable**: its only importer was `app/_pages/orders/page.tsx`, and `_pages` is a private (non-routed) folder in the App Router |
| 2 | `components/orders/trade/*` (13 child components) | — | A near-duplicate of #3's children; `charges-panel` used a backend route that does not exist, `target-panel` was localStorage-backed while the other copy was engine-backed |
| 3 | `components/trading/*` (16 files, `trade-page-client.tsx`) | 739 lines | **The one actually mounted** — but undocumented in the audit (the audit still describes #1) |

Documented history: `docs/implementation/019-trade-page-unblocked.md` →
`021-trade-page-realtime-performance.md` → `030-trade-page-pwa-web-ui-rebuild.md`
(+ verifications 019/024/032/038 and the PWA plan `docs/opencode/006-…`).

The fourth rewrite — the one the user asked for — is this document.

---

## 5. Source documentation read

- `PROJECT_IMPLEMENTATION_RULE.md` (full) — mandatory first action.
- `docs/pending/PENDING-005-trade-page-remaining-verification.md` (the open pending work for
  this page).
- `docs/architecture/SDK_CATALOG.md` — the SDK inventory (kotakneoapi 3.0.7,
  NorenRestApiOAuth 0.0.41, and the hard dependency chains).
- `docs/broker/BROKER_INTEGRATION_MAP.md` — the broker capability matrix + the terminal
  router surface.
- `docs/frontend/FRONTEND_CONTRACT.md` — the two HTTP paths (Next proxy vs direct WebSocket).
- `docs/engines/RISK_ENGINE.md`, `docs/architecture/12_ORDER_LIFECYCLE.md`,
  `docs/architecture/13_RISK_MARGIN_ARCHITECTURE.md`.
- `docs/audits/frontend/TRADE_PAGE_UI_AUDIT.md` (the previous audit of this page).
- `docs/implementation/030-trade-page-pwa-web-ui-rebuild.md`,
  `docs/verification/038-trade-page-pwa-web-ui-rebuild.md`.

---

## 6. Problems found (all reproduced against the running stack)

### P1 — Every paper order died with HTTP 500 (CRITICAL)

`POST /api/demo/order/place` → `POST /api/trade/demo/order` called a function that did not
exist:

```
python-service/api/demo.py:2060
    result = await order_engine.place("dummy", _to_engine_order_intent(req))
NameError: name '_to_engine_order_intent' is not defined
INFO: 127.0.0.1 - "POST /api/demo/order/place HTTP/1.1" 500 Internal Server Error
```

`_to_engine_order_intent` was called but never defined or imported anywhere in the
repository — in the released v1.0.0 commit as well. **No Dummy order could ever be placed
from the trade page.** The operator's own attempts were in the backend log four times
before the first successful placement.

### P2 — The UI's own risk pre-check made the order impossible (CRITICAL)

`risk_engine.validate_order()` applied the duplicate-order suppression window to EVERY
call, including the read-only preview the page fires while the ticket is being edited:

```
POST /api/services/risk/validate  ->  {"accepted": false,
    "reasons": ["duplicate order (same intent within suppression window)"]}
```

The Order Engine calls the same function on placement (`core/engines/order_engine.py:219`),
so the preview recorded the intent and the real order a moment later was rejected as a
duplicate. The page could never place an order: its own safety check poisoned the
execution path. The duplicate key also ignored `trigger_price`, so two stop orders with
different triggers collided.

### P3 — The browser's realtime socket could never connect (HIGH)

`lib/realtime-ws.ts` opens the socket at the PAGE origin
(`ws://127.0.0.1:3000/ws/realtime`). Next.js does not proxy WebSocket upgrades, so the
handshake failed:

```
ERROR (handshake failed)  <-  ws://127.0.0.1:3000/ws/realtime?token=…
OPEN (101 upgrade OK)     <-  ws://127.0.0.1:8000/ws/realtime?token=…
```

The page therefore showed "Realtime offline" permanently and fell back to a 15 s REST
snapshot. The same-origin requirement (a phone must not resolve 127.0.0.1 to itself) is
still honoured — the page now uses the **shared SSE tick channel**
(`/api/ticks/stream`, same-origin, already used by every other live surface) as its live
price source.

### P4 — A request storm against the Risk Engine (MEDIUM)

The risk pre-check effect depended on the raw LTP, so it re-fired on every tick: the
backend log shows `POST /api/services/risk/validate` every ~2.5 s while the page was open.
The page now re-checks only when the ORDER INTENT changes (plus a 1 % price bucket).

### P5 — The charges panel had no working data source (MEDIUM)

`components/orders/trade/charges-panel.tsx` called `POST /api/dummy/preview`, which does
not exist in the backend (`500`). The page now uses the app's own canonical charge engine
(`lib/charge-engine.ts`, statutory rates in `config/`), the same module the dashboard,
positions, history and calculator use.

### P6 — The capabilities were a hand-written copy of the SDK registry (MEDIUM)

`components/orders/trade/capabilities.ts` mirrored `python-service/brokers/capabilities.py`
by hand. The page now reads the LIVE registry (`GET /api/terminal/list` → `capabilities`)
and falls back to the static mirror only until the first answer arrives.

### P7 — The watchdog killed the backend during its own cold start (HIGH, environment)

`python-service/watchdog_backend.py` had `GRACE_AFTER_START = 45`, but a cold start on
this machine takes ~100-140 s (MongoDB → 2 685-instrument master → session manager → tick
buffer → every engine). The watchdog therefore killed a backend that was still booting and
the operator was left with a permanently dead backend (every page answered "Internal
Server Error"). The grace is now 240 s.

### P8 — Documentation drift (MEDIUM)

`docs/audits/frontend/TRADE_PAGE_UI_AUDIT.md` described implementation #1 while the live
page was implementation #3. The audit is now rewritten against reality (§12).

---

## 7. Design decision

**One implementation, in one place, driven by the backend registry.**

```
app/(trading)/trading/trade/page.tsx
  └─ components/trading/trade-page.tsx          ← the single truth boundary (NEW)
       ├─ terminal-rail.tsx        status rail (session / market / feed / engines)
       ├─ instrument-search.tsx    combobox over the Search Engine
       ├─ quote-header.tsx         LTP hero + day range + circuits
       ├─ order-ticket.tsx         side / type / product / validity / qty / prices
       ├─ margin-strip.tsx         margin · available · after · value
       ├─ trade-inspector.tsx      Risk | Charges | Targets | Basket | Position
       │    ├─ risk-panel.tsx · charges-panel.tsx · targets-panel.tsx
       │    ├─ basket-panel.tsx · position-panel.tsx
       ├─ execution-panel.tsx      the broker's own order result
       ├─ order-actions.tsx        slide-to-confirm (touch) / tap (mouse) + summary
       └─ confirm-order-dialog.tsx the review step
```

The shared CONTRACTS stay where the other order surfaces already import them
(`components/orders/trade/types.ts`, `capabilities.ts`, `lifecycle.ts` — used by the
basket, history and suggestion pages). Everything that was a duplicate UI was deleted
(§9).

**Where the numbers come from (nothing is invented):**

| Value | Source |
|---|---|
| LTP / OHLC / circuits / volume | shared SSE tick stream → central tick-store snapshot → on-demand broker quote → search seed (four-level chain, each level labelled honestly) |
| Order types, products, margin API, charge model, currency | the BACKEND capability registry (`GET /api/terminal/list`) |
| Risk verdict | `POST /api/services/risk/validate` (preview phase) |
| Margin | the broker margin API when the terminal supports it, otherwise a labelled estimate |
| Charges | the app's canonical charge engine (`lib/charge-engine.ts`) |
| Position / funds | the terminal's own position + funds reads, polled every 8 s |

**Risk authority is unchanged.** The page renders the server's verdict; it never decides
whether an order may pass, and it never disables the button because of the verdict. The
backend still decides.

---

## 8. UI changes (R5 — full change)

| Region | Before | After |
|---|---|---|
| Layout | one narrow column, `max-w-5xl`, everything stacked | two columns on desktop (ticket + inspector), one column on mobile; `max-w-[1400px]` |
| Type scale | `text-[8px]` … `text-[10px]` labels | 11 px floor, 12-14 px body, 18 px symbol, 28 px LTP, all prices `tabular-nums` mono |
| Status | 3 small badges in a scroll strip | a status rail: terminal + mode chip, session, market, feed, engine health, and a `caps mirror` chip when the live registry has not answered |
| Instrument | a compact card | a price header: symbol, exchange, live/snapshot badge, LTP hero, change, open/high/low/prev-close/volume/circuits, and a day-range bar with the live marker |
| Ticket | segmented controls + a squeezed amount field | side / type / product / validity segments, a lot-aware quantity stepper, a margin-amount field that sizes the quantity, limit/trigger fields only when the type needs them, and a live marketability line |
| Money | one thin strip of `text-[10px]` | four tiles (margin · available · after · value) with an `est` marker on a locally derived margin and `—` for unknown values |
| Secondary panels | an accordion behind an "Insights" toggle, then a sheet | a five-tab INSPECTOR that is always visible (Risk / Charges / Targets / Basket / Position) |
| Order bar | a fixed bar + a side-flip button | the same geometry, but the summary line is richer and the side flip is a labelled control |
| Result | a banner | an execution panel that reports the broker's own status (`Filled` / `Working` / `Order not placed`) with the order id, filled qty and average price |
| Errors | could blank a region | every region is still wrapped in a `SafeRegion` boundary |

---

## 9. Files changed

### Frontend — created

| File | Purpose |
|---|---|
| `components/trading/trade-page.tsx` | the single truth boundary of the page |
| `components/trading/terminal-rail.tsx` | the status rail |
| `components/trading/quote-header.tsx` | the price header |
| `components/trading/order-ticket.tsx` | the ticket (rewritten) |
| `components/trading/margin-strip.tsx` | the money strip |
| `components/trading/trade-inspector.tsx` | the tabbed inspector |
| `components/trading/risk-panel.tsx` | the risk verdict |
| `components/trading/charges-panel.tsx` | the charge estimate (canonical charge engine) |
| `components/trading/targets-panel.tsx` | engine-backed targets |
| `components/trading/basket-panel.tsx` | basket legs + handoff |
| `components/trading/position-panel.tsx` | the open position |
| `components/trading/execution-panel.tsx` | the order result |
| `components/trading/order-actions.tsx` | slide-to-confirm / tap + summary |
| `components/trading/confirm-order-dialog.tsx` | the review step |
| `components/trading/terminal-capabilities.ts` | the live capability registry hook |
| `hooks/use-market-watch-snapshot.ts` | the central tick-store snapshot (one instrument) |

### Frontend — deleted (the duplicate implementations)

`components/trading/trade-page-client.tsx`, `selected-stock-card.tsx`,
`risk-margin-panel.tsx`, `target-panel.tsx`, `execution-state.tsx`, `slide-to-order.tsx`,
`insight-sheet.tsx`,
`components/orders/trade/trade-page.tsx`, `auth-gate.tsx`, `charges-panel.tsx`,
`execution-state.tsx`, `insight-sheet.tsx`, `instrument-card.tsx`, `instrument-search.tsx`,
`order-preview.tsx`, `order-ticket.tsx`, `risk-margin-panel.tsx`,
`selected-instrument-detail.tsx`, `selected-stock-card.tsx`, `slide-to-order.tsx`,
`target-panel.tsx`, `app/_pages/orders/page.tsx`.

### Frontend — modified

| File | Change |
|---|---|
| `app/(trading)/trading/trade/page.tsx` | mounts the new page |
| `components/orders/trade/capabilities.ts` | rewritten: the static mirror of the backend registry + `capsFromBackend()` |
| `components/trading/instrument-search.tsx` | rewritten (one implementation; the basket now imports this one) |
| `components/trading/trade-page-skeleton.tsx` | rewritten to the new layout |
| `components/trading/auth-gate.tsx` | unused state removed |
| `components/orders/basket/basket-page.tsx` | imports the canonical instrument search |
| `components/shoonya/pages/trade.tsx` | renders the ONE canonical page instead of the deleted legacy page |
| `hooks/use-instrument-tick.ts` | freshness is measured from the backend receive time; seconds→ms normalisation |
| `lib/realtime-ws.ts` | relative + explicit-extension import (fixes the Node test runner) |
| `tests/trade-quote-fallback.test.ts` | the quote-fallback guard now pins the NEW chain |
| `tests/trading-session-hydration.test.ts` | points at the new page |

### Backend — modified

| File | Change |
|---|---|
| `python-service/api/demo.py` | **added the missing `_to_engine_order_intent()`** (P1) |
| `python-service/core/engines/risk_engine.py` | `phase="preview" \| "execute"` on `validate_order`; the trigger price joins the duplicate key (P2) |
| `python-service/api/risk_engine.py` | `POST /api/services/risk/validate` runs as a PREVIEW (P2) |
| `python-service/watchdog_backend.py` | `GRACE_AFTER_START` 45 s → 240 s (P7) |

### Backend — tests created

`python-service/tests/test_demo_order_intent.py` (6 tests) and 4 new cases in
`python-service/tests/test_common_trading_core.py`.

---

## 10. Backend / API / database / realtime / scheduler changes

- **API**: no route added or removed. Two existing routes changed BEHAVIOUR:
  `/api/demo/order/place` no longer raises a `NameError`; `/api/services/risk/validate` no
  longer mutates the duplicate-suppression ring.
- **Database**: none.
- **Realtime**: the page's live price now comes from the shared SSE tick channel
  (`/api/ticks/stream`) instead of the unreachable page-origin WebSocket. The WebSocket
  itself is untouched.
- **Scheduler**: none.
- **Risk Engine**: the policy is unchanged — same checks, same limits, same reasons. Only
  the MUTATION boundary changed: a preview reads the duplicate ring, an execution writes
  it.

---

## 11. Tests

```
npx tsc --noEmit                                   -> exit 0, clean
npx eslint <every touched file>                    -> exit 0, 0 errors, 0 warnings
npm test                                           -> 461 tests | 461 pass | 0 fail
python -m pytest tests/test_demo_order_intent.py
        tests/test_common_trading_core.py -q        -> 57 passed
```

Baseline before this task: `446 tests | 445 pass | 1 fail` (the failing one was
`tests/realtime-client.test.ts`, whose import of `lib/realtime-ws.ts` used a path alias the
Node ESM loader cannot follow — fixed here).

---

## 12. Documentation changes

- `docs/audits/frontend/TRADE_PAGE_UI_AUDIT.md` — rewritten against the new reality.
- `docs/pending/PENDING-005-trade-page-remaining-verification.md` — updated.
- `docs/implementation/033-trade-page-full-rebuild.md` — this file.
- `docs/verification/041-trade-page-full-rebuild.md` — the evidence.
- `docs/logs/LOG-014-20261021-trade-page-full-rebuild.md` — the session log.
- `docs/opencode/008-trade-page-rebuild/` — the working files and the re-runnable probes.

---

## 13. Verification

See `docs/verification/041-trade-page-full-rebuild.md`. Headlines:

- The rebuilt page was driven in a real headless Chrome: search → select → live price →
  risk PASS → review dialog → **a paper order that FILLED** (`id DEMO1792576469294469`).
- The Kotak path was driven with every order request intercepted and aborted, so no broker
  order was ever sent; the captured payload is the real broker payload.
- The mobile (390×844) geometry was measured: the order bar sits flush above the app's
  bottom navigation (780 vs 779) and the slide-to-confirm control is present on the touch
  build.
- 0 uncaught exceptions, 0 console errors, 0 failed responses in every run.

---

## 14. Remaining issues / pending work

1. **Physical-device swipe feel** — still unproven (headless touch emulation only). Carried
   over in `PENDING-005`.
2. **An accepted Kotak order end to end** — still unproven in this environment (the broker
   session is the operator's; the probe deliberately never sends one). Carried over in
   `PENDING-005`.
3. **The backend loses its HTTP listener on Windows** — a pre-existing environment defect
   (documented in `watchdog_backend.py`). The watchdog now heals it instead of killing the
   backend during its cold start, but the root cause (a network-stack hiccup) is not in
   this task's scope. New pending item `PENDING-007`.
4. **The charge engine's product vocabulary** — `lib/charge-engine.ts` treats every product
   except CNC/CO/MARGIN as intraday equity, while this platform treats CASH as full-payment
   delivery. The trade page maps CASH onto the engine's delivery vocabulary locally; the
   shared engine was NOT changed (it drives historical charge snapshots).

---

## 15. Final Status

**VERIFIED_WITH_LIMITATIONS**

- IMPLEMENTED, TYPECHECKED, LINTED, TESTED.
- RUNTIME_VERIFIED in a real browser: the page renders, prices live, shows the server's
  risk verdict, and places a paper order that fills.
- The two backend defects that made the page dead are fixed and covered by regression
  tests.
- Limitations: physical-device swipe feel and an accepted live-broker order remain
  unproven (the environment and the operator's session, not the implementation).
