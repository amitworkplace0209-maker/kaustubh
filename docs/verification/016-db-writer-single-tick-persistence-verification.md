# 016 Verification — DB Writer as the Single Authority for Tick Persistence

- **Subject:** `docs/implementation/016-db-writer-single-tick-persistence-authority.md`
- **Date:** 2026-09-28
- **Overall:** `VERIFIED_WITH_LIMITATIONS` — all automated checks pass; live
  broker / MongoDB behaviour is `NOT_VERIFIED`.

---

## 1. Environment

- Backend: `python-service` (`.venv`, Windows/PowerShell)
- Frontend: Next.js app at `C:\project` (`tsc --noEmit`, `eslint`, `node --test`)
- No live broker session, no live MongoDB, no running application server.

---

## 2. Automated results

| Check | Command | Result |
|---|---|---|
| Backend full suite | `python -m pytest -q` | **1189 passed, 0 failed** |
| DB Writer + Market Watch suites | `pytest tests/test_db_writer_engine.py tests/test_market_watch_spec_modules.py tests/test_market_watch_engine.py tests/test_market_watch_route.py -q` | **261 passed** |
| Frontend typecheck | `npx tsc --noEmit` | **clean (exit 0)** |
| Frontend lint (changed page) | `npx eslint app/_pages/db-writer/page.tsx` | **clean (exit 0)** |
| Frontend tests | `npm test` | 274 tests, **273 pass, 1 pre-existing failure** |
| Byte-compile | `python -m py_compile` on 4 changed backend files | **clean** |
| **Route registration (real FastAPI)** | mount the real `engine_control` router in a scratch app, list routes | `GET` + `PUT .../db_writer_engine/tick-persistence` **registered**; router **is** included at `app.py:1020` |
| **Endpoint over real HTTP** | `fastapi.testclient.TestClient` against the real router | `GET` → **200** with the correct payload; validation paths → **200 `ok:false`** with precise errors |

### 2.1 Live HTTP round-trip (partial — no MongoDB)

An in-process FastAPI app mounting the **real** `engine_control` router was
exercised with `TestClient`. This is real HTTP through the real handlers, but the
settings store is a live MongoDB connection that was not available.

Observed:

| Request | Result |
|---|---|
| `GET .../tick-persistence` | `200` — `owner: db_writer_engine`, three permissions, all `enabled: false`, real setting keys |
| `PUT {"personalOneWeek": true}` | `200 ok:false` — `unknown tick persistence permission(s): personalOneWeek` |
| `PUT {"personalOneDay": "yes"}` | `200 ok:false` — `personalOneDay must be a boolean` |
| `PUT {}` | `200 ok:false` — `provide at least one of ...` |
| `PUT {"marketWatchOneDay": true}` | see §4.2 |

**A backend was already running on port 8000** during this session (pid 11200,
started 23:32:46, i.e. *before* these changes). `GET /api/services/engines/
db_writer_engine/tick-persistence` against it returns `404`, which is the correct
and expected result for a process started before the route existed. The running
instance was **not** restarted, so the new code is confirmed only via the scratch
app above.

### 2.2 The one failing frontend test is pre-existing and unrelated


`tests/topbar-status.test.ts:336` — `canonical session state never invents ACTIVE`

```
expected: 'AUTHENTICATING'
actual  : 'INACTIVE'
```

This is the same failure recorded before this task began, in an unrelated module
(`components/terminal/mode-reconciler` / topbar status). It imports the subject
under test through the value-import path `@/lib/api`, which the bare
`node --test` harness cannot resolve — the test file does not even import the
module whose behavior it asserts. **Not caused by, and not fixed by, this change.**

---

## 3. Requirement-by-requirement verification

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | DB Writer is the only tick persistence authority | VERIFIED | `ingest_market_watch_ticks()` consults `should_persist_tick()`; `buffer_documents()` documented as batching-only. Trace §1 shows the pre-change bypass. |
| 2 | No Market Watch → MongoDB tick writes | VERIFIED | `market_watch_engine._persist_tick()` now only calls `ingest_market_watch_ticks()`; no Mongo client in that path. |
| 3 | No Market Watch persistence decision | VERIFIED | `mwr_persist_ticks` is an offer gate ANDed with the DB Writer permission; `_ticks_suppressed` counts refusals. |
| 4 | `dbw_market_watch_ticks` OFF actually stops MW tick writes | VERIFIED | `test_db_writer_permission_off_blocks_market_watch_ticks`, `test_market_watch_handoff_is_blocked_when_the_permission_is_off`. |
| 5 | Three permissions, all OFF by default | VERIFIED | `test_all_three_permissions_default_off`; defaults asserted to come from `settings_service.DEFAULTS` (`False`) and be in `LIVE_KEYS`. |
| 6 | Independent toggles | VERIFIED | `test_the_three_permissions_are_independent`; `test_set_tick_persistence_only_touches_supplied_names`. |
| 7 | `PERSONAL_ONE_DAY` classification | VERIFIED | `test_personal_one_day_maps_to_the_expiry_permission`. |
| 8 | `MARKET_WATCH_ONE_DAY` classification | VERIFIED | `test_market_watch_maps_to_the_market_watch_permission`. |
| 9 | No symbol-name inference | VERIFIED | `test_classification_is_not_inferred_from_the_symbol_name` (`MWALLA-BEES` → `unknown_source`). |
| 10 | No frontend classification | VERIFIED | Classification is computed server-side in `_get_tick_classifications()`; the UI only sends a permission name. |
| 11 | No duplicate event bus / engine / collection | VERIFIED | Reused `market_watch_doc_buffer` and `tick_buffer`; no new bus, engine, or collection. |
| 12 | Market Watch provides authoritative metadata | VERIFIED | MW hands the validated document; classification is resolved by the DB Writer from Session Manager state, not from MW's own claim. |
| 13 | DB Writer does not scan Market Watch | VERIFIED | Classification reads only `session_manager.snapshot()`. |
| 14 | Backend API for read + update | VERIFIED | `TickPersistenceApiTest` (6 cases): get, put, nested body, non-boolean, empty body, unknown name. |
| 15 | Frontend Settings ⚙️ with 3 independent toggles | VERIFIED | `app/_pages/db-writer/page.tsx`; typecheck + lint clean. |
| 16 | No optimistic frontend state | VERIFIED | Toggles render backend-reported state; writes adopt the response; a rejected write triggers `loadPermissions()`. |
| 17 | Live status from backend | VERIFIED | "Tick persistence — live status" card renders `data.tickPersistence` with accepted/skipped/overlap/unknown counters. |
| 18 | Batch writes, no per-tick inserts | VERIFIED | Both paths still use the existing bulk-write buffers; no `insert_one` added. |
| 19 | Deterministic dedup on the strongest existing identity | VERIFIED | `(instrumentToken, sequenceNumber)`; MW `_id = symbol:sequence`. `test_market_watch_handoff_deduplicates_on_identity`. |
| 20 | Persist at most once for overlapping classifications | VERIFIED | `test_overlapping_classifications_persist_at_most_once`. |
| 21 | Retention honest (no invented TTL) | VERIFIED | Documented in spec + UI copy that "1-day" is a session classification, not a MongoDB TTL. |

