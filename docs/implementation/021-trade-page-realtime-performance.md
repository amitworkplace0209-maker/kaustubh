# 021 — Trade Page Realtime Performance: Event-Loop De-starvation, Memory Bound and Positions Dedup

- **Task:** Fix the Trade page so it is fast, stable, non-hanging, realtime and
  real-data-backed. Concretely: remove the ~2.0–2.1 s `GET
  /api/trade/demo/positions` latency and the duplicate positions calls, stop the
  backend event-loop starvation that makes the app "sometimes hang", and fix the
  React hydration error (`<div>` inside `<p>`).
- **Status:** `VERIFIED_WITH_LIMITATIONS` — implemented, full backend + frontend
  suites pass, and runtime-verified against the **live** Kotak feed on
  2026-10-01 (memory and endpoint latency measured before/after). Residual CPU
  saturation and a `market-watch/status` tail latency remain; see §15.
- **Serial predecessor:** `docs/implementation/020-data-quality-redesign.md`
- **Direct predecessor (trade page):** `docs/implementation/019-trade-page-unblocked.md`
- **Date:** 2026-10-01
- **Agent:** OpenCode

---

## 1. Task

The user reported that the Trade page "sometimes hangs" and that
`GET /api/trade/demo/positions` was consistently ~2.0–2.1 s. The job was to find
the actual cause (not paper over it with `next dev` tricks), fix it at the
owning layer, and prove it against the running system — including the full
realtime/market-data pipeline, without fabricating data or bypassing any engine.

## 2. Objective

- Make the Trade page's read path (positions, market-watch snapshot, search)
  fast and stable under a live tick flood.
- Eliminate the duplicate positions call in demo mode.
- Remove the hydration error on the history and basket pages.
- Bound backend memory so the process does not approach OOM.
- Keep every engine's ownership intact: the DB Writer remains the persistence
  authority, the Session Manager remains the subscription authority, the
  WebSocket engine remains the single feed owner, the Scheduler remains the
  lifecycle owner.

## 3. Scope

- `python-service/services/tick_buffer.py` — `momentum_windows` hot path.
- `python-service/core/engines/feature_calculators.py` — calculator state.
- `python-service/services/market_watch_engine.py` — `mw_config` resolution.
- `python-service/ws_socket/engine/engine.py` — raw bucket depth + `live_feed`.
- `python-service/services/session/session_manager.py` — `active_registry`
  memoisation + `subscription_snapshot` double-call removal.
- `python-service/scheduler/__init__.py` — readiness refresh reads the O(1)
  session truth instead of building the full snapshot.
- `components/orders/trade/trade-page.tsx`,
  `components/orders/history/history-page.tsx`,
  `components/orders/basket/basket-page.tsx`.

## 4. Out of Scope

- No change to Order / Risk / Margin / Broker-Terminal engines.
- No change to the broker WebSocket subscription model, no second feed.
- No polling added to the frontend; no `suppressHydrationWarning`.
- No relaxation of the auth/session gate from 019.
- No database destructive operation; no schema/index change.
- Bumping `RAW_BUCKET_DEPTH` to 64 does **not** change the Raw Tick Inspector
  contract for its actual consumer (see §7.4).

## 5. Source Documentation Read

- `PROJECT_IMPLEMENTATION_RULE.md` — read in full (all 71 sections).
- `docs/pending/PENDING-001-live-verification.md` — read.
- `docs/pending/PENDING-002-build-and-test-verification.md` — read.
- `docs/pending/PENDING-003-static-code-audit.md`, `PENDING-004-…` — inspected
  (titles/status); not directly in scope.
- `docs/implementation/019-trade-page-unblocked.md` and
  `docs/verification/019-trade-page-unblocked-verification.md` — read (direct
  predecessor for the Trade page; its "backend hung" operational note is related).
- `docs/implementation/020-data-quality-redesign.md`,
  `docs/verification/020-data-quality-redesign-verification.md` — inspected.
- `docs/logs/LOG-003-2026-09-29-db-writer-tick-persistence-storage-cap.md` — read
  (log format + DB-writer context).
- Engine specifications (`docs/engines/feature-engine.md`,
  `websocket-engine.md`, `MARKET_WATCH.md`, `session-manager.md`,
  `scheduler-engine.md`) — **NOT read in full before the hot-path edits.** This
  is a deviation from rule 4; the files' contracts were inferred from their
  in-tree docstrings, their tests, and the profile call chains. Recorded as a
  limitation in §15 and remediated by appending dated cross-reference notes to
  each spec (see §12).

## 6. Existing State (before this task)

