# 018 — Search Engine as the Single Canonical Instrument Discovery Path

- **Task:** Make the existing Search Engine the only instrument-discovery
  implementation. One backend contract, one frontend client, one hook, no
  parallel search implementation, no duplicated ranking or result shape.
- **Status:** `IMPLEMENTED` (backend + frontend automated suites pass; live HTTP
  verification performed — see
  `docs/verification/018-search-engine-single-canonical-instrument-discovery-verification.md`)
- **Contract:** `docs/engines/search-engine.md`
- **Date:** 2026-09-30
- **Serial predecessor:** `017-data-center-observability-center`

---

## 1. Target invariant

```
INSTRUMENT DISCOVERY
    -> ONE BACKEND CONTRACT  (GET/POST /api/search)
    -> ONE FRONTEND CLIENT   (lib/instrument-search-client.ts)
    -> ONE FRONTEND HOOK     (hooks/use-instrument-search.ts)
    -> ONE RANKING, ONE NORMALIZATION, ONE RESULT SHAPE
NO COMPONENT OWNS A PRIVATE INSTRUMENT SEARCH
LIVE STATE -> services/tick_buffer (canonical)   |  NEVER a private cache
MARGIN      -> authoritative broker provider    |  NEVER derived from LTP or leverage
MISSING DATA -> null + explicit status/reason    |  NEVER 0, NEVER a guess
```

Explicitly out of scope, and unchanged by this task:

- Market Watch / watchlist ranking (owned by the Market Watch engine).
- Order placement, order context, position maths.
- The scheduler.
- Login / auth behaviour (`app/api/auth/login/route.ts`,
  `app/api/realtime/token/route.ts` untouched per explicit user directive).

---

## 2. Field → source → owner map

| Field | Source | Owner |
| --- | --- | --- |
| `symbol`, `name`, `tradingSymbol`, `series`, `token`, `isin`, `exchangeSegment`, `lotSize`, `tickSize`, `instrumentType` | `sanctioned_master` / `instrument_cache` (instrument registry) | Instrument registry |
| `ltp`, `prevClose`, `change`, `changePct`, `volume`, `bid`, `ask`, `spread`, `timestamp` | `services/tick_buffer.get_latest_ticks()` (canonical live store; e.g. `kotak_neo_sfeed`) | Broker feed → tick store |
| `upperCircuit`, `lowerCircuit` | canonical tick store | Broker feed → tick store |
| `tickAgeSeconds`, `liveStatus`, `dataStatus` | derived from the tick clock by the Search Engine | Search Engine |
| `oneQtyMargin` | `kotak_session.margin_required` (authoritative 1-Qty MIS) | Broker margin authority |
| `marginStatus`, `marginSource`, `marginReason` | provider response, incl. `REQUIRES_ORDER_CONTEXT` pass-through | Search Engine |
| `source` (index) | `search_engine` | Search Engine |

Status vocabulary is the one in `docs/engines/search-engine.md`: `LIVE`,
`STALE`, `UNAVAILABLE` for market data; `AVAILABLE` / `UNAVAILABLE` /
`REQUIRES_ORDER_CONTEXT` for margin.

---

## 3. Backend

### 3.1 Freshness and shape (`core/engines/search_engine.py`)

- Freshness now normalizes every timestamp shape the tick store actually holds:
  timezone-aware `datetime`, epoch seconds, epoch milliseconds, ISO-8601
  string. Previously non-`int` values fell through and every real production
  tick read as fresh.
- A price with no usable clock is **not** claimed fresh (`STALE`, not `LIVE`).
- `timestamp` is emitted as ISO-8601 UTC; `tickAgeSeconds`, `dataStatus` and
  `source` accompany it so the consumer never has to infer freshness.
- The LTP cache fallback now reports `STALE` with `source="ltp_cache"`. It
  previously reported `LIVE` with no clock, which invented liveness.
- Canonical `change`, `changePct`, `close` → `prevClose`,
  `upper_circuit_limit` → `upperCircuit`,
  `lower_circuit_limit` → `lowerCircuit` are read directly.
- New error codes: `SEARCH_INVALID_SCOPE`, `SEARCH_INDEX_UNAVAILABLE`.
  Margin carries `marginSource` and `marginReason`; a provider
  `REQUIRES_ORDER_CONTEXT` status passes through rather than being flattened
  to `UNAVAILABLE`.

### 3.2 `master_canonical` provenance (`ws_socket/engine/router.py`)

`master_canonical` was dropped when payloads were reshaped, so downstream
consumers and storage documents lost the source attribution. It is now
preserved.

### 3.3 One index behind the legacy routes

The duplicate endpoints each ran their own master scan, ranking and field
mapping. They now resolve through the same engine, keeping their legacy
envelopes so existing callers keep working:

