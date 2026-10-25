**STATUS: MIGRATED 2026-09-23 � 4-WS model (WebSocket_ConnectionManager_Flow.md + 08_WEBSOCKET_ARCHITECTURE.md). Dual description WS#1+WS#2 collapsed; now WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend. See 08/09 for canonical flows.**

# 17_DATABASE_ARCHITECTURE.md - Database Architecture

## 17.1 Database Overview
The KAUSTUBH trading terminal uses MongoDB as its primary data store for persistence, session state, market data, and audit logs. The `database_engine` manages the MongoDB connection pool and ensures data integrity.

### 17.2 Database Engine (database_engine)
The `database_engine` is a native engine (managed=false, auto-start enabled) that manages the MongoDB connection pool and provides database operations to all other engines.

#### Database Connection Configuration
```yaml
database:
  engine: mongodb
  host: localhost
  port: 27017
  database_name: kaustubh_trading
  connection_pool:
    min_size: 5
    max_size: 50
    max_idle_time_ms: 300000  # 5 minutes
    connect_timeout_ms: 10000  # 10 seconds
    socket_timeout_ms: 30000  # 30 seconds
  auth:
    username: kaustubh_user
    password: "<REDACTED>"
    auth_source: admin
  options:
    retry_writes: true
    w: "majority"  # write concern
    read_preference: primary
    journal: true
    auto_reconnect: true
```

#### Connection Pool State
| Metric | Value | Status |
|--------|-------|--------|
| Active connections | 12 | Within pool size |
| Idle connections | 8 | Available |
| Max pool size | 50 | Configured |
| Connection uptime | 2h 15m | Stable |
| Reconnects today | 0 | No disconnections |
| Average query time | 45ms | Within target |

### 17.3 Database Collections

#### Core Collections
| Collection | Purpose | Schema | TTL | Documents (est.) |
|------------|---------|--------|-----|-------------------|
| `orders` | All order lifecycle states | Order schema | 1 year | ~24,000 |
| `positions` | Open and closed positions | Position schema | 1 year | ~18,000 |
| `sessions` | User session state | Session schema | 30 min | ~15 |
| `market_data` | Real-time market data | Market data schema | 24 hours | ~1,800,000 |
| `audit_log` | Compliance audit trail | Audit event schema | 7 years | Growing |
| `targets` | Trading targets | Target schema | 1 year | ~80 |
| `notifications` | User notifications | Notification schema | 90 days | ~1,200 |
| `config` | System configuration | Key-value schema | Persistent | ~50 |
| `users` | User account data | User schema | Persistent | ~500 |
| `broker_adapters` | Broker connection state | Adapter schema | Persistent | ~3 |

#### Collection Details

##### Orders Collection
```json
{
  "order_id": "ORDER-UUID-123",
  "user_id": "USER123",
  "symbol": "RELIANCE",
  "side": "BUY",
  "quantity": 100,
  "price": 2453.00,
  "order_type": "LIMIT",
  "validity": "DAY",
  "status": "FILLED",
  "filled_quantity": 100,
  "filled_price": 2453.15,
  "broker_order_id": "BROKER-UUID-456",
  "source_broker": "kotak_adapter",
  "created_at": "2026-09-21T14:35:10.123Z",
  "updated_at": "2026-09-21T14:35:12.456Z",
  "state_stamp": "order_engine-v2.3.1-FILLED-2026-09-21T14:35:12Z"
}
```
- **Indexes**: user_id+symbol, status+created_at, order_id (unique)
- **TTL**: 1 year
- **Write Concern**: w:"majority"
- **Read Pattern**: By user_id+date range, by status+symbol

##### Positions Collection
```json
{
  "position_id": "POS-UUID-123",
  "user_id": "USER123",
  "symbol": "RELIANCE",
  "side": "LONG",
  "quantity": 100,
  "average_entry_price": 2453.15,
  "current_market_price": 2460.00,
  "unrealized_pnl": 685.00,
  "realized_pnl": 0.00,
  "total_pnl": 685.00,
  "margin_used": 24531.50,
  "position_status": "OPEN",
  "entry_timestamp": "2026-09-21T14:35:10.123Z",
  "last_update": "2026-09-21T14:35:12.456Z"
}
```
- **Indexes**: user_id+symbol (unique), position_status, side
- **TTL**: 1 year (after close)
- **Write Pattern**: Update-on-tick for PnL, insert on open
- **Read Pattern**: By user_id for portfolio view

##### Sessions Collection
```json
{
  "user_id": "USER123",
  "session_id": "SESSION-UUID-456",
  "tabs": [<tab_id>],
  "subscriptions": {
    "symbols": ["RELIANCE", "TCS", ...],
    "channels": ["market_data", "orders"]
  },
  "state": "active",
  "last_heartbeat": "2026-09-21T14:35:12Z",
  "created_at": "2026-09-21T14:00:00Z",
  "updated_at": "2026-09-21T14:35:12Z"
}
```
- **TTL Index**: last_heartbeat + 30 minutes (auto-expire)
- **Write Pattern**: Every 5 minutes or on state change
- **Read Pattern**: By user_id for session restore

