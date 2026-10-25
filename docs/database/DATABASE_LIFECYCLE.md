# DATABASE_LIFECYCLE.md

## KAUSTUBH Trading Platform - Database Lifecycle

**Last Updated**: 2026-09-28
**Status**: ACTIVE
**Verification**: Lifecycle described from documentation and configuration. **NOT runtime-verified.**

---

## Startup Sequence

```
1. Read MONGODB_URI (required — startup fails without it)
2. database/connection.py → connect_mongo()
3. Apply client options:
     serverSelectionTimeoutMS, connectTimeoutMS, socketTimeoutMS,
     maxPoolSize, minPoolSize, maxIdleTimeMS, waitQueueTimeoutMS
4. Select database: MONGODB_DATABASE (default "kaustubh")
5. Run migrations (database/migrations.py)  ← strategy UNKNOWN
6. Ensure indexes exist
7. Signal ready to scheduler
8. Engine registry starts engines (db_writer_engine first)
```

**Failure**: If step 1–4 fails, the backend must not serve. `/api/system/health` returns **503**.

---

## Runtime Write Path

```
Engine event
  → EngineEventBus
  → db_writer_engine (sole writer)
  → tick_buffer
      • accumulate in memory
      • flush when: buffer_flush_interval_ms OR buffer_max_size
  → bulk_insert (bulk_insert_size chunks)
  → MongoDB
  → tick_buffer reset
```

**Backpressure**: If flush is slow, buffer grows to `buffer_max_size`, then events are dropped or block (behavior `NOT_VERIFIED`).

---

## Read Path

```
API router
  → service / engine
  → Motor cursor
  → optional projection / filter / sort
  → Pydantic response model
  → JSON
```

**Patterns**: Latest-tick-per-symbol uses `{ token: 1, ts: -1 }` with `find_one` + sort. Order history uses cursor pagination.

---

## TTL & Retention Lifecycle

| Collection | TTL | Field | Effective lifetime |
|-----------|-----|-------|--------------------|
| `market_data` | 24 hours | `ts` | 1 trading day |
| `sessions` | 30 minutes | `expires_at` | Rolling |
| `orders` | 1 year | `created_at` | 1 year |
| `positions` | 1 year | `created_at` | 1 year |
| `targets` | 1 year | `created_at` | 1 year |
| `notifications` | 90 days | `created_at` | 90 days |
| `websocket_history` | 7 days | `ts` | 7 days |
| `audit_log` | 7 years | `ts` | 7 years (regulatory) |
| `config`, `users`, `broker_adapters`, `session_manager_config` | none | — | Persistent |

**Important**: MongoDB TTL deletion is **asynchronous and lazy** — a background sweeper runs roughly every 60 seconds. Documents may briefly exceed their TTL. Do not rely on exact expiry timing.

---

## Cleanup Mechanisms

### 1. TTL Indexes (automatic, server-side)
No application code required. MongoDB sweeps expired documents during normal operation.

### 2. Atlas Cleanup Job (optional, application-side)
```yaml
atlas_cleanup_enabled: <bool>
atlas_cleanup_hour:   <0-23>
atlas_cleanup_minute: <0-59>
```
Runs an application-level cleanup (e.g. removing orphaned or oversized documents TTL cannot handle).

### 3. Manual Cleanup API
```
GET  /api/system/cleanup/status   current retention job state
POST /api/system/cleanup/run      trigger cleanup now
```

### 4. WebSocket History Cleanup
```
POST /api/websocket/history/delete-day
POST /api/websocket/history/delete-older-than
POST /api/websocket/history/clear-all
POST /api/dummy/maintenance/retention
```

### 5. Notification Retention
```
POST /api/alerts/retention/run
```

---

## Data Quality Lifecycle

```
Periodic scan (schedule unknown)
  → /api/data-quality/scan or /scan/if-due
  → examine dimensions (symbol, exchange, field completeness)
  → produce issues
  → GET /api/data-quality/issues
  → operator action: POST /api/data-quality/issues/{id}/{action}
  → duplicates: GET /api/data-quality/duplicates, POST /duplicates/delete
  → snapshot: POST /api/data-quality/snapshot
```

---

## Backup & Restore

**NOT DOCUMENTED / UNKNOWN**. No backup script, mongodump wrapper, or restore procedure was found in `docs/`. **This is a gap** — MongoDB holds 7 years of `audit_log` (regulatory) and all order history.

**Recommended**: Document `mongodump` schedule, Atlas backup policy, and a tested restore procedure.

---

## Migration Strategy

**UNKNOWN.** `database/migrations.py` exists but its strategy is unverified:
- Versioned migration collection? Unknown.
- Idempotent? Unknown.
- Rollback support? Unknown.
- Applied automatically at startup? Unknown.

**Recommended**: Read `migrations.py` and document the strategy in this file.

---

## Schema Drift Risk

MongoDB is schemaless. Application code and stored documents can drift silently.

**Mitigations present**:
- Pydantic response models (validate on read)
- `/api/data-quality/*` endpoints
- `/api/stocks/validate` (instrument master validation)

**Gap**: No schema version field on documents. Consider adding `schema_version` for future evolution.

---

## Connection Lifecycle

| Event | Behavior |
|-------|----------|
| Startup | Connect with retry (`mongodb_connect_attempts`, `mongodb_connect_retry_delay_s`) |
| Idle | Connections reaped after `mongodb_max_idle_time_ms` |
| Loss | Motor reconnects; writes may fail until reconnected |
| Queue full | `mongodb_wait_queue_timeout_ms` → error returned to caller |
| Shutdown | `app.py` lifespan teardown (exact behavior `NOT_VERIFIED`) |

---

## Capacity Considerations

| Concern | Estimate | Mitigation |
|---------|----------|------------|
| `market_data` volume | Millions of docs/day (universe × ticks) | TTL 24h + bulk insert + buffer cap |
| `audit_log` growth | Moderate; 7y retention | Archive to cold storage (not documented) |
| Pool exhaustion | Possible during market hours | Tune `bulk_insert_size` vs `max_pool_size` |
| Deep scans | Expensive on large collections | `/api/system/data-center/deep-scan` should be off-peak only |

---

## Related Documents
- `DATABASE_ARCHITECTURE.md` — Platform, ownership, indexes
- `DATABASE_COLLECTION_CATALOG.md` — Per-collection schemas
- `../api/API_CATALOG.md` — Data-related endpoints
- `../config/CONFIGURATION_CATALOG.md` — Connection settings
- `../PROJECT_GAPS.md` — GAP-010 (unverified counts)
