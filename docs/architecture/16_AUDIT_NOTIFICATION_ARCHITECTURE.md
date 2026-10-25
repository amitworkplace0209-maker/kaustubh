**STATUS: MIGRATED 2026-09-23 � 4-WS model (WebSocket_ConnectionManager_Flow.md + 08_WEBSOCKET_ARCHITECTURE.md). Dual description WS#1+WS#2 collapsed; now WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend. See 08/09 for canonical flows.**

# 16_AUDIT_NOTIFICATION_ARCHITECTURE.md - Audit and Notification Architecture

## 16.1 Audit and Notification Overview
The audit and notification architecture defines how all system events are logged for compliance, auditing, and user notification purposes. This is critical for regulatory compliance, troubleshooting, and user communication.

### 16.2 Audit Engine (audit_engine)
The `audit_engine` is currently in **UNKNOWN** state - no runtime events have been observed. It is designed to be a native engine (managed=false) that logs all system events to MongoDB.

#### Audit Event Categories
| Category | Description | Event Examples | Retention |
|----------|-------------|----------------|-----------|
| **Trading Events** | Order lifecycle events | order_placed, order_filled, order_cancelled | 7 years (regulatory) |
| **Risk Events** | Risk and margin events | risk_violation, margin_insufficient | 7 years |
| **System Events** | Engine lifecycle events | engine_started, engine_stopped, engine_failed | 1 year |
| **User Events** | User actions | login, logout, subscription_change | 1 year |
| **Configuration Events** | System changes | config_updated, broker_connected, target_set | 1 year |
| **Security Events** | Authentication and access | auth_failure, permission_denied | 7 years |
| **Error Events** | Errors and exceptions | error_occurred, exception_caught, timeout | 1 year |

#### Audit Event Schema (MongoDB)
```json
{
  "event_id": "AUDIT-UUID-123",
  "event_type": "order_filled",
  "category": "trading",
  "timestamp": "2026-09-21T14:35:12.456Z",
  "user_id": "USER123",
  "session_id": "SESSION-UUID-456",
  "details": {
    "order_id": "ORDER-UUID-789",
    "symbol": "RELIANCE",
    "side": "BUY",
    "quantity": 100,
    "filled_price": 2453.15,
    "filled_quantity": 100
  },
  "metadata": {
    "source_engine": "order_engine",
    "state_stamp": "order_engine-v2.3.1-RUNNING-2026-09-21T14:35:12Z",
    "ip_address": "192.168.1.100",
    "user_agent": "Mozilla/5.0 (PWA)"
  }
}
```

#### Audit Engine Methods
```python
class AuditEngine(EngineBase):
    def log_event(self, event: AuditEvent) -> EventID:
        """Log an audit event to MongoDB"""
        
    def get_audit_log(self, filters: Dict) -> List[AuditEvent]:
        """Retrieve audit events by filter"""
        
    def get_compliance_report(self, user_id, date_range) -> ComplianceReport:
        """Generate regulatory compliance report"""
        
    def flush_events(self) -> int:
        """Force flush buffered events to MongoDB"""
```

### 16.3 Notification Architecture
Notifications are sent to users via WS#2 connections and persisted for later review.

#### Notification Types
| Notification Type | Trigger | Delivery Method | Urgency |
|-------------------|---------|-----------------|---------|
| **Order Confirmation** | Order filled/cancelled | WS#2 push + in-app | Normal |
| **Risk Alert** | Risk limit approached/breached | WS#2 push + email | High |
| **Margin Warning** | Margin usage > 80% | WS#2 push | Medium |
| **Target Hit** | Price target reached | WS#2 push + sound | High |
| **Squareoff Notice** | Auto-squareoff initiated | WS#2 push | Normal |
| **System Alert** | Engine failure/degraded state | WS#2 push + email | Critical |
| **Circuit Breaker** | Market halt | WS#2 push + email | Critical |

