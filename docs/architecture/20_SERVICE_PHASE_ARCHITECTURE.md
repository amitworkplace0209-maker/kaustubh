# 20_SERVICE_PHASE_ARCHITECTURE.md - Service Phase Architecture

## 20.1 Service Phase Overview
The KAUSTUBH trading terminal operates across multiple service phases, each defining a set of capabilities and engine states. Phase gates control which features are available at each stage of the trading day.

### 20.2 Service Phases

#### Phase 1: Pre-Market (6:00 AM - 9:00 AM IST)
| Status | Description |
|--------|-------------|
| **Active Engines** | database_engine, scheduler_engine, connection_engine |
| **Purpose** | System warmup, data loading, session preparation |
| **Features** | View market data, set targets, configure orders |
| **Trading** | Disabled - no order placement |
| **Key Operations** | Load historical data, warm up connection pools, verify broker connections |

#### Phase 2: Market Open (9:00 AM - 3:30 PM IST)
| Status | Description |
|--------|-------------|
| **Active Engines** | All 15 engines RUNNING |
| **Purpose** | Full trading operations |
| **Features** | All trading features active - order placement, squareoff, targets, risk checks |
| **Trading** | Fully enabled |
| **Key Operations** | Real-time market data, order execution, PnL tracking, risk monitoring |

#### Phase 3: Market Close (3:30 PM - 4:00 PM IST)
| Status | Description |
|--------|-------------|
| **Active Engines** | All 15 engines RUNNING |
| **Purpose** | Squareoff and end-of-day processing |
| **Features** | Squareoff operations, PnL calculation, settlement preparation |
| **Trading** | Restricted - new orders blocked, existing orders can be modified |
| **Key Operations** | Auto-squareoff at 3:25 PM, PnL calculation, settlement |

#### Phase 4: Post-Market (4:00 PM - 6:00 AM IST)
| Status | Description |
|--------|-------------|
| **Active Engines** | database_engine, scheduler_engine, audit_engine |
| **Purpose** | Data archival, reporting, system maintenance |
| **Features** | View reports, configure for next day, review PnL |
| **Trading** | Disabled |
| **Key Operations** | Data archival, report generation, session cleanup, engine cooldown |

### 20.3 Phase Transition Flow
```
Pre-Market (6:00 AM)
       │
       │ scheduler_engine triggers startup sequence
       ▼
Market Open (9:00 AM)
       │
       │ scheduler_engine monitors trading window
       ▼
Market Close (3:30 PM)
       │
       │ scheduler_engine triggers squareoff at 3:25 PM
       │ sqareoff_engine initiates end-of-day squareoff
       ▼
Post-Market (4:00 PM)
       │
       │ scheduler_engine triggers cooldown and archival
       ▼
Pre-Market (6:00 AM next day)
       │
       │ Full cycle repeats
```

### 20.4 Phase Gate Configuration
```yaml
phases:
  pre_market:
    start: "06:00:00"
    end: "09:00:00"
    engines_active: [database_engine, scheduler_engine, connection_engine]
    trading_enabled: false
    order_placement: false
    squareoff_enabled: false
    
  market_open:
    start: "09:00:00"
    end: "15:30:00"
    engines_active: [all_15]
    trading_enabled: true
    order_placement: true
    squareoff_enabled: true
    
  market_close:
    start: "15:30:00"
    end: "16:00:00"
    engines_active: [all_15]
    trading_enabled: false
    order_placement: false  # blocked
    squareoff_enabled: true
    squareoff_trigger: "15:25:00"  # 5 min before close
    
  post_market:
    start: "16:00:00"
    end: "06:00:00"
    engines_active: [database_engine, scheduler_engine, audit_engine]
    trading_enabled: false
    order_placement: false
    squareoff_enabled: false
```

### 20.5 Current Service Phase
| Metric | Value |
|--------|-------|
| Current phase | Market Open |
| Phase start time | 09:00:00 IST |
| Phase end time | 15:30:00 IST |
| Trading enabled | Yes |
| Order placement | Allowed |
| Squareoff enabled | Yes |
| Next phase transition | Market Close at 15:30:00 IST |
| Auto-squareoff trigger | 15:25:00 IST |

### 20.6 Phase Transition Events
| Event | Trigger | Consumers |
|-------|---------|-----------|
| `phase_pre_market` | 06:00:00 IST | scheduler_engine, all engines |
| `phase_market_open` | 09:00:00 IST | scheduler_engine, order_engine |
| `phase_market_close` | 15:30:00 IST | scheduler_engine, sqareoff_engine |
| `phase_post_market` | 16:00:00 IST | scheduler_engine, database_engine |
| `squareoff_trigger` | 15:25:00 IST | sqareoff_engine, order_engine |

### 20.7 Phase-Related Errors
| Error Scenario | Detection | Recovery |
|----------------|-----------|----------|
| Phase transition missed | scheduler_engine not triggering | Manual phase override via API |
| Auto-squareoff failure | sqareoff_engine DEGRADED | Manual squareoff, operator alert |
| Trading not enabled at market open | order_engine not RUNNING | Start order_engine, phase rollback |
| Phase stuck | Engine not transitioning | Manual phase reset, operator alert |

### 20.8 Notes
- **4 service phases** govern trading operations throughout the day
- **scheduler_engine** manages phase transitions via cron jobs
- **Auto-squareoff** at 3:25 PM IST (5 minutes before market close)
- **Phase gates control** which engines are active and which features are enabled
- **Current phase**: Market Open (all trading features active)
- **All phase transitions** are published as events on the central event bus

---
*Service phase architecture based on scheduler_engine implementation and observed runtime phase state.*