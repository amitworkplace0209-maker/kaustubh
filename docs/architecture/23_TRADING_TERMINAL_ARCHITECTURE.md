**STATUS: MIGRATED 2026-09-23 � 4-WS model (WebSocket_ConnectionManager_Flow.md + 08_WEBSOCKET_ARCHITECTURE.md). Dual description WS#1+WS#2 collapsed; now WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend. See 08/09 for canonical flows.**

# 23_TRADING_TERMINAL_ARCHITECTURE.md - Full Trading Terminal Architecture

## 23.1 Full Trading Terminal Overview
The complete KAUSTUBH trading terminal integrates all 35 architecture domains into a unified system. This document provides the holistic view of the entire trading terminal architecture.

### 23.2 Complete System Architecture
```
┌─────────────────────────────────────────────────────────────┐
│                    FRONTEND LAYER                           │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  React PWA (C:\project\app) - 30+ page components  │   │
│  │  - Watchlist, Market Data, Order Entry, Positions   │   │
│  │  - PnL Dashboard, Targets, Squareoff, Reports       │   │
│  └──────────────────────┬──────────────────────────────┘   │
│                         │                                  │
│                         │ WS#2 (Connection Manager)         │
└─────────────────────────┼─────────────────────────────────┘
                          │
┌─────────────────────────┼─────────────────────────────────┐
│                 BACKEND LAYER (FastAPI)                    │
│  ┌──────────────────────────────────────────────────────┐ │
│  │  API Layer                                           │ │
│  │  - REST endpoints (/api/orders, /api/config, etc.)   │ │
│  │  - WebSocket endpoints (WS#2)                        │ │
│  └──────────────────────┬──────────────────────────────┘ │
│                         │                                  │
│  ┌──────────────────────┼──────────────────────────────┐ │
│  │  Engine Layer        │                              │ │
│  │  ┌───────────────────┼──────────────────────────┐   │ │
│  │  │ Core Trading      │                          │   │ │
│  │  │ - order_engine    │                          │   │ │
│  │  │ - risk_engine     │                          │   │ │
│  │  │ - margin_engine   │                          │   │ │
│  │  │ - sqareoff_engine │ (DEGRADED)               │   │ │
│  │  │ - target_engine   │                          │   │ │
│  │  │ - watchlist_engine│                          │   │ │
│  │  └───────────────────┼──────────────────────────┘   │ │
│  │  ┌───────────────────┼──────────────────────────┐   │ │
│  │  │ Data & Feeds      │                          │   │ │
│  │  │ - feature_engine  │                          │   │ │
│  │  │ - websocket_engine│                          │   │ │
│  │  │ - scheduler_engine│                          │   │ │
│  │  │ - connection_engine│                        │   │ │
│  │  │ - database_engine │                          │   │ │
│  │  └───────────────────┼──────────────────────────┘   │ │
│  │  ┌───────────────────┼──────────────────────────┐   │ │
│  │  │ Infrastructure    │                          │   │ │
│  │  │ - session_engine  │                          │   │ │
│  │  │ - broker_manager  │                          │   │ │
│  │  │ - audit_engine    │ (UNKNOWN)                │   │ │
│  │  │ - watchlist_target│ (UNKNOWN)                │   │ │
│  │  │   _engine         │                          │   │ │
│  │  └───────────────────┼──────────────────────────┘   │ │
│  └──────────────────────┼──────────────────────────────┘ │
│                         │                                  │
│  ┌──────────────────────┼──────────────────────────────┐ │
│  │  Data Layer          │                              │ │
│  │  - MongoDB (primary) │                              │ │
│  │  - Event Bus         │                              │ │
│  └──────────────────────┼──────────────────────────────┘ │
└─────────────────────────┼─────────────────────────────────┘
                          │
┌─────────────────────────┼─────────────────────────────────┐
│                 EXTERNAL LAYER                             │
│  ┌──────────────────────┼──────────────────────────────┐ │
│  │  Broker Adapters     │                              │ │
│  │  - kotak_adapter     │                              │ │
│  │  - shoonya_adapter   │                              │ │
│  │  - dummy_adapter     │                              │ │
│  └──────────────────────┼──────────────────────────────┘ │
│                         │                                  │
│  ┌──────────────────────┼──────────────────────────────┐ │
│  │  Exchange Connectivity│                              │ │
│  │  - NSE               │                              │ │
│  │  - BSE               │                              │ │
│  │  - MCX               │                              │ │
│  └──────────────────────┴──────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 23.3 Complete Engine Inventory
| # | Engine | Type | State | Phase | Health |
|---|--------|------|-------|-------|--------|
| 1 | database_engine | Native | RUNNING | 1 | ✅ Healthy |
| 2 | scheduler_engine | Native | RUNNING | 1 | ✅ Healthy |
| 3 | connection_engine | Native | RUNNING | 1 | ✅ Healthy |
| 4 | feature_engine | Native | RUNNING | 1 | ✅ Healthy |
| 5 | risk_engine | Native | RUNNING | 1 | ✅ Healthy |
| 6 | margin_engine | Native | RUNNING | 1 | ✅ Healthy |
| 7 | order_engine | Native | RUNNING | 1 | ✅ Healthy |
| 8 | session_engine | Native | RUNNING | 1 | ✅ Healthy |
| 9 | websocket_engine | Native | RUNNING | 1 | ✅ Healthy |
| 10 | broker_manager | Native | RUNNING | 1 | ✅ Healthy |
| 11 | target_engine | Native | RUNNING | 1 | ✅ Healthy |
| 12 | watchlist_engine | Native | RUNNING | 1 | ✅ Healthy |
| 13 | sqareoff_engine | Facade | DEGRADED | 1 | ⚠️ Degraded |
| 14 | audit_engine | Native | UNKNOWN | 2 | ❓ Unobserved |
| 15 | watchlist_target_engine | Facade | UNKNOWN | 2 | ❓ Uninitialized |

### 23.4 Complete Architecture Summary
- **Total engines**: 15 registered
- **Operational**: 10 RUNNING (66.7%)
- **Degraded**: 1 (sqareoff_engine)
- **Unknown**: 3 (audit_engine, watchlist_target_engine, 1 more)
- **Full functionality**: Phase 1 core trading fully operational
- **Phase 2 features**: Pending audit_engine and watchlist_target_engine startup
- **Market data**: Flowing from 3 broker adapters, 24 symbols
- **Frontend**: 24 active tabs connected via WS#2
- **Order execution**: Fully functional with real-time risk/margin checks

### 23.5 Key Architectural Decisions
1. **WS#1/WS#2 Separation**: Critical design decision separating broker feeds from frontend distribution
2. **Session Manager as Single Source of Truth**: Session Manager controls all subscriptions
3. **Event-Driven Architecture**: All engines communicate via event bus, not direct calls
4. **State Stamp Pattern**: All engines carry state_stamp for dependency resolution
5. **Native vs Facade Engine Classification**: Different lifecycle management strategies
6. **MongoDB as Primary Store**: Single source of truth for all persistent data
7. **YAML Configuration with Hot Reload**: Runtime configuration changes without restart
8. **15-Engine Design**: Modular engine architecture for maintainability

### 23.6 Current System Health Summary
| Component | Status | Health |
|-----------|--------|--------|
| Overall system | OPERATIONAL | ✅ |
| Core trading | FULLY FUNCTIONAL | ✅ |
| Market data | FLOWING | ✅ |
| Order execution | OPERATIONAL | ✅ |
| Risk management | OPERATIONAL | ✅ |
| Margin management | OPERATIONAL | ✅ |
| Session management | OPERATIONAL | ✅ |
| Broker connectivity | OPERATIONAL | ✅ |
| WebSocket feeds | OPERATIONAL | ✅ |
| Audit trail | NOT OPERATIONAL | ❌ (audit_engine UNKNOWN) |
| Watchlist+Target composite | NOT OPERATIONAL | ❌ (watchlist_target_engine UNKNOWN) |
| Squareoff | DEGRADED | ⚠️ |

---
*Full trading terminal architecture synthesizing all 22+ architecture domains.*
