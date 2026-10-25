# 024 — Trade Page: Live Verification

- **Verification ID:** 024
- **Date / Time:** 2026-10-02 (IST), during the running session
- **Agent:** OpenCode AI agent
- **Task / Feature:** Live (running-stack) verification of `/trading/trade` —
  page render, instrument search, realtime feed, order ticket and every backend
  dependency it touches. No code was changed by this verification.
- **Subject page:** `app/(trading)/trading/trade/page.tsx` →
  `components/orders/trade/trade-page.tsx` (Dummy mode active)

---

## Expected Behavior

1. With a valid session, `/trading/trade` renders the trade workspace instead of
   redirecting to `/login`.
2. Instrument search returns real instruments from the Search Engine and a
   selection is possible.
3. The realtime path (WS#3 gateway + tick/system SSE) is reachable and accepts
   the page's `trading` subscription.
4. Every data dependency answers with real data or an explicit honest
   "unavailable" — never a fabricated `0`.
5. No console errors, no failed network requests during the session.

## Verification Method

Two complementary methods, both against the **running** stack:

1. **HTTP probes** against the live Next dev server (`127.0.0.1:3000`) and the
   live backend (`127.0.0.1:8000`), including cross-origin (CORS) behaviour,
   SSE streams and a raw WebSocket client session.
2. **Headless Chrome over CDP** (`Temp/opencode/cdp-probe.mjs`), logging in
   **through the app's own Login button** (no cookie injection, no auth bypass),
   navigating to `/trading/trade`, typing into the instrument search, picking a
   result, then capturing the rendered DOM, console, failed requests and a
   screenshot.

Invalid payloads were used instead of real writes so that no order, position or
price was ever created — the verification is read-only.

## Environment

- Windows; Next dev on `127.0.0.1:3000` (`next dev`, started 11:06)
- uvicorn `app:app` on `127.0.0.1:8000` (PID 23796, started 11:05)
- Chrome headless (`--headless=new`), `ws` module resolved from `C:/project`
- Trading mode: **Dummy**; app-lock (PIN) **not configured** → the app's own
  direct-login path is what the Login button uses
- Backend clock: 2026-10-02 13:54 IST

---

## Questions / Checks → Results

### Q1. Does the page render for an authenticated session?

Unauthenticated first, to prove the gate is real:

```
GET /trading/trade                → 307 Location: /login?from=%2Ftrading%2Ftrade
POST /api/auth/login {"direct":true} → 200 {"ok":true,"message":"Authenticated"}
GET /trading/trade (session)      → 200, 70 664 bytes of HTML
```

Rendered text (SSR) contained the workspace shell and **no** error markers
(`Unhandled` 0, `Application error` 0, `ChunkLoadError` 0, `__next_error__` 0).

### Q2. Does the fully hydrated page work in a real browser?

`cdp-probe.mjs … --login --search RELIANCE`:

```
=== LOGIN STEP ===        clicked                (real UI button)
session: {"authenticated":true}
=== URL ===               http://localhost:3000/trading/trade
=== DOM COUNTS ===
  totalElements: 886, inputs: 4, buttons: 40, sections: 4
  hasSearchInput: true
  searchPlaceholder: "Search another — currently RELIANCE"
  dataNextError: null
=== ERRORS (0) ===        (none)
=== FAILED REQUESTS (0) === (none)
```

Console carried only the two harmless React DevTools/HMR notices.

### Q3. Does search actually work?

```
typed: RELIANCE
options:
  "RELIANCE NSE CM NO QUOTE EQ RELIANCE INDUSTRIES LTD Lot 1 ₹— no quote yet"
  "RPOWER  NSE CM NO QUOTE EQ RELIANCE POWER LTD. Lot 1 ₹— no quote yet"
  "RCOM    NSE CM NO QUOTE BE RELIANCE COMMUNICATIONS L Lot 1 ₹— no quote yet"
  "RELCHEMQ NSE CM NO QUOTE EQ RELIANCE CHEMOTEX IND LTD Lot 1 ₹— no quote yet"
  "RELINFRA NSE CM NO QUOTE BE RELIANCE INFRASTRUCTU Lot 1 ₹— no quote yet"
clicked: RELIANCE NSE CM NO QUOTE EQ RELIANCE INDUSTRIES LTD
```

Engine chip reported `Search Engine · healthy · 9,912 instruments`. The page
then showed `SELECTED RELIANCE INDUSTRIES LTD`, the instrument card and a full
order ticket (BUY/SELL, QUANTITY, PRODUCT MIS, ORDER TYPE MKT/L/SL/SL-M,
VALIDITY DAY/IOC), funds `Available: ₹1,00,000`.

Backing REST endpoint: `GET /api/search?q=RELIANCE` → 200 with real ranked
instruments (`NSE:2885`, token `2885`, `RELIANCE-EQ`).

### Q4. Is the realtime path (WS#3) alive end to end?

```
GET  /api/realtime/token  (with session) → 200 {"ok":true,"token":"…",
     "username":"kaustubh","expiresInSeconds":28800,"endpoint":"/ws/realtime"}
WS   ws://127.0.0.1:8000/ws/realtime?token=… → State=Open
     [1] {"type":"welcome", … channels: {market:[ai,market_watch,trading,watchlist], …}}
     [2] {"type":"subscription.ack", correlation_id:"verify-1",
          data:{requestId:"verify-1",
                results:[{channel:"trading", added:1, profile:"POSITION_CRITICAL", …}]}}
```

The exact frame the trade page sends
(`{action:"subscribe", channels:[{channel:"trading", instruments:[…2885…]}],
request_id}`) was accepted and acknowledged by the gateway.

SSE channels used by the page's providers:

```
GET /api/ticks/stream              → 200 chunked, ": heartbeat"   (no ticks — market closed)
GET /api/websocket/system/stream   → 200, data: {"type":"state_snapshot",
   "appConnection":{"state":"CONNECTED","heartbeat":12.0},
   "session":{"status":"SESSION_ACTIVE","mode":"dummy","broker":"Dummy Mode"…}}
```

### Q5. Is cross-origin access from :3000 to :8000 permitted?

```
GET  /api/dummy/state  Origin: http://127.0.0.1:3000 → Access-Control-Allow-Origin: *
OPTIONS /api/dummy/preview (preflight POST+content-type) → 200
     Access-Control-Allow-Origin = http://127.0.0.1:3000
     Access-Control-Allow-Methods = DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT
     Access-Control-Allow-Headers = content-type
     Access-Control-Allow-Credentials = true
```

### Q6. Do the data dependencies answer honestly?

| Endpoint (live) | Result |
| --- | --- |
| `GET /api/system/market` | 200 — `market_status=CLOSED`, `day_class=EXCHANGE_HOLIDAY`, `trading_day=false`, `closure_reason="Exchange holiday"` |
| `GET /api/system` | 200 — node health, uptime, memory |
| `GET /api/system/time` | 200 — IST server time |
| `GET /api/terminal/state` | 200 — `terminal=dummy`, `mode=dummy`, `isLoggedIn=true` |
| `GET /api/dummy/{state,session,portfolio,holdings,risk,positions,market-session,watchlists}` | **8/8 → 200** with real values (`balance 100000`, `marginUtilizationPct 0.0`, `positions []`) |
| `GET /api/terminal/{orders,positions,holdings}/dummy` | 200 — `isDemo:true`, empty books |
| `GET /api/demo/{account,orders,positions}` | 200 |
| `GET /api/market-watch/tick-snapshot?tokens=2885` | 200 — `ltp:null … hasData:false`, `quoteSource:"none"` (honest, no fake price) |
| `POST /api/dummy/preview` (realistic BUY/MIS/LIMIT 10 @ 1400) | **200** — brokerage 4.20, STT 0.00, txn 0.48, GST 0.87, SEBI 0.14, stamp 0.42, **total 6.11**, margin 2 800, `sufficient:true` |
| `POST /api/trade/demo/order` (Next proxy → `/api/demo/order/place`) with `{}` | 422 — route exists and validates (no order created) |
| `POST /api/trade/demo/ltp` (Next proxy → `/api/demo/ltp`) with `{}` | 422 — same |
| `GET /api/trade/demo/positions` | 200 `{"data":[],"stat":"Ok"}` |
| `GET /health` | 200 — `database.connected: true` |

### Q7. What did the page honestly display for the unavailable data?

```
Market CLOSED · Broker WS Down · Data WAITING
RELIANCE NSE CM EQ — WAITING
LTP — · CHANGE — · MARGIN / 1 QTY —
"Circuit data not yet available from broker feed"
"ORDER VALUE — · 1 qty @ ₹—"
"REQUIRED MARGIN UNAVAILABLE · Available: ₹1,00,000 · Remaining: —"
"No server margin yet — the backend response has not arrived."
"No order in flight."
```

Every unavailable value rendered as `—` with a reason. Nothing was defaulted to
`0`, and no price was invented despite the exchange being closed.

---

## Evidence

- Full CDP transcript: `C:\Users\1208a\AppData\Local\Temp\opencode\trade-live.txt`
- Screenshot: `C:\Users\1208a\AppData\Local\Temp\opencode\shot.png`
- CDP harness: `C:\Users\1208a\AppData\Local\Temp\opencode\cdp-probe.mjs`

## Problems Found

**None that block the trade page.** Observations:

1. **`POST /api/trading/quote` → 504 "Quote request timed out or broker
   unavailable"** while the Kotak session is not logged in. This is the *correct*
   honest failure (`api/trading.py` raises 504 rather than returning zeros), and
   it is **not on the active path**: `/trading/trade` in Dummy mode uses
   `components/orders/trade/trade-page.tsx` (WS#3 + market-watch snapshot),
   while `/api/trading/quote` is only called by
   `components/orders/order-entry.tsx`, imported solely by the Kotak page.
2. **`capsFor('dummy').supportsMarginPreview === false`** while
   `ChargesPanel` *does* fetch `/api/dummy/preview` for Dummy. In this run the
   preview correctly did not fire because `price == null` (`ready` requires
   `price > 0`) — an honest no-data state, not a defect. The two messages
   ("Dummy Mode has no margin preview" from `selected-stock-card`, and the
   charges panel's own pending text) describe different things and are both
   truthful, but they read as contradictory to a user.
3. `/api/demo/order` does not exist (404) — expected: the real path is the
   Next proxy `/api/trade/demo/order` → `/api/demo/order/place`. Verified, no
   dead call sites found.

## Fixes Applied

None — no defect required a code change, and this activity changed no code.

## Re-verification

Not applicable (no fix).

## Final Result

**`PASSED_WITH_LIMITATIONS`**

Proven live, against the running stack:

- authenticated render of `/trading/trade` with **0 console errors and 0 failed
  requests** in a real browser,
- working instrument search → selection → instrument card → order ticket,
- WS#3 gateway connect + `trading` subscription acknowledged,
- both SSE streams, CORS, and all 20+ Dummy/terminal/search/preview endpoints
  returning real data,
- honest `—` + reason rendering for every value the closed market cannot supply.

Limitations (both environmental, neither caused by the page):

- **Market closed** — 2026-10-02 is an `EXCHANGE_HOLIDAY`, so live quotes,
  tick-driven LTP, charges preview (needs a price) and a real order round-trip
  could not be exercised end to end. The page behaved correctly by showing
  `—`/`WAITING` rather than invented values.
- **No order was placed** — the verification was deliberately read-only; the
  order chain was proven only to the point where the engine validates the
  payload (422 on an empty body through the real Next proxy).

## Remaining Risks

- The live-quote, order-placement and charges-preview paths still need a pass
  **during market hours** to be fully proven.
- The backend process on port 8000 still runs pre-Tick-Analytics code, so
  `/api/data-saver/tick-analytics/*` remains 404 there (tracked in
  verification 023; unrelated to this page).
