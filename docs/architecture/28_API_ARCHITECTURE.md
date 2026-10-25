**STATUS: MIGRATED 2026-09-23 � 4-WS model (WebSocket_ConnectionManager_Flow.md + 08_WEBSOCKET_ARCHITECTURE.md). Dual description WS#1+WS#2 collapsed; now WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend. See 08/09 for canonical flows.**

# 28_API_ARCHITECTURE.md - API Architecture

## 28.1 API Overview
The KAUSTUBH trading terminal exposes a comprehensive REST API and WebSocket API for frontend interaction and external integrations.

### 28.2 API Endpoints

#### REST API (FastAPI)
| Endpoint | Method | Description | Auth Required |
|----------|--------|-------------|---------------|
| `/api/orders` | POST | Place new order | Yes |
| `/api/orders/{id}` | DELETE | Cancel order | Yes |
| `/api/orders/{id}` | GET | Get order status | Yes |
| `/api/orders` | GET | List orders | Yes |
| `/api/positions` | GET | Get open positions | Yes |
| `/api/portfolio` | GET | Get portfolio summary | Yes |
| `/api/watchlist` | GET/POST | Manage watchlist | Yes |
| `/api/targets` | GET/POST | Manage targets | Yes |
| `/api/sessions` | GET | Get active sessions | Yes |
| `/api/brokers` | GET | Get broker status | Yes |
| `/api/config` | GET/PUT | Get/update config | Admin only |
| `/api/auth/login` | POST | User login | No |
| `/api/auth/logout` | POST | User logout | Yes |
| `/api/audit` | GET | Get audit log | Admin only |
| `/api/notifications` | GET | Get notifications | Yes |
| `/api/risk` | GET | Get risk status | Yes |
| `/api/margin` | GET | Get margin status | Yes |
| `/api/health` | GET | System health | No |

#### WebSocket API (WS#2)
| Channel | Description | Subscribe |
|---------|-------------|-----------|
| `market_data:{symbol}` | Real-time market data | Yes |
| `order_status:{user_id}` | Order status updates | Yes |
| `position_updates:{user_id}` | Position PnL updates | Yes |
| `account_changes:{user_id}` | Account balance changes | Yes |
| `notifications:{user_id}` | User notifications | Yes |
| `alerts:{user_id}` | System alerts | Yes |
| `broker_events` | Broker connection events | Admin only |

### 28.3 API Request/Response Patterns

#### Order Placement
```json
// Request
POST /api/orders
{
  "user_id": "USER123",
  "symbol": "RELIANCE",
  "side": "BUY",
  "quantity": 100,
  "price": 2453.00,
  "order_type": "LIMIT",
  "validity": "DAY"
}

// Response
{
  "order_id": "ORDER-UUID-123",
  "status": "ACCEPTED",
  "message": "Order accepted for transmission",
  "timestamp": "2026-09-21T14:35:12.456Z"
}
```

#### Order Status
```json
// Response
{
  "order_id": "ORDER-UUID-123",
  "status": "FILLED",
  "filled_quantity": 100,
  "filled_price": 2453.15,
  "timestamp": "2026-09-21T14:35:12.456Z"
}
```

### 28.4 API Authentication
- **Bearer token** authentication on all protected endpoints
- **Session token** from login response
- **Token expiry**: 30 minutes
- **Auto-refresh**: Token refreshed on every request

### 28.5 API Rate Limiting
| Limit | Value | Action if Exceeded |
|-------|-------|--------------------|
| Requests per minute | 100 | 429 Too Many Requests |
| Burst size | 20 | Immediate rejection |
| Window size | 60 seconds | Rolling window |

### 28.6 Current API Runtime State
| Metric | Value | Status |
|--------|-------|--------|
| Active API connections | 24 | ✅ |
| Requests per minute | ~120 | ✅ Within limits |
| Average response time | 45ms | ✅ |
| Error rate | 0% | ✅ |
| Auth failures | 3 today | ✅ Normal |
| Rate limit triggers | 0 | ✅ |

### 28.7 Configuration
```yaml
api:
  host: "0.0.0.0"
  port: 8080
  cors_origin: ["https://kaustubh.trading", "http://localhost:3000"]
  rate_limit:
    max_requests_per_minute: 100
    burst_size: 20
  auth:
    token_expiry: 1800  # 30 minutes
    auto_refresh: true
  endpoints:
    - path: /api/orders
      methods: [POST, GET]
      auth: true
    - path: /api/health
      methods: [GET]
      auth: false
```

### 28.8 Notes
- **FastAPI** as the REST API framework
- **WebSocket** (WS#2) for real-time data
- **Bearer token** authentication on all protected endpoints
- **Rate limiting** prevents abuse
- **All API endpoints** documented in OpenAPI/Swagger
- **Current throughput**: ~120 requests/min

---
*API architecture based on FastAPI implementation in python-service/app/ and observed API performance.*
