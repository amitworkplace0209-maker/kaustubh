# ENGINE.md — KAUSTUBH Trading Terminal Architecture

> Canonical engine architecture document. Every engine below is real and
> registered on the running backend (`GET /api/services/engines`).
> Engine Registry registration ≠ running — state is always the honest,
> observed engine state. Each engine documents: Purpose, Phase, Location,
> Inputs, Outputs, Dependencies, Consumers, Lifecycle, Runtime Flow, API,
> WebSocket Flow, Database, Broker Dependency, Failure Behaviour, Monitoring,
> UI, Phase 3 Control and Future Phase 4.

## Engine Model

- **Native engine** (`EngineBase`): owns its own lifecycle; the registry
  drives `_on_start` / `_on_stop`. `managed=false`.
- **Facade engine** (`LegacyEngineFacade`): wraps a pre-existing subsystem
  (scheduler, WS, session, gateway, order/position, notification). Lifecycle is
  delegated to the subsystem; the facade mirrors its real state. `managed=true`.
- **Registration ≠ RUNNING**: the registry records the engine; whether it
  actually runs depends on app.py lifespan auto-start (native engines) or the
  subsystem the facade reports.
- **Broker dependency** is by INTERFACE (`MarketDataProvider` /
  `TradingBrokerProvider`), never hard-coded to a single broker SDK.

---

## CORE Engines

### Session Manager (`session_manager`) — CORE
| Field | Value |
|---|---|
| **Purpose** | Single source of truth for the broker session lifecycle (login/logout/expiry/mode) AND the subscription set ("what is subscribed": desired + broker acks + pins + real expiry + routing + required fields). Owns ONE independent session record per terminal (`dummy`/`kotak`/`shoonya`). |
| **Phase** | Phase 2 live runtime + Phase 1 terminal. Phase 3.5 Session Manager Engine control plane (canonical lifecycle + Mongo persistence) builds on the SAME singleton. |
| **Location** | `services/session/session_manager.py` (manager) + `services/session/instrument_store.py` (Mongo canonical store); facade: `services/legacy_engine_facades.py` |
| **Inputs** | Login success/start/failure, logout, expiry events, terminal-switch requests, active `stocks` (MongoDB), engine pin intents (`set_pin_intents`), broker acks (`mark_broker_subscribed/unsubscribed`), routing updates (`mark_subscription_routing`). |
| **Outputs** | `snapshot()` with `sessionId`, `mode`, `state`, `expiresAt`, `remainingSeconds`, `sessions` (per terminal), `sessionHistory`, `sessionRouting`, `subscriptionState` (revision + counts + per-instrument rows in the canonical SUBSCRIBED / PINNED / SUBSCRIBED+PINNED / NOT SUBSCRIBED / EXPIRED / INACTIVE vocabulary). |
| **Dependencies** | `events.history`, `config.settings` (dependency-light by design — never imports the Kotak engine). |
| **Consumers** | Scheduler, Trading API, `/api/session`, `/api/sessions`, SCC engine facade, all terminals. |
| **Lifecycle** | App-lifetime singleton (`CentralSessionManager`); facade reflects real-time snapshot. |
| **Runtime Flow** | mode switch → `set_mode()` restores that terminal's own record; login → `mark_login_success()` writes the record; logout/expiry → updates ONLY the target terminal's record. |
| **API** | `/api/session`, `/api/sessions`, `/api/session/history` + Phase 3 control plane: `/api/phase3/session-manager/*` (overview/status/health, instruments CRUD, subscribe/unsubscribe/pin/unpin/activate/deactivate/expire/remove/error, revision, connections, events, reconcile). |
| **WebSocket Flow** | Not a WS source/sink; tracks `_ws_state` from the WS supervisor. |
| **Database** | `events.history` persisted events; no credentials stored. |
| **Broker Dependency** | None (state only). |
| **Failure Behaviour** | Deterministic state machine; failures recorded with honest reason vocabulary; never fabricates countdowns. |
| **Monitoring** | `GET /api/session` (remainingSeconds, state, per-terminal `sessions`). |
| **UI** | Terminal provider reads session snapshot for login/logout/switch affordances. |
| **Phase 3 Control** | Stop/start via SCC engine control endpoint (facade). |
| **Future Phase 4** | Multi-session concurrency + audit replay. |

