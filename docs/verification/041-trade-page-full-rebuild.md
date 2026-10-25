# 041 — Trade Page Full Rebuild: Verification

- **Verification ID:** 041
- **Date:** 2026-10-21
- **Agent:** OpenCode
- **Task / Feature:** `/trading/trade` — delete → rebuild → new UI, plus the two backend
  defects that made the page unable to place an order
- **Subject:** `docs/implementation/033-trade-page-full-rebuild.md`
- **Working files:** `docs/opencode/008-trade-page-rebuild/`

---

## 1. Environment

| Item | Value |
|---|---|
| Frontend | `next dev` on `http://127.0.0.1:3000` (Next 16.3.4, React 19.2.8, Turbopack) |
| Backend | `uvicorn app:app` on `http://127.0.0.1:8000` (FastAPI 0.115.0) |
| Backend launcher | `python-service/start_backend.py` + `python-service/watchdog_backend.py` |
| Browser | Chrome 156.0.8078.48, headless (`--headless=new`), driven over CDP |
| Viewports | 1440×900 (desktop) and 390×844 (mobile emulation, touch emulation on) |
| Market | 2026-10-21, NSE, session OPEN, Kotak Neo SFeed live (broker session, MANUAL login) |
| Terminal | Dummy for the end-to-end order proof; Kotak Neo for the routing proof (intercepted) |
| Timezone | Asia/Kolkata (IST) |

---

## 2. Verification method

1. **Static** — `npx tsc --noEmit`, `npx eslint`, `npm test`, `python -m pytest`.
2. **API level** — direct HTTP calls against the running backend with the real payloads.
3. **Browser level** — headless Chrome over CDP:
   - `docs/opencode/008-trade-page-rebuild/trade-page-verify.mjs` (desktop flow),
   - `docs/opencode/008-trade-page-rebuild/trade-page-mobile.mjs` (mobile geometry).
   Both re-runnable; the desktop probe **fails every order request** by default so it can
   never reach an engine.

---

## 3. The defects, reproduced and then fixed

### 3.1 P1 — paper orders died with HTTP 500

**Before**

```
Command:
  curl -s -X POST -H "Content-Type: application/json" \
    -d '{"symbol":"RELIANCE",...}' http://127.0.0.1:3000/api/trade/demo/order
Expected: 200 with a paper order id
Actual:   500 Internal Server Error

Backend log:
  python-service/api/demo.py:2060
      result = await order_engine.place("dummy", _to_engine_order_intent(req))
  NameError: name '_to_engine_order_intent' is not defined
  INFO: 127.0.0.1 - "POST /api/demo/order/place HTTP/1.1" 500 Internal Server Error
Status:   FAIL (reproduced 5× — 4 of them from the operator's own browser)
```

**After**

```
Command: (same)
Expected: 200 with a filled paper order
Actual:   200
  {"data":{"n_ord_no":"DEMO1792572317254317","stat":"Ok"},"stat":"Ok","isDemo":true,
   "orderId":"DEMO1792572317254317","status":"COMPLETE","accepted":true,
   "demoOrder":{"status":"COMPLETE","averageTradedPrice":1204.7,"filledQuantity":1,
     "orderValue":1204.7,"charges":{"total":0.53},"ltpSource":"ws_tick",
     "fillSource":"placement"}}
Status:   PASS — the paper order was ACCEPTED and FILLED at the real live LTP (1204.7).
```

### 3.2 P2 — the risk preview poisoned the execution path

**Before**

```
Command:
  1) POST /api/services/risk/validate   {terminal:dummy, symbol:TCS, qty:2, MKT}
  2) POST /api/services/risk/validate   (the same preview again)
  3) POST /api/trade/demo/order         {symbol:TCS, qty:2, MKT}

Expected: the preview passes and the order is placed
Actual:   1) accepted:true
          2) accepted:FALSE — "duplicate order (same intent within suppression window)"
          3) ORDER_REJECTED — "duplicate order (same intent within suppression window)"
Status:   FAIL
```

**After**

```
1) accepted:true
2) accepted:true            <- a preview no longer mutates the suppression ring
3) 200 COMPLETE             <- the order that follows a preview is placed
Status:   PASS
```

**The protection itself is still intact** — two identical orders fired concurrently are
still rejected:

```
Command: two identical POST /api/trade/demo/order in parallel
Actual:  job 1 -> {"stat":"Ok","orderId":"DEMO1792572431429431"}
         job 3 -> {"stat":"NotOk","remarks":"duplicate order (same intent within
                   suppression window)","error":{"code":"ORDER_REJECTED"}}
Status:  PASS — the suppression window still blocks a genuine double submit
```