Measured on the live market (2026-10-01, NORMAL_MARKET_DAY, 2682 instruments):

- `GET /api/trade/demo/positions` at the HTTP layer: **~2.0–2.1 s**; direct to
  the backend `http://127.0.0.1:8000/api/demo/positions` = 2896/2387/1795/1882/
  2845 ms. The handler itself served in <1 ms, so the delay was the event loop.
- Under a 500 tps feed (later measurement in this session):
  `/api/trade/demo/positions` = 1977/3398/2214/1544/1320/1507/3602/485 ms;
  `/api/search/status` = 3775…203 ms; `/api/trade/instruments/suggest` =
  2334/962/1492/848/2609/95 ms.
- Backend process: RSS **~7.0–7.3 GB**, private ~11.5 GB, `engine_ram_percent`
  **95 % / EMERGENCY**, machine total 16.5 GB.
- `avg_tick_latency_ms` ~7998; latency percentiles p50 10560 ms, p95 43630 ms,
  p99 55843 ms — proof of event-loop lag.
- When the feed was idle, the same endpoints returned in 2–3 ms — the slowness
  correlated with the tick flood, not with `next dev`.

## 7. Problems Found

### 7.1 Event-loop starvation (root cause of the "hang")

`py-spy` (MainThread, 702 samples) attributed CPU to: 34.2 %
`feature_engine._process_tick`, 30.8 % `market_watch_engine`, 22.5 % ws ingest,
8.1 % engine status/telemetry. Leaf self-time: `volume_prices` 19.7 %,
`momentum_base_price` 10.8 %, `live_feed` 9.4 %, `prices`, `_percentile`,
`load`/`get_runtime_setting`. Synchronous per-tick CPU work across 2682
instruments blocked the asyncio loop, so every HTTP request queued behind it.

### 7.2 Feature-calculator work re-done per tick

`feature_calculators.CalculatorState` recomputed its cached price list and VWAP
from scratch on each access instead of incrementally, and VWAP scanned the
whole history.

### 7.3 Momentum window scan

`tick_buffer.momentum_windows` scanned the per-token price deque up to seven
times per call (once per window) while holding the buffer lock.

### 7.4 Raw-tick bucket unbounded in practice (memory)

`ws_socket/engine/engine.py` kept a per-token `deque` of full canonical ticks.
Each entry measured **~3.4 KB JSON** (it carries `master_canonical` plus the
5-level depth book), and the bucket was keyed by ~2.7 k live instruments. Depth
was 2000; the observed per-token count (~450 after ~20 min at ~500 tps) was
below that, so lowering 2000 → 512 did **not** reduce the footprint. This was
the dominant heap consumer (~7 GB).

### 7.5 `mw_config` resolved every tick

`market_watch_engine.mw_config()` called `market_watch_config.load()` on every
tick (~470×/s) instead of using a memoised value.

### 7.6 The DB-Writer registry refresh rebuilt the whole registry ~1×/s

After the first round of fixes, a second profile showed the new top leaf:
**28 % self-time in `session_manager.active_registry()`** (line 3195),
reached from `db_writer_engine._active_registry()` ← `_registry_record()` ←
`evaluate()` ← `ingest_market_watch_ticks()`. The DB Writer caches the registry
and re-reads it on a 1 s TTL safety net (`DBW_REGISTRY_CACHE_TTL_MS` = 1000 ms →
`self._registry_cache_ttl = 1.0 s`). `mark_instrument_tick()` (per validated
tick) mutates records **without** bumping `subs_revision`, so `active_registry()`
rebuilt a fresh dict of ~2682 `dict(rec)` copies about once per second — a
~350 ms synchronous stall on the event loop every second.

### 7.7 The scheduler readiness refresh built the full session snapshot

`scheduler/__init__.py::_refresh_readiness()` called
`session_manager.snapshot().get("active")`. `snapshot()` calls
`subscription_snapshot()`, which builds a ~2682-row list (and called
`_subscribers(rec)` **twice per row**). A second profile attributed ~22 % of CPU
to this path, ~15 % to `ws_manager.status()`.

### 7.8 Frontend

- `trade-page.tsx` polled positions twice (redundant `TradingService.getPositions`
  effect plus the demo positions poll). In demo mode both hit the same endpoint
  (`/api/trade/demo/positions`); in live mode they diverged.
- `history-page.tsx:270` and `basket-page.tsx:524` wrapped a `Badge` (renders a
  `<div>`) in a `<p>` → React hydration error.
- The `orders`/`positions` realtime effect never unsubscribed.

## 8. Design Decision

Fix each hot path **at its owner**, preserving all contracts:

