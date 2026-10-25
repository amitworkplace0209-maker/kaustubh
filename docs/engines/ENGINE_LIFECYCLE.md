**STATUS: MIGRATED 2026-09-23 � now 4-WS (WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend per 08_WEBSOCKET_ARCHITECTURE.md).**

# ENGINE LIFECYCLE — KAUSTUBH Trading Terminal

> **PART 31**: How engines start, run, and stop. Facade engines delegate
> lifecycle to the underlying subsystem; native engines use the registry.

## 1. Engine Registration (Startup)

`GET /api/services/engines` enumerates **every engine actually in the system**.
Registry registration is **NOT** "running" — registered-but-not-running shows
`state: REGISTERED, health: UNKNOWN` (e.g. margin_engine, squareoff_engine,
notification_engine).

### Native engines (EngineBase, auto-start)
Created and started in `app.py` lifespan → `engine_registry.register(engine)`:
- feature_engine, search_engine, watchlist_engine, market_coach, storage_engine

### Facade engines (managed=True, reflect pre-existing subsystems)
Registered at startup; lifecycle belongs to the subsystem they wrap:
- scheduler_engine → `SchedulerController`
- session_manager → `CentralSessionManager`
- connection_manager → `ConnectionEngine`
- websocket_engine → `WebSocketEngine` (wired to ws_manager)
- order_engine, position_engine → module singletons
- notification_engine → `NotificationCenter`

## 2. Phase Model

Each engine reports:
- `initPhase` — how it was created/registered
- `runPhase` — what triggers work
- `runCadence` — how often work happens

