# 025 — Basket Page: Connection, Correctness and Working Execution Path

- **Implementation ID:** 025
- **Date:** 2026-10-02 (IST)
- **Agent:** OpenCode AI agent
- **Task:** `basket page ko upadate kro trade page or bake sab jgh se connect kro or basket page ko working kro`
  — update the Basket Workspace, connect it from the Trade page and from every
  other entry point, and make it actually work end-to-end in the Dummy
  (paper) terminal.
- **Records:** verification `docs/verification/025-basket-page-live-verification.md`,
  session log `docs/logs/LOG-007-2026-10-02-basket-page.md`.

---

## Task

Make `/trading/basket-orders` a working page:

1. It must render and behave correctly in **Dummy** mode (session, funds,
   positions, LTP and risk must be live, not stubs).
2. Adding a leg from Global Search, creating a basket, expanding it and
   executing it must all work through the real UI and the real backend.
3. Every other surface that talks about baskets (Trade page composer, Orders
   module, dashboard, dummy page) must actually lead to this workspace.
4. The Trade page's composed basket must arrive in the workspace instead of
   evaporating on navigation.

## Objective

Deliver a basket workspace that a user can drive from search → compose →
create → execute → per-leg result, with honest values only (no fabricated
prices, margins or fills), and prove it with a real browser run.

## Scope

- `python-service/api/baskets.py` — basket CRUD / push contract hardening.
- `python-service/tests/test_baskets_api.py` — new contract tests.
- `python-service/services/json_safe.py` + `python-service/app.py` — response
  timestamp rewrite (found broken during this verification, user-approved fix).
- `python-service/tests/test_timezones.py` — 3 new invariant tests.
- `components/orders/basket/basket-page.tsx` — the workspace itself.
- `lib/basket-draft.ts` (new) — Trade → Basket draft handoff.
- `components/orders/trade/trade-page.tsx` — compose + hand off + link.
- Entry points: `app/(dashboard)/orders/page.tsx`, `components/dummy/pages/baskets.tsx`.
- Live verification in Dummy mode, then reset of all test data.

## Out of Scope

- No change to the paper engine's fill rules (`api/demo.py`).
- No consolidation of the two independent basket stores.
- No broker (Kotak Neo) execution test — Dummy only.
- No tick/analytics, data-center or trade-page feature work (previous rounds).

## Source Documentation Read

- `PROJECT_IMPLEMENTATION_RULE.md` — §14 (implementation record), §15/§16
  (verification), §21 (no fake data), §39/§40 (update order + serials),
  §56 (filesystem is source of truth for numbering), §67 (implementation +
  verification + log relationship), §71 (working files).
- `docs/verification/024-trade-page-live-verification.md` (previous round,
  trade page = `PASSED_WITH_LIMITATIONS`) — carried its open observation about
  `supportsMarginPreview` into this record.
- Existing files listed under *Files Changed* before every edit (trace before
  change).

## Existing State

- The route `/trading/basket-orders` existed and was gated
  (`TerminalRouteGate allowed=['dummy','kotak-neo']`), and nav entries
  (`orders-basket`, terminal variants, dashboard, Orders module) already
  pointed at it.
- The backend `/api/baskets` API existed but silently mangled legs and crashed
  on bad ids.
- The workspace page existed but was effectively unusable in Dummy mode and
  crashed in the browser as soon as a leg was composed.

## Problems Found

1. **Page crash (blocker).** Three `<Select>` elements rendered their
   `<SelectItem>` children as a direct child of `<Select>` instead of inside
   `<SelectContent>` (`basket-page.tsx` lines 953 / 960 / 986). Radix throws
   `SelectItem must be used within SelectContent`; the section ErrorBoundary
   replaced the whole page with "Something went wrong" the moment a leg was
   added. This alone made the page "not working".
2. **Silent leg corruption.** The API accepted snake_case legs
   (`transaction_type`, `order_type`, `trigger_price`) and stored them as
   `BUY`/`MKT`/`0` — a SELL limit order became a BUY market order.
3. **500 on malformed ids.** `PUT` / `DELETE` / `POST …/push` with a
   non-ObjectId raised an unhandled error instead of `404`.
4. **Lost policy fields.** `maxOrders`, `allocatedAmount`, `expiry` were
   accepted but never persisted; `status` never advanced honestly.