#### Notification Schema (MongoDB)
```json
{
  "notification_id": "NOTIF-UUID-123",
  "user_id": "USER123",
  "type": "risk_alert",
  "title": "Risk Limit Warning",
  "message": "Your RELIANCE position is approaching the 80% risk limit.",
  "urgency": "HIGH",
  "read": false,
  "timestamp": "2026-09-21T14:35:12.456Z",
  "source_engine": "risk_engine",
  "actions": [
    {"label": "View Position", "action": "navigate_to_position"},
    {"label": "Dismiss", "action": "dismiss_notification"}
  ]
}
```

#### Notification Delivery Flow
```
Event triggers notification (e.g., risk_violation)
       │
       ▼
notification_service generates notification
       │
       ├─► Persist to MongoDB (notifications collection)
       │
       ├─► Publish to WS#2: connection_manager.send(user_id, notification)
       │
       └─► Frontend receives: notification_push({type, title, message})
             │
             ├─► Display in notification center
             │
             ├─► Play sound (for HIGH/CRITICAL urgency)
             │
             └─► Update notification badge count
```

### 16.4 Current Audit and Notification Runtime State
| Metric | Value | Notes |
|--------|-------|-------|
| audit_engine state | UNKNOWN | Not yet observed at runtime |
| Notifications sent today | 47 | Order confirmations + risk alerts |
| Notifications delivered | 47/47 (100%) | All delivered via WS#2 |
| Notification backlog | 0 | All notifications sent in real-time |
| Audit events logged | 0 | audit_engine not yet operational |
| Audit log size (MongoDB) | 0 events | audit_engine pending startup |
| Compliance reports generated | 0 | Pending audit_engine startup |

### 16.5 Audit and Notification Events
| Event | Payload | Consumers |
|-------|---------|-----------|
| `audit_event_logged` | `{event_id, event_type, category, timestamp}` | audit_engine, compliance_reports |
| `notification_sent` | `{notification_id, user_id, type, urgency}` | UI, notification_service |
| `notification_read` | `{notification_id, user_id}` | UI, notification_service |
| `notification_dismissed` | `{notification_id, user_id}` | UI, notification_service |

### 16.6 Audit and Notification Error Handling
| Error Scenario | Detection | Recovery |
|----------------|-----------|----------|
| MongoDB write failure | DB connection error | Buffer events, retry with backoff |
| Notification delivery failure | WS#2 send error | Queue notification, retry |
| Audit event format error | Schema validation failure | Log error, skip event, alert operator |
| Notification backlog > 1000 | Queue depth exceeded | Increase delivery threads, alert |
| Audit engine not started | UNKNOWN state | Start audit_engine manually |

### 16.7 Configuration
```yaml
audit:
  retention_days: 2555  # 7 years
  buffer_size: 10000  # events
  flush_interval: 5  # seconds
  categories:
    - trading
    - risk
    - system
    - user
    - configuration
    - security
    - error
    
notifications:
  delivery_channels: [ws2_push, in_app, email]
  urgency_levels: [LOW, NORMAL, HIGH, CRITICAL]
  sound_enabled: true
  max_notifications_per_user: 500
  read_after_display: false  # require manual mark as read
  email_notifications:
    enabled: true
    smtp_host: "smtp.kaustubh.trading"
    smtp_port: 587
    recipients: []
```

### 16.8 Notes
- **audit_engine is currently UNKNOWN** - not yet observed at runtime; should start last among all engines
- **Notifications are delivered via WS#2** (connection_manager) for real-time delivery
- **All audit events are persisted to MongoDB** with 7-year retention for regulatory compliance
- **Notification center** is a UI feature in _pages/ showing all unread notifications
- **audit_engine not yet operational** means compliance report generation is pending
- **Upon audit_engine startup**, all historical events should be replayed from event bus

---
*Audit and notification architecture based on audit_engine implementation in python-service/core/engines/ and notification_service in python-service/.*
