# 10_MARKET_DATA_FLOW.md — Market Data Flow

**STATUS: CURRENT — Migrated 2026-09-23 to 4-WS model (WebSocket_ConnectionManager_Flow.md + 08_WEBSOCKET_ARCHITECTURE.md)**

## 10.1 Scope

Market data is **LIVE_WS1 ONLY**. `connection_engine` does **not** normalize market ticks; `WebSocketEngine` owns validation/normalization. `Order/Position P&L` is derived separately (§14).

## 10.2 Pipeline (MDP1-6)

```
MDP1 Market Watch builds eligible NSE universe (validated instrument_cache EQ, intraday eligibility)
  ↓ eligible_subscription_payload()
MDP2 Session Manager stores dated desired set {exchange_segment, instrument_token, symbol, feed_level L8/INDEX} + revision + broker mirror
  ↓ subscription_desired_keys_by_row()
MDP3 Subscription Registry merges market_watch + PinManager + session_manager consumer intents, dedup by InstrumentKey, resolves feed level
  ↓ desired()
MDP4 WebSocket Engine computes broker_diff (_broker_subscribed vs desired), validation plan
  ↓ to_sub/to_unsub
MDP5 WebSocket Manager subscribes Kotak (single SFeedWebSocket owner), tracks ACKs
  ↓ WS#1
MDP6 WebSocket Engine receives raw SFeed bytes → validate → dedup → normalize (flat {instrumentToken, exchangeSegment, symbol, ltp, volume, open/high/low/prevClose/netChange/netChangePct, receivedAt, brokerUpdateTimestamp}) → Feed Quality Monitor (degraded/stale/latency)
  ↓ EngineEventBus TICK_VALIDATED
MDP7 Feature Engine / Risk / Market Watch consume via EventBus (no WebSocket hop)
MDP8 Connection Manager fan-out → WS#3 market.* channel → Frontend ticks Map<SEG|TOKEN>
MDP9 DB Writer via DATA_SAVER consumer → to_storage_doc → db_writer_engine → Mongo + tick_buffer
```

## 10.3 Why the Old Diagram Is Obsolete

Old doc showed `Broker WS → connection_engine → websocket_engine → feature/risk/order/session → EventBus publish market_data_{type}{symbol} → connection_manager → frontend WS#2 tabs (max 20 per tab)` and a `feed_relay_01/02/03` table. That **inverted** ownership: `connection_engine` normalize/validate claims belonged to `WebSocketEngine`, and `connection_manager` was incorrectly the upstream broker subscriber. The `feed_relay` collection is historical; current store is `ticks` + `instruments` via `db_writer_engine`. Payloads are `TICK_VALIDATED` envelopes, not `market_data_{type}{symbol}`.

## 10.4 Subscription Restoration (Daily Full-Market)

At 09:15 disconnect → `ws_manager._supervisor_restore_subscriptions` rebuilds from `SessionManager.daily_intent_snapshot().daily_universe_desired>0` (full NSE universe), with Mongo `stocks` only when no intent has been applied (legacy `≤8` rows). Never silently shrink a `~2600` universe to active stocks. Expired/inactive rows go to `to_unsub`. Verified via `KOTAK_*_AUDIT` §18 reconnect traces.

## 10.5 Frontend Consumption

```
Frontend Trading/MarketWatch pages: WS#3 channel trading|watchlist|market_watch
  + REST fallback: POST /api/trading/quote (ltp+ohlc) + GET /api/search
```
Pages patch `quoteState` from `RealtimeClient.ticks` (latest-value merge, never whole-list replacement, never `0` when data unavailable → state `WAITING/STALE/OFFLINE`).

## 10.6 Observability

Live feed pane `windowSec=10` `ticks_per_second` + `messages_per_sec` + `last_tick_at` via `GET /api/services/websocket/live-feed`; `last_tick_at` age drives `FEED_CONNECTED/DISCONNECTED` → `market_watch_engine._feed_state`. Persisted history via `services/websocket_history_service` (TTL).
