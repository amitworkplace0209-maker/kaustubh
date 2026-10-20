# 025 — Basket Page: Live Verification (Dummy Terminal)

- **Verification ID:** 025
- **Date / Time:** 2026-10-02, 15:00–15:57 IST (backend clock checked against
  `Get-Date`)
- **Agent:** OpenCode AI agent
- **Task / Feature:** Live verification of `/trading/basket-orders` — compose →
  create → execute → per-leg result, the Trade → Basket handoff, the
  `/api/baskets` contract, and (incidentally) every timestamp that leaves the
  backend. Run against the **running** stack in the Dummy (paper) terminal.
- **Subject pages:** `app/(trading)/trading/basket-orders/page.tsx`,
  `components/orders/basket/basket-page.tsx`,
  `components/orders/trade/trade-page.tsx`
- **Implementation record:** `docs/implementation/025-basket-page-connection-and-usability.md`
- **Session log:** `docs/logs/LOG-007-2026-10-02-basket-page.md`

---

## Expected Behavior

1. Authenticated session → the workspace renders (no redirect, no error
   boundary), in **Dummy** mode with live session/funds/positions.
2. Search an instrument → add a leg → the composer shows it, with honest
   totals (`—` when the value is unknown, never a fabricated `₹0`).
3. Create a basket through the dialog → it persists with `expiry`,
   `maxOrders`, `allocatedAmount` and `status`.
4. Execute → each leg runs the Single Order choke point (Risk → Audit →
   Adapter) and the UI shows the engine's real per-leg result and reason.
5. The Trade page's composed basket survives navigation into the workspace.
6. Every response timestamp is labelled **and** valued in IST.
7. No console errors, no failed network requests.
8. After the run, all test data is removed (baskets + demo account).

## Verification Method

**Headless Chrome over CDP** driving the real UI (no auth bypass — the app's
own Login button is clicked), plus **HTTP probes** against the live backend:

| Harness | Purpose |
|---|---|
| `Temp/opencode/basket-e2e.mjs [url] [waitMs] [--limit]` | login → workspace → search → add leg → create dialog → expand → Execute → console/errors/failed requests/screenshot |
| `Temp/opencode/trade-to-basket.mjs [url] [waitMs]` | login → Trade page → Add to Basket → sessionStorage draft → link → workspace composer |
| plain `Invoke-WebRequest` probes | `/api/baskets`, `/api/demo/orders`, `/api/demo/positions`, `/api/demo/account`, `POST /api/demo/reset` |

Market state during the whole run: `2026-10-02 = EXCHANGE_HOLIDAY`,
**market CLOSED**, so no instrument had a live LTP anywhere in the app. That is
the environment, not a defect — it is what makes the engine's honest rejections
observable.

## Environment

- Windows; Next dev on `127.0.0.1:3000`
- uvicorn `app:app` on `127.0.0.1:8000`, cwd `python-service`, venv python —
  **restarted twice**: PID `24712` (start of session, loaded the new basket
  API) and PID `18424` (15:34:01, loaded the timestamp fix); log
  `Temp/opencode/uvicorn.log`
- Trading mode: **Dummy**; app-lock not configured → direct login
- Chrome headless (`--headless=new`), `ws` resolved from `C:/project`
- Backend clock verified with `Get-Date` (`2026-10-02 15:34:17 +05:30`)

---

## Questions / Checks → Results

### Q1. Does the workspace render for an authenticated session, in Dummy mode?

Header snapshot from the CDP run:

```
DUMMY TRADING TERMINAL v1.0 · Basket Orders · Dummy Mode
Session active · DUMMY · Coin · Dummy Mode — Virtual Trading
PAPER · Paper execution via Dummy Engine · No broker funds
REAL MARKET LTP · Instant fills · VIRTUAL
BASKET DETAILS · 0 baskets · 0 orders
SYSTEM: Terminal Dummy | Mode DUMMY | Currency Coin | Margin Preview Client estimate
```

`Session active` proves the `isDemo` fold-in works (it used to stay blank in
Dummy mode). `DOM: totalElements 890, sections 6, dataNextError null`.

### Q2. Can a leg be added without the page exploding? — **NO, then YES**

**First run (defect):** as soon as a search result was clicked, the section
ErrorBoundary caught

