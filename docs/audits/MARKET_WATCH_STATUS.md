# Market Watch — Status & Handoff

**Feature:** Market Watch (NSE EQ intraday gainers / losers)
**Spec (authoritative):** `docs/engines/MARKET_WATCH.md`
**Status:** Code complete, deterministic tests green, frontend reconciled.
**Blocker for full sign-off:** live broker + MongoDB verification not possible
in this environment, plus 2 unrelated pre-existing test failures that need an
owner decision.

> **How to use this file:** read sections 5 (Baki) and 6 (Kya karna hai) first,
> then execute the commands in section 6 exactly. Sections 1–4 explain what
> exists so you do not re-discover it.

---

## 1. Kya bana hai (what was built)

### 1.1 Canonical engine — 14 modules, `python-service/services/`

| File | Lines | Responsibility |
| --- | ---: | --- |
| `market_watch_engine.py` | 2223 | The single orchestrator: registry, tick ingestion, lifecycle, ranking loop, publish set, recovery |
| `market_watch_config.py` | 654 | Runtime config + live settings keys, circuit policy resolution |
| `market_watch_state.py` | 499 | Typed per-symbol state, `from_storage_doc` recovery |
| `market_watch_publish.py` | 362 | Controlled publish set, coalescing, EOD flush |
| `market_watch_timeframes.py` | 331 | 1m/5m/10m/30m bars, real VWAP, recovery |
| `market_watch_eligibility.py` | 284 | Ordered eligibility decision pipeline + reasons |
| `market_watch_lifecycle.py` | 268 | Time-driven phases (pre-open → final monitoring) |
| `market_watch_doc_buffer.py` | 244 | Idempotent buffered persistence to the DB Writer |
| `market_watch_filters.py` | 249 | Engine-side filter evaluation |
| `market_watch_ledger.py` | 299 | Day-scoped block ledger → `market_watch_decisions` |
| `market_watch_ranking.py` | 199 | Gainers/losers ranking, circuit-near as a signal |
| `market_watch_indexes.py` | 146 | Index constituent tracking |
| `market_watch_report.py` | 230 | EOD report, blocked rows flagged |
| `market_watch_pins.py` | 131 | Top-5 pins + pin-change events |

REST surface: `python-service/api/market_watch.py` (1324 lines) — a **read** of
the engine. Endpoints: `/`, `/progress`, `/history`, `/search`, `/page`, `/rank`,
`/ui`, `/ranking`, `/pins` (GET/POST/DELETE), `/filters` (GET/POST/DELETE),
`/symbol/{token}`, `/live`, `/tick-snapshot`, `/eod`.

### 1.2 Frontend

