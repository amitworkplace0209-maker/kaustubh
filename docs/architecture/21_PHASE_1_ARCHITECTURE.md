# 21_PHASE_1_ARCHITECTURE.md - Phase 1: Core Trading Architecture

## 21.1 Phase 1 Overview
Phase 1 represents the core trading functionality of the KAUSTUBH terminal. It includes the essential engines and data flows required for order placement, risk management, margin tracking, and position monitoring.

### 21.2 Phase 1 Engine Set
| Engine | Type | State | Phase 1 Requirement |
|--------|------|-------|--------------------:|
| database_engine | Native | RUNNING | ✅ Required |
| connection_engine | Native | RUNNING | ✅ Required |
| feature_engine | Native | RUNNING | ✅ Required |
| risk_engine | Native | RUNNING | ✅ Required |
| margin_engine | Native | RUNNING | ✅ Required |
| order_engine | Native | RUNNING | ✅ Required |
| session_engine | Native | RUNNING | ✅ Required |
| websocket_engine | Native | RUNNING | ✅ Required |
| broker_manager | Native | RUNNING | ✅ Required |
| scheduler_engine | Native | RUNNING | ✅ Required |
| target_engine | Native | RUNNING | ✅ Required |
| watchlist_engine | Native | RUNNING | ✅ Required |
| sqareoff_engine | Facade | DEGRADED | ⚠️ Degraded |
| audit_engine | Native | UNKNOWN | ❌ Not observed |
| watchlist_target_engine | Facade | UNKNOWN | ❌ Not initialized |

### 21.3 Phase 1 Data Flows
#### Core Trading Flow
```
User (UI) → API → order_engine → risk_engine + margin_engine → broker_adapter → exchange
       │                                                    │
       ▼                                                    ▼
  session_engine                                    order_engine (confirmation)
       │                                                    │
       ▼                                                    ▼
  websocket_engine                                  connection_manager → UI
       │
       ▼
  feature_engine (signal computation)
```

### 21.4 Phase 1 Features
- **Order Placement**: Full order lifecycle from placement to confirmation
- **Risk Management**: Pre-trade risk checks and post-trade monitoring
- **Margin Management**: Margin calculation and sufficiency validation
- **Position Tracking**: Real-time position and PnL tracking
- **Session Management**: User session and subscription management
- **Market Data**: Real-time market data feeds from broker adapters
- **Broker Connectivity**: Kotak, Shoonya, Dummy adapters
- **Target Management**: Trading targets and auto-exit conditions

### 21.5 Phase 1 Current Status
- **12/14 core engines operational** (all required engines except audit_engine and watchlist_target_engine)
- **1 engine degraded**: sqareoff_engine (position tracking)
- **2 engines unknown**: audit_engine, watchlist_target_engine
- **Trading fully enabled** in Phase 1
- **All risk and margin checks passing**
- **Market data flowing** from 3 broker adapters

### 21.6 Phase 1 Gap Assessment
| Gap | Description | Impact | Priority |
|-----|-------------|--------|----------|
| sqareoff_engine DEGRADED | Position tracking issue | End-of-day squareoff at risk | High |
| audit_engine UNKNOWN | No audit trail | Compliance gap | High |
| watchlist_target_engine UNKNOWN | Composite engine not initialized | Watchlist+target feature incomplete | Medium |

---
*Phase 1 architecture based on core trading engine implementations.*