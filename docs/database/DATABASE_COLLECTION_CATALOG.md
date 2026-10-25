# DATABASE_COLLECTION_CATALOG.md

## Collections and indexes — **extracted from source**

**Created**: 2026-09-28
**Status**: `STATIC_VERIFIED` for names and index definitions below.
**`NOT_VERIFIED`**: actual documents, actual index presence at runtime, and the effective
database name. Nothing was executed and no database was contacted.

> **This file was rewritten on 2026-09-28.** The first version was **inferred** from
> documentation and API responses and carried an explicit "schemas are inferred" warning.
> That inference has now been replaced by reading
> `python-service\database\connection.py` (`_ensure_indexes`, line 480) and
> `python-service\database\migrations.py` directly.

### Primary sources
| File | Lines | What it provides |
|------|-------|------------------|
| `python-service\database\connection.py` | 766 | `_ensure_indexes()` (line 480) — all index definitions |
| `python-service\database\migrations.py` | 335 | `_migrations` ledger, `system_events` duplicate repair |
| `python-service\services\session\instrument_store.py` | — | 3 `session_manager_*` collections |

---

## 1. Retention policy (TTL)

| Retention | Collections | Index name | Line |
|-----------|-------------|-----------|------|
| **7 days** | `notifications` | `ts_ttl_notifications` | 551-556 |
| **7 days** | `websocket_history` | `connected_at_ttl` | 582-587 |
| **7 days** | `websocket_events` | `timestamp_ttl` | 595-600 |
| **30 days** | `data_saver_telemetry` | `ts_ttl_data_saver_telemetry` | 621-626 |
| **30 days** | `api_telemetry` | `ts_ttl_api_telemetry` | 636-641 |
| **Never (permanent)** | `system_events` | — | comment line 605: *"canonical append-only event ledger (never TTL'd — audit trail)"* |
| **Never (permanent)** | `audit_trail` | — | comment line 485-486: *"append-only"*, 7 years of regulatory data |

> **Operational note**: all five TTL index creations are wrapped in `try/except` that only
> logs a warning (lines 557-558, 588-589, 601-602, 627-628, 642-643). **A failure to create
> a TTL index is silent** — the collection then grows without bound rather than failing
> loudly. Confirm each TTL index exists at runtime (`PENDING-001`).

---

## 2. Collections with indexes

### 2.1 Market data
| Collection | Indexes | Line |
|-----------|---------|------|
| `ticks` | `ts`; `(symbol, ts)`; `(instrumentToken, ts)` | 482-484 |
| `market_ticks` | `(date, lastTickAt)`; `(symbol, lastTickAt)`; `(instrumentToken, lastTickAt)` | 534-536 |
| `market_candles_1m` | `(date, instrumentToken)` | 539-542 |
| `market_candles_5m` | `(date, instrumentToken)` | 539-542 |
| `market_candles_10m` | `(date, instrumentToken)` | 539-542 |
| `market_candles_30m` | `(date, instrumentToken)` | 539-542 |

The four candle collections are created in a **loop** over `("1m","5m","10m","30m")`
(line 539) — so the set is data-driven, not hard-coded per timeframe. Comment line 538:
*upserts key on the deterministic `_id`*.

`market_ticks._id` is documented as `"<symbol>:<epoch_ms>"` (comment line 532).

### 2.2 Instruments, watchlist, settings
| Collection | Indexes | Line |
|-----------|---------|------|
| `stocks` | `symbol` **unique**; `internalIndex` **unique**; `active` | 489-491 |
| `watchlist` | `symbol` **unique**; `favorite`; `watchlist_id`; `(watchlist_id, token)` | 502-505 |
| `app_settings` | `key` **unique** | 495 |
| `daily_summaries` | `date` **unique** | 506 |

> `watchlist.symbol` is **unique** across the whole collection, yet `watchlist_id` also
> exists as a grouping key with a compound `(watchlist_id, token)` index. A symbol can
> therefore appear in only one watchlist document overall. This is consistent with the
> `DUPLICATE_OR_POSSIBLE_DUPLICATE` finding across the three watchlist APIs, but the
> intent is `NOT_VERIFIED`.

### 2.3 Audit and events
| Collection | Indexes | Line |
|-----------|---------|------|
| `audit_trail` | `ts`; `(terminal, ts)` — **append-only, no TTL** | 487-488 |
| `system_events` | `ts`; `source`; `event`; `category`; `severity`; `(market_date, ts)`; `connection_id`; `session_id`; `symbol`; `token`; **+ `event_id` unique (created last)** | 521-523, 608-615 |
| `events` | `ts` | 524 |

