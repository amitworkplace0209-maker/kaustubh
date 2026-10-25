KDS Broker WebSocket, Connection Manager, Backend--Frontend WebSocket & API Flow

1. Purpose

This document defines the KDS/KAUSTUBH communication architecture and
the exact data flow between Kotak Neo, backend engines, Connection
Manager, and frontend.

The architecture separates:

Broker Market Data WebSocket --- WS#1

Broker Order & Position WebSocket --- WS#2

Backend → Frontend realtime WebSocket --- WS#3

Frontend → Backend command WebSocket --- WS#4

Frontend ↔ Backend REST API

Backend internal Event Bus

The most important rule is:

WebSockets are used at system boundaries for realtime communication.
Backend engines communicate internally through the Event Bus/internal
service calls, not unnecessary WebSocket hops.

2. High-Level Architecture

                         KOTAK NEO
                            │
             ┌──────────────┴──────────────┐
             │                             │
          WS#1                           WS#2
     Market Data Feed              Order/Position Feed
             │                             │
             ▼                             ▼
      WebSocket Engine              Order Feed Handler
             │                             │
             └──────────────┬──────────────┘
                            │
                    Validation / Normalization
                            │
                         Event Bus
                            │
          ┌─────────────────┼──────────────────┐
          │                 │                  │
          ▼                 ▼                  ▼
    Market Watch        Risk / Position    Order Engine
    Feature Engine      / P&L State        / Squareoff
          │                 │                  │
          └─────────────────┼──────────────────┘
                            │
                    Canonical Backend State
                            │
                            ▼
              Connection Manager / Engine
                            │
                  ┌─────────┴─────────┐
                  │                   │
                WS#3                 WS#4
                  │                   │
            Backend → Frontend   Frontend → Backend
                  │                   │
                  ▼                   ▲
               FRONTEND  ◄────────────┘
                  │
                  │ REST
                  ▼
               BACKEND

3. Four WebSocket Channels

WS#1 --- Broker Market Data

Direction: Kotak → Backend

Purpose:

LTP

change / change %

OHLC

volume

LTQ

bid / ask

spread

market depth

OI where supported

market status

timestamps

other supported SFeed fields

Flow:

Kotak SFeed
 ↓
WS#1
 ↓
WebSocket Manager
 ↓
WebSocket Engine
 ↓
Validation + Normalization
 ↓
Event Bus

WS#1 must never connect directly to the frontend.

WS#2 --- Broker Order & Position Feed

Direction: Kotak → Backend

For Kotak Neo SDK 3.x, verify and use the installed SDK's Order &
Position Feed interface; for SDK 3.0.6 this is expected to be
create_order_feed().

Primary realtime event types:

OrderUpdate

PositionUpdate

OrderUpdate

Used for order lifecycle changes:

SUBMITTING
 ↓
OPEN
 ↓
PARTIAL
 ↓
COMPLETE

or:

SUBMITTING
 ↓
REJECTED

or:

OPEN
 ↓
CANCEL REQUESTED
 ↓
CANCELLED

Typical fields include order identifiers, symbol, side, quantity, filled
quantity, remaining quantity, status, average traded price, order type,
product, exchange segment and timestamps where supported.

PositionUpdate

Used when broker position state changes.

Typical fields include symbol, exchange segment, product, buy/sell
quantities, buy/sell amounts and supported position/timestamp fields.

WS#2 does not place orders.

Order actions use broker REST APIs; WS#2 reports the broker-side
result/events.

4. Broker REST vs Broker WebSocket

Broker REST

Used for:

place order

modify order

cancel order

order/trade reports

funds

margin

holdings

reconciliation

authoritative/request-response snapshots

other broker REST operations

Broker WebSockets

WS#1 = Market Data
WS#2 = Order + Position Events

Therefore:

ACTION:
Frontend
 ↓
Backend
 ↓
Broker REST API
 ↓
Kotak

and:

EVENT:
Kotak
 ↓
Broker WebSocket
 ↓
Backend
 ↓
Frontend

5. Backend Internal Data Flow

Do not create WebSocket connections between every backend engine.

Incorrect:

WebSocket Engine
 ↓ WS
Feature Engine
 ↓ WS
Risk Engine
 ↓ WS
Connection Manager

Correct:

WebSocket Engine
 ↓