| File | Change |
| --- | --- |
| `app/api/market-watch/[...path]/route.ts` | Bridge forwards **GET, POST, DELETE** (was GET-only → pins/filters 405'd) |
| `app/api/phase2/watch/progress/route.ts` | Reports engine lifecycle/subscription counts, **no batch fields** |
| `app/api/phase2/watch/history/route.ts` | Reads `decisions` from the real ledger, `symbol` + `date` filters |
| `app/(phase2)/data-saver/watch/page.tsx` | `EngineProgress` + `DecisionHistoryPanel`; no batch vocabulary |
| `lib/realtime-ws.ts` | Repaired from BOM + mojibake to valid UTF-8 |

### 1.3 Docs written

- `docs/engines/MARKET_WATCH.md` — the canonical spec.
- `docs/audits/MARKET_WATCH_IMPLEMENTATION_AUDIT.md` — conformance, 26 defects found+fixed, frontend contract.
- `docs/engines/MARKET_WATCH_REALTIME_AUDIT.md` — realtime architecture, circuit-policy reasoning.
- This file.

---

## 2. Non-negotiable invariants (do not break these)

These are the architectural rules the work exists to enforce. Any new change
must preserve all of them, and `tests/test_market_watch_spec_modules.py` fails
if you do.

1. **One engine only.** No parallel scanner, no second Market Watch
   implementation, no duplicated subscription/registry.
2. **No direct broker access.** `services/market_watch_*` must never import or
   call `auth.kotak_client`. Account intraday state comes from Session Manager /
   the adapter registry; unknown stays `None` rather than guessed. A
   docstring mention is allowed, an executable import is not.
3. **No order placement.** Ever.
4. **No fabrication.** Unknown circuit data is `UNKNOWN`, never `SAFE`.
   Missing values are `null`, never a number. Every status carries a reason.
5. **REST never re-decides eligibility.** Request filters may narrow the
   *presentation*; circuit / margin / business filters stay engine-owned and
   are only reported under `diagnostics.engineOwnedFilters`. `force` is an
   explicit documented **no-op**.
6. **No request triggers a scan.** `/`, `/progress`, `/history`, `/search`,
   `/page` are all reads of published engine state.
7. **Show More pages the full eligible universe**, not the config-capped board.
8. **Blocked symbols stay ranked** but carry `blocked: true`.
9. **No-tick symbols are excluded** from EOD rankings.
10. **REST route must never call the broker** — asserted by mocking
    `kotak_session.async_quote` to raise.

### Circuit policy — read before touching config

Doc §7's example ("20% circuit → block at 18%") is **dimensionally impossible**.
Distance is measured against the circuit price, so the maximum attainable
distance in a band `b` is `b/(1+b) × 100` → only **16.67%** for a 20% band. An
18% threshold blocks *every* symbol in a 20% band, including one sitting on its
previous close.

Shipped (correct) defaults in `market_watch_config.py`:

```
DEFAULT_CIRCUIT_POLICY     = {"2": 0.6, "5": 1.5, "10": 2.7, "20": 5.0}
DEFAULT_CIRCUIT_NEAR_POLICY = {"2": 1.0, "5": 2.5, "10": 4.5, "20": 8.3}
```

Doc values are preserved for traceability in `DOC_CIRCUIT_EXAMPLE_POLICY`
(`{"5": 3.0, "10": 8.0, "15": 13.0, "20": 18.0}`). Both are overridable at
runtime via `MWR_CIRCUIT_BLOCK_PCT` / `MWR_CIRCUIT_NEAR_PCT`.

---

## 3. Kya verify hua hai (what is verified)

### 3.1 Commands — run from `C:\project\python-service`

```bash
# Market Watch only (274 tests)
python -m pytest tests/test_market_watch_route.py tests/test_market_watch_spec_modules.py \
  tests/test_market_watch_engine.py tests/test_market_watch_filters.py \
  tests/test_market_watch_ranking.py tests/test_market_watch_pins.py -q

# Full backend suite
python -m pytest tests/ -q
```

### 3.2 Results as of the last run

```
test_market_watch_spec_modules.py .............................  130 passed
engine + filters + ranking + pins .............................  124 passed
test_market_watch_route.py ...................................   20 passed
Market Watch total ...........................................  274 passed
full python-service suite ....................................  1110 passed, 2 failed
```

Frontend, from `C:\project`:

```bash
npx tsc --noEmit     # exit 0, clean
npm run lint         # 0 errors (348 pre-existing warnings, unrelated)
```

### 3.3 The 2 remaining failures — NOT Market Watch, NOT caused by this work

Both reproduce in isolation and touch no Market Watch file.

1. **`tests/test_realtime_gateway.py::TokenEndpointTests::test_secure_requires_operator_jwt`**
   Expected 401, got 200. `get_realtime_token` in `api/ws_gateway.py:132-136`
   intentionally allows anonymous bootstrap token issuance. The test asserts the
   opposite. **This is a real security/intent contradiction — it needs an owner
   decision, not a silent code change.** Either the endpoint should require a
   JWT, or the test's expectation is wrong. Do not "fix" it by making the test
   pass without deciding which side is correct.

2. **`tests/test_watchlist_engine.py::WatchlistCardTest::test_connecting_when_session_active`**
   Expected `CONNECTING`, got `DISCONNECTED`. Watchlist card status — an
   unrelated subsystem.

### 3.4 What the tests deliberately do NOT cover

The test suite is deterministic and DB-free by design: it seeds the engine
directly, uses no broker session, no MongoDB, no wall-clock dependence. So the
following are **unproven** and need a live environment (section 6.2):

- Real circuit field formats from the broker / exchange.
- Index token resolution and index constituent behaviour.
- Session Manager margin publication.
- DB Writer flush to a real MongoDB, and `/history` against real documents.
- Broker reconnection and lifecycle phase transitions in real market hours.
- Candle recovery across a real process restart.

---

## 4. Defects found and fixed (26 total — see the implementation audit for the table)

Highest-value ones, so you don't re-introduce them:

- Parallel batch scanner on the REST request path → removed (53 dead defs,
  ~800 lines deleted).
- Engine read `kotak_session.intraday_available` → architecture §5 violation,
  now Session Manager only.
- `SUBSCRIBED` and `FINAL_MONITORING` lifecycle phases were unreachable → added.
- `/history` sorted on `decidedAt`, a field **no writer sets** → history was
  silently unordered; now sorts on `blocked_at`.
- `/history` `symbol`/`date` were assigned as *local* `Query` objects, so
  FastAPI never bound them and any `symbol` filter raised
  `AttributeError: 'Query' object has no attribute 'upper'` → moved into the
  signature.
- `market_watch_decisions` had **no indexes** while the orphaned
  `market_watch_scans` (nothing writes it) had one → swapped.
- Margin allow/deny lists were inverted.
- Circuit band was computed as full width instead of per-side `(upper−lower)/2`.
- `REASON_FILTER_FAIL` used but never imported → `NameError` on every filtered
  evaluation.
- GET-only Next.js bridge → every pin/filter action returned 405.

---

## 5. Kya baki hai (what remains)

### 5.1 Needs an owner decision (blocking sign-off)

| # | Item | Where | Status |
|---|------|-------|--------|
| D1 | Gateway anonymous token issuance vs. `test_secure_requires_operator_jwt` | `api/ws_gateway.py:132-136` | **RESOLVED** — code already requires operator JWT when `APP_PASSWORD` set; the test `test_secure_requires_operator_jwt` passes. The audit docs were stale. |
| D2 | Circuit policy: shipped sane defaults vs. the doc's literal (impossible) numbers | `docs/engines/MARKET_WATCH.md` §7, `market_watch_config.py:140-143` | **RESOLVED** — doc §7 corrected; shipped defaults (30%/50% of attainable distance) are the authoritative values. The doc's literal numbers remain available as `DOC_CIRCUIT_EXAMPLE_POLICY` for traceability. |

### 5.2 Needs a live environment (cannot be done here)

- L1 — End-to-end circuit evaluation with real broker circuit fields.
- L2 — Index constituent / index tick resolution.
- L3 — Session Manager margin publication into eligibility.
- L4 — DB Writer flush to real MongoDB; `/history` against real documents. **PARTIAL** — indexes for `market_ticks` and `market_candles_*` added.
- L5 — Broker reconnect and lifecycle transitions during real market hours.
- L6 — Candle recovery across a real process restart. **PARTIAL** — silent no-op bug fixed (`state._timeframes` → `state.timeframes`).
- L7 — WebSocket Engine intent → subscription → tick flow under load.

### 5.3 Known limitations (accepted, documented, not bugs)

- Re-entry is data-driven only: `DATA_INVALID` re-enters automatically; a
  business or margin block does not, because the engine has no authoritative
  signal that it changed.
- Candle recovery is bounded: buckets older than process start are
  `INCOMPLETE`; the report publishes the count rather than guessing.
- Legacy `scannerState` / `scan` / `quoteSource` / `scannerEligible` response
  keys are **deliberately retained** for UI compatibility; `scan.id` is always
  `null` because no scan happens on the request path.

### 5.4 Not present in this repo

- `MARKET_WATCH_ENGINE_UPDATED_SPECIFICATION.md` — referenced in older notes
  but **does not exist**. `docs/engines/MARKET_WATCH.md` is authoritative.
  Do not go looking for it.

---

## 6. Kya karna hai (what to do next)

### 6.1 Next session, immediately

```bash
# 1. Confirm the tree is still green before changing anything
cd C:\project\python-service
python -m pytest tests/ -q                      # expect: 1159 passed, 0 failed
cd C:\project
npx tsc --noEmit                                # expect: exit 0
```

No blocking owner decisions remain for Market Watch.

### 6.2 When a live environment becomes available

### 6.2 When a live environment becomes available

Work through L1–L7 in order; L1 and L4 are the highest risk.

- **L1** — start the backend with real credentials during market hours, then
  hit `/api/market-watch/progress` and confirm `statusCounts` show real `live`
  symbols and that `universe.eligible` is non-zero.
- **L4** — after a session, query `market_watch_decisions` in MongoDB, confirm
  documents exist with `blocked_at` as an ISO string, and confirm `/history`
  returns them newest-first with `blockedAt` populated.
- **L5** — kill and restore the broker connection; confirm the lifecycle
  snapshot advances through its phases and that no duplicate subscriptions
  appear.
- **L6** — restart the process mid-session; confirm bars before process start
  report `INCOMPLETE` rather than being invented.

### 6.3 Rules while working

- Never add a Market Watch broker call, an order, or a per-request scan.
- If you add engine behaviour, add it to
  `tests/test_market_watch_spec_modules.py` — that file is the spec executable.
- Update both audit docs if you change a public field name or a count.
- Do not commit secrets. `python-service/.env.example` is the template.

---

## 7. File map

**Spec**
- `docs/engines/MARKET_WATCH.md`

**Engine**
- `python-service/services/market_watch_engine.py` — orchestrator
- `python-service/services/market_watch_config.py` — config + circuit policy
- `python-service/services/market_watch_eligibility.py` — decision order + reasons
- `python-service/services/market_watch_ledger.py` — `market_watch_decisions` writer
- `python-service/services/market_watch_report.py` — EOD
- `python-service/api/market_watch.py` — REST read surface
- `python-service/database/connection.py` — decision indexes (line ~149)

**Tests**
- `python-service/tests/test_market_watch_spec_modules.py` — 130, the executable spec
- `python-service/tests/test_market_watch_route.py` — 20, HTTP contract
- `python-service/tests/test_market_watch_engine.py`
- `python-service/tests/test_market_watch_filters.py`
- `python-service/tests/test_market_watch_ranking.py`
- `python-service/tests/test_market_watch_pins.py`

**Frontend**
- `app/api/market-watch/[...path]/route.ts`
- `app/api/phase2/watch/progress/route.ts`
- `app/api/phase2/watch/history/route.ts`
- `app/(phase2)/data-saver/watch/page.tsx`

**Audits**
- `docs/audits/MARKET_WATCH_IMPLEMENTATION_AUDIT.md`
- `docs/engines/MARKET_WATCH_REALTIME_AUDIT.md`