### 3.3 P3 — the browser socket could not upgrade

```
Command: node docs/opencode/008-trade-page-rebuild/ws-handshake-probe.mjs <token>
Expected: the socket the page opens must upgrade
Actual:  ERROR (handshake failed)  <- ws://127.0.0.1:3000/ws/realtime?token=…
          OPEN  (101 upgrade OK)   <- ws://127.0.0.1:8000/ws/realtime?token=…
Status:  FAIL (the page pointed at the Next.js dev server, which cannot proxy upgrades)
```

**After** — the page's live price comes from the shared SSE tick channel (same-origin, and
the channel every other live surface already uses). The probe confirms the stream is
served:

```
Command: curl -s --max-time 8 -N http://127.0.0.1:8000/api/ticks/stream
Actual:  data: {"symbol":"TATASTEEL",...,"ltp":173.84,...,"receivedAt":"2026-10-21T15:25:05.298000+05:30",...}
Status:  PASS
```

### 3.4 P7 — the watchdog killed the backend during its cold start

```
Before: GRACE_AFTER_START = 45 s   vs a measured cold start of ~100-140 s
Actual: [watchdog] health probe failed #1 … #7 → LISTENER DEAD → killing → relaunch →
        the same again. The backend was permanently down and every page answered 500.
After:  GRACE_AFTER_START = 240 s
        [watchdog] launching backend … → health 200, backend serving, no kill cycle
Status:  PASS
```

---

## 4. The rebuilt page — browser evidence

### 4.1 Desktop flow (Kotak Neo terminal, every order request INTERCEPTED and aborted)

```
Command: node docs/opencode/008-trade-page-rebuild/trade-page-verify.mjs 9333 <cookie> \
           http://127.0.0.1:3000/trading/trade
```

| Check | Expected | Actual | Result |
|---|---|---|---|
| Search | real Search Engine results | `RELIANCE NSE CM LIVE 1 RELIANCE INDUSTRIES LTD ₹1,204.60 +0.22%` | PASS |
| Price source | a real feed, labelled | header shows `LIVE TICK STREAM`, LTP ₹1,204.80, +2.80 (+0.23%) | PASS |
| Day context | open/high/low/prev close/volume/circuits | `₹1,212.00 / ₹1,234.30 / ₹1,199.30 / ₹1,202.00 / 1.67Cr / ₹1,081.8 – ₹1,322.2` | PASS |
| Capabilities | from the backend registry | `ORDER TYPE MKT L SL SL-M`, `PRODUCT MIS CNC NRML CASH` | PASS |
| Money strip | margin / available / after / value | `₹241 ESTIMATE`, `₹90,661`, `₹90,420`, `₹1,204.80` | PASS |
| Risk verdict | the server's verdict | `PASS — Order passes the active risk policy. Margin pass` | PASS |
| Risk request rate | one per intent, not per tick | `riskCalls: 1`, `marginCalls: 1` (before: a validate every ~2.5 s) | PASS |
| Review dialog | the exact order | `BUY RELIANCE-EQ nse_cm · MIS · MKT · DAY / QUANTITY 1 / EXECUTION Market / ORDER VALUE ₹1,204.80 / MARGIN ₹240.96` | PASS |
| Order payload | the broker contract | `POST /api/terminal/order {"terminal":"kotak","order":{"exchange":"NSE","token":"2885","symbol":"RELIANCE","transaction_type":"BUY","product":"MIS","order_type":"MKT","quantity":"1","price":"0","trigger_price":"0","validity":"DAY","disclosed_quantity":"0","expected_ltp":1204.8}}` | PASS |
| Nothing reached the broker | the request is aborted | the page shows `Order not placed — Failed to fetch`; `orderRequests` shows the payload but the request never left | PASS |
| Console health | clean | `exceptions: []`, `consoleErrs: []`, `badResponses: []` | PASS |

### 4.2 End-to-end paper order (Dummy terminal, the request ALLOWED)

```
Command: node docs/opencode/008-trade-page-rebuild/trade-page-verify.mjs 9333 <cookie> \
           http://127.0.0.1:3000/trading/trade --allow-order
```

