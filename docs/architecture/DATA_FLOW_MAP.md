# ARCHITECTURE/DATA_FLOW_MAP.md

## KAUSTUBH Trading Platform - Detailed Data Flow Map

**Last Updated**: 2026-09-28
**Status**: ACTIVE
**Note**: Executive summary is in `../DATA_FLOW_MAP.md`. This is the detailed trace.

---

## Flow 1: Market Data Ingestion (WS#1)

```
[Broker]  Kotak SFeed (wss://...)
    │  TICK frame: token, LTP, OHLC, depth, OI, volume
    ▼
[ws_manager]  python-service/ws_socket/ws_manager.py
    │  • connect w/ exponential backoff
    │  • subscribe(tokens, feed="CM")
    │  • wait for ACK
    │  • dispatch raw frame
    ▼
[websocket_engine]  python-service/ws_socket/ws_engine/
    │  • apply field_profile (broker field → canonical field)
    │  • type/range validation
    │  • staleness check
    │  • reject bad ticks (emit TICK_REJECTED)
    ▼
[EngineEventBus]  typed event: TICK_VALIDATED
    ├─→ feature_engine         (signals, derived features)
    ├─→ market_coach           (eligibility, ranking, movers)
    ├─→ watchlist_engine       (membership, ordering)
    ├─→ risk_engine            (exposure, per-symbol risk)
    └─→ tick_buffer            (batched persistence)
              │
              ▼
        [db_writer_engine] → MongoDB market_data (TTL 24h)
              │
[connection_engine]  buffer + drain per client
    │
    ▼
[WS#3]  backend → frontend
    │
    ▼
[lib/realtime-ws.ts] → hooks → components (market-watch, dashboard, chart)
```

**Backpressure**: `tick_buffer` flushes on `buffer_flush_interval_ms` or when `buffer_max_size` reached.

---

## Flow 2: Order Execution

```
[Frontend]  order entry form (react-hook-form)
    │  POST /api/trading/order/place
    │  or WS#4 { type: "place_order", ... }
    ▼
[api/trading.py]  validate request schema (pydantic)
    ▼
[order_engine]  structural validation
    │  • instrument resolved
    │  • quantity > 0, within limits
    │  • price sanity
    ▼
[risk_engine]  pre-trade risk
    │  • per-symbol exposure limit
    │  • per-order risk limit
    │  • if violated → REJECT, record to audit_log
    ▼
[margin_engine]  funds check
    │  • available margin ≥ required
    │  • if insufficient → REJECT
    ▼
[audit_engine]  record intent (before broker call)
    │  persist: { action, decision, reason, timestamp }
    ▼
[broker adapter]  kotak_adapter.place_order()
    │  REST → Kotak Neo API
    ▼
[Broker]  Kotak accepts/rejects
    │
    │  WS#2: OrderUpdate event
    ▼
[order_feed_manager]  python-service/ws_socket/order_feed_manager.py
    ▼
[EngineEventBus]  ORDER_UPDATE
    ├─→ order_engine   (state machine: NEW → ACKED → OPEN → FILLED/CANCELLED/REJECTED)
    ├─→ risk_engine    (update exposure)
    └─→ audit_engine   (record broker response)
    ▼
[connection_engine] → WS#3 → frontend (order book updates)
    │
    ▼
[db_writer_engine] → MongoDB orders (TTL 1y)
```

**Fallback**: If WS#2 is down, backend polls `order_status` / `order_report` / `trade_report` via REST.

---

## Flow 3: Position & P&L

```
[Broker]  WS#2 PositionUpdate + WS#1 LTP
    ▼
[order_feed_manager] / [ws_manager]
    ▼
[risk_engine] / [position state]
    │  • netQty (signed: long/short)
    │  • average price
    │  • unrealized P&L = (LTP − avg) × qty × multiplier
    │  • realized P&L from closed trades
    │  • MTM (mark-to-market) exposure
    ▼
[EngineEventBus]  POSITION_UPDATE
    ▼
[connection_engine] → WS#3 → frontend (positions page, portfolio)
    │
    ▼
[db_writer_engine] → MongoDB positions (TTL 1y)
```

**Authority**: REST `positions()` (broker-confirmed) is authoritative; WS is fast-but-possibly-lagging.

---

## Flow 4: Subscription Lifecycle (Scheduler-driven)

```
[Scheduler]  08:50 login trigger
    ▼
[Session Manager]  broker login (Kotak TOTP / Shoonya OAuth)
    │  • store session token, instruments
    │  • revision++
    ▼
[Scheduler]  08:55 WS start
    ▼
[market_coach]  eligible universe + ranking
    │  • compute top-N by ranking criteria
    │  • apply pins
    ▼
[Session Manager]  daily intent
    │  • set current-day desired subscriptions
    │  • validity window
    │  • revision++ (observable change)
    ▼
[Subscription Registry]  merge / dedup / feed-level resolution
    │  • combine sources (market_watch, watchlist, manual)
    │  • resolve to broker feed keys (CM/FO/NFO)
    │  • diff vs current broker state
    ▼
[websocket_engine]  orchestrate
    │  • reconcile desired vs actual
    │  • issue subscribe/unsubscribe
    ▼
[ws_manager] → Kotak SFeed (WS#1)
    │
    ▼
[connection_engine] → WS#3 → frontend (subscription state)
```

---

## Flow 5: Engine Event Fan-out

```
Any engine
    │  emits typed event via EngineEventBus
    ▼
[EngineEventBus]  pub/sub
    ├─→ subscribed engines (decide to react)
    ├─→ connection_engine (route to UI)
    ├─→ db_writer_engine (persist if event is durable)
    └─→ notification_engine (surface to user)
```

**Decoupling**: Engines do not call each other directly; they publish/subscribe. This prevents tight coupling and circular dependencies.

---

## Flow 6: Persistence (Tick Data)

```
[TICK_VALIDATED] → [tick_buffer]
    │  accumulate
    │  flush when: interval reached OR max_size reached
    ▼
[bulk_insert (insert_many, bulk_insert_size)]
    ▼
[MongoDB: market_data collection]  (TTL 24h)
    │
    ▼
[atlas_cleanup job]  (atlas_cleanup_hour:minute) — remove expired docs
```

---

## Flow 7: Frontend Data Flow

```
[Page]  server/client component
    │  useEffect / SWR-style fetch
    ▼
[lib/backend.ts]  REST client (with auth)
    │  GET /api/...
    ▼
[Backend router] → engine/service → MongoDB / broker
    │  JSON response
    ▼
[Frontend]  zod validate → store/hook state → render
    │
    │  parallel: WS#3 subscription for live updates
    ▼
[lib/realtime-ws.ts] → use-realtime-client → UI live updates
```

---

## Data Freshness Guarantees

| Data | Max staleness | Source of truth |
|------|---------------|-----------------|
| LTP / ticks | Realtime (ms) | WS#1 |
| Position | Seconds (WS) / minutes (REST) | REST `positions()` |
| Order status | Seconds (WS#2) / minutes (poll) | Broker order_status |
| Margin | On-demand | Broker funds API |
| Margin (used) | Computed from positions | Backend risk engine |
| Market Watch rank | Per tick | Backend market_coach |

**Rule**: Never display a value without a staleness indicator. `STALE` badge when older than threshold.

---

## Related Documents
- `WEBSOCKET_ARCHITECTURE.md` — WS channel detail
- `../api/API_CATALOG.md` — REST endpoints
- `FAILURE_AND_RECOVERY.md` — Error paths
- `../database/DATABASE_LIFECYCLE.md` — TTL and cleanup
