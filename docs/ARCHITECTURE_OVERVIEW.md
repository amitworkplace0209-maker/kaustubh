# ARCHITECTURE_OVERVIEW.md

## KAUSTUBH Trading Platform - High-Level Architecture

**Last Updated**: 2026-09-28
**Version**: 1.0
**Status**: ACTIVE
**Source**: Derived from codebase scan and authoritative docs

---

## System Identity

- **Project**: KAUSTUBH / KDS Trading Terminal
- **Type**: Algorithmic trading terminal with PWA interface
- **Philosophy**: Engine-first design with Session Manager as single source of truth
- **Backend**: Python 3.12+ / FastAPI 0.115 / Motor 3.5 (async MongoDB)
- **Frontend**: Next.js 16.3.4 / React 19.2.8 / TypeScript 5.9
- **Database**: MongoDB (local or Atlas via MONGODB_URI)
- **Primary Broker**: Kotak Neo (kotakneoapi 3.0.7)
- **Secondary Broker**: Shoonya (NorenRestApiOAuth 0.0.41)
- **Paper Trading**: Dummy adapter (uses live Kotak feed)

---

## Architectural Layers

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 6: UI Layer - React/PWA Frontend (30+ pages)             │
│   Components, Hooks, Libraries, Real-time WS Client            │
├─────────────────────────────────────────────────────────────────┤
│ Layer 5: API Layer - FastAPI REST + WebSocket Endpoints        │
│   30+ Routers, Engine Control, WebSocket Gateway               │
├─────────────────────────────────────────────────────────────────┤
│ Layer 4: Data Layer - MongoDB Persistence + Realtime Feeds     │
│   Database Engine, Tick Buffer, DB Writer, Event History       │
├─────────────────────────────────────────────────────────────────┤
│ Layer 3: Service Layer - Scheduler, Connection Manager,        │
│   Session Manager, Engine Registry, Notification Center        │
├─────────────────────────────────────────────────────────────────┤
│ Layer 2: Engine Layer - 17 registered (14 native + 3 facade)    │
│   Feature, Search, Margin, Squareoff, Watchlist, Market Watch,   │
│   Market Coach, Storage, DB Writer, Notification, Audit,         │
│   Session Manager, Connection Manager, WebSocket,                │
│   + facades: Scheduler, Order, Position                         │
├─────────────────────────────────────────────────────────────────┤
│ Layer 1: Broker Adapters - Kotak, Shoonya, Dummy               │
│   REST APIs, WebSocket Feeds (SFeed + OrderFeed)               │
├─────────────────────────────────────────────────────────────────┤
│ Layer 0: Hardware/OS - Base Execution Environment              │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core Architectural Principles

1. **Engine-First Design**: All trading functionality encapsulated in independent engine components
2. **Session Manager as Single Source of Truth**: Tracks active subscriptions, order states, user context
3. **4-WebSocket Separation**:
   - WS#1: Broker → Backend (Market Data SFeed)
   - WS#2: Broker → Backend (Order & Position Feed)
   - WS#3: Backend → Frontend (Realtime Distribution)
   - WS#4: Frontend → Backend (Commands/Control)
4. **Native vs Facade Engines**:
   - Native: EngineBase subclass, auto-start enabled, full lifecycle managed
   - Facade: managed=true, lifecycle delegated to container, simplified API
5. **State Stamp Pattern**: All engines carry `state_stamp` for lifecycle tracking
6. **Event-Driven Inter-Engine Communication**: Engines communicate via published events, not direct dependencies
7. **Backend Owns Calculations**: Frontend renders results, never computes official rankings/eligibility
8. **No Fake Data**: Show UNKNOWN/NO_DATA/STALE honestly per documented contract
9. **Security Boundaries**: Broker credentials never leave backend; frontend never calls broker APIs

---

## Data Flow Summary

### Market Data Flow
```
Kotak SFeed (WS#1)
    ↓
WebSocketManager (connect/reconnect/subscribe/ACK)
    ↓
WebSocketEngine (validation/normalization)
    ↓
EngineEventBus (TICK_RECEIVED/TICK_VALIDATED/TICK_REJECTED)
    ├── Market Watch / Feature Engine
    ├── Risk Engine
    ├── DB Writer (via Connection Manager's DATA_SAVER drain)
    └── Connection Manager → WS#3 → Frontend
```

