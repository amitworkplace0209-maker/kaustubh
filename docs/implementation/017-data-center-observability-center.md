# 017 — Data Center as a Real, Source-Attributed Observability Center

- **Task:** Upgrade the existing `/data-saver/data-center` page in place so it
  answers real operational questions — which MongoDB, which engines, who owns
  which collection, what the dependency graph is, is the tick pipeline healthy,
  what is the retention contract — with every number carrying its source, and
  every unknown stated as an unknown.
- **Status:** `VERIFIED_WITH_LIMITATIONS` (automated suites pass; no live
  MongoDB / backend / browser run — see
  `docs/verification/017-data-center-observability-center-verification.md`)
- **Audits:** `docs/audits/backend/DATA_CENTER_OBSERVABILITY_PLANES_AUDIT.md`,
  `docs/audits/frontend/DATA_CENTER_PLANES_UI_AUDIT.md`
- **Date:** 2026-09-28
- **Serial predecessor:** `016-db-writer-single-tick-persistence-authority`

---

## 1. Target invariant

```
EVERY NUMBER ON THE DATA CENTER PAGE
    -> HAS A SOURCE (a module path, shown in the panel footer)
EVERY MISSING MEASUREMENT
    -> RENDERS AS N/A / UNKNOWN / NOT AVAILABLE / NOT CONFIGURED / NOT VERIFIED
    -> NEVER AS 0, NEVER AS AN EMPTY LIST, NEVER AS A GUESSED OWNER
EVERY PLANE
    -> READ-ONLY, INDEPENDENT TTL, FAILURE ISOLATED
```

Supporting invariants:

- The Data Center never writes to MongoDB and never changes tick-persistence
  authority. `ticks` is attributed to **DB Writer Engine**.
- No URI, credential, Atlas key, broker credential, JWT, or token is ever
  emitted by a plane.
- One canonical page. No desktop/mobile variant, no alias route, no second PWA.

---

## 2. Backend

### 2.1 New module — `python-service/services/data_center_planes.py` (new, 838 lines)

Six plane builders, each returning the same envelope:

| Plane | What it answers | Primary source |
| --- | --- | --- |
| `database_plane()` | which MongoDB, what server facts, what storage totals | `get_mongo_info()`, `api.system.mongo_stats()`, `serverStatus` allow-list |
| `engines_plane()` | which engines exist, state, health, dependencies | Engine Registry |
| `topology_plane()` | the real dependency graph (nodes, edges, orphans) | Engine Registry `dependency_graph()` |
| `db_writer_plane()` | tick pipeline counters, permissions, data-loss accounting, storage caps | `DBWriterEngine.status_snapshot()` |
| `ownership_plane()` | which collection belongs to which engine | `mongo_stats()` ⨝ static owner map |
| `retention_plane(limit)` | real TTL indexes, the 06:00 IST cleanup contract, snapshot retention | `coll.index_information()`, `atlas_cleanup`, `recent_snapshots()` |

Design decisions worth stating:

- **`mongo_stats()` is reused, not re-implemented.** The database plane has its
  own 10s TTL but performs no second `collStats` sweep, so adding the plane did
  not double the MongoDB load of the page.
- **`serverStatus` is allow-listed**, not copied. A restricted Atlas tier yields
  `available: false` with the real reason, while the rest of the database plane
  still renders.
- **Engines are read from the Registry**, never from a hard-coded list, and an
  undocumented registry engine is surfaced as `UNMAPPED` rather than dropped.
- **Topology edges are read from `dependency_graph()`**, not authored in the UI.
- **DB Writer counters are republished, never recomputed.** The page does not
  build a second opinion about tick persistence.
- **The ownership map is static and explicitly labelled as such.** It carries a
  `basis` per row so it can be re-derived or corrected individually.

### 2.2 New routes — `python-service/api/data_center.py`

```
GET /api/system/data-center/database
GET /api/system/data-center/engines
GET /api/system/data-center/topology
GET /api/system/data-center/db-writer
GET /api/system/data-center/ownership
GET /api/system/data-center/retention?limit=<1..2000>
```

Each plane gets its own cache key, TTL (10s live / 30s slow), and single-flight
entry. A raising builder is logged and returned as
`503 {"ok": false, "error": ...}`. The pre-existing POST actions
(`capture` / `deep-scan` / `cleanup`) and the existing overview/history/ticks/
trend/snapshots/api-telemetry routes were not moved or duplicated.

---

## 3. Frontend

### 3.1 `app/api/phase2/data-center/route.ts`

The six planes were added as independent entries in the existing consolidated
proxy. Each has its own `timeoutMs` and its own `{ ok, data | error }` result, so
a plane that fails cannot blank the sections that are working.

### 3.2 `lib/data-center.ts`

