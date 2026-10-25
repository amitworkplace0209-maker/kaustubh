# Data Center — Backend Observability Planes Audit

- **Scope:** `python-service/services/data_center_planes.py` (new),
  `python-service/api/data_center.py` (plane routes), and the read path they depend on.
- **Method:** Static code trace of the real sources, plus automated tests that drive the
  real functions and the real FastAPI router. No live MongoDB / broker / scheduler run.
- **Date:** 2026-09-28
- **Status:** `VERIFIED_WITH_LIMITATIONS` (offline only — see *Limitations*)

---

## 1. Problem found

`services/data_center.py` (the pre-existing snapshot service) answered a
**storage/history** question: how many bytes, how many ticks, per day, over a
window. It could not answer the questions a data center is actually asked:

| Question | Answered before this change? |
| --- | --- |
| Which MongoDB am I actually talking to right now? | No |
| Which engines exist, and who owns which collection? | No |
| What does the engine dependency graph look like? | No |
| Is the tick pipeline healthy, and who is allowed to write? | No |
| What is the retention contract, and does it exist in the DB? | No |

Everything the page showed before was derived from `build_snapshot()`, which
returns **storage aggregates**. Several panels therefore had to infer ownership
by name-matching, and could only say `UNKNOWN` where the answer was knowable.

---

## 2. What was added

Six read-only planes in `services/data_center_planes.py`, each with an
independent TTL / single-flight entry in `api/data_center.py`:

| Endpoint | Plane | Builder | TTL |
| --- | --- | --- | --- |
| `GET /api/system/data-center/database` | `database` | `database_plane()` | 10s |
| `GET /api/system/data-center/engines` | `engines` | `engines_plane()` | 30s |
| `GET /api/system/data-center/topology` | `topology` | `topology_plane()` | 30s |
| `GET /api/system/data-center/db-writer` | `dbwriter` | `db_writer_plane()` | 10s |
| `GET /api/system/data-center/ownership` | `ownership` | `ownership_plane()` | 30s |
| `GET /api/system/data-center/retention?limit=` | `retention` | `retention_plane(limit)` | 30s |

Every plane returns the same envelope shape, so a new plane can be added
without touching the ones that already work:

```json
{ "plane": "...", "source": "<module path>", "generatedAt": "...",
  "available": true, "error": null, "...": "..." }
```

`available: false` is a **supported, expected** state. It means the measurement
could not be taken, and `error` carries the real reason.

---

## 3. Source of every value (no invented data)

| Field | Real source | Notes |
| --- | --- | --- |
| `identity.*` | `database.connection.get_mongo_info()` | `source`/`database`/`host`/`pool`; **never the URI** |
| `storage.*`, `collections[]` | `api.system.mongo_stats()` | **reused**, already cached + 10s TTL — no second collStats sweep |
| `serverStatus.*` | `db.command("serverStatus")` | explicit allow-list only, see §4 |
| `engines.*` | `services.engine_registry` `dependency_graph()` / `get_status()` | never a hard-coded list |
| `topology.edges[]` | registry `dependency_graph()` | `depends_on` edges are read, not authored |
| `dbwriter.*` | `services.db_writer_engine.DBWriterEngine.status_snapshot()` | the writer's **own** counters, never recomputed |
| `permissions[]` | `services.db_writer_engine.TICK_PERSISTENCE_PERMISSIONS` | module constants |
| `retention.ttlIndexes[]` | `coll.index_information()` | real indexes, `expireAfterSeconds` only |
| `retention.cleanup` | `services.atlas_cleanup.get_cleanup_status()` | |
| `retention.snapshots` | `services.data_center.recent_snapshots()` | |
| `ownership.*` | `mongo_stats()` ⨝ static `COLLECTION_OWNERS` | unlisted ⇒ `UNMAPPED` |

---

## 4. Secret-handling review (read-only audit)

`serverStatus` on a real deployment returns the full document, which includes
`localTime`, `connections`, `network`, `opcounters`, `security`, and on Atlas
additionally host/tenant identifiers. Copying it wholesale would leak more than
the page needs.

`database_plane()` therefore copies **only** these paths, and nothing else:

```
uptime
connections.{current,available,totalCreated}
network.{numRequests,numYieldedAcquires,numPendingAcquires,serviceExecutor}
opcounters.{insert,query,update,delete,getmore,command}
memory.{bits,resident,residentPeak,virtual,mapped,swapUsed}
extra_info.page_size
```

`sanitize_for_json()` is still applied on the way out. A regression test asserts
that none of `mongodb+srv://`, `mongodb://`, `password`, `"uri"`, `apikey`,
`secret` appear in **any** plane response, and a second test walks every key of a
real-shaped `serverStatus` to confirm the non-allow-listed `host` field is
absent.