### Order Flow
```
Frontend (WS#4 place_order or REST POST /api/trading/order/place)
    ↓
Connection Manager / API
    ↓
Order Engine → Risk Engine → Margin Engine → Audit Engine
    ↓
Broker Terminal → Kotak REST (place_order)
    ↓
Kotak → WS#2 OrderUpdate → EngineEventBus
    ↓
Order Engine / Risk / Audit → Connection Manager → WS#3 → Frontend
    + REST fallback poll (order_report/trade_report) on reconnect
```

### Position/P&L Flow
```
Kotak WS#2 PositionUpdate + Kotak WS#1 LTP
    ↓
Risk / Position State (netQty/avg/unreal/MTM, realized from REST positions())
    ↓ EngineEventBus
Connection Manager → WS#3 → Frontend Position Page
    + Periodic REST positions() as broker-confirmed authoritative
    + Indicative P&L derived backend-side
```

### Session/Subscription Flow
```
Scheduler (08:50 login → 08:55 WS connect)
    ↓
Session Manager (Kotak/Shoonya login, session lifecycle)
    ↓
Market Watch (eligible universe, ranking, pins, live state)
    ↓ daily intent
Session Manager (current-day desired set, revision, validity)
    ↓
Subscription Registry (merge/dedup/feed-level resolution/broker diff)
    ↓
WebSocket Engine (orchestration, reconcile, validation/normalization)
    ↓
WebSocketManager → Kotak SFeed (WS#1)
```

---

## Engine Catalog (17 Registered — derived from code)

> **Corrected 2026-09-28.** The architecture set states "15 engines (13 native, 2 facade)".
> Source registration in `python-service\app.py:609-626` and
> `services\legacy_engine_facades.py:428-432` yields **17 (14 native + 3 facade)**.
> See `docs/DOCUMENTATION_AUTHORITY.md` §4 · finding D-15.

| Engine | Type | State | Health | Category | Auto-Start |
|--------|------|-------|--------|----------|------------|
| feature_engine | Native | RUNNING | HEALTHY | MARKET_DATA | Yes |
| search_engine | Native | RUNNING | HEALTHY | CORE | Yes |
| margin_engine | Native | REGISTERED | UNKNOWN | TRADING | No |
| squareoff_engine | Native | REGISTERED | UNKNOWN | TRADING | No |
| watchlist_engine | Native | RUNNING | HEALTHY | MARKET_DATA | Yes |
| market_coach | Native | RUNNING | HEALTHY | MARKET_DATA | Yes |
| storage_engine | Native | RUNNING | HEALTHY | STORAGE | Yes |
| scheduler_engine | Facade | RUNNING | HEALTHY | CONTROL | Yes |
| session_manager | Facade | RUNNING | HEALTHY | CORE | Yes |
| connection_manager | Facade | RUNNING | HEALTHY | CONTROL | Yes |
| websocket_engine | Facade | RUNNING | HEALTHY | MARKET_DATA | Yes |
| order_engine | Facade | RUNNING | HEALTHY | TRADING | Yes |
| position_engine | Facade | RUNNING | HEALTHY | TRADING | Yes |
| notification_engine | Facade | REGISTERED | UNKNOWN | CONTROL | No |
| db_writer_engine | Native | RUNNING | HEALTHY | STORAGE | Yes |

---

## Broker Architecture

```
                    ┌─────────────────┐
                    │  broker_manager │
                    └────────┬────────┘
                             │
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  kotak_adapter  │ │ shoonya_adapter │ │  dummy_adapter  │
│  (PRIMARY)      │ │  (SECONDARY)    │ │  (PAPER)        │
│  REST + WS×2    │ │  REST + WS      │ │  Mock + Live WS │
└────────┬────────┘ └────────┬────────┘ └────────┬────────┘
         │                   │                   │
         ▼                   ▼                   ▼
   Kotak Neo API       Shoonya API         Virtual Engine
   (Live Market)       (Live Market)       (Kotak LTP)
```

**Failover**: Kotak → Shoonya → Dummy (automatic, transparent to upper engines)

---

## Scheduler Daily Lifecycle (IST)

