# 016 — DB Writer as the Single Authority for Tick Persistence

- **Task:** Make the DB Write Engine the only authority allowed to decide whether a
  live tick is persisted to MongoDB, with exactly three independent ON/OFF
  permissions, plus backend API, Service-page Settings UI, tests and docs.
- **Status:** IMPLEMENTED_NOT_VERIFIED (static + automated tests only; no live
  broker / MongoDB run — see `docs/verification/016-db-writer-single-tick-persistence-verification.md`)
- **Pre-implementation trace:** `docs/opencode/002-tick-persistence-ownership-trace.md`
- **Date:** 2026-09-28

---

## 1. Target invariant

```
MARKET WATCH / PERSONAL SUBSCRIPTIONS
    -> TICK EVENT
    -> DB WRITE ENGINE
    -> PERMISSION CHECK
    -> BUFFER
    -> BATCH WRITE
    -> MONGODB
```

The DB Write Engine is the single authority for tick persistence. Market Watch
receives, validates and publishes; it never decides persistence and never writes
ticks to MongoDB.

---

## 2. What the trace found (the reason for this change)

Before the change, `mwr_persist_ticks` (a **Market Watch** switch, default
`True`) was the only gate on the Market Watch tick path.
`db_writer_engine.buffer_documents("market_ticks", ...)` never consulted
`_should_persist_tick()`, so:

- `dbw_market_watch_ticks` (the DB Writer permission, default OFF) had **no
  effect** on Market Watch tick writes;
- Market Watch ticks **were** persisted by default;
- turning the DB Writer's Market Watch permission OFF did **not** stop the writes.

That made Market Watch a co-owner of tick persistence, which is exactly what the
invariant forbids. Details and the full write-site inventory are in the trace
document.

---

## 3. Changes made

### 3.1 `python-service/services/db_writer_engine.py`

- **Canonical classification names.** `TickSource` now exposes
  `PERSONAL_NO_EXPIRY`, `PERSONAL_ONE_DAY`, `MARKET_WATCH_ONE_DAY`, `UNKNOWN`.
  The previous `PERSONAL_EXPIRY` / `MARKET_WATCH` names are kept as **aliases
  with the same string value**, so existing callers, stored documents and tests
  keep working. No second classification system was introduced.
- **Single permission registry.** `TICK_PERSISTENCE_PERMISSIONS` maps the three
  permission names to the pre-existing settings keys, and
  `TICK_PERSISTENCE_LABELS` carries the UI labels. Both the API surface and
  `status_snapshot()` read from this one registry, so they cannot drift.
- **`_get_tick_classifications()` (new).** Returns **every** applicable
  classification, not just the first. The old `_get_tick_source()` short-circuited
  on `market_watch`, which made the overlapping-source dedup branch
  **unreachable dead code**. An instrument that is both personally subscribed and
  in the Market Watch universe now genuinely matches both classifications, and the
  "persist at most once" rule is enforceable. `_get_tick_source()` remains as the
  primary-classification accessor.
- **`should_persist_tick()` (new, public, side-effect free).** The authority
  decision, usable by any caller without buffering or touching metrics. Returns
  `classification`, `classifications`, `permission`, `settingKey`, `enabled`,
  `overlapping` and a `reason` (`permission_granted` / `permission_disabled` /
  `unknown_source`).
- **`ingest_market_watch_ticks()` (new).** The Market Watch handoff entry point.
  It asks `should_persist_tick()`, dedupes on `(instrumentToken, sequenceNumber)`,
  stamps `_tick_source`, and only then buffers. Documents still travel through the
  existing `market_ticks` append-only buffer, so batching, backpressure, retry and
  the deterministic `_id` are unchanged.
- **`buffer_documents()` is now explicitly batching-only** and documented as
  never deciding persistence. Non-tick Market Watch documents (candles, decisions,
  daily report) still use it; only the tick path moved to the authority.
- **`tick_persistence_settings()` / `set_tick_persistence()` (new).** The
  authoritative read and the write path through the existing
  `settings_service` + `runtime_settings` system. Writes refresh the runtime
  cache immediately so the next tick observes the change; an unknown permission
  name raises `ValueError` so the API can answer 400 instead of ignoring a typo.
- **`status_snapshot()["tickPersistence"]`** now returns the same
  `tick_persistence_settings()` structure (canonical names, `owner`,
  `overlappingSourcesDeduped`, `unknownSourceSkipped`).

### 3.2 `python-service/services/market_watch_engine.py`

- `_persist_tick()` now calls `db_writer_engine.ingest_market_watch_ticks([doc])`
  instead of `buffer_documents(...)`. Market Watch hands off; the DB Writer
  decides. When the DB Writer's permission is OFF the tick is counted in
  `_ticks_suppressed` rather than `_persisted_ticks`, so the two counters can
  never disagree with the authoritative decision.
- `mwr_persist_ticks` is **demoted, not deleted** (rule §37). It is now only the
  *offer* gate ("should Market Watch offer this tick upstream?"), ANDed with the
  DB Writer permission. The setting description was updated to say so.
- `reconcile_storage_switches()` now also reports `dbWriterPermission` so no
  reader can mistake the Market Watch switch for authority.

### 3.3 `python-service/api/engine_control.py`