---

## 5. Write-path audit — is the Data Center read-only?

Yes. Reviewed every call site in `data_center_planes.py`:

- `db.command("serverStatus")` — read
- `coll.index_information()` — read
- `db.list_collection_names()` — read
- `api.system.mongo_stats()` — read (already cached by the existing system API)
- `engine_registry.dependency_graph()` / `get_status()` / `summary()` — in-process reads
- `db_writer_engine.status_snapshot()` / `storage_caps()` / `storage_cap_reason()` / `is_tick_persistence_hard_capped()` — in-process reads
- `atlas_cleanup.get_cleanup_status()` — read
- `data_center.recent_snapshots()` — read

No `insert_one` / `update_one` / `delete_many` / `create_index` / `drop` call
exists in the module. The pre-existing POST actions (`capture`, `deep-scan`,
`cleanup`) were **not** moved or duplicated; they remain where they were.

Tick-persistence authority is untouched: `ticks` is attributed to
**DB Writer Engine**, and `db_writer_plane()` republishes the writer's own
counters rather than recomputing a competing view.

---

## 6. Defects found and fixed during this work

These were found by the tests written alongside the change, not by inspection.

| # | Defect | Impact | Fix |
| --- | --- | --- | --- |
| B1 | `_server_status_raw()` swallowed the command error and returned `{}`; `_server_status_whitelist()` then saw a dict and reported **`available: true` with no metrics** | On Atlas tiers that restrict `serverStatus`, the UI would show a healthy-but-empty server instead of an honest "not available" | raise on failure; treat an empty/allow-list-less document as unavailable |
| B2 | TTL index field read as `next(iter(spec.get("key") or {}), None)` | pymongo reports `key` as a **list of `(field, direction)` pairs**, so the UI showed `("expiry", 1)` instead of `expiry` | added `_index_field()` accepting both the pair-list and dict shapes |
| B3 | `database_plane()` returned `collections: []` when `mongo_stats` failed | an empty list asserts "this database has no collections"; it actually asserts "we could not measure" | return `null` (not measured) and keep `storageError` |
| B4 | `_plane()` cached under `_cache_key("plane", name=name)` only | `retention?limit=50` and `limit=400` shared one entry — the first response was replayed for the other | `_plane(..., **key_parts)`; retention passes `limit=` |
| B5 | `_cache_key(name, **parts)` used `name` as its own first parameter | `_cache_key("plane", name=name, ...)` raised `TypeError: got multiple values for argument 'name'` | renamed the parameter to `_prefix` |
| B6 | `db_writer_plane` imported `TICK_PERSISTENCE_*` from the module, not the instance | a test that faked only the engine saw an empty permission list | no product change needed; test fixture corrected to patch the module (documented here because it is a real trap) |

B1–B5 are product fixes. B6 is recorded because the module/instance split is a
genuine footgun for the next person who writes a test against this plane.

---

## 7. Ownership attribution — and its honest limit

`DOCUMENTED_ENGINES` (9) and `COLLECTION_OWNERS` (36) are **static, code-derived**
maps. They are not discovered at runtime, because the runtime has no such
registry for collections.

The contract they follow:

- A collection that **is** live but **is not** in the map ⇒ `owner: "UNMAPPED"`,
  `retention: "NOT VERIFIED"`, `documented: false`.
- A collection in the map that is **not** currently live ⇒ reported with
  `present: false` and `documents: null` — *declared, currently absent*.
- An engine present in the registry but absent from the documented set is
  surfaced as `documented: false` with `owner: "UNMAPPED"` rather than dropped.

Each map entry carries a `basis` string naming the module it was derived from, so
a reviewer can re-derive or correct any single row without re-reading the whole
module. Two tests assert the maps are *fully attributed* (no entry with a blank
owner / module / retention / basis) and that `ticks` is owned by DB Writer.

**This is a static audit artifact, not live discovery.** The limitations are
listed in §9.

---

## 8. Error-handling and isolation review

- Each plane is a separate `asyncio` task behind its own `_get_or_build` key, so
  a slow or failing plane cannot delay or blank another.
- A builder that raises is caught, logged, and returned as
  `503 {"ok": false, "error": "..."}` — verified through the **real** FastAPI
  router, not a stub.
- A `serverStatus` that is not authorized is **not** an error state; it is an
  expected unavailable state, and the rest of the database plane still renders.
- One collection whose `index_information()` raises is skipped and the remaining
  indexes are still returned (verified).
- Unconnected MongoDB yields `available: false` with the real reason, never a
  zeroed-out payload.

