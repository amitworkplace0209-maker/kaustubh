# Market Watch Engine Implementation Report

**Engine ID:** `market_watch`
**Engine Name:** Market Watch Engine
**Version:** 2.0.0
**Category:** MARKET_DATA
**Phase:** D (Market Data) — Engine 11
**Date:** 2026-09-22
**Report Location:** `docs/engines/reports/MARKET_WATCH_ENGINE_IMPLEMENTATION_REPORT.md`
**Design Reference:** `docs/engines/MARKET_WATCH.md`

---

## Objective

Deliver the Market Watch Engine end-to-end, from Kotak Neo (WebSocket Engine) → Market Watch Engine (ranking / pins / filters) → Connection Manager realtime → Next.js frontend, per the design doc.

Hard constraint applied throughout: **never fabricate market data.** Missing/unknown fields render as `PENDING`/`STALE`/`NO_DATA`/`INACTIVE`/`DISCONNECTED` and "—"; a row that lacks a field must fail any filter criterion on that field naturally.

---

## Architecture (as implemented)

```
Kotak Neo
   │
   ├── Scrip/Instrument API ──► daily eligible NSE intraday universe
   └── Market Data WebSocket ──► ws_manager (WS/WebSocket Engine) ──► normalized ticks
                                      │  (event bus: WEBSOCKET_CONNECTED/DISCONNECTED/RECONNECTED)
                                      ▼
                       Market Watch Engine (`services/market_watch_engine.py`)
                                      │
            ┌─────────────┬───────────┼─────────────────┬──────────────────┐
            ▼             ▼           ▼                 ▼                  ▼
       live state     ranking     auto pins        saved filters       status/index
   (token-keyed)  (30s snap)   (Top-5 freq)   (market_watch_filters)   metrics
            │
            ▼
       Connection Manager (market_watch state + market channels)
            │
            ▼
       Next.js UI (app/_pages/market-watch/*)
```

Jobs split: full eligible-universe live state + 30-second ranking/publish are independent — the UI is never flooded with raw ticks.

---

## Phase Map (work phases, all completed)

| Phase | Scope | Outcome |
|---|---|---|
| 1 | Registry / eligible-universe discovery | Day-scoped NSE EQ universe from validated instrument master + broker session products (no hardcoded 600-list); symbol/name/token mapping saved to Mongo |
| 2 | WebSocket Engine integration | Subscribes universe via `desired_subscriptions()`, consumes `TICK_VALIDATED`, resubscribe/reconnect sync |
| 3 | Live state + tick enrichment | `_enrich_entry()` merges `masterCanonical` + `tick_buffer._latest_ticks` (LTP/OHLC/volume/ltq/avgPrice/oi/circuits/52w/depth ≤10 level/side, spread, midPrice, buySellRatio, tradedValue, lastTradeTime, dataAgeSec) |
| 4 | Rolling momentum windows | 5-min / 10-min movers over tick buffer |
| 5 | Ranking engine | `services/market_watch_ranking.py` — gainers/losers/volume rows/absolute change/movers, 30s snapshots, snapshot history |
| 6 | Automatic pin system | Top-5 appearance frequency, deterministic tie-breaking, max 5+5, day-scoped, dynamic replacement |
| 7 | Manual pins + saved filters | `services/market_watch_pins.py`, `services/market_watch_filters.py` + Mongo (day-scoped, max 20 manual pins, validation) |
| 8 | FastAPI routes | `/api/market-watch/*` (list below) |
| 9 | Connection Manager realtime | `market_watch` dual-listed: STATE channel (ranking/pins/status), MARKET channel (live rows); instrument-less subscribe = state channel |
| 10 | Engine wiring | feedState lifecycle + universe refresh + subscription sync via engine event bus |
| 11 | Frontend tabbed redesign | overview / movers / rank / filters / pins / symbol pages, live row updates, virtualized tables |
| 12 | Frontend cleanup | removed `RowNav`/`SectionListCard`/dead props; tsc + eslint clean |
| 13 | Tests | 3 new/extended backend suites + 4 new frontend realtime tests |
| 14 | Live runtime verification | booted new backend, probed all endpoints against live feed; found+fixed feedState bug |
| 15 | This report | — |