### Search Engine (`search_engine`) — CORE
| Field | Value |
|---|---|
| **Purpose** | Instrument metadata search with in-memory index and live LTP cache — no broker API call per keystroke. |
| **Phase** | Phase 2 live runtime. |
| **Location** | `core/engines/search_engine.py` |
| **Inputs** | Instrument master (loaded via `InstrumentCache.get_instruments()`), search queries, live ticks. |
| **Outputs** | Search results, related stocks, LTP lookups. Config summary `instrumentCount`, `indexed`. |
| **Dependencies** | `services.instrument_cache` (preferred), fallback `data/instrument_master.json` (`{"instruments": [...]}` dict). |
| **Consumers** | Search UI, related-stocks widgets, LTP-aware features. |
| **Lifecycle** | Native `EngineBase`, auto-start in app.py lifespan. |
| **Runtime Flow** | `_on_start` → `_load_instruments()` → index build → per-request search. |
| **API** | Search endpoints / engine API. |
| **WebSocket Flow** | None (reads canonical ticks where needed). |
| **Database** | `data/instrument_master.json` (read-only source). |
| **Broker Dependency** | None. |
| **Failure Behaviour** | Empty instrument list → search returns no matches (honest); logs error, no crash. |
| **Monitoring** | `GET /api/services/engines` health/state. |
| **UI** | Search box suggestions. |
| **Phase 3 Control** | Start/stop via SCC. |
| **Future Phase 4** | Disk-backed index + fuzzy scoring. |

---

## MARKET_DATA Engines

### Feature Engine (`feature_engine`) — MARKET_DATA
| Field | Value |
|---|---|
| **Purpose** | Derive market features from validated ticks. |
| **Phase** | Phase 2 live runtime. |
| **Location** | `core/engines/feature_engine.py` |
| **Inputs** | `TICK_VALIDATED` events from the event bus. |
| **Outputs** | Feature deltas/derived metrics; state via `request_state()`. |
| **Dependencies** | `websocket_engine`, `connection_manager`, `services/engine_event_bus`. |
| **Consumers** | `market_coach`, watchlists, indicators. |
| **Lifecycle** | Native engine, auto-start in app.py lifespan. |
| **Runtime Flow** | Subscribes event bus → per-tick feature computation → publish derived state. |
| **API** | Engine API (`/api/services/engines/<id>`). |
| **WebSocket Flow** | Subscribes TICK_VALIDATED via event bus (thread-safe queue bridge in `ws_socket/engine/engine.py`). |
| **Database** | None. |
| **Broker Dependency** | None. |
| **Failure Behaviour** | Bad tick → skipped/REJECTED, engine stays healthy. |
| **Monitoring** | SCC health heartbeat. |
| **UI** | Indicators/features panels. |
| **Phase 3 Control** | Start/stop via SCC. |
| **Future Phase 4** | Model-grade feature store. |

### Watchlist Engine (`watchlist_engine`) — MARKET_DATA
| Field | Value |
|---|---|
| **Purpose** | Maintain watchlist pricing from validated ticks. |
| **Phase** | Phase 2 live runtime. |
| **Location** | `services/watchlist_engine.py` |
| **Inputs** | `TICK_VALIDATED` events, watchlist membership. |
| **Outputs** | Per-symbol latest LTP/change state. |
| **Dependencies** | `ws_socket.engine.engine` (event bus). |
| **Consumers** | Watchlist UI, live strips, dashboard. |
| **Lifecycle** | Native engine, auto-start. |
| **Runtime Flow** | Subscribe → update symbol map on each validated tick → serve `request_state()`. |
| **API** | Watchlist engine endpoint. |
| **WebSocket Flow** | TICK_VALIDATED subscriber. |
| **Database** | None. |
| **Broker Dependency** | None. |
| **Failure Behaviour** | Feed offline → last-known values, "Tick feed offline" label. |
| **Monitoring** | SCC health. |
| **UI** | Live watchlist strip (`WatchlistStrip`). |
| **Phase 3 Control** | Start/stop via SCC. |
| **Future Phase 4** | Derived watchlist groups. |

