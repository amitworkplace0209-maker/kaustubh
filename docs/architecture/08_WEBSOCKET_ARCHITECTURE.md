# 08_WEBSOCKET_ARCHITECTURE.md — Four WebSocket Architecture

Reference: `docs/architecture/WebSocket_ConnectionManager_Flow.md` (source of truth)

## 8.1 Four-WebSocket Overview

KDS uses **four** system-boundary WebSockets plus REST and an internal Event Bus. Backend engines communicate via the Event Bus, never via WebSocket hops.

| Channel | Direction | Owner | Purpose |
|---|---|---|---|
| **WS#1** | Kotak → Backend | `ws_socket.ws_manager.WebSocketManager` + `ws_socket.engine.engine.WebSocketEngine` | Broker Market Data WebSocket (SFeed): LTP, OHLC, volume, LTQ, bid/ask, depth, OI, market status, timestamps |
| **WS#2** | Kotak → Backend | `ws_socket.order_feed_manager.OrderFeedManager` (create_order_feed()) | Broker Order & Position WebSocket: `OrderUpdate` / `PositionUpdate` |
| **WS#3** | Backend → Frontend | `connection_engine.ConnectionEngine` (Connection Manager) | Backend realtime bridge: market, orders, positions, P&L, risk/margin, notifications, connection/subscription state |
| **WS#4** | Frontend → Backend | `connection_engine` + `api.ws_gateway` Command Router | Frontend command/control: place/cancel/modify/square-off/watchlist/target/realtime controls |
| **REST** | Frontend ↔ Backend | FastAPI + backend engines | Search, bootstrap, snapshots, funds/holdings/margins, previews, historical data, reports, config |
| **Broker REST** | Backend ↔ Kotak | `Broker Terminal Engine` + `auth.kotak_client.KotakSession` | Order actions, order/trade reports, funds/margin/holdings reconciliation |
| **Event Bus** | Backend internal | `services.engine_event_bus.EngineEventBus` | Engine-to-engine distribution (Market Watch, Risk, Order, Audit, Connection Manager, etc.) |

> **Rule:** `WebSocket Engine → Event Bus → {Feature/Market Watch, Risk, Order, Connection Manager}`. Never `WebSocket Engine → WS → Feature Engine → WS → Risk Engine → WS → Connection Manager`.

## 8.2 WS#1 — Broker Market Data (Kotak SFeed)

**Direction:** Kotak → Backend  
**Owner:** `WebSocketManager` (socket, reconnect, subscribe/unsubscribe, ACKs) + `WebSocketEngine` (validation, normalization, reconciliation)  
**Flow:**
```
Kotak SFeed
  ↓ WS#1
WebSocketManager (connect / reconnect / subscribe / ACK)
  ↓
WebSocketEngine (validation / normalization)
  ↓
EngineEventBus (TICK_VALIDATED / TICK_RECEIVED / TICK_REJECTED)
  ├── Market Watch / Feature Engine
  ├── Risk Engine
  ├── DB Writer (via Connection Manager's DATA_SAVER drain)
  └── Connection Manager → WS#3 → Frontend
```

Key properties: supervisor states (`SUPERVISOR_*`), exponential backoff with jitter, session-driven, daily subscription intent from `Session Manager` (see §8.9), validation/normalization, `raw_store` for lossless persistence. Must never connect directly to frontend. Implemented via `NeoAPI.create_websocket()` / `SFeedWebSocket`.

## 8.3 WS#2 — Broker Order & Position Feed

**Direction:** Kotak → Backend  
**Owner:** `ws_socket.order_feed_manager.OrderFeedManager` (OrderFeedWebSocket, session-driven supervisor)  
**SDK:** `kotakneoapi==3.0.6`, `NeoAPI.create_order_feed() -> OrderFeedWebSocket`, `wss://{data_center}.kotaksecurities.com/realtime` (dynamic via `configuration.order_feed_url / rt_url / base_url`)  
**Message types:** `OrderUpdate` (`type:"order"`, `OrderData` with `nOrdNo`, `exOrdId`, `ordSt`, `avgPrc`, `qty`, `fldQty`, `unFldSz`, `trnsTp`, `prcTp`, `prod`, `exSeg`, `sym`, `trdSym`, `tok`, ... ) + `PositionUpdate` (`type:"position"`, `PositionData` with `actId`, `sym`, `exSeg`, `prod`, `flBuyQty`, `flSellQty`, `buyAmt`, `sellAmt`, `posFlg`, `sqrFlg`, `lotSz`, `multiplier`, `hsUpTm`, ...). Both have `extra="allow"` so unknown broker keys are preserved.

