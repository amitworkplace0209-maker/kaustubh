**STATUS: MIGRATED 2026-09-23 — 4-WS model (WebSocket_ConnectionManager_Flow.md + 08_WEBSOCKET_ARCHITECTURE.md). Dual description WS#1+WS#2 collapsed; now WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend. See 08/09 for canonical flows.**

# 34_DEVELOPER_ONBOARDING.md - Developer Onboarding Guide

## 34.1 Developer Onboarding Overview
This guide helps new developers understand the KAUSTUBH trading terminal architecture and get started with development.

## 34.2 System Architecture Quick Start

### Core Concepts
1. **Engine-First Design**: All functionality encapsulated in 15 independent engines
2. **WS#1/WS#2 Separation**: Broker feeds (WS#1) vs frontend distribution (WS#2)
3. **Session Manager**: Single source of truth for all subscriptions
4. **Event-Driven**: All engines communicate via central event bus
5. **State Stamps**: All engines carry state_stamp for lifecycle tracking

### Key Directories
| Directory | Purpose |
|-----------|---------|
| `C:\project\docs\engines\` | Engine documentation (25+ .md files) |
| `C:\project\docs\architecture\` | Architecture documentation (35+ .md files) |
| `C:\project\python-service\` | Backend Python service |
| `C:\project\python-service\core\engines\` | Engine implementations |
| `C:\project\python-service\brokers\` | Broker adapters |
| `C:\project\python-service\database\` | MongoDB connection |
| `C:\project\python-service\scheduler\` | Scheduler controller |
| `C:\project\python-service\api\` | FastAPI routes |
| `C:\project\app\_pages\` | Frontend page components |

### Engine Classification
- **Native Engines**: Extend EngineBase, auto-start enabled (13 engines)
- **Facade Engines**: managed=true, lifecycle delegated (2 engines: sqareoff_engine, watchlist_target_engine)

## 34.3 Development Setup
```bash
# Clone and setup
cd C:\project
python -m pip install -r requirements.txt

# Start all engines
python -m kaushub.cli start

# Check status
python -m kaushub.cli status

# View engine logs
python -m kaushub.engine logs <engine_name>
```

## 34.4 Adding a New Engine
1. Create engine class extending EngineBase in `python-service/core/engines/`
2. Implement `initialize()`, `start()`, `stop()`, `get_state()`, `get_state_stamp()`
3. Add engine documentation in `docs/engines/`
4. Update architecture documentation
5. Add to engine dependency graph
6. Test with `python -m kaushub.engine start <new_engine>`

## 34.5 Testing Architecture
- **Unit Tests**: Per engine in `python-service/tests/`
- **Integration Tests**: Engine interaction tests
- **Load Tests**: WebSocket and order throughput
- **Compliance Tests**: Audit and security validation

## 34.6 Documentation Standards
- Every engine must have a .md file in `docs/engines/`
- Architecture docs follow the 35-file structure in `docs/architecture/`
- Use CURRENT vs TARGET format for all architecture docs
- Always document state_stamp for each engine
- Update ARCHITECTURE_DOCUMENTATION_AUDIT.md after changes

## 34.7 Quick Reference Commands
```bash
# Engine management
python -m kaushub.engine start <name>
python -m kaushub.engine stop <name>
python -m kaushub.engine restart <name>
python -m kaushub.engine status <name>
python -m kaushub.engine diagnose <name>
python -m kaushub.engine reconcile positions

# System management
python -m kaushub.cli start
python -m kaushub.cli shutdown
python -m kaushub.cli status

