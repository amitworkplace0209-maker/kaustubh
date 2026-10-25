**STATUS: MIGRATED 2026-09-23 � 4-WS model (WebSocket_ConnectionManager_Flow.md + 08_WEBSOCKET_ARCHITECTURE.md). Dual description WS#1+WS#2 collapsed; now WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend. See 08/09 for canonical flows.**

# 06_BROKER_ARCHITECTURE.md - Broker Adapter Architecture

## 6.1 Broker Architecture Overview
The KAUSTUBH trading terminal supports multiple broker adapters for connectivity to different brokerage platforms. The broker architecture is managed by `broker_manager` engine with `managed=false` (native engine, auto-start enabled).

### 6.2 Broker Adapter Inventory
| Broker | Adapter | Status | API Protocol | Authentication |
|--------|---------|--------|--------------|----------------|
| Kotak | `kotak_adapter` | RUNNING | REST + WebSocket | OAuth 2.0 + API Key |
| Shoonya | `shoonya_adapter` | RUNNING | REST + WebSocket | Session Token |
| Dummy | `dummy_adapter` | RUNNING | REST + WebSocket | Mock Credentials |

### 6.3 Broker Manager (broker_manager Engine)
The `broker_manager` engine is the central orchestrator for all broker adapters. Key responsibilities:

- **Adapter Registration**: Dynamic registration of broker adapters at startup
- **Connection Lifecycle**: Coordinate connect/disconnect across all adapters
- **Failover**: Automatic broker switch on connection failure
- **Load Balancing**: Distribute order routing across available brokers
- **Health Monitoring**: Continuous heartbeat and liveness detection per adapter

### 6.4 Adapter Interface Contract
All broker adapters must implement the following methods (defined in `BrokerAdapter` base class):

```python
class BrokerAdapter(ABC):
    @abstractmethod
    async def connect(self) -> bool: ...
    @abstractmethod
    async def disconnect(self) -> None: ...
    @abstractmethod
    async def place_order(self, order: Order) -> OrderID: ...
    @abstractmethod
    async def cancel_order(self, order_id: OrderID) -> bool: ...
    @abstractmethod
    def get_positions(self) -> List[Position]: ...
    @abstractmethod
    def get_account_status(self) -> AccountStatus: ...
    @abstractmethod
    def subscribe_market_data(self, symbols: List[str], callback) -> None: ...
    @abstractmethod
    def unsubscribe_market_data(self, symbols: List[str]) -> None: ...
```

### 6.5 Kotak Adapter (kotak_adapter)
- **Status**: RUNNING
- **Primary Exchange**: NSE/BSE
- **WebSocket Feed**: wss://api.kotaksecurities.com/ws
- **REST API**: https://api.kotaksecurities.com/v1
- **Features**:
  - Equity equity and F&O order placement
  - Real-time market data feeds
  - Position tracking and PnL calculation
  - Margin requirement checking
- **Authentication**: OAuth 2.0 token refresh (auto-handled by adapter)
- **Current State**: Connected, streaming 15 symbol feeds

### 6.6 Shoonya Adapter (shoonya_adapter)
- **Status**: RUNNING
- **Primary Exchange**: NSE/BMC
- **WebSocket Feed**: wss://api.shoonya.com/ws
- **REST API**: https://api.shoonya.com/v1
- **Features**:
  - Intraday and delivery order placement
  - Option chain requests
  - Historical data requests
- **Authentication**: Session token (generated at login, refreshed auto)
- **Current State**: Connected, market data active

### 6.7 Dummy Adapter (dummy_adapter)
- **Status**: RUNNING
- **Purpose**: Paper trading and development
- **Features**:
  - Simulated order execution with configurable latency
  - Position tracking with synthetic PnL
  - Market data simulation with configurable price movements
  - Risk and margin simulation
- **Authentication**: Mock credentials (any valid string accepted)
- **Current State**: Connected, used for paper trading desks

### 6.6 Broker Connection Topology
```
User API Requests
       ↓
  broker_manager engine
       ↓
   ┌─────────────────┐
   │ kotak_adapter   │
   │ shoony_adapter  │
   │ dummy_adapter   │
   └─────────────────┘
       ↓          ↓          ↓
  Broker Servers   Broker Servers   Paper Trading
       ↓          ↓          ↓
  Exchange Feeds   Exchange Feeds   Simulated Feeds
```

### 6.7 Failover and Redundancy
- **Primary Broker**: kotak_adapter (preferred, full feature set)
- **Secondary Broker**: shoonya_adapter (backup, similar feature set)
- **Paper Trading**: dummy_adapter (always available, no real market impact)
- **Failover Policy**:
  1. If kotak_adapter fails → shounya_adapter auto-activated within 3 seconds
  2. If both fail → dummy_adapter activated for paper trading mode
  3. User notification sent via session_engine events

### 6.8 Broker Adapter Health Metrics
| Metric | Threshold | Action |
|--------|-----------|--------|
| Connection uptime | < 95% over 5 min | Auto-restart adapter |
| Heartbeat timeout | > 30s no heartbeat | Mark adapter UNHEALTHY |
| Order rejection rate | > 5% in 1 min | Investigate broker API limits |
| Latency (order → ack) | > 5000ms | Circuit breaker activated |
| WebSocket disconnects | > 3 in 1 min | Auto-reconnect with exponential backoff |

### 6.9 Current Broker Runtime State
| Adapter | State | Health | Last Heartbeat | Active Feeds | Open Orders |
|---------|-------|--------|----------------|--------------|-------------|
| kotak_adapter | RUNNING | Healthy | 2026-09-21T14:35:12Z | 15 | 3 |
| shoonya_adapter | RUNNING | Healthy | 2026-09-21T14:35:12Z | 12 | 1 |
| dummy_adapter | RUNNING | Healthy | 2026-09-21T14:35:12Z | 20 | 0 |

### 6.10 Broker Configuration
```yaml
brokers:
  kotak:
    managed: false  # native engine, auto-start
    api_key: "<REDACTED>"
    api_secret: "<REDACTED>"
    oauth_token: "<REDACTED>"
    sandbox: false
    auto_connect: true
    
  shoonya:
    managed: false  # native engine, auto-start
    api_key: "<REDACTED>"
    api_secret: "<REDACTED>"
    session_token: "<REDACTED>"
    sandbox: false
    auto_connect: true
    
  dummy:
    managed: false  # native engine, auto-start
    mock_user: "paper_trader"
    sandbox: true
    auto_connect: true
```

### 6.11 Notes
- All 3 broker adapters are native engines (managed=false, auto-start enabled)
- kotak_adapter and shoonya_adapter connect to live broker servers
- dummy_adapter used for paper trading and strategy development
- Broker failover is automatic and transparent to upper-layer engines (order_engine, session_engine)
- Connection state shared via broker_manager state_stamp for dependency engines

---
*Broker architecture based on broker_manager implementation in python-service/brokers/manager.py and adapter implementations in python-service/brokers/.*
