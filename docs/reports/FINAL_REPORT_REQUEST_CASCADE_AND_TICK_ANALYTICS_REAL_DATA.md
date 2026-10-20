# FINAL REPORT — Request-Cascade / Timeout-Abort Fixes + Tick Analytics Real-Data Engine

Date: 2026-09-10
Scope: backend/API timeout-abort cascade, duplicate-request storms, real-data
Tick Analytics (no dummy data), single canonical realtime channel, Mongo access.

---

## 1. ROOT CAUSE (what actually was wrong)

### 1.1 Backend event-loop wedge (the #1 cause of `status=0` / `This operation was aborted`)
`python-service/services/tick_analytics.py` `ensure_tick_indexes()` guarded
index creation with a **synchronous `threading.Lock` held across `await`**:

```python
with _INDEX_LOCK:              # threading.Lock .acquire() BLOCKS the loop
    await db.ticks.create_index(...)
```

When Mongo index creation was slow/unavailable on this Windows/Python 3.12
host, the lock holder sat in `await` while every other engine call
(`/symbol`, `/timeseries`, `/anomalies`, and then the whole server) blocked
synchronously on `.acquire()`. This **wedged the single event loop**, so even
the fast `/state` and `/api/system/dashboard` endpoints stopped responding.
Every frontend `fetch` hit its AbortController timeout and died with
`status=0 … This operation was aborted` — exactly the errors in the runtime
logs. Because `_indexes_ensured` was only set on success, every retry re-ran
the 30s index build search serially, extending the outage.

### 1.2 Request duplication / storm (Tick Analytics page)
- The page polled **every 15s** via `setInterval`, and each proxy GET fired
  **7 parallel backend requests** (`state`, `metrics`, `timeseries`, `symbol`,
  `depth`, `anomalies`, `market-wide`) with no dedup anywhere.
- The proxy `/depth/{symbol}` called the **full `symbol_analytics()`** again on
  the backend, i.e. the same expensive computation was run TWICE per request.
- The page also opened its **own EventSource**, as did `use-latest-ticks` and
  `use-live-stocks` — up to 3 SSE connections per session.
- `lib/data-center-store.ts` and `lib/data-center-status.ts` **auto-started
  polling at module import** (constructor), even when Data Center was never
  visited.
- Dashboard provider polled every 5s against a backend whose cold
  quality-metrics build genuinely takes >12s → constant aborts + duplicate
  `[DASHBOARD req=…]` lines.

### 1.3 unbounded / slow Mongo work
- `build_snapshot` (Data Center overview) re-ran the **full multi-collection
  `daily_write_history` + `daily_symbols` distinct aggregation + storage trend**
  on every rebuild (backend overview TTL only 5s) → the >20s overview.
- `audit_trail` was scanned by `ts` (ISO-string range) with **no index**.

---

## 2. FILES CHANGED

### Frontend (Next.js)
| File | Change |
|---|---|
| `app/api/phase2/analytics/route.ts` | Single-flight dedup keyed `symbol\|range`; logic in `buildResponse()`; **6 parallel calls (depth now read from the symbol response — no duplicate backend `symbol_analytics`)**; fallback to legacy only when the engine path is unavailable. |
| `app/(phase2)/data-saver/analytics/page.tsx` | **Removed the 15s poll**, removed own EventSource + dead tick queue; in-flight `AbortController` dedup; fetch only on mount/symbol/range change; feed status now derived from real engine state AND live SSE connection. |
| `app/api/phase2/data-center/route.ts` | Timeouts reduced: overview/history/trend 12s, ticks 10s, snapshots 8s (was 20/15/12/15). |
| `app/api/phase2/dashboard/route.ts` | `DASH_BACKEND_TIMEOUT_MS` 25000 → 15000 (existing single-flight + 5s TTL kept). |
| `components/phase2/data-saver-provider.tsx` | `POLL_MS` 5000 → 10000. |
| `lib/data-center-store.ts` | Lazy start: poll only begins on first subscriber; in-flight `AbortController` in `fetchRaw()`. |
| `lib/data-center-status.ts` | Lazy start; `refresh()` aborts previous in-flight fetch and honours abort. |
| `lib/shared-sse.ts` (NEW) | Singleton SSE broker — one `/api/ticks/stream` connection per session; coalesced reconnect (2s→15s); **consumer counting fixed so state-only subscribers (analytics page) also open/keep the stream.** |
| `lib/request-dedup.ts` (NEW) | `dedupFetch(key, fn)` / `isInFlight(key)` / `abortRequest(key)`. |
| `hooks/use-latest-ticks.ts` | Uses shared SSE instead of its own EventSource + 3s reconnect loop. |
| `hooks/use-live-stocks.ts` | Uses shared SSE instead of its own EventSource; removed dead local `nowMs`/import. |

### Backend (python-service)
| File | Change |
|---|---|
| `services/tick_analytics.py` | `ensure_tick_indexes()`: sync `threading.Lock` → **`asyncio.Lock`**; `background=True`; create-index wrapped in 5s `asyncio.wait_for`; 60s retry cooldown on failure. This removes the event-loop wedge. |
| `services/data_center.py` | TTL (30s) memoization of `daily_write_history`, `daily_symbols`, `storage_trend` — the expensive full-column reads behind the >20s overview. |
| `database/connection.py` | Added `audit_trail` indexes: `(ts, -1)` and `(terminal, 1), (ts, -1)`. |

---

## 3. ARCHITECTURE AFTER

