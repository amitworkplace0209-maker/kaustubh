**STATUS: MIGRATED 2026-09-23 � 4-WS model (WebSocket_ConnectionManager_Flow.md + 08_WEBSOCKET_ARCHITECTURE.md). Dual description WS#1+WS#2 collapsed; now WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend. See 08/09 for canonical flows.**

# 05_RUNTIME_LIFECYCLE.md - Runtime Lifecycle Management

## 5.1 Runtime Engine States
Each of the 15 engines operates in one of four runtime states, tracked via `get_state()` and `get_state_stamp()`:

| State | Code | Description | Transition Triggers |
|-------|------|-------------|---------------------|
| `RUNNING` | 0 | Engine active, all operations functional | `engine.start()` completed, all dependencies satisfied |
| `STOPPED` | 1 | Engine inactive, resources cleaned up | `engine.stop()` completed |
| `ERROR` | 2 | Unrecoverable error encountered | Exception during start/operation, `get_state() == ERROR` |
| `DEGRADED` | 3 | Functional but with reduced capabilities | sqareoff_engine current state - position tracking issue |

**Current Runtime Distribution** (as of observation):
- RUNNING: 10 engines (feature_engine, risk_engine, margin_engine, order_engine, target_engine, watchlist_engine, session_engine, connection_engine, websocket_engine, scheduler_engine)
- DEGRADED: 1 engine (sqareoff_engine - position tracking)
- UNKNOWN: 3 engines (audit_engine - no events, watchlist_target_engine - not initialized, plus 1 more)

## 5.2 Heartbeat and Liveness Detection
All engines must implement heartbeat publishing via the central event bus:

### Heartbeat Event Format
```
{
  "engine": "<engine_name>",
  "state": "<RUNNING|STOPPED|ERROR|DEGRADED>",
  "state_stamp": "<engine_name>-<version>-<status>-<timestamp>",
  "timestamp": "<ISO8601 UTC>",
  "metrics": {
    "cpu_percent": <float>,
    "memory_mb": <int>,
    "event_queue_depth": <int>,
    "active_subscriptions": <int>,
    "connections_open": <int>
  },
  "last_heartbeat": "<ISO8601 UTC>"
}
```

### Liveness Detection
- **Timeout**: No heartbeat within 30 seconds → engine marked UNHEALTHY
- **Stale**: Heartbeat older than 60 seconds → system logs warning
- **Critical**: No heartbeat from core engines (order_engine, connection_engine) within 10 seconds → auto-alert and possible failover

## 5.3 Runtime Recovery Procedures
When an engine enters ERROR state:

### 5.3.1 Automatic Recovery
1. **Circuit Breaker**: Adjacent engines check state_stamp; if ERROR detected, dependent engines are paused
2. **State Persistence**: Current state saved to MongoDB before recovery attempt
3. **Restart Attempt**: `engine.restart()` called with exponential backoff (attempt 1: 5s, attempt 2: 10s, attempt 3: 30s)
4. **Degraded Mode**: If restart fails, system operates in DEGRADED mode with reduced functionality

### 5.3.2 Manual Recovery
1. `python -m kaushub.engine recover <engine_name>` - targeted restart
2. `python -m kaushub.engine reset <engine_name>` - force state reset to IDLE
3. `python -m kaushub.cli reset-all` - reset all engines to IDLE (destructive)

### 5.3.3 sqareoff_engine DEGRADED Recovery
Specific procedure for the DEGRADED sqareoff_engine:
1. Diagnose position tracking gap: `python -m kaushub.engine diagnose sqareoff_engine`
2. Force position reconciliation: `python -m kaushub.engine reconcile positions`
3. Restart sqareoff_engine: `python -m kaushub.engine restart sqareoff_engine`
4. Verify state: `python -m kaushub.engine status sqareoff_engine` should show RUNNING

## 5.4 Session Management Lifecycle
Session Manager (session_engine) oversees user session runtime state:

### Session States
```
USER_SESSION: active → subscribed → unsubmitted → completed → expired
SUBSCRIPTION: joined → active → left → refreshed
FEED: subscribed → streaming → paused → disconnected
```

### Session Timeout Policy
- **User inactivity**: 30 minutes → session marked expired, subscriptions auto-unsubscribed
- **System maintenance**: 15 minutes warning → all sessions gracefully disconnected
- **Broker disconnect**: Immediate session invalidation, reconnection required

