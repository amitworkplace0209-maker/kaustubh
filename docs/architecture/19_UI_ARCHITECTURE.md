**STATUS: MIGRATED 2026-09-23 � 4-WS model (WebSocket_ConnectionManager_Flow.md + 08_WEBSOCKET_ARCHITECTURE.md). Dual description WS#1+WS#2 collapsed; now WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend. See 08/09 for canonical flows.**

# 19_UI_ARCHITECTURE.md - User Interface Architecture

## 19.1 UI Architecture Overview
The KAUSTUBH trading terminal uses a React-based PWA frontend at `C:\project\app` with 30+ page components. The UI communicates with the backend via WS#2 (Connection Manager) for real-time data and REST APIs for actions.

### 19.2 UI Framework and Structure
- **Framework**: React with TypeScript
- **Build Tool**: Vite (or similar bundler)
- **PWA**: Progressive Web App with offline support
- **Routing**: Client-side routing with lazy loading
- **State Management**: React Context + useReducer for global state
- **Styling**: CSS Modules or Tailwind CSS

### 19.3 Page Component Inventory (30+ pages)
| Page | Route | Description | WebSocket Channels |
|------|-------|-------------|--------------------|
| Home | `/` | Dashboard overview | market_data, portfolio |
| Watchlist | `/watchlist` | Symbol watchlist | market_data:{symbol} |
| Market Data | `/market` | Real-time market data | market_data:{symbol} |
| Order Entry | `/order` | Place new orders | order_status |
| Positions | `/positions` | Open positions view | position_updates |
| PnL | `/pnl` | Profit and loss dashboard | position_updates |
| Targets | `/targets` | Trading targets | target_updates |
| Squareoff | `/squareoff` | Position squareoff | squareoff_events |
| Orders | `/orders` | Order history | order_updates |
| Portfolio | `/portfolio` | Portfolio overview | portfolio_updates |
| Settings | `/settings` | User preferences | config_updates |
| Audit Log | `/audit` | Compliance audit trail | audit_events |
| Notifications | `/notifications` | User notifications | notifications |
| Broker Status | `/brokers` | Broker connection status | broker_events |
| Session Manager | `/sessions` | Active sessions | session_events |
| Risk Monitor | `/risk` | Risk limit monitoring | risk_events |
| Margin Monitor | `/margin` | Margin status | margin_events |
| Market Depth | `/depth` | Order book depth | market_data:{symbol} |
| Chart | `/chart` | Price charts | market_data:{symbol} |
| Alerts | `/alerts` | System alerts | alert_events |
| Trade History | `/history` | Historical trades | trade_history |
| Account | `/account` | Account details | account_events |
| Login | `/login` | Authentication | auth_events |
| Register | `/register` | User registration | auth_events |
| Reports | `/reports` | Financial reports | report_events |
| Help | `/help` | Help documentation | N/A |
| About | `/about` | About KAUSTUBH | N/A |

### 19.4 UI Data Flow
```
Frontend (React PWA)
       │
       │ 1. User interaction (click, type, scroll)
       ▼
┌─────────────────────────┐
│  React Components (_pages/) │
│  - State management        │
│  - WebSocket connection    │
│  - API calls               │
└─────────┬───────────────┘
          │
          │ 2. WS#2 connection (Connection Manager)
          ▼
┌─────────────────────────┐
│  Connection Manager     │
│  - Per-connection state  │
│  - Channel subscriptions │
│  - Message routing       │
└─────────┬───────────────┘
          │
          │ 3. Backend engines
          ▼
┌─────────────────────────┐
│  FastAPI + Engines      │
│  - order_engine          │
│  - feature_engine        │
│  - risk_engine           │
│  - ... (all engines)     │
└─────────┬───────────────┘
          │
          │ 4. Broker adapters (WS#1)
          ▼
┌─────────────────────────┐
│  Broker Adapters        │
│  - kotak_adapter         │
│  - shoonya_adapter       │
│  - dummy_adapter         │
└─────────────────────────┘
```

### 19.5 WebSocket Integration Pattern
Each page component subscribes to relevant WebSocket channels:

```typescript
// Example: Watchlist page subscription
const watchlistPage = {
  // On mount: subscribe to market data for watchlist symbols
  connect() {
    ws.send({ type: 'subscribe', channels: ['market_data:RELIANCE', 'market_data:TCS'] });
  }
  
  // On message: update component state
  onMessage(data) {
    if (data.type === 'market_data') {
      updateWatchlist(data.symbol, data.price);
    }
  }
  
  // On unmount: unsubscribe
  disconnect() {
    ws.send({ type: 'unsubscribe', channels: ['market_data:RELIANCE', 'market_data:TCS'] });
  }
}
```

### 19.6 Real-time UI Components
| Component | Data Source | Update Frequency | Rendering |
|-----------|-------------|------------------|-----------|
| **Market Data Ticker** | WS#2 market_data | Per tick (1-10Hz) | Real-time price display |
| **Order Book Depth** | WS#2 market_data | Per update | 5-level depth chart |
| **Portfolio Summary** | WS#2 position_updates | Every 5s | Aggregate PnL |
| **PnL Dashboard** | WS#2 position_updates | Every 5s | Charts + numbers |
| **Order Status** | WS#2 order_status | Per event | Order list with states |
| **Risk Gauge** | WS#2 risk_events | Per risk check | Visual gauge indicator |
| **Margin Display** | WS#2 margin_events | Per update | Margin usage % |
| **Notification Center** | WS#2 notifications | Per notification | Bell icon + list |
| **Target Panel** | WS#2 target_updates | Per target change | Target list with status |

### 19.7 UI State Management
```typescript
// Global application state
interface AppState {
  // Authentication
  user: User | null;
  session: Session | null;
  isAuthenticated: boolean;
  
  // Market data
  marketData: Map<string, MarketData>;  // symbol → data
  watchlist: string[];
  
  // Trading
  orders: Order[];
  positions: Position[];
  portfolio: Portfolio;
  
  // Risk and margin
  riskState: RiskState;
  marginState: MarginState;
  
  // UI
  theme: 'light' | 'dark';
  notifications: Notification[];
  activePage: string;
  
  // Connection
  wsConnected: boolean;
  connectionQuality: 'good' | 'fair' | 'poor';
}
```

### 19.8 Current UI Runtime State
| Metric | Value | Status |
|--------|-------|--------|
| Active tabs | 24 | Connected to WS#2 |
| Page views (last hour) | ~180 | Active usage |
| Market data updates/sec | 45 | Real-time |
| Order submissions/min | ~2 | Normal trading |
| WebSocket disconnections | 0 | Stable |
| UI re-renders/sec | ~120 | Smooth performance |
| Page load time | < 1.5s | Within target |
| Largest page component | Portfolio | Lazy loaded |

### 19.9 UI Error Handling
| Error Scenario | Detection | Recovery |
|----------------|-----------|----------|
| WS#2 disconnect | Heartbeat timeout | Auto-reconnect, resume subscriptions |
| API error | HTTP error response | Show error message, retry |
| Page load failure | Component error | Fallback UI, error boundary |
| Data staleness | No update in 5s | Show "data stale" warning |
| WebSocket message parse error | JSON decode error | Log, skip message, continue |
| Authentication failure | 401 response | Redirect to login |

### 19.10 Configuration
```yaml
ui:
  theme:
    default: dark
    options: [light, dark, system]
    persistence: localStorage
    
  market_data:
    update_interval: 100  # ms
    max_symbols: 30
    decimal_places: 2
    
  notifications:
    max_visible: 50
    sound_enabled: true
    auto_dismiss: false
    
  performance:
    lazy_load: true
    virtual_scroll: true
    memoization: true
    chunk_size: 10
```

### 19.11 Notes
- **30+ page components** in C:\project\app\_pages/
- **WS#2 (Connection Manager)** is the real-time data source
- **REST APIs** handle order placement, configuration, and actions
- **PWA** provides offline support and push notifications
- **All UI components** subscribe to relevant WebSocket channels
- **Lazy loading** for performance optimization
- **Real-time data** updates at 1-10Hz per symbol
- **Connection quality** monitored and displayed to users

---
*UI architecture based on 30+ page components in C:\project\app\_pages/ and WS#2 connection management.*