---

## 9. Limitations (unverified without a live run)

1. **No live MongoDB was used.** Every test drives a fake `db` / fake collection.
   Real `serverStatus` field names and real `index_information()` shapes are
   matched from the documented driver contract, not observed.
2. **The ownership map is unratified.** It was derived by reading write paths in
   the code, but no second reviewer has signed it off, and it is not regenerated
   from the code at runtime.
3. **`_dc._snapshot_task` / `_dc._last_snapshot_at` are private attributes** of
   `services.data_center` used by `retention_plane()` for the snapshot-retention
   panel. A rename there would break the plane (it would surface as an
   `available: false` retention plane, not a crash).
4. **`TICK_PERSISTENCE_LABELS` contains mojibake** (e.g. `â€”` for an em dash) in
   `services/db_writer_engine.py`. This is pre-existing and is republished
   verbatim by `db_writer_plane()`; it is visibly wrong in the UI and was left
   alone because correcting it is a separate change to another module.
5. **Engine names/categories come from the registry**, which reports `UNKNOWN` for
   health on a process that has not yet emitted a heartbeat.
6. Atlas-only behaviours (`serverStatus` privilege tier, `mongo_stats` latency on
   large deployments) are reasoned about, not measured.

---

## 10. Realtime delivery + section classification update (2026-10-01, serial 022)

Related implementation: `docs/implementation/022-data-center-realtime-snapshot-push-and-page-redesign.md`
Related verification: `docs/verification/022-data-center-realtime-snapshot-push-and-page-redesign-verification.md`

### 10.1 Defect that was fixed

`realtime_section` was listed in `ASYNC_SECTIONS` although it is a plain `def`.
`build_snapshot()` awaits every async section, so it awaited a `dict`:

```
TypeError: object dict can't be used in 'await' expression
```

Effective outcome before the fix: `realtime.available = false` with the
`TypeError` as its reason, and `health.overall = UNKNOWN` because the realtime
health category could not be rolled up. `realtime_section` now lives in
`SYNC_SECTIONS`; `ASYNC_SECTIONS` contains only `storage`, whose builder really is
a coroutine function.

### 10.2 New realtime delivery path (WS#2, `data_center` channel)

Current implementation, post-022:

- `connection_engine/channels.py` — `STATE_CHANNELS["data_center"]` = "aggregated
  Data Center snapshot (single authoritative document)". It is advertised in the
  `welcome` frame under `data.channels.state`.
- `connection_engine/connection_engine.py`:
  - `DATA_CENTER_SNAPSHOT_INTERVAL_S = 5.0`, `SOURCE_DATA_CENTER = "data_center"`.
  - `_STATE_TYPE_CHANNEL["data_center_snapshot"] = "data_center"`; the wire type is
    `data_center.snapshot`; `_broadcast_frame` tags these frames with
    `source: "data_center"`.
  - `_has_data_center_subscribers()` gates the emit: with no subscriber the loop
    performs **no** snapshot build.
  - `data_center_snapshot_frame()` = `{type, generatedAt, data: <snapshot>}`.
  - `self._data_center_task` is created in `start()` and cancelled in
    `shutdown()`, mirroring the `engines` loop. There is no scheduler job and no
    new engine.
- `services/data_center_snapshot.py` — `PUSH_TTL_S = 5.0`, module-level
  `_push_cache`, and `async get_cached_snapshot(ttl=PUSH_TTL_S)`. The pushed
  document and the REST response are therefore the **same** document; there is no
  second aggregation and no per-client fan-out. It is lock-free and documented as
  single-caller (the Connection Engine loop).

### 10.3 What did NOT change

- Snapshot schema is still `schemaVersion: 2` with the same nine sections; the
  `snapshot/schema` endpoint is unchanged.
- No REST route, response shape, cache TTL or ownership was changed.
- The Data Center remains **read-only**; DB Writer remains the only tick writer.
- The `engines` channel, its interval and the outbox/broadcast path are untouched
  apart from one extra `source` value.

### 10.4 Observed runtime state (2026-10-01)

- `GET /api/system/data-center/snapshot` → `realtime.available=True`,
  `overall=DEGRADED`, `database.connected=True`.
- `DEGRADED` is honest, not a regression: `brokerFeed.available=True
  connected=False` (no broker session in that session) and
  `backendRealtime.available=True health=NO_DATA`.
- A WebSocket client subscribed to `data_center` received
  `type=data_center.snapshot channel=data_center source=data_center` within one
  5 s cycle.
- First (cold) build measured `buildMs=4697`; steady-state builds are served from
  the 5 s cache.