```
Error: `SelectItem` must be used within `SelectContent`
```

Cause: three selects rendered `<SelectItem>` as a direct child of `<Select>`
instead of inside `<SelectContent>` (`basket-page.tsx` lines 953 / 960 / 986 —
product, order type, validity). The whole page was replaced by "Something went
wrong".

**Fix applied**, run re-issued:

```
=== LEG ADDED ===        clicked:RELIANCE NSE CM NO QUOTE EQ RELIANCE INDUSTRIES LTD
=== AFTER LEG ===        Legs in composer 1 · Total Value — · Est. Charges — · Est. Margin —
=== DOM ===              totalElements 890, sections 6, dataNextError null
=== ERRORS (0) ===       (none)
=== FAILED REQUESTS (0) === (none)
```

Honest `—` for all three totals: no LTP exists on a holiday.

### Q3. Does the Create dialog persist a basket?

```
=== CREATE SUBMIT ===    clicked
=== AFTER CREATE ===     VIRTUAL BASKET DETAILS 1 baskets · 1 orders
                         ACTIVE BASKETS 1 · E2E Basket · ACTIVE · 1 orders · Expires: Today
                         0/1 done · ₹1,400
```

Persisted document (GET `/api/baskets`):

```json
{ "_id": "6abf7c9b8e142649be6d1610", "name": "E2E Basket",
  "orders": [{ "symbol":"RELIANCE", "transactionType":"BUY", "orderType":"L",
               "quantity":"1", "price":"1400", "status":"failed", "orderId":"",
               "error":"Limit price or live LTP unavailable" }],
  "cancelOnFill": true, "maxOrders": 1, "allocatedAmount": 0.0,
  "expiry": "Today", "status": "failed", "terminal": "dummy" }
```

`maxOrders` / `allocatedAmount` / `expiry` are now stored (they were dropped
before), and the legs are camelCase.

### Q4. What does Execute do with a MARKET leg?

```
=== EXECUTE ===          clicked
BASKET EXECUTION         0/1 accepted · 1 failed
  #1 Market LTP unavailable — cannot price a market order without live market data
  REJECTED
```

`GET /api/demo/orders`:

```json
{"orderId":"DEMO1790934062969062","symbol":"RELIANCE","transactionType":"BUY",
 "orderType":"MKT","quantity":1,"status":"REJECTED",
 "errorMessage":"Market LTP unavailable — cannot price a market order without live market data",
 "charges":{"total":0.0},"sessionId":"DUMMY:2026-10-02"}
```

The leg reached the engine (a demo `orderId` was minted) and the engine refused
to invent a price. The basket end status became `failed` — derived from the
legs, not guessed.

### Q5. What does Execute do with a LIMIT leg (explicit price)?

Second run with `--limit` (Type → `L`, Price → `1400`):

```
=== TYPE OPTIONS ===     ["MKT","L","SL","SL-M"]
=== PRICE SET ===        price-set:1400
ORDER DETAILS            Legs in composer 1 · Total Value ₹1,400 · Est. Charges ₹1 · Est. Margin ₹280
ACTIVE BASKETS           E2E Basket · ₹1,400 · Exposure ₹280
AFTER EXECUTE            Total 1 · Executed 0 · Pending 0 · Rejected 1
                         Allocated ₹0 · Used ₹1,400 · Remaining -₹1,400 · Exposure ₹280
                         RELIANCE BUY Qty 1 L MIS failed · Price ₹1,400.00 · Value ₹1,400
                         Margin ₹280 · Charges ₹1 · Filled —
BASKET EXECUTION         0/1 accepted · 1 failed
  #1 Limit price or live LTP unavailable · REJECTED
```

The margin/charge/value figures are computed by the real engines (a limit leg
gives them something to price), and `LTP —` stays `—`.

### Q6. Does the Trade page hand its basket over? — YES

```
=== ADD TO BASKET ===    clicked: Add RELIANCE to Basket
=== DRAFT IN SESSIONSTORAGE ===
{"name":"My Basket","legs":[{"symbol":"RELIANCE","token":"2885","exchange":"NSE",
  "side":"BUY","product":"MIS","orderType":"MKT","quantity":"1","price":"0","triggerPrice":"0"}]}
=== OPEN BASKET WORKSPACE === clicked:/trading/basket-orders
=== HANDOFF CHECK ===
{ "url": "/trading/basket-orders", "hasLeg": true, "legsLabel": "1 leg",
  "legSide": true, "orderType": "MKT" }
```

