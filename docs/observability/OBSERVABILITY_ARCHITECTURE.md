# OBSERVABILITY_ARCHITECTURE.md

## KAUSTUBH Trading Platform - Observability Architecture

**Last Updated**: 2026-09-28
**Status**: ACTIVE
**Verification**: Modules and endpoints identified statically. **No telemetry inspected at runtime.**

---

## Overview

The platform has a mature observability surface spanning structured logging, engine metrics, API telemetry, a data-quality pipeline, and an insights/incident layer. Most of it is exposed through REST endpoints under `/api/data-saver/insights`, `/api/data-quality`, and `/api/services/engines`.

---

## 1. Structured Logging

**Library**: `structlog` 26.1.0
**Module**: `python-service/logger/`
**Middleware**: Request logging in `app.py`

| Aspect | Detail | Status |
|--------|--------|--------|
| Format | JSON (structured) | `VERIFIED` (library) |
| Timestamps | IST (via `core/timezones.py`) | `VERIFIED` (design) |
| Request logging | Latency, status, DB-related flag | `VERIFIED` (middleware exists) |
| Correlation IDs | — | `UNKNOWN` |
| Log destination | stdout or file | `NOT_VERIFIED` |
| Log rotation | — | `NOT_VERIFIED` |
| Secret redaction | — | `UNKNOWN` (risk) |

**Endpoints**: `GET /api/logs`, `POST /api/system/logs/clear`

---

## 2. Engine Telemetry

**Endpoint family**: `/api/services/engines/*`

| Endpoint | Data |
|----------|------|
| `GET /api/services/engines` | All engine instances |
| `GET /api/services/engines/summary` | Aggregated states |
| `GET /api/services/engines/dependency-graph` | DAG |
| `GET /api/services/engines/{id}/health` | Per-engine health |
| `GET /api/services/engines/{id}/metrics` | Per-engine counters/timers |
| `GET /api/services/engines/{id}/dependencies` | Upstream/downstream |
| `GET /api/services/engines/{id}/errors` | Error log |
| `GET /api/services/engines/{id}/activity` | Activity stream |
| `POST /api/services/engines/heartbeat-all` | Force heartbeat |
| `POST /api/services/engines/health-check` | Global health check |

**Engine health vocabulary**: `HEALTHY`, `DEGRADED`, `UNKNOWN`, `UNHEALTHY`
**Engine state vocabulary**: `REGISTERED`, `STARTING`, `RUNNING`, `STOPPED`, `ERROR`

---

## 3. Health & Liveness

```
GET /health                    root probe
GET /api/health                alias (routes.py)
GET /api/system/health         full system health (503 if MongoDB down)
GET /api/phase3/session-manager/health
GET /api/services/websocket/health
GET /api/schedule-events/health
GET /api/scheduled-downloads/health
GET /api/realtime/health
```

**Semantics**: `/api/system/health` returns **503** when a critical dependency (MongoDB) is unavailable. This is the correct pattern for load-balancer probing.

**`CONFLICT`**: `/api/health` is registered in two modules. Resolution order `NOT_VERIFIED`.

---

## 4. API Telemetry

**Endpoints**:
```
GET /api/data-saver/insights/api-telemetry
GET /api/system/data-center/api-telemetry
```

| Metric | Description |
|--------|-------------|
| Request latency (p50/p95/p99) | Per-endpoint timing |
| Status code distribution | 2xx/4xx/5xx counts |
| Error rate | Failures per endpoint |
| DB-related flag | Requests touching MongoDB |
| Throughput | Requests per interval |

**Storage**: `api_telemetry` collection (rolling window)

---

## 5. Insights & Incidents

**Module**: `api/insights.py` (22 routes) under `/api/data-saver/insights`

| Endpoint | Purpose |
|----------|---------|
| `/live` | Live insight feed |
| `/summary` | Current summary |
| `/cards` | Dashboard summary cards |
| `/today` | Today's overview |
| `/events` | Event stream |
| `/events/{event_id}` | Event detail |
| `/errors` | Error groups |
| `/errors/{group_id}` | Error group detail |
| `/incidents` | Correlated incidents |
| `/attention` | Items requiring human action |
| `/telemetry` | Telemetry buckets |
| `/api-telemetry` | API metrics |
| `/search` | Search across events |
| `/compare` | Period comparison |
| `/reports` | Report index |
| `/reports/daily/{date}` | Daily report |
| `/reports/weekly` | Weekly report |
| `/reports/{report_type}` | Typed report |
| `POST /reports/generate` | Trigger report generation |
| `POST /events/export` | Export events |
| `POST /telemetry/flush` | Flush telemetry buffer |

**Insight Cards**: Pre-computed summary widgets (engine status, market session, incidents).

---

## 6. Data Quality Pipeline

**Module**: `api/quality.py` (20 routes) under `/api/data-quality`

