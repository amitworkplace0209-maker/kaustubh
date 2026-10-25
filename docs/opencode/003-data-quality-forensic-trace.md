# 003 — Data Quality forensic trace (020 working file)

Date: 2026-10-01
Purpose: preserve the audit trail behind the 020 redesign so a future agent can
retrace it without re-reading 3000+ lines. Permanent knowledge lives in the
spec / audits / implementation / verification records; this file is the
scratch trace.

## Starting confusion (corrected during the task)

The task brief pointed at "the Data Quality screenshot" and `_pages`-era
symptoms. First audit read `app/_pages/data-quality/page.tsx` (646 lines,
client-side only, `getStocks()` + `getRecentTicks(200)`) and concluded the
frontend bypassed the backend entirely. That file is DEAD legacy (one of 73
dead `_pages` per `FRONTEND_PAGES_AUDIT.md`). The canonical page is
`app/(phase2)/data-saver/quality/page.tsx` (1877 lines, route
`/data-saver/quality`, full backend integration). The implementation record
was corrected to reflect this.

## Forensic findings (all verified in code, then fixed)

1. `api/quality.py::quality_symbols` used bare `start` (undefined) inside the
   per-symbol dup scope → NameError → caught by the per-symbol `except` →
   duplicates silently 0 for every symbol. Also `$count` (groups) vs global
   excess rows Σ(n−1).
2. `_compute_all_filtered` called `dq_compute_metrics(24, symbol)` — the
   exchange/segment/date/intraday slice never reached the error-rate
   aggregations. Totals filtered, rates unfiltered.
3. `_cache_key(hours, symbol)` collided across filter sets.
4. Ordering walk `find(match).sort("ts",1)` unbounded in Python — the 720h
   page-load stall root cause. `api/system.py` already had the bounded
   pattern (limit + 5s timeout); the quality service did not.
5. Frontend `params` memo passed only hours + symbol; 6 of 8 controls were
   decorative. Symbol input had no debounce (full refresh per keystroke).
6. `refreshNow` fired 7 heavy endpoints in parallel per mount/poll; duplicates
   auto-swept 720h on mount.
7. Transport used direct loopback (`API_BASE`) instead of the existing
   same-origin proxy (`app/api/data-quality/[...path]`).
8. A second `useQualityEvents(true)` call was introduced mid-edit (would have
   opened a second SSE stream) — caught by grep, merged immediately.

## Fix shapes chosen

- Service `_compute_metrics` gained optional `extra_match`/`start_override`/
  `end_override` (default None → zero behavior change for existing callers
  like `run_scan`).
- Per-symbol unmeasured cells are `null` + `*Measured: false`, not 0.
- Endpoint `_CACHE` left unwired deliberately (single global key).
- Duplicates: lazy + 24h cap + manual trigger (not auto).
- Dead `_pages` copy left alone (separate dead-code decision).

## Test notes

- Backend mocks: `instrument_cache.loaded` is a property (no setter) — patch
  the whole `instrument_cache` object. Async endpoints need `AsyncMock`.
  Motor cursors in fakes need `to_list(*a, **k)` (both positional and
  `length=` call styles exist).
- Full backend suite was NOT run (1324 tests, time); `-k quality` (48) covers
  the touched modules. Recommend a full run before the live pass.
- Frontend full suite: 364/365; the 1 failure is pre-existing
  (`topbar-status.test.ts:331`), identical on 016/017.

## Next session entry point

Live pass needs: test DB (`kaustubh_test`), dummy broker, backend restart
(port 8000 may host a stale process — see PENDING-004 "Do This First"),
then drive `/data-saver/quality`: scan-if-due → summary → duplicates (24h) →
filters → trend → recovery. Record observed numbers in a new verification
record; do not claim COMPLETE without them.
