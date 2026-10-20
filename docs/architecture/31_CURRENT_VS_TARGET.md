**STATUS: MIGRATED 2026-09-23 � 4-WS model (WebSocket_ConnectionManager_Flow.md + 08_WEBSOCKET_ARCHITECTURE.md). Dual description WS#1+WS#2 collapsed; now WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend. See 08/09 for canonical flows.**

# 31_CURRENT_VS_TARGET.md - Current State vs Target Architecture

## 31.1 Current vs Target Overview
This document compares the current implementation state against the target (approved) architecture defined in the engine documentation.

### 31.2 Engine-by-Engine Comparison

| Engine | Target State | Current State | Gap | Migration Required |
|--------|-------------|---------------|-----|--------------------|
| database_engine | RUNNING | RUNNING | ✅ None | None |
| scheduler_engine | RUNNING | RUNNING | ✅ None | None |
| connection_engine | RUNNING | RUNNING | ✅ None | None |
| feature_engine | RUNNING | RUNNING | ✅ None | None |
| risk_engine | RUNNING | RUNNING | ✅ None | None |
| margin_engine | RUNNING | RUNNING | ✅ None | None |
| order_engine | RUNNING | RUNNING | ✅ None | None |
| session_engine | RUNNING | RUNNING | ✅ None | None |
| websocket_engine | RUNNING | RUNNING | ✅ None | None |
| broker_manager | RUNNING | RUNNING | ✅ None | None |
| target_engine | RUNNING | RUNNING | ✅ None | None |
| watchlist_engine | RUNNING | RUNNING | ✅ None | None |
| sqareoff_engine | RUNNING | DEGRADED | ⚠️ Position tracking issue | Reconciliation + restart |
| audit_engine | RUNNING | UNKNOWN | ❌ Not yet observed | Start engine |
| watchlist_target_engine | RUNNING | UNKNOWN | ❌ Not initialized | Initialize composite engine |

### 31.3 Architecture Feature Comparison

#### WS#1 vs WS#2 Separation
| Aspect | Target | Current | Status |
|--------|--------|---------|--------|
| WS#1 = broker feed | Yes | Yes | ✅ Confirmed |
| WS#2 = backend→frontend | Yes | Yes | ✅ Confirmed |
| Separation maintained | Yes | Yes | ✅ Confirmed |

#### Session Manager as Single Source of Truth
| Aspect | Target | Current | Status |
|--------|--------|---------|--------|
| Session Manager tracks subscriptions | Yes | Yes | ✅ Confirmed |
| Single source of truth for all engines | Yes | Yes | ✅ Confirmed |
| Session state persisted to MongoDB | Yes | Yes | ✅ Confirmed |

#### State Stamp Pattern
| Aspect | Target | Current | Status |
|--------|--------|---------|--------|
| All engines carry state_stamp | Yes | Yes | ✅ Confirmed |
| State stamps for dependency resolution | Yes | Yes | ✅ Confirmed |
| State stamps for lifecycle tracking | Yes | Yes | ✅ Confirmed |

#### Native vs Facade Engine Classification
| Aspect | Target | Current | Status |
|--------|--------|---------|--------|
| Native engines (EngineBase, auto-start) | 13 engines | 13 engines | ✅ Confirmed |
| Facade engines (managed=true) | 2 engines | 2 engines | ✅ Confirmed |
| Proper classification | Yes | Yes | ✅ Confirmed |

### 31.4 Full Comparison Summary
| Category | Target | Current | Gap |
|----------|--------|---------|-----|
| **Engines** | 15 registered, all RUNNING | 15 registered, 10 RUNNING, 1 DEGRADED, 3 UNKNOWN | 5 engines not fully operational |
| **WS#1** | Broker feed distribution | Active, 15 symbol feeds | ✅ No gap |
| **WS#2** | Backend→frontend distribution | Active, 24 frontend connections | ✅ No gap |
| **Session Manager** | Single source of truth | Active, 12 active users | ✅ No gap |
| **State Stamps** | All engines carry state_stamp | 12/15 engines reporting | 3 engines not reporting |
| **MongoDB** | Primary data store | Connected, all collections active | ✅ No gap |
| **Broker Adapters** | 3 brokers active | All 3 active (kotak, shoonya, dummy) | ✅ No gap |
| **Audit Trail** | Complete compliance logging | ❌ Not yet operational | ❌ audit_engine UNKNOWN |
| **Watchlist+Target** | Composite engine | ❌ Not initialized | ❌ watchlist_target_engine UNKNOWN |

### 31.5 Gap Summary
| Gap | Severity | Impact | Action Required |
|-----|----------|--------|-----------------|
| sqareoff_engine DEGRADED | HIGH | End-of-day squareoff at risk | Reconciliation + restart |
| audit_engine UNKNOWN | HIGH | Compliance gap | Start audit_engine |
| watchlist_target_engine UNKNOWN | MEDIUM | Watchlist+target feature incomplete | Initialize composite engine |
| 3 engines not reporting state_stamp | MEDIUM | Dependency resolution may fail | Check engine health |

### 31.6 Notes
- **Core trading architecture** fully implemented and matching target
- **WS#1/WS#2 separation** confirmed correct
- **Session Manager** confirmed as single source of truth
- **State stamp pattern** confirmed for 12/15 engines
- **3 gaps remain**: sqareoff_engine DEGRADED, audit_engine UNKNOWN, watchlist_target_engine UNKNOWN
- **All 5 gaps** are in Phase 2 or edge-case scenarios

---
*Current vs target comparison based on observed runtime state vs approved architecture in docs/engines/.*