5. **Wrong end status.** With `cancelOnFill:false` every basket finished
   `failed` even when every leg filled.
6. **Dummy mode stubbed out.** `loggedIn` did not include `isDemo`, so
   session, funds, positions, LTP and risk were blank in Dummy; the Orders
   module read `data.baskets` instead of `data?.data` so its basket tab was
   permanently empty; `legToOrder` emitted snake_case so the create path sent
   the same corrupted legs; "Create & Execute" read `res._id` while the API
   returns `{data:{_id}}`, so execution never started.
7. **Fake zeros.** Exposure/margin rendered `₹0` when the value was unknown.
8. **Broken Trade → Basket handoff.** `basketItems` lived only in Trade page
   state; clicking "Open Basket Workspace" arrived with an empty composer.
9. **Timestamps mislabelled as IST (found while reading the API evidence).**
   `IstTimestampMiddleware` (`app.py:1074`) called
   `services/json_safe.rewrite_utc_offsets_inplace`, which only replaced the
   `+00:00` offset with `+05:30` and left the instant untouched — so every
   UTC timestamp in every response reached the UI 5h30m behind real time
   while claiming to be IST. Contradicted the project's own invariant
   (`tests/test_timezones.py`) and its own warning comment. Reported to the
   user, approved, fixed in this round.

## Design Decision

- **Fix the render, don't work around it.** Wrap the three selects in
  `<SelectContent>` (the same shape every other select in the repo already
  uses) rather than replacing Radix selects with custom controls.
- **One store, two dialects.** Keep `/api/baskets` as the single store and make
  it accept both camelCase and snake_case (`AliasChoices`) while always
  **persisting camelCase**. Corrupting an order is worse than a strict API.
- **Hand off through storage, not route state.** A tiny module
  (`lib/basket-draft.ts`, in-memory + `sessionStorage`
  `kaustubh.basket.draft`) written by the Trade page whenever `basketItems`
  changes, and consumed once (`takeBasketDraft()`) by the workspace on mount —
  so it survives links, sidebar navigation and reload.
- **Honest or absent.** Unknown values render `—`, at-most values render
  `≤ ₹x`, at-least values `₹x+`; per-leg status is derived case-insensitively
  from what the engine actually returned; the end status is derived from the
  legs (`completed` / `partial` / `failed` / `cancelled`).
- **Convert, never relabel, a timestamp.** The response middleware keeps its
  byte-length-preserving rewrite (so `Content-Length` and streaming stay
  valid) but now runs the instant through `to_ist()` — same digits, same
  6-byte offset, correct wall clock.
- **No engine change.** The paper engine's requirement of a live LTP for every
  order type was left untouched; the holiday consequence is documented in the
  verification record as a limitation instead of being papered over.

## Files Changed

| File | Change |
|---|---|
| `python-service/api/baskets.py` | rewritten |
| `python-service/tests/test_baskets_api.py` | new |
| `python-service/services/json_safe.py` | `rewrite_utc_offsets_inplace` converts the instant to IST |
| `python-service/app.py` | middleware comment corrected (converts, not relabels) |
| `python-service/tests/test_timezones.py` | +3 response-rewrite invariant tests |
| `components/orders/basket/basket-page.tsx` | Dummy-mode fold-in, camelCase legs, create→execute wiring, honest totals/status, draft seeding, 3 `<SelectContent>` fixes |
| `components/orders/trade/trade-page.tsx` | `setBasketDraft` effect, `<Link>` to the workspace |
| `app/(dashboard)/orders/page.tsx` | `data?.data` fix + 2 workspace links |
| `components/dummy/pages/baskets.tsx` | "Full workspace" link |
| `lib/basket-draft.ts` | new (draft store) |

## Files Created

- `python-service/tests/test_baskets_api.py`
- `lib/basket-draft.ts`
- `docs/implementation/025-basket-page-connection-and-usability.md`
- `docs/verification/025-basket-page-live-verification.md`
- `docs/logs/LOG-007-2026-10-02-basket-page.md`

## Files Removed

None.

## Backend Changes

`python-service/api/baskets.py`:

- Leg models take `AliasChoices` so `transactionType|transaction_type`,
  `orderType|order_type`, `triggerPrice|trigger_price`, `disclosedQty|…`,
  `validity|…` all validate; storage always camelCase.