`ws_order_feed: {type:cn, Authorization:<edit_token>, Sid:<edit_sid>, src:WEB}` is sent immediately after socket open.

**Flow:**
```
Kotak
  ↓ WS#2
OrderFeedManager (connect / reconnect with fixed delay + jitter, auth via edit_token/sid)
  ↓ normalize
EngineEventBus (ORDER_UPDATE / POSITION_UPDATE, also order.updated / position.updated, ORDER_UPDATED / POSITION_UPDATED legacy)
  ├── Order Engine
  ├── Risk / Position state (indicative P&L = PositionUpdate × WS#1 LTP, reconciled with REST positions())
  ├── Audit Engine
  └── Connection Manager → WS#3 → Frontend (orders / positions channels)
```

`OrderFeedManager` is session-driven (not market-window gated) so post-market order events are delivered. It also bridges directly into `ConnectionEngine._broadcast_frame` (`order.update` → `orders` channel, `position.update` → `positions` channel) and `state_store.publish` so both SSE and WS#3 listeners observe it. Broker order placement still uses **Broker REST** (`place_order` / `modify_order` / `cancel_order`); WS#2 only reports the broker-side result and must not be treated as an order placement API. Reconnect is reconnect-delay + jitter, bounded by `ws_max_reconnect_attempts` (0=unlimited), and on reconnect REST reconciliation (`positions()`, `order_report()`, `trade_report()`) recovers missed state.

Previous gap: `ws_manager.py` was the single SFeed owner; `create_order_feed()` existed but was not wired. Now `ws_socket/order_feed_manager.py` owns it and `app.py` + `scheduler._login_impl_body` start the supervisor.

## 8.4 WS#3 — Backend → Frontend Realtime

**Direction:** Backend → Frontend  
**Owner:** `Connection Manager / Connection Engine` (`connection_engine.ConnectionEngine`, `api.ws_gateway` `GET /api/realtime/*` + `WS /ws/realtime` read path)  
**Flow:**
```
WS#1 / WS#2 → Validation / Normalization → EngineEventBus → Canonical Backend State
  ↓
Connection Manager (fan-out, coalescing, backpressure, per-channel rate)
  ↓ WS#3
Frontend (canonical KDS events, NOT raw Kotak payloads)
```

WS#3 carries: market events (LTP/change/OHLC/volume/bid/ask/spread/depth/freshness), order events (`ORDER_UPDATE` lifecycle SUBMITTING→OPEN→PARTIAL→COMPLETE/REJECTED/CANCELLED), position events (qty/amount updates), risk/margin/P&L, notifications, connection/subscription/system state. Frontend must receive canonical events; raw SFeed bytes stay in `raw_store` / `Data Saver` only. Delivery is per-session `Outbox` with `DROP_OLDEST` backpressure; critical channels (`orders`, `notifications`, `positions`) are prioritized.

Snapshot + realtime pattern: on (re)connect frontend fetches REST snapshot (`/api/trading/*`, `/api/search`, `/api/websocket/*`) then resumes WS#3 deltas. WS#3 alone is not assumed to be complete after reconnect.

## 8.5 WS#4 — Frontend → Backend Commands

**Direction:** Frontend → Backend  
**Owner:** `connection_engine` `Command Router` inside `api.ws_gateway` reader task (`WS /ws/realtime` write path)  
**Flow:**
```
Frontend (WS#4 frame {action, request_id, correlation_id, payload})
  ↓ WS#4
Connection Manager / Command Router (_handle_message)
  ↓ route
Order Engine / Squareoff Engine / Watchlist / Target / Risk / Audit / Broker Terminal
  ↓
Kotak REST (place/modify/cancel etc.)
  ↓
Kotak → WS#2 → OrderUpdate → Backend state → Event Bus → Connection Manager → WS#3 → Frontend
```

