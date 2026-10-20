# FAILURE_AND_RECOVERY.md

## KAUSTUBH Trading Platform - Failure, Error & Recovery Analysis

**Last Updated**: 2026-09-28
**Status**: ACTIVE
**Verification**: Recovery code paths inferred from module names and config; **NOT runtime-verified**.

---

## Failure Classes

| Class | Example | Blast Radius | Auto-Recovery |
|-------|---------|---------------|----------------|
| **Transient** | Network blip, broker 5xx | Localized | Retry w/ backoff (`tenacity`) |
| **Dependency** | MongoDB down | **System-wide** | Reconnect loop; health 503 |
| **Data** | Malformed tick, bad field | One symbol | Reject + count; continue |
| **Business** | Insufficient margin, risk limit hit | One order | Reject + audit; no retry |
| **Configuration** | Missing `MONGODB_URI` | **Startup failure** | None — fail fast |
| **Runtime** | Engine exception, unhandled | Engine-specific | Engine error state + alert |
| **Security** | Bad token, rate limit | User/session | 401/403; log |
| **Process** | Backend crash, OOM | **Full outage** | Process guard + restart policy |

---

## Error Handling Patterns

| Pattern | Where | Behavior |
|---------|-------|----------|
| `tenacity` retry | Broker REST, DB ops | Exponential backoff, max attempts |
| `try/except` + log | All services | Structured log with context |
| `state = ERROR` | Engines | Engine transitions to ERROR; health degrades |
| `audit_log` write | Order/risk decisions | Persist before/after every decision |
| `HTTPException` | API routers | Structured error responses |
| Graceful degradation | Health endpoints | 503 when critical deps down |

---

## Dependency Failure Matrix

| Dependency | If Down | System State | Recovery |
|-----------|---------|--------------|----------|
| **MongoDB** | Cannot persist, cannot start | `CRITICAL` — health 503 | Reconnect; `mongodb_connect_attempts` with delay |
| **Kotak REST** | No order placement | Trading degraded; read-only | Retry; failover to Shoonya (if enabled) |
| **Kotak SFeed (WS#1)** | No market data | Ticks stale; rankings stale | Reconnect w/ backoff; resubscribe |
| **Kotak OrderFeed (WS#2)** | No order/position updates | Orders may show stale state | REST poll fallback; reconnect |
| **Shoonya** | No secondary broker | No failover | N/A (already degraded) |
| **Frontend** | No UI | Backend still runs | N/A (client issue) |
| **Scheduler** | No lifecycle transitions | Manual intervention needed | Restart scheduler; catch-up logic |

---

## WebSocket Recovery

| Scenario | Detection | Recovery |
|----------|-----------|----------|
| Broker feed drop | Heartbeat timeout | Exponential reconnect + resubscribe |
| App WS client drop | Client heartbeat | Client reconnect + REST gap-rehydrate |
| Reorder gap | Sequence number check | Request missing range via REST |
| Stale ticks | Timestamp check | Mark `STALE`; attempt resubscribe |

**Config**: `ws_reconnect_initial_delay`, `ws_reconnect_max_delay`, `ws_reconnect_max_attempts`, `ws_heartbeat_timeout_sec`, `ws_heartbeat_interval_sec`

---

## Engine Recovery

| Engine Failure | Detection | Recovery |
|---------------|-----------|----------|
| Start failure | `STARTING → ERROR` | Log; health `UNHEALTHY`; manual restart via `POST /api/services/engines/{id}/restart` |
| Runtime exception | Error handler | Engine → `ERROR`; error log in `/{id}/errors` |
| Stall (no heartbeat) | Health check | Flag `DEGRADED`; alert |
| Dependency failure | Dependency check | Dependents also `DEGRADED` |

**Manual controls**:
```
POST /api/services/engines/{engine_id}/start
POST /api/services/engines/{engine_id}/stop
POST /api/services/engines/{engine_id}/restart
POST /api/services/engines/heartbeat-all
POST /api/services/engines/health-check
POST /api/services/engines/db_writer_engine/flush
```

---

## Scheduler Recovery

| Failure | Impact | Recovery |
|---------|--------|----------|
| Missed phase (system asleep) | Skipped action | **UNKNOWN** — no catch-up documented |
| Clock drift | Wrong phase timing | NTP; `scheduler-engine` ledger check |
| Square-off skipped | **Positions left open** | **CRITICAL** — manual square-off; alert |
| Logout skipped | Session not closed | Manual logout via `/api/auth/logout` |

**Risk**: Square-off failure at 15:16 leaves real money exposed. Mitigation: alert if positions remain after 15:20 IST.

---

## Data Integrity Recovery

| Issue | Detection | Recovery |
|-------|-----------|----------|
| Duplicate orders (retry race) | `client_order_id` dedup | Idempotency check before retry |
| Partial bulk insert | Write count mismatch | Retry remaining; audit |
| Corrupt tick field | Validation | Reject; count in `TICK_REJECTED` |
| Stale position cache | Reconcile mismatch | REST `positions()` as authority |
| Orphaned subscription | Diff vs broker | Reconcile (unsubscribe or refresh) |
| DB disconnect mid-write | Exception | Retry w/ backoff; verify commit |

---

## Process-Level Recovery

| Mechanism | Purpose |
|-----------|---------|
| `runtime/singleton.py` | Prevent duplicate backend instances (process guard) |
| `psutil` | Process/system monitoring |
| Health endpoints | External liveness probe |
| Structured logging | Post-mortem analysis |

**NOT VERIFIED**: Whether a supervisor (systemd, PM2, Docker restart policy) is configured outside the repo.

---

## Observability for Failure Analysis

| Tool | Purpose |
|------|---------|
| `/api/system/health` | Liveness + dependency status |
| `/api/services/engines/{id}/errors` | Per-engine error log |
| `/api/data-saver/insights/errors` | Correlated error groups |
| `/api/data-saver/insights/incidents` | Correlated incidents |
| `/api/data-saver/insights/attention` | Items needing action |
| `/api/websocket/history` | Connection history |
| `/api/websocket/metrics` | WS metrics |
| `audit_log` collection | All trading decisions |

---

## Known Failure Gaps

| Gap | Severity | Detail |
|-----|----------|--------|
| No documented scheduler catch-up after missed phase | High | Sleep/restart mid-session may skip actions |
| No confirmed retry idempotency on order placement | Critical | Risk of duplicate orders on retry |
| Square-off failure alerting not confirmed | High | Positions could be left open silently |
| No supervisor config outside repo | Medium | Crash recovery depends on deployment |
| Circuit breaker pattern not documented | Medium | Broker outage may cause cascading retries |

---

## Related Documents
- `WEBSOCKET_ARCHITECTURE.md` — WS recovery detail
- `../runtime/SCHEDULER_AND_LIFECYCLE.md` — Scheduler phases
- `../observability/OBSERVABILITY_ARCHITECTURE.md` — Monitoring
- `../PROJECT_RISKS.md` — Risk register
- `../api/API_CATALOG.md` — Recovery endpoints