| Legacy route | Previous behaviour | Now |
| --- | --- | --- |
| `GET /api/stocks/search` | own master scan + EQ filter, blocking 45s cache load, broker fallback | delegates to `search_engine.search_scoped()`; `deprecated: true`, `replacement: "/api/search"` |
| `POST /api/stocks/search` | own master scan, Kotak `p*` fallback when cache cold | delegates to the canonical index; Kotak `p*` field names still emitted for broker-subscription callers |
| `POST /api/trading/search-local` | own master scan, else live Kotak `search_scrip` | delegates to the canonical index; `source: "search_engine"` |
| `POST /api/trading/search` | live broker scrip passthrough | unchanged (a broker capability, not instrument discovery); marked deprecated in the docstring |
| `GET /api/market-watch/search` | Market Watch engine universe search | unchanged — owned by the Market Watch engine, not a duplicate instrument lookup |

The shared adapter lives in `api/search.py`:
`canonical_instrument_rows()` and `legacy_row()`. `api/stocks.py` and
`api/trading.py` import from it, so there is no second normalizer.

### 3.4 Not changed, deliberately

- `core/engines/margin_engine.py` is still registered but not auto-started and
  not reachable from the Search API. Search resolves margin only through the
  authoritative provider; wiring the engine in is a separate decision.
- The Market Watch tick-snapshot split state is untouched here (recorded as a
  known discrepancy in the verification record).

---

## 4. Frontend

### 4.1 Shared contract

- `lib/instrument-search.ts` — import-free types, constants, normalization,
  stable identity, explicit statuses. No `lib/api` import (keeps the contract
  testable in isolation).
- `lib/instrument-search-client.ts` — one-shot canonical search client.
- `hooks/use-instrument-search.ts` — 300ms debounce, minimum query length,
  bounded limit, 8s timeout, `AbortController`, sequence guard, 15s TTL cache,
  and a `loading` / `success` / `error` / `empty` state machine.
- `lib/api.ts` — `GlobalSearchResult` widened for ISO timestamps, circuits,
  data/source fields and margin metadata. The four legacy search helpers now
  accept an `AbortSignal` and are marked `@deprecated` in favour of the client.
- `lib/order-workspace.ts` — search constants removed; Orders-only
  presentation/validation helpers retained.

### 4.2 Consumer migration (15 files)

Every one of the 15 call sites now uses the shared hook or client; the local
debounce timers, per-component `AbortController`s, ad-hoc mapping and
`${name} (${exchange})` identity strings are gone.

- `components/orders/trade/instrument-search.tsx`
- `app/(phase2)/data-saver/watch-list/page.tsx`
- `app/(phase2)/data-saver/subscription/page.tsx`
- `app/(phase2)/data-saver/analytics/page.tsx`
- `app/(phase2)/data-saver/websocket/page.tsx`
- `app/(dashboard)/stocks/page.tsx`
- `app/_pages/stocks/page.tsx`
- `app/(dashboard)/orders/page.tsx`
- `components/dummy/pages/trade.tsx`
- `app/_pages/session-manager/manual-add.tsx`
- `components/orders/stock-search.tsx`
- `components/downloads/stock-search.tsx`
- `components/layout/universal-search.tsx`
- `components/kotak/pages/watchlist.tsx`
- `components/kotak/pages/trading-chart.tsx`

Preserved behaviour: `companyName` compatibility alias, navigation-index
results, subscription flows, quote overlays, selection callbacks and UI
labelling. `exchangeSegment` keeps the broker-valid `nse_cm` form that the
subscription path requires.

### 4.3 Tests

- `tests/instrument-search.test.ts` (new) — contract, normalization,
  statuses, identity, clamp behaviour.
- `tests/orders-workspace.test.ts` — updated import ownership.
- `python-service/tests/test_search_engine.py::LegacyAdapterTest` (new) — pins
  the consolidation: legacy rows resolve through the canonical index, the legacy
  field projection is complete, missing live state stays `null` +
  `UNAVAILABLE`, an unavailable index is reported, and the deprecation target
  is `/api/search`.

### 4.4 Proxy route

`app/api/phase2/subscription-search/route.ts` now targets canonical
`/api/search?scope=stocks` instead of the deprecated `/api/stocks/search`.
A repository-wide search confirms no remaining frontend reference to the legacy
endpoints; the only occurrences left are the deprecated `lib/api.ts` wrappers.

---

## 5. Verification summary

- Backend: `1280 passed, 1 failed` — the single failure is the pre-existing
  `tests/test_timezones.py::test_production_modules_do_not_redefine_the_offset`
  against untouched `api/quality.py`.
- Frontend: `313 tests, 312 pass, 1 fail` — the single failure is the
  pre-existing `tests/topbar-status.test.ts` (`INACTIVE` vs `AUTHENTICATING`).
- `npx tsc --noEmit` clean.
- Live HTTP verification of all four search routes — see the verification
  record.