Inbound actions (JSON, `action` + `request_id` + `correlation_id`):
- `place_order` / `placeOrder` → `core.engines.order_engine.place("kotak", order)`
- `cancel_order` → `order_engine.cancel("kotak", order_id)`
- `modify_order` → `order_engine.modify("kotak", order_id, order)`
- `square_off` → `order_engine.square_off("kotak", position)`
- `watchlist_add` / `watchlist_remove` / `target_set` etc. → respective engines

Each handler enforces `session_manager.auth_gate("trading")` (JWT + broker session), validates payload, attaches `correlation_id` for audit trail, returns `order.ack` / `square_off.ack` on WS#4 with `requestId/correlationId/ok/result`, and publishes `state_store` frame for legacy SSE listeners. Never calls Kotak directly from the browser. Order placement failure → `ORDER_REJECTED` notification; success → `ORDER_SUBMITTED` notification (both via `notification_service`).

WS#4 coexists with REST: `POST /api/trading/order/*` remains the synchronous fallback; either path converges on `Order Engine → Risk → Audit → Broker Terminal → Kotak REST`. No business logic lives in transport handling.

## 8.6 REST — Frontend ↔ Backend

| Use | Endpoint family | Engine |
|---|---|---|
| search (global eq-only, ranked, with 1-qty margin) | `GET /api/search`, `POST /api/trading/search-local` | `Search Engine` + instrument cache |
| bootstrap / instrument details / cache status | `GET /api/trading/instrument-cache/*` | `instrument_cache` |
| quote snapshots (ltp/ohlc) | `POST /api/trading/quote` | `kotak_adapter` → `KotakSession` → `quotes()` |
| initial orders / positions / funds / holdings | `GET /api/trading/orders`, `/positions`, `/funds`, `/holdings` | `Broker Terminal` / `KotakSession` → REST + cache |
| margin preview (broker-computed) | `GET /api/trading/margin`, `GET /api/trading/brokers/overview` margin | `Broker Terminal` → `margin_required()` (authoritative; no local estimate) |
| risk preview | `POST /api/services/risk/validate` | `Risk Engine` |
| historical / reports / downloads / exports | `GET /api/downloads/*`, `/api/export/*`, `/api/ticks/*` | `Storage Engine`, `Data Center` |
| configuration | `GET/PUT /api/settings/*` | `settings_service` |
| session / system | `GET /api/phase3/session-manager/*`, `GET /api/system` | `Session Manager`, `state_store` |

Synchronous request/response; complements WS#3 realtime deltas.

## 8.7 Broker REST — Backend ↔ Kotak

Owned by `Broker Terminal Engine` + `KotakSession` (the only place that imports `neo_api_client`).

- `place_order` (exchange_segment, product, price, order_type, quantity, validity, trading_symbol, transaction_type, amo, disclosed_quantity, trigger_price) — trading_symbol resolved via instrument cache from token
- `modify_order` (order_id, price, order_type, quantity, validity, trigger_price, disclosed_quantity)
- `cancel_order` (order_id)
- `order_report` / `order_history`, `trade_report`, `positions`, `holdings`, `limits`, `quotes`, `search_scrip`, `margin_required`
- `square_off` is executed as an opposite-direction market order (v3 removed the dedicated `square_off_position` REST call)

All mutating calls go through `Order Engine → Risk → Audit → Adapter → Kotak REST`. SDK responses are normalized to plain dicts (`_to_dict`) before persistence/logging.

## 8.8 Event Bus — Backend Internal

`services.engine_event_bus.EngineEventBus` (typed, async, bounded queues, wildcard + typed subscribers) — NOT a WebSocket.

Canonical event types (use existing naming where present; add `order.updated` / `position.updated` / `market.quote.updated` aliases where the spec requires them):

- Market: `TICK_RECEIVED`, `TICK_VALIDATED`, `TICK_REJECTED`, `MARKET_STATUS_CHANGED`, `market.quote.updated`, `market.depth.updated`
- Orders/positions: `ORDER_UPDATE`, `POSITION_UPDATE`, `ORDER_CREATED`, `ORDER_SUBMITTED`, `ORDER_REJECTED`, `ORDER_FILLED`, `ORDER_CANCELLED`, `ORDER_MODIFIED`, `POSITION_UPDATED`, `order.updated`, `position.updated`
- Risk/P&L: `RISK_UPDATED`, `MARGIN_UPDATED`, `POSITION_LIMIT_REACHED`, `pnl.updated`, `risk.updated`, `margin.updated`
- System: `WEBSOCKET_CONNECTED`, `ORDER_FEED_CONNECTED`, `CONNECTION_CONNECTED`, `SUBSCRIPTION_UPDATED`, `connection.updated`, `subscription.updated`, `notification.created`

