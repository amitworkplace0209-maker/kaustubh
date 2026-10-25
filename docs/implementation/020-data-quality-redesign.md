# 020-data-quality-redesign.md

## Task
Full redesign + logic rebuild + backend engine integration for Data Quality page.

## Objective
Connect the existing comprehensive Data Quality backend service to the frontend, replacing the client-side computed metrics with authoritative backend data. Make realtime quality metrics actually work, implement proper filtering, and make the page fast, responsive, and PWA-ready.

## Scope
- Backend: Data Quality service (`services/data_quality.py`) and API (`api/quality.py`) — already exist and are comprehensive
- Frontend: Move page from `_pages/data-quality` to routable location, redesign to consume backend API
- Realtime: Connect to event bus for live quality updates
- Performance: Fast load via snapshot, progressive enhancement
- Documentation: Engine spec, updated audits, implementation record, verification record

## Out of Scope
- Creating new engines (Data Quality is an observer, not a producer)
- Modifying broker/WebSocket/DB Writer ownership
- Fabricating any data — all metrics must come from real backend computation

## Source Documentation Read
- `PROJECT_IMPLEMENTATION_RULE.md`
- `FINAL_REPORT.md` (discovery bootstrap + 016/017 changes)
- `ENGINE_INVENTORY.md` (engine catalog, 17 registered engines)
- `ENGINE_DEPENDENCY_GRAPH.md` (engine dependencies)
- `DATA_FLOW_MAP.md` (data flow architecture)
- `WEBSOCKET_ARCHITECTURE.md` (4-WS design)
- `OBSERVABILITY_ARCHITECTURE.md` (observability patterns)
- `services/data_quality.py` (authoritative backend service)
- `api/quality.py` (API facade)
- `app/_pages/data-quality/page.tsx` (current frontend — client-side only)
- `lib/api.ts` (Data Quality API client helpers)

## Existing State

### Backend (COMPREHENSIVE, AUTHORITATIVE)
- `services/data_quality.py` — 1055 lines, single source of truth
  - Real metrics from `ticks` collection: completeness, uniqueness, validity, ordering, timestamp, price, volume, persistence
  - Deterministic Quality Score (weighted sum, configurable weights persisted in MongoDB)
  - Issue lifecycle: OPEN → ACKNOWLEDGED → RESOLVED/SUPPRESSED, deduplicated by key
  - Periodic scan runner with persistence to `quality_snapshot`, `quality_issues`, `quality_scans`, `quality_config`
  - Duplicate detection: identity = (instrumentToken, ts, ltp, volume, bp, sp)
  - Freshness from `ws_manager.status().last_tick_at`
  - Pipeline health from `tick_buffer.stats()` (received/written/errors/buffer/latency)
  - Realtime events via event bus: `quality_scan_started`, `quality_scan_completed`, `quality_issue_created`, `quality_issue_updated`, `quality_duplicates_cleaned`

- `api/quality.py` — 1620 lines, thin HTTP facade
  - `/summary` — main overview with score, freshness, pipeline, DB health
  - `/metrics` — detailed metrics with delta vs previous window
  - `/issues` — paginated, filterable issues
  - `/scan` — manual scan trigger
  - `/scan/if-due` — on-demand scan (used when page visited)
  - `/scan/history` — scan run history
  - `/duplicates` — real duplicate groups with identity rule
  - `/dimensions` — detailed dimension scores with pass/warn/fail counts
  - `/symbols` — per-symbol quality with real metrics
  - `/symbol/{sym}` — single symbol detail
  - `/trend` — quality trend from snapshots (today/7d/30d)
  - `/pipeline` — pipeline health stages (Broker → WS → Normalizer → Validator → DB)
  - `/storage` — storage health (Mongo stats, ticks counts, buffer)
  - `/diagnostics` — API/DB/WS latency, records processed