- `maxOrders`, `allocatedAmount`, `expiry`, `status` are persisted and echoed.
- `_oid()` → HTTP 404 on a malformed id for `PUT`, `DELETE`, `POST …/push`.
- Empty basket → 400; pushing an executed basket again → 400.
- End status is computed from legs (`completed` / `partial` / `failed`), which
  makes `cancelOnFill:false` behave correctly.
- Blank basket name → 422.

`python-service/services/json_safe.py`:

- `rewrite_utc_offsets_inplace()` (called by `IstTimestampMiddleware` for every
  HTTP response body) previously did `_UTC_OFFSET_RE.sub(rb"\1+05:30", body)` —
  a pure relabel that left the UTC instant in place. It now parses the
  timestamp, runs it through the canonical `to_ist()` and re-emits it, still
  byte-for-byte the same length (same digit pattern, same 6-byte offset) so
  `Content-Length` and streaming behaviour are untouched.
- `Z`-suffixed timestamps are still deliberately ignored (not
  length-preserving); they remain prevented at source by `sanitize_for_json`.
- `app.py:1070` comment updated to describe the conversion.

## Frontend Changes

`components/orders/basket/basket-page.tsx`:

- `isDemo = mode === 'dummy'` folded into `loggedIn` → session, funds,
  positions, LTP and risk panels are live in Dummy mode.
- `legToOrder` emits camelCase (matches the new contract).
- `handleAddLegToBasket` no longer remaps existing legs (it used to wipe
  side/type on every add).
- "Create & Execute" reads `res?.data?._id` → execution actually starts.
- `legIsExecuted/Pending/Rejected/Cancelled` + `CLOSED_BASKET_STATUSES` →
  counters (`Executed / Pending / Rejected`) are derived from real leg state.
- Composer totals are LTP-aware with labelled fallbacks (`—`, `₹x+`, `≤ ₹x`).
- Exposure uses `basketValue` / `basketExposure` / `labelAtMost` instead of a
  fake `₹0`; funds show `—` while the Account Engine has not answered.
- `statusTone` accepts `PARTIAL` / `EXECUTING`.
- One-shot `takeBasketDraft()` effect seeds the composer from the Trade page.
- **Crash fix:** product / order-type / validity selects now wrap their items
  in `<SelectContent>`.

`components/orders/trade/trade-page.tsx`: persists `basketItems` as a draft on
every change; "Open Basket Workspace (n)" is a real `<Link>`.

`app/(dashboard)/orders/page.tsx`: reads `data?.data` (basket tab was empty)
and gained two workspace links. `components/dummy/pages/baskets.tsx` gained a
"Full workspace" link (`ArrowUpRight`).

## Database Changes

None (basket documents live in the existing MongoDB collection; only the
persisted field set changed — `maxOrders`, `allocatedAmount`, `expiry`,
`status` are now written).

## API Changes

`/api/baskets` (and `/api/baskets/{id}`, `/api/baskets/{id}/push`):

- accepts snake_case **and** camelCase leg payloads (camelCase on output);
- returns `404` for malformed ids (was `500`);
- returns `400` for an empty basket and for re-pushing a closed basket;
- returns `422` for a blank name;
- persists/echoes `maxOrders`, `allocatedAmount`, `expiry`, `status`.

No route added or removed.

## Realtime Changes

None.

## Scheduler/Lifecycle Changes

None.

## Documentation Changes

- `docs/implementation/025-basket-page-connection-and-usability.md` (this file)
- `docs/verification/025-basket-page-live-verification.md`
- `docs/logs/LOG-007-2026-10-02-basket-page.md`

## Tests

- New: `python-service/tests/test_baskets_api.py` — 16 contract tests
  (snake/camel parity, policy field persistence, 404 on bad ids, empty basket,
  choke point, `cancelOnFill` end status, `partial`, re-push guard, blank name).
- New in `python-service/tests/test_timezones.py` — 3 response-rewrite tests:
  instant converted (not relabelled), length preserved across a date rollover,
  `+05:30` / `Z` / plain dates / empty body left alone.
- Existing suites re-run unchanged.

## Test Results