WS#1 `TICK_VALIDATED` and WS#2 `ORDER_UPDATE`/`POSITION_UPDATE` are the only sources of those buses (via `ws_manager` publish hook → `WebSocketEngine` drain queue → `EngineEventBus.publish`). `Connection Manager` drains consumer queues + `state_store`/`event_bus` bridge queues and envelopes frames for WS#3. `DB Writer` is a `DATA_SAVER` consumer drained by `Connection Manager` → `db_writer_engine` (no direct `WebSocketEngine → MongoDB` path).

## 8.9 Daily Full-Market Subscription

```
Kotak / NSE Instrument Master
  ↓
Market Watch Engine (eligible universe, ranking, pins, live state)
  ↓ daily intent
Session Manager (current-day desired set, revision, validity, broker-subscription mirror)
  ↓
Subscription Registry (merge / dedup / feed-level resolution / broker diff)
  ↓
WebSocket Engine (orchestration, reconcile, validation / normalization)
  ↓
WebSocketManager
  ↓ WS#1
Kotak SFeed
```

On trading-day open: Market Watch builds eligible universe → Session Manager stores dated desired set → Registry merges pins + Session Manager `session_manager` consumer intents + `market_watch` consumer intents, dedups by `exchange_segment|instrument_token`, resolves `L4/L8/L16/INDEX` → WebSocket Engine `broker_diff` → WebSocketManager `subscribe()` → broker ACK `mark_broker_subscribed` + `mark_revision_applied` → ticks → `TICK_VALIDATED` → Event Bus → consumers. Expired/inactive rows go to `to_unsub` and leave the feed.

On reconnect: `_supervisor_restore_subscriptions()` rebuilds registry from Session Manager first (`_reload_subscriptions_from_session_manager()`), with MongoDB `stocks` as final fallback only when `daily_universe_desired==0` (pre-intent legacy path). The full current-day eligible universe is restored, never silently fallen back to `db.stocks`-only. `DEFAULT_DEGRADED_SEC` / `DEFAULT_STALE_SEC` gating uses `rt_int("ws_stale_feed_sec")` so settings affect live liveness.

## 8.10 Connection Manager vs WebSocket Engine

| Component | Owns | Direction | Input | Output |
|---|---|---|---|---|
| `WebSocketEngine` + `WebSocketManager` | Broker market-data lifecycle, reconciliation, validation/normalization, publishing | Kotak → Backend | `SFeedWebSocket` bytes | `EngineEventBus` + `TickRouter` per-consumer queues |
| `OrderFeedManager` | Broker order/position lifecycle, normalization, publishing | Kotak → Backend | `OrderFeedWebSocket` (`OrderUpdate`/`PositionUpdate`) | `EngineEventBus` + `ConnectionEngine._broadcast_frame` → orders/positions |
| `Connection Engine` (`connection_engine`) | Frontend session registry, fan-out, coalescing, backpressure, field projection, state bridge, persistence drain, WS#3 + WS#4 transport | Backend ⇄ Frontend | `EngineEventBus` / `TickRouter` + `state_store`/`event_bus` + `WS#4` commands | WS#3 envelope stream + `WS#4` acks → Frontend; `DB Writer` via `DATA_SAVER` drain |

`Connection Manager` never calculates risk/margin, never places orders directly, never owns broker feeds.

## 8.11 Snapshot + Realtime + Reconnect