**`system_events` ordering constraint (important).** Line 606-608:
> *"The event_id index MUST be unique and is created AFTER duplicate repair (see
> `database.migrations`) — never before."*

`ensure_system_events_unique_index(db)` is called at line 608 **before** the other
`system_events` indexes but **after** duplicate repair. Creating the unique index first
would fail on a collection that already contains duplicate `event_id` values. This is a
deliberate, documented ordering constraint — **do not "tidy" it.**

### 2.4 Notifications and logs
| Collection | Indexes | Line |
|-----------|---------|------|
| `notifications` | `read`; `created_at`; `severity`; `category`; `source`; `event_type`; `ts` **TTL 7d** | 494, 545-556 |
| `app_logs` | `ts`; `category` | 492-493 |

### 2.5 Data quality
| Collection | Indexes | Line |
|-----------|---------|------|
| `quality_snapshot` | `ts`; `(session, ts)`; `(symbol, ts)` | 561-563 |
| `quality_issues` | `ts`; `status`; `severity`; `dimension`; `symbol`; `(key, status)`; `last_seen` | 564-570 |
| `quality_scans` | `started_at`; `status` | 571-572 |

### 2.6 WebSocket history
| Collection | Indexes | Line |
|-----------|---------|------|
| `websocket_history` | `connected_at`; `disconnected_at`; `created_at`; `connection_id` **unique**; `status`; `date`; `connected_at` **TTL 7d** | 575-587 |
| `websocket_events` | `timestamp`; `connection_id`; `event_type`; `timestamp` **TTL 7d** | 591-600 |

Note the **two different TTL semantics**: `websocket_history` expires on `connected_at`
while `websocket_events` expires on `timestamp`. A long-lived connection therefore
retains its history document 7 days past connect, while its event documents roll off 7
days after each event.

### 2.7 Data SAVer / telemetry
| Collection | Indexes | Line |
|-----------|---------|------|
| `data_saver_telemetry` | `bucket` **unique**; `(ts, bucket)`; `ts` **TTL 30d** | 618-626 |
| `api_telemetry` | `(bucket, route)` **unique**; `route`; `ts`; `ts` **TTL 30d** | 631-641 |
| `data_saver_incidents` | `incident_id` **unique**; `(kind, status)`; `detected_at`; `status` | 646-650 |
| `data_saver_daily_reports` | `report_id` **unique**; `report_date`; `(report_type, report_date)` | 653-656 |
| `data_saver_weekly_reports` | `report_id` **unique**; `weeks` | 657-658 |
| `data_center_snapshots` | `ts`; `istDay` | 661-662 |

### 2.8 Market Watch
| Collection | Indexes | Line |
|-----------|---------|------|
| `market_watch_decisions` | `blocked_at`; `(date, blocked_at)`; `symbol`; `instrumentToken` | 527-530 |

One document per eligibility decision, written through the DB Writer (comment 525-526);
`/history` reads and sorts exactly these fields.

### 2.9 Downloads, exports, scheduling
| Collection | Indexes | Line |
|-----------|---------|------|
| `download_history` | `ts`; `format`; `source`; `fileId` | 507-510 |
| `export_jobs` | `createdAt`; `status` | 511-512 |
| `scheduled_downloads` | `enabled`; `nextRun` | 513-514 |
| `schedule_runs` | `runAt`; `scheduleId`; `idempotencyKey` | 515-517 |
| `package_downloads` | `createdAt`; `scheduleId`; `status` | 518-520 |

`schedule_runs.idempotencyKey` is indexed but **not unique** — so it does not by itself
prevent duplicate schedule runs.

### 2.10 Sessions
| Collection | Indexes | Line |
|-----------|---------|------|
| `dummy_daily_sessions` | `(terminal, trading_date)` **unique**; `(status, trading_date)` | 498-501 |

Comment line 496-497: *"One session document per Dummy terminal per trading date (09:00 IST
fresh-day lifecycle). Unique => the idempotent open can never duplicate."*

### 2.11 Session Manager (Phase 3)
From `services\session\instrument_store.py`:

| Collection | Constant | Line |
|-----------|----------|------|
| `session_manager_instruments` | `INSTRUMENTS_COLLECTION` | 30 |
| `session_manager_events` | `EVENTS_COLLECTION` | 31 |
| `session_manager_revisions` | `REVISIONS_COLLECTION` | 32 |

`ensure_indexes()` (`instrument_store.py:135-168`) is called from
`connection.py:667-672` inside a `try/except` that only logs a warning, and the comment at
`connection.py:665-666` states the store also **lazily ensures** them — so these indexes may
be created outside startup. Index definitions (read line-by-line 2026-09-28):

**`session_manager_instruments`** — 18 indexes