```
pytest tests -q  (python-service)  ->  1436 passed, 1 failed (pre-existing)
  tests/test_timezones.py                              -> 21 passed (was 18)
  FAILED tests/test_ws_engine.py::EngineFacadeTest::test_storage_doc_flattens_full_scrip_surface
  AssertionError: '3.0.2' != '3.0.7'   (pre-existing, untouched by this change)

npm test                            ->  393 tests, 392 pass, 1 fail (pre-existing)
  tests/topbar-status.test.ts:331  'INACTIVE' vs 'AUTHENTICATING' (pre-existing)

tsc --noEmit -p tsconfig.json       ->  exit 0
eslint (5 touched files)            ->  0 errors, 35 warnings (all pre-existing unused-var)
```

## Verification

Full live verification in the running stack — see
`docs/verification/025-basket-page-live-verification.md`
(`PASSED_WITH_LIMITATIONS`). Summary of what was proven in a real browser:

1. Crash-free compose: search → leg → composer (after the `<SelectContent>`
   fix) — 0 console errors, 0 failed requests.
2. Create through the dialog → basket persisted with `expiry`, `maxOrders`,
   `allocatedAmount`, `status: active`.
3. Execute → per-leg engine result rendered (`0/1 accepted · 1 failed`,
   reason `Market LTP unavailable — cannot price a market order without live
   market data`), basket end status `failed`, demo order `DEMO…` written with
   computed charges and the same honest `errorMessage`.
4. Limit variant → leg `L @ ₹1400`, `Total Value ₹1,400` / `Est. Charges ₹1`
   / `Est. Margin ₹280` / `Exposure ₹280`, `Used ₹1,400`, reason
   `Limit price or live LTP unavailable`.
5. Trade → Basket handoff → sessionStorage draft written, link navigates, the
   workspace opens with `1 leg` (RELIANCE, `SIDE BUY · PRODUCT MIS · TYPE MKT`)
   instead of an empty composer.
6. Backend contract probes: snake payload stored as `SELL`/`L`, malformed id
   → `404`, policy fields echoed.
7. Timestamps: before the fix `orderDate` read `09:42:58+05:30` for an order
   placed at `15:12 IST`; after the fix (uvicorn restarted, PID 18424) it
   reads `15:56:01.992860+05:30` against `Get-Date 15:56:20 +05:30`, and
   `account.startDate` reads `15:20:07+05:30` for a reset done at 15:20.
8. Cleanup: `POST /api/demo/reset` → `200`, test baskets deleted,
   `/api/baskets` = `{"data":[]}`, demo orders `[]`, balance `100000`,
   `usedMargin 0`.

## Remaining Issues

1. **No fill is possible on an exchange holiday.** `_execution_decision` in
   `python-service/api/demo.py:334` requires `ltp > 0` for MKT, limit *and*
   stop orders; on `EXCHANGE_HOLIDAY` there is no tape, so every paper order
   is honestly rejected. Not changed (changing it would invent market data).
   A limit order with no LTP arguably deserves to `REST/OPEN` rather than
   reject — recorded as an open design question, not implemented.
2. **Two basket stores** — `/api/baskets` (this workspace) and
   `/api/dummy/baskets` (embedded Orders-module tab) are linked but not
   consolidated.
3. `TRADE_CAPS.dummy.supportsMarginPreview:false` while `charges-panel.tsx`
   fetches the Dummy preview → two contradictory on-screen messages (carried
   over from verification 024).
4. No single-basket `GET /api/baskets/{id}` (list only); `GET` on an id
   returns `405`. Not needed by the UI today.
5. With no allocation set, a basket card shows `Allocated ₹0` next to
   `Used ₹1,400` → `Remaining -₹1,400`. Honest arithmetic, harsh presentation.
6. The timestamp fix is **global**: every API timestamp moved +5h30m to its
   true IST value. No consumer was found compensating for the old wrong value,
   but only the automated suites and this session's probes cover that.
7. `Z`-suffixed timestamps are still not rewritten by the middleware (not
   length-preserving) — they must keep being prevented at source.

## Pending Work

None inside this task. See *Remaining Issues* for the four recorded items.

## Final Status

**COMPLETE — PASSED_WITH_LIMITATIONS.**
The basket page is connected from every entry point, no longer crashes, and
its full search → compose → create → execute → per-leg result path was driven
end-to-end in a real browser against the live backend, with all test data
reset afterwards. The verification also caught and fixed a global honesty bug
— API timestamps were UTC instants wearing an IST label. Execution cannot
*fill* while the exchange is closed; that is an environment limitation of the
honest paper engine, not a defect in the basket path.
