**STATUS: MIGRATED 2026-09-23 � 4-WS model (WebSocket_ConnectionManager_Flow.md + 08_WEBSOCKET_ARCHITECTURE.md). Dual description WS#1+WS#2 collapsed; now WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend. See 08/09 for canonical flows.**

# 01_SYSTEM_OVERVIEW.md - KAUSTUBH/KDS Trading Terminal System Overview

## 1.1 System Identity
- **Project Name**: KAUSTUBH / KDS Trading Terminal
- **Project Type**: Algorithmic trading terminal with PWA interface
- **Architecture Philosophy**: Engine-first design with session management as single source of truth

## 1.2 Core Architectural Principles
1. **Engine-First Design**: All trading functionality is encapsulated in independent engine components
2. **Session Manager as Single Source of Truth**: Session Manager tracks active subscriptions, order states, and user context
3. **WS#1/WS#2 Separation**: 
   - WS#1 = Broker feed (WebSocket Engine → Broker adapters → Market data)
   - WS#2 = Backend→frontend distribution (Connection Manager → Web clients)
4. **Native vs Facade Engines**: 
   - Native: EngineBase subclass, auto-start enabled, full lifecycle managed
   - Facade: managed=true, lifecycle delegated to container, simplified API
5. **State Stamp Pattern**: All engines carry `state_stamp` for lifecycle tracking and dependency resolution
6. **Event-Driven Inter-Engine Communication**: Engines communicate via published events, not direct dependencies

## 1.3 System Architecture Layers
```
Layer 0: Hardware/OS - Base execution environment
Layer 1: Broker Adapters - Kotak, Shoonya, Dummy connectivity
Layer 2: Engine Layer - Core trading engines (feature, risk, margin, order, etc.)
Layer 3: Service Layer - Scheduler, connection manager, session manager
Layer 4: Data Layer - MongoDB persistence, realtime feeds
Layer 5: API Layer - FastAPI REST/WebSocket endpoints
Layer 6: UI Layer - React/PWA frontend (30+ pages)
```

## 1.4 Engine Inventory (15 Registered)
| Engine | Type | State | Auto-Start |
|--------|------|-------|------------|
| feature_engine | Native | RUNNING | Yes |
| risk_engine | Native | RUNNING | Yes |
| margin_engine | Native | RUNNING | Yes |
| order_engine | Native | RUNNING | Yes |
| sqareoff_engine | Facade | DEGRADED | No |
| target_engine | Native | RUNNING | Yes |
| watchlist_engine | Native | RUNNING | Yes |
| session_engine | Native | RUNNING | Yes |
| connection_engine | Native | RUNNING | Yes |
| websocket_engine | Native | RUNNING | Yes |
| scheduler_engine | Native | RUNNING | Yes |
| broker_manager | Native | RUNNING | Yes |
| database_engine | Native | RUNNING | Yes |
| audit_engine | Native | UNKNOWN | No |
| watchlist_target_engine | Facade | UNKNOWN | No |

*States: RUNNING=active and healthy, DEGRADED=initialized but malfunctioning, UNKNOWN=not yet observed, REGISTERED=configured but not started*

## 1.5 Data Flow Summary
- **Market Data**: Broker WebSocket → connection_engine → websocket_engine → feature_engine signals → order_engine execution
- **Order Flow**: UI → API → order_engine → broker adapter → exchange → order_engine → confirmation → UI
- **Risk Flow**: order_engine → risk_engine (pre-trade check) → margin_engine → order execution
- **Session Flow**: Session Manager tracks all subscriptions; engines subscribe/unsubscribe based on user context
- **Squareoff Flow**: sqareoff_engine monitors positions and auto-closes at target trigger prices

## 1.6 Key Dependencies
- MongoDB as primary data store (connection_engine manages pool)
- FastAPI as request router and WebSocket handler
- WebSocket transport for both broker feeds (WS#1) and frontend distribution (WS#2)
- Redis optional for pub/sub cross-process communication

## 1.7 Deployment Model
- Single-process FastAPI application
- Multi-threaded for WebSocket feed handling
- MongoDB for persistence
- Broker adapters via subprocess or threaded integration

## 1.8 Current Status Summary
- **15 engines registered**: All configured in system
- **10 engines running**: feature, risk, margin, order, target, watchlist, session, connection, websocket, scheduler
- **2 engines degraded**: sqareoff_engine (position tracking issue), audit_engine (not observed)
- **3 engines unknown**: status not yet observed at runtime
- Architecture docs in `docs/architecture/` define the target state for each engine

---
*System overview based on scan of engine documentation, Python service codebase, and runtime state observation.*