### Session Persistence
- Session state saved to MongoDB every 5 minutes
- On reconnection, session state restored from DB
- Active order states preserved for 24 hours post-session expiry

## 5.5 WebSocket Feed Runtime Management
WebSocket Engine (websocket_engine) manages real-time data flow:

### Feed States per Symbol
```
SYMBOL_FEED: uninitialized → connecting → streaming → paused → error → disconnected
```

### Runtime Feed Operations
- **Auto-resubscribe**: On reconnection, previously subscribed symbols automatically resubscribed
- **Quality of Service**: At-least-once delivery guarantee for market data messages
- **Backpressure**: Downstream consumers (feature_engine) can signal backpressure via event bus
- **Feed Priority**: L1 data (bids/asks) > L2 data (order book) > L3 data (trades)

### Current Feed Status
- **Connection Engine**: 5 broker feeds active (Kotak, Shoonya, Dummy)
- **WebSocket Engine**: 15 symbol feeds streaming
- **Feature Engine**: Receiving real-time signals from all active feeds

## 5.6 Order Execution Runtime
Order Engine (order_engine) manages order lifecycle at runtime:

### Order States
```
ORDER_LIFECYCLE: pending → validated → accepted → transmitted → filled → cancelled → rejected
```

### Pre-Trade Validation (at time of order placement)
1. **Risk Check**: risk_engine.check_order_risk(order) - must PASS
2. **Margin Check**: margin_engine.calculate_margin(order) - sufficient funds required
3. **Session Check**: session_engine.validate_user_context(user_id, order)
4. **Circuit Breaker**: System-wide halt check - NO new orders if halted

### Order Timeout Policy
- **Pending orders**: 4-hour auto-cancel if not filled
- **Rejected orders**: 24-hour retry window before user must resubmit
- **Cancelled orders**: Immediately removed from active state, preserved in history

## 5.7 Runtime Monitoring and Observability
All engines publish runtime metrics to the central observability system:

### Core Metrics (published every 5 seconds)
- `engine_cpu_usage` - CPU percentage
- `engine_memory_usage` - MB allocated
- `event_bus_latency` - ms from event production to consumption
- `websocket_latency` - ms from feed generation to consumer receipt
- `db_query_latency` - MongoDB operation latency (ms)
- `broker_connection_health` - connected/disconnected/reconnecting

### Alert Thresholds
- **WARNING**: CPU > 70%, memory > 80%, event queue depth > 1000
- **ERROR**: CPU > 90%, memory > 95%, broker connection lost
- **CRITICAL**: Order engine risk check bypass, database connection lost

## 5.8 Current Runtime State Summary
| Engine | State | Health | Uptime | Last Heartbeat |
|--------|-------|--------|--------|----------------|
| feature_engine | RUNNING | Healthy | 2h 15m | 2026-09-21T14:35:12Z |
| risk_engine | RUNNING | Healthy | 2h 15m | 2026-09-21T14:35:12Z |
| margin_engine | RUNNING | Healthy | 2h 15m | 2026-09-21T14:35:12Z |
| order_engine | RUNNING | Healthy | 2h 15m | 2026-09-21T14:35:12Z |
| sqareoff_engine | DEGRADED | Unhealthy | 1h 42m | 2026-09-21T14:10:05Z |
| target_engine | RUNNING | Healthy | 2h 15m | 2026-09-21T14:35:12Z |
| watchlist_engine | RUNNING | Healthy | 2h 15m | 2026-09-21T14:35:12Z |
| session_engine | RUNNING | Healthy | 2h 15m | 2026-09-21T14:35:12Z |
| connection_engine | RUNNING | Healthy | 2h 15m | 2026-09-21T14:35:12Z |
| websocket_engine | RUNNING | Healthy | 2h 15m | 2026-09-21T14:35:12Z |
| scheduler_engine | RUNNING | Healthy | 2h 15m | 2026-09-21T14:35:12Z |
| broker_manager | RUNNING | Healthy | 2h 15m | 2026-09-21T14:35:12Z |
| database_engine | RUNNING | Healthy | 2h 15m | 2026-09-21T14:35:12Z |
| audit_engine | UNKNOWN | Unobserved | N/A | N/A |
| watchlist_target_engine | UNKNOWN | Not initialized | N/A | N/A |

---
*Runtime lifecycle based on continuous observation of engine states in production KAUSTUBH deployment.*
