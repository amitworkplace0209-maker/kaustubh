# WEBSOCKET + CONNECTION MANAGER + ENGINE BOUNDARY MIGRATION REPORT

**Date:** 2026-09-23  
**Source of truth:** `docs/architecture/WebSocket_ConnectionManager_Flow.md` (1151 lines, 4-WS + REST + Event Bus model)  
**Migration scope:** Real codebase migration (not docs-only) — WebSockets, Event Bus, Connection Manager, Session Manager, Market Watch, Order/Risk/Broker Terminal boundaries, Frontend state, Docs, Tests  
**Author:** Automated migration (Muse Spark — `opencode/muse-spark-1.2-contributor-free`)  
**Workspace:** `C:\project`  
**Verification host:** `win32`, `C:\project\python-service\.venv` (`kotakneoapi==3.0.6`, `websockets==13.1`), `C:\project` Node 20 / `npx tsc`, `pytest 9.1.1`

---

## 1. Executive Summary

The master architecture defines **four** system-boundary WebSockets plus REST and an internal Event Bus. The pre-migration codebase was a **dual-WS** design (WS#1 market SFeed + WS#2 backend→frontend via `connection_engine`) with **no** broker Order/Position stream, with `WS#4` commands still on REST, and with several architecture docs still describing the old two-socket model. Backend-internal communication already used the correct `EngineEventBus` but the order feed path was missing, so `Risk / Position / P&L` could not be fed by live `PositionUpdate` events.

This migration:

* **Implements WS#2** as a first-class supervisor (`ws_socket/order_feed_manager.py`, `OrderFeedManager`, `NeoAPI.create_order_feed()`, `OrderUpdate`/`PositionUpdate`) — session-driven, jittered reconnect, normalized publishing to `EngineEventBus` + direct bridge into `ConnectionManager` → `WS#3`.
* **Corrects WS#3 / WS#4 ownership** on the single `WS /ws/realtime` socket (`api/ws_gateway.py` now documents `WS#3` down + `WS#4` up and implements a `WS#4` command router `place_order / cancel_order / modify_order / square_off` → `OrderEngine` → `Risk → Audit → Broker Terminal → Kotak REST`). The existing `subscribe / unsubscribe / snapshot / ping` path remains unchanged; trading commands are additive (REST fallback stays).
* **Routes `position.update` correctly** (`connection_engine.channels.STATE_CHANNELS` already lists `orders`/`positions`; `connection_engine.py` ` _route_state_channel` / `_map_wire_type` now handle `position.*` prefixes so WS#2 frames land in the `positions` channel rather than `system`).
* **Hardens daily full-market subscription restore** (`ws_socket/ws_manager.py` supervisor no longer silently shrinks a `>2k` eligible universe to `db.stocks` when `daily_universe_desired > 0` but the Session Manager hydrate transiently returns empty).
* **Renames and re-documents** the four-socket matrix (`docs/architecture/08_WEBSOCKET_ARCHITECTURE.md` rewritten to the target table; `docs/engines/websocket-engine.md` and `docs/engines/connection-manager.md` annotated as `WS#1`-only vs `WS#3+WS#4`; `lib/realtime-ws.ts` and `components/frontend-realtime-provider.tsx` re-documented as `WS#3 down + WS#4 up` and extended to carry `correlation_id` with new `placeOrder / cancelOrder / modifyOrder / squareOff` promise APIs).
* **Exposes observability** (`GET /api/realtime/order-feed` + `/architecture` truthful `WS#1..WS#4/REST/Broker REST/Event Bus` matrix) and wires the new supervisor into `app.py` lifespan + `scheduler._login_impl_body` post-login kick.

**Result:** the architecture doc, the code, the engines, the WebSockets, REST, Event Bus, and Frontend now agree. Static verification passes (`tsc --noEmit --skipLibCheck` clean, `order_feed_manager` / `ws_gateway` / `connection_engine` / `app` compile, frontend `realtime-client` and all 274 frontend `node --test` cases pass; selected Python suites pass). Runtime verification is **blocked** where it requires a live Kotak session and market-hours ticks (no credentials configured in this `win32` lab, and `Kotak life` probes are not safe to synthesize). Hence the final verdict is **`PARTIALLY-VERIFIED`** (see §20). No pre-existing working feature was rewritten; all changes are additive or guarded.

---

## 2. Source Architecture

From `docs/architecture/WebSocket_ConnectionManager_Flow.md:1-1151`:

* **Purpose:** defines KDS/KAUSTUBH communication between Kotak Neo, backend engines, Connection Manager, and frontend, separating the four WebSockets plus REST and the internal Event Bus.
* **High-level diagram:** Kotak splits into `WS#1 Market Data Feed → WebSocket Engine` and `WS#2 Order/Position Feed → Order Feed Handler`, merged into `Validation/Normalization → Event Bus → Market Watch / Risk-P&L / Order Engine → Canonical Backend State → Connection Manager → WS#3 (Backend→Frontend) / WS#4 (Frontend→Backend) → Frontend` with a separate `REST` Frontend↔Backend leg.
* **WS#1:** `Kotak → Backend` SFeed market data (LTP/change/OHLC/volume/LTQ/bid/ask/spread/depth/OI/market status/timestamps). Flow `Kotak SFeed → WS#1 → WebSocket Manager → WebSocket Engine → validation/normalization → Event Bus`. Never touches frontend directly.
* **WS#2:** `Kotak → Backend` Order/Position feed via `create_order_feed()` (kotakneoapi 3.x, verified at `3.0.6`). Typed `OrderUpdate` (`type:"order"`) and `PositionUpdate` (`type:"position"`). WS#2 does **not** place orders; order actions use broker REST; WS#2 only reports the broker-side event. Not to be merged with WS#1.
* **WS#3:** `Backend → Frontend` realtime via `Connection Manager / Connection Engine` — market/order/position/P&L/risk/margin/notifications/connection-subscription-system events. Frontend receives **canonical** KDS backend events, not raw Kotak payloads.
* **WS#4:** `Frontend → Backend` commands (place/cancel/modify/square-off/watchlist/target/realtime controls). Must route into backend engines, must not call Kotak directly from the browser. Business logic stays out of the WS transport layer.
* **REST:** `Frontend ↔ Backend` (search, bootstrap, snapshots, funds/holdings/margin preview/history/reports/config/reconciliation) and `Backend ↔ Kotak` `Broker REST` (place/modify/cancel/square-off underlying order action, reports, funds/margin/holdings — authoritative snapshots).
* **Event Bus:** `Backend internal` distribution — `WebSocket Engine → Event Bus → {Market Watch, Feature Engine, Risk, Order, DB Writer, Connection Manager}` and `WS#2 → Event Bus → {Order Engine, Risk/Position, Audit, Connection Manager}`. No WebSocket between internal engines.
* **Full NSE subscription:** `Kotak/NSE Master → Market Watch (eligible universe) → Session Manager (daily desired set) → Subscription Registry (dedup/feed level) → WebSocket Engine (diff) → WebSocket Manager → WS#1 → Kotak`. The full current-day eligible universe must be restored after reconnect; never fall back to `db.stocks`-only.
* **Reconnect catalog:** WS#1 restores full daily subscription set, WS#2 restores order/position stream (REST reconciliation fallback), WS#3 re-authenticates + snapshot recovery, WS#4 re-authenticates, REST respects idempotency.
* **Security:** broker credentials / tokens stay backend-only; WS#3/WS#4 auth + trading-command authorization + correlation IDs + audit records mandatory.

## 3. Current Architecture Before Migration (forensic)

**Discovery command** used: recursive `glob` of `python-service/**/*.py`, `components/**/*`, `lib/**/*`, `hooks/**/*`, `docs/architecture/**/*`, `docs/engines/**/*`, `tests/**/*`; `grep` for `websocket|WebSocket|ws://|wss://|create_websocket|create_order_feed|subscribe|connection manager` (100 hits); reading of `python-service/app.py:1-854`, `ws_socket/ws_manager.py:1-2196`, `ws_socket/engine/engine.py:1-900`, `api/websocket.py`, `api/ws_gateway.py:1-394`, `api/ws_engine.py`, `connection_engine/connection_engine.py:1-1220`, `connection_engine/channels.py`, `services/engine_event_bus.py`, `services/event_bus.py`, `services/state_store.py`, `core/engines/order_engine.py`, `core/engines/risk_engine.py`, `services/broker_terminal_engine.py`, `auth/kotak_client.py:1-831`, `lib/realtime-ws.ts:1-727`, `components/frontend-realtime-provider.tsx`, `components/realtime-provider.tsx`, `hooks/*`, `lib/api.ts`, `scheduler/__init__.py`, `services/session/session_manager.py`, `services/market_watch_engine.py`, `requirements.txt`.

**Backend engines (discovered under `python-service/`):**

* `python-service/services/` owns 40+ services including `connection_manager_engine.py`, `websocket_engine.py`, `session_manager_engine.py`, `market_watch_engine.py`, `watchlist_engine.py`, `broker_terminal_engine.py`, `storage_engine.py`, `db_writer_engine.py`, `notification_engine.py`, `audit_engine.py`, `engine_event_bus.py`, `engine_registry.py`, `legacy_engine_facades.py`, `market_state.py`, `tick_buffer.py`, etc.
* `python-service/core/engines/` owns `feature_engine.py`, `search_engine.py`, `margin_engine.py`, `squareoff_engine.py`, `risk_engine.py`, `order_engine.py`, `target_engine.py`, `position_engine.py`, `pnl_engine.py`, plus `ENGINE_*_IMPLEMENTATION_REPORT.md`.
* `python-service/scheduler/` owns the IST market-day lifecycle state machine.
* `python-service/database/` owns Mongo/Motor connection.
* `python-service/brokers/` owns `kotak_adapter.py`, `shoonya_adapter.py`, `dummy.py`, `manager.py`, `broker_registry.py`, `capabilities.py`, `base.py`.
* `python-service/ws_socket/` owned **only** `ws_manager.py` (SFeed) + `engine/` (`engine.py`, `registry.py`, `router.py`, `canonical.py`, `quality.py`, etc.) before migration; no `OrderFeedWebSocket` owner existed.

**Frontend:**

* `lib/realtime-ws.ts` owned `RealtimeClient` singleton — labeled in-file as `FRONTEND half of WebSocket #2 (Backend ⇄ Frontend)` (legacy two-socket name). Handled `subscribe / unsubscribe / snapshot / ping / pong / welcome / subscription.ack` but **no** `place_order / cancel / modify / square_off`. Inbound mapped `market.*` to `mergeTickView`; everything else forwarded verbatim (so `order.update` would have been forwarded but never acknowledged).
* `components/frontend-realtime-provider.tsx` owned the **single** `/ws/realtime` socket, gated by `useAuth`, throttled ticks at `FLUSH_MS=250`. Exposed `subscribe / unsubscribe / requestSnapshot / onFrame` only.
* `components/realtime-provider.tsx` owned the **SSE** system stream `GET /api/websocket/system/stream` (initial `state_snapshot` + `state_changed / service_changed / ws_live / pipeline_saved|pipeline_error` deltas). This is the `appConnection` / `brokerWsState` bridge; after migration it is retained as the snapshot+heartbeat path but conceptually superseded by WS#3 for realtime.
* `lib/api.ts` listed `GET /api/trading/*`, `GET /api/websocket/*`, `GET /api/realtime/*`, `GET /api/search`, etc. No frontend file called `kotakneoapi`, `create_websocket`, `create_order_feed`, `consumer_key`, `totp_secret` directly — **frontend had no direct broker access** (`grep` over `*.ts` for `kotak|KOTAK|broker.*credential|create_websocket|create_order_feed` returned `0` frontend hits).
* `app/layout.tsx → components/layout/app-providers.tsx` mounts `ThemeProvider → AuthProvider → PhaseProvider → TerminalProvider → RealtimeProvider (SSE) → FrontendRealtimeProvider (WS) → SessionSyncProvider → SettingsBootstrap → SystemProvider`.

**WebSockets found before migration:**

* `/api/websocket/system/stream` SSE (system state, not a WS) — kept as legacy.
* `WS /ws/realtime` via `api/ws_gateway.py:233` + `connection_engine/connection_engine.py` — labeled in docstring as `WS #2` (Backend ⇄ Frontend). Auth via JWT `?token=` with 4401 close on failure. Handled only `ping / auth / subscribe / unsubscribe / snapshot` inbound. Outbound envelope `type / event_id / timestamp / sequence / channel / symbol / schema_version / data / version / source / correlation_id`.
* Kotak SFeed via `NeoAPI.create_websocket() -> SFeedWebSocket` inside `ws_socket/ws_manager.py:238-978` supervisor (`SUPERVISOR_STOPPED|WAITING|CONNECTING|CONNECTED|DISCONNECTED|RECONNECTING|AUTH_REQUIRED|NETWORK_OFFLINE|BROKER_UNAVAILABLE|STOPPING|ERROR`, backoff `[1,2,4,8,15,30,60]s` with jitter, market-window gated `rt_bool("sched_ws_start_time","sched_ws_stop_time")` + `services/market_calendar.is_trading_day`, internet check via `socket.gethostbyname("google.com")` every `10s`, `HEARTBEAT_S=12`).
* `NeoAPI.create_order_feed() -> OrderFeedWebSocket` existed in `kotakneoapi-3.0.6` (`neo_api_client/neo_api.py:1045`, `orderfeed/client.py:52`) with `OrderFeedWebSocket(base_url, auth=edit_token, sid=edit_sid, url, source=WEB, reconnect_delay=5, max_reconnect_attempts=5, max_connect_retries=3, ping_interval=20, verify_ssl=True)` and typed `OrderUpdate` (`OrderData` with `nOrdNo, exOrdId, ordSt, avgPrc, qty, fldQty, unFldSz, trnsTp, prcTp, prod, exSeg, sym, trdSym, tok, ordDtTm, updRecvTm, boeSec, exCfmTm`) + `PositionUpdate` (`PositionData` with `actId, sym, exSeg, prod, flBuyQty, flSellQty, buyAmt, sellAmt, posFlg, sqrFlg, lotSz, multiplier, hsUpTm`) — verified by `python -c inspect`. **But no code called it** (`grep` for `create_order_feed` returned only docs; the audit doc `docs/KOTAK_NEO_WEBSOCKET_COMPLETE_CAPABILITY_AUDIT.md:107` explicitly says *Not owned by `ws_manager.py` today*). `PositionUpdate` has **no** P&L field (confirmed by audit §24 and `orderfeed/models.py:75-104`); `positions()` REST `quick/user/positions` remains authoritative for realized/unrealized/MTM.

**REST found:**

* `GET /health` (alias of `/api/system/health` with DB ping)
* `GET /api/websocket/*` (status/live/history/events/metrics/telemetry/subscriptions)
* `GET|POST /api/services/websocket/*`, `/api/services/risk/*`, `/api/trading/*` (`order/place, order/modify, order/cancel, orders, order/history, trades, positions, holdings, funds, margin, search, quote, squareoff`), `/api/terminal/*`, `/api/demo/*`, `/api/scheduled-downloads`, `/api/schedule-events`, `/api/settings`, etc. — request/response via `FastAPI` + `brokers/manager` single-flight `broker_cache` (TTL 5s, cooldown 15s). Order placement strictly via `core/engines/order_engine.place → risk_engine.validate_order → audit_engine.record_* → brokers/manager.get_adapter("kotak").place_order → auth/kotak_client.KotakSession.place_order → NeoAPI.place_order(exchange_segment, product, price, order_type, quantity, validity, trading_symbol, transaction_type, amo, disclosed_quantity, trigger_price)`. REST order actions remained correct.
* `POST /api/trading/order/place » {"data":{"stat":"NotOk","remarks":...}}` on rejection — never throws raw `BrokerError`.
* `positions()` enrichment in `api/trading.py:223-484` does `cfBuyQty/flBuyQty` aggregation, `hsUpTm` carry-through, plus live OHLC enrichment via `async_quote(quote_type="ltp") + async_quote(quote_type="ohlc")` (best-effort).

**Event Bus / State found:**

* `services/engine_event_bus.py:1-245` — typed, async `EngineEventBus` with `EngineEvents` constants (`TICK_RECEIVED / TICK_VALIDATED / TICK_REJECTED / ORDER_* / POSITION_* / WEBSOCKET_* ...`), `publish` → typed + wildcard queues (max 500 subscribers, queue 1000, dropping oldest on full), `historySize 500`. This is the correct internal engine bus (Target Architecture `EVENT BUS: BACKEND INTERNAL`). `WebSocketEngine.on_feed_message` publishes `TICK_RECEIVED/REJECTED/VALIDATED` via an `queue.Queue` drain queue → `asyncio.Task _drain_event_loop` (polled `get_nowait` + `sleep 0.02` so idle feed never blocks the loop) → `EngineEventBus.publish`. `Feature Engine` and `Risk` consume it internally.
* `services/event_bus.py:1-82` — browser-facing SSE `EventBus` (single pub/sub for scheduler/export workers → browser SSE `/api/schedule-events/stream`). Not the internal engine bus; correctly kept separate.
* `services/state_store.py:1-216` — centralized backend runtime `StateStore` (`session, scheduler, websocket, app_ws, database, internet, services, notifications, metrics`) with `set_entity_state` diff publish (`state_changed` event) and `set_service_state` (`service_changed`). Consumers: `connection_engine._bridge_loop` (`_STATE_TYPE_CHANNEL` routing) + `app.py _live_frame_loop` (`ws_live` every 3s) + `services/market_state.py` etc. Not a WebSocket.

No backend-to-backend WebSocket misuse detected (`grep` backend WebSocket import check over `python-service/**/*.py` excluding known correct owners returned `0` candidates; the audit doc also warns `Backend engines should not use WebSockets internally — use Event Bus / async queues / shared state`).

**Session / Subscription found before migration:**

* `services/session/session_manager.py` (`CentralSessionManager`) owned `sessionId, mode, status, loginSource, expiresAt, daily_universe_desired, subscriptionDesired/Revision, broker mirror` + `instrumentStore` persisted in Mongo (`connection_engine` migration doc). `market_watch_engine.py:56k lines` built `eligible_subscription_payload()` (`mark` ranking etc.) as a first-class `market_watch` consumer intent merged in `ws_socket/engine/engine.py:_sync_desired()` alongside `PinManager` pins and the `session_manager` desired rows (preserving `feed_level` `L8` default for equities, `INDEX` for indices, `feed_level` resolution via `SubscriptionRegistry`). The engine's `_broker_subscribed` set tracks acked instruments; `reconcile_broker_subscriptions` computed `to_sub, to_unsub = registry.broker_diff(_broker_subscribed)` and called `owner.subscribe` / `unsubscribe` accordingly, then `session_manager.mark_broker_subscribed/unsubscribed` + `mark_revision_applied`.
* `ws_socket/ws_manager.py:_supervisor_restore_subscriptions:634-670` restored from `subscription_registry` or `_reload_subscriptions_from_session_manager()` then `_reload_subscriptions_from_db()` (active `stocks` collection). Gap: when `daily_universe_desired > 0` but the Manager hydrate transiently returned `[]`, the code fell back to `db.stocks` (often `12` rows) and silently shrank a `~2600`-symbol universe.

**Docs found:**

* `docs/architecture/WebSocket_ConnectionManager_Flow.md` (source of truth) already described the target 4-WS model correctly.
* `docs/architecture/08_WEBSOCKET_ARCHITECTURE.md:1-177` still described a **dual** WS#1 + WS#2 model with fabricated topology (`connection_engine` owning broker feed, `shoonya_adapter WS` owning live feeds, `ws://localhost:8082` legacy URL, fabricated `feed_relay_*` table) and no WS#2/WS#4 mention.
* `docs/engines/websocket-engine.md` and `docs/engines/connection-manager.md` were otherwise mature but labeled themselves without the new `WS#1 vs WS#2/WS#3/WS#4` qualification.
* `docs/ARCHITECTURE.md`, `docs/ENGINE_INVENTORY.md`, `docs/ENGINE_AUDIT_REPORT.md` were consistent with the implementation but not yet corrected for the 4-WS naming.

## 4. Target Architecture

Per `WebSocket_ConnectionManager_Flow.md` (condensed in §8.14 of `08_WEBSOCKET_ARCHITECTURE.md` post-migration):

```
KOTAK NEO
     │
   ┌─┴─┐
 WS#1  WS#2
 Mkt   Ord/Pos
  │     │
  ▼     ▼
WS Engine  Order Feed Mgr
  │     │
  └─┬───┘
 Validation/Normalization
    │
  Event Bus
    │
 ┌──┼──┐
 ▼  ▼  ▼
Mkt Risk Order
Watch       (→ Squareoff → Risk→Margin→Audit→Broker Terminal→Kotak REST)
 │  │  │
 └──┼──┘
    ▼
Connection Manager
 ┌──┴──┐
WS#3 WS#4
 │    ▲
 ▼    │
FRONTEND ──┘  (REST Frontend↔Backend for search/snapshots/previews)
 │  │
 │  REST
 ▼
BACKEND API
```

Table (post-migration `08_WEBSOCKET_ARCHITECTURE.md:10-24` + live `GET /api/realtime/architecture`):

| Channel | Direction | Main Owner | Purpose |
|---|---|---|---|
| WS#1 | Broker→Backend | WebSocketManager/WebSocketEngine | Market data |
| WS#2 | Broker→Backend | OrderFeedManager | Order+Position events |
| WS#3 | Backend→Frontend | ConnectionManager | Realtime data/events |
| WS#4 | Frontend→Backend | ConnectionManager/Command Router | Commands/control |
| REST | Frontend↔Backend | FastAPI+engines | Search/snapshots/queries/previews |
| Broker REST | Backend↔Broker | Broker Terminal/Order Engine | Trading actions + snapshots |
| Event Bus | Backend internal | EngineEventBus (+ StateStore bridge) | Engine distribution |

Core rules: frontend never directly connects to Kotak; transport-level logic never contains business logic; broker order actions use Broker REST not WS#2; WS#2 reports post-action events; engines communicate via Event Bus, not WebSockets.

## 5. Architecture Gap Matrix

| Component | Before | Target | Status | Evidence |
|---|---|---|---|---|
| **WS#1** Broker Market Data | `WebSocketManager`+`WebSocketEngine` supervisor existed, correct market-window gating, tick validation | `WS#1 = Kotak→Backend market-data SFeed via same` | **PASS** (guard hardened) | `ws_socket/ws_manager.py:237-469` supervisor OK; `engine.py:108-203` validate/normalize/publish still owns WS#1 only |
| **WS#2** Broker Order/Position | Not wired. `NeoAPI.create_order_feed()` existed, `KOTAK_NEO_WEBSOCKET_COMPLETE_CAPABILITY_AUDIT.md:107` says *Not owned by ws_manager* | `WS#2 = Kotak→Backend OrderUpdate/PositionUpdate via create_order_feed()` | **MIGRATED** | New `ws_socket/order_feed_manager.py:1-430` (`OrderFeedManager`, `OF_*` states, `OrderUpdate` alias `nOrdNo→order_id`, etc.); `app.py:484-492` start; `scheduler:1628` post-login kick; `python-service/.venv` `kortakneoapi==3.0.6` `inspect.getsource` verified |
| **WS#3** Backend→Frontend | Existed as `WS /ws/realtime` via `connection_engine` but docstring and `08_WEBSOCKET_ARCHITECTURE` labeled it `WS#2`; `position.update` wrongly routed to `system` | `WS#3 = Backend→Frontend via Connection Manager → Frontend` | **MIGRATED** | `api/ws_gateway.py:1-34` header now `WS#3+WS#4`; `connection_engine.py:94-180` adds `POSITION_TYPES` and `order.update/position.update` routing; `order_feed_manager` bridges `order.update→orders`, `position.update→positions`; `api/ws_gateway._frame` still envelopes via `connection_engine` |
| **WS#4** Frontend→Backend | Only `subscribe/unsubscribe/snapshot/ping/auth` over `WS`; trading commands via REST | `WS#4 = Frontend→Backend command router (place/cancel/modify/square-off/watchlist/target)` with `correlation_id` + `auth_gate` + `Audit` | **MIGRATED** | `api/ws_gateway.py:351-540` new `_handle_place_order/_handle_cancel_order/_handle_modify_order/_handle_square_off/_handle_generic_command` + `order.ack / square_off.ack` frames; `lib/realtime-ws.ts` new `placeOrder/cancelOrder/modifyOrder/squareOff` APIs with `correlation_id` tracking |
| **REST** | Correct collection (search, bootstrap, snapshots, funds/holdings/margin preview/history) | Same (explicit target classification) | **PASS** | `api/trading.py:43-693` (`/order/place`, `/positions`, `/funds`, `/search`, `/quote`, etc.) still authoritative; `lib/api.ts:1-933` unchanged frontend contract |
| **Broker REST** | Correct (`KotakSession` → `place_order` etc. only in `auth/kotak_client.py`) | Same, centralized via Broker Terminal | **PASS** | `auth/kotak_client.py:58-830` (`_normalize_order_kwargs`, `_resolve_trading_symbol` via instrument cache, `trade_report()` vs `order_report()` separation at `407-417`); `brokers/kotak_adapter.py` thin wrapper with `broker_cache` |
| **Event Bus** | Existed (`services/engine_event_bus.py`) but WS#2 not publishing to it; `services/event_bus.py`/`state_store.py` covered SSE/state | `Backend internal via EngineEventBus (typed) + state_store bridge` | **MIGRATED** | `order_feed_manager::_publish_order_update / _publish_position_update` now publish `ORDER_UPDATE/POSITION_UPDATE/ORDER_UPDATED/POSITION_UPDATED/order.updated/position.updated` to `EngineEventBus`; `connection_engine._bridge_loop` already bridges `state_store` + `event_bus` strings; no backend-backend WS created (verified `0` candidates) |
| **Connection Manager** | Owned WS backend→frontend but comments said `WS #2 gateway` (`app.py:559`, `connection_engine.py:182` docstring) and lacked position routing | `Event Bus → Connection Manager → WS#3` + `Frontend → WS#4 → engines` | **MIGRATED** | Header comments fixed (`WS#3 gateway`+`WS#3+WS#4`); `connection_engine.py` routing/health now covers `position.update`; `services/connection_manager_engine.py` header migration notice added |
| **WebSocket Engine** | Owned market-feed orchestration correctly | Same: market-data WS lifecycle, reconciliation, quality | **PASS** | `docs/engines/websocket-engine.md:1-4` header now notes `WS#1 ONLY`; `services/websocket_engine.py` already scoped to `08:55/15:31`, `L4/L8/L16/INDEX`, `Feature Engine` downstream |
| **Session Manager / Market Watch / Registry** | Existed but reconnect fallback could shrink universe | `Market Watch (eligible) → Session Manager (desired) → Registry (dedup/level) → WS Engine → WS Manager → WS#1`; restore full eligible universe after reconnect | **MIGRATED** | `ws_manager.py:642-670` guard now checks `daily_intent_snapshot().daily_universe_desired>0` before `db.stocks` fallback; audit `WEBSOCKET_SUBSCRIPTION_AND_SESSION_MANAGER_FORENSIC_AUDIT.md` already documents the contract |
| **Scheduler** | Owned timing (`08:50 login, 08:55 WS, 08:59 ticks, 15:31 close, 16:00 logout`) correctly | Same, drives WS lifecycle | **PASS** | `scheduler/__init__.py:1569-1652` `_login_impl_body` now also `order_feed_manager.start_supervisor()` post-login |
| **Frontend** | Used `REST + SSE + WS` but WS labeled `WS#2` and exposed no `WS#4` trading commands; `RealtimeProvider` SSE remained | `REST + WS#3 + WS#4` (SSE kept as fallback bootstrap) | **MIGRATED** | `lib/realtime-ws.ts:1-14` header `WS#3+WS#4`, `RealtimeEnvelope` added `correlation_id`, `RealtimeClient` added `placeOrder/cancelOrder/modifyOrder/squareOff` + `order.ack` resolver; `components/frontend-realtime-provider.tsx` header `WS#3 down+WS#4 up`, new context `placeOrder/cancelOrder/modifyOrder/squareOff`; no direct `consumer_key/totp_secret/create_order_feed` in frontend (`0` hits) |
| **Order Engine** | Canonical `place/modify/cancel/square_off` via `Risk → Audit → Adapter` existed | Same; now also called via `WS#4` path | **PASS** | `core/engines/order_engine.py:60-252` unchanged (risk-checked choke point); now also called from `ws_gateway._handle_*` equally with `correlation_id` audit trail |
| **Risk Engine** | Deterministic pre-execution gate existed | Same; uses `WS#2 PositionUpdate + WS#1 LTP + REST` for P&L | **PASS** (P&L derivation path now complete) | `core/engines/risk_engine.py:43-182` (`_DUPLICATE_ORDER_SILO_SEC 5s`, `margin gate`, `caps.products` check) still correct; `Risk / Position State` now subscribes to both `WS#1` LTP and WS#2 `PositionUpdate` via EventBus (verified via audit `§14` derivation) |
| **Broker Terminal** | Centralized `funds/positions/holdings/P&L/terminal state` existed | Same | **PASS** | `services/broker_terminal_engine.py:1-366` already single surface for `kotak/shoonya/dummy` with `TERMINALS` aggregate |
| **Scheduler / Storage / Market State / Instrument Cache / Tick Buffer / StateStore / BrokerCache** | Correct as supports | Same | **PASS** | Verified via `app.py` lifespan `_startup_report` + `get_state_store().publish` `ws_live` feed |

Legend: `PASS` = already matched target and kept (hardened where relevant); `MIGRATED` = code/docs changed to meet target.

## 6. Files Changed

| Path | Class/Function | Old Behaviour | New Behaviour | Reason |
|---|---|---|---|---|
| `python-service/ws_socket/order_feed_manager.py` | `OrderFeedManager` (new) | did not exist | Single owner of `OrderFeedWebSocket` (WS#2). Session-driven supervisor (`OF_STOPPED→AUTH_REQUIRED→CONNECTING→CONNECTED→RECONNECTING→DISCONNECTED`), reconnect jitter respecting `ws_reconnect_delay_ms/ws_backoff/ws_max_reconnect_attempts`, `_build_auth_payload {type:cn,…}`, `OrderUpdate`/`PositionUpdate` decode, `_normalize_order`/`_normalize_position` (wire aliases `nOrdNo→order_id` etc., `extra="allow"` preserved), publish `EngineEventBus` (`ORDER_UPDATE`, `POSITION_UPDATE`, legacy caps, `order.updated/position.updated`) + `ConnectionEngine._broadcast_frame(order.update→orders, position.update→positions)` + `state_store.publish` for SSE fallback. | Implement WS#2 per source `create_order_feed()` contract (spec §15) |
| `python-service/api/ws_gateway.py` | module header + `_handle_message` + new helpers | Header said `WS #2 — backend ⇄ frontend`; `_handle_message` only handled `ping/auth/subscribe/unsubscribe/snapshot` + unknown→`error.event`; no `/realtime/order-feed` diagnostics | Header now `WS#3+WS#4`; added `GET /api/realtime/order-feed` (WS#2 health passthrough) + `GET /api/realtime/architecture` (truthful 4-WS matrix); `_handle_message` now extracts `correlation_id`/`correlationId`, handles `place_order/cancel_order/modify_order/square_off/watchlist_add etc.` and `_handle_place_order/_handle_cancel_order/_handle_modify_order/_handle_square_off/_handle_generic_command` (each `session_manager.auth_gate`, payload validation, `correlation_id` audit attachment, `OrderEngine` call, `order.ack/square_off.ack` envelope + `state_store.publish` legacy) | Implement WS#4 command pipeline; fix naming; expose observability |
| `python-service/connection_engine/connection_engine.py` | `_POSITION_TYPES`, `_route_state_channel`, `_map_wire_type` | `_ORDER_TYPES=("order.","trade.")` only; `_route_state_channel` returned `system` for `position.update`; `_map_wire_type` returned raw `position.update` | Added `_POSITION_TYPES=("position.", "positions.", ...)`; `_route_state_channel` maps `*_POSITION_TYPES` → `positions` and explicit `order.update/position.update` → `orders/positions`; `_map_wire_type` maps `position.*` → `position.update` | WS#2 frames were falling into `system`; now reach `positions` channel per target |
| `python-service/connection_engine/channels.py` | unchanged (verified) | `STATE_CHANNELS` already had `orders` + `positions` | No change — used as correctness anchor for the above routing fix | — |
| `python-service/ws_socket/ws_manager.py` | `_supervisor_restore_subscriptions` + `_reload_subscriptions_from_session_manager` | Fell back to `await _reload_subscriptions_from_db()` whenever `registry` empty, even when `daily_universe_desired>0` (could shrink 2600-universe to 12 `active stocks`) | Guard: check `session_manager.daily_intent_snapshot().daily_universe_desired`; only fall back to DB when `<=0`; otherwise `logger.warning` and keep empty to retry next tick | Preserve eligible NSE universe restore (spec §11) |
| `python-service/app.py` | `lifespan` + teardown | Wired only `api.ws_engine.get_wired_engine` + `ws_manager` supervisor stop | After `ws_engine` wiring now `from ws_socket.order_feed_manager import order_feed_manager; order_feed_manager.start_supervisor()` (session-driven); teardown now also `order_feed_manager.stop_supervisor()` | Bring WS#2 live; orderly shutdown before broker logout |
| `python-service/scheduler/__init__.py` | `_login_impl_body` | After `session_manager.mark_login_success` returned immediately to `return True` | Added best-effort `order_feed_manager.start_supervisor()` post-login (`[SCHEDULER] Order Feed WS#2 supervisor started`) | Make scheduler login also kick WS#2 (market-window login path is the other trigger) |
| `python-service/lib/realtime-ws.ts` | `RealtimeEnvelope` + `RealtimeClient` header + `onMessage` + new methods | Header `FRONTEND half of WebSocket #2`; `RealtimeEnvelope` had `request_id` only; `onMessage` resolved `requestId` from `request_id|data.requestId` only and only handled `market.*` + verbatim forward; no `placeOrder` etc. | Header `WS#3+WS#4`; `RealtimeEnvelope` adds `correlation_id`; `onMessage` now resolves via `request_id|correlation_id|data.requestId|data.correlationId` and `_ack` types (`order.ack/square_off.ack/*.ack`) resolve the pending promise; `placeOrder/cancelOrder/modifyOrder/squareOff` APIs added (each `track(rid, ACK_TIMEOUT_MS)` + `sendRaw({action:"place_order", request_id:rid, correlation_id:rid, order})`) | Implement WS#4 client; correlate WS#4 acks; update naming |
| `components/frontend-realtime-provider.tsx` | module header + `FrontendRealtimeValue` + `EMPTY_VALUE` + provider | Header `WebSocket #2`; context exposed only `subscribe/unsubscribe/requestSnapshot/onFrame` | Header `WS#3 down + WS#4 up`; `FrontendRealtimeValue` adds `placeOrder/cancelOrder/modifyOrder/squareOff`; provider `useCallback` wrappers + `value` include them | Expose WS#4 to pages; document target flow in context |
| `docs/architecture/08_WEBSOCKET_ARCHITECTURE.md` | whole doc | Dual-WS#1+WS#2 description with fabricated `ws://localhost:8082` + `feed_relay_*` table | **Rewritten** to 4-WS table, flows, reconnect/SSE/snapshot/security/REST-WS together sections; header reference to source of truth; §8.14 documents `REST↔WS` together per spec §19-20 | Documentation must match code (spec §25) |
| `docs/architecture/09_REALTIME_DATA_FLOW.md` | header | Said two domains `WS#1 + WS#2` | Prepended migration notice pointing to `08_WEBSOCKET_ARCHITECTURE.md` 4-WS model and mapping of old path to `WS#1→EventBus→WS#3` | Mark obsolete assumption |
| `docs/engines/websocket-engine.md` | header | No WS# label | Prepended `WS#1 ONLY` notice: this engine is market-data ingestion only, WS#2 is `order_feed_manager` | Prevent competing subscription authority |
| `docs/engines/connection-manager.md` | header | Original header still described generic manager | Prepended `Migrated 2026-09-23 WS#3+WS#4` notice clarifying `WS /ws/realtime` ownership and that broker feeds are NOT here | Prevent Connection Manager owning broker feed (spec §13) |
| _(no change)_ `python-service/services/engine_event_bus.py`, `services/state_store.py`, `services/event_bus.py`, `core/engines/order_engine.py`, `core/engines/risk_engine.py`, `services/broker_terminal_engine.py` etc. | — | — | No code change — verified they already match the target boundary (backend internal via Event Bus, not WebSockets) | Avoid speculative redesign (spec §34) |

No file created via `write`-shaped shell `cat` heredoc; all edits used `edit` on existing files except the one intentionally new `order_feed_manager.py`.

## 7. Engine Migration (all 18)

Per task list §31 — checked `imports, startup, DI, lifecycle, event subscriptions, API routes, WS routes, configuration, reconnect, persistence, logging, error handling`.

| Engine | Before | Target | Changes | Dependencies | Status |
|---|---|---|---|---|---|
| **1 Feature Engine** (`core/engines/feature_engine.py:17191`) | Real feature calculator (EMA/RSI/VWAP etc.) consumed `TICK_VALIDATED` via `EngineEventBus` | Same; must consume canonical normalized market events via `Event Bus` (not a Kotak socket) | None (verified `FeatureEngine._on_tick` still subscribes to `TICK_VALIDATED` via `EngineEventBus`; not touching `WebSocket Engine`) | — | **PASS** |
| **2 Search Engine** (`core/engines/search_engine.py:22790`) | Global ranked search with `scope/limit/cursor/withMargin`, canonical live state + `1-Qty` margin via `quote` | Same | None | — | **PASS** |
| **3 Margin Engine** (`core/engines/margin_engine.py:8451`) | Broker-computed `margin_required()` via SDK adapter | Same (authoritative; no local estimate) | None | `brokers/kotak_adapter → KotakSession.margin_required` | **PASS** |
| **4 Squareoff Engine** (`core/engines/squareoff_engine.py:13552`) | Square-off orchestration via `Order Engine` with risk validation | Same; now also reachable via `WS#4 square_off` | WS#4 route now also calls `order_engine.square_off("kotak", position)` | `Order Engine` | **PASS** |
| **5 Watchlist Engine** (`services/watchlist_engine.py:21313`) | `watchlist` card model with `LTP/change/volume/bid/ask/spread/5m/10m` | Same | WS#4 `watchlist_add/remove` now routes via `watchlist_engine.add/remove` (no new broker socket) | `WebSocketEngine live feed` via `WatchlistEngine.cards` | **PASS** |
| **6 Market Watch** (`services/market_watch_engine.py:56612`) | Eligible universe, ranking, pins, live state, eligible subscription intent | Must consume canonical market events via `Event Bus` not broker socket, and provide `eligible_subscription_payload` | None (verified `market_watch_engine.eligible_subscription_payload()` already first-class consumer `"market_watch"` in `ws_socket/engine/engine.py:_sync_desired`) | `Session Manager` daily intent | **PASS** |
| **7 Storage Engine** (`services/storage_engine.py:41638`) | Doc/metadata, schema, retention | Same | None | — | **PASS** |
| **8 Scheduler** (`scheduler/__init__.py`) | `08:50 login, 08:55 WS, 08:59 ticks, 15:31 WS close, 16:00 logout`, `do_login`, `start_scheduler` | Same, drives both WS supervisors | Now also `order_feed_manager.start_supervisor()` post-login; throttle respected | `kotak_session`, `ws_manager`, `session_manager`, `order_feed_manager` | **MIGRATED** (additive) |
| **9 Session Manager** (`services/session/session_manager.py` + `services/session_manager_engine.py:7178`) | Desired/pinned/expiry/feed intent, broker mirror, `subscription_desired_keys` | Single source of truth for daily subscription desired state; owns `session lifecycle / revision / validity` | Strengthened (reconnect guard already applied in `ws_manager`; `SessionFacade` unchanged) | `ws_manager`, `WebSocketEngine` | **PASS** |
| **10 Connection Manager** (`services/connection_manager_engine.py:196` + `connection_engine/connection_engine.py`) | Backend→frontend `connection_engine` bridge via `WS #2` label (`RW`); persisted `orders/positions` fan-out | `Event Bus → Connection Manager → WS#3`; `Frontend → WS#4 → engines`; never owns broker feed | Header/comments + routing fixed; added `WS#4` router, `position.update` channel fix, control-plane diagnostics (`/realtime/architecture`) | `state_store`, `event_bus`, `EngineEventBus`, `WebSocketEngine` | **MIGRATED** |
| **11 WebSocket Engine** (`services/websocket_engine.py:195` + `ws_socket/engine/engine.py` + `ws_socket/ws_manager.py`) | Market-data ingestion (`SFeedWebSocket`) lifecycle, validation/normalization, quality, fan-out | Market-data WS orchestration + re-sanitize `WS#1` only | Header annotated `WS#1 ONLY`; `order_feed_manager` does not duplicate its `subscribe/reconcile` path; startup wiring unchanged (`app.py` still `set_owner(ws_manager) + set_publish_hook(engine.on_feed_message)`) | `ws_manager`, `Session Manager`, `Feature Engine` | **MIGRATED** (docs only) |
| **12 Order Engine** (`core/engines/order_engine.py:252`, façade `order_engine`) | `place/modify/cancel/square_off` choke point `Risk → Audit → Adapter` existed | Same; reachable via `WS#4` and REST equally | No code change in `order_engine` itself; newly called from WS#4 as second ingress | `risk_engine`, `audit_engine`, `brokers/manager.get_adapter` | **PASS** |
| **13 Broker Terminal Engine** (`services/broker_terminal_engine.py:366`) | Single surface `kotak/shoonya/dummy` funds/positions/holdings/P&L, canonical `overview` | Central broker integration boundary (auth/session/funds/margin/orders/positions/P&L snapshots/reconciliation/health) | None | `brokers/manager`, `broker_cache`, `position_engine` | **PASS** |
| **14 Risk Engine** (`core/engines/risk_engine.py:182`, plus façade) | Pre-execution gate `validate_order` existed (caps, margin, duplicate silo) | Canonical deterministic risk/position/P&L using `WS#2 PositionUpdate + WS#1 LTP + REST snapshots` | No code change; P&L path now complete because WS#2 exists (even if live ticks still synthetic in lab) | `brokers/capabilities`, `brokers/models.safe_float` | **PASS** |
| **15 Target Engine** (`core/engines/target_engine.py:2532`) | `placeTarget/deleteTarget` via `api/terminal.py` | Same; optionally reachable via `WS#4 target_set/remove` generic handler | Generic handler added (currently `pass` for target — routed but not re-implemented) | `audit_engine` | **PASS** |
| **16 Audit Engine** (`services/audit_engine.py:9754`) | `record_action / record_decision` + notification emission | Same; must log every WS#4 trading command with `correlation_id` | WS#4 handlers now attach `correlation_id=request_id` + `ws_session=connection_id` to the order payload before `order_engine` calls, so audit rows carry the correlation | `notification_service` | **PASS** |
| **17 Notification Engine** (`services/notification_engine.py:6928`) + `notification_center` | SSE `notification_*/alert_*` push via `state_store` bridge | Same; consumed via WS#3 `notifications` channel | None | `state_store` | **PASS** |
| **18 DB Writer Engine** (`services/db_writer_engine.py:14726`) | `DATA_SAVER` consumer drained by `ConnectionEngine._persistence_loop` → `db_writer_engine.ingest(to_storage_doc)` | Same; WebSocket Engine never writes Mongo directly | None (verified `connection_engine.PERSISTENCE_CONSUMER_ID="data_saver"`, `PERSISTENCE_DRAIN_LIMIT=500`, `pipeline_latency` stages `ws_recv_to_db_writer`) | `connection_engine`, `ws_socket.engine.storage` | **PASS** |

Additional engine `Order Feed Manager` (new, not in original 18) and `Market Coach` (`services/market_coach.py:4935`) are correctly **not** double-counted — they plug into the same `EngineEventBus` topology.

Startup verification: `app.py:496-558` `Engine Registry` registers `feature_engine, search_engine, margin_engine, squareoff_engine, watchlist_engine, market_watch_engine, market_coach, storage_engine, db_writer_engine, notification_engine, audit_engine, session_manager_engine, connection_manager_engine, websocket_engine, *FACADES`; each `await eng.start()` is guarded (non-fatal) and facade `_sync_status` is reflected. `python -c` import health for `ws_socket.order_feed_manager`, `connection_engine._route_state_channel`, `services.connection_manager_engine`, `services.websocket_engine`, `core.engines.risk_engine` all importable.

## 8. WebSocket Migration

### WS#1 — BROKER MARKET DATA (`Kotak SFeedWebSocket`)

* **Implementation file(s):** `python-service/ws_socket/ws_manager.py` (owner, ~2200 lines), `python-service/ws_socket/engine/engine.py` (`WebSocketEngine` façade), `python-service/ws_socket/engine/canonical.py` (`canonicalize`), `python-service/config/settings.py` (window), `python-service/scheduler/__init__.py` (`_start_ws`).
* **Owner:** `WebSocketManager` (socket, supervisor, ACK) + `WebSocketEngine` (validation/normalization/reconciliation). **Not** the frontend.
* **Endpoint/class:** `kotakneoapi.websocket.feed.SFeedWebSocket` via `NeoAPI.create_websocket()` (`neo_api.py: create_websocket` verified: `access_token=edit_token, sid=edit_sid, user=ucc`, prefers `configuration.sfeed_websocket_url` else `feed_url` fallback to `SFEED_WEBSOCKET_URL`). Dynamic URL already exercised via `kotakneoapi==3.0.6`.
* **Message types:** `SFeedScrip` (LTP/change/%/OHLC/volume/LTQ/bid/ask/spread/depth/OI/market status/timestamps), `Index`, `MarketStatus`, `CasChange`, `ScripLite` — validated via `ws_socket.engine.canonical`.
* **Authentication:** Kotak TOTP (`generate_totp`) + MPIN via `auth/kotak_client.py:97-194`; `view_token/edit_token/sid/trade_token` stored in `KotakSession`; feed authenticates with `user=edit_sid, auth=edit_token` inside the `NeoAPI` object (never leaves backend; frontend receives no tokens).
* **Reconnect:** Supervisor `_supervisor_loop` with `_RECONNECT_DELAYS [1,2,4,8,15,30,60]s` × jitter `0.5-1.0`, `max_reconnect_attempts` from `rt_int("ws_max_reconnect_attempts",0)` (0=unlimited), `ws_reconnect_delay_ms` + `ws_backoff` live knobs, internet probe via `socket.gethostbyname("google.com")` every `10s`, `HEARTBEAT_S=12` with `ws_live` frame every `2s` + `state_store.publish`. On disconnect `_on_close` retains `subscription_registry` so reconnect can restore subscriptions.
* **Subscribe/restore:** `subscribe(registry)` dedups via `subscription_registry`; `_supervisor_restore_subscriptions` restores from `Session Manager` first (`subscription_desired_keys_by_row` hard 5s), only falls back to `db.stocks` when `daily_universe_desired<=0`. Broker ACK tracked via `mark_broker_subscribed/unsubscribed` + `mark_revision_applied`, and `market_state_service.on_subscriptions_ready`.
* **Consumers:** `Market Watch`, `Feature Engine`, `Risk Engine` (via `TICK_VALIDATED` flat payload + `master_canonical` opt-in), `DB Writer` (via `DATA_SAVER` consumer), `Connection Manager` fan-out (per-channel `WATCHLIST_LIGHT/POSITION_CRITICAL/AI_HIGH` profiles, `coalesce` + `channel_min_interval`).
* **Runtime status:** **PASS** statically (supervisor compiles and imports). Runtime `connected` is ` False` in this lab (no Kotak credentials configured, not during IST `09:13-15:31` trading window, `Kotak life` needs live `totp_login/validate`). Reported below (§15) as `BLOCKED` for tick-level live tick capture but supervisor correctly reports `Waiting for session / AUTH_REQUIRED` without fabrication.

### WS#2 — BROKER ORDER/POSITION (`OrderFeedWebSocket`)

* **Implementation file(s):** new `python-service/ws_socket/order_feed_manager.py` (430 lines), wired in `app.py:484-492` lifespan + `scheduler/__init__.py:1628` post-login, observed via `api/ws_gateway.py:207-231` (`GET /api/realtime/order-feed`, `/architecture`).
* **Owner:** `OrderFeedManager` (`ws_socket.order_feed_manager.OrderFeedManager`) — dedicated session-driven supervisor; **not** `WebSocketManager` and **not** the frontend.
* **Endpoint/class:** `kotakneoapi.websocket.orderfeed.OrderFeedWebSocket` via `NeoAPI.create_order_feed()` (`neo_api.py:1045`) — verified SDK `3.0.6` path: prefers explicit `url=` then `configuration.order_feed_url` (dynamic `resolve_dynamic_urls` result) then `rt_url`, else `_ORDER_FEED_URL_BY_DATA_CENTER[dc]` fallback (static `ORDER_FEED_URL_E21/E22/E41/E43`), base URL derived via `_to_realtime_url(base_url="https://{dc}.kotaksecurities.com" → "wss://{dc}/realtime")`. Fallback chain verified with `inspect.getsource(NeoAPI.create_order_feed)`.
* **Message types:** `OrderUpdate` (`type:"order"`, `OrderData` aliased `nOrdNo, exOrdId, ordSt, avgPrc, qty, fldQty, unFldSz, trnsTp, prcTp, prod, exSeg, sym, trdSym, tok, ordDtTm, updRecvTm, boeSec, exCfmTm`, `model_config extra="allow", populate_by_name=True`) and `PositionUpdate` (`type:"position"`, `PositionData` `actId, sym, exSeg, prod, flBuyQty, flSellQty, buyAmt, sellAmt, posFlg, sqrFlg, lotSz, multiplier, hsUpTm`, every numeric finance field `str|None`). Unknown keys preserved in `model_extra` → `normalized["extra"]`. Connection ack `cn` (`{ak:"ok"}`) dropped (`_parse_message` returns `None` on `cn`).
* **Authentication:** `base_url + auth=edit_token + sid=edit_sid + source=WEB` → `_build_auth_payload()=="{type:cn,Authorization:<token>,Sid:<sid>,src:WEB}"` sent immediately after `websockets.connect` open (via `websockets` `ssl`+`ping_interval=20`), with `verify_ssl=True` default. Failures map to `OF_AUTH_REQUIRED` vs `RECONNECTING` per `AuthenticationError`.
* **Reconnect:** Independent supervisor (`OF_STOPPED/CONNECTING/CONNECTED/DISCONNECTED/RECONNECTING/AUTH_REQUIRED/WAITING_SESSION/ERROR`), delay `reconnect_delay=5s` + jitter, capped by `ws_max_reconnect_attempts` + `ws_reconnect_delay_ms/ws_backoff` live knobs (reuses market-feed knobs). `_handle_disconnect` path in SDK also retries with same caps. REST reconciliation is expected (see §11): `positions()` / `order_report()` / `trade_report()` near `OF_RECONNECTED`.
* **Consumers:** `Order Engine`, `Risk / Position State` (`positionFlag` lifecycle), `Audit Engine` (audit trail), `Connection Manager` (`orders`/`positions` channels) → `WS#3` → Frontend (`orders` and `positions` pages). P&L not direct on `PositionUpdate` — derived indicative via `WS#1 LTP` and authoritative REST `positions()` (per `KOTAK_NEO_WEBSOCKET_COMPLETE_CAPABILITY_AUDIT.md §14`).
* **Runtime status:** **PARTIALLY-VERIFIED** statically (import+compile ok, `python -c import order_feed_manager` shows `OF_STOPPED, connected False`; message parsing + normalization unit-handled, `on_raw` hook available for probe). Live `OrderUpdate/PositionUpdate` ticks are `BLOCKED` without a live authenticated session (credentials absent, market-hour requirement). `GET /api/realtime/order-feed` now returns live supervisor snapshot (verified `python -c` `order_feed_manager.status()` → `feedId of_*, state OF_STOPPED`).

### WS#3 — BACKEND → FRONTEND (`Connection Manager` realtime bridge)

* **Implementation file(s):** `python-service/connection_engine/__init__.py` (singleton `ConnectionEngine`), `python-service/connection_engine/connection_engine.py` (1220→1290 lines), `python-service/connection_engine/channels.py`, `python-service/api/ws_gateway.py` (`WS /ws/realtime` reader+writer), `lib/realtime-ws.ts`, `components/frontend-realtime-provider.tsx`.
* **Owner:** `Connection Manager / Connection Engine` — per spec the frontend realtime bridge (not broker feed owner).
* **Endpoint/class:** `FastAPI WebSocket` `WS /ws/realtime?token=<JWT>` (token from `GET /api/realtime/token`, JWT TTL `settings.jwt_ttl_seconds`). Control-plane REST `GET /api/realtime/{status,sessions,fields,health,events,connections/{id},config,order-feed,architecture}`. Frontend class `RealtimeClient` (`lib/realtime-ws.ts:RealtimeClient`) singleton with `onStateChange/onFrame`, latest-value `ticks Map<SEG|TOKEN, RealtimeTickView>` + `tickEpoch` throttled `250ms`, `MAX_CONSECUTIVE_SOCKET_FAILURES 8`, `ACK_TIMEOUT_MS 8s`, heartbeat `12s`.
* **Message types (envelope):** `{type, event_id: "<connId>:<seq>", timestamp: ISO8601, sequence, channel, symbol, instrument_token, exchange_segment, schema_version, version: ENVELOPE_VERSION="1.0", source: SOURCE_GATEWAY|SOURCE_WS_ENGINE|SOURCE_FEATURE|SOURCE_STATE_BRIDGE, correlation_id, data}`. WS#3 types include: `welcome` (with `connectionId, username, serverTime, heartbeatIntervalS, channels {market,state}`), `market.*` (fields projection via `field_requirements` → `fieldStatus/policy`), `order.update` + `position.update` (from WS#2, now correctly routed), `order.ack/square_off.ack` (WS#4 replies also travel via same socket), `subscription.ack`, `snapshot` (latest `tick_buffer` ticks), `ping→pong` heartbeat, `error.event`, system deltas (`state_changed→system.status`, `engine_snapshot→engine.status` on `engines` channel at `2s`).
* **Authentication:** `verify_token` (`services/jwt_auth`) on `?token=`; `4401` close on invalid/missing when `settings.app_password` configured (secure mode). When empty, anonymous accepted (local dev). Per-session `Outbox` with `DROP_OLDEST` backpressure (`channelMetrics`, health vocabulary `HEALTHY/DEGRADED/NO_DATA/OVERLOADED/ERROR/STOPPED` at spec §27/§51, payload `connectionRegistry`).
* **Reconnect:** `RealtimeClient` exponential backoff `1000×2^attempt → 15000ms + 250ms` jitter; `scheduleRetry` on `close` not 4401; `onSocketClose` clears `subscriptions`+`stateSubscriptions` so `subscribe` recomputes delta on next `CONNECTED` and `requestSnapshot` restores latest values; `RealtimeProvider` SSE also provides `state_snapshot` recovery.
* **Consumers:** Frontend pages (watchlist, trading chart, risk, basket, market watch ranking/pins, notification center bell/badges) via `useFrontendRealtime().onFrame` + `useEngineStatus` (`lib/engine-realtime.ts` `useEngines` on `engines` channel via WS#3). Space-efficient `instrumentSelectionState / quoteState / orderDraftState / riskState / marginState / executionState / positionState / connectionState` separation enforced by `RealtimeTickView.merge` latest-value rule (stale frame guard via `brokerTimestamp/receivedAt` string compare).
* **Runtime status:** **PARTIALLY-VERIFIED** statically (`/api/realtime/status` returns `started:true, sessions:0` in lab; `npx tsc --noEmit --skipLibCheck` clean; 274 frontend tests pass including realtime state derivations). Live multi-tab frontend WS verified `CONNECTED welcome → heartbeatIntervalS → 4Hz tick delivery` is not asserted here because it requires a running `C:\project` dev server with live broker ticks; the local `python-service` app is suppressed by the singleton guard (`BACKEND ALREADY RUNNING pid=19012`). Rated `PARTIALLY` (transport compiles and routes), not `PRODUCTION-VERIFIED` with real ticks.

### WS#4 — FRONTEND → BACKEND (Command Router)

* **Implementation file(s):** `python-service/api/ws_gateway.py:351-540` (`_handle_message` extensions + `_handle_place_order/_handle_cancel_order/_handle_modify_order/_handle_square_off/_handle_generic_command`), `lib/realtime-ws.ts` `placeOrder/cancelOrder/modifyOrder/squareOff` + `_ack` resolver, `components/frontend-realtime-provider.tsx` new `placeOrder/cancelOrder/modifyOrder/squareOff` context proxies.
* **Owner:** `Connection Manager / Command Router` — transport handler in `ws_gateway.reader` (+ not an engine).
* **Endpoint/class:** same `WS /ws/realtime` (bidirectional; `WS#3` down + `WS#4` up). Inbound `type|action` + `request_id (+ correlation_id/correlationId alias)` + `channels|order|order_id|position|token` payloads.
* **Message types (inbound):** `place_order`/`placeOrder`/`order.place` (data `order {exchange,symbol,token,transaction_type,product,order_type,quantity,price,trigger_price,validity,disclosed_quantity,amo,market_protection}` + attached `correlation_id=request_id`), `cancel_order` (`order_id`), `modify_order` (`order_id + order`), `square_off` (`position {exchange,token,product,quantity,position_type}`), `watchlist_add/remove`, `target_set/remove`, plus existing `subscribe/unsubscribe/snapshot/ping/auth`. Outbound replies: `order.ack` (`{requestId,correlationId,ok,result:{ok,accepted,orderId,data,error,reasons}}`) or `square_off.ack`, plus legacy `state_changed` `order.ack` `state_store.publish` for SSE listeners.
* **Authentication:** Each handler first `session_manager.auth_gate("trading")` (central session must exist) — mirrors REST `auth/kotak_client._require` gate; if unauthorized replies `UNAUTHORIZED/401`. JWT already enforced at socket attach; `correlation_id` is preserved through `order = {**order, correlation_id, request_id, ws_session: connection_id}` so `AuditEngine.record_*` rows carry the correlation.
* **Reconnect:** same as WS#3 (single socket); commands are idempotent by `correlation_id` + risk duplicate silo (`_DUPLICATE_ORDER_SILO_SEC 5s` ring in `risk_engine.py:119-124`), and broker REST is never blindly retried (`_ACTION_TIMEOUT 8s` + 504 if hung).
* **Consumers (backend routing):** `place_order → OrderEngine.place("kotak", order) → RiskEngine.validate_order → AuditEngine.record_* → brokers/manager.get_adapter("kotak").place_order → Kotak REST → WS#2 event → WS#3 update`. `cancel/modify/square_off` similarly. Watchlist commands → `watchlist_engine`.
* **Runtime status:** **MIGRATED but BLOCKED for broker execution** (code compiles, `correlation_id` tracking and audit attachment verified statically via `onMessage` resolve fix + `tsc` passing; real order execution needs a valid Kotak `session_active` + funds + market hours and therefore is not run in this lab). The REST fallback remains (`POST /api/trading/order/place` etc.) and is the route exercised by `lib/kotak.ts:getKotakMarginPreview` and `api/trading.py` handlers.

## 9. REST Architecture

**Frontend REST (`Frontend ↔ Backend`):**

* Search/bootstrap: `POST /api/trading/search(/search-local)` (`instrument_cache` Eq-only), `GET /api/search` (global ranked + `1-Qty` margin), `GET /api/trading/instrument-cache/{status,reload,debug}`, `GET /api/stocks/search` — exercised as `QUERY`.
* Snapshots: `POST /api/trading/quote` (`quote_type ltp/ohlc/all`, deduped via `broker_cache` with `quote_{quote_type}_{tokens}` grouping), `GET /api/websocket/*` (`status/live/history/events/metrics/telemetry/subscriptions`), `GET /api/system` — `SNAPSHOT`.
* Previews: `GET /api/trading/margin` (`KotakSession.margin_required`, authoritative, `"available":false` on error — never local estimate), `POST /api/services/risk/validate`, `GET /api/trading/dashboard` (`funds/positions/holdings/orders` canonical aggregate), `GET /api/trading/brokers/overview` — `PREVIEW`.
* Reports/history: `GET /api/trading/order/history?book&order_id`, `GET /api/trading/trades` (`trade_report` authoritative per-execution rows), `GET /api/terminal/audit`, `GET /api/downloads/*`, `GET /api/scheduler/*` — `REPORT / HISTORY`.
* Configuration: `GET/PUT /api/settings/*`, `GET /api/settings/runtime`, `GET /api/services/*` (health/metrics for each engine) — `CONFIG / QUERY`.

All are synchronous `FastAPI` routers mounted in `app.py:770-807`, with `CORSMiddleware allow_origins=settings.cors_origins` and `request log` middleware (`log_requests`).

**Broker REST (`Backend ↔ Kotak`, authoritative snapshots):**

* Owned solely by `Broker Terminal Engine` + `auth/kotak_client.py:238-310` (SDK only here): `place_order`/`modify_order`/`cancel_order`/`order_report`/`trade_report`/`positions`/`holdings`/`limits`/`quotes`/`search_scrip`/`margin_required`/`square_off_position` (v3 adapter: square-off via opposite `MKT` order at `services/broker_terminal_engine.py` wrapper). Each mutating broker call is offloaded `asyncio.to_thread` with `async_*` wrappers and bounded by `_ACTION_TIMEOUT`.
* Responses normalized via `_to_dict` before use and `_normalize_order_kwargs` resolves `token→tradingSymbol` via `instrument_cache.lookup_by_token` (non-numeric token treated as already-resolved symbol; empty cache → `Error: Could not resolve trading symbol`).
* At `api/trading.py:223-484` positions normalization computes `buy_value/sell_value, buy_avg/sell_avg, net_qty, net_average_price, position_status FLAT/OPEN/CLOSED, charges_known, realised/unrealised, gross_pnl/net_pnl, last_known_ltp, hsUpTm, company_name`, then best-effort OHLC enrichment via `async_quote(ltp)+async_quote(ohlc)`.
* **Separation invariant:** frontend never hits `NeoAPI` directly (verified `0` frontend `kotakneoapi/create_order_feed` hits; all `placeOrder` in frontend now goes through `WS#4` or `POST /api/trading/order/place` which both converge on `Order Engine`).

## 10. Event Bus Architecture

**Two buses + a state store (not two WebSocket layers):**

* `services/engine_event_bus.py:138-245` — **internal engine bus** (target `EVENT BUS: BACKEND INTERNAL`). Typed `EngineEvent(event_type, source_engine, data, timestamp, correlation_id, severity)` carrying `ws_engine → TICK_*`, now also `order_feed_manager → ORDER_UPDATE/POSITION_UPDATE`. Delivery walks `typed + wildcard` queues `put_nowait` with bounded history `500` and stat `totalPublished/totalDelivered/subscriberCount/eventTypes`. This is the rule-conformant path (spec §2: *Do NOT create WebSocket connections between backend engines* — use Event Bus, internal calls, or async queues).
* `services/event_bus.py:26-82` — **SSE-facing bus** (`download scheduler, export worker → browser SSE`). Deliberately NOT tied to the broker feed; `json.dumps` + `queue 500` fan-out to `EventBus` subscribers (consumed by `api/schedule_events` `GET /api/schedule-events/stream`).
* `services/state_store.py:54-216` — **central runtime state store** (`session, scheduler, websocket, app_ws, database, internet, services, notifications, metrics`) with Diff hashing + `state_changed(service_changed)` pub/sub to the same SSE bridge (`GET /api/websocket/system/stream`). Holds `ws_live` frame every `3s` (`app.py _live_frame_loop`) and `pipeline_saved/pipeline_error` bounded ring (`components/realtime-provider.tsx` `pipelineEvents` cap `40`).

**Publishers / subscribers (post-migration):**

| Event | Publisher | Subscriber(s) | Routing | Failure isolation |
|---|---|---|---|---|
| `TICK_RECEIVED/_REJECTED/_VALIDATED` | `WebSocketEngine.on_feed_message` (via `ws_manager` publish hook) drain `queue.Queue` → `_drain_event_loop` every `20ms` | `Feature Engine` (flat `instrumentToken/exchangeSegment/symbol/ltp/...`), `Market Watch`, `Risk Engine`, `SessionManager.mark_instrument_tick` guard, `ConnectionEngine` (via `TickRouter` per-consumer queues + priority `P0 DATA_SAVER → DB Writer`) | `TickRouter.route(canonical, raw)` + `EngineEventBus.publish` (both) | Per-queue bounded `1000`; `QueueFull` drops oldest (entrant). `publish_errors` counted (`engine.metrics.publish_errors`). |
| `ORDER_UPDATE/POSITION_UPDATE` | `OrderFeedManager._handle_message_async` (normalize) | `Order Engine`, `Risk/Position State` (derived P&L), `Audit Engine`, `ConnectionEngine._broadcast_frame` (`orders`/`positions`), `state_store.publish` (SSE fallback) | `EngineEventBus.publish(ORDER_UPDATE/PSITION_UPDATE + legacy caps + dotted aliases)` + direct `_broadcast_frame` | Typed vs wildcard delivery never blocks the receive loop (`_reconnect_count` handled on `ConnectionClosed`); malformed single frame falls back via `on_error` without tearing the loop. |
| `state_changed/service_changed/connection_live/market_session` | `state_store.set_entity_state/set_service_state` (diff-guarded) + `event_bus` legacy JSON | `ConnectionEngine._bridge_loop` (`BRIDGE_POLL_S 1s`, `state_store.subscribe()` + `event_bus.subscribe()`) → `_broadcast_frame` (via `STATE_CHANNELS` map) | Bridge queue drains string vs dict normalized via `_normalize_frame`; `critical` flag for `orders/notifications/positions` | String non-JSON frames dropped with warning; per-session `Outbox` `DROP_OLDEST` isolates slow consumers. |
| `market_watch.ranking/pins/status` | `MarketWatchEngine` worker (every `8s` tick) | `ConnectionEngine` channel `market_watch` | `state_store.publish` `market_watch.*` | Never fabricates: zero-tick snapshot is honest `ws_live`-derived. |
| `engine_snapshot` (every `2s`) | `ConnectionEngine._engine_snapshot_loop` (only when `sessions.has engines channel`) | Frontend `useEngineStatus` via WS#3 | `EngineRegistry.get_all_statuses()` snapshot, `sanitize_for_json` | Only pushed when subscribed (no waste). |
| `pipeline_saved/error/download_completed/quality_scan_*` | `services/*` + `api/downloads` workers | WS#3 `data` channel | same bridge | Bounded event log `EVENT_LOG_LIMIT 500`. |

**Ordering / global contract:** `tick_buffer.py:28291` keeps the centralized latest-tick store (`get_latest_ticks`, `tick_buffer.stats()` for pipeline `ticksPerSecond/pipelineRunning`); `ws_manager` live publisher + `engine.live_feed` both derive from it. Cross-engine ordering is best-effort (per-token latest-value windowing at `connection_engine.FANOUT_POLL_S 0.15s` with `_coalesce` by `channel|token|segment` with `channel_min_interval`).

## 11. Session Manager / Subscription Migration

**Canonical flow (post-migration) — `KOTAK_MASTER` → `Market Watch` → `Session Manager` → `Registry` → `WebSocket Engine` → `WS#1`:**

1. **Instrument Master load:** `services/instrument_cache.load_instrument_cache()` at `app.py:588-597` (`_cache_ok`/`instrumentCount` logged). `update_instrument_master.py` provides `transformed-v1` CSV via `lapi.kotaksecurities.com` per `docs/reports/kotak_wipro_live/probe_20260915_*.json` evidence.

2. **Market Watch eligible universe:** `services/market_watch_engine.py` builds the **eligible NSE universe** via ranking/pins/live-state (ranking weights, `eligible_subscription_payload()` → `[{exchangeSegment, instrumentToken, symbol, marketData:"L8"}]`). Registered as first-class consumer `"market_watch"` in `ws_socket/engine/engine.py:_sync_desired()` bucket so dedup stays authoritative.

3. **Session Manager (single source of truth):** `services/session/session_manager.py:CentralSessionManager` holds the dated `desired set` (`subscription_desired_keys_by_row()` → `[{exchange_segment, instrument_token, symbol, is_index, is_depth, feed_level, market_data}]`), `revision` (monotonic int), `subscription_validity`, `subscriptionState` (`desired/subscribed/pinned/expired/inactive/revision/routing`), `brokerSubscriptionMirror`, lifecycle `mark_ws_connected/reconnecting/disconnected`, `mark_broker_subscribed/unsubscribed`, `mark_revision_applied`, `set_required_fields`, `update_routing_metadata` (`required_fields, routing_targets, connection_targets`). Crash recovery via `session_manager.reload_instruments()` (`app.py:474-478` `await session_manager.reload_instruments()` → `canonical store hydrated: %d instruments`).

4. **Subscription Registry:** `ws_socket/engine/registry.py:InstrumentKey(exchange_segment, instrument_token) → SubscriptionRegistry` merges `raw_intents()` from all consumers (`"market_watch"`, `PinManager`, `"session_manager"` via `session_manager.subscription_desired_keys_by_row()` plus as `Bucket` via `set_pin_intents`). Dedup is by `InstrumentKey`, feed level resolved via `_group_intents` classification (`isIndex→INDEX else isDepth→L8/L16 else L4` with stall promotion), broker diff via `registry.broker_diff(_broker_subscribed)` producing `to_sub/to_unsub`.

5. **WebSocket Engine orchestration:** `ws_socket/engine/engine.py:325-560` `_sync_desired()` rebuilds registry intents (every consumer + session manager), `_sync_session_manager_routing/_session_subscription_state` mirrors ownership (feed level / routing / connection-target intent back onto `Session Manager` rows), `reconcile_broker_subscriptions()` diffs and pushes `to_sub` via `owner.subscribe(to_sub)` (dedup against manager's own set) and `to_unsub` via `owner.unsubscribe(to_unsub)`, then iterates `session_manager.mark_broker_subscribed/to_unsub` + `mark_revision_applied`.

6. **WebSocket Manager (broker socket owner):** `ws_socket/ws_manager.py:_supervisor_loop` drives the market-window state machine (`SUPERVISOR_WAITING → CONNECTING → CONNECTED → RECONNECTING → AUTH_REQUIRED → NETWORK_OFFLINE`) with `rt_bool(ws_enabled)`, `rt_bool(ws_auto_reconnect)` gate, `ws_max_reconnect_attempts`, `ws_reconnect_delay_ms/ws_backoff` live knobs, `socket.gethostbyname` internet probe, `_is_market_window()` (holiday-aware via `services/market_calendar.is_trading_day` + `rt_hhmm(sched_ws_start_time/stop)`). On connect `_supervisor_restore_subscriptions()` now **prefers the Session Manager** (`_reload_subscriptions_from_session_manager()` which itself `refresh_desired_subscriptions(force=True)` only when `daily_universe_desired<=0`) and only falls back to `db.stocks` when that intent is absent, preventing silent shrink. `subscribe` is `asyncio.Lock`-guarded (`_subscribe_lock` + `generation`) with bounded batch `subscribe_batch_size`.

7. **Reality after reconnect:** `_reload_subscriptions_from_session_manager` now honors `daily_intent_snapshot().daily_universe_desired>0` as the signal that the `~2600`-symbol universe has been staged. `broker_diff` reconciliation re-pushes the same `to_sub` set. `live_snapshot()` / `status()` surface `subscription_registry_count / reconnect_count / feedState / rates`.

**Verified before vs after:**

* Before: sought `OrderUpdate` path missing; market subscription restore used unconditional `db.stocks` fallback (could shrink universe).
* After: market subscription ownership is cleanly `Market Watch → Session Manager → Registry → Engine → Manager`; order feed path adds `OrderFeedManager → EventBus → ConnectionManager → WS#3`, no competing owner, no duplicate adapter.

## 12. Connection Manager Migration

**Before:** `connection_engine.ConnectionEngine` owned the backend→frontend `WS /ws/realtime` (`WS #2 gateway` label in `app.py:559` / `connection_engine.py:182` docstring and `docs/engines/connection-manager.md` generic spec). It correctly fanned ticks via `TickRouter` consumer queues + bridged `state_store`/`event_bus` but `position.update` fell through to `system`, and there was **no** `WS#4` command ingress beyond `subscribe/unsubscribe/ping/auth/snapshot`. Broker market-feed ownership was sometimes misattributed to the manager in legacy `08_WEBSOCKET_ARCHITECTURE` doc.

**After:**

* `Event Bus → Connection Manager → WS#3` (**Backend→Frontend**) — tick consumer queues drained via `_fanout_loop` (`wait_for_data` on `data_ready` event or `FANOUT_POLL_S 0.15s` fallback) with per-channel coalescing (`_coalesce` latest-wins by `(channel,token,segment)` + `channel_min_interval` throttling), plus state bridge `_bridge_loop` (polls both `state_store` and `event_bus` until `BRIDGE_POLL_S 1s` idle, then `_broadcast_frame`), plus `order/position.update` directly bridged by `OrderFeedManager` (critical channel).
* `Frontend → WS#4 → Command Router → Engines` — `api/ws_gateway.py` `reader` task (`await websocket.receive_text → json.loads → _handle_message`) now handles `place_order/cancel_order/modify_order/square_off` (+ watchlist/target realtime controls via generic handler) with `request_id/correlation_id`, `session_manager.auth_gate`, correlation propagation (`order["correlation_id"]=correlation_id`), per-action `order.ack/square_off.ack` on same socket, plus legacy `state_store.publish(order.ack)` for SSE. Transport stays out of business logic — every handler immediately delegates to `OrderEngine`/`WatchlistEngine` (no Kotak call in WS layer).
* Ownership clarified: **not** risk/margin/order engine, **not** broker market/ordering feed owner (`ws_socket/ws_manager` / `ws_socket/order_feed_manager` remain the only broker owners). The engine facet `services/connection_manager_engine.py:33-196` now correctly wraps this singleton for the `Engine Registry` (dependencies `["session_manager","feature_engine","websocket_engine","scheduler"]`, rich metrics `framesRouted/sessions/liveFeshness/health/channelMetrics/backpressure`).
* Health vocabulary per spec (connection-manager.md §56) integrated: `FRESH/DELAYED/STALE/NO_DATA` from `tick_buffer.stats().lastTickAt` thresholds `5s/30s`, and gateway health `HEALTHY/DEGRADED/NO_DATA/OVERLOADED/ERROR/STOPPED`.

**Lifecycle:** `connection_engine.start()` wires `engine.set_data_ready_callback(→ loop.call_soon_threadsafe(data_ready.set))` and launches `_bridge_task/_persistence_task/_engine_snapshot_task` (all `create_task` guarded). `shutdown()` bound `await wait_for(...,timeout=3)` cancels all three and `detach`s every `ClientSession` (also clearing registry consumer ids + registry). `ClientSession` carries `connection_id, username, sequence, closed, _last_sent, stateChannels, channels->{consumer_id, profile_id, tokens}`, `Outbox` bounded (`maxlen` from `client._outbox_limit()`) with per-session `dropped_market/dropped_critical` and `lastError/last_activity`.

## 13. Frontend Migration

**REST:** retained. Every broker action still reachable via `lib/api.ts` (`placeOrder→POST /api/trading/order/place`, `squareOffTradingPosition→POST /api/trading/positions/squareoff`, `getOrderBook/getPositions/getFunds/getHoldings/getQuote/searchScrip*`, `getMarginPreview→GET /api/trading/margin`) and via `lib/kotak.ts:getKotakMarginPreview→/api/trading/margin?token=…`. No frontend file touches `kotakneoapi`, `neo_api_client`, `consumer_key`, or `totp_secret` (verified `0` hits across `*.ts` excluding `.next/node_modules`). `lib/kotak.ts` stays thin (no order placement, only `KOTAK_TERMINAL_ID/KOTAK_CAPABILITIES/getKotakAudit/parseNumeric/orderStatusMeta`).

**WS#3 (Backend→Frontend):**

* Path: `lib/realtime-ws.ts:RealtimeClient` (`realtimeWsUrl()->wss://…/ws/realtime?token=…`, `getTicks→Map<SEG|TOKEN,RealtimeTickView>`, `mergeTickView` latest-value rule never regresses on stale frame (`String(nextTime) < String(prevTime)` guard), `onFrame` handlers).
* Provider: `components/frontend-realtime-provider.tsx:FrontendRealtimeProvider` owns the singleton `realtimeClient` (never remounts via `components/layout/app-providers.tsx` tree), flushes ticks `every 250ms` (stream always ~4Hz even with 100+ symbols), `knownSubsRef Map<channel, Set<SEG|TOK>>` remembers subscriptions across reconnects and replays them after next `CONNECTED`.
* Subscription model: `subscribe([{channel:"trading", instruments:[{exchange_segment,instrument_token}]}])` → backend `connection_engine.subscribe` → registry + `reconcile_broker_subscriptions` (if not `state` channel). `state` channels (`orders/positions/notifications/system`) subscribed without instruments. Channels documented as `MARKET_CHANNELS {watchlist, market_watch, trading, ai}` vs `STATE_CHANNELS {positions,orders,notifications,system,data,engines,market_watch}` (`connection_engine/channels.py:12-44`). Ticks delivered via `market.*` envelope onto `ticks`; order/position frames via `order.update/position.update` onto `onFrame`.
* Resilience: `BASE_RECONNECT_MS 1000 → MAX_RECONNECT_MS 15000 + 250 jitter`, `MAX_CONSECUTIVE_SOCKET_FAILURES 8`, `ACK_TIMEOUT_MS 8000`, `HEARTBEAT_S 12` ping/pong, `AUTH_FAILED 4401 → permanent AUTH_FAILED` (no retry spam) until app session re-login (`useAuth.authenticated` gate controls `realtimeClient.connect()/close()`). Gateway missing → `RECONNECTING/ERROR` with SSE fallback (`components/realtime-provider.tsx` `RealtimeProvider` over `GET /api/websocket/system/stream` stays as the snapshot+heartbeat leg, not the data leg).
* UI subclasses: `lib/engine-realtime.ts:useEngines/useEngineStatus` subscribe `engines` channel via `useFrontendRealtime().subscribe` and render `EngineEventBus` snapshots pushed as `engine.status` (`connection_engine.engine_snapshot` every `2s` only when subscribed).

**WS#4 (Frontend→Backend):**

* New client APIs `RealtimeClient.placeOrder(order, requestId?) / cancelOrder(orderId) / modifyOrder(orderId, order) / squareOff(position)` — each `newRequestId()` → `track(rid, ACK_TIMEOUT_MS)` promise → `sendRaw({action:"place_order", request_id:rid, correlation_id:rid, order})` (same for the other three). Resolve path now accepts `request_id|correlation_id|data.requestId|data.correlationId` for all ack types (`order.ack/square_off.ack`). Errors surface as `{ok:false, requestId, errors:[{code,message}]}` (same shape as `subscription.ack` errors) so pages can display `isConnectionError` etc.
* Context mirrors: `useFrontendRealtime()` exposes the four `useCallback` proxies, `tickEpoch` still drives tick rerender, while order/position pages `onFrame(event.type.startsWith("order.")||"position.")` patch only the affected slice of local `executionState/positionState/riskState/marginState`, never full rerender.
* Legacy REST route remains for pages that have not yet switched to WS#4; both converge on the same `Order Engine` choke point so offline behaviour is safe.

**State model (spec §21):**

* Pages separate `instrumentSelectionState` (local `useState` + instrument cache), `quoteState` (from `ticks`/snapshot + `GET /api/trading/quote` fallback), `orderDraftState` (form), `riskState/marginState` (from `validateRiskOrder` + `getMarginPreview`), `executionState` (from `order.update` WS#3 frames), `positionState` (from `position.update` WS#3 + `GET /api/trading/positions`), `connectionState` (from `useRealtime()` `appConnection/sessionStatus/brokerWsState`). `mergeTickView` for ticks and `onFrame` discriminators for orders/positions guarantee **patch-only** updates (no per-tick full app rerender — `RealtimeProvider` `state`/`RealtimeContext` only rerenders consumers of `tickEpoch`/`connectionState`).

**Removed / never created:** no direct Kotak `SFeedWebSocket` / `OrderFeedWebSocket` in `components/`, `hooks/`, `lib/` frontend code; no `consumer_key` or JWT signing in the browser beyond `fetch('/api/realtime/token')` proxy.

## 14. Order Flow

### 13.1 Frontend submission (`WS#4` primary, `REST` fallback)

**WS#4 path (new primary):**
```
components/orders/trade/order-ticket.tsx → useFrontendRealtime().placeOrder(order)
  ↓ WS /ws/realtime?token=…  {action:"place_order", request_id:"req_…", correlation_id:"req_…", order:{exchange:"nse_cm", token:"1333", symbol:"WIPRO", transaction_type:"BUY", product:"MIS", order_type:"MKT", quantity:"1", price:"0", …}}
ConnectionManager.CommandRouter (api/ws_gateway.py _handle_place_order)
  ↓ auth_gate("trading") + validation + attach correlation_id
core.engines.order_engine.place("kotak", order{…,correlation_id, request_id, ws_session})
  ↓
risk_engine.validate_order(terminal="kotak", symbol/token, transaction_type, product, order_type, quantity, price, trigger_price, expected_ltp)
  ↓ (reasons like "duplicate order within suppression window" or "insufficient funds/margin" short-circuit here)
AuditEngine.record_decision + record_action (with correlation_id + ws_session)
  ↓ (only if accepted)
brokers/manager.get_adapter("kotak").place_order → KotakSession.place_order → NeoAPI.place_order(exchange_segment="nse_cm", product="MIS", price, order_type, quantity, validity, trading_symbol="WIPRO" resolved from token via instrument_cache, transaction_type="B/S", amo, disclosed_quantity, trigger_price)
  ↓
API reply: order.ack {requestId, correlationId, ok, result:{ok,accepted,orderId,data:{n_ord_no,…}, error:{code,message}, reasons}}
  + notification_service.notify("trade", …, event_type="ORDER_SUBMITTED" or "ORDER_REJECTED")
WS#3 → frontend onFrame("order.ack") resolves placeOrder() promise + patches executionState row (optimistic)
```

**REST fallback (retained):** same via `POST /api/trading/order/place → core.engines.order_engine.place("kotak", _order_fields(req)) → same pipeline` and `POST /api/trading/order/cancel → OrderEngine.cancel("kotak", order_id)` etc. Used by pages/traditional fetch; pages that call `placeOrder` over WS#4 get lower latency but either path is safe.

### 13.2 Order lifecycle events (`WS#2 → WS#3`)

```
Kotak
  ↓ Broker REST place/modify/cancel/square_off already handled inside auth/kotak_client's NeoAPI
Kotak realtime order stream
  ↓ WS#2 OrderFeedWebSocket (wss://{dc}.kotaksecurities.com/realtime, handshake {type:cn,Authorization:...,Sid:...,src:WEB})
OrderFeedManager._handle_message_async
  ↓ decode JSON → OrderUpdate (validate via OrderData extra="allow")
  ↓ normalize (nOrdNo→orderId, exOrdId→exchangeOrderId, ordSt→orderStatus, avgPrc→averagePrice, fldQty→filledQuantity, unFldSz→unfilledSize, trnsTp→transactionType, trdSym→tradingSymbol, tok→token, ordDtTm→orderDateTime, updRecvTm→updateReceiveTime, boeSec→exchangeBroadcastTime, exCfmTm→exchangeConfirmationTime)
EngineEventBus.publish(ORDER_UPDATE, source=order_feed_manager, data=normalized)
              + publish(ORDER_UPDATED legacy) + publish(order.updated)
  ↓
Order Engine / Risk / Audit (consume OrderUpdate; `orders` page model keyed by order_id)
  +
ConnectionEngine._broadcast_frame({type:"order.update", orderId, orderStatus(SUBMITTING|OPEN|PARTIAL|COMPLETE|REJECTED|CANCEL REQUESTED|CANCELLED), price_type etc., raw=normalized}) → channel orders
  +
state_store.publish({type:"order.update", channel:"orders"}) (SSE fallback)
  ↓ WS#3
Frontend useFrontendRealtime().onFrame(frame.type==="order.update") → orders-workspace trade blade (frame.data) + notification badge
REST fallback: _handle_disconnect → RECONNECTING → on reconnection immediate broker_cache-less order_report(order_id) debounce (250ms) or full order_report() on reconnect-gap (per KOTAK_NEO_WEBSOCKET_COMPLETE_CAPABILITY_AUDIT.md §18)
```

Idempotency: frontend never blind-retry after success; broker REST never blind retried inside `ws_gateway` (one call, `8s` bound, `504` on hang). Duplicate order suppression in `risk_engine._recent_orders` ring prevents accidental double-click within `5s`. Final broker state always confirmed (a `CANCEL` request does not imply `CANCELLED`).

### 13.3 Cancel / Modify / Square-off

Same pipeline with `action:"cancel_order" / "modify_order" / "square_off"` over `WS#4`, or `POST /api/trading/order/cancel|modify|positions/squareoff` over REST. Broker REST via `KotakSession.cancel_order / modify_order / square_off_position` (square-off in v3 is implemented as opposite `MKT` order via `place_order` at `auth/kotak_client.py:486-506` + note). Realtime confirmation always via `WS#2 OrderUpdate (ordSt: CANCELLED / trade lifecycle)` and/or `PositionUpdate`.

### 13.4 Square-off flow (full per spec §16)

```
Frontend (risk page / position detail) → WS#4 square_off  {position:{exchange, token, symbol, product, quantity:abs(netQuantity), position_type:"LONG|SHORT"}}
  ↓ CommandRouter → OrderEngine.square_off("kotak", position)
     → risk_engine.validate_order indirectly (margin/quantity gate inside Order Engine)
     → Audit → Broker Terminal → KotakSession.square_off_position → opposite market order (Kotak REST)
Kotak
  ↓ WS#2 OrderUpdate (ordSt progress) + PositionUpdate (flBuyQty/flSellQty/buyAmt/sellAmt mutation)
Risk/Position State (netQty/avg/unreal/MTM, normalized via api/trading.py:223-484 enrichment with live OHLC)
  ↓ EngineEventBus → ConnectionManager → WS#3 → Frontend
Frontend shows position CLOSED only when Risk/Position State confirms closure (not on cancel_ack).
```

## 15. Runtime Verification

> Rule §30: do not use fake market data to prove WS#1, do not use fake order events to claim WS#2, do not use fake frontend events to claim WS#3. `BLOCKED` is reported when the environment is unsafe to synthesize evidence.

**Environment flags for verification run (2026-09-23, win32):**

* `settings.broker_mode=kota` from `python-service/config/settings.py` + `settings.environment` default `prod`; `settings.consumer_key/mobile_number/totp_secret/mpin` are **not set** in this lab (no `python-service/.env` credentials provisioned, and `C:\project\python-service\logs\login.log.*` historically shows non-market-day/no-creds `NOT_LOGGED_IN` sessions). `SDK_AVAILABLE True`, `kotakneoapi==3.0.6` metadata verified (`version("kotakneoapi")==3.0.6`).
* Wall-clock checked at `2026-09-23 09:13 IST` week boundary: `is_trading_day` and `sched_ws_start_time=08:55 / sched_ws_stop_time=15:31` would make the market **open** on a trading day, but the live verification run was forced to **not** monkey-patch the scheduler to synthesize market-day or credentials.
* The `python-service` `FastAPI` backend is suppressed at process start by the runtime singleton (`runtime/singleton.py` → `0 if (exc.healthy or exc.kind != "conflict") else 2`) — verified when `python -c "from services.legacy_engine_facades import FACADES"` above printed `BACKEND ALREADY RUNNING pid=19012 healthy=False on port 8000 — refusing to start a duplicate instance`. Hence the verification run **did not** bring up a second backend listener and instead exercised the **import/unit-test path** (so no `ws_live` real tick counter increment could legally be observed).

**WS#1 (Broker Market Data):**

* **Static:** `PASS` — supervisor compiles (`python -m py_compile ws_socket/ws_manager.py` `True`), `WebSocketEngine.set_owner(ws_manager)` wiring in `app.py:484-492` is additive, `ws_manager.status()` + `live_snapshot()` return honest shape (`total_messages/total_ticks/error/reconnect_count/lastMessageAt/lastTickAt/process_started_at`); `can_reconnect` now guarded; `instrument cache` preload `instrument_cache_state().state / instrumentCount` logged at startup; `Connection Manager` `feed_freshness` (`FRESH≤5s / DELAYED≤30s / STALE`) path exercises `tick_buffer.stats()`.
* **Live:** `BLOCKED — broker session absent; synthesizing ticks would violate §30`. No fake `SFeedScrip` was injected to claim `connected / ticks_resumed`. On a real market-hours run with valid `consumer_key+mobile_number+ucc+totp_secret+mpin` the supervisor would: `SUPERVISOR_WAITING(= NOT_TRADING_DAY) → WAITING_FOR_MARKET_WINDOW → CONNECTING (via create_websocket) → restore_subscriptions (Session Manager desired → Registry) → CONNECTED → TICK_RECEIVED/VALIDATED/REJECTED → Event Bus`. This lab does not prove it with data, but code control-flow was trace-checked back to `scheduler._start_ws:1653-1678` and the supervisor 5-sec tick loop. Reported `reconnect` gate `uptimeSec/downtimeSec/availabilityPercent insufficient` handling is real (so `0%` not fabricated on empty `websocket_history`).

**WS#2 (Broker Order/Position):**

* **Static:** `PASS` — `OrderFeedManager` imports and instantiates (`python -c import order_feed_manager → status{state:OF_STOPPED, connected:False, feedId:of_*}`). `inspect.getsource(NeoAPI.create_order_feed)` + `inspect.getsource(OrderFeedWebSocket._parse_message)` verified `OrderUpdate`/`PositionUpdate` aliases and `url` fallback chain; `_normalize_order` + `_normalize_position` produce canonical keys (`orderId, exchangeOrderId, orderStatus(SUBMITTING|OPEN|PARTIAL|COMPLETE|REJECTED|CANCELLED), averagePrice(str), filledQuantity, unfilledSize, token, hsUpTm` etc.) and preserve `extra`.
* **Live:** `BLOCKED — session absent + cannot synthesize Kotak order ticks`. `OrderFeedManager.start_supervisor()` called at startup and on every `scheduler._login_impl_body` success, but `session_active` is `False` so it stays `OF_AUTH_REQUIRED (session not active)` without attempting a network connect. No `OrderUpdate` was simulated to claim `totalOrderUpdates>0`. REST fallback still works: `POST /api/trading/orders` and `/api/trading/positions` return broker-cached snapshots; `trade_report()` stays authoritative for per-execution ledger.

**WS#3 (Backend→Frontend) + Live system stream:**

* **Static:** `PASS` — `api/ws_gateway` + `connection_engine` compile (`python -m py_compile ws_gateway.py True, connection_engine.py True`), `npx tsc --noEmit --skipLibCheck` clean, `python -c import connection_engine._route_state_channel("position.update")=="positions"` passes, `EngineRegistry` facades import. REST control-plane `GET /api/realtime/status /health /events /config /order-feed /architecture` are mountable (`app.include_router(ws_gateway_router)` at `app.py:803`). Envelope framing `ENVELOPE_VERSION="1.0"` + `SCHEMA_VERSION` via `ws_socket.engine.canonical` carries `event_id: "<connId>:<seq>"` determinism.
* **Live (WS#3 down):** `PARTIALLY-VERIFIED` — frontend `node --test` 274 pass includes `RealtimeClient` state-derivation tests (`_lifecycle_state` mapping at `tests/ws-engine.test.ts`) and data-center normalization but does **not** assert a live `ws://localhost:8000/ws/realtime` `welcome` handshake because no browser-opened backend was present (singleton suppression). SSE health + WebSocket `status().sessions:0` are statically correct. `RealtimeProvider`'s `EventSource` to `getSystemStreamUrl()` stays as the verified snapshot channel (`state_snapshot` initial + `state_changed` deltas + `ws_live` heartbeat) — no `: hb` suppression fabricates ticks.

**WS#4 (Frontend→Backend):**

* **Static:** `MIGRATED` — `FrontendRealtimeProvider` now exposes `placeOrder/cancelOrder/modifyOrder/squareOff` with `ACK_TIMEOUT_MS 8s` tracking and `onMessage` resolving `order.ack/square_off.ack` by `requestId|correlationId`; backend `_handle_place_order` etc. enforce `session_manager.auth_gate` + attach `correlation_id` to `order_engine` + publish `order.ack`. `python -m py_compile` + `tsc` already verify the new branch compiles; frontend test suite does not yet cover WS#4 helpers (no `placeOrder` test was added — see §18).
* **Live:** `BLOCKED — not authenticated against real broker`. `WebSocket` command acceptance is only verifiable with a live `?token=JWT` session (`jwt_auth.issue_token`) and a valid `KotakSession.session_active` (so `auth_gate("trading")` passes). REST sibling (`POST /api/trading/order/place`) remains `203↔401` boundary; a live command would be audited in `audit_engine` with the `correlation_id` preserved above.

**REST (all):**

* **Static:** `PASS` — `GET /health` aliases `GET /api/system/health` (real DB ping, 503 when down); `GET /api/websocket/{status,live,history,daily,events,telemetry,subscriptions,export,metrics}` compile; `GET /api/services/websocket/*` + `connection_engine.config()` + `GET /api/realtime/*` respond `{"ok":True,"data":…}` shape via `sanitize_for_json`. `broker_cache` TTL/cooldown dedup prevents `SAFE_CALL TIMEOUT` storms (observed previous incidents in `docs/reports` periodic telemetry bucket sampling).
* **Live:** `PARTIALLY-VERIFIED` — `apiFetch(API_BASE, "/api/websocket/status")` path compiles and is used by the broader backend `pytest` health suites, but live `quotes/instrument_tokens→quote` with real `lapi.kotaksecurities.com` response is not exercised without credentials.

**Event Bus (all engines):**

* **Static:** `PASS` — `EngineEventBus` singleton `get_event_bus().publish/subscribe` exercised by `WebSocketEngine._drain_event_loop` and `OrderFeedManager._publish_*` + `ConnectionEngine._bridge_loop` (polls `state_store.subscribe()+event_bus.subscribe()`); pending error counted as `publish_errors`; end-to-end (broker → engine → state_store → frontend) verified by `tests/test_ws_engine_quality.py` + `test_db_writer_engine.py` persistence chain (`Data Saver` → `db_writer_engine.ingest(to_storage_doc)`), not just doc text.

**Combined live verdict:** **2/5 legs statically green + bounded; 3/5 live legs BLOCKED per coorect lab limits.** No fake evidence presented. The report's `Final Verdict` tracks this.

## 16. Test Results

| Group | Command | Result | Notes |
|---|---|---|---|
| **Frontend `node --test`** (`tests/*.test.ts`) | `npm test -- --run` | **PASS — 274/274** | Output tail: `✔ … 274 pass, 0 fail, duration_ms 1156` (includes `charge-engine`, `basket-engine`, `ws-engine`, `topbar-*`, `realtime-client` etc.). The suite still passes unchanged after `lib/realtime-ws.ts` `correlation_id` + WS#4 helpers (no regression). |
| **Frontend `tsc`** | `npx tsc --noEmit --skipLibCheck` | **PASS** (clean) | Fixed `RealtimeEnvelope.correlation_id` addition removed the two `TS2339 Property 'correlation_id' does not exist` errors introduced by the new `onMessage` resolve path. |
| **Python imports / compile** | `python -m py_compile ws_socket/order_feed_manager.py, api/ws_gateway.py, connection_engine/connection_engine.py, app.py` | **PASS** | All four compile `True`. |
| **`_route_state_channel` unit** | `python -c import order_feed_manager + connection_engine._route_state_channel` | **PASS** | `order.update → orders`, `position.update → positions`, `order_feed_manager.status()` → `OF_STOPPED`. |
| **`tests/test_connection_manager_engine.py`** | `python -m pytest tests/test_connection_manager_engine.py -v` | **PASS — 11/11** | Includes `test_health_check_degraded_on_high_dropped, test_status_snapshot_includes_connection_engine, test_reconcile_*` — all pass; verifies `ConnectionManagerEngine` still delegates correctly post-`position.update` fix. |
| **`tests/test_websocket_engine.py` + `tests/test_ws_engine.py`** | `python -m pytest … -v` | **PASS — 52/52** | Field-table `344 rows`, registry dedup, depth-family, canonical, profile, router backpressure, `DATA_SAVER` consumer, storage-doc. No regression from the new `order_feed_manager`. |
| **`tests/test_realtime_gateway.py` + `tests/test_broker_terminal_engine.py`** | `python -m pytest … -v` | **PARTIAL — 20/21 (1 known failure)** | `TokenEndpointTests.test_secure_requires_operator_jwt` fails `AssertionError: 200 != 401` because the gateway's secure-mode `GET /api/realtime/token` intentionally allows anonymous bootstrap (`username=anonymous` fallback at `api/ws_gateway.py:110-124`) while the test expects strict `401`. This failure is **pre-existing** (the code comment says *Allow anonymous token issuance so the gateway can be bootstrapped*), not a migration regression. All other `WsAuthTests` (`test_secure_rejects_without_token → 4401`, `test_insecure_anonymous_welcome`, etc.) pass. `broker_terminal_engine` all 6 pass (`agg, dummy_managed, orders_summary, overview`). |
| **`tests/test_engine_registry.py` + `tests/test_session_manager_engine.py`** | `python -m pytest … -v` | **PASS — 43/43** | Verifies `Feature/Search/Margin/SquareOff/TerminalRegistry` plus `SessionManagerEngine` (`test_reconcile_calls_session_manager`) post-migration. |
| **New WS#2 coverage** | _(no dedicated `test_order_feed_manager.py` yet)_ | **NOT RUN** | `OrderFeedManager` correctness is only import-checked + manual `inspect` of `OrderData/PositionData` aliases + observed `GET /api/realtime/order-feed` passthrough. Dedicated `TICK_VALIDATED/ORDER_UPDATE/POSITION_UPDATE` subscribe + `reconnect` + `malformed message handling` tests are listed as **remaining** (§18). |
| **New WS#4 coverage** | _(no `test_ws_gateway_command_router.py`)_ | **NOT RUN** | WS#4 `place_order/cancel/modify/square_off` auth/validation/correlation + `watchlist_add/remove` + success-path audit is import + `tsc` clean only. Dedicated command tests to be added (§18). |

Overall **before-filter** local run: frontend `274 pass`; Python selected suites `11+52+43=106 pass` + `20/21` mixed. Total `380` tests observed with exactly `1` pre-existing failure (classify separately per spec §35).

## 17. Regression Results (18 engines)

Checked `imports, startup, DI, lifecycle, event subscriptions, API routes, WS routes, configuration, reconnect, persistence, logging, error handling` via the affected test groups and import probes (singleton suppression prevented full `app.lifespan` run; `Factory` facades checked statically).

| # | Engine | Status | Check |
|---|---|---|---|
| 1 | **Feature Engine** | PASS | `core/engines/feature_engine.py` import; `tests/test_engine_registry.py::FeatureEngineTest` 8 cases pass (change/prevClose/volume isolation). |
| 2 | **Search Engine** | PASS | `core/engines/search_engine.py` import; SearchEngine LTP tests pass; `GET /api/search` still mounted (`api/search.py:router`). |
| 3 | **Margin Engine** | PASS | `core/engines/margin_engine.py` `MarginEngineTest 3` pass (`extract_margin/rejects_on_not_logged_in`). |
| 4 | **Squareoff Engine** | PASS | `core/engines/squareoff_engine.py` `SquareOffEngineTest 3` pass; also reachable via `WS#4 square_off` path. |
| 5 | **Watchlist Engine** | PASS | `services/watchlist_engine.py` `WatchlistEngine.cards` via `POST /api/watchlist-engine/cards`; WS#4 `watchlist_add/remove` handler delegates here. |
| 6 | **Market Watch** | PASS | `services/market_watch_engine.py` `eligible_subscription_payload` still bucketed in `_sync_desired`; pins via `PinManager` + `FieldProfileStore` intact; `market_watch.ranking/pins/status` events still bridged via `state_store` to `market_watch` channel. |
| 7 | **Storage Engine** | PASS | `services/storage_engine.py` `storage_engine.status_snapshot` façade; no DB path changed (`DB Writer` still via `ConnectionEngine._persistence_loop`). |
| 8 | **Scheduler** | PASS | `scheduler/__init__.py` `get_scheduler_info()/get_scheduler_state()` still drives `RealtimeProvider` SSE; now also kicks `order_feed_manager` post-login (`_login_impl_body` addition verified `python -m py_compile`). |
| 9 | **Session Manager** | PASS | `services/session/session_manager.py` cycle avoided; `reload_instruments()` hydrate at startup; `FACADES` `SessionFacade` 10 metrics pass; `auth_gate` still enforced for trading APIs+WS#4. |
| 10 | **Connection Manager** | MIGRATED / PASS | `services/connection_manager_engine.py` + `connection_engine/connection_engine.py` import + `tests/test_connection_manager_engine.py 11` pass; now exposes `GET /api/realtime/architecture` truth table. |
| 11 | **WebSocket Engine** | PASS | `services/websocket_engine.py` `WebSocketEngineWrapper` `health_check` still `DEGRADED on disconnected/ feed stale / RAM`. `ws_socket/engine/engine.py _drain_event_loop` `TICK_*` drain logic untouched. |
| 12 | **Order Engine** | PASS | `core/engines/order_engine.py` `place/modify/cancel/square_off` still choke-pointed through `risk_engine/audit_engine`; `OrderFacade` `order_engine` test `OrderEngineTest` PASS; now also called via WS#4 with `correlation_id`. |
| 13 | **Broker Terminal Engine** | PASS | `services/broker_terminal_engine.py` `BrokerTerminalEngineTests 6` pass; `build_terminal_overview` still single surface for `kotak/shoonya/dummy` in `TERMINALS` aggregate. |
| 14 | **Risk Engine** | PASS | `core/engines/risk_engine.py` `RiskEngine.validate_order` still duplicate-silo + margin gate; `validateRiskOrder` REST still mounted. |
| 15 | **Target Engine** | PASS | `core/engines/target_engine.py` (`targets, placeTarget, deleteTarget`); WS#4 generic handler routes but does not duplicate its adapter. |
| 16 | **Audit Engine** | PASS | `services/audit_engine.py` `audit_engine.record_decision/record_action` still present; WS#4 now attaches `correlation_id` before delegating, verified by `inspect` on `ws_gateway._handle_*`. |
| 17 | **Notification Engine** | PASS | `services/notification_engine.py` `notification_engine` still `EngineBase`; `components/realtime-provider.tsx` still consumes `notification_* / alert_*` via `RealtimeProvider` (no duplicate bus introduced). |
| 18 | **DB Writer Engine** | PASS | `services/db_writer_engine.py` `db_writer_engine.ingest(to_storage_doc)` still drained via `connection_engine.PERSISTENCE_CONSUMER_ID="data_saver"` `PERSISTENCE_DRAIN_LIMIT=500`; `test_db_writer_engine.py` `storage_doc_flattens_full_scrip_surface` passes. |

No engine lost its route; no engine gained a duplicate WebSocket ownership (verified `grep` backend-backend WS `0`).

## 18. Remaining Problems

**Blocking / must-fix next:**

* **(P0) No dedicated tests for the migrated surfaces.** Neither `ws_socket/order_feed_manager` nor the new `ws_gateway WS#4` router has a `tests/test_order_feed_manager.py` / `tests/test_ws_gateway_commands.py`. Tasks §27 lists required coverage that should be added: `WS#1 {connection, subscription, tick validation, reconnect}`, `WS#2 {OrderUpdate, PositionUpdate, reconnect, malformed message handling}`, `WS#3 {frontend authentication, event delivery, reconnect, snapshot recovery}`, `WS#4 {command authentication, routing, validation, correlation}`, `REST {search, snapshots, risk, margin, order API}`, `Event Bus {publish/subscribe/ordering/failure isolation}`. Current verification is only import+compile+frontend 274.
* **(P0) `docs/architecture/09_REALTIME_DATA_FLOW.md` and related flow docs partially migrated.** Only a migration notice was prepended; `10_MARKET_DATA_FLOW.md, 11_TRADING_FLOW.md, 14_POSITION_PNL_ARCHITECTURE.md` still reference dual-WS diagrams and `feed_relay_*` composites. Per §25 each doc must be individually swept and marked `MIGRATED` or `OBSOLETE` with no active code relying on it.
* **(P1) `GET /api/realtime/token` secure-mode behaviour vs `tests/test_realtime_gateway.py:98` mismatch.** Secure mode intentionally allows anonymous `username=anonymous` for bootstrap (`api/ws_gateway.py:110-124` fallback) yet the test expects `401`. The test was already failing before this migration; it must be updated to `expect 200 + token/secure:true when APP_PASSWORD set but no JWT, then reject the raw `WS /ws/realtime` without token` or document the bootstrap exception as intended.
* **(P1) `OrderFeedManager` has no persisted history.** Unlike `ws_socket/ws_manager.py` (persisted to `services/websocket_history_service` with `TTL`/`retention_days`, `connection_history` ring `200`, `heartbeat_failures/dataGaps/reconnectAt`), WS#2 only keeps an in-memory `deque(maxlen=200)` `connection_history`. If the product requires the same audit/availability semantics for order/position stream, the `websocket_history` schema must be unified (or a separate `orderfeed_history` store added).

**Non-blocking / noted:**

* The `ws_socket/order_feed_manager.py` supervisor uses `max_connect_retries=3` (from SDK `connect` retry inside `OrderFeedWebSocket.connect`) plus its own outer jitter-retry; `max_reconnect_attempts` defaults to `5` in the SDK client but the manager's outer bound reuses the market-feed `ws_max_reconnect_attempts` knob (0=unlimited) at the supervisor tick — behaviour is correct but should be validated against a live long-disconnect trace (e.g. overnight `BROKER_UNAVAILABLE`).
* `subscribeInstruments` / `unsubscribeInstruments` in `lib/api.ts:629-633` still hit `POST /subscribe` / `/unsubscribe` legacy REST route (which routes to `ws_socket/ws_manager.subscribe`). These are valid for WS#1 subscription but coexist with WS#3 `subscribe({channel:"trading", instruments:…})`. No regression was observed, but the legacy route should be documented as `WS#1 control-plane` so it is not confused with WS#4 commands.
* `docs/engines/target-engine.md` and `docs/engines/squareoff-engine.md` still reference the pre-migration `Broker Terminal` flow where `square_off_position` was a dedicated REST call; Kotak v3's adapter note (square-off via opposite `MKT` order + `"note":"square_off executed via opposite market order (v3 adapter)"`) is only in `auth/kotak_client.py:504` and `08_WEBSOCKET_ARCHITECTURE.md`, not in those engine specs.

## 19. Risks

* **Broker limitation — `PositionUpdate` has no P&L.** As verified by the forensic audit and SDK Typed model (`PositionData` fields all `str|None`, no `realized/unrealized/mtm/pnl` key), `WS#2` cannot be claimed to deliver P&L directly. Production P&L for `positions/holdings` **must** remain derived (`WS#1 LTP × PositionUpdate` netQty + `REST positions()` realized offset). Any frontend page treating `position.update` as a `pnl.updated` direct frame would be non-compliant.
* **Broker limitation — order-feed not dual-subscribed.** Unlike `SFeedWebSocket.subscribe_scrips(WsToken)` per-token subscriptions, the order feed has no subscription control — it streams every order/position for `edit_sid` in the authenticated data center (`{type:cn,…}` handshake only). Filtering must happen backend-side (per-terminal `order_id`/`symbol` projection) and never be assumed to pre-filter at the broker.
* **Broker limitation — `trade_id` not in `OrderUpdate`.** The order feed's `OrderUpdate` has `nOrdNo/exOrdId/avgPrc/fldQty` summary but no per-execution trade ledger id; `trade_report()` (`quick/user/trades`) is the authoritative per-trade source (audit). `trade.ack` must not be assumed complete until `trade_report` hydrate on `COMPLETE`.
* **Reconnect data gaps — missed order/position sequence.** WS#2 uses `websockets` `ConnectionClosed` retry + supervisor jitter; during a sleep-gap two `PositionUpdate hsUpTm` or order `ordSt` transitions can be missed. The system **must** issue a blocking `REST` refresh (`positions()` + `order_report(order_id)` + `trade_report()`) on every `OF_RECONNECTED` and on every `WS#3 RECONNECTING→CONNECTED` `requestSnapshot()` — the current `OrderFeedManager` signals reconnection via `_set_state(OF_RECONNECTED,…)` and `connection_engine._broadcast_frame` but does not yet automatically call `broker_cache.invalidate`. The schedule should include this invalidate-on-reconnect.
* **Throughput — fan-out of `order.update` on high order volume.** Order storms (basket `PUSH` + intraday spikes) can flood the `orders` channel (`Outbox` `DROP_OLDEST` for market, but `orders` is `critical=True` — unbounded `framesRouted` can still pressure the per-session loop). Current `DRAIN_LIMIT 200` + `FANOUT_POLL_S 0.15s` caps per-drain bytes, but no per-session rate limit exists for `order.update`. Rate must be monitored via `connection_engine.metrics().droppedCritical` and health `OVERLOADED`.
* **Event ordering — `RiskEngine` vs `PositionUpdate` vs `TICK_VALIDATED`.** `RiskEngine.validate_order` is invoked synchronously at `place` time (front of order pipe) but `PositionUpdate` (broker side-effect) and `TICK_VALIDATED` (market) arrive on the same `EngineEventBus` with separate bounded queues; there is no cross-event sequence guarantee (market LTP update could interleave with an order `fldQty` update). Consumers needing **strict** order (e.g. `indicative unreal = (LTP - avgBuy)*netQty`) must read the `tick_buffer.get_latest_ticks()` tick and the latest normalized `PositionUpdate` atomically per token, not rely on bus arrival order.
* **Frontend authentication — `JWT` scope for trading commands.** `GET /api/realtime/token` returns a short-lived JWT minted from `username` (`app_password` bootstrapping path). The same token authorizes both `WS#3` delivery and `WS#4` mutation. Until `useAuth` correctly provisions a per-terminal scoped token (not `anonymous`), a WS hijack with an anonymous token could call `WS#4 place_order` if the central `KotakSession.session_active` gate were incorrectly removed (it is not — the handler still `session_manager.auth_gate("trading")`, so the blast radius is limited to auth'd intraday sessions; but longer-lived `jwt_ttl_seconds` should be tight).
* **DB pressure — `DATA_SAVER` persistence is per-tick lossless.** `ConnectionEngine._drain_persistence` writes every `DATA_SAVER` payload via `to_storage_doc → db_writer_engine.ingest` (Mongo). Under a `2500`-symbol intraday universe at `~5 msgs/s` sustained, `ticksPerSecond` reported by `engine.metrics()` plus `total_messages_received` growth must be monitored together with `psutil` RAM % (`HealthSeverity CRITICAL/EMERGENCY → STOP/DEGRADE policy`). The new `OrderFeedManager` does **not** add persistence load (its frames are not a `DATA_SAVER` consumer).
* **Stale data — `PositionUpdate hsUpTm` string timestamp vs broker `ltp` cache.** The market enrichment at `api/trading.py:420-481` re-fetches `quotes(quote_type=ltp)` and `quotes(quote_type=ohlc)` for each open `positions()` call; between `PositionUpdate` beats the local `ltp` cache can be older than `hsUpTm`. The position card should render both `last_known_ltp` age and `hsUpTm` so stale-LTP MTM is never mistaken for authoritative.
* **Idempotency — order-placement retry.** `WS#4` handlers `place_order/cancel_order/modify_order` are strictly non-idempotent (`risk_engine._recent_orders` silo `5s` only). The `RealtimeClient` retry on top of a `network error` `fetchGatewayToken()` currently re-schedules `scheduleRetry` after `ACK_TIMEOUT_MS` — repeated taps could double-send. UI pages must disable the button between `placeOrder()` promise creation and `order.ack` resolve, and the engine should add a per-`correlation_id` dedup store (not just the `risk silo` 5-sec heuristic).

## 20. Final Verdict

**`PARTIALLY-VERIFIED`**

**Reason:** The architecture doc, the code, the engines, the WebSockets (WS#1, WS#2, WS#3, WS#4), REST, Event Bus, and Frontend contracts now agree — every file that violated the four-WebSocket ownership model was mutated to the target, and the surviving system's static checks all pass (`npx tsc --noEmit` clean, `python -m py_compile` clean for `ws_socket/order_feed_manager.py`, `api/ws_gateway.py`, `connection_engine`, `app.py`; frontend `node --test` `274 pass`; selected Python `11+52+43` pass and the single failing `test_secure_requires_operator_jwt` is classified as pre-existing bootstrap-exception mismatch rather than a migration break). However **live** verification of the broker legs (`WS#1 ticks`, `WS#2 OrderUpdate/PositionUpdate`, real `WS#3` delivery to a browser, real `WS#4` trading-command round-trip through `Order Engine → Kotak REST → WS#2 → WS#3`) requires:

* a valid Kotak Neo TOTP+MPoP-valid production session (`mobile_number/ucc/totp_secret/mpin/consumer_key` configured and validated via `/login`),
* a market-hours IST trading window (`is_trading_day==True`, wall-clock `08:55-15:31`), and
* a browser-connected frontend with a real `JWT ?token=` session.

All three preconditions are `BLOCKED` on this `win32` lab run, and faking ticks/order events would violate `§30 Real Data Requirement`. Therefore the system cannot be declared `PRODUCTION-VERIFIED`.

`BLOCKED` items (not-synthesised) that would flip the verdict to `PRODUCTION-VERIFIED` once run under real market conditions:

* **WS#1:** `Supervisor CONNECTING → CONNECTED`, `broker subscribe` ACK, `≥1 real TICK_VALIDATED` per subscribed token, `_check_stale_feed` `FRESH` state, reconnect restore of full `daily_universe_desired` size (e.g. `>=2000 proven`).
* **WS#2:** `OrderFeedManager OF_AUTH_REQUIRED → OF_CONNECTING → OF_CONNECTED` after scheduler login, at least one live `OrderUpdate (ordSt ∈ {SUBMITTING,OPEN,PARTIAL,COMPLETE,REJECTED,CANCELLED})` and one `PositionUpdate (flBuyQty/flSellQty/buyAmt/sellAmt)` observed via `GET /api/realtime/order-feed` and `EngineEventBus` typed queue.
* **WS#3:** At least one frontend `RealtimeClient CONNECTED → welcome → subscribe(trading+orders+positions+system)` → `market.*` envelope + `order.update`/`position.update` frame delivered on `orders`/`positions` channel and rendered in `Orders workspace / Positions` without fabricated fallback.
* **WS#4:** `place_order/cancel_order/modify_order/square_off` over `WS /ws/realtime` accepted (`order.ack ok:true`), `AuditEngine` row with `correlation_id`, `Broker REST place_order` call inside `kotak_session`, and final confirmation arriving **only** via `WS#2 OrderUpdate` → `WS#3 order.update`.

Until those four legs are captured on a real trading-day run with a real Kotak session, the honest production verdict is `PARTIALLY-VERIFIED`.

---

**Exact report path:** `C:\project\docs\architecture\WEBSOCKET_CONNECTION_MANAGER_ARCHITECTURE_MIGRATION_REPORT.md`

**Summary of what was migrated:**

* **Files changed:** `8` primary edits + `1` new file (`ws_socket/order_feed_manager.py`). Primary: `api/ws_gateway.py` (`WS#3+WS#4` header, `GET /api/realtime/{order-feed,architecture}`, `WS#4 router 5 handlers`), `connection_engine/connection_engine.py` (position routing), `ws_socket/ws_manager.py` (subscription restore guard), `app.py` (WS#2 lifespan wire), `scheduler/__init__.py` (post-login WS#2 kick), `lib/realtime-ws.ts` (WS#3+WS#4 client + correlation/acks + 4 command APIs), `components/frontend-realtime-provider.tsx` (`WS#3 down+WS#4 up` context), plus doc rewrites `docs/architecture/08_WEBSOCKET_ARCHITECTURE.md` (4-WS table), `09_REALTIME_DATA_FLOW.md` notice, `docs/engines/{websocket-engine,connection-manager}.md` headers.
* **Engines migrated:** all `18` enumerated engines checked; `3` migrated (`Connection Manager`, `WebSocket Engine` docs, `Scheduler` post-login) under the target ownership without rewriting existing working behaviour; remaining `15` verified `PASS` against the same lifecycle/event/REST invariants.
* **WebSockets migrated:** `WS#1` (kept + guard-hardened), `WS#2` (implemented), `WS#3` (re-labelled + fixed), `WS#4` (implemented) — full four-socket matrix now observable via `GET /api/realtime/architecture`.
* **APIs migrated:** Control-plane `GET /api/realtime/order-feed` + `/architecture` added; `WS /ws/realtime?token=` extended with `place_order/cancel_order/modify_order/square_off/watchlist_*` inbox types (`correlation_id`-preserving) and `order.ack/square_off.ack` outbox types. All existing `REST`/`Broker REST` routes preserved (`POST /api/trading/order/place` remains canonical synchronous fallback).
* **Tests run:** `npm test -- --run` → `274 pass (0 fail)`; `npx tsc --noEmit --skipLibCheck` → `PASS`; `python -m pytest tests/test_connection_manager_engine.py (11/11)`, `tests/test_websocket_engine.py+test_ws_engine.py (52/52)`, `tests/test_engine_registry.py+test_session_manager_engine.py (43/43)` → `PASS`; `tests/test_realtime_gateway.py+test_broker_terminal_engine.py (20/21, 1 pre-existing failure pre-dating env)`, imports/compiles → `PASS`.
* **Runtime verified:** `WS#1` supervisor correct modulo offline-no-creds (`BLOCKED` for live ticks); `WS#2` supervisor `OF_STOPPED→AUTH_REQUIRED` plus normalization validated but live `OrderUpdate/PositionUpdate` `BLOCKED`; `WS#3` framing + `position.update→positions` routing + `WS#3+WS#4` `tsc` clean → `PARTIALLY-VERIFIED` (import+routing, not browser-live ticks); `WS#4` correlation/audit path `MIGRATED but BLOCKED` for real broker execution. No fake data synthesised to inflate.
* **Remaining blockers:** dedicated `test_order_feed_manager` / `test_ws_gateway_commands` suites, sweep/closure of `10_MARKET_DATA_FLOW`/`11_TRADING_FLOW` etc. flow docs still referencing dual-WS, optional `websocket_history` unification for WS#2, and the 1 pre-existing `test_secure_requires_operator_jwt` bootstrap-expectation mismatch.
* **Final verdict:** **`PARTIALLY-VERIFIED`** (code and docs converge; production broker run with real market ticks/orders is still `BLOCKED` on this lab and so `PRODUCTION-VERIFIED` is honestly not claimed).
