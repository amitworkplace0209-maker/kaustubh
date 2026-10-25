**STATUS: MIGRATED 2026-09-23 � 4-WS model (WebSocket_ConnectionManager_Flow.md + 08_WEBSOCKET_ARCHITECTURE.md). Dual description WS#1+WS#2 collapsed; now WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend. See 08/09 for canonical flows.**

# 04_STARTUP_SHUTDOWN_LIFECYCLE.md - Startup and Shutdown Lifecycle

## 4.1 Startup Lifecycle Overview
The KAUSTUBH trading terminal follows a deterministic startup sequence governed by the engine dependency graph (see 03_ENGINE_DEPENDENCY_GRAPH.md). Startup proceeds in two phases: foundation layer initialization, followed by layer-by-layer engine activation.

### Phase 1: Foundation Layer (Steps 1-2)
| Step | Engine | Purpose | Completion Criteria |
|------|--------|---------|---------------------|
| 1 | `database_engine` | Initialize MongoDB connection pool | `get_state() == RUNNING` and `connection_pool.active > 0` |
| 2 | `scheduler_engine` | Initialize task scheduler with cron expressions | `get_state() == RUNNING` and `scheduled_tasks.registered > 0` |

### Phase 2: Layer-by-Layer Engine Activation (Steps 3-14)
| Step | Engine | Depends On | Start Command | Health Check |
|------|--------|------------|---------------|--------------|
| 3 | `connection_engine` | `database_engine` | `engine.start()` | Broker adapter registry populated |
| 4 | `feature_engine` | `database_engine`, `scheduler_engine` | `engine.start()` | Signal computation metrics available |
| 5 | `margin_engine` | `database_engine` | `engine.start()` | Margin calculation stable |
| 6 | `risk_engine` | `order_engine`, `margin_engine` (starting order_engine first) | `engine.start()` | All risk limits accessible |
| 7 | `order_engine` | `risk_engine`, `margin_engine`, `connection_engine` | `engine.start()` | Order placement API responsive |
| 8 | `websocket_engine` | `connection_engine`, `scheduler_engine` | `engine.start()` | WebSocket feed listening |
| 9 | `session_engine` | `connection_engine`, `websocket_engine` | `engine.start()` | Session subscriptions active |
| 10 | `target_engine` | `feature_engine`, `watchlist_engine` | `engine.start()` | Strategy targets configured |
| 11 | `watchlist_engine` | `database_engine`, `session_engine` | `engine.start()` | Watchlist database records loaded |
| 12 | `sqareoff_engine` | `target_engine`, `watchlist_engine`, `watchlist_target_engine` | `engine.start()` | Squareoff conditions monitored |
| 13 | `audit_engine` | ALL engines (last to start) | `engine.start()` | Audit trail capture active |
| 14 | `watchlist_target_engine` | `watchlist_engine`, `target_engine` (composite) | `engine.start()` | Composite watchlist+target operational |

### 4.2 Startup Completion Criteria
Full startup is considered complete when:
- All 15 engines have `get_state() == RUNNING`
- All engine state_stamps are consistent (no version mismatches)
- Session Manager has active subscriptions configured
- Connection Manager has broker connections established
- WebSocket feeds are streaming market data
- Order placement is functional (risk + margin checks passing)

**Observed Runtime State**: As of current observation, 10/15 engines are RUNNING, 1 is DEGRADED (sqareoff_engine), and 3 are UNKNOWN (audit_engine, watchlist_target_engine).

### 4.3 Shutdown Lifecycle Overview
Shutdown proceeds in exact reverse order of startup, ensuring graceful resource cleanup and audit trail completion.

| Step | Engine | Shutdown Command | Purpose |
|------|--------|------------------|---------|
| 1 | `audit_engine` | `engine.stop()` | flush audit buffers, ensure all events logged |
| 2 | `watchlist_target_engine` | `engine.stop()` | composite engine cleanup |
| 3 | `sqareoff_engine` | `engine.stop()` | cancel pending squareoff operations |
| 4 | `watchlist_engine` | `engine.stop()` | unsubscribe from all watchlist channels |
| 5 | `target_engine` | `engine.stop()` | persist target state, save strategy configs |
| 6 | `session_engine` | `engine.stop()` | unsubscribe all user sessions, close channels |
| 7 | `websocket_engine` | `engine.stop()` | stop WebSocket feeds, disconnect data sources |
| 8 | `connection_engine` | `engine.stop()` | disconnect broker adapters, release connections |
| 9 | `order_engine` | `engine.stop()` | cancel pending orders, persist order state |
| 10 | `risk_engine` | `engine.stop()` | persist risk limit state, final checks |
| 11 | `margin_engine` | `engine.stop()` | persist margin calculations, release resources |
| 12 | `feature_engine` | `engine.stop()` | shut down signal computation, clean up caches |
| 13 | `scheduler_engine` | `engine.stop()` | cancel scheduled tasks, persist timer state |
| 14 | `connection_engine` (secondary) | `engine.stop()` | final broker connection teardown |
| 15 | `database_engine` | `engine.stop()` | close MongoDB connection pool, persist shutdown state |

### 4.4 Startup/Shutdown Commands
```
# Startup
python -m kaushub.cli start
# or individual engine startup
python -m kaushub.engine start <engine_name>

# Shutdown
python -m kaushub.cli shutdown
# or individual engine shutdown
python -m kaushub.engine stop <engine_name>

# Status check
python -m kaushub.cli status
# or
python -m kaushub.engine status <engine_name>
```

### 4.5 Lifecycle State Machine
Each engine follows a 4-state machine:
```
IDLE → INITIALIZING → RUNNING → STOPPING → STOPPED
     ↘ ERROR (unrecoverable)
```

State transitions are governed by:
- `engine.initialize()` → moves from IDLE to INITIALIZING, then to RUNNING on success
- `engine.start()` → moves from RUNNING to active operations
- `engine.stop()` → moves from RUNNING to STOPPING, then to STOPPED
- Unhandled exceptions → move to ERROR state, requires manual restart

### 4.6 Startup Failure Handling
If any engine fails to start:
1. Affected engine state set to ERROR
2. Dependent engines blocked from starting (dependency check fails)
3. System enters DEGRADED mode - partial functionality available
4. Audit engine logs startup failure event
5. Operator can: `restart <engine_name>` or `bypass <engine_name>` (risk operation)

### 4.7 Observed Startup Behavior
- **Successful**: 10 engines start in correct dependency order
- **Partial**: sqareoff_engine fails DEGRADED due to position tracking issue
- **Blocked**: audit_engine and watchlist_target_engine remain UNKNOWN (not yet observed starting)
- **Recovery**: Manual restart of sqareoff_engine resolves position tracking issue in most cases

---
*Startup/shutdown lifecycle based on EngineBase implementations in python-service/core/engines/ and runtime state observation.*
