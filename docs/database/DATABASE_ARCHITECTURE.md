# DATABASE_ARCHITECTURE.md

## KAUSTUBH Trading Platform - Database Architecture

**Last Updated**: 2026-09-29
**Status**: ACTIVE
**Canonical Source**: `docs/architecture/17_DATABASE_ARCHITECTURE.md`
**Verification**: Collection names are documented. The **single-writer rule is VERIFIED against a live MongoDB** (see below); actual per-collection counts and indexes still depend on deployment.

---

## Database Platform

| Attribute | Value |
|-----------|-------|
| **Engine** | MongoDB |
| **Driver** | Motor 3.5.1 (async) + pymongo 4.8.0 |
| **DNS** | dnspython 2.7.0 (for `mongodb+srv://` Atlas) |
| **Default DB** | `kaustubh` (via `MONGODB_DATABASE`) |
| **Test DB** | `kaustubh_test` (via `MONGODB_TEST_DATABASE`) |
| **Module** | `python-service/database/connection.py`, `migrations.py` |

**Connection strings** (from settings):
- `mongodb://host:27017/kaustubh` (local)
- `mongodb+srv://user:pass@cluster.mongodb.net/kaustubh?retryWrites=true&w=majority` (Atlas)

---

## Persistence Ownership

**Single Writer Rule**: `db_writer_engine` is the **sole owner** of persistence. Other engines publish events; the DB Writer batches and writes.

```
Engines → EngineEventBus → db_writer_engine → tick_buffer → bulk insert → MongoDB
Market Watch ── (validated tick handoff) ──▶ db_writer_engine.ingest_market_watch_ticks()
```

**Why**: Prevents write storms, duplicate inserts, and inconsistent indexing during market hours.

**Verification**: **VERIFIED** against a live MongoDB 8.0.4 on 2026-09-29.
- Only one direct tick write remains in the codebase: `services/tick_buffer.py`
  (`db.ticks.bulk_write`), which is the DB Writer's own buffer. `rg` for
  `db.ticks.(insert|delete_many|bulk_write|update)` returns that line alone.
- Tick **deletes** were also bypasses. `api/quality.py` (duplicate cleanup) called
  `db.ticks.delete_many` three times; it now calls
  `db_writer_engine.delete_duplicate_ticks()`, so removals are owned, counted
  (`duplicateTicksRemoved`) and audited like every other tick write.
- Live end-to-end proof: five real ticks were offered to the DB Writer; exactly
  the two permitted ones were written to `market_ticks`
  (`_tick_source=MARKET_WATCH_ONE_DAY` and `PERSONAL_NO_EXPIRY`), read back
  through a **separate** pymongo client. The three refusals carried
  `EXPIRED_STOCK`, `INACTIVE_STOCK` and `NOT_ALLOWED_SOURCE`. Decision vs. stored
  state was consistent for all five.
- A manual `db_writer_engine.flush()` drains **both** buffers the engine owns
  (the Data Saver `ticks` buffer and the Market Watch document buffer), so a
  flush cannot report "drained" while accepted documents are still buffered.

**Not verified**: the Atlas cluster. In this environment Atlas fails the TLS
handshake (`TLSV1_ALERT_INTERNAL_ERROR`), so the proof above ran against a real
local `mongod` reached through the same universal `MONGODB_URI` and the same
`database.connection` layer. Atlas-specific behaviour (SRV DNS, auth, storage
limits) still needs a run from a network that can reach it.

---

## Collections (11 core + 2 auxiliary)

| # | Collection | Purpose | Retention |
|---|-----------|---------|-----------|
| 1 | `orders` | Order lifecycle records | TTL 1 year |
| 2 | `positions` | Open/closed position snapshots | TTL 1 year |
| 3 | `sessions` | User/broker session state | TTL 30 min |
| 4 | `market_data` | Real-time ticks | TTL 24 hours |
| 5 | `audit_log` | Compliance trail of all decisions | TTL 7 years |
| 6 | `targets` | Per-symbol price targets | TTL 1 year |
| 7 | `notifications` | User notifications | TTL 90 days |
| 8 | `config` | System configuration overrides | Persistent |
| 9 | `users` | User accounts | Persistent |
| 10 | `broker_adapters` | Broker connection state | Persistent |
| 11 | `session_manager_config` | Session Manager runtime config | Persistent |
| aux | `websocket_history` | Connection history | TTL 7 days |
| aux | `telemetry` / `api_telemetry` | Metrics and latency | Rolling |

**Detail**: `DATABASE_COLLECTION_CATALOG.md`

**Conflict**: `17_DATABASE_ARCHITECTURE.md` may list a slightly different set. `DOCUMENTATION_CODE_CONFLICT` — reconcile against actual `database/` code.

---

## Tick Buffer & Bulk Write

```
[TICK_VALIDATED event]
    → tick_buffer (services/tick_buffer)
    → accumulate
    → flush trigger:
        • buffer_flush_interval_ms elapsed, OR
        • buffer_max_size reached
    → bulk_insert (bulk_insert_size chunks)
    → MongoDB market_data
```

**Tuning knobs**:
- `buffer_flush_interval_ms` — latency vs. throughput
- `buffer_max_size` — memory cap
- `bulk_insert_size` — write batch size

**Risk**: Large `bulk_insert_size` competes with `mongodb_max_pool_size` for connections during market hours.

---

## Connection Pool

| Setting | Purpose |
|---------|---------|
| `mongodb_max_pool_size` | Upper bound on concurrent connections |
| `mongodb_min_pool_size` | Maintained idle connections |
| `mongodb_max_idle_time_ms` | Idle connection reaping |
| `mongodb_wait_queue_timeout_ms` | Queue wait limit |
| `mongodb_server_selection_timeout_ms` | Server discovery timeout |
| `mongodb_connect_timeout_ms` | Connect timeout |
| `mongodb_socket_timeout_ms` | Socket I/O timeout |
| `mongodb_connect_attempts` | Reconnect attempts |
| `mongodb_connect_retry_delay_s` | Delay between attempts |

