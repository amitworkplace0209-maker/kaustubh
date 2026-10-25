# PROJECT_GLOSSARY.md

## KAUSTUBH Trading Platform - Terminology Glossary

**Last Updated**: 2026-09-28
**Status**: ACTIVE

---

## Trading & Market

| Term | Definition |
|------|-----------|
| **LTP** | Last Traded Price — most recent transaction price for an instrument |
| **OHLC** | Open, High, Low, Close — four core price fields for a candle/interval |
| **Depth** | Order-book bid/ask levels (5-level in Kotak Neo API) |
| **MTM** | Mark-to-Market — unrealized P&L on open positions |
| **P&L** | Profit and Loss (realized when closed, unrealized while open) |
| **Square-off** | Automatic closure of all open positions near session end (15:16 IST) |
| **Square-off Engine** | Engine responsible for time-based position closure |
| **Target** | Price target per symbol used to trigger alerts/exit |
| **Basket** | A named group of symbols submitted together as orders |
| **OI** | Open Interest — total outstanding derivative contracts |
| **FII / DII** | Foreign/Domestic Institutional Investors (market participants) |
| **AUTO / LMT / SLT / SL-MKT** | Order variety: market, limit, stop-limit, stop-market |
| **NRML / CNC** | Order product: intraday normal, cash-and-carry |
| **MTF / MIS** | Product variants: normal, intraday squared-off |
| **EQ / FNO / CDS** | Exchange segments: equities, F&O, currency derivatives |
| **Token** | Broker instrument identifier (e.g. `3045` for RELIANCE) |
| **ISIN** | International Securities Identification Number |
| **DP** | Delivery percentage |
| **Exposure** | Total deployed capital across positions |
| **Margin** | Capital blocked/available for trading |

---

## Broker

