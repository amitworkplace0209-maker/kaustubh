**STATUS: MIGRATED 2026-09-23 � 4-WS model (WebSocket_ConnectionManager_Flow.md + 08_WEBSOCKET_ARCHITECTURE.md). Dual description WS#1+WS#2 collapsed; now WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend. See 08/09 for canonical flows.**

# 15_TARGET_SQUAREOFF_ARCHITECTURE.md - Target and Squareoff Architecture

## 15.1 Target and Squareoff Overview
The target and squareoff architecture defines how trading targets are set, monitored, and executed automatically when target conditions are met. This is the automated safety and profit-taking mechanism of the KAUSTUBH trading terminal.

### 15.2 Target Engine (target_engine) Responsibilities
The `target_engine` is a native engine (managed=false, auto-start enabled) that manages trading strategies and target conditions.

#### Target Types
| Target Type | Description | Trigger Condition | Action |
|-------------|-------------|-------------------|--------|
| **Price Target** | Target price level | market_price >= target_price | Auto-sell, lock profit |
| **Percentage Target** | Target % gain | (current - entry) / entry >= target_pct | Auto-sell |
| **Trailing Stop** | Dynamic stop loss | price drops below (peak - trail_amount) | Auto-sell, protect gains |
| **Time Target** | Time-based exit | current_time >= target_time | Auto-sell at close |
| **Signal Target** | Signal-based exit | feature_engine signals SELL | Auto-sell on signal |

#### Target State Machine
```
TARGET_LIFECYCLE: ACTIVE → HIT → EXPIRED → CANCELLED
```

| State | Description | Transition |
|-------|-------------|------------|
| ACTIVE | Target is being monitored | Created, waiting for trigger |
| HIT | Target condition met | Triggered auto-sell order |
| EXPIRED | Target time elapsed | Time target reached without hit |
| CANCELLED | Target manually cancelled | User cancels target |

#### Target Engine Methods
```python
class TargetEngine(EngineBase):
    def set_target(self, symbol, target_type, value, params) -> TargetID:
        """Create a new trading target"""
        
    def check_targets(self) -> List[TargetHit]:
        """Check all active targets against current market data"""
        
    def cancel_target(self, target_id) -> bool:
        """Cancel an active target"""
        
    def get_active_targets(self) -> List[TargetState]:
        """Return all active targets"""
```

### 15.3 Squareoff Engine (sqareoff_engine) Responsibilities
The `sqareoff_engine` is a **facade engine** (managed=true) that handles end-of-trading position squareoff. It is currently in **DEGRADED** state due to a position tracking issue.

#### Squareoff Operations
| Operation | Description | Trigger | Action |
|-----------|-------------|---------|--------|
| **End-of-Day Squareoff** | Close all open positions at market close | 3:25 PM IST daily | Auto-squareoff all positions |
| **Risk-Based Squareoff** | Close positions when risk limits breached | Risk engine alerts | Auto-squareoff high-risk positions |
| **Target-Based Squareoff** | Close positions when target conditions met | target_engine signals HIT | Auto-squareoff targeted positions |
| **Manual Squareoff** | User-initiated position closure | User request | Close specified positions |

#### Squareoff Engine State Machine
```
SQUAREOFF_LIFECYCLE: MONITORING → TRIGGERED → EXECUTING → COMPLETED → DEGRADED
```

| State | Description | Transition |
|-------|-------------|------------|
| MONITORING | Watching positions and conditions | Normal operation |
| TRIGGERED | Squareoff condition met | Target hit or time reached |
| EXECUTING | Squareoff order being placed | order_engine accepting orders |
| COMPLETED | All positions squared off | All orders filled/cancelled |
| DEGRADED | Malfunction detected | Position tracking issue (current state) |

#### Current DEGRADED State (sqareoff_engine)
The sqareoff_engine is currently in **DEGRADED** state due to:
- Position tracking inconsistency (position counts not matching actual open positions)
- Target condition evaluation delays
- Possible root cause: race condition between position_engine updates and sqareoff_engine monitoring loop

**Recovery Procedure**:
1. Run reconciliation: `python -m kaushub.engine reconcile positions`
2. Force position sync from MongoDB: `python -m kaushub.engine sync positions`
3. Restart sqareoff_engine: `python -m kaushub.engine restart sqareoff_engine`
4. Verify state: should return to MONITORING

### 15.4 Target and Squareoff Interaction Flow

#### Target-to-Squareoff Flow
```
target_engine.check_targets()
       │
       ▼
Target condition met? (price >= target_price)
       │
       ├─── YES → target_engine.publish("target_hit", {target_id, symbol})
       │              │
       │              ▼
       │         sqareoff_engine.process_target_hit(target_id, symbol)
       │              │
       │              ├─► order_engine.create_exit_order(symbol)
       │              │
       │              ├─► position_engine: update position status
       │              │
       │              └─► Publish: position_closed {source: target}
       │
       └─── NO → continue monitoring
```

