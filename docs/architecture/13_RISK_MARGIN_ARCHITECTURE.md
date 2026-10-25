**STATUS: MIGRATED 2026-09-23 � 4-WS model (WebSocket_ConnectionManager_Flow.md + 08_WEBSOCKET_ARCHITECTURE.md). Dual description WS#1+WS#2 collapsed; now WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend. See 08/09 for canonical flows.**

# 13_RISK_MARGIN_ARCHITECTURE.md - Risk and Margin Architecture

## 13.1 Risk and Margin Overview
The risk and margin architecture defines the pre-trade risk checks, margin calculations, and ongoing monitoring that ensures all orders executed on the KAUSTUBH trading terminal comply with defined risk limits and margin requirements. This architecture is critical for capital protection and regulatory compliance.

### 13.2 Risk Engine (risk_engine) Responsibilities
The `risk_engine` is a native engine (managed=false, auto-start enabled) that performs real-time pre-trade and post-trade risk checks.

#### Pre-Trade Risk Checks (at order placement)
| Check Type | Description | Validation Logic | Failure Action |
|------------|-------------|------------------|----------------|
| **Position Limit** | Maximum open positions per symbol | `abs(current_position) + abs(order_qty) <= position_limit[symbol]` | Reject order, emit `risk_violation` |
| **Exposure Limit** | Total portfolio exposure | `sum(abs(positions[symbol]) * market_price[symbol]) <= exposure_limit` | Reject order, reduce position size |
| **Order Quantity** | Min/max order size | `min_qty <= order_qty <= max_qty` | Reject order, invalid size error |
| **Price Limit** | Price bands and circuits | `price within [lower_bound, upper_bound]` | Reject order, price out of circuit |
| **Concentration Limit** | Single symbol exposure | `% of portfolio in single symbol <= limit` | Reject order, diversify requirement |
| **Circuit Breaker** | Global market halt | `global halt_flag == false` | Block all new orders, alert users |

#### Post-Trade Risk Monitoring
- Track filled orders against limits
- Monitor running PnL vs. daily loss limits
- Update risk metrics after every execution
- Generate risk events for audit trail

#### Risk Engine Methods
```python
class RiskEngine(EngineBase):
    def check_order_risk(self, order: Order) -> RiskResult:
        """Check if order passes all risk limits"""
        
    def update_risk(self, execution_report: ExecutionReport) -> None:
        """Update risk state after order execution"""
        
    def get_active_limits(self) -> Dict[str, LimitState]:
        """Return current active risk limits"""
        
    def check_daily_limits(self, user_id: str) -> LimitViolationResult:
        """Check daily PnL and exposure limits"""
```

### 13.3 Margin Engine (margin_engine) Responsibilities
The `margin_engine` is a native engine (managed=false, auto-start enabled) that calculates margin requirements and monitors margin sufficiency.

#### Margin Calculation Types
| Margin Type | Description | Calculation Formula | Consumers |
|-------------|-------------|---------------------|-----------|
| **SPAN Margin** | Exchange-standard margin | SPAN algorithm with price scenarios | order_engine, broker adapters |
| **VAR Margin** | Value-at-Risk based | Statistical confidence interval (99%) | risk_engine, feature_engine |
| **Premium Margin** | Option premium upfront | `option_price * quantity * multiplier` | order_engine |
| **Day Trading Margin** | Reduced margin for intraday | `SPAN * 0.5 (intraday discount)` | order_engine, margin_engine |
| ** overnight Margin** | Margin for overnight positions | `SPAN full rate` | margin_engine, database_engine |

#### Margin Calculation Pipeline
```
Order Request
       │
       ▼
margin_engine.calculate_margin(order)
       │
       ├─► returns: required_margin, available_margin, margin_shortfall
       │
       └─► persists: margin_status to MongoDB
             │
             ▼
order_engine validates: sufficient_margin
       │
       ▼
decision: ACCEPT or REJECT order
```

#### Margin Status Schema (MongoDB)
```json
{
  "user_id": "USER123",
  "symbol": "RELIANCE",
  "required_margin": 24531.50,
  "available_margin": 50000.00,
  "used_margin": 24531.50,
  "free_margin": 25468.50,
  "margin_status": "SUFFICIENT" | "INSUFFICIENT" | "WARNING",
  "last_updated": "2026-09-21T14:35:10.123Z",
  "maintenance_margin": 29437.80
}
```

### 13.4 Risk-Margin Interdependence
The risk_engine and margin_engine work in tandem during order validation:

#### Order Validation Sequence
```
1. order_engine receives order request
       │
       ▼
2. risk_engine.check_order_risk(order) → PASS/FAIL
       │
       ▼ (if FAIL) → order REJECTED, risk_violation event
       │
3. margin_engine.calculate_margin(order) → SUFFICIENT/INSUFFICIENT/WARNING
       │
       ▼ (if INSUFFICIENT) → order REJECTED, margin_insufficient event
       │
4. Both checks must PASS for order to reach ACCEPTED state
       │
5. If both PASS: order → ACCEPTED → TRANSMITTED → execution
```

