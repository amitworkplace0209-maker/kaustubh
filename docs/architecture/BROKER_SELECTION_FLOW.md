# Broker Selection Flow

The Broker Registry separates **trading** from **market-data** selection. A
broker change is a stateful operation and must not corrupt a live session.

## Endpoints

| Endpoint | Action |
|----------|--------|
| `GET /api/services/engines/broker` | current selections + status (live) |
| `GET /api/services/engines/broker/trading` | trading broker status |
| `GET /api/services/engines/broker/market-data` | market-data broker status |
| `GET /api/services/engines/broker/list` | all brokers + capabilities |
| `POST /api/services/engines/broker/trading/select` | set trading broker |
| `POST /api/services/engines/broker/market-data/select` | set market-data broker |

## Selection rules (enforced in `BrokerRegistry`)

1. Unknown broker id → rejected.
2. Broker whose capability bit is `False` (`shoonya` trading or market-data)
   → rejected with `NOT IMPLEMENTED` in the error. No partial acceptance.
3. Same-broker re-selection → idempotent (no action).
4. Legitimate switch returns the broker id, its capabilities, and the next
   status snapshot.

## UI behaviour (Phase 3 Service Control Center)

Each broker card shows a selector plus the current live status badge:

```
Trading Broker  [ kotak ▾ ]        Market Data Broker [ kotak ▾ ]
  ● Connected (login: LIVE)          ● Receiving ticks (feed: RECEIVING)
```

Safe transition steps in the UI before applying a switch:

1. **Validate** — call `GET /broker` to confirm the target is implemented.
2. **Stop subscriptions** — for market-data change, unsubscribe current tokens
   from the WebSocket Engine.
3. **Disconnect** — release the current feed / pre-flight the trading adapter.
4. **Reconnect** — `POST .../select` then re-establish the feed (re-login if
   required).
5. **Resubscribe** — re-subscribe the instrument set on the new feed.
6. **Verify** — confirm `ws_manager.status()` reports `RECEIVING` (market data)
   or the new adapter reports logged-in (trading) before showing success.

A change is surfaced as a `BROKER_CHANGED` / `TRADING_BROKER_CHANGED` /
`MARKET_DATA_BROKER_CHANGED` event on the Engine Event Bus so downstream
engines (feature, watchlist, market coach) can re-arm cleanly.

## Deliberately not done

- Switching to `shoonya` "in demo mode" — there is no demo mode override; the
  separation of trading vs market-data status is additive truth, not permission
  to fake capability.