# WEBSOCKET_ARCHITECTURE.md

## KAUSTUBH Trading Platform - WebSocket Architecture

**Last Updated**: 2026-09-28
**Status**: ACTIVE
**Canonical Source**: `docs/architecture/08_WEBSOCKET_ARCHITECTURE.md`
**Verification**: Channel ownership confirmed by directory structure; runtime multiplexing NOT_VERIFIED.

---

## The Four Channels

| ID | Direction | Protocol | Owner (Code) | Purpose | Data Rate |
|----|-----------|----------|--------------|---------|-----------|
| **WS#1** | Kotak SFeed → Backend | Kotak (wss) | `python-service/ws_socket/ws_manager.py` | Market data ticks (LTP, OHLC, depth, OI) | Very high |
| **WS#2** | Kotak OrderFeed → Backend | Kotak (wss) | `python-service/ws_socket/order_feed_manager.py` | Order updates, position updates, trades | Low–medium |
| **WS#3** | Backend → Frontend | App WS | `python-service/connection_engine/` | Realtime distribution to UI | High |
| **WS#4** | Frontend → Backend | App WS | `python-service/connection_engine/` + `api/ws_gateway.py` | Commands (place/cancel/modify, subscribe) | Low |

---

## Why Four Channels

Separating broker feeds from UI distribution allows:
- Independent scaling (market data fan-out is high-volume; commands are low)
- Failure isolation (broker feed drop ≠ UI outage)
- Different security postures (WS#1/2 are broker-authenticated; WS#3/4 are app-authenticated)
- Clear ownership (broker owns WS#1/2; backend owns WS#3/4)

---

## WS#1 & WS#2 (Broker → Backend)

**Owner**: Broker. Backend is a consumer, never initiates protocol semantics.

**Manager responsibilities**:
```
connect (exponential backoff)
  → authenticate
  → subscribe(tokens, feed)
  → wait for ACK
  → track subscription state
  → dispatch validated messages to engines
reconnect (initial_delay → max_delay, max_attempts)
  → resubscribe (reconcile)
  → emit reconnection events
```

**Field normalization**: Broker field names vary (e.g. `last_traded_price` vs `ltp`). The WebSocket Engine applies **field profiles** per instrument to map broker → canonical names.

**Validation**: Type checks, required-field presence, range sanity, staleness detection.

**Events emitted**: `TICK_RECEIVED`, `TICK_VALIDATED`, `TICK_REJECTED`, `WS_CONNECTED`, `WS_DISCONNECTED`, `SUBSCRIPTION_ACK`, `SUBSCRIPTION_FAILED`.

---

## WS#3 & WS#4 (Backend ↔ Frontend)

**Served by**: `api/ws_gateway.py` at `WS /ws/realtime` (a single multiplexed endpoint).

**WS#3 (backend → frontend)**: Engine state, market data, order updates, position updates, scheduler events, notifications.

**WS#4 (frontend → backend)**: Place/modify/cancel order, subscribe/unsubscribe, engine control commands.

**Authentication**: `GET /api/realtime/token` issues a short-lived token; client presents on connect.

**NOT_VERIFIED**: Whether WS#3 vs WS#4 are separate logical subscriptions, separate sockets, or a single bidirectional socket with message-type routing. Code shows a single `/ws/realtime` endpoint — this may be a **DOCUMENTATION_CODE_CONFLICT** with the "4 separate WebSocket" architecture claim.

---

## Connection Engine (Backend Distribution)

**Module**: `python-service/connection_engine/`

**Responsibilities**:
- Maintain set of connected frontend clients
- Route engine events to relevant clients
- Batch/drain outbound frames (per `consumer` model)
- Enforce per-connection sequencing (reorder buffer)
- Expose health, metrics, telemetry

**Diagnostics endpoints**:
```
GET  /api/realtime/status
GET  /api/realtime/sessions
GET  /api/realtime/health
GET  /api/services/websocket/consumers
GET  /api/services/websocket/consumers/{id}/drain
GET  /api/services/websocket/subscriptions
```

---

## Reconnection & Resilience

| Mechanism | Config |
|-----------|--------|
| Initial reconnect delay | `ws_reconnect_initial_delay` |
| Max delay | `ws_reconnect_max_delay` |
| Max attempts | `ws_reconnect_max_attempts` |
| Heartbeat interval | `ws_heartbeat_interval_sec` |
| Heartbeat timeout | `ws_heartbeat_timeout_sec` |

**Behavior**: On drop, backoff grows exponentially. On reconnect, Session Manager reconciles desired subscriptions vs actual broker state and resubscribes. REST fallback poll for orders runs when WS#2 is unavailable.

**Risk**: Excessive reconnect attempts during a broker outage could trigger rate limits. Cap via config.

---

## WebSocket Endpoints (REST Companion)

| Endpoint | Purpose |
|----------|---------|
| `WS /ws/realtime` | Combined WS#3/WS#4 |
| `GET /api/services/websocket/status` | Engine status |
| `GET /api/services/websocket/health` | Health |
| `GET /api/services/websocket/metrics` | Metrics |
| `GET /api/services/websocket/subscriptions` | Active subscriptions |
| `POST /api/services/websocket/subscribe` | Add subscription |
| `POST /api/services/websocket/unsubscribe` | Remove subscription |
| `GET /api/services/websocket/field-profiles` | Field mappings |
| `GET /api/services/websocket/consumers` | Consumer drain state |
| `GET /api/websocket/history` | Connection history |
| `GET /api/websocket/events` | Event log |

Full list: `../api/API_CATALOG.md`.

---

## Frontend Client

**Module**: `lib/realtime-ws.ts`

**Hooks**: `use-realtime-client`, `use-live-stocks`, `use-tick-stream`, `engine-realtime`

**Behavior**:
- Connect to `/ws/realtime` with token
- Subscribe/unsubscribe based on route (page-scoped)
- Reconnect with backoff
- Rehydrate missed events via REST (gap recovery)
- Distribute events to subscribed consumers

---

## Verification Matrix (WebSocket)

| Behavior | Status |
|----------|--------|
| WS#1 subscription lifecycle | `NOT_VERIFIED` |
| WS#2 order feed delivery | `NOT_VERIFIED` |
| WS#3 frame format | `NOT_VERIFIED` |
| WS#4 command routing | `NOT_VERIFIED` |
| Reconnect + resubscribe | `NOT_VERIFIED` |
| Frontend gap recovery | `NOT_VERIFIED` |
| Field profile correctness | `NOT_VERIFIED` |

---

## Related Documents
- `08_WEBSOCKET_ARCHITECTURE.md` — Canonical source-of-truth
- `DATA_FLOW_MAP.md` — Data flows
- `../frontend/FRONTEND_DATA_FLOW.md` — Frontend WS client
- `../architecture/FAILURE_AND_RECOVERY.md` — Error handling
- `WebSocket_ConnectionManager_Flow.md` — Connection manager detail (referenced in 08)