#### State Synchronization
- Both engines maintain `state_stamp` for coordination
- Changes persisted to MongoDB every 30 seconds or on state change
- Real-time event bus updates for dependent engines (order_engine, feature_engine)

### 13.5 Current Risk and Margin Runtime State

#### Risk Engine Status
| Metric | Value | Status |
|--------|-------|--------|
| Active position limits | 24 symbols | All configured |
| Active exposure limit | ₹50 Crores | Enforced |
| Circuit breaker status | ACTIVE (normal) | Not halted |
| Risk violations today | 5 | All user-resolvable |
| Real-time check latency | 15ms | < 50ms target |

#### Margin Engine Status
| Metric | Value | Status |
|--------|-------|--------|
| Active margin calculations | 24 symbols | All symbols covered |
| Margin utilization | 38.2% | Well within limits |
| Margin warnings today | 3 | All addressed |
| Margin calculation latency | 25ms | < 50ms target |
| Free margin available | ₹1.2 Crores | Available for new orders |

### 13.6 Risk Limit Configuration
```yaml
risk_limits:
  position_limits:
    RELIANCE: 5000  # max qty
    TCS: 3000
    INFY: 4000
    HDFC: 3500
    SBIN: 4500
    
  exposure_limit:
    total_portfolio: 500000000  # ₹50 Crores
    per_symbol: {max_pct: 20}  # max 20% per symbol
    
  order_limits:
    min_qty: 1
    max_qty: 10000
    min_price: 1.0
    max_price: 99999.0
    
  circuit_breaker:
    halt_threshold: 5  # % orders rejected triggers halt
    max_daily_loss: 10000000  # ₹10 Crores
    daily_loss_remaining: 95000000  # updated daily
```

### 13.7 Margin Configuration
```yaml
margin:
  span:
    enabled: true
    refresh_interval: 60  # seconds
    price_scenarios: 8
    
  var:
    enabled: true
    confidence_level: 99  # percent
    lookback_days: 30
    
  rates:
    intraday_discount: 0.5  # 50% of SPAN for intraday
    overnight_rate: 1.0  # full SPAN for overnight
    
  requirements:
    minimum_maintenance: 0.1  # 10% minimum margin
    emergency_margin: 0.5  # 50% additional in crisis
```

### 13.8 Risk and Margin Events
All risk and margin changes are published as events on the central event bus:

| Event | Payload | Consumers |
|-------|---------|-----------|
| `risk_violation` | `{order_id, violation_type, limit_value, current_value}` | order_engine, audit_engine |
| `margin_insufficient` | `{order_id, required, available, shortfall}` | order_engine, user UI |
| `margin_warning` | `{user_id, margin_pct_used, symbol}` | feature_engine, UI |
| `daily_limit_breach` | `{user_id, loss_amount, limit_amount}` | audit_engine, UI |
| `circuit_breaker_triggered` | `{halt_type, trigger_time, expected_resume}` | all engines, UI |

### 13.9 Current Risk-Margin Flow (Integrated with Trading Flow)
```
Order Placement (trading flow 11)
       │
       ▼
Pre-trade validation sequence
       │
       ├──► risk_engine.check_order_risk() ──┐
       │                                      │
       ▼                                      │
Margin Engine: calculate_margin() ────────┤ Validation
       │                                      │
       ▼                                      │
Both PASS? ──→ YES → order ACCEPTED ──────┘
       │
       NO  → order REJECTED with reason
       │
       ▼
Order transmitted to broker
       │
       ▼
Post-trade: risk_engine.update_risk(execution_report)
       │
       ▼
Margin engine: update_margin(execution_report)
       │
       ▼
Persist to MongoDB
       │
       ▼
Event bus: risk_updates, margin_updates
```

### 13.10 Risk-Margin Error Handling
| Error Scenario | Detection | Recovery |
|----------------|-----------|----------|
| Risk check timeout | > 50ms latency | Cancel order, emit risk_timeout |
| Margin calculation failure | exception in computation | Use last known margin, alert operator |
| Limit breach detected | real-time monitoring | Auto-reduce position, notify user |
| Circuit breaker triggered | halt_threshold exceeded | Block all orders, alert all users |
| Margin shortfall | available < required | Notify user, offer deposit or reduce size |

### 13.11 Notes
- **risk_engine and margin_engine are both native engines** (managed=false, auto-start)
- **Both must PASS** for order to proceed (AND logic, not OR)
- **Real-time monitoring** continues after order execution
- **State stamps** ensure coordinated start/stop between the two engines
- **Current health**: Both engines RUNNING, all limits enforced, 2 risk violations today (all resolved)
- **Configuration** is YAML-based and reloadable without restart (hot reload supported)

---
*Risk and margin architecture based on risk_engine and margin_engine implementations in python-service/core/engines/risk_engine.py and python-service/core/engines/margin_engine.py.*