| Engine | runPhase | runCadence |
|--------|----------|-----------|
| feature_engine | event-driven (TICK_VALIDATED) | per-tick |
| watchlist_engine | event-driven (TICK_VALIDATED) | per-tick |
| market_coach | event-driven + time-driven | periodic |
| storage_engine | event-driven (STORAGE_WRITE_COMPLETE) | periodic flush |
| search_engine | on-demand (query) | per-request |
| scheduler_engine | reconciler loop | 5s tick |
| session_manager | on-demand (mode switch / login) | on-change |
| connection_manager | on-demand (WS#2 fan-out) | on-event |

## 3. Stop / Shutdown

`app.py` shutdown:
- `engine_registry.stop_all()` → native engines' `.stop()`
- `ws_engine.stop_event_bridge()` → drains pending TICK events
- facade engines reflect the subsystem shutdown itself

## 4. Health Model

- `periodic heartbeat`: registry tracks `lastHeartbeat`; stale → STALE/UNHEALTHY
- `on-change`: facade engines snapshot live subsystem state every reconcile
- `realStatus` field: omitted unless the facade has real subsystem state
- Honest reporting: UNKNOWN is used when no health evidence exists

---

*Generated: 2026-09-14 | Part 31*




KAUSTUBH / KDS --- MASTER ENGINE LIFECYCLE & CONNECTION FLOW

Detailed Engine-to-Engine Architecture, Startup, Runtime, Event, Trading, Market-Data, Shutdown and Failure Flow

Document type: Architecture / Lifecycle / Integration Design
Scope: Backend engine architecture + frontend realtime boundary +
broker boundary + persistence
Architecture basis: Existing engine audit plus the approved
target-engine design direction
Important: This document separates verified current code flow
from the target integration contract where the architecture has
intentionally been redesigned/merged.

1. Architecture Objective

KAUSTUBH is not a collection of independent engines. It is a coordinated
runtime in which:

Scheduler Engine controls when lifecycle phases happen.

Session Manager controls broker session/subscription state.

Broker Terminal Engine controls broker terminal/account state
and adapter boundary.

WebSocket Engine controls the canonical broker market-data
stream (WS#1).

Feature Engine, Watchlist Engine, and Market Watch Engine
consume market data.

Connection Manager controls backend → frontend realtime delivery
(WS#2).

Risk Engine is the final deterministic trading gate and contains
the merged Position/P&L capability layer.

Order Engine is the single trading-execution choke point and
contains the merged Basket capability.

Target Engine can request exits through Order Engine.

Squareoff Engine can request controlled end-of-day exits through
Order Engine.

Margin Engine controls AI capital allocation/reservation and
exposes allocation capacity to trading flows; it does not replace
final Risk validation.

Audit Engine records immutable operational/trading decisions.

Notification Engine turns important system events into user-facing
notifications/alerts.

DB Writer Engine and Storage Engine persist/monitor
infrastructure state without blocking realtime trading paths.

2. Engine Count and Naming

2.1 Top-level engines

The current target architecture has 18 top-level engines:

Feature Engine

Search Engine

Watchlist Engine

Market Watch Engine

Scheduler Engine

Session Manager

Connection Manager

WebSocket Engine

DB Writer Engine

Margin Engine

Squareoff Engine

Risk Engine

Broker Terminal Engine

Audit Engine

Notification Engine

Order Engine

Target Engine

Storage Engine

2.2 Merged capabilities

Two former engine responsibilities are intentionally internalized:

Position capability → Risk Engine

P&L capability → Risk Engine

Basket capability → Order Engine

Therefore they are not separate top-level engines in this architecture.

If an old code inventory still lists position_engine, pnl_engine,
or basket_engine, treat those names as legacy implementation
concepts until the code migration is complete.

3. Connection Model

There are four different connection categories. They must not be
confused.

3.1 Control connection

Scheduler Engine
      ↓
Session Manager
      ↓
Broker Terminal Engine

Purpose: - login/session lifecycle - market phase control - session
expiry - terminal readiness

3.2 Broker market-data connection --- WS#1

Kotak Broker
    ↓
ws_manager / broker socket
    ↓
WebSocket Engine

WebSocket Engine is the canonical broker-feed owner.

Consumers do not open their own Kotak market-data WebSockets.

3.3 Internal engine/event connection

WebSocket Engine
      ↓
Engine Event Bus
      ↓
Feature / Watchlist / Market Watch / other consumers

This is an internal event/data contract, not another broker socket.

3.4 Frontend realtime connection --- WS#2

Backend engines
      ↓
Connection Manager
      ↓
WS#2
      ↓
Next.js frontend

The frontend must not directly connect to Kotak WS#1.

4. Master Dependency Graph

                         ┌──────────────────────┐
                         │   Scheduler Engine   │
                         │  Time / Phase Owner  │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │   Session Manager    │
                         │ Session + Subscribe  │
                         └───────┬───────┬──────┘
                                 │       │
                    ┌────────────┘       └───────────────┐
                    ▼                                    ▼
        ┌────────────────────┐                ┌────────────────────┐
        │ Broker Terminal    │                │ WebSocket Engine   │
        │ Engine             │                │ Broker WS#1        │
        └─────────┬──────────┘                └─────────┬──────────┘
                  │                                     │
                  │                                     ▼
                  │                            ┌─────────────────┐
                  │                            │ Engine Event Bus│
                  │                            └───────┬─────────┘
                  │                                    │
                  │                 ┌──────────────────┼─────────────────┐
                  │                 ▼                  ▼                 ▼
                  │        Feature Engine       Watchlist Engine   Market Watch
                  │                 │                  │                 │
                  │                 └──────────────────┴─────────────────┘
                  │                                    │
                  │                                    ▼
                  │                           Connection Manager
                  │                                    │
                  │                                    ▼
                  │                                  WS#2
                  │                                    │
                  │                                    ▼
                  │                               Next.js UI
                  │
                  └──────────────────────┐
                                         ▼
                                  Risk Engine
                                  ├─ Position capability
                                  └─ P&L capability
                                         │
                         ┌───────────────┼────────────────┐
                         ▼               ▼                ▼
                 Margin Engine      Audit Engine     Order Engine
                         │                                │
                         │                                ▼
                         │                         Broker Terminal
                         │                         Adapter / API
                         │                                │
                         └────────────────────────────────┘
                                                          │
                                                          ▼
                                                 Risk Position/P&L
                                                          │
                                  ┌───────────────────────┼──────────────────┐
                                  ▼                       ▼                  ▼
                            Target Engine          Squareoff Engine   Connection Manager
                                  │                       │                  │
                                  └──────────→ Order Engine ←───────────────┘

Persistence side:

WebSocket / engines
        ↓
   DB Writer Engine
        ↓
   Storage Engine
        ↓
      MongoDB

5. Startup Lifecycle

Startup must be deterministic. No engine should randomly start because
another engine happened to import it.

Phase 0 --- Process bootstrap

FastAPI process
   ↓
configuration load
   ↓
logging / DB / infrastructure initialization
   ↓
Engine Registry available
   ↓
Engine Event Bus available

Required state:

Registry = READY
EventBus = READY
Database = READY / DEGRADED

6. Startup Order

Recommended dependency-safe order:

1. Storage Engine
2. DB Writer Engine
3. Notification Engine
4. Audit Engine
5. Risk Engine
6. Session Manager
7. Broker Terminal Engine
8. Scheduler Engine
9. Connection Manager
10. WebSocket Engine
11. Feature Engine
12. Search Engine
13. Watchlist Engine
14. Market Watch Engine
15. Margin Engine
16. Target Engine
17. Order Engine
18. Squareoff Engine

This is a dependency initialization order, not necessarily a strict
synchronous start() chain.

Engines should become READY only after their mandatory dependencies
are available.

7. Why This Startup Order Exists

Storage first

Audit, notifications and operational state may need persistence
immediately.

Storage
   ↓
DB Writer

Without persistence infrastructure, the application can still run in
degraded mode, but must explicitly report that condition.

Session before WebSocket

Session Manager
   ↓
valid broker session
   ↓
WebSocket Engine

A broker market-data connection should not assume a valid authenticated
session.

WebSocket before market-data consumers

WebSocket Engine
   ↓
Event Bus
   ↓
Feature / Watchlist / Market Watch

Consumers can start earlier only if they explicitly support NO_FEED
state.

Risk before Order

Risk Engine
   ↓
Order Engine

Order Engine must never create an execution path that can bypass Risk
Engine.

8. Scheduler Lifecycle

Scheduler Engine is the temporal authority.

It does not perform every business action itself. It emits/initiates
phase transitions.

Conceptual state:

OFF_DAY
   ↓
PRE_OPEN
   ↓
LOGIN
   ↓
PREPARE
   ↓
MARKET_READY
   ↓
TRADING
   ↓
PRE_SQUAREOFF
   ↓
SQUAREOFF
   ↓
POST_MARKET
   ↓
DISCONNECT
   ↓
LOGOUT
   ↓
OFF_DAY

The exact clock configuration remains policy/configuration, not
hard-coded business logic in every engine.

9. Market-Day Lifecycle

9.1 Login phase

Scheduler
   ↓ LOGIN
Session Manager
   ↓
Broker Terminal Engine
   ↓
Broker authentication
   ↓
terminal/session READY

Broker Terminal Engine reports:

connectionState = CONNECTED
sessionState = AUTHENTICATED

If authentication fails:

Broker Terminal
      ↓
ERROR / DEGRADED
      ↓
Notification Engine
      ↓
Connection Manager
      ↓
UI

Scheduler may retry according to policy.

10. Instrument Preparation

After broker session readiness:

Session Manager
    ↓
instrument registry / subscription registry
    ↓
Search Engine
    ↓
instrument index

Search Engine owns lookup/indexing.

It does not own the broker feed.

11. WebSocket Preparation

Scheduler
   ↓ PREPARE / CONNECT
Session Manager
   ↓
WebSocket Engine
   ↓
ws_manager
   ↓
Kotak WS#1

WebSocket Engine responsibilities:

connect

authenticate/handshake where required

subscribe

normalize ticks

validate ticks

detect gaps/latency/quality problems

reconnect with backoff

expose connection state

12. Subscription Flow

Subscription ownership must be centralized.

UI / Market Watch / Watchlist
             ↓
       Session Manager
             ↓
      subscription registry
             ↓
       WebSocket Engine
             ↓
          Broker WS#1

Do not allow:

Market Watch → Kotak directly
Watchlist → Kotak directly
Feature Engine → Kotak directly

That creates multiple sockets, duplicated subscriptions and inconsistent
feed state.

13. Real-Time Tick Flow

This is the most important market-data path.

Kotak WS#1
    ↓
ws_manager
    ↓
WebSocket Engine
    ↓
raw tick normalization
    ↓
tick validation / quality checks
    ↓
EngineEventBus
    ↓
TICK_VALIDATED

Then fan-out:

                    TICK_VALIDATED
                         │
        ┌────────────────┼─────────────────┐
        ▼                ▼                 ▼
 Feature Engine    Watchlist Engine   Market Watch Engine
        │                │                 │
        ▼                ▼                 ▼
 features/cache      LTP cache        live market state
        │                │                 │
        └────────────────┼─────────────────┘
                         ▼
                 Connection Manager
                         ↓
                        WS#2
                         ↓
                      Frontend

14. Feature Engine Connection

Feature Engine subscribes to validated ticks.

WebSocket Engine
      ↓
TICK_VALIDATED
      ↓
Feature Engine
      ↓
VWAP / SMA / volatility / momentum /
change% / spread / rolling metrics

Feature Engine must not:

execute orders

own broker authentication

own subscriptions

directly push to browser

replace Risk Engine

Its output is analytical market state.

15. Watchlist Engine Connection

Search Engine
     ↓
instrument identity
     ↓
Watchlist Engine
     ↑
TICK_VALIDATED
     ↑
WebSocket Engine

Watchlist Engine maintains:

selected symbols

current LTP

change

relevant live fields

subscription relationship

Frontend delivery:

Watchlist Engine
      ↓
Connection Manager
      ↓
WS#2
      ↓
Watchlist UI

16. Market Watch Engine Connection

Market Watch uses the broker/instrument universe for discovery and
WebSocket data for live state.

Correct separation:

Instrument/Scrip Master
        ↓
Market Watch universe
        ↓
eligible symbols/tokens
        ↓
Session Manager subscription registry
        ↓
WebSocket Engine
        ↓
TICK_VALIDATED
        ↓
Market Watch live state

Every ranking interval:

live state
   ↓
snapshot
   ↓
ranking
   ├── Top Gainers
   ├── Top Losers
   ├── Highest Volume
   ├── strong/weak movers
   └── configured filters

Automatic pin logic is internal Market Watch logic:

30-sec snapshot
   ↓
Top-5 Gainers / Top-5 Losers
   ↓
appearance counters
   ↓
dynamic pin replacement

Market Watch does not become the owner of WebSocket transport.

17. Search Engine Runtime Flow

Search is request-driven.

User types query
      ↓
Frontend
      ↓
Search API / backend
      ↓
Search Engine
      ↓
instrument index
      +
live LTP cache where available
      ↓
ranked results
      ↓
Connection/API response
      ↓
UI

For a trading result:

Search result
    ↓
instrument/token/terminal context
    ↓
Order Ticket

Search does not execute the order.

18. Frontend Realtime Boundary

The frontend must have one controlled realtime backend boundary.

Backend Event Sources
   ├─ Market Data
   ├─ Orders
   ├─ Positions
   ├─ P&L
   ├─ Risk
   ├─ Notifications
   ├─ Scheduler
   ├─ Broker Terminal
   └─ Engine Health
          ↓
Connection Manager
          ↓
       WS#2
          ↓
     Next.js Client

Suggested channel families:

MARKET_CHANNELS
- watchlist
- market_watch
- trading
- ai

STATE_CHANNELS
- positions
- orders
- notifications
- system
- data
- engines

19. Broker Terminal Engine

Broker Terminal Engine is the broker integration/state boundary.

Order / Risk / Session / UI request
                ↓
       Broker Terminal Engine
                ↓
          Broker Adapter
       ┌────────┼─────────┐
       ▼        ▼         ▼
     Kotak    Shoonya   Dummy

It normalizes:

funds

margin

orders

positions

holdings

broker P&L

capabilities

connectivity

latency

sync state

It must preserve source attribution:

terminal_id
broker
account
source
last_sync

It must not silently merge incompatible broker fields.

20. Trading Order Master Flow

All order sources converge into Order Engine.

MANUAL
   │
AI
   │
BASKET
   │
TARGET EXIT
   │
SQUAREOFF
   │
SYSTEM
   │
   └──────────────┐
                  ▼
             ORDER ENGINE
                  ↓
             request normalize
                  ↓
             idempotency check
                  ↓
             Risk Engine
                  ↓
        PASS / WARNING / BLOCK /
        EMERGENCY_BLOCK
                  ↓
             Audit Engine
                  ↓
       Broker Terminal Engine
                  ↓
             Broker Adapter
                  ↓
          broker response
                  ↓
       execution normalization
                  ↓
       Position/P&L capability
                  ↓
       Target / Squareoff state
                  ↓
       Connection Manager
                  ↓
                  UI

21. Risk Engine Flow

Risk Engine is a hard gate.

Order Engine
     ↓
Risk Engine
     ↓
collect authoritative state
     ├── account/capital
     ├── margin
     ├── exposure
     ├── P&L
     ├── position
     ├── circuit
     ├── market quality
     ├── trading phase
     └── source type
     ↓
evaluate ALL applicable rules
     ↓
decision

Possible result:

PASS
WARNING
BLOCK
EMERGENCY_BLOCK

Risk Engine must preserve all applicable failure reasons, not only the
first one.

22. Position + P&L Internal Flow

These are merged capabilities, not independent top-level engines.

After broker execution or broker reconciliation:

Broker Terminal Engine
        ↓
authoritative broker position state
        ↓
Risk Engine — Position capability
        ↓
Risk Engine — P&L capability
        ↓
canonical position/P&L state

Conceptually:

position
   ↓
average price / quantity / side
   ↓
realized P&L
   ↓
unrealized P&L
   ↓
net P&L

This canonical state is then consumed by:

Risk rules

Target Engine

Squareoff Engine

UI

Audit

Notifications

23. Margin Engine Flow

Margin Engine is the AI Capital Control Layer.

It must not become a universal manual-order margin gate.

AI flow

AI Model
   ↓
Trade Suggestion
   ↓
Margin Engine
   ↓
available allocatable capital
   ↓
configured slot policy
   ↓
reservation
   ↓
quantity capacity
   ↓
Risk Engine
   ↓
Order Engine
   ↓
Broker

Example:

Available capital = ₹X
AI order slot = 20%
Allocated ceiling = ₹X × 20%
Required capital/qty = ₹Y
Maximum quantity = floor(allocated / required)

Manual order path:

User
  ↓
Order Engine
  ↓
Risk Engine
  ↓
Broker

Manual order must not silently consume AI reservation policy.

24. Audit Engine Connection

Audit is append-only.

Critical flow:

Risk Decision
    ↓
Audit Engine
    ↓
MongoDB / audit trail

For successful order:

Order request
   ↓
Risk decision
   ↓
audit
   ↓
broker request
   ↓
broker response
   ↓
execution state
   ↓
audit

Use a common:

correlation_id

so one trading action can be reconstructed end-to-end.

25. Notification Engine Flow

Notification Engine is event-driven.

Engine event
     ↓
Notification Engine
     ↓
classify
     ↓
phase
     ↓
broker
     ↓
category
     ↓
severity
     ↓
policy
     ↓
dedupe
     ↓
cooldown
     ↓
group
     ↓
persist
     ↓
deliver
     ↓
Connection Manager
     ↓
UI

Examples:

BROKER DISCONNECTED
RISK BLOCK
ORDER REJECTED
SQUAREOFF FAILED
TARGET HIT
MARGIN LOW
SESSION EXPIRING
ENGINE DEGRADED

Alert is a specialized notification; no separate Alert Engine is
required.

26. Target Engine Flow

Target Engine monitors position-specific target state.

Order execution
      ↓
actual fill
      ↓
Target Engine registers target
      ↓
Risk Engine Position/P&L capability
      ↓
live P&L
      ↓
target reached?
      ├── NO → continue monitoring
      └── YES
            ↓
       create exit request
            ↓
       Order Engine
            ↓
       Risk Engine
            ↓
       Broker Terminal

Target Engine never directly calls the broker.

27. Squareoff Engine Flow

Squareoff is a controlled lifecycle operation.

Example policy:

T-1 minute
    ↓
FREEZE
    ├─ new manual orders
    ├─ new AI orders
    ├─ new AI suggestions
    ├─ new AI allocations
    └─ new trading subscriptions

Then:

T = configured squareoff time
    ↓
cancel pending orders
    ↓
verify cancellations
    ↓
fetch broker-authoritative open positions
    ↓
if positions > 0
    ↓
create opposite-side MARKET exit requests
    ↓
Order Engine
    ↓
Risk Engine
    ↓
Broker Terminal
    ↓
verify fills / remaining quantity

Retry:

failure / remaining position
        ↓
15-sec retry interval
        ↓
re-fetch broker positions
        ↓
cancel pending orders
        ↓
close remaining positions
        ↓
verify

Squareoff must not trust only local cached positions.

28. Squareoff vs Risk Connection

Squareoff is a position-reduction operation.

Therefore:

Risk Engine
   ↓
classify request
   ↓
POSITION_REDUCTION / SQUAREOFF

Normal new-entry restrictions should not accidentally block a required
safety exit.

Emergency/global safety rules can still block if explicitly configured.

29. Order Engine + Basket Capability

Basket is internal Order Engine capability.

Basket Request
      ↓
Order Engine
      ↓
expand basket
      ↓
per-order normalization
      ↓
Risk Engine per order
      ↓
execution policy
      ├─ sequential
      ├─ controlled parallel
      └─ configured priority
      ↓
Broker Terminal

No second broker-order choke point is allowed.

30. DB Writer + Storage Flow

Realtime data must not block the trading path.

Tick / event
   ↓
tick buffer
   ↓
DB Writer Engine
   ↓
bounded queue
   ↓
Storage Engine
   ↓
batch write
   ↓
MongoDB

Example current persistence behavior observed in the audit:

batch size ≈ 100
flush interval ≈ 2 seconds

The persistence pipeline is asynchronous.

Bad architecture:

tick
 ↓
MongoDB write
 ↓
then continue

Correct architecture:

tick
 ↓
bounded buffer
 ↓
continue realtime processing
       \
        → async persistence

31. Storage Engine vs DB Writer Engine

They are different responsibilities.

DB Writer

Owns:

queueing

buffering

flush coordination

persistence pipeline

Storage

Owns:

storage/runtime health

infrastructure monitoring

DB/storage latency

queue/backlog visibility

resource monitoring

Do not turn Storage Engine into the business-data owner.

32. Engine Health Flow

Every top-level engine should expose a common health state:

STARTING
READY / RUNNING
DEGRADED
STOPPING
STOPPED
ERROR

Health aggregation:

Engine
  ↓
Engine Registry
  ↓
health/state snapshot
  ↓
Connection Manager
  ↓
WS#2
  ↓
Engine Health UI

Example:

WebSocket Engine = DEGRADED
Reason = high tick latency
Last event = 12 sec ago

This should be visible without requiring the UI to inspect internal
Python modules.

33. Failure Propagation

Failure must propagate as state/events, not uncontrolled exceptions.

WebSocket failure

WS#1 disconnect
    ↓
WebSocket Engine = RECONNECTING
    ↓
Feature/Watchlist/Market Watch = STALE / DEGRADED
    ↓
Notification Engine
    ↓
Connection Manager
    ↓
UI

Do not kill unrelated engines.

34. Broker Terminal Failure

Broker Terminal = DEGRADED
       ↓
Risk Engine sees stale broker state
       ↓
new orders may be BLOCKED
       ↓
existing monitoring continues
       ↓
Notification

Fail-closed behavior is appropriate for safety-critical trading
decisions when authoritative state is stale.

35. Persistence Failure

Mongo unavailable
    ↓
DB Writer queue grows
    ↓
Storage health = DEGRADED
    ↓
Notification

Realtime market-data processing should not automatically stop merely
because persistence is temporarily unavailable, unless a configured
compliance/safety policy requires it.

36. Event Bus Rules

Event Bus is for decoupling.

Examples:

TICK_VALIDATED
FEATURES_UPDATED
ORDER_SUBMITTED
ORDER_FILLED
ORDER_REJECTED
POSITION_UPDATED
PNL_UPDATED
RISK_BLOCKED
BROKER_CONNECTED
BROKER_DISCONNECTED
SESSION_EXPIRED
SQUAREOFF_STARTED
SQUAREOFF_COMPLETED
TARGET_TRIGGERED
ENGINE_DEGRADED

Rule:

Publish facts/events. Do not use the event bus as an uncontrolled RPC
mechanism.

For synchronous safety gates such as Risk validation, direct
request/response is more appropriate.

37. Synchronous vs Asynchronous Connections

Synchronous

Use when the caller cannot continue without the result.

Order Engine
    ↓
Risk Engine
    ↓
decision

Order Engine
    ↓
Broker Terminal
    ↓
broker submission result

Asynchronous

Use for fan-out and notifications.

WebSocket Engine
    ↓
Event Bus
    ↓
many consumers

Engine
    ↓
Notification Engine

Engine
    ↓
Connection Manager

38. No Circular Dependency Rule

Forbidden:

Order → Risk → Order

Forbidden:

WebSocket → Market Watch → WebSocket

Forbidden:

Connection Manager → UI → Engine → Connection Manager

Correct:

UI request
   ↓
API/Engine
   ↓
result/event
   ↓
Connection Manager
   ↓
UI

The frontend is never a backend dependency.

39. Source-of-Truth Rules

Market tick

WebSocket Engine

Broker account/funds/orders/positions

Broker Terminal Engine

Risk decision

Risk Engine

Order execution state

Order Engine
+ broker-authoritative reconciliation

Canonical position/P&L capability

Risk Engine internal capability

AI capital reservation

Margin Engine

Notification state

Notification Engine

Audit history

Audit Engine

Persistence pipeline

DB Writer → Storage

UI realtime delivery

Connection Manager

Market lifecycle timing

Scheduler Engine

Broker session/subscription registry

Session Manager

40. Complete End-to-End Market Data Example

A tick for RELIANCE:

1. Kotak emits tick
2. ws_manager receives it
3. WebSocket Engine normalizes it
4. validation succeeds
5. TICK_VALIDATED published
6. Feature Engine calculates features
7. Watchlist Engine updates LTP
8. Market Watch updates live state
9. DB Writer receives persistence item
10. Connection Manager prepares relevant UI payload
11. WS#2 sends update
12. Next.js updates only affected UI state
13. Storage Engine asynchronously persists data

No engine should perform unrelated work in this critical path.

41. Complete End-to-End Manual Order Example

User clicks BUY
      ↓
Frontend API
      ↓
Order Engine
      ↓
normalize request
      ↓
Risk Engine
      ↓
check:
- trading phase
- terminal capability
- capital/margin
- exposure
- quantity
- circuit
- market quality
- P&L
      ↓
PASS?
 ├─ NO → Audit → Notification → UI
 └─ YES
      ↓
Audit Engine
      ↓
Broker Terminal Engine
      ↓
Kotak adapter
      ↓
broker response
      ↓
Order Engine normalizes response
      ↓
broker position/order reconciliation
      ↓
Risk Position/P&L capability
      ↓
Target Engine if target exists
      ↓
Connection Manager
      ↓
WS#2
      ↓
UI

42. Complete AI Order Example

AI model
   ↓
trade suggestion
   ↓
Margin Engine
   ↓
AI capital slot policy
   ↓
reservation
   ↓
quantity capacity
   ↓
Risk Engine
   ↓
PASS/BLOCK
   ↓
Order Engine
   ↓
Broker Terminal
   ↓
execution
   ↓
Position/P&L capability
   ↓
Target Engine
   ↓
Audit + Notification
   ↓
Connection Manager
   ↓
UI

If Risk blocks:

AI
 ↓
Margin reservation
 ↓
Risk BLOCK
 ↓
reservation release
 ↓
Audit
 ↓
Notification

43. Complete Squareoff Example

Scheduler
   ↓
PRE-SQUAREOFF
   ↓
freeze new trading activities
   ↓
Squareoff Engine
   ↓
cancel pending orders
   ↓
verify cancellations
   ↓
Broker Terminal → fetch positions
   ↓
open position?
 ├─ NO → COMPLETE
 └─ YES
      ↓
opposite-side MARKET request
      ↓
Order Engine
      ↓
Risk Engine (position reduction classification)
      ↓
Broker Terminal
      ↓
execution
      ↓
re-fetch positions
      ↓
remaining?
 ├─ NO → COMPLETE
 └─ YES → retry

44. Complete Shutdown Lifecycle

Shutdown must be the reverse of startup dependency order.

Recommended:

1. Scheduler stops creating new lifecycle actions
2. Freeze new trading requests
3. Squareoff policy decides whether active positions require handling
4. Stop new market subscriptions
5. WebSocket Engine disconnects WS#1
6. Market-data consumers stop
7. Connection Manager stops new UI fan-out
8. Flush DB Writer
9. Storage Engine flushes/terminates
10. Broker Terminal session cleanup
11. Session Manager cleanup
12. Notification cleanup
13. Registry marks engines STOPPED
14. FastAPI process exits

Important:

Never terminate persistence before its producers have stopped.

45. Shutdown Dependency Rule

Bad:

Storage STOP
   ↓
DB Writer still running
   ↓
writes lost

Correct:

Producer STOP
   ↓
DB Writer drain
   ↓
Storage flush
   ↓
Storage STOP

Similarly:

Market-data consumers STOP
   ↓
WebSocket STOP

not the reverse.

46. Connection Matrix

Source                     Destination       Connection             Purpose

Scheduler                  Session Manager   control/direct         lifecycle

Scheduler                  WebSocket Engine  control                connect/disconnect
timing

Scheduler                  Squareoff Engine  command/event          EOD closure

Session Manager            WebSocket Engine  subscription/control   subscription
registry

Session Manager            Broker Terminal   session/control        broker session

Broker Terminal            Broker Adapter    adapter API            broker account/API

WebSocket Engine           Event Bus         event                  validated ticks

Event Bus                  Feature Engine    event                  feature calculation

Event Bus                  Watchlist Engine  event                  live watchlist state

Event Bus                  Market Watch      event                  live market state

Feature/Watchlist/Market   Connection        state/event            UI updates
Watch                      Manager

Broker Terminal            Risk Engine       state/query            authoritative broker
state

Risk Engine                Order Engine      decision               execution gate

Margin Engine              Risk/Order flow   allocation/result      AI capital control

Order Engine               Broker Terminal   command                broker execution

Order Engine               Audit Engine      event/direct           execution trail

Order Engine               Notification      event                  user alerts
Engine

Order Engine               Risk Position/P&L state update           canonical state

Target Engine              Order Engine      command                exit request

Squareoff Engine           Order Engine      command                EOD exit

Engines                    DB Writer         event/data             persistence

DB Writer                  Storage           queue/write            persistence

All engines                Connection        event/state            frontend delivery
Manager

47. What Must Never Connect Directly

Frontend → Broker

Forbidden.

Next.js → Kotak API
Next.js → Kotak WS

Feature Engine → Order Engine

Forbidden unless an explicitly approved strategy/trading layer exists.

Feature calculation alone must not place orders.

Market Watch → Broker

Forbidden.

Market Watch consumes the canonical feed and subscription
infrastructure.

Target Engine → Broker

Forbidden.

Target Engine requests an exit from Order Engine.

Squareoff Engine → Broker

Forbidden.

Squareoff requests closure through Order Engine.

UI → Risk bypass

Forbidden.

Every new trading request must reach Risk through Order Engine.

48. Critical Architecture Invariants

One broker market-data WebSocket owner: WebSocket Engine.

One frontend realtime gateway: Connection Manager.

One broker order execution choke point: Order Engine.

One final deterministic risk gate: Risk Engine.

One broker account/terminal integration boundary: Broker
Terminal Engine.

One lifecycle/time authority: Scheduler Engine.

One broker session/subscription authority: Session Manager.

One append-only trading audit trail: Audit Engine.

One notification/alert infrastructure: Notification Engine.

No direct UI-to-broker communication.

No direct Target/Squareoff-to-broker execution.

No duplicated broker WebSocket ownership.

No synchronous Mongo writes inside the hot tick path.

No circular engine dependencies.

Broker-authoritative state wins during reconciliation.

49. Current Code vs Target Architecture

The source audit verified the older runtime structure:

app.py lifespan
├─ Scheduler
├─ Notification initialization
├─ Session Manager
├─ WebSocket facade
├─ Connection Manager
├─ Order/Position/Notification facades
├─ WS#1 wiring
├─ WS#2 start
└─ native engines
   ├─ Feature
   ├─ Search
   ├─ Watchlist
   ├─ Market Coach
   ├─ Storage
   ├─ DB Writer
   └─ others

The audit also verified:

Kotak WS#1
 → ws_manager
 → WebSocket Engine
 → TICK_VALIDATED
 → Feature / Watchlist
 → Connection Manager
 → WS#2
 → UI

Order
 → Risk
 → Audit
 → Broker adapter
 → Position/P&L
 → Connection Manager

These are the source-derived baseline flows. The redesigned 18-engine
architecture in this document introduces the newer Broker Terminal
boundary and merges Position/P&L and Basket responsibilities as
specified by the target architecture.

50. Implementation Rule

Do not implement all engine connections simultaneously.

Recommended migration sequence:

Phase A
Engine Registry + lifecycle contract
        ↓
Phase B
Scheduler + Session Manager + Broker Terminal
        ↓
Phase C
WebSocket + Event Bus + Connection Manager
        ↓
Phase D
Feature + Watchlist + Market Watch + Search
        ↓
Phase E
Risk + Position/P&L capability
        ↓
Phase F
Order + Broker execution
        ↓
Phase G
Margin + Target + Squareoff
        ↓
Phase H
Audit + Notification
        ↓
Phase I
DB Writer + Storage hardening
        ↓
Phase J
full integration tests

51. Minimum Integration Tests

Lifecycle

startup ordering

dependency unavailable

partial startup

graceful shutdown

restart after failure

Market data

WS#1 connect

subscription

tick normalization

TICK_VALIDATED event

consumer fan-out

reconnect

stale-feed handling

UI realtime

WS#2 connection

channel routing

reconnect

duplicate event protection

backpressure

Trading

manual order PASS

manual order BLOCK

AI allocation

Risk BLOCK after allocation

reservation release

broker rejection

ambiguous broker timeout

partial fill

position reconciliation

Target

target registration

target hit

duplicate trigger

partial fill

exit failure

Squareoff

freeze

pending cancellation

cancellation verification

open-position fetch

closure

partial closure

retry

incomplete squareoff

Persistence

queue overflow

DB outage

recovery

shutdown drain

audit persistence

52. Final Architecture Principle

The system should behave like this:

TIME
  ↓
Scheduler

IDENTITY / SESSION
  ↓
Session Manager

BROKER TERMINAL STATE
  ↓
Broker Terminal Engine

BROKER MARKET DATA
  ↓
WebSocket Engine
  ↓
Event Bus
  ↓
Market-data consumers

FRONTEND REALTIME
  ↓
Connection Manager

TRADING DECISION
  ↓
Risk Engine

TRADING EXECUTION
  ↓
Order Engine
  ↓
Broker Terminal Engine

CAPITAL ALLOCATION
  ↓
Margin Engine

POSITION TARGET EXIT
  ↓
Target Engine → Order Engine

END-OF-DAY SAFETY
  ↓
Squareoff Engine → Order Engine

TRACEABILITY
  ↓
Audit Engine

USER ALERTS
  ↓
Notification Engine

PERSISTENCE
  ↓
DB Writer → Storage → MongoDB

The key architectural rule is single ownership + controlled fan-out:
each important responsibility has one authoritative engine, while
consumers receive state through explicit synchronous contracts or typed
events rather than creating their own broker/database/UI connections.