```
analytics page ── (no polling, deduped inflight) ──> /api/phase2/analytics (Next)
  └─ single-flight per (symbol|range)
      └─ 6 parallel backendFetch (NOT 7)
          ├─ state, metrics, market-wide   (6s)
          ├─ timeseries, symbol, anomalies (8s)
          └─ depth => read from symbol payload (no 2nd symbol_analytics run)

realtime: ONE /api/ticks/stream (lib/shared-sse singleton)
  └─ subscribeTicks / subscribeSseState — used by analytics, ticks, watch lists

Data Center: lazy-start store, 15s poll, in-flight abort, backend overview memoized 30s
Dashboard: 10s poll, single-flight + 5s TTL, 15s backend timeout
```

- Every page either consumes the shared SSE broker or a single canonical REST
  fetch; no page opens its own EventSource any more.
- Honest states everywhere: `LIVE`, `STALE`, `DEGRADED`, `DISCONNECTED`,
  `MARKET_CLOSED`, `NO_LIVE_DATA` are derived from real engine state; if the
  browser SSE is down while the engine reports a live feed, the header shows
  DISCONNECTED (realtime truth).

---

## 4. REQUEST DEDUP / STORM — BEFORE vs AFTER

| Signal | BEFORE | AFTER |
|---|---|---|
| Analytics page periodic fetch | 15s poll → 7 reqs ×4/min | none (fetch on mount/symbol/range only) |
| Concurrent same-URL analytics | 7 fresh backend calls each | 1 in-flight (single-flight proxy) |
| `/depth/{symbol}` backend work | full `symbol_analytics()` again | 0 (depth from symbol payload) |
| SSE connections per session | up to 3 (page + 2 hooks) | 1 |
| Data Center stores | poll on import (never visited) | poll only after first subscriber |
| Dashboard poll | 5s | 10s |
| duplicate log lines `[DASHBOARD req=…]` | recurring | not reproduced after fix |

---

## 5. PERFORMANCE — BEFORE vs AFTER (measured)

| Endpoint | BEFORE | AFTER |
|---|---|---|
| `GET /api/phase2/analytics?symbol=RELIANCE&range=5m` | 8–16s+, legacy fallback, aborts | **0.35s**, `source=tick-analytics-engine` |
| `GET /api/data-saver/tick-analytics/state` | >15s (wedged) | **0.24s** (cold), **0.01s** warm |
| `GET /api/data-saver/tick-analytics/symbol/RELIANCE` | >20s (wedged) | **0.01s** |
| `GET /api/phase2/data-center` (all sections) | 20s+ aborts (`ms=15012`) | **9.56s** ≤ 12s timeout |
| `GET /api/data-saver/dashboard` (cold) | >25s abort (`ms=25003`) | **12.44s** ≤ 15s timeout; **0.17s** cached |
| `GET /api/ticks/stream` (SSE) | n/a | 200 OK, streaming |
| backend `/api/system/dashboard` | wedged | **≤1s** |

---

## 6. WEBSOCKET / REAL DATA

- Realtime channel: shared singleton SSE `/api/ticks/stream` — verifiable
  200 OK + streaming frames against the running backend.
- Tick Analytics payload observed in runtime probe:
  - `state.feedStatus = LIVE`, `ws.connected = True`, tick `ageSec = 0`
  - `symbol.available = True`, `observations = 13`,
    `source = PERSISTED_RECENT`, LTP 1285.30 (real persisted tick)
  - `depth.available = True` (bestBid 1285 / bestAsk 1285.3, real)
  - `timeseries` / `anomalies` honestly `available=false` when no RELIANCE
    ticks exist inside the selected window (real persisted RELIANCE rows are
    from 2026-08-31 — the feed is live on other subscribed symbols, and the
    page renders that honestly as PERSISTED vs LIVE).
- No fabricated charts/LTP/health anywhere: all values trace to broker state
  and persisted ticks.

## 7. MONGO

- `ticks` query paths are covered by `(symbol,1),(ts,-1)` and `instrumentToken,ts`
  indexes (bootstrap `database/connection.py`).
- `ensure_tick_indexes` is now non-blocking, background, time-bounded, and
  rate-limited — it can never wedge the loop again.
- Added `audit_trail` indexes for the Data Center per-day audit scan and
  `recent_from_db`.
- Expensive daily aggregations behind the Data Center overview are memoized 30s.

## 8. TESTS

- Frontend `npm run typecheck` — **PASS** (`tsc --noEmit`)
- Frontend `npm run lint` — **PASS** (0 errors; warning count unchanged from
  baseline; the 2 warnings introduced by edits were cleaned up)
- Frontend `npm test` — **PASS** (59/59)
- Frontend `npm run build` — **PASS** (all routes incl. `/data-saver/analytics`,
  `/api/phase2/analytics`, `/api/data-saver/dashboard` build)
- Backend `pytest tests/test_tick_analytics.py tests/test_data_center.py` — **PASS** (52/52)
- Backend full `pytest` — **340 PASS / 1 FAIL**
  - FAILED `tests/test_dummy_session.py::DummySessionHooksTest::test_order_is_session_stamped`
  - Verified **pre-existing**: fails identically with the changed files removed.
- Runtime verification — **PASS** (performance table §5; backend restarted with
  all fixes, single instance on port 8000)
- Live Kotak market-feed end-to-end trade verification — **NOT VERIFIED**
  (no live broker session available during this run; feed state above is from
  the running backend's real pipeline)

## 9. FILES REMOVED / DEPRECATED

- No files removed. `use-latest-ticks.ts` / `use-live-stocks.ts` no longer
  create EventSource connections (their own-stream code is gone); the shared
  broker in `lib/shared-sse.ts` is the single owner of the SSE connection.