| Endpoint | Purpose |
|----------|---------|
| `/summary` | Overall quality score |
| `/metrics` | Per-dimension metrics |
| `/issues` | Open quality issues |
| `/issues/{id}/{action}` | Resolve/dismiss an issue |
| `/scan-state` | Last scan state |
| `POST /scan` | Trigger full scan |
| `POST /scan/if-due` | Conditional scan |
| `/scan/history` | Historical scans |
| `/duplicates` | Duplicate records |
| `/dimensions` | Quality dimensions |
| `/symbols` | Per-symbol quality |
| `/trend` | Quality trend over time |
| `POST /snapshot` | Capture snapshot |
| `/pipeline` | Ingestion pipeline status |
| `/storage` | Storage health |
| `/diagnostics` | Full diagnostic dump |

---

## 7. WebSocket Observability

**Endpoints**:
```
GET /api/services/websocket/status | /health | /metrics | /latency
GET /api/services/websocket/quality
GET /api/services/websocket/quality/{instrument_token}
GET /api/services/websocket/subscriptions
GET /api/services/websocket/consumers
GET /api/services/websocket/consumers/{id}/drain
GET /api/services/websocket/history | /history/{connection_id}
GET /api/services/websocket/events | /daily
GET /api/realtime/status | /sessions | /events | /telemetry | /health
```

| Metric | Description |
|--------|-------------|
| Latency | Tick → UI delivery time |
| Quality | Field-completeness per instrument |
| Drain | Consumer buffer backlog |
| History | Connection lifecycle records |
| Subscriptions | Active broker subscriptions |

---

## 8. System & Database Metrics

```
GET /api/system/mongo-stats                       MongoDB server stats
GET /api/system/data-center/overview              Storage overview
GET /api/system/data-center/storage-trend         Growth over time
GET /api/system/data-center/collections/all       Per-collection stats
GET /api/system/data-center/collections/{name}    Collection detail
GET /api/system/data-center/snapshots             Captured snapshots
POST /api/system/data-center/snapshots/capture    Capture now
POST /api/system/data-center/deep-scan            Heavy scan (off-peak)
GET /api/system/data-center/history
GET /api/system/data-center/ticks-history
GET /api/system/trading-day-stats
GET /api/system/trading-history
GET /api/system/quality-metrics
```

---

## 9. Audit Trail

**Collection**: `audit_log` (7-year TTL)
**Owner**: `audit_engine`, `order_engine`, `risk_engine`

| Field | Purpose |
|-------|---------|
| `ts` | When |
| `actor` | user / engine / broker |
| `action` | What |
| `entity` / `entity_id` | Target |
| `decision` | ALLOW / DENY |
| `reason` | Why |
| `request` / `response` | Payload |
| `risk_checks` | Pre-trade results |
| `ip` | Source |
| `duration_ms` | Latency |

**Immutability**: Should be append-only. **NOT_VERIFIED** that no update/delete paths exist.

---

## 10. Frontend Observability

| Route | Purpose |
|-------|---------|
| `/services/logs` | Application log viewer |
| `/services/system` | System status |
| `/services/system-indicators` | Indicator dashboard |
| `/data-saver/insights` | Insights hub |
| `/data-saver/insights/errors` | Error explorer |
| `/data-saver/insights/incidents` | Incident list |
| `/data-saver/insights/attention` | Action queue |
| `/data-saver/insights/activity` | Activity stream |
| `/data-saver/quality` | Data quality UI |
| `/data-saver/data-center` | Storage/DB UI |
| `/data-saver/websocket` | WebSocket health UI |

**Connection indicator**: Expected in the layout shell (WS#3/WS#4 state). `NOT_VERIFIED`.

---

## 11. Gaps in Observability

| Gap | Severity | Detail |
|-----|----------|--------|
| No alerting integration | High | No Prometheus/Grafana/Sentry config found |
| No CI/CD observability | High | No pipeline (see `TESTING_ARCHITECTURE.md`) |
| No log shipping | Medium | No Loki/ELK config found |
| Correlation IDs | Medium | Not confirmed |
| Metrics not exported | Medium | No Prometheus `/metrics` endpoint found |
| Trace propagation | Low | No OpenTelemetry/tracing found |
| Alert on missed square-off | High | Not confirmed — see `SCHEDULER_AND_LIFECYCLE.md` |

---

## 12. Recommended Additions

| Addition | Rationale |
|----------|-----------|
| Prometheus `/metrics` endpoint | Machine-readable metrics for alerting |
| Alert rules (engine DEGRADED, WS disconnected, positions open after 15:20) | Catch money-losing conditions |
| Log shipping to centralized store | Post-mortem across restarts |
| OpenTelemetry tracing | Correlate frontend → backend → broker latency |
| Health-based alerting on `/api/system/health` | Detect MongoDB loss immediately |

---

## Related Documents
- `../api/API_CATALOG.md` — All observability endpoints
- `../architecture/FAILURE_AND_RECOVERY.md` — Diagnostics
- `../runtime/SCHEDULER_AND_LIFECYCLE.md` — Scheduler observability
- `../testing/VERIFICATION_MATRIX.md` — Verification status