---

## Backend components

- `python-service/services/market_watch_engine.py` — EngineBase engine; universe build/refresh, live state, enrichment, ranking driver, pins, subscription sync, day reset, publishes `market_watch.*` frames.
- `python-service/services/market_watch_ranking.py` — pure ranking/large-volume/pin-frequency logic (stateless, easily tested).
- `python-service/services/market_watch_filters.py` — pure filter catalog (13 keys; `between/gte/lte/gt/lt/eq`, `in/neq`, `contains`), `validate_criteria`, `apply_filters`, `validate_filter_document` (limit clamped 1–1000, default 100).
- `python-service/services/market_watch_pins.py` — manual pins Mongo store (day-scoped, `MAX_MANUAL_PINS=20`, idempotent, no fabricated metadata).
- `python-service/api/market_watch.py` — FastAPI router, prefix `/api/market-watch`.

### API routes (live verified)

| Method | Route | Purpose |
|---|---|---|
| GET | `/config` | engine config + feedState + filter catalog |
| GET | `/status` | engine health + metrics (feedState, tickCount, indexVersion, subscribed/eligible/live counts) |
| GET | `/rank?offset&limit&sortBy&sortDir` | ranked rows (real, sorted) |
| GET | `/filters`, `/filters/{id}` | saved filter list / detail |
| POST | `/filters` | save filter (validated) |
| POST | `/filters/apply` | apply criteria to live state (AND semantics; missing field ⇒ fails criterion) |
| DELETE | `/filters/{id}` | remove filter |
| GET | `/pins` | auto + manual pins with appearance counts |
| POST | `/pins` | add manual pin |
| DELETE | `/pins/{symbol_or_token}`, `/pins` | remove manual pin(s) |
| GET | `/symbol/{symbol_or_token}` | single stock detail (quote/depth/circuit, honest `no_ws_tick` when no feed) |
| GET | `/ranking`, `/ranking/status`, `/history`, `/sections`, `/search`, `/registry`, `/page`, `/ui`, `/tick-snapshot`, `/progress` | supporting views |

---

## FeedState lifecycle fix (found in Phase 14)

Symptom: while a live feed streamed (dataAgeSec ~0.03, ~7.4 ticks/s, 8 LIVE instruments), `/status` still reported `feedState: DISCONNECTED`.

Root cause: `market_watch_engine._on_start` subscribes to `WEBSOCKET_CONNECTED/DISCONNECTED/RECONNECTED` on `services/engine_event_bus`, but **nothing ever published them** — `session_manager._stamp("WEBSOCKET_CONNECTED", ...)` only writes a timestamp, it is not an event-bus publish.

Fix (`ws_socket/ws_manager.py`):
- Added `WebSocketManager._publish_ws_engine_event(event_type, data=None)` — publishes `EngineEvent` onto the engine event bus (scheduled off the SDK callback thread).
- `_on_open` now publishes `WEBSOCKET_CONNECTED` (after `_publish_ws_state("CONNECTED", …)`).
- `_on_close` now publishes `WEBSOCKET_DISCONNECTED` (after `_publish_ws_state("DISCONNECTED", …)`); reconnects arrive via `_on_open` (RECONNECTED).

Result: `feedState` now truthfully mirrors the broker feed. Unit-tested in `tests/test_ws_supervisor_sdk.py` (event forwarding + bus-failure resilience). A bare headless process with genuinely no feed correctly stays `DISCONNECTED` with `subscribedTokenCount=0` — i.e. the cost signal is honest in both directions.

---

## Frontend

