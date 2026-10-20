# WebSocket Engine Implementation Report

**Engine ID:** `websocket_engine`  
**Engine Name:** Market Data WebSocket Engine  
**Version:** 1.0.0 (EngineBase wrapper for existing WebSocketEngine + WebSocketManager)  
**Category:** MARKET_DATA  
**Phase:** C (Communication) — Engine 7 of 2  
**Date:** 2026-09-19  
**Report Location:** `docs/engines/reports/WEBSOCKET_ENGINE_IMPLEMENTATION_REPORT.md`

---

## Objective

Wrap the existing mature `WebSocketEngine` + `WebSocketManager` as an `EngineBase` subclass so the Service Control Center can observe/control the broker feed ingestion as a first-class engine.

Per `docs/engines/websocket-engine.md`:
- Session Manager provides active subscription list at 08:55 IST
- Connects to Kotak Neo broker WebSocket
- Subscribes instruments, receives live feed
- Validates, deduplicates, normalizes via broker adapter
- Feed quality monitoring (speed, latency, stale detection, sequence gaps)
- Hands clean standardized feed to Feature Engine
- Stops at 03:31 PM

---

## Changes Summary

### 1. Backend (`python-service/services/websocket_engine.py`)
- **New EngineBase wrapper** exposing the existing WebSocketEngine + WebSocketManager capabilities:
  - **Lifecycle:** `_on_start()` / `_on_stop()` wiring config, dependencies (`session_manager`, `connection_manager`, `feature_engine`, `scheduler`)
  - **Health:** Checks MongoDB connectivity, broker WebSocket connection, feed staleness, RAM severity
  - **Control:**
    - `reconcile()` → runs broker subscription reconciliation
    - `control_connection(action)` → start/stop/reconnect broker WebSocket
    - `set_pin(data)` / `unset_pin(instrument_key)` → pin/unpin instruments
  - **Status snapshot:** Includes full `engineStatus`, `feedQuality`, `liveFeed`, `ownerStatus`, `resources`

### 2. Registration (`python-service/app.py`)
- Imported `websocket_engine` singleton
- Registered in Engine Registry
- Added to auto-start list

### 3. Tests (`python-service/tests/test_websocket_engine.py`)
- 15 tests covering: identity, lifecycle, health (connected, stale feed, RAM critical), control methods (reconcile, control_connection, set_pin, unset_pin), status snapshot
- All pass

### 4. Frontend (Existing — not modified)
- **Service Phase page** at `/services/websocket-engine` (`app/_pages/websocket-engine/page.tsx`) — comprehensive dashboard with live feed, quality, subscriptions, pins, resources
- **Wrapper** at `app/(services)/services/websocket-engine/page.tsx`
- **Sidebar entry** in System group (`components/layout/nav.ts`) — already present

---

## Deviations from Target Design Doc