The workspace opened **with the leg composed** (`1 leg … RELIANCE PASS · SIDE
BUY · PRODUCT MIS · TYPE MKT · VALIDITY DAY`) instead of the empty composer it
used to show. `=== ERRORS (0) ===`, `=== FAILED REQUESTS (0) ===`.

### Q7. Does the API contract hold? (backend probes)

```
DELETE /api/baskets/__not_an_object_id__  -> 404   (was 500)
POST   /api/baskets/__not_an_object_id__/push -> 404
snake payload {"transaction_type":"SELL","order_type":"L","trigger_price":1405}
             -> stored {"transactionType":"SELL","orderType":"L","triggerPrice":1405}
policy fields maxOrders 4 / allocatedAmount 150000 / expiry Today -> echoed back
```

All 16 cases are locked down by `python-service/tests/test_baskets_api.py`.

### Q8. Are response timestamps honest IST? — **NO, then YES (defect found here)**

While reading `/api/demo/orders` the timestamp did not line up with the wall
clock:

```
local now (Get-Date) : 2026-10-02 15:27:51 +05:30
order orderDate      : 2026-10-02T09:42:58.334038+05:50  -> labelled +05:30, value 5h30m behind
account startDate    : 2026-10-02T09:50:07.095764+05:30
```

`09:42` is the **UTC** wall clock for an order placed at `15:12 IST`.

Cause: `IstTimestampMiddleware` (`python-service/app.py:1074`) rewrote only the
offset — `services/json_safe.py` had `_UTC_OFFSET_RE.sub(rb"\1+05:30", body)`,
i.e. "the instant itself is unchanged, only the offset it is labelled with".
Every `+00:00` timestamp in every HTTP response reached the UI mislabelled as
IST, contradicting the project invariant in `tests/test_timezones.py`
("Every timestamp the project produces must be IST") and the warning already
written in `test_serializer_treats_naive_as_utc_not_ist`
("labelling it IST would shift it 5h30m").

**Fix applied** (user approved): the rewrite now converts the instant and
stays byte-length preserving; three tests added to `tests/test_timezones.py`.

Re-verification after restarting uvicorn (PID 18424):

```
local now : 2026-10-02 15:34:17 +05:30
account   : "startDate":"2026-10-02T15:20:07.095764+05:30"   (reset time, correct)

local now : 2026-10-02 15:56:20 +05:30
order     : orderDate=2026-10-02T15:56:01.992860+05:30        (order placed 15:56, correct)
```

### Q9. Is the environment left clean?

```
POST /api/demo/reset {"force":true} -> 200 {"message":"Dummy account reset successfully"}
DELETE test baskets                  -> 200
GET  /api/baskets                    -> {"data":[]}
GET  /api/demo/orders                -> {"data":[]}
GET  /api/demo/positions             -> {"data":[]}
GET  /api/demo/account               -> balance 100000, usedMargin 0, freeMargin 100000
```

### Q10. Do the gates pass?

```
pytest tests -q   -> 1436 passed, 1 failed  (test_timezones: 21 passed, was 18)
  pre-existing: tests/test_ws_engine.py::EngineFacadeTest::test_storage_doc_flattens_full_scrip_surface
                '3.0.2' != '3.0.7'
npm test          -> 393 tests, 392 pass, 1 fail
  pre-existing: tests/topbar-status.test.ts:331 'INACTIVE' vs 'AUTHENTICATING'
tsc --noEmit      -> exit 0
eslint (touched)  -> 0 errors, 35 pre-existing warnings
```

## Evidence

- CDP runs: `Temp/opencode/basket-e2e.mjs`, `Temp/opencode/trade-to-basket.mjs`
- Screenshots: `Temp/opencode/basket-shot.png`, `Temp/opencode/handoff-shot.png`
- Backend log: `Temp/opencode/uvicorn.log`
- Test output quoted inline above (Q2–Q10)

## Problems Found