---

## Indexes (VERIFIED against live MongoDB 8.0.4, 2026-09-29)

Read back from a real database through `database.connection`'s own
`_ensure_indexes` + migration run, not from this document's intentions.

| Collection | Index | Purpose |
|-----------|-------|---------|
| `ticks` | `{ instrumentToken: 1, ts: 1 }` | Per-instrument tick history |
| `ticks` | `{ symbol: 1, ts: -1 }` | Latest tick per symbol |
| `ticks` | `{ ts: -1 }` | Time-window scans (quality/duplicate scans) |
| `market_ticks` | `{ symbol: 1, lastTickAt: -1 }` | Latest Market Watch tick per symbol |
| `market_ticks` | `{ instrumentToken: 1, lastTickAt: -1 }` | Per-instrument Market Watch history |
| `market_ticks` | `{ date: 1, lastTickAt: -1 }` | Per-trading-date tick slices |
| `market_watch_decisions` | `{ date: 1, blocked_at: -1 }` | Block-ledger decisions per day |
| `market_watch_decisions` | `{ instrumentToken: 1 }`, `{ symbol: 1 }` | Per-instrument ledger lookups |
| `market_candles_*` | `{ date: 1, instrumentToken: 1 }` | Candle upsert key per timeframe |
| `notifications` | `{ read: 1, created_at: -1 }` (as `category_1`, `read_1`, `created_at_-1`, …) | Unread list |
| `notifications` | `{ ts: -1 }` `ts_ttl_notifications` **TTL 604800s (7d)** | Auto-purge — **not** 90d as previously documented |
| `app_settings` | `{ key: 1 }` **unique** | Setting lookup |
| `stocks` | `{ symbol: 1 }` **unique**, `{ internalIndex: 1 }` **unique** | Stock identity |
| `session_manager_instruments` | `{ instrument_id: 1 }` **unique** | Registry identity |
| `session_manager_instruments` | `{ active: 1, status: 1 }`, `{ expires_at: 1, status: 1 }` | Active/validity registry queries |
| `session_manager_instruments` | `{ instrument_token: 1 }`, `{ broker: 1, symbol: 1 }` | Token and symbol lookups |
| `session_manager_instruments` | `{ source: 1 }`, `{ desired: 1 }`, `{ pinned: 1 }`, `{ expiry_type: 1 }` | Source/classification queries |
| `quality_issues` | `{ status: 1 }`, `{ severity: 1 }`, `{ symbol: 1 }`, `{ ts: -1 }`, `{ key: 1, status: 1 }` | Quality dashboard filters |

**Corrections found by verifying instead of assuming**:
- `notifications` auto-purges after **7 days** (`ts_ttl_notifications`,
  `expireAfterSeconds=604800`), not the 90 days this table previously claimed.
- `orders` and `positions` are **not created at startup** — they are created on
  first write, so their indexes cannot be verified from a fresh database. The
  previously listed `orders`/`positions` TTL indexes remain unverified.
- `market_ticks` has **no TTL index**. Expiry is application-managed (this is
  why the DB Writer treats `market_date`/`expires_at` as decision metadata),
  consistent with the note on the three `dbw_*` permissions.


---

## Health & Monitoring

```
GET /api/system/health         → includes MongoDB status (503 when down)
GET /api/system/mongo-stats    → server stats, collection sizes
GET /api/system/data-center/collections/all   → per-collection stats
GET /api/system/data-center/collections/{name} → single collection detail
POST /api/system/data-center/deep-scan        → heavy scan (WARNING)
GET /api/system/data-center/storage-trend     → growth over time
POST /api/system/data-center/snapshots/capture
GET /api/system/data-center/snapshots
```

---

## Cleanup & Retention

**Two mechanisms**:
1. **MongoDB TTL indexes** — automatic, server-side, no app involvement
2. **Atlas cleanup job** — `atlas_cleanup_enabled` + `atlas_cleanup_hour` / `atlas_cleanup_minute`

**Manual**:
```
GET  /api/system/cleanup/status     retention job status
POST /api/system/cleanup/run        trigger cleanup
```

**Note**: TTL index deletion is asynchronous and lazy (MongoDB deletes during normal sweeps ~every 60s). Documents may persist briefly past expiry.

---

## Migrations

**Module**: `database/migrations.py`

**UNKNOWN**: Migration strategy (idempotent scripts? versioned collection? none?). Read the module.

---

## Data Quality

**API**: `/api/data-quality/*` (20 routes)
```
GET  /api/data-quality/summary        overall quality
GET  /api/data-quality/metrics        per-dimension metrics
GET  /api/data-quality/issues         open issues
GET  /api/data-quality/duplicates     duplicate records
GET  /api/data-quality/scan-state     last scan state
POST /api/data-quality/scan           trigger scan
POST /api/data-quality/scan/if-due    conditional scan
GET  /api/data-quality/pipeline       ingestion pipeline status
GET  /api/data-quality/storage        storage health
GET  /api/data-quality/diagnostics    full diagnostic dump
```

---

## Related Documents
- `DATABASE_COLLECTION_CATALOG.md` — Per-collection schema
- `DATABASE_LIFECYCLE.md` — Lifecycle, TTL, cleanup
- `../architecture/17_DATABASE_ARCHITECTURE.md` — Canonical doc
- `../api/API_CATALOG.md` — DB-related endpoints
- `../config/CONFIGURATION_CATALOG.md` — Connection settings