#### Squareoff at Market Close
```
scheduler_engine daily cron: 3:25 PM IST
       │
       ▼
sqareoff_engine.initiate_end_of_day_squareoff()
       │
       ├─► Get all open positions from position_engine
       │
       ├─► For each position:
       │       ├─► order_engine.create_exit_order(symbol, side=SELL)
       │       ├─► Wait for execution confirmation
       │       └─► Update position status = CLOSED
       │
       ├─► Confirm all positions squared off
       │
       └─► Publish: end_of_day_squareoff_complete
```

### 15.5 Target Configuration
```yaml
targets:
  default_price_target:
    type: PRICE
    trigger: ">="
    action: SELL
    persist_to_mongo: true
    
  default_percentage_target:
    type: PERCENTAGE
    trigger: ">="
    action: SELL
    persist_to_mongo: true
    
  default_trailing_stop:
    type: TRAILING_STOP
    trigger: "<"
    action: SELL
    persist_to_mongo: true
    trail_amount_percent: 2.0
    
  default_time_target:
    type: TIME
    trigger: ">="
    action: SELL
    persist_to_mongo: true
    expiry_time: "15:25:00"  # IST
    
  default_signal_target:
    type: SIGNAL
    trigger: "SELL_SIGNAL"
    action: SELL
    persist_to_mongo: true
```

### 15.6 Squareoff Configuration
```yaml
squareoff:
  end_of_day:
    trigger_time: "15:25:00"  # 5 minutes before market close
    timeout: 300  # seconds to complete all squareoffs
    retry_policy:
      max_attempts: 3
      base_delay: 5  # seconds
    partial_squareoff: true  # allow partial fills
    
  risk_based:
    enable_auto_squareoff: true
    max_loss_per_position: 50000  # ₹50,000
    max_loss_per_session: 500000  # ₹5 Lakhs
    trigger_on_breach: true
    
  recovery:
    reconcile_interval: 60  # seconds
    sync_from_mongo: true
    max_retries: 5
    degraded_mode_timeout: 300  # seconds in degraded mode before auto-recovery
```

### 15.7 Current Target and Squareoff Runtime State
| Metric | Value | Status |
|--------|-------|--------|
| Active targets | 8 | All being monitored |
| Targets hit today | 3 | Auto-sell executed |
| Targets expired | 0 | None reached time limit |
| Targets cancelled | 1 | User-initiated |
| Open positions needing squareoff | 4 | Being monitored |
| Squareoff engine state | DEGRADED | Position tracking issue |
| End-of-day squareoff | Scheduled | 3:25 PM IST daily |
| Risk-based squareoff | Enabled | Active monitoring |
| Positions squared off today | 12 | All successful |

### 15.8 Target and Squareoff Events
All target and squareoff events are published to the central event bus:

| Event | Payload | Consumers |
|-------|---------|-----------|
| `target_hit` | `{target_id, symbol, target_type, target_value}` | sqareoff_engine, audit_engine, UI |
| `target_created` | `{target_id, symbol, target_type, value}` | UI, audit_engine |
| `target_cancelled` | `{target_id, reason}` | UI, audit_engine |
| `squareoff_initiated` | `{reason, positions_count}` | position_engine, order_engine |
| `squareoff_completed` | `{positions_squared, pnl_realized}` | position_engine, audit_engine, UI |
| `squareoff_degraded` | `{issue, recovery_attempt}` | audit_engine, UI |
| `position_squareoff` | `{position_id, exit_price, pnl}` | position_engine, UI |

### 15.9 Target and Squareoff Error Handling
| Error Scenario | Detection | Recovery |
|----------------|-----------|----------|
| Target condition never met | Monitor loop timeout | Emit target_timeout event, cancel |
| Squareoff order fails | Broker rejection | Retry with backoff, alert user |
| Partial squareoff | Some positions not closed | Queue remaining, retry |
| Position tracking mismatch | Reconciliation finds discrepancy | Force sync from MongoDB, restart engine |
| Target hit but order fails | order_engine rejection | Retry order, emit order_failed event |
| DEGRADED state persists | > 5 minutes in DEGRADED | Auto-recovery attempt, operator alert |

### 15.10 Notes
- **target_engine** is a native engine (RUNNING), managing 8 active targets
- **sqareoff_engine** is a facade engine currently in **DEGRADED** state (position tracking issue)
- **Both engines work together**: target_engine detects target hits → sqareoff_engine processes squareoff
- **End-of-day squareoff** is automated at 3:25 PM IST (5 minutes before market close)
- **Current sqareoff_engine DEGRADED state** needs reconciliation + restart to recover
- **All target and squareoff events** are published to event bus and logged by audit_engine

---
*Target and squareoff architecture based on target_engine and sqareoff_engine implementations in python-service/core/engines/ and observed runtime state (sqareoff_engine DEGRADED).*
