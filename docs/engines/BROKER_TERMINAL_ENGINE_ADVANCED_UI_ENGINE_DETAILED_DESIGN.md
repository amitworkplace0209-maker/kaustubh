Broker Terminal Engine — Advanced UI + Engine + Real-Time Architecture

1. Purpose

Broker Terminal Engine is the centralized broker-integration and terminal-state layer for the trading platform.

Its job is to manage and normalize all configured trading terminals:

Kotak Neo

Shoonya

Dummy / Simulation

The frontend must NOT independently fetch data from each broker.

Target architecture:

Kotak API / Feed ─────┐
Shoonya API / Feed ───┼──> Broker Terminal Engine
Dummy Simulator ──────┘             │
                                    ↓
                           Normalize + Validate
                                    ↓
                              Canonical State
                                    ↓
                           Event / State Updates
                                    ↓
                           Connection Manager
                                    ↓
                                    UI

The engine hides broker-specific schemas, authentication details, response formats, connection states, capabilities, errors and synchronization logic from the UI.

2. Core Principle

One Terminal Data Gateway

The UI should have one logical data source:

UI
 ↓
Broker Terminal Engine

Not:

UI
 ├── Kotak API
 ├── Shoonya API
 └── Dummy API

This prevents broker-specific code from spreading throughout the frontend.

3. Supported Terminals

Initial terminal registry:

KOTAK_NEO
SHOONYA
DUMMY

Future terminals can be added through adapters without redesigning the UI.

Example future structure:

Broker Terminal Engine
├── KotakTerminalAdapter
├── ShoonyaTerminalAdapter
├── DummyTerminalAdapter
├── FutureBrokerAdapter
└── TerminalAggregator

4. Responsibilities

Broker Terminal Engine owns

Connectivity

broker connection state

API connectivity

market-data connectivity

session state

reconnect coordination

connection health

Authentication/session state

broker session validity

token/session expiry state

authentication errors

session refresh/re-login coordination where supported

Broker state ingestion

account/funds

margin

orders

positions

holdings

broker-side P&L

order status

broker capabilities

Normalization

Convert broker-specific data into canonical platform models.

Synchronization

initial sync

periodic reconciliation

event-driven updates

gap recovery

stale-data detection

last-sync tracking

Terminal health

latency

API health

feed health

error state

degradation state

Combined portfolio

Aggregate multiple real broker terminals into a source-aware combined view.

5. What It Does NOT Own

Broker Terminal Engine should NOT become a duplicate of other engines.

Order Engine

Owns the application's normal order execution workflow.

Risk Engine

Owns risk validation and ALLOW/BLOCK decisions.

Position Engine

Owns the canonical application-level position model.

P&L Engine

Owns canonical P&L normalization/calculation.

Squareoff Engine

Owns end-of-day position closure.

WebSocket Engine

Owns the platform's canonical market-data streaming architecture where already defined.

Broker Terminal Engine provides broker-specific feed/account state to the appropriate platform services and must not create a competing global market-data architecture.

6. High-Level Architecture

                         BROKER TERMINAL ENGINE
                                  │
              ┌───────────────────┼───────────────────┐
              ↓                   ↓                   ↓
       Kotak Adapter       Shoonya Adapter       Dummy Adapter
              ↓                   ↓                   ↓
         Kotak APIs           Shoonya APIs        Simulator
              │                   │                   │
              └───────────────────┼───────────────────┘
                                  ↓
                         RAW BROKER EVENTS
                                  ↓
                         NORMALIZATION LAYER
                                  ↓
                         VALIDATION LAYER
                                  ↓
                         TERMINAL STATE STORE
                                  ↓
                    EVENT / RECONCILIATION LAYER
                                  ↓
                         CONNECTION MANAGER
                                  ↓
                                  UI

7. Terminal Adapter Contract

Every broker adapter should expose a common conceptual contract.

connect()
disconnect()

getSessionStatus()
getAccount()
getFunds()
getMargin()