# Database
python -m kaushub.db.connect
python -m kaushub.db.query <collection> <filter>
```

## 34.8 Architecture Documentation Map
| Doc # | File | Description |
|-------|------|-------------|
| 00 | 00_ARCHITECTURE_INDEX.md | Documentation index and cross-references |
| 01 | 01_SYSTEM_OVERVIEW.md | System overview and engineering metadata |
| 02 | 02_ENGINE_ARCHITECTURE.md | Engine architecture and specifications |
| 03 | 03_ENGINE_DEPENDENCY_GRAPH.md | Engine dependency DAG |
| 04 | 04_STARTUP_SHUTDOWN_LIFECYCLE.md | Startup and shutdown procedures |
| 05 | 05_RUNTIME_LIFECYCLE.md | Runtime lifecycle and state management |
| 06 | 06_BROKER_ARCHITECTURE.md | Broker adapter architecture |
| 07 | 07_SESSION_ARCHITECTURE.md | Session management architecture |
| 08 | 08_WEBSOCKET_ARCHITECTURE.md | WebSocket architecture (WS#1/WS#2) |
| 09 | 09_REALTIME_DATA_FLOW.md | Realtime data flow architecture |
| 10 | 10_MARKET_DATA_FLOW.md | Market data flow architecture |
| 11 | 11_TRADING_FLOW.md | Trading execution flow |
| 12 | 12_ORDER_LIFECYCLE.md | Order lifecycle architecture |
| 13 | 13_RISK_MARGIN_ARCHITECTURE.md | Risk and margin architecture |
| 14 | 14_POSITION_PNL_ARCHITECTURE.md | Position and PnL architecture |
| 15 | 15_TARGET_SQUAREOFF_ARCHITECTURE.md | Target and squareoff architecture |
| 16 | 16_AUDIT_NOTIFICATION_ARCHITECTURE.md | Audit and notification architecture |
| 17 | 17_DATABASE_ARCHITECTURE.md | Database architecture |
| 18 | 18_CONFIGURATION_ARCHITECTURE.md | Configuration architecture |
| 19 | 19_UI_ARCHITECTURE.md | UI architecture |
| 20 | 20_SERVICE_PHASE_ARCHITECTURE.md | Service phase architecture |
| 21 | 21_PHASE_1_ARCHITECTURE.md | Phase 1 core trading |
| 22 | 22_PHASE_2_ARCHITECTURE.md | Phase 2 advanced features |
| 23 | 23_TRADING_TERMINAL_ARCHITECTURE.md | Full trading terminal overview |
| 24 | 24_PWA_ACCESSIBILITY_ARCHITECTURE.md | PWA and accessibility |
| 25 | 25_SECURITY_ARCHITECTURE.md | Security architecture |
| 26 | 26_ERROR_RECOVERY_ARCHITECTURE.md | Error recovery architecture |
| 27 | 27_OBSERVABILITY_ARCHITECTURE.md | Observability architecture |
| 28 | 28_API_ARCHITECTURE.md | API architecture |
| 29 | 29_EVENT_ARCHITECTURE.md | Event architecture |
| 30 | 30_ENGINE_UI_MAPPING.md | Engine-to-UI mapping |
| 31 | 31_CURRENT_VS_TARGET.md | Current vs target comparison |
| 32 | 32_ARCHITECTURE_GAPS.md | Architecture gaps analysis |
| 33 | 33_MIGRATION_PLAN.md | Migration roadmap |
| 34 | 34_DEVELOPER_ONBOARDING.md | Developer onboarding |
| 35 | 35_AI_AGENT_CONTEXT.md | AI agent context |
| - | ARCHITECTURE_DOCUMENTATION_AUDIT.md | Documentation audit |

## 34.9 Notes
- **Start with 00_ARCHITECTURE_INDEX.md** for documentation map
- **Read 03_ENGINE_DEPENDENCY_GRAPH.md** before modifying engines
- **Check 32_ARCHITECTURE_GAPS.md** for known issues
- **Follow 33_MIGRATION_PLAN.md** for deployment
- **All 35 architecture files** must be maintained
- **Engine docs** in docs/engines/ define approved architecture

---
*Developer onboarding guide based on project structure, engine documentation, and architecture documentation.*
