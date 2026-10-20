# Verification ID
020-data-quality-redesign-verification

# Date / Time
2026-10-01

# Agent
OpenCode (Muse Spark)

# Task / Feature
020 Data Quality redesign: backend engine-integration fixes + frontend rebuild
around real backend data (`/data-saver/quality`).

Related implementation: `docs/implementation/020-data-quality-redesign.md`
Related spec: `docs/engines/DATA_QUALITY.md`
Related audits: `docs/audits/DATA_QUALITY_BACKEND_AUDIT.md`,
`docs/audits/DATA_QUALITY_FRONTEND_AUDIT.md`

# Expected Behavior
1. Metric cache isolates filter sets; filtered views measure their own slice.
2. `/symbols` never raises NameError; per-symbol duplicates use excess-row
   semantics scoped to the window; unmeasured per-symbol cells are null.
3. Ordering walk and duplicate aggregation are bounded (no page-load stall).
4. `/pipeline` reports the 6 canonical stages with honest latency notes.
5. `/storage` reports provider identity (no secrets) and the retention contract.
6. Every page filter reaches the backend query; typing a symbol does not spam.
7. Page loads in phases; duplicates scan only on demand (24h cap).
8. Scan completion refreshes scored phases; issues refresh on quality events.
9. `tsc`, `eslint` (changed files), `next build` clean; one quality route.

# Verification Method
- Static code inspection (read every changed region after editing).
- Unit tests (backend pytest, frontend node --test).
- Typecheck (`npx tsc --noEmit`), lint (eslint changed files), production build.

# Environment
- Backend: NOT RUN (no live MongoDB, no broker in this session).
- Frontend: NOT RUN in a browser (no device/browser available).
- Static + automated only: Python 3.12 venv, Node 22+, Next.js 16.3.4.
- Timezone assertions use Asia/Kolkata where applicable (formatters only).

# Questions / Checks
1. Does the cache key cover the full filter set?
2. Does `quality_symbols` scope duplicates to the window without NameError?
3. Are per-symbol ooo/invalid/missing null (not 0)?
4. Does `_compute_all_filtered` forward hours + slice to the service?
5. Are ordering/dup/count aggregations time-bounded?
6. Does `/pipeline` return 6 stages with latency honesty notes?
7. Does `/storage` return provider + retention without secrets?
8. Does the page pass every filter to the backend (with debounce)?
9. Is duplicate scanning lazy + capped?
10. Do typecheck/lint/build pass with exactly one quality route?

# Expected Results
All checks pass statically and under automated tests; live behavior (real
ticks, real Mongo, real browser) remains NOT_VERIFIED.

# Actual Results
1. PASS — `_cache_key(hours, symbol, extra_match)`; 4 key-isolation tests.
2. PASS — window-scoped `sym_match` (ts `$gte`/`$lt` from `time_filter`);
   excess-row sum; test asserts scope contents and nulls.
3. PASS — `outOfOrder`/`invalid`/`missing` are `None` with `*Measured: false`;
   frontend types nullable, renders `—`.
4. PASS — `extra_match`/`start_override`/`end_override` plumbed; test asserts
   service receives hours=24, exchange, segment, start.
5. PASS — 5s count timeout; 8s dup timeout + maxTimeMS; 200k/8s ordering walk
   with `orderingTruncated` flag.
6. PASS — stages are exactly Broker Feed → WebSocket → Validation → Quality →
   DB Writer → MongoDB; null latencies carry `NOT MEASURED` notes (test asserts).
7. PASS — provider from `get_mongo_info()` (source/database/host/version/pool;
   no URI); retention block with real snapshot days + honest UNAVAILABLE rows.
8. PASS — `dqParamsForFilters` covers hours/symbol/exchange/segment/date/
   time_from/time_to; 3 mapping tests; symbol debounced 500ms.
9. PASS — no auto-load effect; manual Refresh; 24h cap; throttled post-scan
   refresh only when already requested.
10. PASS — `tsc` clean; eslint 0 errors; `next build` clean with exactly one
    `/data-saver/quality` route.

# Evidence
- Command: `python -m pytest tests/ -q -k "quality"` (workdir `python-service`)
  Actual: `48 passed, 1324 deselected` (37 pre-existing + 11 new 020).
- Command: `npx node --test tests/data-quality-client.test.ts`
  Actual: `6 passed`.
- Command: `npx tsc --noEmit -p tsconfig.json` — Actual: clean, no output.
- Command: `npx eslint lib/data-quality-client.ts "app/(phase2)/data-saver/quality/page.tsx" hooks/use-quality-events.ts`
  Actual: 0 errors, 13 pre-existing unused-var warnings.
- Command: `npm run build` — Actual: compiled, TypeScript clean, route table
  contains exactly one `○ /data-saver/quality`.
- Command: `npm test` (full frontend suite) — Actual: 364/365; single failure
  is the pre-existing unrelated `tests/topbar-status.test.ts:331`
  (`canonical session state never invents ACTIVE`), also failing on 016/017.

# Problems Found
1. `quality_symbols` NameError + group-vs-row dup semantics + hardcoded
   per-symbol zeros — FIXED (B1/B2/B3).
2. Filtered views measured the unfiltered scope; cache keys collided — FIXED (B4/B5).
3. Unbounded ordering walk + untimed aggregations — FIXED (B6/B7/B8).
4. Pipeline/storage panels lacked stages/latency/provenance/retention — FIXED (B9/B10).
5. Page fired 7 heavy aggregations per mount/poll/keystroke; duplicates
   auto-swept 720h on load; transport bypassed the same-origin proxy — FIXED (F1–F7).
6. Full-suite frontend failure `topbar-status.test.ts:331` — NOT FIXED (pre-existing,
   unrelated; touches only `lib/topbar-status.ts`).

# Fixes Applied
All fixes in §Problems Found 1–5 are implemented, tested, typechecked, and built
(see implementation record for the file list).

# Re-verification
- Re-ran `pytest -k quality` after each test-harness correction: 48 passed.
- Re-ran `tsc`, `eslint`, `next build` after the final page edit: clean.
- Re-ran the new frontend test file: 6 passed.

# Final Result
IMPLEMENTED_NOT_VERIFIED

# Remaining Risks
- No live MongoDB: aggregation timeouts, index use, and real latency values
  are inferred from code, not observed.
- No live broker/feed: freshness transitions, scan triggers, issue creation,
  and recovery are unverified at runtime.
- No browser: responsive widths (375–1920), PWA standalone, and safe-area
  behavior are unverified visually.
- Large-window filtered metrics: error-rate aggregations run on the
  (hours, symbol, slice) scope; extremely selective slices over huge windows
  still scan via the `ts` index and depend on the timeout guards.