getOrders()
getOrder(orderId)
cancelOrder(orderId)
modifyOrder(orderId)

getPositions()
getHoldings()
getPnl()

getCapabilities()

subscribeMarketData()
unsubscribeMarketData()

healthCheck()
reconcile()

Actual method names should follow project conventions.

The adapter translates broker-specific APIs into the common contract.

8. Canonical Terminal State

The UI receives normalized state such as:

TerminalState

terminal_id
broker
display_name
mode

connection_status
session_status
market_data_status

account
funds
margin

orders
positions
holdings
pnl

capabilities

health
latency
last_sync
last_event

errors
warnings

created_at
updated_at

The raw broker response may be preserved for debugging/audit where appropriate, but frontend components should not depend on broker-specific fields.

9. Connection State Machine

DISCONNECTED
     ↓
CONNECTING
     ↓
CONNECTED
     ↓
AUTHENTICATING
     ↓
ACTIVE
     ↓
DEGRADED
     ↓
RECONNECTING
     ↓
ACTIVE

Failure states:

AUTH_EXPIRED
AUTH_FAILED
BROKER_ERROR
DISCONNECTED
MAINTENANCE

A terminal must never appear ACTIVE if critical session/account state is invalid.

10. Health Model

Overall health should be derived from multiple dimensions:

Connection
Session
API
Market Data
Account Sync
Order Sync
Position Sync
Latency
Last Successful Reconciliation

Example:

Kotak Neo

Connection      HEALTHY
Session         ACTIVE
API             HEALTHY
Market Feed     LIVE
Orders Sync     HEALTHY
Position Sync   HEALTHY
Latency         240 ms

Overall          HEALTHY

If the market feed fails while API remains healthy:

Overall = DEGRADED

Do not incorrectly report the entire terminal as disconnected.

11. Real-Time Data Architecture

Different data types may have different sources.

Streaming data

Potentially:

LTP
Ticks
Market status
Order events where broker supports them

API/reconciliation data

Typically:

Funds
Margin
Orders
Positions
Holdings
Account state

Architecture:

Broker Feed
     ↓
Adapter
     ↓
Terminal Engine
     ↓
Normalize
     ↓
State Update
     ↓
Event
     ↓
Connection Manager
     ↓
UI

Periodic reconciliation remains necessary even when streaming events are available.

12. Reconciliation Engine

Advanced feature: the terminal engine must not blindly trust event streams.

Use:

EVENTS
  +
PERIODIC SNAPSHOT
  =
RECONCILED STATE

Example:

09:30 order event received
09:31 broker snapshot
09:31 compare local vs broker
09:31 repair differences

This handles:

missed events

WebSocket disconnects

delayed broker updates

application restart

partial fills

cancel/fill races

13. Sync Status

Every major data domain should expose:

last_successful_sync
last_attempt
sync_status
source
data_age
error

Example:

Orders:
LIVE
Last sync: 320 ms

Positions:
RECONCILED
Last sync: 1.2 sec

Holdings:
SYNCED
Last sync: 3.8 sec

Funds:
SYNCED
Last sync: 4.1 sec

14. Stale Data Protection

Every state has freshness metadata.

data_timestamp
received_at
processed_at
age_ms
source

Example:

Position data age = 7.2 sec
Configured max = 5 sec

Status = STALE

The engine must expose stale status rather than silently presenting old data as current.

Risk Engine can use this state for trading decisions.

15. Terminal Card — Updated UI

Current dashboard cards should evolve into live terminal summaries.

┌─────────────────────────────────────────────┐
│ 🟢 Kotak Neo                   ACTIVE       │
│ Connected • Market Data LIVE                │
│                                             │
│ Funds              ₹82,450                  │
│ Available Margin   ₹61,220                  │
│ Used Margin        ₹21,230                  │
│ Open Positions     4                        │
│ Orders Today       18                       │
│ Net P&L            +₹2,840                  │
│                                             │
│ API              ● HEALTHY                  │
│ Market Feed      ● LIVE                     │
│ Sync             ● HEALTHY                  │
│ Latency          240 ms                     │
│ Last Update      250 ms ago                 │
│                                             │
│ [OPEN] [DETAILS] [RECONNECT]               │
└─────────────────────────────────────────────┘

