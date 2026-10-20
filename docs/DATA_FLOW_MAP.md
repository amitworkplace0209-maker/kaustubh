# DATA_FLOW_MAP.md

## KAUSTUBH Trading Platform - Data Flow Map

**Last Updated**: 2026-09-28
**Status**: ACTIVE
**Note**: Canonical detail lives in `architecture/DATA_FLOW_MAP.md`. This is the executive summary.

---

## Four Critical Data Flows

### 1. Market Data (Broker → Backend → Frontend)
```
Kotak SFeed (WS#1)
  → ws_manager (connect/reconnect/subscribe/ACK)
  → websocket_engine (validate/normalize)
  → EngineEventBus (TICK_RECEIVED → TICK_VALIDATED | TICK_REJECTED)
  → [feature_engine, market_coach, watchlist_engine, risk_engine, db_writer_engine]
  → connection_engine (data_saver drain)
  → WS#3 → frontend (lib/realtime-ws.ts)
  → hooks (use-live-stocks, use-tick-stream) → components
```

### 2. Order Execution (Frontend → Broker → Frontend)
```
Frontend (WS#4 place_order | REST POST /api/trading/order/place)
  → order_engine (validate) → risk_engine (pre-trade) → margin_engine (funds) → audit_engine (record)
  → broker adapter (kotak_adapter → Kotak REST place_order)
  → Kotak → WS#2 OrderUpdate → order_feed_manager
  → EngineEventBus (ORDER_UPDATE) → order_engine / risk / audit
  → connection_engine → WS#3 → frontend
  + REST fallback poll (order_status / order_report / trade_report) on reconnect
```

### 3. Position & P&L (Broker → Backend → Frontend)
```
Kotak WS#2 PositionUpdate + Kotak WS#1 LTP
  → risk/position state (netQty, avg, unreal, MTM; realized from REST positions())
  → EngineEventBus
  → connection_engine → WS#3 → frontend
  + periodic REST positions() = broker-confirmed authoritative
```

### 4. Subscription Lifecycle (Scheduler → Session Manager → Broker)
```
Scheduler (08:50 login → 08:55 WS connect)
  → Session Manager (broker login, session lifecycle)
  → market_coach (eligible universe, ranking, pins)
  → Session Manager (daily intent set, revision++, validity window)
  → Subscription Registry (merge, dedup, feed-level resolution, broker diff)
  → websocket_engine (orchestrate, reconcile, validate/normalize)
  → ws_manager → Kotak SFeed subscribe (WS#1)
  → connection_manager → WS#3 → frontend
```

---

## Data Trust Hierarchy

| Rank | Source | Trust | Notes |
|------|--------|-------|-------|
| 1 | Broker REST (`positions()`, `order_status`) | Authoritative | Broker-confirmed |
| 2 | Broker WebSocket (WS#2 order/position feed) | High | Async, may lag |
| 3 | Backend computed (risk, margin, ranking) | Derived | Backend-owned per spec |
| 4 | Broker WebSocket (WS#1 market data / LTP) | High | Real-time ticks |
| 5 | Frontend rendered | Presentation | Must never compute official values |
| 6 | Cached/persisted (MongoDB history) | Historical | For analytics, not live decisions |

**Rule**: `targets`, `margin`, `ranking`, `eligibility` are always **backend-computed**. Frontend renders only.

---

## State Propagation Path

```
Broker (WS#1/WS#2 or REST)
  → backend adapter (normalize to canonical fields)
  → engine (validate, update internal state)
  → EngineEventBus (typed event)
  → consuming engines (fan-out)
  → connection_engine (buffer + batch)
  → WS#3 (push to subscribed clients)
  → frontend store/hooks
  → UI render
```

---

## Data Transforms

| Stage | Transform |
|-------|-----------|
| Broker payload | Raw broker field names (e.g. `last_price`) |
| Adapter | Map to canonical schema |
| WebSocket Engine | Validate types, normalize, apply field profiles |
| Engine | Compute domain state (rank, margin, risk) |
| Connection Engine | Batch/drain, attach metadata |
| WS#3 Frame | JSON envelope with `type` + payload |
| Frontend | Type-guard (zod), render |

---

## Buffers & Backpressure

| Buffer | Owner | Purpose |
|--------|-------|---------|
| Tick buffer | `services/tick_buffer` | Batch ticks before MongoDB write |
| WS#3 outbound | `connection_engine` | Drain to frontend clients |
| Export job queue | `api/export_jobs` | Async file generation |
| Reorder buffer | `connection_engine` | Sequence per connection |

**Backpressure signal**: `buffer_max_size` and `buffer_flush_interval_ms` cap tick memory. `drain` endpoints expose consumer health (`/api/services/websocket/consumers/{id}/drain`).

---

## Lifecycle Data Flows (Scheduler-driven)

| Time (IST) | Trigger | Data |
|------------|---------|------|
| 08:50 | Login | Session token, instruments |
| 08:55 | WS connect | Subscriptions, feed config |
| 09:00–09:05 | Pre-market | Eligible universe, rankings |
| 09:15 | Feed start | Ticks begin (WS#1) |
| 09:15–15:16 | Live | Ticks, orders, positions, P&L, margin |
| 15:16 | Square-off | Orders to close positions |
| 15:30 | Feed stop | Final ticks, flush buffers |
| 16:00 | Logout | Session teardown, final DB writes |

---

## Related Documents
- `architecture/DATA_FLOW_MAP.md` — Detailed flows
- `architecture/WEBSOCKET_ARCHITECTURE.md` — WS channel detail
- `ARCHITECTURE_OVERVIEW.md` — System layers
- `../api/API_CATALOG.md` — REST surface
