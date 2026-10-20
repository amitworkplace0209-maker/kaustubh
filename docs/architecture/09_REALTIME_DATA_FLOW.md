# 09_REALTIME_DATA_FLOW.md — Realtime Data Flow Architecture

**STATUS: CURRENT — Migrated 2026-09-23 to 4-WS model (WebSocket_ConnectionManager_Flow.md + 08_WEBSOCKET_ARCHITECTURE.md)**

## 9.1 Overview

Realtime flow separates **Broker → Backend** (WS#1 market, WS#2 order/position) from **Backend → Frontend** (WS#3) and **Frontend → Backend** commands (WS#4). All backend-internal distribution uses the `EngineEventBus` (+ `state_store` bridge), never WebSocket hops. End-to-end latency target remains `<200ms` for market `TICK_VALIDATED` to `WS#3` envelope.

## 9.2 Four Domains

| Domain | Path | Protocol |
|---|---|---|
| **Market Data** | `Kotak SFeed → WS#1 → WebSocketManager → WebSocketEngine (validate/normalize) → EngineEventBus (TICK_VALIDATED) → Feature/Market Watch/Risk/ConnectionManager → WS#3 → Frontend` | `SFeedWebSocket` (`kotakneoapi` SFeed) |
| **Order/Position Events** | `Kotak OrderFeed → WS#2 → OrderFeedManager (OrderUpdate/PositionUpdate) → EngineEventBus (ORDER_UPDATE/POSITION_UPDATE) → Order Engine / Risk / Audit → ConnectionManager → WS#3 → Frontend` | `OrderFeedWebSocket` (`create_order_feed()`, `{type:cn,…}` handshake) |
| **Commands** | `Frontend → WS#4 → CommandRouter (auth → OrderEngine→Risk→Audit→Broker Terminal→Broker REST) → WS#2 confirmation → EventBus → WS#3 → Frontend` | `WS /ws/realtime` write path (`place_order/cancel/modify/square_off` with `correlation_id`) |
| **Snapshots/REST** | `Frontend → REST → backend engines → Kotak REST (authoritative)` + `Positions/Orders/Trades/Quotes` enrichment | HTTP `FastAPI` (`/api/trading/*`, `/api/search`, `/api/websocket/*`) |

Previous dual description `WS#1 broker→engines / WS#2 engines→UI` is obsolete; the new path via `EventBus` is canonical.

## 9.3 Market Data Flow (WS#1) — Detail

```
Step 1: Exchange publishes → Broker adapter (Kotak)
Step 2: SFeedWebSocket bytes → ws_manager (supervisor, market-window gated 08:55-15:31, jitter reconnect, ACK)
Step 3: WebSocketEngine.on_feed_message → canonicalize (snake→flat camel, master_canonical opt-in) → TickRouter per-consumer queues (profiles DATA_SAVER P0 / POSITION_CRITICAL P1 / WATCHLIST_LIGHT P2) + raw_store
Step 4: EngineEventBus.publish(TICK_VALIDATED flat {instrumentToken, exchangeSegment, symbol, ltp, volume, open/high/low/prevClose/netChange/prevChangePct, receivedAt, brokerUpdateTimestamp})
Step 5: FeatureEngine (TICK_VALIDATED → calculator registry), RiskEngine (tick-aware), Market Watch (eligible universe), ConnectionManager (fan-out coalesce + rate limit)
Step 6: DB Writer via DATA_SAVER drain → to_storage_doc → db_writer_engine.ingest → Mongo ticks + tick_buffer
```

**Types:** LTP/change/%/OHLC/volume/LTQ/bid/ask/spread/depth (L8 default, L16 opt-in), OI, Index, MarketStatus. Validated, never fabricated. `PREV CLOSE` sourced from tick `prev_close`, not synthesized. Stale threshold via `rt_int(ws_stale_feed_sec)`.

## 9.4 Order/Position Flow (WS#2) — Detail

```
Kotak order lifecycle → OrderFeedWebSocket (session-driven, not market-window gated)
→ OrderFeedManager._handle_message_async (JSON → typed OrderUpdate with nOrdNo→orderId mapping / PositionUpdate with flBuyQty/flSellQty/buyAmt/sellAmt)
→ EngineEventBus ORDER_UPDATE/POSITION_UPDATE (also order.updated/position.updated) + ConnectionManager._broadcast_frame(order.update→orders, position.update→positions)
→ Order Engine (order_id keyed state) + Risk/Position (netQty/avgBuy/avgSell derived, indicative MTM via WS#1 LTP) + Audit (correlation_id) → WS#3 orders/positions channels
→ REST reconciliation on reconnect (broker_cache.invalidate + positions()/order_report()/trade_report() + POSITION_RECONCILED/ORDER_RECONCILED publish)
```

`PositionUpdate` carries **no P&L** field — `unrealised = (LTP - avgBuy)*netQty` derived per §14, `realised` from REST `positions()`; charges from `trade_report()` only.

## 9.5 Frontend Delivery (WS#3) — Detail

```
EngineEventBus / state_store / event_bus → ConnectionEngine._bridge_loop + _fanout_loop
→ per-session Outbox (DROP_OLDEST, critical for orders/notifications) + coalesce (latest-wins per channel|token|segment + channel_min_interval)
→ WS#3 envelope {type, event_id:"connId:seq", timestamp, sequence, channel, symbol, instrument_token, exchange_segment, schema_version, version:"1.0", source, correlation_id, data}
   Types: market.* , order.update / order.ack, position.update / position.reconciled, system.status / engine.status, notification.new, etc.
→ Frontend RealtimeClient (single singleton, 250ms tickEpoch flush, 12s heartbeat, JWT ?token=, AUTH_FAILED 4401 permanent, 8-retry backoff)
→ Snapshot recovery: REST bootstrap (positions/orders/funds + /api/search) + WS#3 deltas; reconnect re-subscribes knownSubsRef + requestSnapshot
```

Frontend never receives raw `SFeed` bytes; backend `raw_store` remains.

## 9.6 Schema (envelope)

```json
{
  "type": "order.update | position.update | market.tick | order.ack | position.reconciled",
  "event_id": "conn_abc123:42",
  "timestamp": "2026-09-23T09:15:00.123Z",
  "sequence": 42,
  "channel": "orders | positions | trading | system | market_watch",
  "symbol": "RELIANCE", "instrument_token": "2885", "exchange_segment": "nse_cm",
  "schema_version": "1.0", "version": "1.0",
  "source": "order_feed_ws2 | ws_engine | feature | gateway",
  "correlation_id": "req_172707000_abc123",
  "data": { "orderId": "ORD123", "orderStatus": "OPEN", "filledQuantity": 5, "averagePrice": "100.5", "...": "canonical" }
}
```

## 9.7 Provenance

* Market LTP: `LIVE_WS1` (freshness `FRESH≤5s / DELAYED≤30s / STALE`)
* Order status: `BROKER_WS2` (OrderUpdate)
* Position qty/amounts: `BROKER_WS2 + REST_RECONCILED`
* Indicative P&L: `DERIVED_WS1_WS2` (WS#1 LTP × PositionUpdate)
* Confirmed P&L / Funds / Holdings / Trade ledger: `BROKER_REST`
* Configuration reconciliation: `BROKER_REST` on `WS#2 reconnect`
