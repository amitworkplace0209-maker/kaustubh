**STATUS: MIGRATED 2026-09-23 — 4-WS model (WebSocket_ConnectionManager_Flow.md + 08_WEBSOCKET_ARCHITECTURE.md). Dual description WS#1+WS#2 collapsed; now WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend. See 08/09 for canonical flows.**

# 18_CONFIGURATION_ARCHITECTURE.md - Configuration Architecture

## 18.1 Configuration Overview
The KAUSTUBH trading terminal uses a YAML-based configuration system that is reloadable at runtime without requiring engine restarts. All configuration is managed through the `config` collection in MongoDB and can be modified via the API.

### 18.2 Configuration Layers
| Layer | File/Source | Priority | Managed By |
|-------|-------------|----------|------------|
| **System** | `config.yaml` | 1 (highest) | System administrator |
| **Environment** | Environment variables | 2 | Deployment platform |
| **Broker** | Broker adapter configs | 3 | broker_manager |
| **User** | User preferences | 4 | User profile |
| **Runtime** | In-memory defaults | 5 (lowest) | Engine defaults |

### 18.3 Configuration Sources

#### Primary Configuration File (config.yaml)
Located at `C:\project\config.yaml`, this file contains the main system configuration:
```yaml
system:
  name: "KAUSTUBH Trading Terminal"
  version: "2.3.1"
  environment: "production"
  
database:
  host: "localhost"
  port: 27017
  name: "kaustubh_trading"
  
brokers:
  kotak: {enabled: true, sandbox: false}
  shoonya: {enabled: true, sandbox: false}
  dummy: {enabled: true, sandbox: true}

risk:
  max_exposure: 500000000  # â‚¹50 Crores
  position_limits: {RELIANCE: 5000, TCS: 3000, ...}
  
trading:
  max_timeout_minutes: 240
  order_types: [LIMIT, MARKET, SL, SL-M]
  
notifications:
  enabled: true
  channels: [ws2_push, in_app, email]
```

#### Environment Variables
| Variable | Description | Default |
|----------|-------------|---------|
| `KAUSTUBH_ENV` | Environment (dev/prod) | production |
| `KAUSTUBH_PORT` | API server port | 8080 |
| `KAUSTUBH_WS_PORT` | WebSocket port | 8082 |
| `KAUSTUBH_MONGO_URI` | MongoDB connection string | localhost:27017 |
| `KAUSTUBH_LOG_LEVEL` | Logging verbosity | INFO |
| `KAUSTUBH_REDIS_URL` | Redis URL (optional) | null |

#### Broker Adapter Configuration
Each broker adapter has its own configuration:
```yaml
brokers:
  kotak:
    api_key: "<REDACTED>"
    api_secret: "<REDACTED>"
    oauth_token: "<REDACTED>"
    sandbox: false
    auto_connect: true
    websocket_url: "wss://api.kotaksecurities.com/ws"
    rest_url: "https://api.kotaksecurities.com/v1"
    
  shoonya:
    api_key: "<REDACTED>"
    api_secret: "<REDACTED>"
    session_token: "<REDACTED>"
    sandbox: false
    auto_connect: true
    websocket_url: "wss://api.shoonya.com/ws"
    rest_url: "https://api.shoonya.com/v1"
    
  dummy:
    mock_user: "paper_trader"
    sandbox: true
    auto_connect: true
```

### 18.4 Configuration Management

#### Hot Reload
Configuration changes are applied at runtime without restarting engines:
1. API request: `PUT /api/config` with updated config
2. Config stored to MongoDB `config` collection
3. Config published to event bus: `config_updated {section, new_value}`
4. Affected engines receive config_update event and apply changes
5. Confirmation sent to API caller

#### Configuration Validation
Each configuration section has a schema that validates values:
| Section | Schema Validation | Example |
|---------|-------------------|---------|
| `database` | Host, port, auth required | host: string, port: integer |
| `risk` | Limits must be positive numbers | max_exposure > 0 |
| `brokers` | Must have api_key, sandbox flag | api_key: string, sandbox: boolean |
| `trading` | Order types must be valid | order_types: [LIMIT, MARKET, SL, SL-M] |

#### Configuration Version Control
- All config changes are stored in MongoDB `config` collection with version number
- Each config change creates an audit log entry
- Rollback to previous version is supported via API
- Configuration history is maintained for 90 days

### 18.5 Configuration Schema (MongoDB)
```json
{
  "config_id": "CONFIG-UUID-123",
  "version": 42,
  "section": "risk",
  "key": "max_exposure",
  "value": 500000000,
  "changed_by": "admin",
  "changed_at": "2026-09-21T14:35:12.456Z",
  "previous_value": 400000000,
  "change_reason": "Increased exposure limit for Q4 trading"
}
```

### 18.6 Current Configuration Status
| Metric | Value | Status |
|--------|-------|--------|
| Config version | 42 | Active |
| Config last changed | 2026-09-21T10:00:00Z | 4h 35m ago |
| Active brokers | 3 (kotak, shoonya, dummy) | All enabled |
| Risk limits | Active | All enforced |
| Trading config | Active | All valid order types |
| Hot reload | Enabled | All sections reloadable |
| Environment | production | Production mode |
| API port | 8080 | Listening |
| WebSocket port | 8082 | Listening |

### 18.7 Configuration Error Handling
| Error Scenario | Detection | Recovery |
|----------------|-----------|----------|
| Invalid config value | Schema validation fails | Reject change, keep previous value |
| Config file missing | File not found | Use environment defaults |
| Config hot reload failure | Engine update error | Rollback to previous config version |
| MongoDB config write failure | DB connection error | Buffer changes, retry |
| Permission denied | Unauthorized user | Log attempt, reject change |

### 18.8 Configuration APIs
| API | Method | Description |
|-----|--------|-------------|
| `/api/config` | GET | Get current configuration |
| `/api/config` | PUT | Update configuration (hot reload) |
| `/api/config/{section}` | GET | Get specific section |
| `/api/config/{section}` | PATCH | Partial update |
| `/api/config/rollback` | POST | Rollback to previous version |
| `/api/config/history` | GET | View configuration change history |

### 18.9 Configuration Access Control
| Role | Permissions | Restrictions |
|------|-------------|--------------|
| **admin** | All sections | Full access to config, brokers, risk |
| **trader** | `trading` section only | Can modify trading parameters |
| **viewer** | Read-only | Can view config, cannot modify |
| **system** | All sections | Engine-internal, full access |

### 18.10 Notes
- **YAML-based configuration** with hot reload support
- **MongoDB `config` collection** stores configuration history
- **All config changes are audited** for compliance
- **Configuration is versioned** (currently version 42)
- **Broker adapter configs** are separate per broker
- **Hot reload** means no engine restart required for most changes
- **Environment variables** override file-based config for deployment flexibility

---
*Configuration architecture based on config management in python-service/ and observed config.yaml state.*