### Market Coach (`market_coach`) — MARKET_DATA
| Field | Value |
|---|---|
| **Purpose** | Market session coaching / session-aware context (open/pre-open/closed). |
| **Phase** | Phase 2 live runtime. |
| **Location** | `core/engines/market_coach.py` |
| **Inputs** | `TICK_VALIDATED`, time-of-day, market state service. |
| **Outputs** | Coach messages/session context. |
| **Dependencies** | `feature_engine`, `market_state_service`. |
| **Consumers** | Coaching UI, notifications. |
| **Lifecycle** | Native engine, auto-start. |
| **Runtime Flow** | Event-driven per tick + periodic session evaluation. |
| **API** | Engine API. |
| **WebSocket Flow** | TICK_VALIDATED subscriber. |
| **Database** | None. |
| **Broker Dependency** | None. |
| **Failure Behaviour** | Market closed → "Market Closed — last known data" states, no fabricated advice. |
| **Monitoring** | SCC health. |
| **UI** | Coach panels, `MarketSessionCard`. |
| **Phase 3 Control** | Start/stop via SCC. |
| **Future Phase 4** | AI advisory hook (AI interfaces). |

### WebSocket Engine (`websocket_engine`) — MARKET_DATA
| Field | Value |
|---|---|
| **Purpose** | Own the market-data feed: connect, subscribe, normalize, publish TICK_VALIDATED. Subscribes/expires exactly what the Session Manager desires (never decides the set itself). |
| **Phase** | Phase 2 live runtime. |
| **Location** | `ws_socket/engine/engine.py`, `ws_socket/engine/canonical.py`, facade in `services/legacy_engine_facades.py`. |
| **Inputs** | Session Manager desired set (`subscription_desired_keys`), pin intents, supervisor connect/unsubscribe commands, config/status consumers. |
| **Outputs** | `TICK_RECEIVED` / `TICK_VALIDATED` / `TICK_REJECTED` on the event bus; canonical ticks; broker subscribe/unsubscribe deltas (`reconcile_broker_subscriptions`); subscription-state mirror back into the Session Manager. |
| **Dependencies** | `ws_manager` (supervised Kotak SDK feed — the ONLY `SFeedWebSocket` owner), thread-safe queue → asyncio drain bridge, `services.session.session_manager` (authoritative desired set), `ws_manager.prepare_subscriptions()` (pre-login staging). |
| **Consumers** | feature_engine, watchlist_engine, market_coach, storage_engine, dashboards. |
| **Lifecycle** | Facade engine (`managed=true`); lifecycle delegated to `ws_manager` supervisor. |
| **Runtime Flow** | Session Manager desired set → registry intent ("session_manager" consumer) + pins → `reconcile_broker_subscriptions()` computes broker delta → supervisor connects after login (prepared 08:25 via scheduler `WEBSOCKET_PREP`) → acks mirror to Session Manager → `_flat_tick()` normalization → bridge → publish validated events. |
| **API** | `/api/ws/...` subscribe/unsubscribe; engine control. |
| **WebSocket Flow** | SELF: is the primary Kotak market-data WS consumer; fan-out via `connection_manager` (WS#2). |
| **Database** | None (ticks fan out to storage_engine). |
| **Broker Dependency** | Kotak Neo via KotakSDK / `ws_manager` — `MarketDataProvider` interface. |
| **Failure Behaviour** | Feed drop → supervisor reconnect w/ backoff; state DISCONNECTED, honest. |
| **Monitoring** | SCC state DISCONNECTED/RUNNING; supervisor state. |
| **UI** | "Tick feed offline" indicators, dashboards. |
| **Phase 3 Control** | Stop supervisor / disconnect via engine control. |
| **Future Phase 4** | Multi-feed aggregation. |

---

## TRADING Engines

### Margin Engine (`margin_engine`) — TRADING
| Field | Value |
|---|---|
| **Purpose** | Validate order margin affordability against the active broker's exposure rules. |
| **Phase** | Phase 2 (order-time validation). |
| **Location** | `core/engines/margin_engine.py` |
| **Inputs** | Order intent (symbol, qty, product, side), current margin state. |
| **Outputs** | PASS / BLOCK decision + required/excess margin. |
| **Dependencies** | `TradingBrokerProvider` (`KotakAdapter`). |
| **Consumers** | order_engine, Order API, risk panels. |
| **Lifecycle** | Native engine, `registered, not auto-started` — runs on demand. |
| **Runtime Flow** | Order → margin check → decision. |
| **API** | Engine API. |
| **WebSocket Flow** | None. |
| **Database** | None. |
| **Broker Dependency** | Broker (`KotakAdapter`) via provider abstraction. |
| **Failure Behaviour** | Broker unreachable → BLOCK with honest "margin unavailable" reason. |
| **Monitoring** | SCC health (REGISTERED/UNKNOWN until exercised). |
| **UI** | Order ticket margin hint. |
| **Phase 3 Control** | Start/stop via SCC. |
| **Future Phase 4** | Smart margin optimizer. |

### Order Engine (`order_engine`) — TRADING
| Field | Value |
|---|---|
| **Purpose** | Route order placement through the ACTIVE broker adapter. |
| **Phase** | Phase 2 live runtime. |
| **Location** | Facade: `services/legacy_engine_facades.py` (wraps order placement). |
| **Inputs** | Order requests, active adapter, margin engine decision. |
| **Outputs** | Order ACK/state, order events. |
| **Dependencies** | `TradingBrokerProvider` (KotakAdapter/DummyAdapter), margin_engine. |
| **Consumers** | Orders UI, positions, history. |
| **Lifecycle** | Facade (`managed=true`), app.py lifespan sync. |
| **Runtime Flow** | Request → margin check → active adapter place → event. |
| **API** | Order endpoints (broker-gated by active terminal). |
| **WebSocket Flow** | Order-update events. |
| **Database** | Order store/history. |
| **Broker Dependency** | Active adapter only (`KotakAdapter`/`DummyAdapter`); Dummy MUST NEVER send orders to Kotak. |
| **Failure Behaviour** | Adapter error → REJECTED + reason surfaced. |
| **Monitoring** | SCC health/state. |
| **UI** | Orders module, recent orders table. |
| **Phase 3 Control** | Start/stop via SCC. |
| **Future Phase 4** | Order lifecycle DB + replay. |

### Position Engine (`position_engine`) — TRADING
| Field | Value |
|---|---|
| **Purpose** | Serve positions from the ACTIVE broker adapter honestly. |
| **Phase** | Phase 2 live runtime. |
| **Location** | Facade wraps position provider. |
| **Inputs** | Position query, active adapter. |
| **Outputs** | Canonical positions (side/net/average/ltp/P&L). |
| **Dependencies** | `TradingBrokerProvider`. |
| **Consumers** | Positions UI, squareoff, dashboard, comparison. |
| **Lifecycle** | Facade (`managed=true`). |
| **Runtime Flow** | Query → adapter.positions() → canonicalization → serve. |
| **API** | Position endpoints. |
| **WebSocket Flow** | Position-update events. |
| **Database** | None. |
| **Broker Dependency** | Active adapter only. |
| **Failure Behaviour** | Not logged in → 403 Not logged in (never fabricated positions). |
| **Monitoring** | SCC health. |
| **UI** | Positions table. |
| **Phase 3 Control** | Start/stop via SCC. |
| **Future Phase 4** | P&L time-series. |

### Square-Off Engine (`squareoff_engine`) — TRADING
| Field | Value |
|---|---|
| **Purpose** | Trigger square-off of open positions (manual/triggered), skipping zero-qty rows. |
| **Phase** | Phase 2 live runtime. |
| **Location** | `core/engines/squareoff_engine.py` |
| **Inputs** | Square-off trigger, target symbol/qty. |
| **Outputs** | Exit order requests. |
| **Dependencies** | `position_engine`, `order_engine`, `margin_engine`. |
| **Consumers** | Risk UI, manual square-off buttons. |
| **Lifecycle** | Native engine, registered not auto-started; on-demand. |
| **Runtime Flow** | Trigger → filter zero-qty → exit order per position. |
| **API** | Engine API. |
| **WebSocket Flow** | None. |
| **Database** | None. |
| **Broker Dependency** | Broker (`KotakAdapter`) via provider. |
| **Failure Behaviour** | No qty → no-op (zero-qty filter); broker error → partial exit reported. |
| **Monitoring** | SCC health. |
| **UI** | Square-off controls. |
| **Phase 3 Control** | Start/stop via SCC. |
| **Future Phase 4** | Auto square-off rules. |

---

## STORAGE Engines

### Storage Engine (`storage_engine`) — STORAGE
| Field | Value |
|---|---|
| **Purpose** | Persist validated market/trading data. |
| **Phase** | Phase 2 (Data Saver). |
| **Location** | `core/engines/storage_engine.py` |
| **Inputs** | `STORAGE_WRITE_COMPLETE` / validated ticks batch. |
| **Outputs** | Durable storage writes. |
| **Dependencies** | None. |
| **Consumers** | History, backtest groundwork. |
| **Lifecycle** | Native engine, auto-start; periodic flush. |
| **Runtime Flow** | Accumulate → periodic flush → write. |
| **API** | Engine API. |
| **WebSocket Flow** | Consumes feed events. |
| **Database** | Data store (ticks/history). |
| **Broker Dependency** | None. |
| **Failure Behaviour** | Write error → logged, retry, honest state. |
| **Monitoring** | SCC health. |
| **UI** | History pages. |
| **Phase 3 Control** | Start/stop via SCC. |
| **Future Phase 4** | Analytics storage. |

---

## CONTROL Engines

### Scheduler (`scheduler_engine`) — CONTROL
| Field | Value |
|---|---|
| **Purpose** | Broker session lifecycle supervision: 08:25 pre-login WebSocket preparation, 08:50 broker login, market window awareness, reconnect. Gated so Dummy Mode NEVER becomes Kotak. |
| **Phase** | Phase 2 live runtime. |
| **Location** | `scheduler/__init__.py` (facade: SchedulerFacade). |
| **Inputs** | Mode (`active_terminal()`), market window, session state, auth-failure notifications, Session Manager desired set. |
| **Outputs** | Auto-login/logout (`WEBSOCKET_PREP` at 08:25), reconnect, health/session-state transitions, WS `WS_PREPARING` state. |
| **Dependencies** | `brokers.manager` (`is_dummy_mode`), kotak session, `ws_manager` (`prepare_subscriptions`, `start_supervisor`), `market_state_service`, Session Manager (authoritative desired set — never reads `db.stocks` directly). |
| **Consumers** | Real terminal sessions, WS supervisor, session manager. |
| **Lifecycle** | Facade (`managed=true`), 5s reconcile loop during market hours. |
| **Runtime Flow** | Reconcile → prep window (08:25, pre-login): Session Manager desired set → `ws_manager.prepare_subscriptions()` → tick buffer → supervisor → `WS_PREPARING` (idempotent, one `WEBSOCKET_PREP` event/day) → login (08:50) → feed applies staged tokens → dummy gate? park supervisor, PRESERVE existing sessions, keep WS feed alive → else broker login reconcile → logout on expiry. |
| **API** | Scheduler endpoints. |
| **WebSocket Flow** | Owns/reconnects WS supervisor for Kotak market data. |
| **Database** | None (state derived live). |
| **Broker Dependency** | Kotak Neo (real live broker). |
| **Failure Behaviour** | Auth failure → `notify_auth_failure` gated by dummy; honest DEGRADED state, no forced logout of another terminal's session. |
| **Monitoring** | SCC state per-reconcile. |
| **UI** | Terminal status. |
| **Phase 3 Control** | Stop/start via SCC. |
| **Future Phase 4** | Scheduling rule engine. |

### Connection Engine / Gateway (`connection_manager`) — CONTROL
| Field | Value |
|---|---|
| **Purpose** | Fan-out market feed to WebSocket #2 (browser clients). |
| **Phase** | Phase 2 live runtime. |
| **Location** | `services/legacy_engine_facades.py` (GatewayFacade). |
| **Inputs** | Validated ticks from websocket_engine. |
| **Outputs** | Browser WS fan-out. |
| **Dependencies** | websocket_engine. |
| **Consumers** | Browser clients. |
| **Lifecycle** | Facade (`managed=true`), app.py lifespan + `start()`. |
| **Runtime Flow** | Tick valid → fan-out to connected WS clients. |
| **API** | WS#2 gateway endpoints. |
| **WebSocket Flow** | SELF: fan-out sink/source (WS#2). |
| **Database** | None. |
| **Broker Dependency** | None. |
| **Failure Behaviour** | Client drop → disconnect; server keeps feeding. |
| **Monitoring** | SCC health. |
| **UI** | Live tick consumers. |
| **Phase 3 Control** | Start/stop via SCC. |
| **Future Phase 4** | Authorization for WS#2. |

### Notification Center (`notification_engine`) — CONTROL
| Field | Value |
|---|---|
| **Purpose** | Aggregate and push notifications. |
| **Phase** | Phase 2 (event-driven). |
| **Location** | Facade (`NotificationFacade`, NotificationCenter). |
| **Inputs** | Events from engines/session. |
| **Outputs** | Notification records, unread counts. |
| **Dependencies** | None. |
| **Consumers** | Notification UI, bell badge. |
| **Lifecycle** | Facade (`managed=true`); "notification center not initialized" until first event. |
| **Runtime Flow** | Event → record → notify. |
| **API** | Notification endpoints. |
| **WebSocket Flow** | Optional event push. |
| **Database** | Notification store. |
| **Broker Dependency** | None. |
| **Failure Behaviour** | Center not initialized → REGISTERED/UNKNOWN; no fake notifications. |
| **Monitoring** | SCC health. |
| **UI** | Notifications page. |
| **Phase 3 Control** | Start/stop via SCC. |
| **Future Phase 4** | Channel routing (email/push). |

---

## Cross-Cutting Rules

1. **Registration ≠ running** — SCC and engine API report the true observed state.
2. **No fabricated data** — zeros only when backend reports zero; otherwise `—`/`N/A`/`Not Connected`.
3. **Market closed** — keep last-known values; label "Market Closed — last known data".
4. **Terminal isolation** — switching terminals never logs out/invalidates another terminal's session (`set_mode` restores per-terminal records).
5. **Broker via interfaces** — `MarketDataProvider` and `TradingBrokerProvider` are independent; Dummy never sends orders to Kotak.
6. **Helpfulness/brevity** — docs match reality; state is derived, never guessed.

---

*Source: live backend probe (`GET /api/services/engines`) + code audit.*
*Sections per §16 MASTER IMPLEMENTATION PROMPT.*