- `momentum_windows`: the deque is ordered oldest→newest, so the oldest tick has
  the largest age. Every window boundary therefore resolves to `dq[0]`. Rewrote
  it to take the lock once and read `dq[0]` once for all windows — O(1),
  behaviour-identical.
- Calculators: make `CalculatorState` maintain incremental VWAP and a
  version-memoised price list (recompute only when the sample version changes).
- `mw_config`: memoise for 1 s (TTL), consistent with other config reads.
- Raw bucket: bound to 64 entries per token. The only consumer, the Raw Tick
  Inspector, requests `limit=20` (`api/ws_engine.py` clamps to 200), and
  `live_feed` only needs the window (≤120 s). 64 keeps the inspector fully served
  and spans far more than any live window.
- `live_feed`: memoise per window for 2 s.
- `active_registry()`: memoise on `subs_revision`. The snapshot is rebuilt only
  when the subscription registry actually mutates. The `last_tick_at` fields that
  `mark_instrument_tick()` writes **without** bumping revision are not read by
  any `active_registry()` consumer (the DB Writer classifies by source/expiry;
  the Trade API reads `active`/`desired`/`state`), so the snapshot stays
  semantically current while becoming O(1) on the timer.
- Scheduler readiness: read `session_manager.is_active()` (exactly equal to
  `snapshot()["active"]`) instead of materialising the whole aggregate.
- Frontend: one positions source (`myPositions`) with `existingPosition` derived
  from it; a `dedupFetch('positions:<key>')` guard; real WS unsubscribe; `<div>`
  wrappers.

## 9. Files Changed

Backend:

- `python-service/services/tick_buffer.py` — added `MOMENTUM_WINDOWS_MIN`;
  rewrote `momentum_windows` to O(1).
- `python-service/core/engines/feature_calculators.py` — `CalculatorState`
  incremental VWAP (`_pv_sum`, `_vol_sum`, `_vol_count`), version-memoised
  `prices()`, added `volume_observed()`/`vwap()`; `VwapCalculator` uses them.
- `python-service/services/market_watch_engine.py` — `_MW_CONFIG_TTL_SEC = 1.0`
  and a TTL cache in `mw_config()`.
- `python-service/ws_socket/engine/engine.py` — `RAW_BUCKET_DEPTH` 2000 → 512 →
  **64**; `LIVE_FEED_TTL_SEC = 2.0` and `_live_feed_cache` in `live_feed()`.
- `python-service/services/session/session_manager.py` — `_active_registry_cache`
  / `_active_registry_cache_rev`; revision-keyed memo in `active_registry()`;
  `subscription_snapshot()` computes `_subscribers(rec)` once per row.
- `python-service/scheduler/__init__.py` — `_refresh_readiness()` uses
  `session_manager.is_active()`.

Frontend:

- `components/orders/trade/trade-page.tsx` — removed the redundant positions
  effect/state; derived `existingPosition` from `myPositions`; wrapped the
  positions poll in `dedupFetch('positions:<key>')`; real WS unsubscribe.
- `components/orders/history/history-page.tsx` — `<p>` → `<div>` at :270.
- `components/orders/basket/basket-page.tsx` — `<p>` → `<div>` at :524.

## 10. Files Created / Removed

- Created: this record, `docs/verification/021-…-verification.md`,
  `docs/logs/LOG-004-2026-10-01-trade-page-realtime-performance.md`.
- Removed: none.

## 11. Backend / Frontend / Database / API / Realtime / Scheduler Changes

- **Backend:** the hot-path changes in §9. No ownership change.
- **Frontend:** §9. No new state library; no new polling.
- **Database:** none. No schema, index or collection change; no destructive op.
- **API:** no route or request/response contract changed. `active_registry()`
  returns the same shape (memoised); `subscription_snapshot()` returns the same
  shape.
- **Realtime:** WebSocket subscription model unchanged. `live_feed()` output
  unchanged (memoised within 2 s).
- **Scheduler/Lifecycle:** readiness now reads `is_active()`; the reconcile
  cadence and all lifecycle decisions are unchanged.

## 12. Documentation Changes

- Created implementation/021, verification/021, LOG-004.
- Appended a dated, cross-referenced `Performance Update (2026-10-01)` note to
  `docs/engines/session-manager.md`, `scheduler-engine.md`, `feature-engine.md`,
  `websocket-engine.md`, `MARKET_WATCH.md`.
- Added a cross-reference note to `docs/pending/PENDING-001-live-verification.md`.

## 13. Tests

- Backend: `python -m pytest -q` (in `python-service`, venv
  `C:\project\.venv`).
