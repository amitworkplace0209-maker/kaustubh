# DATA QUALITY BACKEND AUDIT

Date: 2026-10-01
Scope: `python-service/services/data_quality.py`, `python-service/api/quality.py`
Status: AUDITED — defects found, fixed, tested (020)
Related: `docs/engines/DATA_QUALITY.md`, `docs/implementation/020-data-quality-redesign.md`

## What the system actually does

- `services/data_quality.py` is the single authority for metrics, score,
  issues, scans, snapshots. Router `api/quality.py` is a thin facade (20
  routes under `/api/data-quality`).
- Metrics derive from `ticks` (indexed: `ts`, `(symbol,ts)`,
  `(instrumentToken,ts)`), `tick_buffer.stats()`, `ws_manager.status()`,
  `daily_summaries`, `instrument_cache`.
- Score is a deterministic weighted sum over measured dimensions only.
- Issues deduplicate by `key`; resolved rows are kept.
- Duplicate identity is `(instrumentToken, ts, ltp, volume, bp, sp)` with a
  `master_canonical` fallback. Same-price ticks with a distinct broker
  timestamp are NOT duplicates.
- Realtime events publish to `services.event_bus` (SSE `/api/schedule-events/stream`).
- No second broker feed, WebSocket, or Mongo writer exists in this module.
  Duplicate deletes delegate to `db_writer_engine.delete_duplicate_ticks()`.

## Defects found and fixed (020)

| # | Location | Defect | Fix |
|---|---|---|---|
| B1 | `api/quality.py::quality_symbols` | Referenced undefined `start` in the per-symbol duplicate scope → NameError swallowed per symbol → duplicates silently 0 | Scope to the endpoint's own `time_filter` window |
| B2 | same | `$count` returned duplicate GROUP count while the global metric reports excess ROWS Σ(n−1) | Sum excess rows, matching the service identity |
| B3 | same | `outOfOrder` / `invalid` / `missing` hardcoded `0` per symbol (fabricated) | Returned as `null` + `*Measured: false` |
| B4 | `api/quality.py::_compute_all_filtered` | Called `dq_compute_metrics(24, symbol)` ignoring exchange/segment/date/intraday filters; totals filtered but rates unfiltered (mismatched view) | New `extra_match` / `start_override` / `end_override` pass-through in `services/data_quality._compute_metrics` |
| B5 | `services/data_quality._cache_key` | Key was `hours:symbol` → filtered and unfiltered views collided | Key now covers the full filter set |
| B6 | `services/data_quality` ordering walk | Unbounded `find().sort()` over the whole window (page-load stall on 720h) | Capped at 200k docs + 8s timeout, `orderingTruncated` flag, partial count kept |
| B7 | duplicate aggregation | No timeout guard | 8s timeout + `maxTimeMS=15000`, truncated flag via log |
| B8 | `count_documents(total)` | No timeout | 5s timeout, reports 0 with warning on timeout |
| B9 | `/pipeline` | 5 stages (Broker/WebSocket/Normalizer/Validator/Database), no Quality stage, no hop latency | 6 canonical stages (Broker Feed → WebSocket → Validation → Quality → DB Writer → MongoDB) + `pipeline_latency` A–G p50 + per-stage `latencyNote` when NOT MEASURED |
| B10 | `/storage` | No provider identity, no retention contract | Provider (`Atlas`/`Local MongoDB`/`Unknown` via `get_mongo_info()`, never the URI) + retention block (snapshot days real; ticks/issues/archive honestly CONFIGURATION UNAVAILABLE) |

## Deliberately not changed

- Endpoint-level `_CACHE`/`_get_cached` in `api/quality.py` remains unused:
  it is a single global key and would collide across filter sets. The
  service-level 60s full-filter-key cache is the correct layer.
- Completeness stays presence-based (no expected-tick model exists — spec §13).
- Volume integrity stays NOT MEASURED (no pipeline validator exists).
- Snapshots stay global/unfiltered (trend is the engine's own history, not a
  filtered view).
- No new collections, indexes, or TTLs. No secret-bearing fields added
  (provider label carries source/database/host/version/pool only).

## Tests

- `python-service/tests/test_data_quality_020.py` — 11 tests (cache-key
  isolation, window parsing, symbols scope + unmeasured nulls, filtered
  pass-through, 6-stage pipeline honesty, storage retention contract).
- Existing quality suites: 48 passed (`-k quality`), including the 11 new.