- `DC_WIRE_SECTIONS` / `DcWireSection` / `dcWireSection()` — **one** typed source
  of truth for the wire names the proxy accepts.
- Six `Dc*Plane` interfaces and six `normalize*Plane()` functions written to the
  honesty rules in §1 (a `null` measurement stays `null`).
- `DcDbWriterPlane.authoritative: boolean` so the page can state that DB Writer
  is the single writer.

### 3.3 `lib/data-center-store.ts`

- Six new state slots, each with its own `error` string, merged **in place** —
  a failed refresh never blanks a working panel.
- `LIVE_PLANES` polled every 15s, `SLOW_PLANES` every 60s, on top of the
  pre-existing 15s overview and 60s history polls.
- All four section lists are now derived from, or `satisfies`,
  `DC_WIRE_SECTIONS`.

### 3.4 `components/data-center/dc-planes.tsx` (new, 994 lines) + the page

Six panels, each showing its plane's `source`, its honest unavailable reason,
and its refresh cadence. The page header status prefers the live `database`
plane identity. Responsive rules: per-table horizontal scroll, collapsing
grids, `overflow-x-clip`, and top/bottom safe-area padding.

---

## 4. Bugs found and fixed by the tests written for this change

The tests were written to assert the §1 invariants, and six real defects fell
out of them:

| # | Where | Defect | Consequence if shipped |
| --- | --- | --- | --- |
| F1 | store | `'dbwriter'` vs the proxy's `'dbWriter'` | the 15s live poll silently stopped fetching DB Writer; the panel froze at its first value with no error |
| F2 | store | three untyped duplicate name lists in two naming conventions | the above typo class was invisible to both the compiler and the console |
| F3 | store | `fetchRaw`/`urlFor` erased the section type | last type-safety net removed |
| F4 | `lib/data-center.ts` | absent section reported as `ok: false` | a targeted poll would raise phantom "unavailable" badges |
| F5 | `lib/data-center.ts` | no `authoritative` field | the page could not state single-writer authority |
| B1 | backend | `serverStatus` failure rendered as `available: true` | a restricted Atlas tier would look healthy-but-empty instead of unavailable |
| B2 | backend | TTL index key read as a dict | the field rendered as `("expiry", 1)` instead of `expiry` |
| B3 | backend | failed `mongo_stats` returned `collections: []` | "could not measure" would render as "this database is empty" |
| B4 | backend | plane cache key omitted `limit` | `retention?limit=50` replayed the `limit=400` response |
| B5 | backend | `_cache_key(name, **parts)` param collision | `TypeError` on the corrected retention key |

Full detail, including the fix for each, is in the two audit documents.

---

## 5. Verification summary

| Suite | Result |
| --- | --- |
| `python -m pytest tests` | **1248 passed**, 12 subtests passed |
| `npx node --test tests/data-center-planes.test.ts` | **13 passed** |
| `npm test` | **286 passed / 1 failed** (pre-existing, `topbar-status.test.ts:331`, unrelated) |
| `npm run typecheck` | clean |
| `npm run build` | compiled, TypeScript clean, one `/data-saver/data-center` route |
| `eslint` on changed files | clean |
| Live MongoDB / backend / browser | **not run** |

New tests:

- `python-service/tests/test_data_center_planes.py` (16 tests) — plane contracts,
  the no-secret guarantee, registry failures, `UNMAPPED` handling, TTL index
  shapes, and map completeness.
- `python-service/tests/test_data_center_planes_routes.py` (5 tests / 12
  subtests) — real FastAPI router: every path wired, unknown path is a 404,
  `limit` honoured, a raising builder is a 503, and no response contains a
  URI/secret.
- additions to `python-service/tests/test_data_center.py` (3 tests) — plane
  cache-key isolation and clamping.
- `tests/data-center-planes.test.ts` (13 tests) — normalizer honesty, envelope
  isolation, and the wire-name ⇄ proxy contract in both directions.

---

## 6. Honest limitations

1. **No live MongoDB, no running backend, no browser.** Every behavioural claim
   about the real deployment is inferred from the code and from fakes. This is
   why the status is `VERIFIED_WITH_LIMITATIONS` and not `COMPLETE`.
2. **The ownership map is unratified** and is not regenerated from code at
   runtime. It is a static, per-row-attributed audit artifact.
3. **No responsive QA was performed.** The required widths (375 / 390 / 430 /
   768 / 1024 / 1280 / 1440 / 1920) have not been observed in a browser.
4. **Pre-existing mojibake** in `TICK_PERSISTENCE_LABELS` is republished
   verbatim by the DB Writer plane and is visibly wrong. Left alone as it is a
   change to a different module.
5. **One pre-existing test failure** in `tests/topbar-status.test.ts` is not
   caused by this work and was not fixed by it.