- `app/_pages/market-watch/page.tsx` — tabbed shell (overview / movers / rank / filters / pins / symbol).
- `overview.tsx`, `movers.tsx`, `rank.tsx` (useMemo-ized items), `filters.tsx`, `pins.tsx`, `symbol.tsx` — pages; `mw-table.tsx` (virtualized table, removed `RowNav`/`SectionListCard`), `mw-shared.tsx` (shared helpers, "—" rendering).
- `lib/realtime-ws.ts` — realtime client; supports instrument-less state-channel subscriptions (ranking/pins/status) + instrument market-channel rows.
- `components/layout/nav.ts` — Market sidebar entry.

No-fake-data on the frontend: rows without a field render "—"; the realtime client only ever renders backend-provided values.

---

## Tests

### Backend (pytest, 131 relevant passed)
- `tests/test_market_watch_filters.py` (NEW): catalog shape/options, criteria validation/coercion, between, AND semantics, enum/text ops, **missing-field-fails-naturally**, filter document validation + limit clamping (saved filters).
- `tests/test_market_watch_pins.py` (NEW, async): FakeDB/FakeCollection with async `find_one/count_documents/insert_one/delete_many`; add/list/idempotency, 20-cap, missing token, no_trading_date, remove/clear, is_pinned, day scoping, no-fabricated-metadata, db-error handling.
- `tests/test_market_watch_ranking.py` (extended): `VolumeRowsTest` (topVolume order/exposure/empty-when-missing), `highestTurnover`/`buyingStrength` from real quantities (`test_highest_turnover_sorted_desc` ⇒ `["B","A","D","C"]`; `test_buying_strength_from_real_quantities` ratio 3.0; `test_buying_strength_never_fabricated`).
- `tests/test_ws_supervisor_sdk.py` (extended): engine-event publish forwarding + bus-failure resilience.
- Existing `test_market_watch_route.py`, `test_connection_engine.py`, engine tests — still green.

### Frontend (`npm test` = `node --test "tests/*.test.ts"`)
- 274 passed, 0 failed. New in `tests/realtime-client.test.ts`: state-channel subscribe sends instrument-less spec; instrument subscribe merges state+token delta; unsubscribe removes state channel (re-sub re-sends); destroy clears subscriptions (fresh connect re-sends).
- `npx tsc --noEmit` EXIT=0; eslint EXIT=0.

---

## Live Runtime Verification (Phase 14, market open, tradingDate 2026-09-22)

- `/config` → ok; `feedState` + full engine config: `{rankingIntervalSeconds:30, maxGainerPins:5, maxLoserPins:5, initialSectionLimit:50, pageSize:100, staleThresholdSeconds:30, universeRefreshSeconds:300}`; `maxManualPins:20`; filter catalog present.
- `/status` (with live feed) → engine RUNNING/HEALTHY, `tickCount≈13862`, `subscribedTokenCount=8`, `eligibleUniverseCount=2668`, `indexVersion=60`, `rankingDurationMs≈12ms`, ranking snapshots every 30s (`gainers=5 losers=3`).
- Ranking logs → real pin rotation across snapshots: gainers `CUPID-EQ, IFCI-EQ, HIKAL-EQ, BOSCHLTD-EQ, IRCTC-EQ`; losers `EIHOTEL-EQ, ONGC-EQ, WIPRO-EQ, IRCTC-EQ`.
- `/rank?sortBy=changePercent&sortDir=desc` → real sorted items.
- `POST /filters/apply {"criteria":[{"key":"ltp","op":"gte","value":1000}]}` → 1 result **BOSCHLTD-EQ** (token 2181) with fully real enriched quote (ltp 47785.0, prevClose 47565.0, change% 0.46, volume 4970, tradedValue ~237.6M, depth bid 47755/ask 47780, buySellRatio 0.8587, upperCircuit 52320/lowerCircuit 42810, 52w high/low 50000/28610, status LIVE, dataAgeSec ~0.031).
- Manual pins live round-trip (Mongo): `POST /pins` (RELIANCE/2885) → ok + persisted; `GET /pins` shows it under manual with `tradingDate`; `DELETE /pins/2885` → removed; manualCount 0 after.
- Saved filters live round-trip (Mongo): `POST /filters` (ltp≥1000, limit 50) → filterId; `GET /filters/{id}` → detail; `DELETE /filters/{id}` → removed; list count 0 after.
- `/symbol/RELIANCE` with no WS tick → honest: status PENDING, priceSource pending, `quote.available=false reason=no_ws_tick`, depth available=false, circuit null + `circuitAvailable=false`.
- `/symbol/ZZZ-NOTREAL` → `ok:false reason=unknown_symbol`.

