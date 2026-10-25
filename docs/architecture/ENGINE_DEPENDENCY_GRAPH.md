# Engine Dependency Graph

Dependencies are declared by each engine via `set_dependencies([...])` and are
enforced by the Engine Registry: starting an engine whose dependencies are not
RUNNING is rejected (configurable policy), and stopping a dependency while it
is in use is blocked or warns.

```
                            ┌──────────────────────┐
                            │    Scheduler         │
                            └───────┬──────────────┘
                                    │ triggers
                    ┌───────────────┼───────────────────┐
                    ▼               ▼                   ▼
           ┌──────────────┐  ┌──────────────┐  ┌────────────────┐
           │ Session Mgr  │  │ Storage/Audit│  │  Square-Off    │
           └──────┬───────┘  └──────────────┘  └──────┬─────────┘
                  │ auth/session                       │ depends on
                  ▼                                    ▼
           ┌──────────────┐  ┌────────────────────────────────────┐
           │ Connection   │  │   Position Engine  Order Engine    │
           │  Manager     │  └──────────────────┬─────────────────┘
           └──────┬───────┘                     │                  │
                  │ gives WS#2                  │ uses             │ uses
                  ▼                             ▼                  ▼
           ┌──────────────┐  ┌──────────────────────────────────────┐
           │ WebSocket    │  │  Risk Engine     Margin Engine       │
           │  Engine(#1)  │  │  PnL Engine      Notification       │
           └──────┬───────┘  └──────────────────────────────────────┘
                  │ validates & publishes TICK_VALIDATED (event bus)
                  ▼
           ┌──────────────┐  ┌──────────────────────────────────────┐
           │ Feature Eng. │  │  Watchlist · Market Coach · Search   │
           └──────┬───────┘  └──────────────────────────────────────┘
                  │ FEATURE_CALCULATED
                  ▼
           ┌─────────────────────────────────────────────────────────┐
           │  Model Group (planned)  →  Suggestion Engine            │
           └─────────────────────────────────────────────────────────┘
```

## Edge: order flow dependency chain

```
Risk/Margin validate → Order Engine → Broker Adapter (trading broker)
                             │
                             ▼
                     Position Engine ← PnL Engine
                             │
                             ▼
                    Square-Off Engine (closes net positions)
```

## Registered engines and their declared dependencies

| Engine | Category | Dependencies |
|--------|----------|--------------|
| `feature_engine` | MARKET_DATA | websocket_engine, connection_manager |
| `search_engine` | MARKET_DATA | connection_manager |
| `margin_engine` | TRADING | session_manager, connection_manager |
| `squareoff_engine` | TRADING | position_engine, order_engine, margin_engine, session_manager |
| `watchlist_engine` | MARKET_DATA | session_manager |
| `market_coach` | ADVISORY | feature_engine, watchlist_engine |
| `storage_engine` | SYSTEM | — (writes batched docs) |

Pre-existing modules (Scheduler, Session/Connection Manager, WebSocket
Engine, Position/Order/Risk/PnL/Audit, Notification Center) are wired in
`app.py` `lifespan()` and are also registered into the Engine Registry as
façade engines (`services/legacy_engine_facades.py`): `scheduler_engine`,
`session_manager`, `connection_manager`, `websocket_engine`, `order_engine`,
`position_engine`, `notification_engine`. The façades reflect each subsystem's
real state (never fabricated) and delegate start/stop only where a safe API
exists — the Service Control Center can therefore observe every engine.