### Frontend (CLIENT-SIDE ONLY, BYPASSES BACKEND)
- `app/_pages/data-quality/page.tsx` — 646 lines, in non-routable `_pages` directory
  - Fetches `getStocks()` + `getRecentTicks(200)` — only last 200 ticks
  - Computes freshness/completeness/consistency locally in React
  - No backend Data Quality API calls at all
  - No filtering, no time ranges, no realtime updates (only reloads on `engine.status` frame)
  - Shows "No data" when no stocks subscribed
  - Not accessible via URL (in `_pages`)

### Architecture Violations
1. Frontend computes metrics instead of consuming authoritative backend service
2. Page not routable (in `_pages`)
3. No realtime quality events consumed
4. Limited to 200 recent ticks vs full windowed analysis
5. No filtering, date ranges, exchange/segment filters functional

## Problems Found
1. **Frontend completely bypasses backend Data Quality API** — all metrics computed client-side from minimal data
2. **Page not accessible** — in `_pages` directory, not mounted in route groups
3. **No realtime updates** — only reloads on engine status, not quality events
4. **No filtering works** — UI has filters but they don't affect backend queries
5. **No historical trend** — chart shows last 10 minutes of local tick buckets, not quality snapshots
6. **No per-symbol quality from backend** — local computation only
7. **No pipeline/storage health** — backend provides `/pipeline` and `/storage` but frontend doesn't use them
8. **No issue management** — backend has full issue lifecycle, frontend shows local issues only
8. **Duplicate management disconnected** — backend has `/duplicates` with delete, frontend doesn't use it
9. **Configuration not connected** — backend has persisted config with weights/thresholds, frontend hardcodes
10. **No loading/error states for degraded backend** — page shows skeleton but no degraded state handling

## Design Decision
Data Quality backend is already the authoritative implementation. The task is to:
1. **Move page to routable location** — `/data-quality` under a route group
2. **Replace all client-side computation** with backend API calls
3. **Connect realtime** — subscribe to `quality_scan_completed`, `quality_issue_created`, `quality_issue_updated` events
4. **Implement progressive loading** — Phase 1: snapshot (`/summary`), Phase 2: realtime pipeline (`/pipeline`), Phase 3: details (`/metrics`, `/dimensions`, `/symbols`), Phase 4: trend (`/trend`) on demand
5. **Make all filters functional** — pass to backend query params
6. **Responsive/PWA** — mobile-first cards, stacked tables, horizontal scroll for filters
7. **Honest states** — LIVE/FRESH/STALE/NO_DATA/NOT_MEASURED/UNAVAILABLE/DISCONNECTED/ERROR

## Files Changed

Backend:
- `python-service/services/data_quality.py` — full-filter cache key; `_compute_metrics`
  gains `extra_match` / `start_override` / `end_override`; 5s total-count timeout;
  duplicate aggregation 8s timeout + `maxTimeMS`; ordering walk capped at 200k docs +
  8s timeout with `orderingTruncated` flag; window payload carries
  `filtered` / `filters` / scan accounting; `_distinct_symbols` honors the slice.
- `python-service/api/quality.py` — `_compute_all_filtered` passes the slice
  through (hours + exchange/segment/date/intraday); `quality_symbols` fixed
  (undefined `start` → window scope, excess-row dup semantics, per-symbol
  ooo/invalid/missing return `null` + `*Measured: false`); `_db_health_payload`
  adds provider identity via `get_mongo_info()`; `/pipeline` rebuilt to 6 canonical
  stages + `pipeline_latency` A–G p50 + `latencyNote`; `/storage` adds retention
  contract + provider/server/pool fields.

Frontend:
- `app/(phase2)/data-saver/quality/page.tsx` — same-origin client; full filter
  wiring (dataset/session/date/exchange/segment/stock debounced/time-range
  toggle); phased loading (1: summary+scan, 2: metrics+pipeline+storage+diag,
  3: symbols+issues+trend/duplicates lazy); scan-completion refreshes scored
  phases; duplicate scan manual-only with 24h cap; nullable per-symbol cells;
  responsive header wrap; corrected Uniqueness definition.