| Index | Unique | Line |
|-------|--------|------|
| `_id` | (implicit) | 140 |
| `instrument_id` | **yes** | 141 |
| `broker` | | 142 |
| `exchange_segment` | | 143 |
| `instrument_token` | | 144 |
| `(broker, symbol)` compound | | 145 |
| `source` | | 146 |
| `status` | | 147 |
| `subscription_state` | | 148 |
| `active` | | 149 |
| `desired` | | 150 |
| `pinned` | | 151 |
| `expires_at` | | 152 |
| `expiry_type` | | 153 |
| `(active, status)` compound | | 154 |
| `(expires_at, status)` compound | | 155 |
| `(ts desc)` | | 156 |
| `updated_at` | | 157 |

**`session_manager_events`** — 6 indexes: `(ts desc)` 160; `event` 161; `instrument_id` 162;
`event_type` 163; `(instrument_id, ts desc)` compound 164; `revision` 165.

**`session_manager_revisions`** — 1 index: `owner` **unique** (line 168).

Notes:
- `instrument_id` is the canonical identity, composed as
  `f"{broker}|{exchange_segment}|{instrument_token}"` (line 117-122) and normalised to
  lowercase broker, so the unique index is genuinely collision-free by construction.
- **No TTL on any `session_manager_*` collection.** `expires_at` is indexed but has no
  `expireAfterSeconds`, so instrument expiry is **application-managed business logic**
  (`EXPIRY_TYPES = PERMANENT | SESSION | TRADE | DURATION | ONE_SHOT`, line 110), not
  retention. This is correct — automatic deletion would be wrong here.
- The `owner` **unique** index on `..._revisions` means the collection holds **one document
  per owner**; despite the name it is a current-state snapshot, not a revision log. No
  history is retained.
- Line 140 `create_index("_id")` is redundant — MongoDB always creates a unique `_id` index.
  Harmless, but it costs a round-trip on every boot.

### 2.12 Infrastructure
| Collection | Purpose | Source |
|-----------|---------|--------|
| `_migrations` | migration ledger | `migrations.py:26` |

---

## 3. Migration strategy — now known

The first version of this file recorded migration strategy as `UNKNOWN`. It is now
resolved.

`database\migrations.py` implements a **custom, versioned, idempotent migration ledger** —
not a framework (no Alembic, no `migrate` package in `requirements.txt`).

| Element | Detail | Line |
|---------|--------|------|
| Ledger collection | `_migrations` | 26 |
| Migration name | `system_events.event_id_unique_repair` | 29 |
| Lock staleness window | `LOCK_STALENESS_SECONDS = 60.0` | 28 |
| Claim a migration | `find_one_and_update` on `_migrations` — atomic, so a concurrent or repeated run cannot double-apply | 151 |
| Record completion | `update_one` (state → `applied`) | 194 |
| Check prior run | `find_one` | 211 |
| Target collection | `system_events` | 27 |

### `system_events` duplicate repair
| Step | Detail | Line |
|------|--------|------|
| Detect | `detect_duplicate_event_ids(db, collection)` — aggregation, "cheap on a clean collection (returns [] immediately)" | 45-47, 77-78 |
| Guard | `dry_run: bool = False` parameter | 64 |
| Order | documents sorted by `(ts, _id)`; `docs[0]` is canonical | 94-96 |
| Repair | **`$set` a fresh `_next_event_id()` `event_id` on every non-canonical doc, plus `repaired_from_event_id` and `repaired_at`** | 102-113 |
| Never deletes | no `delete_one`/`delete_many` anywhere in `migrations.py` — **every document is preserved** | 101-113 |
| Per-group isolation | failure on one group increments `failed` and continues with the next | 114-117 |
| Report | `duplicate_groups`, `documents_in_duplicate_groups`, `repaired`, `canonical_kept`, `failed`, `failures`, `repaired_doc_ids`, `dry_run`, `ran_at` | 119-131 |

> **CORRECTION 2026-09-28.** An earlier version of this table said the repair
> *"keep[s] a canonical document per group, delete[s] the rest by `_id`"*. **That was wrong
> and operationally misleading** — it implies data loss. The repair is a pure `$set` of new
> `event_id` values, tagged with `repaired_from_event_id` so the audit trail stays
> traceable, and the original documents all survive. Verified by reading
> `migrations.py:101-113`.

Docstring line 13: *"migration record (`_migrations` collection) so the full repair never
runs"* again.

**No rollback path was found.** `migrations.py` repairs and creates; there is no inverse
operation. This remains a `DOCUMENTATION_GAP` for the audit trail.

### Migration-system assessment (completed 2026-09-28)