All financial values are backend data.

No fake placeholders in production.

16. Shoonya Card

Same component, different data:

┌─────────────────────────────────────────────┐
│ 🟢 Shoonya                    ACTIVE        │
│ Connected • Market Data LIVE                │
│                                             │
│ Funds              ₹...                     │
│ Available Margin   ₹...                     │
│ Open Positions     ...                      │
│ Orders Today       ...                      │
│ Net P&L            ...                      │
│                                             │
│ API              ● HEALTHY                  │
│ Feed             ● LIVE                     │
│ Sync             ● HEALTHY                  │
│                                             │
│ [OPEN] [DETAILS] [RECONNECT]               │
└─────────────────────────────────────────────┘

17. Dummy Terminal

Dummy should behave like a real terminal interface, not a fake dashboard card.

DUMMY MODE
────────────────────────────
Mode: SIMULATION

Virtual Funds
Virtual Margin
Virtual Orders
Virtual Positions
Virtual Holdings
Virtual P&L
Virtual Fills

Simulation State
Market Data Source
Fill Model
Slippage Model

The Dummy adapter can support:

simulated orders

simulated fills

virtual balance

virtual P&L

deterministic test scenarios

18. Detailed Terminal Page

Clicking a terminal opens:

BROKER TERMINAL

Overview
Connection
Session
Account
Funds & Margin
Orders
Positions
Holdings
P&L
Market Data
Capabilities
Health
Sync
Events
Errors

The same page can render:

Kotak
Shoonya
Dummy

using the normalized TerminalState.

19. Overview Page

┌─────────────────────────────────────────────────┐
│ KOTAK NEO                                       │
│ ACTIVE ●                                        │
├─────────────────────────────────────────────────┤
│ Connection      ACTIVE                          │
│ Session         ACTIVE                          │
│ Market Feed     LIVE                            │
│ API             HEALTHY                         │
│                                                 │
│ Funds           ₹82,450                         │
│ Margin          ₹61,220                         │
│ P&L             +₹2,840                         │
│ Positions       4                               │
│ Orders          18                              │
│                                                 │
│ Last Reconcile  09:32:14                        │
│ Latency         240 ms                          │
└─────────────────────────────────────────────────┘

20. Account & Funds

Show:

Available Cash
Available Margin
Used Margin
Blocked Margin
Utilized Capital
Buying Power
Collateral
Broker-specific available fields

Preserve the broker source and timestamp.

21. Orders View

The terminal-specific order view should show broker-side truth:

Order ID
Symbol
Side
Quantity
Filled
Remaining
Price
Average Fill
Status
Product
Exchange
Timestamp
Broker Message

Status normalization:

PENDING
OPEN
PARTIALLY_FILLED
FILLED
CANCEL_REQUESTED
CANCELLED
REJECTED
UNKNOWN

Keep the raw broker status internally for debugging.

22. Positions View

Show:

Symbol
Product
Net Qty
Buy Qty
Sell Qty
Average Price
LTP
Unrealized P&L
Realized P&L
Net P&L
Broker Source
Last Update

The terminal engine provides broker-side position snapshots.

Position Engine remains the canonical application position layer.

23. Holdings View

Show:

Symbol
Quantity
Average Cost
LTP
Market Value
Unrealized P&L
Day Change
Broker
Last Sync

Holdings must remain separate from intraday positions.

24. P&L View

Terminal-specific:

Realized P&L
Unrealized P&L
Day P&L
Net P&L

P&L Engine may normalize/calibrate the platform-level P&L.

Do not create a second competing P&L authority.

25. Capabilities Page

Show broker capabilities dynamically:

                   Kotak  Shoonya  Dummy