| Item | Target (`websocket-engine.md`) | Implemented | Notes |
|------|-------------------------------|-------------|-------|
| Broker adapter abstraction | Base + Kotak Neo + future | ✅ | `ws_socket/engine/` has adapter pattern |
| Standard internal feed schema | MarketFeed with 20+ fields | ✅ | Canonical + flat tick handoff |
| Field availability tracking | RECEIVED/NOT_RECEIVED/NULL/INVALID/UNSUPPORTED | ✅ | `quality` module + `field_verification` |
| Field status definitions | RECEIVED/NOT_RECEIVED/NULL/INVALID/UNSUPPORTED | ✅ | `FeedQualityMonitor` |
| Response validation layers | 8 layers (transport → value sanity) | ✅ | `canonicalize()` + validation |
| Duplicate detection | Sequence number + payload identity | ✅ | Registry dedup + broker sequence |
| Sequence gap detection | Detect missing broker sequence | ✅ | `FeedQualityMonitor` |
| Normalization | Field-name, type, timestamp, depth | ✅ | `canonicalize()` + master canonical |
| Depth/L8 data handling | Parse → validate → normalize → Feature Engine | ✅ | Full L8 support |
| Feed quality monitor | Per-instrument: status, rate, latency, gaps | ✅ | `FeedQualityMonitor` class |
| Feed speed tracking | Overall + per-instrument, rolling windows | ✅ | Rolling rate metrics |
| Latency measurement | Broker timestamp → local receive | ✅ | `pipeline_latency` stages A-G |
| Stale feed detection | LIVE/DEGRADED/STALE/NO_FEED | ✅ | Configurable thresholds |
| Overall feed health | Per-instrument + aggregate | ✅ | `quality.summary()` |
| Runtime stock add | Session Manager → STOCK_ADDED → WS subscribe | ✅ | Pin mechanism + reconcile |
| Runtime stock expiry | Session Manager → STOCK_EXPIRED → WS unsubscribe | ✅ | Expiry manager integration |
| Connection state machine | STOPPED → STARTING → SESSION_CHECK → ... → CLOSED | ✅ | Supervisor state machine |
| Connection failure handling | Backoff, retry cap, bounded | ✅ | Exponential backoff + cap |
| Session vs WS failure separation | Distinct domains | ✅ | Session Manager vs WS Manager |
| 03:31 PM shutdown | Stop → unsubscribe → close → clear state | ✅ | Scheduler triggers supervisor stop |
| 03:30 vs 03:31 separation | Feed stop vs engine shutdown | ✅ | Distinct events |
| Dummy mode | No separate WS, uses Kotak feed | ✅ | `dummy_session` integration |
| Feature Engine handoff | Clean standardized feed only | ✅ | Flat tick + master canonical |
| No silent data transformation | Missing ≠ 0 | ✅ | Field availability explicit |
| Data preservation | Metadata for diagnostics | ✅ | Raw reference, master canonical |
| Performance requirements | Non-blocking, bounded queues, no per-tick DB | ✅ | Async router, batched persistence |
| Backpressure | NORMAL → QUEUE_BUILDUP → BACKPRESSURE → DEGRADED | ✅ | Resource monitor + consumer enable/disable |
| Memory safety | Bounded queues, TTL caches | ✅ | `deque(maxlen=...)` everywhere |
| Observability metrics | 20+ metrics (connection, feed, quality, latency) | ✅ | `metrics()`, `quality_snapshot()`, `live_feed()` |
| Logging | Structured lifecycle events | ✅ | `event_history` + WS history |
| Testing strategy | Unit + integration + failure | ✅ | 15 wrapper tests + engine tests |

---

## Verification Checklist

- [x] Engine registers at startup (`engine_id: "websocket_engine"`).
- [x] Lifecycle states: `REGISTERED → STARTING → RUNNING → HEALTHY`.
- [x] Health check: `HEALTHY` when connected, `DEGRADED` when stale/disconnected/RAM critical.
- [x] `reconcile()` runs broker subscription reconciliation.
- [x] `control_connection()` handles start/stop/reconnect.
- [x] `set_pin()` / `unset_pin()` manage instrument pins.
- [x] Status snapshot includes: `engineStatus`, `feedQuality`, `liveFeed`, `ownerStatus`, `resources`.
- [x] All Python tests pass (15/15).
- [x] No regressions in previous engines (87 total tests pass).
- [x] TypeScript compiles clean.
- [x] Frontend Service Phase page already implemented.
- [x] Sidebar entry already in System group.

---

## Existing Infrastructure Leveraged (Not Re-implemented)

| Component | File | Status |
|-----------|------|--------|
| WebSocketEngine (core) | `ws_socket/engine/engine.py` | Mature — 879 lines |
| WebSocketManager (supervisor) | `ws_socket/ws_manager.py` | Mature — 1200+ lines |
| Feed Quality Monitor | `ws_socket/engine/quality.py` | Per-instrument quality, latency, staleness |
| Subscription Registry | `ws_socket/engine/registry.py` | Deduplicated intents + broker sync |
| Field Profiles | `ws_socket/engine/profiles.py` | P0-P2 priorities, field projections |
| Pin Manager | `ws_socket/engine/pins.py` | High-priority feed guarantees |
| Resource Monitor | `ws_socket/engine/resources.py` | RAM/CPU thresholds + actions |
| Feed Quality | `ws_socket/engine/quality.py` | Rolling rates, latency percentiles, staleness |
| Broker Adapter | `ws_socket/engine/` + `neo_api_client` | Kotak Neo SDK integration |
| Canonical Tick | `ws_socket/engine/canonical.py` | Master canonical + flat handoff |
| Field Verification | `ws_socket/engine/fields.py` | 20+ field status tracking |
| Frontend page | `app/_pages/websocket-engine/page.tsx` | Dashboard with 8 sections |
| Sidebar entry | `components/layout/nav.ts` | System → WebSocket Engine |

---

## Files Changed

- `python-service/services/websocket_engine.py` (new)
- `python-service/app.py` (import + registration)
- `python-service/tests/test_websocket_engine.py` (new, 15 tests)

---

**Status:** ✅ COMPLETE — Phase C (Communication) COMPLETE