**STATUS: MIGRATED 2026-09-23 — 4-WS model (WebSocket_ConnectionManager_Flow.md + 08_WEBSOCKET_ARCHITECTURE.md). Dual description WS#1+WS#2 collapsed; now WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend. See 08/09 for canonical flows.**

# 02_ENGINE_ARCHITECTURE.md - Engine Architecture Specification

## 2.1 Engine Classification
### Native Engines (EngineBase subclass, auto-start enabled)
These engines are native KAUSTUBH engine implementations that extend EngineBase. They have full lifecycle management including auto-start on application launch.

| Engine | Responsibility | Key APIs | Events |
|--------|---------------|----------|--------|
| feature_engine | Signal generation, technical analysis | compute_signals(data), get_signals(symbol) | signal_generated, indicator_updated |
| risk_engine | Pre-trade risk checks, limit enforcement | check_order_risk(order), get_active_limits() | risk_check_passed, risk_violation |
| margin_engine | Margin calculation, requirement tracking | calculate_margin(order), get_margin_status() | margin_updated, requirement_changed |
| order_engine | Order lifecycle management, execution | place_order(order), cancel_order(order_id) | order_placed, order_filled, order_cancelled |
| target_engine | Strategy/target management | set_target(symbol, price), check_target() | target_hit, strategy_updated |
| watchlist_engine | Watchlist tracking and filtering | add_watchlist(symbol), get_watchlist() | watchlist_updated, symbol_tracked |
| session_engine | Session state management, subscriptions | subscribe(user_id, channel), unsubscribe(user_id, channel) | session_joined, session_left, subscription_changed |
| connection_engine | Broker connection management | connect(), disconnect(), get_status() | connection_established, connection_lost |
| websocket_engine | WebSocket feed management | start_feed(), stop_feed(), subscribe_feed() | feed_started, feed_stopped, data_received |
| scheduler_engine | Task scheduling, cron execution | schedule_cron(expr), schedule_once(delay) | task_scheduled, task_executed |
| broker_manager | Broker adapter orchestration | get_broker(name), list_brokers() | broker_connected, broker_disconnected |
| database_engine | MongoDB persistence | save(entity), find(query), update(entity) | entity_saved, entity_updated |

### Facade Engines (managed=true, lifecycle delegated)
These engines have `managed=true` in their configuration. Their lifecycle is delegated to the container/manager, and they expose a simplified API.

| Engine | Responsibility | Key APIs | State |
|--------|---------------|----------|-------|
| sqareoff_engine | Position squareoff/closeout at target prices | check_squareoff(positions), execute_squareoff() | DEGRADED - position tracking issue |
| audit_engine | Audit trail and compliance logging | log_event(event), get_audit_log() | UNKNOWN - not observed at runtime |
| watchlist_target_engine | Composite: watchlist + target tracking | get_watchlist_with_targets() | UNKNOWN - not yet initialized |

## 2.2 Engine Base Class Contract
All engines extend `EngineBase` and must implement:
- `initialize()` - Called once at startup, set up dependencies, register events
- `start()` - Begin engine operations (start feeds, listeners, schedulers)
- `stop()` - Graceful shutdown, cleanup resources, unregister events
- `get_state()` - Return current engine state (RUNNING, STOPPED, ERROR, DEGRADED)
- `get_state_stamp()` - Return state_stamp for dependency resolution

## 2.3 State Stamp Pattern
Every engine maintains a `state_stamp` field that serves:
- Dependency resolution: Other engines can check state_stamp to determine if dependencies are satisfied
- Lifecycle coordination: State stamps ensure proper start/stop ordering
- Health monitoring: Runtime state comparison against expected stamps

State stamp format: `{engine_name}-{version}-{status}-{timestamp}`
- Example: `order_engine-v2.3.1-RUNNING-2026-09-21T14:30:00Z`

## 2.4 Engine Initialization Order (Recommended)
1. database_engine - Persistence layer must be ready first
2. connection_engine - Broker connections require DB for state recovery
3. scheduler_engine - Scheduled tasks may depend on other services
4. feature_engine - Signal computation may need historical data from DB
5. risk_engine - Risk limits may reference stored positions
6. margin_engine - Margin calculations reference account state
7. order_engine - Order execution depends on risk and margin checks
8. session_engine - Session state references all active engines
9. websocket_engine - Feed handling depends on connection_engine
10. broker_manager - Broker connections established last
11. target_engine - Strategy targets configured after engine base is ready
12. watchlist_engine - Watchlist population depends on DB and session state
13. sqareoff_engine - Squareoff logic depends on position engine (if separate)
14. audit_engine - Audit logging runs throughout but initializes after others
15. watchlist_target_engine - Composite engine, last in initialization sequence

## 2.5 Engine Dependencies Summary
```
feature_engine:  depends on [database_engine, scheduler_engine]
risk_engine:     depends on [order_engine, margin_engine]
margin_engine:   depends on [database_engine, account_engine]
order_engine:    depends on [risk_engine, margin_engine, connection_engine]
sqareoff_engine: depends on [position_engine, target_engine, watchlist_engine]
target_engine:   depends on [feature_engine, watchlist_engine]
watchlist_engine:depends on [database_engine, session_engine]
session_engine:  depends on [connection_engine, websocket_engine]
connection_engine:depends on [database_engine]
websocket_engine:depends on [connection_engine, scheduler_engine]
scheduler_engine:depends on [database_engine]
broker_manager:  depends on [connection_engine, websocket_engine]
database_engine: no dependencies (base layer)
audit_engine:    depends on [all engines for complete trail]
watchlist_target_engine: depends on [watchlist_engine, target_engine]
```

## 2.6 Engine Event System
All engines use the central event bus for inter-engine communication. Key event types:
- `engine_initialized` - Emitted when engine.initialize() completes
- `engine_started` - Emitted when engine.start() completes
- `engine_stopped` - Emitted when engine.stop() completes
- `engine_failed` - Emitted when engine encounters unrecoverable error
- `state_stamp_updated` - Emitted when engine updates its state_stamp

Engine-specific events are documented in each engine's .md file in `docs/engines/`.

## 2.7 Current Engine Runtime State
| Engine | State | Health | Notes |
|--------|-------|--------|-------|
| feature_engine | RUNNING | Healthy | Signal generation active |
| risk_engine | RUNNING | Healthy | Risk checks passing |
| margin_engine | RUNNING | Healthy | Margin calculations stable |
| order_engine | RUNNING | Healthy | Order execution operational |
| sqareoff_engine | DEGRADED | Unhealthy | Position tracking issue - see gap doc |
| target_engine | RUNNING | Healthy | Strategy targets active |
| watchlist_engine | RUNNING | Healthy | Watchlist tracking OK |
| session_engine | RUNNING | Healthy | Subscription management OK |
| connection_engine | RUNNING | Healthy | Broker connections stable |
| websocket_engine | RUNNING | Healthy | Feed distribution OK |
| scheduler_engine | RUNNING | Healthy | Cron tasks executing |
| broker_manager | RUNNING | Healthy | Broker adapters responsive |
| database_engine | RUNNING | Healthy | MongoDB connection OK |
| audit_engine | UNKNOWN | Unobserved | No runtime events received |
| watchlist_target_engine | UNKNOWN | Not initialized | Composite engine |

---
*Engine architecture based on EngineBase implementations in python-service/core/engines/ and documentation in docs/engines/.*