Event Bus
 ├── Market Watch / Feature Engine
 ├── Risk Engine
 ├── Order Engine
 └── Connection Manager

The Event Bus is the internal realtime distribution mechanism.

This reduces latency, serialization, authentication, reconnect and
debugging complexity.

6. WebSocket Engine

WebSocket Engine owns broker market-data orchestration.

Responsibilities:

market-data WS lifecycle

subscription reconciliation

Subscription Registry integration

broker subscription diff

feed-level routing

tick validation

tick normalization

realtime event publishing

reconnect coordination

broker subscription ACK tracking

market-data health

Flow:

Kotak SFeed
 ↓
WS#1
 ↓
WebSocket Manager
 ↓
WebSocket Engine
 ↓
Validate
 ↓
Normalize
 ↓
Event Bus

7. Full NSE Market Subscription Flow

The intended daily flow is:

Kotak / NSE Instrument Master
            ↓
      Market Watch Engine
            ↓
   Daily Eligible Universe
            ↓
       Session Manager
            ↓
    Subscription Registry
            ↓
      WebSocket Engine
            ↓
      WebSocket Manager
            ↓
           WS#1
            ↓
        Kotak SFeed

At the beginning of each trading day:

Market Watch builds the eligible universe.

Market Watch provides daily subscription intent.

Session Manager stores the current-day desired set.

Subscription Registry deduplicates and resolves feed levels.

WebSocket Engine calculates broker diff.

WebSocket Manager subscribes the broker.

Broker ACKs are tracked.

Real ticks arrive.

WebSocket Engine validates/normalizes them.

Events are published to the Event Bus.

At the next trading day, the previous day's subscription intent
expires/deactivates and a new revision is created.

8. Event Bus

The Event Bus distributes canonical backend events.

Market flow:

WS#1
 ↓
WebSocket Engine
 ↓
TICK_VALIDATED
 ↓
Event Bus
 ├── Market Watch
 ├── Risk Engine
 ├── Feature Engine
 ├── DB Writer where required
 └── Connection Manager

Order/position flow:

WS#2
 ↓
Order Feed Handler
 ↓
OrderUpdate / PositionUpdate
 ↓
Event Bus
 ├── Order Engine
 ├── Risk / Position State
 ├── Audit Engine
 └── Connection Manager

The Event Bus is not another WebSocket.

9. Market Watch / Feature Engine

Market Watch consumes canonical normalized market events:

WS#1
 ↓
WebSocket Engine
 ↓
Validation / Normalization
 ↓
Event Bus
 ↓
Market Watch / Feature Engine

It can maintain:

LTP

change

change %

volume

depth

rankings

gainers

losers

5m/10m values

filters

search-linked live state

auto pins

freshness

LIVE / STALE state

Market Watch must not create another broker WebSocket.

10. Connection Manager

Connection Manager / Connection Engine is the frontend realtime
communication layer.

It owns:

frontend WebSocket lifecycle

frontend authentication

client/session registration

consumer/channel registration

realtime event delivery

snapshot/event synchronization

heartbeat

frontend reconnect handling

connection health

frontend event routing

command receiving where applicable

It is not:

broker market-data owner

Order Engine

Risk Engine

Market Watch Engine

Its role is to bridge canonical backend state/events to the frontend.

11. WS#3 --- Backend → Frontend

Flow:

Kotak WS#1 / WS#2
 ↓
Backend ingestion
 ↓
Validation / Normalization
 ↓
Event Bus
 ↓
Backend Engines / Canonical State
 ↓
Connection Manager
 ↓
WS#3
 ↓
Frontend

WS#3 can carry:

Market events

LTP

change

change %

bid

ask

volume

depth

timestamp

freshness

Order events

submitted

accepted

open

partial

complete

rejected

cancelled

modified

Position events

opened

increased

reduced

closed

quantity changes

Risk/system events

risk state

margin state

notifications

broker session state

WebSocket state

subscription state

errors

The frontend should receive canonical KDS events, not raw Kotak
payloads.

12. WS#4 --- Frontend → Backend

Flow:

Frontend
 ↓
WS#4
 ↓
Connection Manager / Command Router
 ↓
Appropriate Backend Engine

Possible commands:

place order

cancel order

modify order

square-off

watchlist action

target action

realtime control/subscription commands

client heartbeat/control

WS#4 must never directly call the Kotak SDK from the browser.

