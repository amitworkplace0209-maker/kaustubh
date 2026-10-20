**STATUS: MIGRATED 2026-09-23 � 4-WS model (WebSocket_ConnectionManager_Flow.md + 08_WEBSOCKET_ARCHITECTURE.md). Dual description WS#1+WS#2 collapsed; now WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend. See 08/09 for canonical flows.**

# 35_AI_AGENT_CONTEXT.md - AI Agent Context for Codebase Navigation

## 35.1 AI Agent Context Overview
This document provides AI agents and LLMs with the essential context needed to navigate and understand the KAUSTUBH trading terminal codebase.

## 35.2 Key Information for AI Agents

### Project Identity
- **Project Name**: KAUSTUBH / KDS Trading Terminal
- **Project Root**: C:\project
- **Backend**: Python FastAPI at C:\project\python-service
- **Frontend**: React PWA at C:\project\app
- **Database**: MongoDB
- **Total Engines**: 15 (13 native, 2 facade)

### Architecture Summary
- **WS#1**: Broker feed (WebSocket Engine → Broker adapters)
- **WS#2**: Backend→frontend (Connection Manager → Web clients)
- **Session Manager**: Single source of truth for subscriptions
- **Event Bus**: Central pub/sub for inter-engine communication
- **State Stamps**: All engines carry state_stamp for lifecycle tracking
- **15 engines registered**: 10 RUNNING, 1 DEGRADED, 3 UNKNOWN

### Critical Rules for AI Agents
1. **Current implementation is source-of-truth** - Architecture docs define approved architecture; never falsely document something as implemented if code does not match
2. **Engine docs define target architecture** - .md files in docs/engines/ define what the architecture should be
3. **Gap tracking** - Always document CURRENT STATE, TARGET STATE, GAP, and MIGRATION REQUIRED
4. **WS#1 ≠ WS#2** - Never conflate broker feed data with frontend distribution
5. **State stamp pattern** - All engines carry state_stamp for dependency resolution
6. **Native vs Facade** - Native: EngineBase, auto-start; Facade: managed=true, lifecycle delegated

### Engine States (Current)
| Engine | State | Health |
|--------|-------|--------|
| feature_engine | RUNNING | ✅ Healthy |
| risk_engine | RUNNING | ✅ Healthy |
| margin_engine | RUNNING | ✅ Healthy |
| order_engine | RUNNING | ✅ Healthy |
| sqareoff_engine | DEGRADED | ⚠️ Position tracking issue |
| target_engine | RUNNING | ✅ Healthy |
| watchlist_engine | RUNNING | ✅ Healthy |
| session_engine | RUNNING | ✅ Healthy |
| connection_engine | RUNNING | ✅ Healthy |
| websocket_engine | RUNNING | ✅ Healthy |
| scheduler_engine | RUNNING | ✅ Healthy |
| broker_manager | RUNNING | ✅ Healthy |
| database_engine | RUNNING | ✅ Healthy |
| audit_engine | UNKNOWN | ❓ Not observed |
| watchlist_target_engine | UNKNOWN | ❓ Not initialized |

### Architecture Documentation Location
- **Engine docs**: C:\project\docs\engines\ (25+ .md files)
- **Architecture docs**: C:\project\docs\architecture\ (35+ .md files)
- **Index**: C:\project\docs\architecture\00_ARCHITECTURE_INDEX.md
- **Full map**: C:\project\docs\architecture\34_DEVELOPER_ONBOARDING.md

### Code Structure
- **Python service**: C:\project\python-service\
  - core/engines/: All 15 engine implementations
  - brokers/: Broker adapter implementations
  - database/: MongoDB connection manager
  - scheduler/: Scheduler controller
  - api/: FastAPI routes and endpoints
- **Frontend**: C:\project\app\_pages/
  - 30+ page components
  - API endpoints and WebSocket connections
- **Configuration**: C:\project\config.yaml

### Common Tasks for AI Agents
1. **Understand an engine**: Read its .md file in docs/engines/ and its implementation in python-service/core/engines/
2. **Understand a flow**: Read the relevant architecture doc (09-15) and trace the code
3. **Check current state**: Read 31_CURRENT_VS_TARGET.md and 32_ARCHITECTURE_GAPS.md
4. **Fix a gap**: Follow 33_MIGRATION_PLAN.md
5. **Add a new engine**: Follow 34_DEVELOPER_ONBOARDING.md
6. **Navigate codebase**: Use 00_ARCHITECTURE_INDEX.md as starting point

### Key File Paths for AI Agents
| Purpose | Path |
|---------|------|
| Architecture index | C:\project\docs\architecture\00_ARCHITECTURE_INDEX.md |
| Current vs target | C:\project\docs\architecture\31_CURRENT_VS_TARGET.md |
| Architecture gaps | C:\project\docs\architecture\32_ARCHITECTURE_GAPS.md |
| Migration plan | C:\project\docs\architecture\33_MIGRATION_PLAN.md |
| Developer onboarding | C:\project\docs\architecture\34_DEVELOPER_ONBOARDING.md |
| Engine docs | C:\project\docs\engines\ |
| Backend code | C:\project\python-service\ |
| Frontend code | C:\project\app\ |
| Configuration | C:\project\config.yaml |
| Database | MongoDB (kaustubh_trading) |

### Error Handling Patterns
- **Auto-retry**: 3 attempts with exponential backoff (5s, 10s, 30s)
- **Circuit breaker**: 5 consecutive errors → OPEN for 30s
- **Fallback**: Degraded mode with manual intervention
- **Recovery**: Reconciliation from MongoDB, restart engine

### Common Issues
- **sqareoff_engine DEGRADED**: Position tracking issue, needs reconciliation + restart
- **audit_engine UNKNOWN**: Not yet started, needs manual start
- **watchlist_target_engine UNKNOWN**: Composite engine not initialized
- **3 engines not reporting state_stamps**: Need to check engine health

### Best Practices for AI Agents
1. Always check CURRENT vs TARGET before documenting
2. Never assume an engine is running if state is UNKNOWN
3. Always verify engine state before recommending actions
4. Follow the dependency graph (03_ENGINE_DEPENDENCY_GRAPH.md) for startup order
5. Use the event architecture (29_EVENT_ARCHITECTURE.md) for understanding inter-engine communication
6. Check the gaps document (32_ARCHITECTURE_GAPS.md) for known issues
7. Follow the migration plan (33_MIGRATION_PLAN.md) for deployment guidance

---
*AI agent context based on project structure, engine documentation, and observed runtime state.*