##### Market Data Collection
```json
{
  "symbol": "RELIANCE",
  "timestamp": "2026-09-21T14:35:10.123Z",
  "l1": {"bid": 2453.00, "ask": 2453.20, ...},
  "l2": {"levels": {...}},
  "last_trade": {"price": 2453.15, ...},
  "source": "kotak_adapter",
  "feed_id": "feed_relay_01"
}
```
- **TTL Index**: timestamp + 24 hours (auto-expire)
- **Write Pattern**: Every market data tick (high frequency)
- **Read Pattern**: Latest per symbol, historical range queries
- **Sharding**: By symbol for horizontal scalability

##### Audit Log Collection
```json
{
  "event_id": "AUDIT-UUID-123",
  "event_type": "order_filled",
  "category": "trading",
  "timestamp": "2026-09-21T14:35:12.456Z",
  "user_id": "USER123",
  "session_id": "SESSION-UUID-456",
  "details": {...},
  "metadata": {...}
}
```
- **TTL Index**: timestamp + 7 years (2555 days)
- **Write Pattern**: Append-only, high volume
- **Read Pattern**: By user_id+date_range, by category+date_range
- **Index**: event_type+timestamp, user_id+category

### 17.4 Database Operations by Engine

| Engine | Operations | Collection | Pattern | Frequency |
|--------|------------|------------|---------|-----------|
| database_engine | Connection pool management | All | Infrastructure | Continuous |
| order_engine | Save/find/update orders | orders | CRUD | Per order |
| position_engine | Save/update positions | positions | CRUD | Per tick |
| session_engine | Save/expire sessions | sessions | CRUD + TTL | Every 5 min |
| market_data | Store market data | market_data | INSERT only | Per tick |
| target_engine | Save/cancel targets | targets | CRUD | Per target change |
| notification_service | Save/notifications | notifications | CRUD | Per notification |
| audit_engine | Log audit events | audit_log | INSERT only | Per event |
| scheduler_engine | Store schedule state | config | READ/WRITE | Per cron tick |
| broker_manager | Store broker state | broker_adapters | READ/UPDATE | Per connection |

### 17.5 Database Performance Metrics
| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| Average query time | 45ms | < 100ms | ✅ PASS |
| Write throughput | 1,250 ops/sec | < 2,000 | ✅ PASS |
| Connection pool utilization | 24% | < 80% | ✅ PASS |
| Lock contention | 0 | 0 | ✅ PASS |
| Replication lag | 0ms | < 100ms | ✅ PASS |
| Disk I/O | Normal | Normal | ✅ PASS |
| Memory usage | 2.4GB/8GB | < 80% | ✅ PASS |

### 17.6 Database Error Handling
| Error Scenario | Detection | Recovery |
|----------------|-----------|----------|
| Connection timeout | Socket timeout | Auto-reconnect with backoff |
| Write concern failure | Write error | Retry with exponential backoff |
| Duplicate key error | Unique constraint violation | Log, skip, alert |
| Query timeout | Cursor timeout | Kill query, retry optimized |
| Replica set failover | Member down | Promote secondary, reconnect |
| Disk full | Storage error | Alert operator, stop writes |
| TTL index overflow | TTL monitor error | Rebuild index, restart database_engine |

### 17.7 Database Configuration
```yaml
database:
  mongodb:
    host: localhost
    port: 27017
    database: kaustubh_trading
    connection_pool_size: 50
    write_concern: majority
    read_preference: primary
    journal: true
    
  collections:
    orders: {ttl: 31536000, index: [user_id+symbol, status+created_at]}
    positions: {ttl: 31536000, index: [user_id+symbol, position_status]}
    sessions: {ttl: 1800, index: [last_heartbeat]}
    market_data: {ttl: 86400, index: [symbol+timestamp]}
    audit_log: {ttl: 2555, index: [event_type+timestamp, user_id+category]}
    targets: {ttl: 31536000, index: [user_id+symbol]}
    notifications: {ttl: 7776000, index: [user_id+timestamp]}
    config: {ttl: null, index: [key]}
```

### 17.8 Notes
- **MongoDB is the single source of truth** for all persistent data
- **TTL indexes** automatically expire old market data (24h), sessions (30min), and audit logs (7 years)
- **Write concern majority** ensures data durability across replica set
- **Connection pool size 50** supports high concurrency for 24+ frontend tabs
- **audit_engine currently UNKNOWN** means no audit_log entries yet
- **All database operations** go through database_engine connection pool
- **Market data collection is the highest volume** (~1.8M documents) with 24h TTL

---
*Database architecture based on database_engine implementation in python-service/database/connection.py and observed MongoDB state.*
