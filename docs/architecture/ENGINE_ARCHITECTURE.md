# Engine Architecture

The terminal runs a layered set of engines. Each engine has a **lifecycle**
(registered → starting → running → stopping → stopped), exposes **health**,
and communicates through a shared typed **Engine Event Bus**. The central
**Engine Registry** controls all engines from one place.

## Layers

```
┌──────────────────────────────────────────────────────────────┐
│                       UI (Next.js)                           │
│  Service Control Center  ·  System Indicators  ·  Logs       │
└───────────────▲───────────────────────────────▲──────────────┘
                │ /api/services/engines/*        │ realtime (WS#2)
┌───────────────┴───────────────────────────────┴──────────────┐
│              Engine Registry (services/engine_registry.py)   │
│   register / start / stop / restart / health / metrics       │
└───────────────▲───────────────────────────────┬──────────────┘
                │ writes                        │ reads
        ┌───────┴───────────────┐        ┌──────┴───────────────┐
        │   Engine Event Bus    │        │  Broker Registry     │
        │  (typed pub/sub)      │        │  trading ↔ market    │
        └───────▲───────────────┘        │  data separation     │
                │                         └─────────────────────┘
┌───────────────┴──────────────────────────────────────────────┐
│                         ENGINES                              │
│                                                              │
│  Market Data   Feature · Search · Watchlist · WebSocket(#1)  │
│  Trading       Order · Position · Risk · PnL · Margin ·      │
│                Square-Off                                    │
│  System        Scheduler · Session Manager · Connection      │
│                Manager · Notification · Storage/Audit        │
│  Advisory      Market Coach · Model Group (planned)          │
└──────────────────────────────────────────────────────────────┘
```

## Engine Base

All engines inherit from `EngineBase`
(`core/engines/engine_base.py`), which provides:

| Concern | Facility |
|---------|----------|
| State | `REGISTERED / STARTING / RUNNING / STOPPING / STOPPED / ERROR` |
| Health | `UNKNOWN / HEALTHY / DEGRADED / UNHEALTHY` |
| Lifecycle | `start() / stop() / restart()` driven by `_on_start()` / `_on_stop()` |
| Heartbeat | `heartbeat()` records last-local-beat; staleness flags DEGRADED |
| Metrics | `set_metric() / get_metrics()` (running counts + custom) |
| Errors | `record_error()`; most recent N retained per engine |
| Activity | event counters (`record_event()`) |
| Dependencies | `set_dependencies([...])`; used by the Registry |
| Snapshot | `status_snapshot()` — one dict feeding registry + API + UI |

Engines that must not be stopped silently (order, position, web socket,
connection manager, square-off) are protected by the registry's
`requires_confirmation` safety flag.

## Event Bus

`EngineEventBus` (`services/engine_event_bus.py`) is a typed, async, in-process
pub/sub bus. Engines publish `EngineEvent`s; consumers subscribe to specific
event types or a wildcard queue. Delivered events are also kept in a bounded
history (`get_history()`) and counted (`stats()`).

Canonical event families: lifecycle, session, connection, websocket, broker,
market data, features, orders, positions, margin, square-off, suggestions,
notifications, watchlist, market coach, storage.

## Broker Registry

`BrokerRegistry` (`brokers/broker_registry.py`) keeps **trading broker** and
**market-data broker** independently selectable. Capabilities are honest:

| Broker | Trading | Market Data | Notes |
|--------|---------|-------------|-------|
| kotak | ✅ | ✅ | implemented (Kotak Neo / WS feed) |
| shoonya | ⛔ NOT IMPLEMENTED | ⛔ NOT IMPLEMENTED | blocked, never faked |
| dummy | simulated | simulated | paper/demo execution |

Status reads live sources (`ws_manager.status()` for the WebSocket feed, the
broker adapter login state for trading) so the UI always shows ground truth.

## Control Plane

`api/engine_control.py` exposes `/api/services/engines/*`:

- `GET /summary`, `GET /all`, `GET /status/{id}`, `GET /health/{id}`,
  `GET /metrics/{id}`, `GET /dependencies/{id}`, `GET /errors/{id}`, `GET /activity/{id}`
- `POST /start/{id}`, `POST /stop/{id}`, `POST /restart/{id}`, `POST /heartbeat/{id}`
- `POST /health-check-all`, `POST /heartbeat-all`
- `GET/POST /broker/*` (status, trading, market-data, select)

It is mounted in `app.py` alongside the existing routers; engine registration
happens in `lifespan()`.