# 018 — Search Engine Single Canonical Instrument Discovery: Verification

- **Status:** `VERIFIED_WITH_LIMITATIONS`
- **Implementation record:**
  `docs/implementation/018-search-engine-single-canonical-instrument-discovery.md`
- **Date:** 2026-09-30
- **Environment:** backend `http://127.0.0.1:8000` restarted on the final code;
  frontend `http://127.0.0.1:3000` (typecheck + unit tests; no browser run).

---

## 1. Automated verification

### Backend

```
python -m pytest -q
1280 passed, 1 failed, 12 subtests passed
```

The only failure is pre-existing and unrelated to search:

```
tests/test_timezones.py::test_production_modules_do_not_redefine_the_offset
AssertionError: modules re-deriving the IST offset: ['api/quality.py']
```

`api/quality.py` was not modified by this task.

New/updated search coverage:

| File | Tests | Result |
| --- | --- | --- |
| `tests/test_search_engine.py` | 40 | pass |
| `tests/test_master_canonical.py` | 26 | pass |

`LegacyAdapterTest` pins the consolidation itself: legacy rows come from the
canonical index, the legacy field-name projection is complete, missing live
state stays `null` + `UNAVAILABLE` (never `0`), an unavailable index is
reported rather than hidden, and the deprecation target is `/api/search`.

Freshness regression cases asserted directly: epoch-seconds, epoch-milliseconds
and ISO-string ticks all produce correct ages; a tick with no clock is `STALE`,
not `LIVE`; the LTP-cache fallback reports `STALE` with `source="ltp_cache"`.

### Frontend

```
node --test "tests/*.test.ts"
tests 313 / pass 312 / fail 1
npx tsc --noEmit -p tsconfig.json
(clean)
```

The only failure is pre-existing and unrelated to search:

```
tests/topbar-status.test.ts:331  canonical session state never invents ACTIVE
  actual: 'INACTIVE'   expected: 'AUTHENTICATING'
```

`tests/instrument-search.test.ts` passes in full.

### Lint

The one migration-introduced warning (unused `providerWs` in
`app/(phase2)/data-saver/subscription/page.tsx`) was fixed; the page reads
per-subscription feed state from the subscription payload as before.

---

## 2. Live HTTP verification

All four instrument-search routes verified against the restarted backend.

### 2.1 Canonical `GET /api/search`

```
GET /api/search?q=heromotors&limit=1
  ltp=152.58 change=13.87 changePct=10.0 prevClose=138.71
  upperCircuit=152.58 lowerCircuit=124.84
  liveStatus=LIVE dataStatus=LIVE tickAgeSeconds=0.0
  source=kotak_neo_sfeed token=766171
  exchangeSegment=nse_cm marginStatus=UNAVAILABLE oneQtyMargin=null
```

Real production tick, canonical source, fresh clock, broker-valid segment.
Margin is `null` + `UNAVAILABLE` because no session is active — never derived
from LTP or leverage.

### 2.2 Honest-failure case (no fabrication)

```
GET /api/search?q=tcs&limit=1
  TCS-EQ  ltp=null  change=null
          liveStatus=UNAVAILABLE  dataStatus=UNAVAILABLE
          marginStatus=UNAVAILABLE
```

An index hit with no canonical tick returns nulls and an explicit status. No
zero is substituted for a missing price.

### 2.3 Legacy routes now resolve through the canonical index

```
GET  /api/stocks/search?q=heromotors&limit=1
  source=search_engine deprecated=true replacement=/api/search instrumentCount=1
  token=766171 tradingSymbol=HEROMOTORS-EQ exchangeSegment=nse_cm
  ltp=152.58 liveStatus=LIVE

POST /api/stocks/search  {"search_text":"heromotors"}
  source=search_engine deprecated=true
  pTrdSymbol=HEROMOTORS-EQ pExchSeg=nse_cm token=766171

POST /api/trading/search-local  {"exchange":"nse_cm","search_text":"heromotors"}
  source=search_engine stat=ok deprecated=true instrument_count=1
  row0=HEROMOTORS-EQ token=766171 ltp=152.58
```

All three return identical instrument identity and identical LTP to the
canonical route — evidence of a single index rather than three lookups. Legacy
envelopes (`data` / `results` / `stat` / `source`, Kotak `p*` fields) are
preserved so remaining callers keep working.

### 2.4 Engine status and invalid-scope handling

```
GET /api/search/status
  engineId=search_engine version=2.0.0 state=RUNNING health=HEALTHY
  instrumentCount=9909 indexedTerms=43395 ltpCacheSize=0
  scopes=[stocks, pages, features, actions, watchlists]

GET /api/search?q=heromotors&scope=bonds
  results=[] total=0 errorCode=SEARCH_INVALID_SCOPE scopes=[]
```

An unsupported scope is reported as an error code in the envelope with HTTP
200, never silently coerced to the default `stocks` scope. `ltpCacheSize=0`
confirms live values come from the canonical tick store, not the local LTP
cache — the fallback cache was not in play during this run.

### 2.5 Unchanged by design

- `GET /api/market-watch/search` — still the Market Watch engine's own universe
  search. Not a duplicate instrument lookup.
- `POST /api/trading/search` — still a live broker scrip passthrough; the
  Search Engine does not own broker scrip lookup.

### 2.6 Next.js proxy

`app/api/phase2/subscription-search/route.ts` was repointed from the deprecated
`/api/stocks/search` backend route to canonical `/api/search?scope=stocks`. A
repository-wide search confirms no frontend source, component, test or doc
references the legacy endpoints any more; the only remaining occurrences are
the deprecated `lib/api.ts` wrappers themselves, which are kept for external
callers and now accept an `AbortSignal`.

---

## 3. Known limitations and unresolved items

1. **Pre-existing backend failure.** `tests/test_timezones.py` vs
   `api/quality.py`. Out of scope, untouched.
2. **Pre-existing frontend failure.** `tests/topbar-status.test.ts`
   `INACTIVE` vs `AUTHENTICATING`. Out of scope, untouched.
3. **Market Watch split state.** `/api/market-watch/tick-snapshot?tokens=766171`
   returns no rows while `/api/search` reports the same token live from
   `tick_buffer`. Two different stores, not addressed here.
4. **No live STALE demonstration.** No stale tick was available at verification
   time. The production-shaped STALE path is covered by unit tests only.
5. **Margin Engine not wired.** `core/engines/margin_engine.py` is registered
   but not auto-started and not reachable from the Search API. Margin still
   comes only from the authoritative provider.
6. **Instrument universe.** The master currently holds only `nse_cm` rows
   (9,909). BSE/MCX are absent, so `exchangeSegment` variety cannot be
   verified against the live index.
7. **R-37 / R-38 security findings remain open.** Direct-path login and the
   browser-reachable operator token. Explicitly not addressed per user
   directive; no auth file was modified in this task.
8. **No browser verification.** Frontend changes are covered by typecheck and
   unit tests; no interactive UI run was performed.
9. **Full SDK capability/source review incomplete.** Installed references are
   Kotak Neo `kotakneoapi` 3.0.7 and Shoonya `NorenRestApiOAuth` 0.0.41.

---

## 4. Real-time honesty statement

Every number in section 2 came from the live backend over HTTP on the final
code. No value was hand-written, copied from documentation, or inferred. Where
state was missing the API returned `null` with an explicit status, and that is
recorded as-is rather than being filled in.
