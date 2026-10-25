**STATUS: MIGRATED 2026-09-23 � 4-WS model (WebSocket_ConnectionManager_Flow.md + 08_WEBSOCKET_ARCHITECTURE.md). Dual description WS#1+WS#2 collapsed; now WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend. See 08/09 for canonical flows.**

# 30_ENGINE_UI_MAPPING.md - Engine-to-UI Mapping

## 30.1 Engine-to-UI Mapping Overview
This document maps each backend engine to the corresponding UI components in the KAUSTUBH trading terminal.

### 30.2 Engine-to-UI Correspondence

#### Core Trading Engines
| Engine | UI Component | Page | Description |
|--------|-------------|------|-------------|
| order_engine | Order Entry | `/order` | Place, cancel, view orders |
| risk_engine | Risk Monitor | `/risk` | Risk limit display and alerts |
| margin_engine | Margin Monitor | `/margin` | Margin usage and status |
| position_engine | Positions | `/positions` | Open positions and PnL |
| sqareoff_engine | Squareoff | `/squareoff` | Position squareoff controls |
| target_engine | Targets | `/targets` | Trading targets management |
| watchlist_engine | Watchlist | `/watchlist` | Symbol watchlist |
| feature_engine | Market Data / Charts | `/market`, `/chart` | Technical indicators |

#### Data and Session Engines
| Engine | UI Component | Page | Description |
|--------|-------------|------|-------------|
| session_engine | Session Manager | `/sessions` | Active sessions overview |
| websocket_engine | Connection Status | Dashboard | Feed status indicator |
| connection_engine | Broker Status | `/brokers` | Broker adapter status |
| broker_manager | Broker Status | `/brokers` | Broker adapter management |
| database_engine | System Health | Dashboard | DB connection status |
| scheduler_engine | Scheduler | Dashboard | Scheduled tasks |
| audit_engine | Audit Log | `/audit` | Compliance audit trail |
| notification_service | Notifications | `/notifications` | User notifications center |

#### Full System View
| Engine | Dashboard Widget | Description |
|--------|-----------------|-------------|
| All engines | System Health Panel | Overall engine states |
| All engines | Activity Log | Recent events |
| order_engine | Order Summary | Total orders today |
| position_engine | Portfolio Summary | Total PnL |
| risk_engine | Risk Gauge | Risk utilization |
| margin_engine | Margin Gauge | Margin utilization |
| websocket_engine | Connection Quality | WS status indicator |

### 30.3 Data Flow from Engine to UI
```
Engine publishes event
       │
       ▼
Event Bus (central)
       │
       ▼
connection_manager (WS#2)
       │
       ▼
Frontend (_pages/)
       │
       ▼
React Component updates state
       │
       ▼
UI re-renders with new data
```

### 30.4 Current Engine-to-UI Mapping Status
| Engine | UI Active | Page | Status |
|--------|-----------|------|--------|
| order_engine | ✅ | `/order` | ✅ |
| risk_engine | ✅ | `/risk` | ✅ |
| margin_engine | ✅ | `/margin` | ✅ |
| position_engine | ✅ | `/positions` | ✅ |
| sqareoff_engine | ⚠️ | `/squareoff` | ⚠️ DEGRADED |
| target_engine | ✅ | `/targets` | ✅ |
| watchlist_engine | ✅ | `/watchlist` | ✅ |
| feature_engine | ✅ | `/market`, `/chart` | ✅ |
| session_engine | ✅ | `/sessions` | ✅ |
| websocket_engine | ✅ | Dashboard | ✅ |
| connection_engine | ✅ | `/brokers` | ✅ |
| broker_manager | ✅ | `/brokers` | ✅ |
| database_engine | ✅ | Dashboard | ✅ |
| scheduler_engine | ✅ | Dashboard | ✅ |
| audit_engine | ❌ | `/audit` | ❓ Not available |
| watchlist_target_engine | ❌ | N/A | ❓ Not initialized |

### 30.5 Notes
- **All active engines** have corresponding UI components
- **DEGRADED sqareoff_engine** shows warning in `/squareoff`
- **audit_engine UNKNOWN** means `/audit` page has no data
- **watchlist_target_engine** has no UI yet (not initialized)
- **Dashboard** provides system-wide overview of all engines
- **All UI updates** happen via WS#2 (connection_manager)

---
*Engine-to-UI mapping based on 30+ page components in C:\project\app\_pages/ and observed engine states.*
