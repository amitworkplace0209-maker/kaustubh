# DB Writer Engine Implementation Report

**Engine ID:** `db_writer_engine`  
**Engine Name:** DB Writer Engine  
**Version:** 1.0.0 (enhanced with data-loss accounting, deduplication, per-instrument metrics)  
**Category:** STORAGE  
**Phase:** A (Foundation) — Engine 2 of 2  
**Date:** 2026-09-19  
**Report Location:** `docs/engines/reports/DB_WRITER_ENGINE_IMPLEMENTATION_REPORT.md`

---

## Objective

Enhance the existing DB Writer Engine wrapper (which adapts `tick_buffer` + `storage_engine` pipelines into Engine Registry) to meet the target design in `docs/engines/db_writer_engine_detailed.md` for Phase A:
- Data-loss accounting reconciliation (core correctness property)
- Deduplication via broker sequence numbers
- Per-instrument metrics exposure
- Audit pipeline using new Storage Engine's `persistence_pipeline()`
- Comprehensive tests

---

## Changes Summary

### 1. Backend (`python-service/services/db_writer_engine.py`)
- **Data-loss accounting** (`_data_loss_accounting`): Implements the core reconciliation formulas:
  - `RECEIVED = DUPLICATES + INVALID + ACCEPTED`
  - `ACCEPTED = WRITTEN + WRITE_FAILED + PENDING`
  - Uses DB Writer's own ingest counters (`_ingested`, `_rejected`, `_duplicates`) as single source of truth for RECEIVED
  - Exposed in `status_snapshot()["dataLossAccounting"]` with reconciliation booleans
- **Deduplication** (bounded, TTL-based):
  - `_DEDUP_MAXLEN = 50000`, `_DEDUP_TTL_SEC = 300`
  - Keys on `(instrumentToken, sequenceNumber)` — broker sequence is best identity per design
  - No dedup when `sequenceNumber` missing (upstream responsibility)
  - Counters: `_duplicates` tracked separately from `_rejected`
- **Per-instrument snapshot**: Reads `tick_buffer.get_latest_ticks()` + `latest_tick_age_seconds()` + `momentum_windows()` → exposed in `status_snapshot()["instruments"]`
- **Metrics** (`_refresh_metrics`): Added `ingestedFromRouter`, `rejectedByValidation`, `duplicatesRejected`, `acceptedForPersistence`
- **Audit pipeline**: Now uses `storage_engine.persistence_pipeline()` (public method) instead of legacy `queue_size()` shim
- **Ingest path**: Returns `False` for duplicates (not counted as ingested), validates instrument identity

### 2. Storage Engine (`python-service/services/storage_engine.py`)
- Added public `persistence_pipeline()` method wrapping private `_persistence_pipeline()` for clean API

### 3. Tests (`python-service/tests/test_db_writer_engine.py`)
- **17 tests** covering:
  - Identity, lifecycle, health, flush, ingest validation/rejection
  - **New:** deduplication by sequence number, no-dedup without sequence
  - **New:** data-loss accounting in snapshot (receivedEqualsSum)
  - **New:** per-instrument snapshot from tick_buffer
  - **New:** audit uses `persistence_pipeline()`
  - **New:** metrics include accounting fields

### 4. Verification
- All 17 DB Writer tests pass
- All 12 Storage Engine tests pass (no regression)
- TypeScript compiles clean

---

## Deviations from Target Design Doc

| Item | Target (`db_writer_engine_detailed.md`) | Implemented | Notes |
|------|----------------------------------------|-------------|-------|
| Full validation pipeline (basic/instrument/timestamp/field/dedup/quality) | Yes | Partial | Basic + instrument + dedup done; timestamp/field/quality deferred |
| Field-level metrics (VALID/NULL/MISSING/INVALID/UNSUPPORTED) | Yes | No | Deferred — requires schema contract from upstream |
| Recording lifecycle (CREATED/WAITING/STARTING/ACTIVE/DEGRADED/EXPIRING/EXPIRED/STOPPED) | Yes | No | Belongs to Session Manager + Scheduler integration (Phase B) |
| Expiry handling for options/futures | Yes | No | Deferred — requires instrument registry from Session Manager |
| Scheduler integration (LIVE_FEED_STARTED/FEED_STOP_TRIGGERED) | Yes | No | Scheduler Engine not yet implemented (Phase B) |
| Schema versioning | Yes | No | Deferred |
| Replay support | Yes | No | Deferred — separate Replay Engine |
| Data Saver integration | Yes | No | Data Saver UI exists; wiring deferred |
| Retention policies | Yes | No | Deferred |
| MongoDB collection strategy (date-based/time-series) | Yes | No | Current: single `ticks` collection; validated for current volume |

---

## Verification Checklist

- [x] Engine registers at startup (`engine_id: "db_writer_engine"`).
- [x] Lifecycle states transition: `REGISTERED → STARTING → RUNNING → HEALTHY`.
- [x] `/api/services/engines/db_writer_engine` returns pipeline, audit, dataLossAccounting, instruments.
- [x] Data-loss accounting formulas hold for DB Writer's own tracked data.
- [x] Deduplication rejects same `(token, sequenceNumber)` within TTL window.
- [x] No dedup when `sequenceNumber` absent.
- [x] Per-instrument snapshot includes symbol, LTP, tick age, momentum windows.
- [x] Audit block reads from Storage Engine's `persistence_pipeline()`.
- [x] Metrics include `ingestedFromRouter`, `rejectedByValidation`, `duplicatesRejected`, `acceptedForPersistence`.
- [x] All Python tests pass (17/17).
- [x] No regressions in Storage Engine tests (12/12).
- [x] TypeScript compiles clean.

---

## Migration Notes for Deprecated Modules

| Legacy Module | Status | Replacement |
|---------------|--------|-------------|
| `services.storage_engine.queue_size()` | **Repurposed** | Now returns `_persistence_pipeline().queueDepth` (real tick buffer) |
| `services.storage_engine._write_count` / `_error_count` | **Repurposed** | Updated by `_persistence_pipeline()` from tick_buffer stats |

---

## Next Steps (Phase B → Engine 3: Notification Engine)

1. Implement Notification Engine per `docs/engines/notification-engine.md`
2. Add Service Phase UI + sidebar entry
3. Write tests + report

---

## Files Changed

- `python-service/services/db_writer_engine.py` (enhanced)
- `python-service/services/storage_engine.py` (added `persistence_pipeline()`)
- `python-service/tests/test_db_writer_engine.py` (extended to 17 tests)

---

**Status:** ✅ COMPLETE — Ready for Phase B Engine 3 (Notification Engine).