**STATUS: MIGRATED 2026-09-23 � 4-WS model (WebSocket_ConnectionManager_Flow.md + 08_WEBSOCKET_ARCHITECTURE.md). Dual description WS#1+WS#2 collapsed; now WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend. See 08/09 for canonical flows.**

# 29_EVENT_ARCHITECTURE.md - Event Architecture

## 29.1 Event Architecture Overview
The KAUSTUBH trading terminal uses a central event bus for inter-engine communication. All engines publish and subscribe to events through this event-driven architecture.

### 29.2 Event Bus Architecture
```
┌─────────────────────────────────────────────────┐
│              Central Event Bus                     │
│                                                    │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐          │
│  │feature_ │  │risk_eng │  │order_en │          │
│  │engine   │──│engine   │──│gine     │──►Event Bus│
│  └─────────┘  └─────────┘  └─────────┘          │
│                                                    │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐          │
│  │session_ │  │websocket│  │connection│          │
│  │engine   │──│engine   │──│_engine  │──►Event Bus│
│  └─────────┘  └─────────┘  └─────────┘          │
│                                                    │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐          │
│  │scheduler│  │database │  │audit_en │          │
│  │_engine  │──│engine   │──│gine     │──►Event Bus│
│  └─────────┘  └─────────┘  └─────────┘          │
└─────────────────────────────────────────────────┘
```

### 29.3 Event Types

#### Engine Lifecycle Events
| Event | Payload | Published By | Consumed By |
|-------|---------|--------------|-------------|
| `engine_initialized` | `{engine_name, version, state_stamp}` | All engines | All engines |
| `engine_started` | `{engine_name, timestamp}` | All engines | All engines |
| `engine_stopped` | `{engine_name, reason}` | All engines | All engines |
| `engine_failed` | `{engine_name, error}` | All engines | All engines |
| `state_stamp_updated` | `{engine_name, new_stamp}` | All engines | All engines |

#### Trading Events
| Event | Payload | Published By | Consumed By |
|-------|---------|--------------|-------------|
| `order_placed` | `{order_id, user_id, symbol, side, qty}` | order_engine | risk_engine, margin_engine, audit_engine |
| `order_filled` | `{order_id, filled_qty, filled_price}` | order_engine | position_engine, margin_engine, audit_engine |
| `order_cancelled` | `{order_id, reason}` | order_engine | position_engine, audit_engine |
| `order_rejected` | `{order_id, reason}` | order_engine | audit_engine, UI |
| `risk_violation` | `{order_id, violation_type}` | risk_engine | order_engine, audit_engine, UI |
| `margin_insufficient` | `{order_id, required, available}` | margin_engine | order_engine, UI |
| `position_opened` | `{position_id, symbol, side, qty}` | position_engine | session_engine, audit_engine |
| `position_closed` | `{position_id, realized_pnl}` | position_engine | session_engine, audit_engine |

#### Market Data Events
| Event | Payload | Published By | Consumed By |
|-------|---------|--------------|-------------|
| `market_data_updated` | `{symbol, data_type, price, timestamp}` | websocket_engine | feature_engine, risk_engine, order_engine |
| `feed_started` | `{feed_id, symbols, source}` | websocket_engine | connection_engine |
| `feed_stopped` | `{feed_id, reason}` | websocket_engine | connection_engine |
| `feed_error` | `{feed_id, error}` | websocket_engine | connection_engine, audit_engine |

#### Session Events
| Event | Payload | Published By | Consumed By |
|-------|---------|--------------|-------------|
| `session_joined` | `{user_id, session_id, tab_id}` | session_engine | All engines |
| `session_left` | `{user_id, session_id, tab_id}` | session_engine | All engines |
| `subscription_changed` | `{user_id, added, removed}` | session_engine | feature_engine, watchlist_engine |
| `session_expired` | `{user_id, session_id, duration}` | session_engine | All engines |
| `session_heartbeat` | `{user_id, session_id, timestamp}` | session_engine | Observability |

#### Target and Squareoff Events
| Event | Payload | Published By | Consumed By |
|-------|---------|--------------|-------------|
| `target_hit` | `{target_id, symbol, target_type}` | target_engine | sqareoff_engine, audit_engine |
| `squareoff_initiated` | `{reason, positions_count}` | sqareoff_engine | position_engine, order_engine |
| `squareoff_completed` | `{positions_squared, pnl}` | sqareoff_engine | audit_engine, position_engine |
| `squareoff_degraded` | `{issue, recovery_attempt}` | sqareoff_engine | audit_engine, UI |

#### Configuration and System Events
| Event | Payload | Published By | Consumed By |
|-------|---------|--------------|-------------|
| `config_updated` | `{section, key, new_value}` | API | All engines |
| `broker_connected` | `{broker_name, status}` | broker_manager | All engines |
| `broker_disconnected` | `{broker_name, reason}` | broker_manager | All engines |
| `audit_event_logged` | `{event_id, event_type}` | audit_engine | Compliance |
| `notification_sent` | `{notification_id, user_id}` | notification_service | UI |

### 29.4 Event Bus Configuration
```yaml
event_bus:
  transport: in_memory  # Redis for distributed deployments
  max_queue_depth: 10000
  retry_policy:
    max_attempts: 3
    base_delay: 100  # ms
    backoff_multiplier: 2
  serialization:
    format: json
    compress: true
  subscriptions:
    persistent: true
    ack_timeout: 5000  # ms
```

### 29.5 Current Event Bus Status
| Metric | Value | Status |
|--------|-------|--------|
| Events published/sec | ~150 | ✅ |
| Event queue depth | 45 | ✅ (< 1000) |
| Failed events | 0 | ✅ |
| Retry attempts | 0 | ✅ |
| Event delivery rate | 100% | ✅ |
| Latency | < 10ms | ✅ |
| audit_engine events | 0 | ❓ (audit_engine UNKNOWN) |

### 29.6 Notes
- **Central event bus** for all inter-engine communication
- **Engine lifecycle events** track all engine state changes
- **Trading events** cover order, risk, margin, position
- **Market data events** flow from websocket_engine to all engines
- **Session events** drive subscription management
- **Target/squareoff events** coordinate automated exits
- **Current event bus**: 150 events/sec, 100% delivery
- **audit_engine UNKNOWN** means no audit events published yet

---
*Event architecture based on event bus implementation in python-service/ and observed event flow.*
