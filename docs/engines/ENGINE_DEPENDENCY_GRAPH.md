**STATUS: MIGRATED 2026-09-23 � now 4-WS (WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend per 08_WEBSOCKET_ARCHITECTURE.md).**

# ENGINE DEPENDENCY GRAPH — KAUSTUBH Trading Terminal

> **Part 28**: Actual runtime dependency graph based on code analysis and the
> Engine Registry `GET /api/services/engines/dependency-graph` endpoint.

## Engine Dependency Edges

```
feature_engine        → [websocket_engine, connection_manager]
watchlist_engine      → [websocket_engine]    (implicit, via TICK_VALIDATED)
market_coach          → [feature_engine]       (implicit, reads feature cache)
storage_engine        → []                     (standalone)
search_engine         → []                     (standalone, instrument cache)
margin_engine         → []                     (standalone, broker adapter)
squareoff_engine      → [position_engine, order_engine, margin_engine]
db_writer_engine      → [websocket_engine, connection_manager]  (tick + audit pipelines; consumes the same validated tick stream, writes to MongoDB)

# Facade engines (managed=True, reflect pre-existing subsystems):
scheduler_engine      → []                     (manages kotak_session, ws_manager)
session_manager       → []                     (central session authority)
connection_manager    → []                     (WS#2 backend→frontend)
websocket_engine      → []                     (WS#1 broker feed)
order_engine          → []                     (trading adapter)
position_engine       → []                     (trading adapter)
notification_engine   → []                     (notification center)

# External dependencies (not engines, but critical runtime deps):
ws_manager            → kotak_session (SFeedWebSocket owner)
scheduler             → ws_manager, kotak_session, session_manager
feature_engine        → EngineEventBus (TICK_VALIDATED subscription)
watchlist_engine      → EngineEventBus (TICK_VALIDATED subscription)
market_coach          → feature_engine cache (polling)
```

## Visual Graph (ASCII)

```
                    ┌──────────────────────┐
                    │  Kotak SDK Session   │
                    │  (kotak_session)     │
                    └────────┬─────────────┘
                             │ owns
                    ┌────────▼─────────────┐
                    │   WebSocketManager   │ ◄── ws_manager (WS#1 broker feed)
                    │  (SFeedWebSocket)    │
                    └────────┬─────────────┘
                             │ _publish_hook
              ┌──────────────▼──────────────┐
              │     WebSocketEngine         │ ← WS Engine (canonical stream)
              │  (ws_socket/engine/engine)  │
              │  NOW: publishes TICK_*      │
              └──────────┬─────────────────┘
                         │ EngineEventBus
          ┌──────────────┼──────────────┐
          │              │              │
┌─────────▼─────┐ ┌──────▼──────┐ ┌─────▼──────┐
│ Feature Engine│ │Watchlist Eng│ │ Market Coach│
│ (VWAP,SMA,..) │ │(LTP cache)  │ │ (analytics) │
└───────────────┘ └─────────────┘ └─────────────┘

┌───────────────────────────────────────────────────┐
│              Facade Engines (managed=True)         │
│  SchedulerEngine | SessionManager | Gateway       │
│  OrderEngine | PositionEngine | WebSocketFacade   │
│  NotificationCenter                               │
│  → Reflect real subsystem state; no duplication    │
└───────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────┐
│              Standalone Engines (managed=False)    │
│  SearchEngine | MarginEngine | SquareoffEngine     │
│  StorageEngine                                    │
│  → No external deps or minor deps                 │
└───────────────────────────────────────────────────┘
```

## Tick Flow (Event Bus → Engines)

```
Broker WS (Kotak SFeed)
  → ws_manager._on_message()          [socket thread]
  → ws_engine.on_feed_message()       [socket thread, sync]
  → canonicalize() → _flat_tick()     [normalize to consumer contract]
  → _queue_bus_event(TICK_VALIDATED)  [thread-safe queue.put_nowait]
  → _drain_event_loop()               [async task, drains to event bus]
  → EngineEventBus.publish(EngineEvent(TICK_VALIDATED, ...))
  → FeatureEngine._listen_loop()      [async, gets from queue]
  → WatchlistEngine._listen_loop()    [async, gets from queue]
```

## Lifecycle Ownership

| Engine | Owned By | Start | Stop |
|--------|----------|-------|------|
| feature_engine | Registry (EngineBase) | `app.py` lifespan | `app.py` shutdown |
| search_engine | Registry (EngineBase) | `app.py` lifespan | `app.py` shutdown |
| margin_engine | Registry (EngineBase) | registered only | n/a |
| squareoff_engine | Registry (EngineBase) | registered only | n/a |
| watchlist_engine | Registry (EngineBase) | `app.py` lifespan | `app.py` shutdown |
| market_coach | Registry (EngineBase) | `app.py` lifespan | `app.py` shutdown |
| storage_engine | Registry (EngineBase) | `app.py` lifespan | `app.py` shutdown |
| db_writer_engine | Registry (EngineBase) | `app.py` lifespan | `app.py` shutdown |
| scheduler_engine | Facade → SchedulerController | `app.py` lifespan sync | n/a (managed by scheduler) |
| session_manager | Facade → CentralSessionManager | `app.py` lifespan sync | n/a |
| connection_manager | Facade → ConnectionEngine | `app.py` lifespan sync + start() | `app.py` shutdown |
| websocket_engine | Facade → WebSocketEngine (wired) | `app.py` lifespan sync | n/a |
| order_engine | Facade → OrderEngine (module) | `app.py` lifespan sync | n/a |
| position_engine | Facade → PositionEngine (module) | `app.py` lifespan sync | n/a |
| notification_engine | Facade → NotificationCenter | `app.py` lifespan sync | n/a |

---

*Generated: 2026-09-14 | Verified: live GET /api/services/engines/dependency-graph + code audit*