Having read all 335 lines, the ledger is **better than typical hand-rolled migrations**, and
the specific weaknesses are now known:

**Strengths**

| Property | Evidence |
|----------|----------|
| Atomic multi-worker claim | `find_one_and_update` with `upsert=True`; `DuplicateKeyError` → `False` (`:151-164`) |
| Stale-lock takeover | `$or` on `state != running` **or** `acquired_at_epoch <= now - 60s` (`:152-155`) |
| Repair before constraint | non-unique `event_id` index is dropped **after** data is clean, never before (`:259-267`) |
| Retry on live duplicates | `DuplicateKeyError`/`E11000` triggers re-repair then retry, `retries=2` (`:269-296`) |
| Fails loudly | `RuntimeError` after retries exhausted (`:298-301`) |
| Never downgrades an applied record | release filter requires `state == "running"` (`:183`) |
| Idempotent | no duplicates → zero repairs (`:75`, `:132-138`) |

**Weaknesses**

| # | Issue | Line | Effect |
|---|-------|------|--------|
| M-1 | **No rollback.** Forward-only; no inverse operation for the `$set` rewrite | whole file | A bad repair is manual to undo. Mitigated: originals are tagged, and the report stores `repaired_doc_ids` |
| M-2 | **`dry_run` exists but the startup path never uses it** — `run_startup_migrations` calls `reconcile_system_event_ids(db, collection)` with no `dry_run` | `:324` vs `:64` | First boot against a legacy database performs an **irreversible in-place rewrite with no preview**. Running it manually with `dry_run=True` first would close this |
| M-3 | `_release_lock` is **fire-and-forget** — `asyncio.ensure_future(...)`, never awaited | `:181-186` | A crash between `record_migration` and release leaves the row `running`; the next boot is blocked for up to 60 s |
| M-4 | `is_migration_applied` returns `False` on **any** exception | `:212-213` | A transient DB error causes the repair to **re-run**. Mitigated because step 2 independently verifies the index exists (`:253-257`) |
| M-5 | `record_migration` swallows write failures | `:205-206` | The ledger can silently fail to persist a completed migration; the repair then re-runs each boot (idempotent, so low impact) |
| M-6 | State vocabulary is `running` / `done` / `applied`, but `record_migration` runs *before* the release, so `done` is effectively unreachable on the success path | `:183`, `:194` | Harmless, but the ledger schema is wider than it needs to be |

**Net**: the mechanism is sound. **M-2 is the item worth acting on** — a one-line change to
pass `dry_run=True` on first run, or a documented manual pre-flight.

---

## 4. Index creation is best-effort — a real risk

Index creation is called during startup and is **explicitly non-fatal**:

- comment at `connection.py:665`: *"Best-effort: never block startup on index failures
  (the store also lazily ensures them)"*
- the Session Manager block is wrapped in `try/except` (`connection.py:667-670`)
- each TTL index is individually wrapped in `try/except` that only logs a warning

**Consequence**: a running system can be **missing indexes it believes it has** — silently.
A missing index on `system_events.event_id` unique, or on any of the five TTL indexes, has
direct consequences for both data growth and duplicate-event protection.

**Recommended runtime check** (`PENDING-001`): for each collection in §2, call
`index_information()` and compare against this document.

---

## 5. Collections with no index definitions found

| Expected by | Status |
|-------------|--------|
| `orders` | **no index definitions in `connection.py` or `migrations.py`** |
| `positions` | **no index definitions** |
| `trades` / `fills` / `executions` | **no index definitions** |

`order_engine` and `position_engine` are **facades** over pre-existing subsystems
(`legacy_engine_facades.py:300,336`), so order/position data may be written by code that
does not go through `database/connection.py`.

**This is an open question, not a finding of absence.** The first version of this file
listed order and position collections as inferred; that inference is **withdrawn** — no
evidence for them was found in the database layer. Tracing where order and position
documents are actually persisted is tracked in `PENDING-003`.

---

## 6. Redaction

`connection.py` contains a `_redact(exc)` helper used in the health path (lines 466, 475)
and the module docstring notes that configuration errors *"never contain the URI or any
credential"* (settings.py comment). No connection string or credential is reproduced in
this document.

---

## 7. Database name

`35_AI_AGENT_CONTEXT.md` claims `kaustubh_trading`. `settings.py` reads the name from the
`MONGODB_DATABASE` environment variable, and `MONGODB_DATABASE` **is present in
`python-service/.env`** (key confirmed; value deliberately not read). The actual value is
`NOT_VERIFIED` and must be confirmed before any write.

**Never write to whatever this resolves to without explicit confirmation.**

---
*Static analysis only. No database was contacted. No index or document was read or
written. No secret value read or recorded.*
