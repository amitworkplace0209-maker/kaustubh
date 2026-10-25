# Real-Time Data Flow

**STATUS: OBSOLETE � Consolidated into docs/architecture/08_WEBSOCKET_ARCHITECTURE.md and docs/architecture/09_REALTIME_DATA_FLOW.md (2026-09-23). Two-WS description (WS#1 broker feed + WS#2 browser gateway) is superseded by the 4-WS model WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend. Do not add new code referencing this file � treat it as archival.**
# Real-Time Data Flow

Two WebSocket connections serve two different purposes:

- **WS #1 — Broker feed.** Managed by `WebSocketManager`
  (`ws_socket/ws_manager.py`) + `WebSocketEngine` (`ws_socket/engine/engine.py`).
  Subscribes to Kotak instrument tokens; sinks raw ticks into MongoDB via the
  Data Saver consumer (feed hook → canonical event → router → Mongo).
- **WS #2 — Control gateway to the browser.** Managed by `connection_engine`.
  Carries terminal state, audit entries, and control messages to the UI.

## Today (implemented)

```
Kotak SFeed  →  ws_shape(SDK decode validates)  ─┐
                                                ├→  ws_manager._process_tick()
                                                │      metrics / feed state / market-open
      ┌──────────────────────────────────────────┘
      ▼
WebSocketEngine Data Saver (ws_socket/engine/engine.py)
      ▼
tick_buffer.add(to_storage_doc(payload))  →  MongoDB
      ▼
MarketStateService.on_tick_received(token)  →  MARKET_OPEN / TICK_RECEIVED
      ▼
Search Engine LTP cache  (update_ltp on validated ticks)
```

## Target (intended wiring — feature/watchlist gated on TICK_VALIDATED)

The Feature Engine and Watchlist Engine already subscribe to
`EngineEvents.TICK_VALIDATED`. The remaining work is the **publisher side**: the
WebSocket Engine must publish a bus event for every validated tick. The natural
hook is `ws_manager._process_tick` (WS #1), post-SDK-decode:

```
Kotak SFeed → SDK decode (validation)
      │  accept
      ▼
ws_manager._process_tick()
      ├─ publish EngineEvent(TICK_RECEIVED,  data=raw)
      ├─ validate → publish EngineEvent(TICK_VALIDATED, data=normalized)
      ▼
Feature Engine  (change / change% / spread / VWAP / SMA-10 / SMA-60)
      ├─ publish FEATURE_CALCULATED
      ├─ → Watchlist Engine  (push to watchlists)
      └─ → Model Group (planned) → Suggestion Engine
```

Constraints honoured end-to-end:

- **No fabricated ticks.** If the SDK rejects a message, it is counted as
  rejected (`TICK_REJECTED`), not forwarded as a valid tick.
- Persistence stays in the existing pipeline (Data Saver / tick_buffer); the
  event bus is an additional pub/sub path for live feature computation, not a
  replacement for storage.
- Feature history is bounded per token (rolling window of 600 ticks), so memory
  stays flat under heavy feeds.
