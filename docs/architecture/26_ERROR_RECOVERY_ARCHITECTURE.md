# 26_ERROR_RECOVERY_ARCHITECTURE.md - Error Recovery Architecture

## 26.1 Error Recovery Overview
The error recovery architecture defines how the KAUSTUBH trading terminal handles failures, recovers from errors, and maintains system stability.

### 26.2 Error Categories
| Category | Description | Examples | Recovery Strategy |
|----------|-------------|----------|--------------------|
| **Transient** | Temporary, self-resolving | Network blip, brief timeout | Auto-retry with backoff |
| **Persistent** | Requires intervention | Broker disconnect, DB failure | Manual restart, operator alert |
| **Degraded** | Partial functionality | sqareoff_engine DEGRADED | Fallback mode, reconciliation |
| **Critical** | System-wide impact | Circuit breaker, total outage | Failover, emergency shutdown |

### 26.3 Recovery Strategies

#### Auto-Retry (Transient Errors)
```
Error detected
       │
       ▼
Is transient?
       │
       ├─ YES → Retry with exponential backoff
       │        │
       │        ├─ Attempt 1: delay 5s
       │        ├─ Attempt 2: delay 10s
       │        ├─ Attempt 3: delay 30s
       │        └─ Max 3 attempts → If still failing, escalate
       │
       └─ NO → Escalate to manual recovery
```

#### Circuit Breaker Pattern
```
Circuit breaker state machine:
  CLOSED → OPEN → HALF_OPEN → CLOSED
  (normal)  (tripped)  (testing)  (recovered)
  
  - CLOSED: Normal operation
  - OPEN: Stop all requests for 30s
  - HALF_OPEN: Allow 1 test request
  - If test succeeds → CLOSED
  - If test fails → OPEN
```

#### Fallback Mode (Degraded State)
- sqareoff_engine DEGRADED → Use manual squareoff
- Broker adapter fails → Failover to secondary broker
- Market data feed lost → Use cached data with staleness warning

### 26.4 Error Recovery by Engine

| Engine | Error Types | Recovery | Fallback |
|--------|-------------|----------|----------|
| order_engine | Broker rejection, timeout | Retry 3x | Queue order |
| risk_engine | Calculation timeout | Use last known limits | Bypass risk check (alert) |
| margin_engine | DB connection lost | Retry with backoff | Use cached margin |
| sqareoff_engine | Position tracking | Reconciliation + restart | Manual squareoff |
| websocket_engine | WS disconnect | Auto-reconnect | Cached data |
| broker_manager | Adapter failure | Failover to secondary | Paper trading mode |
| database_engine | Connection lost | Auto-reconnect | Buffer operations |
| session_engine | Session expiry | Auto-reconnect | Re-authenticate |

### 26.5 Current Error Recovery Status
| Component | State | Recovery Status |
|-----------|-------|-----------------|
| sqareoff_engine | DEGRADED | ⚠️ Needs reconciliation + restart |
| broker_manager | Running with failover | ✅ All 3 adapters active |
| database_engine | Running | ✅ No connection issues |
| websocket_engine | Running | ✅ All feeds active |
| auto-retry policy | Active | ✅ 3 attempts with backoff |
| circuit breaker | Normal | ✅ Closed |

### 26.6 Error Recovery Events
| Event | Trigger | Action |
|-------|---------|--------|
| `error_detected` | Any engine error | Log, classify error |
| `retry_initiated` | Transient error | Exponential backoff retry |
| `circuit_breaker_open` | Error threshold | Stop requests, alert |
| `circuit_breaker_closed` | Error resolved | Resume normal operation |
| `fallback_activated` | Degraded state | Use fallback mode |
| `manual_recovery_required` | Persistent error | Alert operator |
| `reconciliation_started` | Position mismatch | Force sync from MongoDB |

### 26.7 Recovery Configuration
```yaml
recovery:
  retry_policy:
    max_attempts: 3
    base_delay: 5  # seconds
    max_delay: 30  # seconds
    backoff_multiplier: 2
    
  circuit_breaker:
    error_threshold: 5  # consecutive errors
    timeout: 30  # seconds in OPEN state
    half_open_requests: 1
    
  fallback:
    enable_degraded_mode: true
    sqareoff_fallback: manual_squareoff
    market_data_fallback: cached_data
    broker_fallback: paper_trading
    
  reconciliation:
    interval: 60  # seconds
    trigger_on: position_mismatch
    max_attempts: 5
```

### 26.8 Notes
- **Auto-retry** handles transient errors (3 attempts with exponential backoff)
- **Circuit breaker** prevents cascading failures
- **sqareoff_engine DEGRADED** requires manual reconciliation + restart
- **All recovery events** are published to event bus
- **Fallback modes** ensure partial functionality during failures
- **Recovery configuration** is YAML-based and hot-reloadable

---
*Error recovery architecture based on error handling implementations in python-service/ and observed error states.*