Market Data          ✓       ✓       ✓
Orders               ✓       ✓       ✓
Cancel               ✓       ✓       ✓
Modify               ✓       ✓       ✓
Positions            ✓       ✓       ✓
Holdings             ✓       ✓       ✓
Margin               ✓       ✓       ✓
Historical Data      ✓       ✓       —
Simulation           —       —       ✓

Capabilities must come from adapters/configuration, not hard-coded UI assumptions.

26. Health Page

Detailed health:

Connection
Session
API
Market Data
Orders Sync
Positions Sync
Holdings Sync
Funds Sync
Reconciliation
Latency
Error Rate
Last Success

Each should expose:

status
last_check
latency
age
error

27. Sync Center

Advanced UI:

SYNC CENTER

Domain          Status       Age       Last Result
Orders          LIVE         320ms     OK
Positions       HEALTHY      1.2s      OK
Holdings        SYNCED       3.8s      OK
Funds           SYNCED       4.1s      OK
P&L             LIVE         1.0s      OK

Actions:

[SYNC NOW]
[RECONNECT]
[RECONCILE]

Dangerous actions require authorization.

28. Connection Controls

Connection

Status: ACTIVE

[Reconnect]
[Disconnect]
[Refresh Session]
[Run Health Check]
[Reconcile Now]

The UI triggers commands through the backend engine.

The frontend never directly handles broker credentials.

29. Combined Portfolio

Kotak + Shoonya Combined should be generated by the Terminal Aggregator.

Kotak State ───┐
               ├──> Combined Aggregator
Shoonya State ─┘
                     ↓
              Combined Portfolio

Show source attribution.

Example:

RELIANCE

Kotak:
+100 qty

Shoonya:
+50 qty

Combined:
+150 qty

Never lose source information.

30. Combined P&L

Show:

Kotak P&L
Shoonya P&L
Combined P&L

Formula must respect the platform's P&L semantics and avoid double-counting.

31. Combined Funds

Do not blindly add every broker value.

Different brokers may expose:

cash

collateral

margin

buying power

blocked amount

The aggregator must define exactly which metrics are additive and which are broker-specific.

UI should label:

Combined Available Capital

only when the underlying calculation is valid.

32. Event Architecture

Conceptual events:

TERMINAL_CONNECTED
TERMINAL_DISCONNECTED
TERMINAL_AUTH_EXPIRED
TERMINAL_HEALTH_CHANGED

FUNDS_UPDATED
MARGIN_UPDATED
ORDER_UPDATED
POSITION_UPDATED
HOLDING_UPDATED
PNL_UPDATED

MARKET_DATA_CONNECTED
MARKET_DATA_DISCONNECTED

SYNC_STARTED
SYNC_COMPLETED
SYNC_FAILED

RECONCILIATION_STARTED
RECONCILIATION_COMPLETED
RECONCILIATION_MISMATCH

Connection Manager forwards UI-relevant events.

33. UI Update Strategy

Do not rerender the whole dashboard on every tick.

Use:

Terminal event
 ↓
state slice update
 ↓
affected component only

Examples:

P&L update
→ P&L card only

Position update
→ Positions card/table only

Connection update
→ terminal status only

Funds update
→ funds widget only

This is critical for performance.

34. Broker Data Ownership

Recommended ownership:

Broker Adapter
    ↓
Broker Terminal Engine
    ↓
Normalized Broker State

Then:

Position Engine ← broker positions
P&L Engine      ← broker/account data
Risk Engine     ← risk-relevant normalized state
Dashboard       ← UI projection
Order Engine    ← execution workflow

No UI component directly calls broker APIs.

35. Authentication and Secrets

The browser must never receive:

API secrets

broker passwords

private tokens

secret keys

refresh tokens unless explicitly designed and safe

Frontend receives:

session status
masked account identifier
health
data
capabilities

36. Error Normalization

Broker-specific:

"Token invalid"
"Session expired"
"Insufficient funds"
"Order rejected"

Normalize:

AUTH_EXPIRED
INSUFFICIENT_FUNDS
ORDER_REJECTED
BROKER_TIMEOUT
RATE_LIMIT
MARKET_CLOSED
UNKNOWN_BROKER_ERROR

Preserve original broker message internally.

37. Rate-Limit Protection

The engine should centralize API calls so the UI cannot accidentally create API storms.

Bad:

20 components
×
poll every second
=
20 broker requests/sec

Target:

Broker Terminal Engine
→ controlled polling/sync
→ shared state
→ many UI consumers

The UI reads shared state rather than triggering duplicate broker requests.

38. Request Deduplication

If several components request the same resource:

Dashboard → getFunds()
Account → getFunds()
Risk → getFunds()

Engine should reuse the current in-flight request/state where possible.

Avoid duplicate broker calls.

39. Cache Strategy

Different TTLs:

Funds:
short TTL

Positions:
very short / event-driven

Orders:
event-driven + reconciliation

Holdings:
moderate TTL

Capabilities:
long TTL

Broker metadata:
long TTL

Exact TTLs must be configurable according to broker limits and data criticality.

40. Startup Flow

At application/backend startup:

Broker Terminal Engine starts
        ↓
Load terminal configuration
        ↓
Initialize adapters
        ↓
Check credentials/session
        ↓
Connect configured terminals
        ↓
Initial account sync
        ↓
Initial order sync
        ↓
Initial position sync
        ↓
Initial holdings sync
        ↓
Initial P&L sync
        ↓
Start event subscriptions
        ↓
Mark terminal state
        ↓
Publish terminal-ready events

Failed terminals should not crash unrelated terminals.

41. Reconnect Flow

Connection Lost
      ↓
Mark DEGRADED
      ↓
Stop relying on stale stream
      ↓
Reconnect with backoff
      ↓
Session validation
      ↓
Resubscribe
      ↓
Full reconciliation
      ↓
Repair state
      ↓
Mark ACTIVE

Do not simply reconnect the socket and assume state is correct.

42. Session Expiry Flow

AUTH_EXPIRED
     ↓
Mark terminal AUTH_EXPIRED
     ↓
Stop new broker-dependent operations
     ↓
Notify UI
     ↓
Refresh/re-login if supported
     ↓
Validate session
     ↓
Reconcile
     ↓
ACTIVE

Risk Engine should be able to see terminal session health.

43. Broker Failure Isolation

Kotak failure:

Kotak = ERROR
Shoonya = ACTIVE
Dummy = ACTIVE

The platform should continue operating according to configured source policies.

One broker must not bring down the entire Broker Terminal Engine.

44. Trading Safety

Before Order Engine sends a broker order:

Order Engine
   ↓
Risk Engine
   ↓
Broker Terminal Engine capability/session check
   ↓
Broker adapter
   ↓
Broker

The terminal layer should verify:

terminal enabled;

session valid;

required capability available;

broker connection usable;

correct broker/product mapping.

Risk Engine remains responsible for risk ALLOW/BLOCK.

45. Terminal Selection

For future multi-broker execution:

Order Request
   ↓
Target Terminal
   ↓
Risk Engine
   ↓
Broker Terminal Engine
   ↓
Selected Adapter

Possible selection policies:

MANUAL_TERMINAL
AI_CONFIGURED_TERMINAL
DEFAULT_TERMINAL
STRATEGY_TERMINAL

Terminal selection should be explicit and auditable.

46. Multi-Broker Routing — Future Advanced Feature

Do not implement automatic smart routing until rules are clearly defined.

Future routing inputs could include:

broker availability;

product support;

margin availability;

capability;

latency;

configured strategy;

user preference.

But the engine must never silently reroute a trade to a different broker without an explicit routing policy.

47. Auditability

Record:

terminal_id
broker
request_id
operation
timestamp
status
latency
error_code
broker_order_id
sync_version

Important transitions:

connect
disconnect
login
logout
reconnect
order sync
position sync
reconciliation
configuration change
terminal switch

48. Monitoring Dashboard

Global Service Phase section:

BROKER TERMINALS

KOTAK NEO
● ACTIVE
Feed: LIVE
API: HEALTHY
Sync: HEALTHY

SHOONYA
● ACTIVE
Feed: LIVE
API: HEALTHY
Sync: HEALTHY

DUMMY
● ACTIVE
Simulation: RUNNING

49. Alerts

Alert when:

broker disconnected;

session expired;

repeated reconnect failures;

position sync stale;

order sync stale;

funds sync failed;

reconciliation mismatch;

broker rate limit reached;

unexpected broker error;

terminal capability unavailable.

50. Reconciliation Mismatch

Example:

LOCAL BROKER STATE

XYZ:
+100

BROKER SNAPSHOT

XYZ:
+80

Engine status:

RECONCILIATION_MISMATCH

Do not silently overwrite without recording the mismatch.

Recovery:

detect
→ record
→ fetch authoritative state
→ repair normalized state
→ publish corrected event

51. Data Lineage

Every normalized value should conceptually have:

value
source
timestamp
age
confidence/status

Example:

Available Margin
Value: ₹61,220
Source: KOTAK_API
Received: 09:32:14
Age: 1.2 sec
Status: FRESH

This is useful for Risk Engine and debugging.

52. Performance Architecture

The engine should maintain a centralized state store.

Broker APIs
    ↓
Terminal Engine
    ↓
Shared normalized state
    ↓
many UI components

Not:

100 UI components
↓
100 independent API calls

Use event-driven updates where possible.

53. Dummy Simulation Advanced Features

Dummy terminal can support:

Virtual balance
Virtual margin
Virtual order book
Market order simulation
Limit order simulation
Partial fills
Slippage
Latency simulation
Order rejection simulation
Broker disconnect simulation
Session expiry simulation

This makes it useful for testing:

Risk Engine

Order Engine

Squareoff Engine

Basket Engine

UI

Notifications

54. Developer / Diagnostic Mode

Advanced Service Phase feature:

Developer Diagnostics

Raw Connection
Raw Session
Last API Request
Last API Response
Last Event
Adapter State
Queue Depth
Pending Sync
Reconciliation Diff
Latency
Rate Limit

This should be permission-controlled and not expose secrets.

55. Terminal Configuration UI

BROKER TERMINALS

Kotak Neo
[ Enabled ]
[ Auto Connect ]

Shoonya
[ Enabled ]
[ Auto Connect ]

Dummy
[ Enabled ]
[ Simulation ]

Each terminal:

Broker
Display Name
Enabled
Default
Auto Connect
Market Data
Trading
Account Sync
Polling/Synchronization

Dangerous changes require confirmation.

56. Terminal Permissions

Allow configuration:

Market Data:
ON/OFF

Trading:
ON/OFF

Account Sync:
ON/OFF

Auto Connect:
ON/OFF

Example:

Dummy:
Market Data ON
Trading ON
Simulation ONLY

A terminal disabled for trading can still provide market/account data where supported.

57. UI Empty / Error States

No fake values.

If disconnected:

Kotak Neo

● DISCONNECTED

Live data unavailable.

Last successful sync:
09:31:44

[RECONNECT]

If never connected:

Kotak Neo

Not connected

Configure broker to begin synchronization.

[CONFIGURE]

If stale:

Data stale

Last update:
2m 14s ago

[RECONCILE]

58. Terminal Event Timeline

Advanced detail page:

EVENT TIMELINE

09:32:14  Position sync completed
09:32:12  Order update received
09:31:58  Margin updated
09:31:44  Market feed connected
09:31:40  Session validated
09:31:37  Reconciliation completed

Useful for debugging broker behavior.

59. Data Contract to UI

The frontend should consume a stable normalized contract:

{
  terminalId,
  broker,
  status,
  session,
  marketData,
  account,
  funds,
  margin,
  orders,
  positions,
  holdings,
  pnl,
  capabilities,
  health,
  sync,
  errors,
  updatedAt
}

No component should need:

kotakResponse.availableCash

or:

shoonyaResponse.cash

Instead:

terminal.account.availableCash

60. Security Boundaries

Browser
   ↓
Frontend API
   ↓
Backend
   ↓
Broker Terminal Engine
   ↓
Broker Credentials

Never:

Browser
   ↓
Broker API

Credentials remain backend-side.

61. Testing Strategy

Adapter Unit Tests

For each broker:

response normalization

status normalization

error normalization

capability mapping

session handling

order mapping

position mapping

funds mapping

Engine Tests

connection state

reconnect

stale data

sync

reconciliation

duplicate requests

rate-limit protection

broker isolation

event publishing

Integration Tests

Kotak adapter
→ Terminal Engine
→ normalized state
→ Connection Manager
→ UI

Same for Shoonya and Dummy.

Failure Tests

broker timeout

invalid session

API rate limit

partial response

malformed broker response

WebSocket disconnect

missed event

reconciliation mismatch

duplicate event

application restart

62. Acceptance Criteria

The Broker Terminal Engine is complete when:

Kotak, Shoonya and Dummy are represented by adapters.

UI does not directly fetch broker APIs.

All terminal state is normalized.

Account/funds/margin data is available.

Orders are normalized.

Positions are normalized.

Holdings are normalized.

P&L is available without creating a competing P&L authority.

Connection state is explicit.

Session state is explicit.

Market-data state is explicit.

Health is explicit.

Data freshness is visible.

Reconciliation exists.

Reconnect exists.

Broker failures are isolated.

Rate-limit protection exists.

Duplicate API requests are controlled.

Combined Kotak + Shoonya view preserves source attribution.

Capabilities are dynamic.

Dummy supports simulation.

UI receives data through the platform backend/Connection Manager path.

No broker secrets reach the frontend.

Every important terminal event is auditable.

UI does not show fake financial data.

Adding a future broker requires an adapter, not a frontend rewrite.

63. Final Runtime Flow

                 ┌───────────────────┐
                 │   KOTAK NEO       │
                 └─────────┬─────────┘
                           │
                 ┌─────────▼─────────┐
                 │ KOTAK ADAPTER     │
                 └─────────┬─────────┘
                           │
                           │
┌───────────────────┐      │      ┌───────────────────┐
│     SHOONYA       │      │      │      DUMMY        │
└─────────┬─────────┘      │      └─────────┬─────────┘
          ↓                │                ↓
┌───────────────────┐      │      ┌───────────────────┐
│ SHOONYA ADAPTER   │      │      │ DUMMY ADAPTER     │
└─────────┬─────────┘      │      └─────────┬─────────┘
          └────────────────┼────────────────┘
                           ↓
              ┌────────────────────────┐
              │ BROKER TERMINAL ENGINE │
              │                        │
              │ Normalize              │
              │ Validate               │
              │ Cache                  │
              │ Reconcile              │
              │ Health                 │
              │ Capabilities           │
              │ Events                 │
              └───────────┬────────────┘
                          ↓
                 Canonical State
                          ↓
                 Connection Manager
                          ↓
              ┌───────────┼───────────┐
              ↓           ↓           ↓
          Dashboard     Orders     Positions
              ↓
        Combined Portfolio

64. Final Architecture Principle

Broker Terminal Engine = Single Backend Gateway + Broker Adapter Layer + Normalized Terminal State + Real-Time Events + Reconciliation + Health + Multi-Broker Aggregation.

The frontend should never care whether a value came from Kotak, Shoonya or Dummy at the API-schema level.

It should ask:

Give me terminal state.

The engine handles:

Which broker?
Which API?
Which schema?
Which session?
Which connection?
Which synchronization?
Which capability?
Which error?
Which source?
How fresh is the data?

This creates a clean platform boundary:

BROKER-SPECIFIC COMPLEXITY
            ↓
    BROKER TERMINAL ENGINE
            ↓
   PLATFORM-NORMALIZED DATA
            ↓
       ALL UI / SERVICES