Example:

Frontend
 ↓ WS#4
Connection Manager
 ↓
Order Engine
 ↓
Risk / Margin
 ↓
Broker Terminal Engine
 ↓
Kotak REST API

13. Order Placement Flow

Frontend
 ↓
WS#4 command
 ↓
Connection Manager / Command Router
 ↓
Order Engine
 ↓
Risk Engine
 ↓
Margin Engine
 ↓
Audit Engine
 ↓
Broker Terminal Engine
 ↓
Kotak Order REST API
 ↓
Kotak

Then the realtime result:

Kotak
 ↓
WS#2
 ↓
OrderUpdate
 ↓
Event Bus
 ↓
Order Engine / Risk / Audit
 ↓
Connection Manager
 ↓
WS#3
 ↓
Frontend

This gives a clean separation:

REST/API = action

WS#2 = broker event

WS#3 = frontend realtime update

14. Cancel Order Flow

Frontend
 ↓
WS#4
 ↓
Order Engine
 ↓
Kotak Cancel Order API
 ↓
Broker

Then:

Broker
 ↓
WS#2 OrderUpdate
 ↓
Backend order state
 ↓
Event Bus
 ↓
Connection Manager
 ↓
WS#3
 ↓
Frontend

A successful cancel request must not automatically be treated as final
CANCELLED. Final broker state must be confirmed.

15. Modify Order Flow

Frontend
 ↓
WS#4
 ↓
Order Engine
 ↓
Kotak Modify Order API
 ↓
Broker
 ↓
WS#2 OrderUpdate
 ↓
Backend state
 ↓
WS#3
 ↓
Frontend

16. Square-Off Flow

Frontend
 ↓
WS#4
 ↓
Squareoff Engine
 ↓
Risk validation
 ↓
Order Engine
 ↓
Broker Order API
 ↓
Kotak

Then:

Kotak
 ↓
WS#2 OrderUpdate
 ↓
PositionUpdate
 ↓
Risk / Position State
 ↓
Event Bus
 ↓
Connection Manager
 ↓
WS#3
 ↓
Frontend

The frontend should show a position as CLOSED only when backend state
confirms closure.

17. Position Page

Position events primarily come from WS#2:

Kotak WS#2
 ↓
PositionUpdate
 ↓
Risk / Position State
 ↓
Event Bus
 ↓
Connection Manager
 ↓
WS#3
 ↓
Position Page

For live/indicative P&L:

WS#2 PositionUpdate
       +
WS#1 Live LTP
       ↓
Risk Engine
       ↓
Indicative P&L
       ↓
Event Bus
       ↓
WS#3
       ↓
Frontend

Authoritative broker-confirmed values should be reconciled with REST
snapshots where required.

18. Order Page

The Order page consumes OrderUpdate through WS#3:

Kotak WS#2
 ↓
OrderUpdate
 ↓
Order Engine / backend order state
 ↓
Event Bus
 ↓
Connection Manager
 ↓
WS#3
 ↓
Order Page

If the Order page also displays live market price:

Kotak WS#1
 ↓
Market state
 ↓
Event Bus
 ↓
Connection Manager
 ↓
WS#3
 ↓
Order Page

Therefore the frontend receives a unified canonical stream through WS#3
even though the source can be WS#1 or WS#2.

19. REST API Pipeline

REST is the synchronous request/response channel.

Frontend
 ↓ HTTP/HTTPS
FastAPI / Backend API
 ↓
Relevant Backend Engine
 ↓
Response
 ↓
Frontend

Use REST for:

search

initial page bootstrap

instrument details

quote snapshots

funds

holdings

margin preview

risk preview

initial orders

initial positions

historical data

reports

configuration

reconciliation requests

Example search:

Frontend
 ↓
Search API
 ↓
Search Engine
 ↓
Instrument Master
 ↓
Search results
 ↓
Frontend

Example margin:

Frontend
 ↓
Margin API
 ↓
Margin Engine
 ↓
Broker/calculation layer
 ↓
Margin response
 ↓
Frontend

20. REST + WebSocket Together

A professional trading page normally needs both.

Page load:

Frontend
 ├── REST → bootstrap/search/snapshot
 └── WS#3 → realtime updates

Order submission:

Frontend
 ↓
WS#4
 ↓
Backend
 ↓
Broker REST Order API

Execution:

Kotak
 ↓
WS#2
 ↓
Backend
 ↓
WS#3
 ↓
Frontend

This combination provides both:

current state

realtime state changes

21. Snapshot + Realtime Pattern

WebSocket alone should not be assumed to provide complete state after
reconnect.

Recommended:

REST Snapshot
      +
WS#3 Realtime Events

Example:

Frontend reconnect
 ↓
REST current snapshot
 ↓
State restored
 ↓
WS#3 realtime events resume

The backend remains the source of truth.

22. Frontend Reconnect

When WS#3 disconnects:

Frontend
 ↓
WS#3 disconnected
 ↓
Reconnect
 ↓
Authenticate
 ↓
Register/restore subscriptions
 ↓
Get current snapshot
 ↓
Resume realtime events

The frontend must not assume it received every event during the
disconnect.

23. Broker WS#1 Reconnect

WS#1 disconnect
 ↓
WebSocket Manager reconnect
 ↓
Session Manager current-day desired set
 ↓
Subscription Registry
 ↓
WebSocket Engine reconcile
 ↓
Kotak subscribe
 ↓
ACK
 ↓
Ticks resume

The current day's full desired universe must be restored.

24. Broker WS#2 Reconnect

WS#2 disconnect
 ↓
Order Feed reconnect
 ↓
Broker session validation
 ↓
Order/Position stream restored
 ↓
Events resume

REST reconciliation should be available to recover missed/uncertain
order state.

25. Connection Manager vs WebSocket Engine

WebSocket Engine

Broker WS#1
 ↓
Market subscription
 ↓
Tick validation
 ↓
Normalization
 ↓
Event Bus

Connection Manager

Event Bus / canonical backend state
 ↓
Frontend routing
 ↓
WS#3
 ↓
Frontend

Therefore:

WS#1 = Broker → Backend market data
WS#2 = Broker → Backend order/position
WS#3 = Backend → Frontend realtime
WS#4 = Frontend → Backend commands

26. Backend Engines Should Not Use WebSockets Internally

If all engines run inside the same backend process/service boundary,
use:

Event Bus

async queues

internal function/service calls

shared state contracts

Do not use:

Feature Engine → WS → Connection Manager

when both are internal backend components.

Use:

Feature Engine
 ↓
Event Bus
 ↓
Connection Manager

27. Final Communication Table

Channel           Direction         Main Owner        Purpose

WS#1              Broker → Backend  WebSocket Engine  Market data
/ Manager

WS#2              Broker → Backend  Order Feed        Order + Position
Handler / Broker  events
Terminal

WS#3              Backend →         Connection        Realtime
Frontend          Manager           data/events

WS#4              Frontend →        Connection        Commands/control
Backend           Manager / Command
Router

REST              Frontend ↔        FastAPI + backend Search, snapshots,
Backend           engines           queries, previews

Broker REST       Backend ↔ Broker  Broker Terminal / Trading actions +
Order Engine      snapshots

28. Final Mental Model

                    KOTAK NEO
                       │
              ┌────────┴────────┐
              │                 │
            WS#1               WS#2
         Market Feed       Order/Position
              │                 │
              ▼                 ▼
       WebSocket Engine    Order Feed Handler
              │                 │
              └────────┬────────┘
                       ▼
                   Event Bus
                       │
             ┌─────────┼─────────┐
             ▼         ▼         ▼
         Market      Risk      Order
          Watch      Engine     Engine
             │         │         │
             └─────────┼─────────┘
                       ▼
               Connection Manager
                       │
                  ┌────┴────┐
                  │         │
                WS#3       WS#4
                  │         ▲
                  ▼         │
               FRONTEND ────┘
                  │
                  │ REST
                  ▼
               BACKEND API

Core Rules

WS#1 = broker market data.

WS#2 = broker order/position events.

WS#3 = backend → frontend realtime data.

WS#4 = frontend → backend commands.

REST = request/response, snapshots, search, previews and
queries.

Broker order actions use broker REST APIs, not WS#2.

WS#2 reports order/position events after broker-side changes.

Backend engines communicate internally through Event Bus/internal
calls, not unnecessary WebSockets.

Connection Manager is the frontend realtime bridge, not the broker
feed owner.

Frontend never directly connects to Kotak.

Frontend should use REST snapshot + WS#3 realtime events.

Backend remains the authoritative trading state.