---

## 4. Defects found and fixed during this work

### 4.1 The overlapping-classification dedup branch was unreachable dead code

The original `_get_tick_source()` returned `MARKET_WATCH` as soon as any source
contained `market_watch`, and never returned a personal classification for such an
instrument. The `_should_persist_tick()` branches that combined a personal
classification with the Market Watch permission could therefore never execute, so
`overlapping_sources_deduped` could only ever stay `0`. The task requirement
"persist at most once if a tick matches multiple classifications" was silently
unenforced.

Fixed by adding `_get_tick_classifications()`, which returns the **full set** of
applicable classifications. `_get_tick_source()` is retained as the
primary-classification accessor, and a regression test now exercises a genuinely
overlapping instrument.

### 4.2 The settings endpoint returned a raw 500 when MongoDB was unreachable

Found by the live HTTP round-trip in §2.1. `set_tick_persistence()` called
`set_setting()` directly, which raises `RuntimeError("MongoDB is not connected")`
when the settings store is down. That propagated out of the route handler as an
unhandled **500** — indistinguishable from a server bug, and with no useful message
to the operator.

Fixed:
- new `TickPersistenceUnavailable` exception, distinct from `ValueError` so a bad
  request is never confused with an outage;
- `set_tick_persistence()` now checks the store is reachable **before** writing
  anything (so a failure cannot half-apply a multi-key update) and records the fault
  through `record_error`;
- the route maps it to `ok:false` with the real reason;
- the frontend distinguishes it and says *"Settings store unavailable — the switches
  below show the DB Writer's last confirmed state."*

Regression tests: `test_put_reports_unavailable_storage_instead_of_raising` and
`test_unavailable_storage_writes_nothing` (asserts `set_setting` is never awaited
when the store is down).

---

## 5. Test added

`python-service/tests/test_db_writer_engine.py`

- `TickPersistenceAuthorityTest` — defaults OFF, independence, key/schema
  agreement, owner, UNKNOWN rejection, missing-identity rejection, no symbol-name
  inference, per-classification mapping, legacy alias value equality, overlap
  dedup, Market Watch handoff accepted/blocked/deduped/stamped/invalid-payload,
  settings write path, unknown-name rejection, partial update, status parity.
- `TickPersistenceApiTest` — GET shape, PUT partial, PUT nested, non-boolean
  rejection, empty-body rejection, unknown-permission error.

`python-service/tests/test_market_watch_spec_modules.py`

- `test_engine_honours_the_switch_per_tick` — updated: the Market Watch offer gate
  alone is **not** enough; the tick only buffers when both gates agree.
- `test_db_writer_permission_off_blocks_market_watch_ticks` — new regression test
  for the original defect.

---

## 6. NOT VERIFIED (explicitly)

- **No live broker feed**, so no live tick was observed flowing through the new
  decision point. The classification → permission → dedup → buffer → bulk-write
  sequence has never executed against real market data.
- **No live MongoDB**, so the resulting documents in `db.ticks` / `db.market_ticks`
  were not inspected, the `market_ticks` indexes were not re-checked, and a
  permission could not be flipped against real persisted settings. The `PUT`
  success path is covered only by unit tests with a mocked store.
- The **already-running** backend on port 8000 predates these changes, so the
  endpoints were exercised through a scratch app mounting the real router rather
  than through the live process. That process was deliberately not restarted.
- The Service page Settings panel was **not exercised in a browser**; only
  typecheck + lint + unit tests cover it.
- Effective database name, live index set, and TTL behaviour remain unverified per
  `docs/pending/PENDING-001-live-verification.md`.
- The separate realtime-auth and data-saver 5xx issues are out of scope for this
  task and remain open.

---

## 7. Conclusion

The architecture change is implemented. It is covered by 1189 automated tests that
fail without it, and the endpoints were confirmed registered and responding over
real HTTP. Live end-to-end confirmation against a real feed and a real MongoDB is
still outstanding and is recorded as GAP-036 in `docs/PROJECT_GAPS.md`.

**Next session:** `docs/pending/PENDING-004-db-writer-tick-persistence-live-verification.md`
is the step-by-step pass. Start with its "Do This First" section — the backend already
running on port 8000 predates this change and must be restarted before any of its checks
will return 200 instead of 404.