| # | Problem | Severity | State |
|---|---|---|---|
| 1 | `<SelectItem>` outside `<SelectContent>` in 3 selects → whole page crashed on add-leg | Blocker | **Fixed** |
| 2 | API silently turned snake_case legs into BUY/MKT, ignored `maxOrders`/`allocatedAmount`/`expiry`, 500 on bad ids | High | **Fixed** |
| 3 | Dummy mode stubbed (no session/funds/LTP), Orders basket tab read `data.baskets`, Create&Execute read `res._id` | High | **Fixed** |
| 4 | Trade → Basket handoff lost on navigation | High | **Fixed** |
| 5 | Fake `₹0` for unknown exposure/margin | High | **Fixed** |
| 6 | `IstTimestampMiddleware` relabelled UTC as IST (5h30m off) | High | **Fixed** (this run) |
| 7 | Paper engine needs `ltp > 0` for *every* order type → no fill is possible on an exchange holiday | Limitation | Recorded, **not** changed |
| 8 | Two basket stores (`/api/baskets` vs `/api/dummy/baskets`) linked but not consolidated | Medium | Recorded |
| 9 | `TRADE_CAPS.dummy.supportsMarginPreview:false` vs `charges-panel` fetching a Dummy preview → contradictory messages | Medium | Recorded (from 024) |
| 10 | No `GET /api/baskets/{id}` (only list; id GET returns 405) | Low | Recorded |
| 11 | Basket card shows `Allocated ₹0` beside `Used ₹1,400` → `Remaining -₹1,400` | Low | Recorded |

## Fixes Applied

1. Wrapped product / order-type / validity selects in `<SelectContent>`
   (`components/orders/basket/basket-page.tsx`).
2. Rewrote `python-service/api/baskets.py` (aliases, persisted policy fields,
   404 on bad ids, derived end status) + 16 contract tests.
3. Dummy-mode fold-in, camelCase legs, `res?.data?._id` execution wiring,
   honest totals/exposure/funds, derived leg counters, draft seeding.
4. Trade page → `lib/basket-draft.ts` draft + real `<Link>`; Orders/dummy page
   links fixed.
5. `services/json_safe.py::rewrite_utc_offsets_inplace` now converts the
   instant to IST (byte-length preserving); comment updated at
   `app.py:1070`; 3 tests added to `tests/test_timezones.py`.

## Re-verification

Performed after every fix, not once at the end:

- after fix 1 → full `basket-e2e.mjs` run (0 console errors, 0 failed requests)
- after fixes 2–4 → `basket-e2e.mjs --limit` (create + execute) and
  `trade-to-basket.mjs` (handoff), plus direct API probes
- after fix 5 → second `basket-e2e.mjs --limit` run on the restarted backend
  (PID 18424) with correct timestamps (Q8) and identical UI results
- after each round → `pytest`, `npm test`, `tsc`, `eslint`

## Final Result

**PASSED_WITH_LIMITATIONS**

The basket page is connected from the Trade page, the Orders module, the
dashboard and the dummy page; it no longer crashes; search → compose → create →
execute → per-leg result was driven end-to-end twice in a real browser against
the live backend, with 0 console errors and 0 failed requests; the
Trade → Basket handoff works; the API contract is locked down by tests; every
timestamp leaving the backend is now a correctly-valued IST timestamp; and all
test data was reset afterwards.

**Limitation:** no order could *fill*, because `2026-10-02` is an exchange
holiday and the paper engine prices only from a real LTP
(`api/demo.py:334 _execution_decision` requires `ltp > 0` for MKT, limit and
stop). The rejections are honest and visible on screen — this is the
environment, not a broken path. A fill must be re-checked on a trading day.

## Remaining Risks

1. **No fill proven.** Re-run `Temp/opencode/basket-e2e.mjs --limit` on a
   trading day to see a `COMPLETE` leg, a real `orderId`, a position and the
   `completed` basket status.
2. **Timestamp fix is global.** Every API timestamp moved +5h30m to its true
   IST value; any consumer that had silently compensated for the old wrong
   value would now be double-corrected. No such compensation was found, but
   only the automated suites and this session's probes cover it.
3. `Z`-suffixed timestamps are still not rewritten by the middleware (not
   length-preserving); they must keep being prevented at source by
   `sanitize_for_json`.
4. Two basket stores remain (item 8) and `supportsMarginPreview` (item 9) is
   still contradictory — both need a product decision, not a patch.
