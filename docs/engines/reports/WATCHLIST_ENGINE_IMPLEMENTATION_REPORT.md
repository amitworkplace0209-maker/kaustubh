# Watchlist Engine Implementation Report

**Engine ID:** `watchlist_engine`  
**Engine Name:** Watchlist Engine  
**Version:** 2.0.0 (already mature EngineBase implementation)  
**Category:** MARKET_DATA  
**Phase:** D (Market Data) — Engine 10 of 4  
**Date:** 2026-09-19  
**Report Location:** `docs/engines/reports/WATCHLIST_ENGINE_IMPLEMENTATION_REPORT.md`

---

## Objective

The Watchlist Engine is already a mature EngineBase implementation that provides watchlist management, live stock cards, dynamic market lists, and advanced screening/ranking per `docs/engines/watchlist-engine.md`.

---

## Implementation Summary

### Backend (`python-service/services/watchlist_engine.py`)
- **Watchlist management**: create/rename/delete watchlists, add/remove/reorder stocks
- **Stable stock-card model** (doc §6): symbol, exchange, LTP, change, change%, volume, bid, ask, spread, 5-min%, 10-min%, lastTick, status (LIVE/STALE/CONNECTING/DISCONNECTED)
- **Derived metrics** (doc §7): change, change%, 5-min%, 10-min% via tick_buffer momentum windows
- **Live status** (doc §6): LIVE (>30s), STALE (>30s no tick), CONNECTING (session active, no LTP), DISCONNECTED (no session)
- **Dynamic lists** (doc §8): top_gainers, pct_gainers, price_gainers, top_losers, pct_losers, price_losers, movers_up (≥1%), movers_down (≤-1%), m5_gainers, m5_losers, m10_gainers, m10_losers
- **Screening** (doc §9): AND-combined rules with operators gt/gte/lt/lte/eq/ne
- **Connection Manager contract** (doc §11): `desired_subscriptions()` returns deduped symbol/token/exchange list
- **LTP cache**: per-token cache with 60s TTL fallback
- **Event-driven**: consumes `TICK_VALIDATED` from EngineEventBus
- **Per-instrument isolation**: no cross-instrument leakage

### API (`python-service/api/watchlist_engine.py`)
- `GET /api/watchlist-engine` — list watchlists
- `POST /api/watchlist-engine` — create watchlist
- `PATCH /api/watchlist-engine/{id}` — rename watchlist
- `DELETE /api/watchlist-engine/{id}` — delete watchlist
- `GET /api/watchlist-engine/{id}/cards` — normalized stock cards
- `POST /api/watchlist-engine/{id}/symbols` — add stock
- `DELETE /api/watchlist-engine/{id}/symbols/{token}` — remove stock
- `PUT /api/watchlist-engine/{id}/order` — reorder
- `GET /api/watchlist-engine/dynamic/{kind}` — ranked dynamic lists
- `POST /api/watchlist-engine/dynamic/{kind}` — rank explicit universe
- `POST /api/watchlist-engine/screen` — custom screening
- `GET /api/watchlist-engine/subscriptions` — Connection Manager contract
- `GET /api/watchlist-engine/meta/dynamic-kinds` — available dynamic list kinds

### Frontend (Existing)
- **Service Phase page**: `app/_pages/watchlist/page.tsx` — watchlist selector, live stock cards table, dynamic market lists (top gainers), polling
- **Wrapper**: `app/(services)/services/watchlist/page.tsx`
- **Sidebar entry**: Market group (Star icon)

### Tests (Existing — 18 tests)
- Watchlist state: add/list, duplicate rejection, remove, create/rename/delete, reorder
- Card model: no live data → DISCONNECTED, session active → CONNECTING, live fields/metrics, stale status
- Ranking: top_gainers, top_losers, price_losers, movers_up, m5_gainers
- Screening: AND-combined rules
- Subscriptions: deduped desired_subscriptions, active_tokens

---

## Verification Checklist

- [x] Engine registers at startup (`engine_id: "watchlist_engine"`).
- [x] Lifecycle states: `REGISTERED → STARTING → RUNNING → HEALTHY`.
- [x] `/api/watchlist-engine` returns watchlists, cards, dynamic lists, subscriptions.
- [x] Watchlist CRUD works (create, rename, delete, add/remove stock, reorder).
- [x] Card model: symbol, LTP, change, change%, volume, bid, ask, spread, 5-min%, 10-min%, status.
- [x] Live status: LIVE (>30s tick), STALE (>30s no tick), CONNECTING (session active, no LTP), DISCONNECTED (no session).
- [x] Dynamic lists: top_gainers, top_losers, pct_gainers, price_gainers/losers, movers_up/down, 5-min/10-min gainers/losers.
- [x] Screening: AND-combined rules with gt/gte/lt/lte/eq/ne.
- [x] Connection Manager contract: `desired_subscriptions()` returns deduped subscriptions.
- [x] All 18 Python tests pass.
- [x] TypeScript compiles clean.
- [x] Service Phase page loads with watchlist selector, live cards table, dynamic top gainers.

---

## Files (Already Implemented)

- `python-service/services/watchlist_engine.py`
- `python-service/api/watchlist_engine.py`
- `python-service/tests/test_watchlist_engine.py` (18 tests)
- `app/_pages/watchlist/page.tsx`
- `app/(services)/services/watchlist/page.tsx`
- `components/layout/nav.ts` (Market group sidebar entry)

---

**Status:** ✅ COMPLETE — Already implemented per design doc. No new code required.

---

**Next:** Phase D Engine 11 — **Market Watch Engine** (per existing `services/market_watch_engine.py`).