# Verification ID

021-trade-page-realtime-performance-verification

# Date / Time

2026-10-01

# Agent

OpenCode

# Task / Feature

021 — Trade page realtime performance: event-loop de-starvation, raw-bucket
memory bound, positions dedup and hydration fix.

# Related Implementation Record

`docs/implementation/021-trade-page-realtime-performance.md`

# Environment

- Frontend: Next.js 16.3.4, React 19.2.8, Node v24.18.0, at `C:\project`.
- Backend: FastAPI in `C:\project\python-service`, venv
  `C:\project\.venv\Scripts\python.exe` (base Python 3.12).
- Broker: Kotak, **dummy** mode, live market feed (~500 tps).
- Instruments: 2682. Backend on `127.0.0.1:8000`.
- Py-spy profiles: 4000 Hz samples of the backend MainThread.

# Code Under Test

- `services/tick_buffer.py` — `momentum_windows` O(1).
- `core/engines/feature_calculators.py` — incremental VWAP + memoised `prices`.
- `services/market_watch_engine.py` — `mw_config()` TTL 1 s.
- `ws_socket/engine/engine.py` — `RAW_BUCKET_DEPTH=64`, `LIVE_FEED_TTL_SEC=2.0`.
- `services/session/session_manager.py` — revision-keyed `active_registry()`;
  `subscription_snapshot()` single `_subscribers` call.
- `scheduler/__init__.py` — readiness via `session_manager.is_active()`.
- `components/orders/trade/trade-page.tsx`,
  `components/orders/history/history-page.tsx`,
  `components/orders/basket/basket-page.tsx`.

---

# A. Root-cause verification (py-spy)

## A.1 Baseline profile — event loop blocked in tick work

MainThread, 702 samples: `feature_engine._process_tick` 34.2 %,
`market_watch_engine` 30.8 %, ws ingest 22.5 %, engine status/telemetry 8.1 %.
Leaf self-time: `volume_prices` 19.7 %, `momentum_base_price` 10.8 %,
`live_feed` 9.4 %, plus `prices`, `_percentile`, `load`/`get_runtime_setting`.

**Result:** PASS — the event loop is saturated by synchronous per-tick work
across 2682 instruments. This is the mechanism behind the ~2 s request latency
and the "hang".

## A.2 Post-fix profile — the next bottleneck exposed

After the calculators/momentum/`mw_config`/bucket fixes, a second profile showed
`session_manager.active_registry()` at **28 % self-time**,
reached from `db_writer_engine._active_registry()` ← `_registry_record()` ←
`evaluate()` ← `ingest_market_watch_ticks()`. Cause: the DB Writer 1 s registry
TTL safety net (`DBW_REGISTRY_CACHE_TTL_MS=1000` → `self._registry_cache_ttl=1.0`)
rebuilt ~2682 `dict(rec)` copies ~1×/s (~350 ms stall/s) because
`mark_instrument_tick()` mutates records without bumping `subs_revision`.
Also `subscription_snapshot` (~22 %, via `scheduler._refresh_readiness`) and
`ws_manager.status()` (~15 %).

**Result:** PASS — identified the second loop-stall source and the fixed
`active_registry()` memo removes it.

---

# B. Latency verification (HTTP, live backend)

Measured directly against `http://127.0.0.1:8000`.

## B.1 Before

| Endpoint | Measured (ms) |
|---|---|
| `/api/demo/positions` (= `/api/trade/demo/positions`) | 2896 / 2387 / 1795 / 1882 / 2845 |
| `/api/trade/demo/positions` | 1977 / 3398 / 2214 / 1544 / 1320 / 1507 / 3602 / 485 |
| `/api/search/status` | 3775 … 203 |
| `/api/trade/instruments/suggest` | 2334 / 962 / 1492 / 848 / 2609 / 95 |

With the feed idle the same endpoints returned in 2–3 ms — correlation with the
tick flood confirmed.

## B.2 After

- `GET /api/trade/demo/positions`: **~35–200 ms** (typical ~50 ms).
- `GET /api/trading/positions`: **~2–230 ms**.
- `GET /api/search/status`: **~2–180 ms**.
- `GET /api/trade/instruments/suggest`: **~6–100 ms**.

**Result:** PASS — the multi-second spikes are gone; the remaining worst case is
sub-250 ms, well inside the page's budgets.

---

# C. Memory verification

| Metric | Before | After |
|---|---|---|
| Backend RSS | ~7.0–7.3 GB | ~1.9 GB stable |
| Backend private | ~11.5 GB | (reduced proportionally) |
| `engine_ram_percent` | 95 % / EMERGENCY | ~66–71 % |
| Machine RAM | 95 % | ~67 % |