| Check | Expected | Actual | Result |
|---|---|---|---|
| Terminal rendering | the registry's currency + products | `Dummy Mode DUMMY … C1,222.00 … PRODUCT MIS CASH` (Coin, not ₹) | PASS |
| Live price | streaming | `LIVE TICK STREAM`, `C1,222.00 +20.00 (+1.66%)`, circuits `C1,168.1 – C1,240.3` | PASS |
| Feed badge | honest | `LIVE` (after the fix: the freshness clock is the backend receive time) | PASS |
| Order routing | the Dummy engine | `POST /api/trade/demo/order {"symbol":"RELIANCE","tradingSymbol":"RELIANCE-EQ","exchange":"NSE","exchangeSegment":"nse_cm","token":"2885","transactionType":"BUY","product":"MIS","orderType":"MKT","quantity":1,"price":0,"triggerPrice":0,"validity":"DAY","ltp":1222,"amount":0,"lotSize":1,"marginPerShare":244.4}` | PASS |
| Order result | the engine's own status | `Filled · FILLED — Qty 1 · id DEMO1792576469294469` | PASS |
| Console health | clean | `exceptions: []`, `consoleErrs: []`, `badResponses: []` | PASS |

### 4.3 Mobile / PWA geometry (390×844, touch emulation)

```
Command: node docs/opencode/008-trade-page-rebuild/trade-page-mobile.mjs 9333 <cookie>
```

| Measurement | Expected | Actual | Result |
|---|---|---|---|
| Order bar | flush above the bottom navigation | bar `top 655 · bottom 780`, bottom nav `top 779 · bottom 844` | PASS |
| Commit gesture | a slide on a touch build | `role="slider"` present, 48 px knob at `left 17` | PASS |
| Horizontal overflow | none | `horizontalOverflowPx: 0` | PASS |
| Exceptions | none | `exceptions: []` | PASS |

Screenshots: `docs/opencode/008-trade-page-rebuild/evidence/trade-page-desktop.png`,
`…/trade-page-mobile.png`, `…/trade-page-dummy-filled.png`.

---

## 5. Static and test results

```
Command: npx tsc --noEmit
Expected: exit 0
Actual:   exit 0, no output
Status:   PASS

Command: npx eslint components/trading components/orders/trade hooks/use-market-watch-snapshot.ts \
           hooks/use-instrument-tick.ts "app/(trading)/trading/trade" lib/realtime-ws.ts \
           components/shoonya/pages/trade.tsx
Expected: 0 errors, 0 warnings
Actual:   0 errors, 0 warnings
Status:   PASS

Command: npm test
Expected: all green
Actual:   tests 461 | pass 461 | fail 0
Baseline: tests 446 | pass 445 | fail 1  (the pre-existing failure was
          tests/realtime-client.test.ts: lib/realtime-ws.ts imported '@/lib/api-base',
          which the Node ESM loader cannot resolve — fixed with './api-base.ts')
Status:   PASS

Command: python -m pytest tests/test_demo_order_intent.py tests/test_common_trading_core.py -q
Expected: all green
Actual:   57 passed
Status:   PASS
```

The 12 new frontend assertions live in `tests/trade-quote-fallback.test.ts` (rewritten
against the new chain) and `tests/trading-session-hydration.test.ts` (repointed).

---

## 6. Problems found during verification

| # | Problem | Fix |
|---|---|---|
| V1 | The feed badge stayed `OFFLINE` while a live price was on screen | the status effect depended on `quote.ts`, which changes with every tick → the interval was re-created before it could fire. The poll now reads the latest values through refs and has no dependencies |
| V2 | The feed badge said `STALE` while streaming | freshness was measured from the broker's feed event time (`ts`, which lags by minutes). It now uses the backend receive time (`receivedAt`) — `hooks/use-instrument-tick.ts` |
| V3 | The first search after a backend restart timed out in the probe | the search engine needs ~5 s to warm up; the probe now waits 7 s. Not a page defect |
| V4 | The backend repeatedly lost its HTTP listener | a pre-existing Windows defect; the watchdog now heals it instead of killing the backend during its cold start (§3.4) |

---

## 7. Not verified

- Physical-device swipe feel (headless touch emulation only).
- An accepted Kotak order end to end — the probe deliberately never sends one to a live
  broker; only the routing and the payload are proven.
- A production build (`npm run build`) — the operator's `next dev` owns the same `.next`
  directory (carried over in `PENDING-002`).
- The charge engine's CASH/DELIVERY vocabulary mismatch (§14.4 of the implementation
  record) — the trade page maps it locally; the shared engine was not changed.

---

## 8. Final result

**PASS** (with the limitations of §7)

The page that "did not work" now: renders a live price, shows the Risk Engine's own
verdict, builds a correct broker/paper payload, and places a paper order that FILLS — with
zero uncaught exceptions and zero console errors, on desktop and on the PWA viewport.
