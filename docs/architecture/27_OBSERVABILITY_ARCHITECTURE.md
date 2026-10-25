**STATUS: MIGRATED 2026-09-23 � 4-WS model (WebSocket_ConnectionManager_Flow.md + 08_WEBSOCKET_ARCHITECTURE.md). Dual description WS#1+WS#2 collapsed; now WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend. See 08/09 for canonical flows.**

# 27_OBSERVABILITY_ARCHITECTURE.md - Observability Architecture

## 27.1 Observability Overview
The observability architecture defines how system health, performance, and behavior are monitored, measured, and visualized across the KAUSTUBH trading terminal.

### 27.2 Observability Layers
| Layer | Metrics | Tools | Status |
|-------|---------|-------|--------|
| **Infrastructure** | CPU, memory, disk, network | System monitoring | ✅ Active |
| **Engine** | state_stamp, heartbeat, latency | Event bus | ✅ Active |
| **Trading** | Order volume, PnL, positions | Custom metrics | ✅ Active |
| **WebSocket** | Connection count, latency, throughput | Connection Manager | ✅ Active |
| **Database** | Query time, pool usage, TTL | MongoDB metrics | ✅ Active |
| **Alerting** | Thresholds, escalations | Alert system | ✅ Active |

### 27.3 Core Metrics

#### Engine Metrics (published every 5 seconds)
```json
{
  "engine_name": "order_engine",
  "state": "RUNNING",
  "state_stamp": "order_engine-v2.3.1-RUNNING-2026-09-21T14:35:12Z",
  "cpu_percent": 12.5,
  "memory_mb": 256,
  "event_queue_depth": 45,
  "active_subscriptions": 0,
  "orders_processed": 156,
  "last_heartbeat": "2026-09-21T14:35:12.456Z"
}
```

#### Trading Metrics
| Metric | Current | Target | Status |
|--------|---------|--------|--------|
| Orders per minute | ~2 | > 1 | ✅ |
| Order fill rate | 97.7% | > 95% | ✅ |
| Average order latency | 1.2s | < 3s | ✅ |
| Portfolio PnL | ₹20,770 | > 0 | ✅ |
| Active positions | 4 | > 0 | ✅ |
| Margin utilization | 38.2% | < 80% | ✅ |
| Risk violations today | 5 | < 10 | ✅ |

#### WebSocket Metrics
| Metric | Current | Target | Status |
|--------|---------|--------|--------|
| Active connections | 24 | > 0 | ✅ |
| WS#1 avg latency | 92ms | < 200ms | ✅ |
| WS#2 avg latency | 15ms | < 50ms | ✅ |
| Active feeds | 15 | > 0 | ✅ |
| Heartbeat loss | 0 | 0 | ✅ |

#### Database Metrics
| Metric | Current | Target | Status |
|--------|---------|--------|--------|
| Average query time | 45ms | < 100ms | ✅ |
| Connection pool usage | 24% | < 80% | ✅ |
| Write throughput | 1,250 ops/s | < 2,000 | ✅ |
| Lock contention | 0 | 0 | ✅ |
| Replication lag | 0ms | < 100ms | ✅ |

### 27.4 Alert Thresholds
| Threshold | Level | Action |
|-----------|-------|--------|
| CPU > 70% | WARNING | Alert operator |
| CPU > 90% | ERROR | Scale resources |
| Memory > 80% | WARNING | Alert operator |
| Memory > 95% | CRITICAL | Emergency restart |
| Order latency > 3s | ERROR | Investigate broker |
| WS#1 latency > 200ms | WARNING | Check broker connection |
| WS#2 latency > 50ms | WARNING | Check connection_manager |
| Margin utilization > 80% | WARNING | Alert user |
| Margin utilization > 95% | CRITICAL | Block new orders |
| Risk violations > 10/min | ERROR | Investigate |
| Engine state = ERROR | ERROR | Auto-restart |
| Engine state = DEGRADED | WARNING | Reconciliation |
| Broker adapter disconnected | ERROR | Failover |
| Database connection lost | CRITICAL | Emergency shutdown |

### 27.5 Dashboard Components
| Dashboard | Description | Frequency |
|-----------|-------------|-----------|
| System Health | All engine states, heartbeats | Real-time |
| Trading Overview | Orders, PnL, positions, margin | Real-time |
| WebSocket Status | Connections, feeds, latency | Real-time |
| Database Health | Query times, pool usage, TTL | Real-time |
| Risk Monitor | Limits, violations, exposure | Real-time |
| Audit Trail | All logged events | Historical |
| Performance | CPU, memory, latency trends | 5-min intervals |

### 27.6 Observability Events
| Event | Payload | Consumers |
|-------|---------|-----------|
| `heartbeat` | `{engine, state, state_stamp, metrics}` | Dashboard, alerting |
| `error_detected` | `{engine, error_type, message}` | Alerting, logging |
| `alert_triggered` | `{threshold, level, action}` | Operator, UI |
| `performance_metric` | `{metric, value, timestamp}` | Dashboard |
| `reconciliation_started` | `{engine, reason}` | Audit, dashboard |
| `system_health_change` | `{component, old_state, new_state}` | Dashboard, alerting |

### 27.7 Current Observability Status
| Component | Status | Health |
|-----------|--------|--------|
| System monitoring | ✅ Active | All metrics collected |
| Engine heartbeats | ✅ Active | 10/15 engines reporting |
| Trading metrics | ✅ Active | All metrics within targets |
| WebSocket monitoring | ✅ Active | All connections healthy |
| Database monitoring | ✅ Active | All queries performing well |
| Alerting | ✅ Active | Thresholds configured |
| Dashboard | ✅ Active | Real-time updates |
| audit_engine | ❓ Pending | Not yet observed |

### 27.8 Notes
- **All metrics** collected every 5 seconds via event bus
- **Alert thresholds** configurable via YAML
- **Dashboard** shows real-time system health
- **Heartbeat** every 25s (WS#1) and 30s (WS#2)
- **audit_engine UNKNOWN** means audit metrics not yet available
- **All observability data** stored in MongoDB for historical analysis

---
*Observability architecture based on event bus metrics and connection_manager heartbeat monitoring.*