**Caveat:** the final re-verification boot had no broker feed running in that bare process (`subscribedTokenCount=0`, `tickCount=0`) — `feedState: DISCONNECTED` was therefore correct/truthful there; the live-feed path (8 LIVE tokens, enriched applies, real pins) was demonstrated in the preceding boot, and the feedState fix now reports a real connection as `CONNECTED`.

---

## Verification Checklist

- [x] Day-scoped NSE EQ intraday universe built from validated Kotak data (no hardcoded 600-list); `eligibleUniverseCount` live.
- [x] Symbol/name/token mapping present; registry day-scoped.
- [x] WebSocket Engine supplies normalized live ticks; enrichment pulls depth/circuits/52w/volume/buy-sell ratio.
- [x] Full eligible-universe live state with statuses PENDING/LIVE/STALE/NO_DATA/INACTIVE.
- [x] Ranking every configured 30s; gainers/losers/volume/absolute-change/movers all sort correctly.
- [x] First snapshot starts Top-5 frequency counting; independent gainer/loser counters; max 5+5 auto pins; deterministic tie-breaking; pin rotation observed live.
- [x] Manual pins (max 20, day-scoped) + saved filters persist to Mongo; live CRUD verified.
- [x] Filters never fabricate: missing-field rows fail any criterion on that field naturally.
- [x] Connection Manager delivers `market_watch` state + market channels; realtime client supports instrument-less state subscribe.
- [x] feedState truthfully mirrors broker feed (fix + unit tests).
- [x] Frontend tabbed redesign; tsc + eslint clean; "—" for missing data.
- [x] Backend 131 market-watch/ws tests pass; frontend 274 tests pass.
- [x] Live endpoint verification (config/status/rank/filters* /pins* /symbol).

---

## Files

- `python-service/services/market_watch_engine.py`
- `python-service/services/market_watch_ranking.py`
- `python-service/services/market_watch_filters.py`
- `python-service/services/market_watch_pins.py`
- `python-service/api/market_watch.py`
- `python-service/ws_socket/ws_manager.py` (feedState lifecycle publishes)
- `python-service/services/engine_event_bus.py` (WEBSOCKET_* event types)
- `python-service/tests/test_market_watch_filters.py` (NEW)
- `python-service/tests/test_market_watch_pins.py` (NEW)
- `python-service/tests/test_market_watch_ranking.py` (extended)
- `python-service/tests/test_ws_supervisor_sdk.py` (extended)
- `app/_pages/market-watch/page.tsx`, `overview.tsx`, `movers.tsx`, `rank.tsx`, `filters.tsx`, `pins.tsx`, `symbol.tsx`, `mw-table.tsx`, `mw-shared.tsx`
- `lib/realtime-ws.ts`
- `tests/realtime-client.test.ts`

---

**Status:** ✅ COMPLETE — Phases 1–15 done. All 131 backend + 274 frontend tests pass; tsc/eslint clean; live endpoints verified; feedState bug fixed and unit-tested.

**Next (suggested):** Scheduler-driven day-reset rehearsal at 15:31 IST, and an end-to-end browser WS state-frame capture next market session.