| Term | Definition |
|------|-----------|
| **Kotak Neo** | Primary broker; REST + 2 WebSocket feeds (SFeed, OrderFeed) |
| **Shoonya** | Secondary broker (Finvasia); REST + WebSocket, OAuth login |
| **Dummy** | Paper-trading adapter; mock orders, live Kotak LTP feed |
| **Broker Terminal** | Per-broker session context (session token, orders, positions) |
| **broker_manager** | Module selecting and routing to the active broker adapter |
| **broker_registry** | Registry of available broker adapters |
| **Broker Mode** | Config value selecting active broker (`kotak`/`shoonya`/`dummy`) |
| **TOTP** | Time-based One-Time Password for Kotak login |
| **MPIN** | 4-digit PIN for Kotak API authentication (PBKDF2-hashed) |
| **OAuth** | Open authorization used for Shoonya login |
| **SFeed** | Kotak market data WebSocket feed (WS#1) |
| **OrderFeed** | Kotak order/position WebSocket feed (WS#2) |
| **KotakNeoApi** | Python SDK package name (`kotakneoapi`) |

---

## Engine Architecture

| Term | Definition |
|------|-----------|
| **Engine** | Autonomous unit with lifecycle, state, metrics, and event subscriptions |
| **Native Engine** | Engine with full lifecycle (start/stop/heartbeat) managed by registry |
| **Facade Engine** | Thin wrapper delegating to a service/singleton |
| **EngineBase** | Base class all engines extend |
| **Engine Registry** | Runtime map of `engine_id → engine instance` |
| **State Stamp** | Timestamp + state field on each engine for lifecycle tracking |
| **Health** | Engine health: `HEALTHY` / `DEGRADED` / `UNKNOWN` / `UNHEALTHY` |
| **Engine State** | `REGISTERED` / `STARTING` / `RUNNING` / `STOPPED` / `ERROR` |
| **Auto-Start** | Whether engine starts on backend boot |
| **dependency-graph** | DAG of engine-to-engine dependencies |
| **Engine Metrics** | Counters/timers exposed via `/api/services/engines/{id}/metrics` |

---

## Session & Subscriptions

| Term | Definition |
|------|-----------|
| **Session Manager** | Single source of truth for subscriptions, instruments, daily intent |
| **Instrument Store** | Session Manager's in-memory instrument registry |
| **Daily Intent** | Desired subscription set for the current trading day |
| **Revision** | Monotonic counter for subscription state changes |
| **Subscription Registry** | Merges/dedupes/diffs broker feed requirements |
| **Feed-level** | Broker-level feed key (e.g. `CM`, `FO`) |
| **Reconcile** | Align Session Manager intent with actual broker subscription state |
| **Connection Manager** | Engine managing all WebSocket connections and distribution |
| **Pin** | User-marked priority instrument |
| **Expiry** | Contract expiry date for derivative instruments |

---

## WebSocket

| Term | Definition |
|------|-----------|
| **WS#1** | Kotak SFeed → backend (market data) |
| **WS#2** | Kotak OrderFeed → backend (orders/positions) |
| **WS#3** | backend → frontend (realtime distribution) |
| **WS#4** | frontend → backend (commands/control) |
| **Realtime Gateway** | `api/ws_gateway.py`; multiplexes WS#3 + WS#4 on `/ws/realtime` |
| **Heartbeat** | Periodic ping/pong for liveness detection |
| **Backoff** | Exponential reconnect delay |
| **Drain** | Graceful flush of buffered events to consumer |
| **Field Profile** | Per-instrument field-name mapping (broker → canonical) |
| **Field Verification** | Validation that broker field maps correctly |

---

## Database

| Term | Definition |
|------|-----------|
| **Motor** | Async MongoDB driver for Python |
| **TTL Index** | MongoDB index that auto-deletes documents after expiry |
| **Tick Buffer** | In-memory buffer batching tick writes to MongoDB |
| **DB Writer Engine** | Sole owner of persistence to MongoDB |
| **Bulk Insert** | Batched `insert_many` for performance |
| **Audit Log** | Compliance trail of all decisions/actions |
| **Collection** | MongoDB document group (orders, positions, etc.) |
| **Estimated Document Count** | Fast approximate count (metadata-based) |
| **atlas_cleanup** | Scheduled Atlas-side cleanup job |

---

## Scheduler & Lifecycle

| Term | Definition |
|------|-----------|
| **Scheduler** | Engine orchestrating daily trading-session lifecycle |
| **Phase** | Time-window stage of trading day (pre-market, limit, equilibrium, buffer, live) |
| **Readiness Check** | Gate verifying all engines healthy before advancing phase |
| **Pre-Market** | 09:00–09:05 phase before live feed |
| **Equilibrium** | 09:10 phase transition event |
| **Buffer** | 09:12 controlled-transition phase |
| **Live Feed** | 09:15–15:30 active market data phase |
| **Logout** | 16:00 broker session termination |

---

## Frontend

| Term | Definition |
|------|-----------|
| **App Router** | Next.js filesystem routing (folder-based) |
| **Route Group** | Folder named `(name)` — organizes code without affecting URL |
| **Private Folder** | Folder named `_name` — excluded from routing |
| **PWA** | Progressive Web App (installable, offline-capable) |
| **Resizable Panels** | `react-resizable-panels` trading terminal layout |
| **Radix UI** | Headless accessible component primitives |
| **Tailwind CSS** | Utility-first CSS framework |
| **Recharts** | Charting library |
| **Zod** | Runtime schema validation |
| **Sonner** | Toast notification library |
| **Shadcn** | UI patterns built on Radix + Tailwind |
| **lib/realtime-ws.ts** | Frontend WS#3/WS#4 client |

---

## Security

| Term | Definition |
|------|-----------|
| **JWT** | JSON Web Token for backend API authentication |
| **WebAuthn** | FIDO2 passwordless authentication (biometric/hardware key) |
| **PBKDF2** | Password-Based Key Derivation Function 2 — PIN hashing |
| **App Lock** | Terminal lock screen (PIN-gated) |
| **Mode Lock** | Trading mode lock preventing accidental trades |
| **CORS** | Cross-Origin Resource Sharing |
| **TTL (auth)** | Token Time To Live |

---

## Observability

| Term | Definition |
|------|-----------|
| **structlog** | Python structured logging library (JSON output) |
| **Event Ledger** | Persistent log of all significant system events |
| **Telemetry** | Metrics, latency, error-rate tracking |
| **Insight Card** | Dashboard summary widget |
| **Incident** | Correlated group of errors/telemetry anomalies |
| **Attention Queue** | Items requiring human action |
| **Daily Report** | Automated end-of-day summary |

---

## Status Markers (per `PROJECT_IMPLEMENTATION_RULE.md`)

| Marker | Meaning |
|--------|---------|
| `VERIFIED` | Confirmed by code inspection or test |
| `NOT_VERIFIED` | Requires running system |
| `UNKNOWN` | Not determinable |
| `DOCUMENTATION_CODE_CONFLICT` | Docs and code disagree |
| `DUPLICATE_OR_POSSIBLE_DUPLICATE` | Overlapping implementations |
| `DEPENDENCY_UNRESOLVED` | Dependency unclear |
| `DOCUMENTATION_GAP` | Documented or implied but missing |
| `PARTIALLY_COMPLETE` | Some items done, some outstanding |
| `COMPLETE` | All items done and verified |
| `BLOCKED` | Cannot proceed |

---

## Related Documents
- `ARCHITECTURE_OVERVIEW.md` — System layers
- `../broker/BROKER_INTEGRATION_MAP.md` — Broker capabilities
- `../architecture/FAILURE_AND_RECOVERY.md` — Error semantics