- `GET /api/services/engines/db_writer_engine/tick-persistence` — the three
  permissions, labels, setting keys, accepted/skipped counters.
- `PUT /api/services/engines/db_writer_engine/tick-persistence` — body
  `{"personalNoExpiry": true, ...}` (or `{"permissions": {...}}`). Only supplied
  names change; non-boolean values and unknown names are rejected; the response is
  the authoritative post-update state.
- A new `TickPersistenceUnavailable` error is mapped to `ok:false` so an
  unreachable settings store reports honestly instead of raising a raw 500. The
  reachability check runs **before** any write, so a failed multi-key update cannot
  half-apply.

### 3.4 `python-service/services/settings_service.py`

- Descriptions updated so the `dbw_*` keys are labelled `[DB Writer]` and the
  `mwr_persist_ticks` description states it is not the persistence decision.
  Defaults untouched (`False`, the pre-existing authoritative default).

### 3.5 `app/_pages/db-writer/page.tsx` (existing page, no new page)

- **Settings ⚙️** control in the page header opens an inline Settings panel.
- **Three independent toggles** (`Personal Stocks — No Expiry`,
  `Personal Stocks — 1-Day Expiry`, `Market Watch Stocks — 1-Day`) bound to the
  three permissions.
- **No optimistic state.** The toggles render what the DB Writer last reported;
  a write adopts the backend's returned state verbatim, and a rejected write
  re-reads the authoritative state so the switch cannot show a false value. An
  unavailable settings store is called out as an operational fault, with copy that
  states the switches still reflect the last confirmed state.
- **Live status** card renders the backend-reported permission state, accepted /
  skipped counters, overlap dedupe and unknown-source rejection counts, and states
  that the DB Writer is the only authority.

---

## 4. The three permissions

| Permission | Setting key | Classification | Default |
|---|---|---|---|
| `personalNoExpiry` | `dbw_personal_no_expiry_ticks` | `PERSONAL_NO_EXPIRY` | OFF |
| `personalOneDay` | `dbw_personal_expiry_ticks` | `PERSONAL_ONE_DAY` | OFF |
| `marketWatchOneDay` | `dbw_market_watch_ticks` | `MARKET_WATCH_ONE_DAY` | OFF |

All three are pre-existing settings keys, already `False` in
`services/settings_service.py` and already live in `runtime_settings.LIVE_KEYS`.
No new default was invented; the existing authoritative one was kept.

**"1-day" is a session/subscription classification, not a MongoDB TTL.** No TTL
index exists in this project; expiry is application-managed via `expires_at` /
`expiry_type` (see `docs/pending/PENDING-001-live-verification.md`).

---

## 5. Deduplication (unchanged identities, no new keys)

- Personal / data-saver path: `(instrumentToken, sequenceNumber)`, 300 s TTL.
- Market Watch path: the existing deterministic `_id = symbol:sequence`, with
  `E11000` treated as a benign duplicate skip.

The task asks for the strongest existing identity per classification. The broker
`sequenceNumber` is that identity, and it is what both paths now use. No new
dedup key was introduced.

---

## 6. Batching / backpressure preserved

Both tick paths still use the existing bounded in-memory buffers and bulk writes
(`services/tick_buffer.py` for `ticks`, `services/market_watch_doc_buffer.py` for
`market_ticks`). No per-tick `insert_one` was introduced, no buffer was replaced,
and the manual flush endpoint is unchanged.

---

## 7. Files changed

Backend
- `python-service/services/db_writer_engine.py`
- `python-service/services/market_watch_engine.py`
- `python-service/services/settings_service.py`
- `python-service/api/engine_control.py`

Frontend
- `app/_pages/db-writer/page.tsx`

Tests
- `python-service/tests/test_db_writer_engine.py` (new `TickPersistenceAuthorityTest`,
  new `TickPersistenceApiTest`)
- `python-service/tests/test_market_watch_spec_modules.py` (updated
  `test_engine_honours_the_switch_per_tick`; new
  `test_db_writer_permission_off_blocks_market_watch_ticks`)

Documentation
- `docs/opencode/002-tick-persistence-ownership-trace.md` (new)
- `docs/engines/db_writer_engine_detailed.md` (updated)
- `docs/engines/MARKET_WATCH.md` (updated)
- `docs/implementation/016-db-writer-single-tick-persistence-authority.md` (this file)
- `docs/verification/016-db-writer-single-tick-persistence-verification.md`
- `docs/FINAL_REPORT.md` (updated)

---

## 8. Verification status

- Backend: `1189 passed` (full `pytest` run), including the new authority and API
  tests.
- Route registration and endpoint behaviour confirmed over **real HTTP** by mounting
  the real `engine_control` router in a scratch FastAPI app; the router is included
  at `app.py:1020`.
- Frontend: `npx tsc --noEmit` clean, `eslint` clean on the changed page,
  `npm test` 274 tests / 273 pass / 1 pre-existing unrelated failure
  (`tests/topbar-status.test.ts:336`).
- Live broker / MongoDB: **NOT_VERIFIED** — an already-running backend on port 8000
  predates these changes and was deliberately not restarted, and no live feed or
  database was available. See `docs/PROJECT_GAPS.md` GAP-036.
