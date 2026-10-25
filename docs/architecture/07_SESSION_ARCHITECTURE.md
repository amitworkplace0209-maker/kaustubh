**STATUS: MIGRATED 2026-09-23 � 4-WS model (WebSocket_ConnectionManager_Flow.md + 08_WEBSOCKET_ARCHITECTURE.md). Dual description WS#1+WS#2 collapsed; now WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend. See 08/09 for canonical flows.**

# 07_SESSION_ARCHITECTURE.md - Session Management Architecture

## 7.1 Session Manager Overview
The `session_engine` is a native engine (managed=false, auto-start enabled) that serves as the **single source of truth** for all user subscriptions, session state, and connection context across the KAUSTUBH trading terminal. It tracks active user sessions, their subscriptions to market data feeds, and relays session context to all consuming engines.

### 7.2 Session Manager Responsibilities
- **User Session Tracking**: Lifecycle of user sessions from login to logout
- **Subscription Management**: Track which user subscribes to which market data feeds and symbols
- **Context Propagation**: Provide session context (user_id, permissions, active positions) to all engines
- **State Synchronization**: Ensure session state is consistent across all engines and persisted to MongoDB
- **Concurrent Session Support**: Multiple browser tabs/windows per user, each with independent session state

### 7.3 Session State Machine
Each user session progresses through the following states:

```
SESSION_LIFECYCLE: unauthenticated → login_pending → authenticated → subscribed → 
                     unsubmitted → completed → expired → terminated
```

### Per-Subscription States
```
SUBSCRIPTION_LIFECYCLE: unsubscribed → subscribing → active → paused → 
                         unsubscribing → removed
```

### 7.4 Session Persistence
- **MongoDB Collection**: `sessions`
- **Persistence Interval**: Every 5 minutes or on state change (whichever comes first)
- **Session Data Schema**:
  ```json
  {
    "user_id": "<string>",
    "session_id": "<UUID>",
    "tabs": [<tab_id_1>, <tab_id_2>, ...],
    "subscriptions": {
      "symbols": ["RELIANCE", "TCS", "INFY", ...],
      "channels": ["market_data", "orders", "positions"],
      "feeds": ["kotak", "shoonya"]
    },
    "state": "active|expired|terminated",
    "last_heartbeat": "<ISO8601 UTC>",
    "created_at": "<ISO8601 UTC>",
    "updated_at": "<ISO8601 UTC>"
  }
  ```
- **TTL Index**: Sessions auto-expire after 30 minutes of inactivity (MongoDB TTL)

### 7.5 Subscription Topology
```
User (Frontend)
       ↓
  WebSocket Connection (WS#2)
       ↓
  Connection Manager ──────► Session Engine (single source of truth)
       ↓                   ↓
  Broker Adapters     All Engines (feature, risk, order, etc.)
       ↓
Market Data Feeds (WS#1)
```

### 7.6 Key Session Events
All session state changes are published as events on the central event bus:

| Event | Payload | Consumers |
|-------|---------|-----------|
| `session_joined` | `{user_id, session_id, tab_id}` | All engines |
| `session_left` | `{user_id, session_id, tab_id}` | All engines |
| `subscription_changed` | `{user_id, symbols_added, symbols_removed}` | feature_engine, risk_engine |
| `session_expired` | `{user_id, session_id, duration_minutes}` | UI, session_engine |
| `session_heartbeat` | `{user_id, session_id, timestamp}` | Observability |

### 7.7 Subscription Management Operations
#### Subscribe Operation
```
1. frontend → API: subscribe({symbols, channels})
2. session_engine.validate(user_id, symbols, channels) → PASS/FAIL
3. session_engine.subscribe(user_id, symbols, channels) → updates DB
4. session_engine.publish("subscription_changed", {user_id, added, removed})
5. connection_manager.subscribe_to_feeds(user_id, symbols, channels)
6. websocket_engine.start_feed(user_id, symbols, channels)
7. frontend receives: subscription_confirmed({symbols})
```

#### Unsubscribe Operation
```
1. frontend → API: unsubscribe({symbols, channels})
2. session_engine.unsubscribe(user_id, symbols, channels) → updates DB
3. session_engine.publish("subscription_changed", {user_id, added: [], removed})
4. connection_manager.unsubscribe_from_feeds(user_id, symbols, channels)
5. websocket_engine.stop_feed(user_id, symbols, channels)
6. frontend receives: subscription_cancelled({symbols})
```

### 7.8 Tab Management
Each user can have multiple concurrent tabs, each with independent subscription state:

| Tab State | Description |
|-----------|-------------|
| `active` | Tab is foreground, receiving real-time data |
| `background` | Tab is minimized/hidden, data feed paused |
| `expired` | Tab session exceeded timeout (30 min inactivity) |
| `closed` | Tab window/tab closed by user |

#### Tab Switching
- When user switches tabs, session_engine updates `active_tab` in session document
- Subscriptions remain active across tabs; only data feed priority changes
- Heartbeat refreshed on tab switch activity

### 7.9 Session Timeout Policy
- **User Inactivity**: 30 minutes no mouse/keyboard activity → session marked expired
- **Foreground Tab**: 60 minutes continuous activity → heartbeat refreshed, session extended
- **Background Tab**: 15 minutes no activity → session marked expired, feeds paused
- **System Maintenance**: 15 minutes warning → all sessions gracefully disconnected, state persisted

### 7.10 Session Recovery
On reconnection (e.g., network dropout, browser restart):
1. frontend reconnects to API via WebSocket (WS#2)
2. session_engine identifies user by authentication token
3. session_engine retrieves session state from MongoDB (last persisted state)
4. All previous subscriptions are restored: `session_engine.restore_subscriptions(user_id)`
5. WebSocket feeds are resubscribed: `websocket_engine.resume_feeds(user_id, restored_subscriptions)`
6. UI receives: `session_recovered({user_id, restored_symbols})`

### 7.11 Current Session Runtime State
| Metric | Value |
|--------|-------|
| Active Users | 12 |
| Total Sessions | 15 (some users have 2 tabs) |
| Active Subscriptions | 87 (across all users) |
| Subscribed Symbols | 24 unique symbols |
| Expired Sessions (last hour) | 3 |
| Failed Subscriptions | 0 |
| Heartbeat Loss Events | 0 |

### 7.12 Session Engine Dependencies
- **Depends On**: connection_engine (for broker WebSocket connections), database_engine (for session persistence)
- **Used By**: All other engines (feature_engine, risk_engine, order_engine, watchlist_engine) for user context
- **State Stamp**: `session_engine-v2.3.1-RUNNING-2026-09-21T14:35:12Z`

### 7.13 Session-Engine UI Mapping
| UI Component | Session State Shown | Action Triggered |
|--------------|--------------------|-----------------|
| User profile dropdown | user_id, session expiration | Logout, Switch User |
| Watchlist page | subscribed symbols per tab | Add/Remove symbols from subscription |
| Market data panels | live feed status per symbol | Subscribe/Unsubscribe toggles |
| Order entry page | user context, margin available | Validate order against session context |
| Session summary page | all active tabs, subscriptions | Emergency session termination |

---
*Session architecture based on session_engine implementation in python-service/core/engines/session_engine.py and runtime state observation.*