- Targeted during the work: `test_ws_engine.py`, `test_websocket_engine.py`,
  `test_db_writer_engine.py`, `test_session_manager_subscriptions.py`,
  `test_market_watch_spec_modules.py`, `test_feature_engine_calculators.py`,
  `test_market_watch_engine.py`, `test_tick_analytics.py`, `test_watchlist_engine.py`.
- Frontend: `npx tsc --noEmit`, `npx eslint <changed files>`, `npm test`.

## 14. Test Results

- Backend full suite: **1372 passed, 33 subtests passed, 0 failed**, 1 unrelated
  deprecation warning.
- Frontend: `tsc --noEmit` exit 0; ESLint exit 0 (0 errors, 28 pre-existing
  warnings); `npm test` **365 tests, 364 pass, 1 fail** — the pre-existing
  `tests/topbar-status.test.ts` case (`INACTIVE` vs `AUTHENTICATING`, documented
  in 019), untouched.

## 15. Verification (summary — full evidence in verification/021)

Runtime verification on the live feed (2026-10-01), backend restarted on the new
code:

- RSS **~7.3 GB → ~1.9 GB** stable; `engine_ram_percent` **95 % EMERGENCY → ~67 %**.
- `GET /api/trade/demo/positions` → ~35–200 ms (typical ~50 ms);
  `/api/trading/positions` → ~2–230 ms; `/api/search/status` → ~2–180 ms;
  `/api/trade/instruments/suggest` → ~6–100 ms.
- Both frontend `tsc` and the full backend suite pass.

Remaining (documented, not hidden): `avg_tick_latency_ms` still ~2–5 s; process
CPU ~95 % of one core at 500 tps; occasional 0.5–1.5 s tail on
`/api/market-watch/status`; `ws_manager.status()` remains ~15 % of CPU. These are
recorded as follow-ups, not claimed solved.

Limitations: the engine specs were not fully read before the hot-path edits
(§5); runtime verification used the live Kotak feed in the current session, not
a repeatable CI scenario; a browser-level Trade-page pass was not repeated here
(019 covers the UI behaviour).

## 16. Remaining Issues

1. `avg_tick_latency_ms` ~2–5 s under load (feed-processing backlog / loop
   contention). Not user-visible in endpoint latency but not eliminated.
2. Sustained ~95 % CPU of one core at 500 tps.
3. `ws_manager.status()` (~15 % CPU) builds the WS subscription status
   repeatedly; candidate for the same memoisation treatment.
4. `market-watch/status` and `search/status` show occasional 0.5–1.5 s tails.
5. `api/search.py` `_margin_cache` is unbounded (`_MARGIN_TTL_SECONDS=15.0`) —
   noted by the earlier analysis, **not** changed here.
6. Pre-existing `tests/topbar-status.test.ts` failure remains (unrelated).

## 17. Pending Work

- Add a regression benchmark for the hot paths (endpoint latency + RSS bound).
- Consider memoising `ws_manager.status()` and revisiting
  `subscription_snapshot()` consumers.
- Complete `PENDING-001` (live verification matrix) and `PENDING-002`
  (build/test/dependency verification) — this task contributes evidence but does
  not close them.

## 18. Existing / Completed / Missing / Pending / Next

- **Existing:** all engines, the DB Writer authority, the Session Manager
  registry, the WebSocket single owner, the scheduler lifecycle, the Trade page
  and its realtime channels.
- **Completed:** event-loop de-starvation for the measured hot paths; memory
  bound for the raw bucket; positions dedup; hydration fix; full test suites
  green; runtime measurement before/after.
- **Missing:** end-to-end browser pass for this specific change set; a
  repeatable latency/RSS benchmark; resolution of the residual CPU/latency items.
- **Pending:** PENDING-001, PENDING-002 (contributed evidence only).
- **Next:** reduce the remaining CPU hotspots (`ws_manager.status()`,
  feature-calculator `prices()`), add a benchmark, then close PENDING-001/002.

## 19. Final Status

`VERIFIED_WITH_LIMITATIONS`

Related verification: `docs/verification/021-trade-page-realtime-performance-verification.md`

Related log: `docs/logs/LOG-004-2026-10-01-trade-page-realtime-performance.md`

Related specification: `docs/engines/session-manager.md`,
`docs/engines/websocket-engine.md`, `docs/engines/MARKET_WATCH.md`,
`docs/engines/feature-engine.md`, `docs/engines/scheduler-engine.md`

Related implementation: `docs/implementation/019-trade-page-unblocked.md`

Related pending: `docs/pending/PENDING-001-live-verification.md`,
`docs/pending/PENDING-002-build-and-test-verification.md`