## Files Created
- `docs/engines/DATA_QUALITY.md` — engine specification (purpose, responsibilities,
  non-responsibilities, inputs, dependencies, dimensions, metrics, issues,
  realtime, persistence, database, retention, known limitations, API, performance,
  security, verification).
- `lib/data-quality-client.ts` — same-origin proxy client (`dqGet`/`dqPost`,
  `DataQualityError`, `dqParamsForFilters`).
- `python-service/tests/test_data_quality_020.py` — 11 regression tests.
- `tests/data-quality-client.test.ts` — 6 client tests.
- `docs/audits/DATA_QUALITY_BACKEND_AUDIT.md` — backend audit.
- `docs/audits/DATA_QUALITY_FRONTEND_AUDIT.md` — frontend audit.

## Files Removed
- None. `app/_pages/data-quality/page.tsx` (dead legacy) intentionally left
  untouched; deletion is a separate dead-code decision.

## Backend Changes
- No backend logic changes needed — service and API are complete
- May add minor optimizations (index hints, projection) if query analysis shows need

## Frontend Changes
- New routable page at `app/(dashboard)/data-quality/page.tsx`
- New components for each section (ScoreCards, PipelineHealth, QualityDimensions, SymbolTable, TrendChart, IssuesPanel, StorageHealth)
- Realtime subscription via `useFrontendRealtime` or direct SSE
- Filter state → backend query params
- Responsive layout with proper breakpoints

## Database Changes
- No schema changes — collections already exist: `quality_config`, `quality_snapshot`, `quality_issues`, `quality_scans`
- May add indexes if scan performance requires (analyze during implementation)

## API Changes
- No new endpoints — existing `/api/data-quality/*` are comprehensive
- Frontend will use: `/summary`, `/metrics`, `/dimensions`, `/symbols`, `/trend`, `/pipeline`, `/storage`, `/issues`, `/duplicates`, `/scan/if-due`, `/config`

## Realtime Changes
- Subscribe to event bus events: `quality_scan_completed`, `quality_issue_created`, `quality_issue_updated`, `quality_duplicates_cleaned`
- Update only affected UI sections (scoped state)

## Scheduler/Lifecycle Changes
- Data Quality periodic scan already hooked via `periodic_scan_if_due()` in scheduler
- Page visit triggers `/scan/if-due` for on-demand freshness

## Documentation Changes
- Create `docs/engines/DATA_QUALITY.md` (engine specification)
- Update `docs/audits/backend/DATA_QUALITY_AUDIT.md` (backend audit)
- Update `docs/audits/frontend/DATA_QUALITY_AUDIT.md` (frontend audit)
- Update `FINAL_REPORT.md` with change log
- Create verification record

## Tests
- Backend: `pytest tests/ -k quality` → 48 passed (37 existing + 11 new 020).
- Frontend: `tests/data-quality-client.test.ts` → 6 passed.
- `npx tsc --noEmit` clean. `eslint` on changed files: 0 errors.
- `next build` clean; exactly one `/data-saver/quality` route.
- Full frontend suite: 364/365 (1 pre-existing unrelated failure,
  `topbar-status.test.ts:331`, also failing on 016/017).

## Verification
- See `docs/verification/020-data-quality-redesign-verification.md`.
- Static + automated verification complete; live broker/MongoDB/browser
  verification NOT run (no live system in this session).

## Remaining Issues
- Live broker/MongoDB/browser verification pending (requires running system).
- Responsive widths and PWA standalone not observed in a browser.
- Endpoint-level `_CACHE` in `api/quality.py` intentionally left unwired
  (single global key would collide across filter sets).

## Pending Work
- Live verification with real ticks (freshness, duplicates, persistence,
  symbol quality, issues, recovery).
- Browser layout check at 375/390/430/768/1024/1280/1440/1920.
- PWA standalone + safe-area check on device.

## Final Status
IMPLEMENTED_NOT_VERIFIED (static + automated verification complete; live
broker/MongoDB/browser verification pending)