The drop is attributable to bounding the per-token raw bucket
(`RAW_BUCKET_DEPTH` 2000 → 64) whose entries measured ~3.4 KB JSON each. The
512 intermediate value did **not** reduce the footprint (per-token count ~450 <
512); 64 does.

Feed cadence after the fixes: `ticks_60s_average` = 479.3, current ~500 tps
(feed resumed and healthy).

**Result:** PASS — bounded, stable, no EMERGENCY RAM state.

---

# D. Functional / contract verification

- Raw Tick Inspector still served: only consumer uses `limit=20`; API clamps to
  200; depth 64 ≫ 20. Its contract is unchanged.
- `live_feed(window_sec)` output shape unchanged; 2 s memo covers the client's
  refresh period.
- `active_registry()` returns the same dict shape; memo invalidates on
  `subs_revision`. No consumer reads the unbumped `last_tick_at` (DB Writer
  classifies by source/expiry; Trade API by `active`/`desired`/`state`).
- `subscription_snapshot()` shape unchanged (only the duplicate `_subscribers`
  call removed).
- Scheduler readiness: `snapshot()["active"]` is exactly `is_active()`; behaviour
  identical.
- Frontend: one positions source; `dedupFetch` prevents the duplicate call;
  WS unsubscribe fires on cleanup; `<div>` wrappers remove the hydration error.

**Result:** PASS.

---

# E. Test-suite verification

## E.1 Backend (full)

```
cd C:\project\python-service
C:\project\.venv\Scripts\python.exe -m pytest -q
```

Result: **1372 passed, 33 subtests passed, 0 failed** (1 unrelated deprecation
warning).

Targeted files run during the work (all green): `test_ws_engine.py`,
`test_websocket_engine.py`, `test_db_writer_engine.py`,
`test_session_manager_subscriptions.py`, `test_market_watch_spec_modules.py`,
`test_feature_engine_calculators.py`, `test_market_watch_engine.py`,
`test_tick_analytics.py`, `test_watchlist_engine.py`.

## E.2 Frontend

```
npx tsc --noEmit        -> exit 0
npx eslint <changed>    -> exit 0 (0 errors, 28 pre-existing warnings)
npm test                -> 365 tests: 364 pass, 1 fail
```

The single failure is the pre-existing, unrelated
`tests/topbar-status.test.ts` case ("canonical session state never invents
ACTIVE"; actual `INACTIVE` vs expected `AUTHENTICATING`), already documented in
verification 019.

**Result:** PASS (with the pre-existing known failure, unchanged).

---

# F. Runtime restart verification

- Backend restarted on the fixed code using the **venv** Python
  (`C:\project\.venv\Scripts\python.exe`). The system Python lacks uvicorn; the
  venv launcher re-execs base Python as a child that owns the port. Both
  processes were terminated on restart to avoid port conflict.
- After restart: feed reconnected, ~500 tps, RAM ~1.9 GB, endpoints fast.

**Result:** PASS.

---

# Overall Result

**VERIFIED_WITH_LIMITATIONS**

Verified: root cause, latency reduction, memory bound, contract preservation,
full backend suite, frontend type/lint/tests, live restart.

Not verified / limitations:

- `avg_tick_latency_ms` remains ~2–5 s; process CPU ~95 % of one core at
  500 tps.
- Occasional 0.5–1.5 s tails on `/api/market-watch/status`; `ws_manager.status()`
  remains ~15 % of CPU.
- Engine specs were not fully read before the hot-path edits (remediated by
  appended dated notes and this record).
- No fresh browser-level Trade page pass in this session (019 covers UI
  behaviour); no repeatable CI benchmark added yet.

# Evidence Statement

All measurements above were taken against the running backend/feed in this
session on 2026-10-01. No values were fabricated or adjusted by hand. Endpoint
timings are wall-clock samples; RSS/RAM are process/system readings; profile
percentages are py-spy MainThread sample shares.

# Related Files

- `docs/implementation/021-trade-page-realtime-performance.md`
- `docs/logs/LOG-004-2026-10-01-trade-page-realtime-performance.md`
- `docs/engines/session-manager.md`, `docs/engines/websocket-engine.md`,
  `docs/engines/MARKET_WATCH.md`, `docs/engines/feature-engine.md`,
  `docs/engines/scheduler-engine.md`
- `docs/verification/019-trade-page-unblocked-verification.md`
