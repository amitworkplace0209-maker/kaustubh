**STATUS: MIGRATED 2026-09-23 — 4-WS model (WebSocket_ConnectionManager_Flow.md + 08_WEBSOCKET_ARCHITECTURE.md). Dual description WS#1+WS#2 collapsed; now WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend. See 08/09 for canonical flows.**

# KAUSTUBH/KDS Trading Terminal - Architecture Documentation Index

## Overview
This directory contains the authoritative architecture documentation for the KAUSTUBH trading terminal system. Documentation is organized into logical domains covering system architecture, engine implementations, data flows, lifecycle management, and operational concerns.

## Documentation Structure

### Domain Categories
- **00-**: Index and reference documents
- **01-**: System overview and engineering metadata
- **02-**: Engine architecture and component specifications
- **03-**: Dependency graphs and component interactions
- **04-**: Startup and shutdown procedures
- **05-**: Runtime lifecycle and state management
- **06-**: Broker adapter and connectivity architecture
- **07-**: Session management and subscription architecture
- **08-**: WebSocket and real-time communication architecture
- **09-**: Realtime market data flow architecture
- **10-**: Market data flow from sources to consumers
- **11-**: Trading execution flow architecture
- **12-**: Order lifecycle from placement to settlement
- **13-**: Risk and margin architecture
- **14-**: Position and PnL tracking architecture
- **15-**: Squareoff/closeout architecture
- **16-**: Audit, logging, and notification architecture
- **17-**: Database schema and storage architecture
- **18-**: Configuration management and environment setup
- **19-**: User interface and page architecture
- **20-**: Service lifecycle and phase gates
- **21-**: Phase 1 (core trading) architecture
- **22-**: Phase 2 (advanced features) architecture
- **23-**: Full trading terminal architecture
- **24-**: PWA and accessibility architecture
- **25-**: Security and compliance architecture
- **26-**: Error handling and recovery architecture
- **27-**: Observability, monitoring, and logging architecture
- **28-**: API surface and endpoint architecture
- **29-**: Event system and publish-subscribe architecture
- **30-**: Engine-to-UI mapping and component correspondence
- **31-**: Current state vs target architecture comparison
- **32-**: Architecture gaps and remediation plan
- **33-**: Migration roadmap and incremental upgrade path
- **34-**: Developer onboarding and setup guide
- **35-**: AI agent and LLM context for codebase navigation

### Documentation Rules
1. **Current implementation is source-of-truth**: Architecture docs define the *approved* architecture; never falsely document something as implemented if the code does not match
2. **Engine docs are the approved architecture**: The .md files in `docs/engines/` define what the target architecture should be
3. **Gap tracking**: For each component, document CURRENT STATE, TARGET STATE, GAP, and MIGRATION REQUIRED
4. **State distinctions**: Native engines (EngineBase, auto-start) vs facade engines (managed=true, lifecycle delegated)
5. **WS#1/WS#2 separation**: WS#1 = broker feed (WebSocket Engine), WS#2 = backendâ†’frontend (Connection Manager)
6. **Session Manager as single source of truth** for subscriptions

### How to Use This Documentation
- Start with `00_ARCHITECTURE_INDEX.md` for the table of contents
- Review `01_SYSTEM_OVERVIEW.md` for the big-picture architecture
- Consult engine-specific docs in `docs/engines/` for detailed engine specifications
- Use `31_CURRENT_VS_TARGET.md` to understand implementation gaps
- Refer to `33_MIGRATION_PLAN.md` for upgrade/rollback procedures

### Index Files
| File | Description |
|------|-------------|
| 00_ARCHITECTURE_INDEX.md | This file - documentation map and cross-references |
| 31_CURRENT_VS_TARGET.md | Current implementation status vs target architecture |
| 32_ARCHITECTURE_GAPS.md | Documented gaps between current and target |
| 33_MIGRATION_PLAN.md | Prioritized migration roadmap |
| 34_DEVELOPER_ONBOARDING.md | Onboarding guide for new developers |
| 35_AI_AGENT_CONTEXT.md | AI/LLM context for codebase navigation |
| ARCHITECTURE_DOCUMENTATION_AUDIT.md | Audit of documentation completeness |

### Engine Documentation Cross-Reference
Each engine in `docs/engines/` has a corresponding architectural specification. Key engines include:
- feature_engine - Feature engineering and signal generation
- risk_engine - Risk limits and pre-trade risk checks
- margin_engine - Margin calculation and requirement tracking
- order_engine - Order lifecycle management and execution
- sqareoff_engine - Squareoff/closeout position management
- target_engine - Target/strategy management
- watchlist_engine - Watchlist management and tracking
- session_engine - Session management and subscription tracking
- connection_engine - Broker connection management
- websocket_engine - WebSocket feed management
- scheduler_engine - Task scheduling and cron execution
- broker_manager - Broker adapter orchestration
- database_engine - MongoDB data persistence
- audit_engine - Audit trail and compliance logging

### Recent Updates
- **2026-09-21**: Initial architecture documentation rebuild started
- All 35 architecture files to be created with current-state vs target-state analysis
- Based on scan of 25+ engine docs, 13 existing architecture files, Python service code, and 30+ frontend pages

---
*Generated as part of KAUSTUBH/KDS trading terminal architecture documentation rebuild.*