| Channel | Disconnect → Reconnect |
|---|---|
| **WS#1** | `WebSocketManager` supervisor `_supervisor_restore_subscriptions()` → Session Manager desired set → Registry → Engine reconcile → Kotak subscribe → ACK → ticks resume → `on_subscriptions_ready` |
| **WS#2** | `OrderFeedManager` `_handle_disconnect()` → `RECONNECTING` with jitter delay (bounded by `ws_max_reconnect_attempts`) → `connect()` → `_build_auth_payload` → `OrderUpdate`/`PositionUpdate` resume → REST reconciliation (`positions()` / `order_report()`) for missed catch-up |
| **WS#3** | Frontend `RealtimeClient` backoff (1s → 15s + jitter, max 8 consecutive failures) → `fetchGatewayToken()` → `wss://.../ws/realtime?token=` → `welcome` → re-`subscribe` all `knownSubsRef` channels + `requestSnapshot()` → re-auth → `state_changed` |
| **WS#4** | Same socket as WS#3; re-authenticated together; commands are idempotent via `correlation_id` and `request_id`; failed broker actions retry only per safe idempotency (never blindly retry `place_order`) |
| **REST** | Single-flight `broker_cache` (TTL 5s, cooldown 15s) dedups quote/order/positions polling; mutating actions use `_ACTION_TIMEOUT` (8s) + HTTP 504 on hang |

## 8.12 Security

- Broker credentials (`consumer_key`, `mobile_number`, `totp_secret`, `mpin`, `edit_token`, `edit_sid`, `trade_token`, `view_token`) never leave `python-service/auth/kotak_client.py` + `neo_api_client.configuration`. Frontend never receives them (verified: no `kotak`, `create_websocket`, `create_order_feed`, credential string in `components/`, `hooks/`, `lib/` frontend code except via backend token).
- `WS#3` + `WS#4` require `APP_PASSWORD` → `JWT` (`services.jwt_auth`) when `settings.app_password` is set; `GET /api/realtime/token` issues per-operator JWT, `WS /ws/realtime?token=` verifies it and closes with 4401 on failure. Anonymous accepted only when `APP_PASSWORD` is empty (local single-operator dev).
- `Order Engine` places behind `Risk Engine` (validations: symbol/qty, orderType/product capability, SL trigger, per-order value cap, margin gate, duplicate suppression) → `Audit Engine` (`record_decision` + `record_action`) with `correlation_id` → `Broker Terminal`. `_recent_orders` ring provides duplicate suppression within `5s` window.
- All `OrderUpdate` / `PositionUpdate` carry broker-side authoritative fields; frontend shows `CLOSED` only on backend confirmation.

## 8.13 End-to-End Flows (target)

**Market:**
```
KOTAK SFeed → WS#1 → WebSocketManager → WebSocketEngine (validate/normalize) → EngineEventBus
  ├── Market Watch / Feature Engine → (Feature → Connection Manager)
  └── Connection Manager → WS#3 → Frontend
       + Data Saver → DB Writer → Mongo / tick_buffer
```

**Order placement:**
```
Frontend
  ↓ WS#4 (place_order) or REST POST /api/trading/order/place
Connection Manager / API
  ↓
Order Engine → Risk Engine → Margin Engine → Audit Engine → Broker Terminal → Kotak REST (place_order)
  ↓
Kotak → WS#2 OrderUpdate → EngineEventBus → Order Engine / Risk / Audit → Connection Manager → WS#3 → Frontend
  + REST fallback poll (order_report / trade_report) on missed/reconnect
```

**Position / P&L:**
```
Kotak WS#2 PositionUpdate + Kotak WS#1 LTP
  ↓
Risk / Position State (netQty/avg/unreal/MTM, realized from REST positions())
  ↓ EngineEventBus
Connection Manager → WS#3 → Frontend Position Page
  + periodic REST positions() as broker-confirmed authoritative values
  + Indicative P&L derived backend-side (never claimed as direct WS field)
```

## 8.14 REST ↔ WebSocket Together

Page load: `REST bootstrap/search/snapshot + WS#3 realtime deltas`  
Order submission: `WS#4 (or REST POST) → Broker REST → WS#2 event → WS#3 update`  
The backend remains the authoritative trading state; frontend patches `instrumentSelectionState / quoteState / orderDraftState / riskState / marginState / executionState / positionState / connectionState` with latest-value merge.

---
*Based on `docs/architecture/WebSocket_ConnectionManager_Flow.md` and verified against `python-service/ws_socket/ws_manager.py`, `ws_socket/order_feed_manager.py`, `ws_socket/engine/engine.py`, `connection_engine/connection_engine.py`, `api/ws_gateway.py`, `services/engine_event_bus.py`, `services/state_store.py`, `core/engines/order_engine.py`, `services/session/session_manager.py`, `services/market_watch_engine.py`, `lib/realtime-ws.ts`, `components/frontend-realtime-provider.tsx`.*