| Time | Event | Owner |
|------|-------|-------|
| 08:50 | Login Trigger | Scheduler → Session Manager |
| 08:55 | WebSocket Start | Scheduler → Connection Manager → WebSocket Engine |
| 08:55-09:00 | Readiness Check | Scheduler (all engines) |
| 09:00-09:05 | Pre-Market | Market Coach, Watchlist, Feature Engine |
| 09:05-09:10 | Limit Order Window | Order Engine phase check |
| 09:10-09:12 | Equilibrium | Phase transition event |
| 09:12-09:15 | Buffer | Controlled transition |
| 09:15 | Live Feed Start | WebSocket Engine → Feature Engine → All |
| 15:16 | Square-off Trigger | Scheduler → Squareoff Engine → Order Engine |
| 15:30 | Feed Stop | Scheduler → Connection Manager (subscriptions) |
| 15:31 | WebSocket Close | Scheduler → WebSocket Engine |
| 16:00 | Logout | Scheduler → Session Manager |

---

## Database Architecture

**Single Source of Truth**: MongoDB (Motor async driver)

**Core Collections** (11):
- `orders` - Order lifecycle (1yr TTL)
- `positions` - Open/closed positions (1yr TTL)
- `sessions` - User session state (30min TTL)
- `market_data` - Real-time ticks (24hr TTL)
- `audit_log` - Compliance trail (7yr TTL)
- `targets` - Trading targets (1yr TTL)
- `notifications` - User notifications (90day TTL)
- `config` - System configuration (persistent)
- `users` - User accounts (persistent)
- `broker_adapters` - Broker connection state (persistent)
- `session_manager_config` - Session Manager runtime config

**Connection Pool**: 5-50 connections, auto-reconnect, retry writes

---

## Configuration Management

**Sources** (priority order):
1. Environment variables (highest)
2. `.env` file (python-service/)
3. `.env.local` (backend-only secrets, gitignored)
4. MongoDB persisted settings (runtime overrides)
5. Code defaults (lowest)

**Key Categories**:
- Kotak SDK credentials (5 vars)
- MongoDB connection (10+ vars)
- Scheduler times (14+ vars)
- Broker mode selection (kotak/shoonya/dummy)
- JWT auth (5 vars)
- WebSocket reconnect (5 vars)
- Tick buffer (3 vars)
- Atlas cleanup (3 vars)

---

## Security Boundaries

```
┌────────────────────────────────────────────────────────────┐
│                    BACKEND PROCESS                          │
│  ┌─────────────┐  ┌─────────────┐  ┌────────────────────┐  │
│  │ Kotak Creds │  │ Shoonya Creds│  │ JWT Secret         │  │
│  │ (NEVER      │  │ (NEVER       │  │ (NEVER             │  │
│  │  EXPOSED)   │  │  EXPOSED)    │  │  EXPOSED)          │  │
│  └─────────────┘  └─────────────┘  └────────────────────┘  │
│         │               │                    │               │
│         ▼               ▼                    ▼               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Broker Adapters (only place importing neo_api_client)│  │
│  └─────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
                             │
                    REST + WS#3/WS#4
                             │
                    ┌────────▼────────┐
                    │   FRONTEND      │
                    │ (NO broker creds│
                    │  NO broker SDK) │
                    └─────────────────┘
```

---

## Observability

- **Structured Logging**: JSON-formatted, IST timestamps via middleware
- **API Telemetry**: Per-request latency, status, DB-related flag
- **Engine Heartbeats**: Periodic state_stamp updates
- **Health Endpoints**: `/health` → `/api/system/health` (503 when MongoDB down)
- **Event Ledger**: All significant events persisted to MongoDB
- **WebSocket History**: 7-day retention (TTL + backend cleanup)
- **Data Insights**: Telemetry buckets, incident correlation, daily reports

---

## Deployment Model

- **Single Process**: FastAPI application (uvicorn)
- **Multi-threaded**: WebSocket feed handling in threads
- **Database**: MongoDB (local or Atlas)
- **Broker Adapters**: In-process SDK integration
- **Frontend**: Next.js (separate process, dev/prod)
- **Process Guard**: Singleton mutex prevents duplicate backend instances

---

## Related Documents

- `DEPENDENCY_MAP.md` - Detailed dependency graph
- `DATA_FLOW_MAP.md` - Critical data flow traces
- `PROJECT_MAP.md` - Navigation map
- `ENGINE_INVENTORY.md` - Engine details
- `08_WEBSOCKET_ARCHITECTURE.md` - WebSocket canonical
- `17_DATABASE_ARCHITECTURE.md` - Database details
- `06_BROKER_ARCHITECTURE.md` - Broker details