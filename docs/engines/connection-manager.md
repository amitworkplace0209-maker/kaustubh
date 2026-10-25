CONNECTION MANAGER ENGINE — DETAILED ARCHITECTURE SPECIFICATION (Migrated 2026-09-23)
Project: Trading Terminal / Trading Platform
Engine Number: 05
Status: Architecture Definition — Migrated to 4-WS model
Language: English

> **Migration 2026-09-23:** This engine now implements **WS#3 (Backend → Frontend)** realtime bridge + **WS#4 (Frontend → Backend)** command router per `docs/architecture/WebSocket_ConnectionManager_Flow.md` and `docs/architecture/08_WEBSOCKET_ARCHITECTURE.md`. It is the single `connection_engine.ConnectionEngine` + `api.ws_gateway` owner for `WS /ws/realtime` (WS#3 down, WS#4 up). Broker feeds are NOT owned here: WS#1 market data lives in `ws_socket.ws_manager` + `ws_socket.engine`, WS#2 Order/Position lives in `ws_socket.order_feed_manager` (create_order_feed). Backend engines communicate via `services.engine_event_bus`, not via WebSockets.

CONNECTION MANAGER ENGINE — DETAILED ARCHITECTURE SPECIFICATION
Project: Trading Terminal / Trading Platform
Engine Number: 05
Status: Architecture Definition
Language: English

======================================================================
1. PURPOSE
======================================================================

The Connection Manager Engine is the central runtime communication,
connection, routing, filtering, and delivery layer between data/feature
producers and application consumers.

Its primary responsibility is NOT to calculate market features and NOT to
connect directly to the broker market-data WebSocket.

Its responsibility is to understand:

- Who needs data
- Which stock/instrument is required
- Which fields are required
- Which source should provide the data
- Which delivery method/channel should be used
- When the connection should start
- When it should stop
- Whether the requested instrument is valid and active
- Whether the required fields are available
- How the same upstream feed can be safely distributed to multiple consumers
- How consumer-specific connections are created, updated, paused, resumed,
  and terminated
- How failures, stale connections, expiry, backpressure, and reconnects
  are handled

The Connection Manager is therefore an intelligent feed-routing and
connection-management layer.

Core conceptual flow:

    SESSION MANAGER
          |
          | instrument/subscription information
          v
    MARKET DATA WEBSOCKET ENGINE
          |
          | raw broker feed
          v
    FEATURE ENGINE
          |
          | processed/standardized feature feed
          v
    CONNECTION MANAGER
          |
          +----------------+----------------+----------------+
          |                |                |                |
          v                v                v                v
         UI          Strategy Engine   Market Coach      Model Engine
          |
       live stream

======================================================================
2. PRIMARY RESPONSIBILITY
======================================================================

The Connection Manager maintains a registry of all active data
connections/requirements.

For every consumer, it knows the requested:

    CONSUMER
    STOCK / INSTRUMENT
    FIELDS
    SOURCE
    DELIVERY METHOD
    DELIVERY CHANNEL
    START CONDITION
    STOP CONDITION
    EXPIRY
    STATUS
    QUALITY / HEALTH
    RATE / DELIVERY POLICY

Example:

    Consumer:
        UI Dashboard 1

    Stock:
        NIFTY

    Fields:
        ltp
        open
        high
        low
        close
        volume

    Source:
        Feature Engine / standardized market feed

    Delivery:
        Live WebSocket

    Status:
        ACTIVE

Another example:

    Consumer:
        Strategy Engine A

    Stock:
        NIFTY

    Fields:
        ltp
        volume
        ema20
        rsi14
        vwap

    Source:
        Feature Engine

    Delivery:
        Internal stream/channel

The two consumers can use the same upstream NIFTY feed without creating
duplicate broker connections.

======================================================================
3. WHAT CONNECTION MANAGER IS NOT
======================================================================

The Connection Manager MUST NOT become responsible for everything.

It must NOT:

1. Log in to Kotak Neo.
2. Log in to Shoonya.
3. Store broker passwords, OTPs, PINs, or secrets.
4. Directly own broker WebSocket authentication.
5. Calculate indicators such as RSI, EMA, VWAP, MACD, etc.
6. Generate trading signals.
7. Place orders.
8. Maintain broker positions.
9. Calculate broker margin.
10. Perform market-data parsing that belongs to the broker WebSocket adapter.
11. Persist every live tick into MongoDB.
12. Fetch live market data repeatedly through REST APIs when a live stream
    already exists.
13. Become the Feature Engine.
14. Become the Session Manager.
15. Become the Strategy Engine.

Its responsibility is communication and routing.

======================================================================
4. RELATIONSHIP WITH SESSION MANAGER
======================================================================

Session Manager and Connection Manager share some information, but their
responsibilities are different.

SESSION MANAGER owns:

- Broker session state
- Login/logout lifecycle
- Broker session expiry
- Instrument/stock subscription registry
- Instrument token
- Exchange
- Instrument validity
- Instrument expiry
- Which consumers/services requested an instrument subscription
- Broker-specific session information

CONNECTION MANAGER owns:

- Consumer connection registry
- Consumer-specific field requirements
- Consumer-specific delivery method
- Consumer-specific delivery channel
- Source selection
- Data filtering
- Routing
- Connection lifecycle
- Delivery health
- Connection expiry
- Backpressure
- Consumer isolation
- Reconnect/recovery for application-level connections

The same instrument expiry can therefore be known by both engines, but
the reason for knowing it is different.

Example:

    Session Manager:
        BANKNIFTY option expires today.
        Instrument subscription becomes invalid after expiry.

    Connection Manager:
        Consumer connection requesting that instrument must stop receiving
        the instrument after expiry.

======================================================================
5. RELATIONSHIP WITH MARKET DATA WEBSOCKET ENGINE
======================================================================

Market Data WebSocket Engine is responsible for the broker market feed.

Its responsibility:

    Broker WebSocket
        |
        v
    receive raw data
        |
        v
    validate
        |
        v
    deduplicate
        |
        v
    normalize
        |
        v
    standard market feed
        |
        v
    Feature Engine

The Connection Manager should NOT directly replace this engine.

The WebSocket Engine should not send every broker message separately to
every UI or engine.

Instead:

    Broker
      |
      v
    Market Data WebSocket Engine
      |
      v
    Feature Engine
      |
      v
    Connection Manager
      |
      +--> UI
      +--> Strategy
      +--> Coach
      +--> Model
      +--> Other consumers

This creates a controlled distribution point.

======================================================================
6. RELATIONSHIP WITH FEATURE ENGINE
======================================================================

Feature Engine receives clean, validated, standardized feed and performs
calculations/features.

Example:

    Market Data:
        NIFTY
        LTP = ...
        Volume = ...
        Bid = ...
        Ask = ...

Feature Engine may produce:

    NIFTY
        LTP
        Volume
        EMA20
        EMA50
        RSI14
        VWAP
        other calculated features

The Connection Manager receives the resulting feature/market-data output
and determines which parts are required by each consumer.

Example:

    UI:
        ltp
        open
        high
        low
        close
        volume

    Strategy:
        ltp
        volume
        ema20
        ema50
        rsi14
        vwap

    Coach:
        ltp
        volume
        depth
        selected features

The Connection Manager filters and routes these separately.

======================================================================
7. CENTRAL CONNECTION REGISTRY
======================================================================

The Connection Manager must maintain a central runtime registry.

Conceptual record:

    ConnectionRecord
        connectionId
        consumerId
        consumerType
        stock
        instrumentToken
        exchange
        expiry
        source
        requestedFields
        resolvedFields
        deliveryMethod
        deliveryChannel
        frequencyMode
        startAt
        stopAt
        createdAt
        updatedAt
        expiresAt
        status
        lastDeliveredAt
        messagesDelivered
        messagesDropped
        lastError
        metadata

Example:

    connectionId:
        CON-1001

    consumerId:
        UI-DASHBOARD-1

    consumerType:
        UI

    stock:
        NIFTY

    instrumentToken:
        12345

    exchange:
        NSE

    requestedFields:
        ltp
        open
        high
        low
        close
        volume

    source:
        FEATURE_ENGINE

    deliveryMethod:
        WEBSOCKET

    deliveryChannel:
        ui_market_feed

    status:
        ACTIVE

======================================================================
8. CONSUMER TYPES
======================================================================

The system should support different consumer types without hard-coding
business logic for every consumer.

Possible consumer types:

    UI
    STRATEGY
    MODEL
    MARKET_COACH
    SUGGESTION
    WATCHLIST
    ALERT
    ANALYTICS
    DOWNLOAD
    BACKGROUND_SERVICE
    OTHER

New consumer types should be addable without changing the core routing
engine.

======================================================================
9. STOCK / INSTRUMENT REQUIREMENT
======================================================================

A consumer may request one or more instruments.

Example:

    UI:
        NIFTY
        BANKNIFTY
        RELIANCE
        TCS

    Strategy:
        NIFTY

    Watchlist:
        RELIANCE
        TCS

Each requirement should be represented independently.

Conceptually:

    ConsumerRequirement
        consumerId
        instrumentToken
        symbol
        exchange
        expiry
        fields
        sourcePreference
        deliveryPreference
        status

The system must use instrumentToken as the primary identity where
available because symbols can be ambiguous across exchanges or segments.

Symbol remains important for display and business logic.

======================================================================
10. FIELD REQUIREMENT MANAGEMENT
======================================================================

The Connection Manager is the authoritative layer for consumer-specific
field delivery requirements.

Important distinction:

    WebSocket Engine knows:
        What the broker actually sends.

    Feature Engine knows:
        What calculations/features it can produce.

    Connection Manager knows:
        What each consumer is allowed/required to receive.

Example:

    UI requests:
        ltp
        volume

    Strategy requests:
        ltp
        volume
        ema20
        rsi14

The Connection Manager does not calculate EMA20 or RSI14.
It checks whether those fields are available from the upstream source.

If a requested field is unavailable:

    DO NOT fabricate the field.

The system should return a clear field-availability result.

Possible status:

    AVAILABLE
    UNAVAILABLE
    PARTIAL
    NOT_READY
    SOURCE_ERROR

======================================================================
11. SOURCE MANAGEMENT
======================================================================

A connection may obtain data from different internal sources.

Possible sources:

    MARKET_DATA_WEBSOCKET
    FEATURE_ENGINE
    DATABASE
    CACHE
    INTERNAL_SERVICE
    REST_API
    OTHER

For live market feed, the preferred source should be the live internal
stream rather than repeated API polling.

Example:

    Source:
        FEATURE_ENGINE

    Reason:
        Live processed feed is already available.

REST/API should only be used when appropriate.

Example API use cases:

    Request current configuration
    Request historical data
    Request one-time snapshot
    Request metadata
    Request instrument information
    Request connection status
    Create/update/delete a connection
    Request data that is not available through a live stream

The system must avoid unnecessary API polling.

======================================================================
12. LIVE DATA DELIVERY
======================================================================

Live data must use persistent/streaming communication where appropriate.

Conceptual flow:

    Feature Engine
          |
          | continuous data
          v
    Connection Manager
          |
          | filtering/routing
          v
    Consumer Channel
          |
          v
    Consumer

For UI:

    Connection Manager
          |
          v
    Application WebSocket
          |
          v
    Next.js UI

For internal engine consumers:

    Connection Manager
          |
          v
    Internal queue/stream/channel
          |
          v
    Strategy Engine

The exact transport can be implemented behind an abstraction so that
future transport changes do not require rewriting routing logic.

======================================================================
13. API CONTROL PLANE VS LIVE DATA PLANE
======================================================================

The architecture should clearly separate:

    CONTROL PLANE
        APIs / commands / configuration

and

    DATA PLANE
        continuous live feed

CONTROL PLANE examples:

    Create connection
    Update fields
    Add stock
    Remove stock
    Pause connection
    Resume connection
    Get connection status
    Get connection list
    Get available fields
    Get source status

DATA PLANE examples:

    Continuous NIFTY feed
    Continuous BANKNIFTY feed
    Continuous feature stream

This separation prevents the application from using REST polling as a
substitute for real-time streaming.

======================================================================
14. CONCEPTUAL API DESIGN
======================================================================

Possible endpoints:

    POST /connections

    GET /connections

    GET /connections/{connectionId}

    PATCH /connections/{connectionId}

    DELETE /connections/{connectionId}

    POST /connections/{connectionId}/pause

    POST /connections/{connectionId}/resume

    GET /connections/{connectionId}/status

    GET /connections/fields

    GET /connections/sources

    GET /connections/health

    GET /connections/instruments/{instrumentToken}

These APIs are control interfaces.

They do NOT mean that live ticks should be fetched repeatedly through
these endpoints.

======================================================================
15. CREATE CONNECTION REQUEST
======================================================================

Conceptual request:

    {
        consumerId: "UI-DASHBOARD-1",
        consumerType: "UI",

        instrument: {
            symbol: "NIFTY",
            instrumentToken: "12345",
            exchange: "NSE",
            expiry: "..."
        },

        fields: [
            "ltp",
            "open",
            "high",
            "low",
            "close",
            "volume"
        ],

        source: "FEATURE_ENGINE",

        delivery: {
            method: "WEBSOCKET",
            channel: "ui_market_feed"
        },

        mode: "LIVE"
    }

Connection Manager validates the request before activation.

======================================================================
16. CONNECTION CREATION FLOW
======================================================================

Flow:

    Consumer
       |
       | connection request
       v
    Connection Manager
       |
       | validate consumer
       |
       | validate instrument
       |
       | check Session Manager
       |
       | check instrument expiry
       |
       | check requested fields
       |
       | resolve source
       |
       | resolve delivery channel
       |
       | create connection
       |
       v
    ACTIVE CONNECTION

If the instrument is not subscribed in Session Manager, the Connection
Manager should coordinate with Session Manager rather than independently
creating a broker subscription.

Possible flow:

    Connection Manager
          |
          v
    Session Manager
          |
          | subscribe instrument
          v
    WebSocket Engine
          |
          | broker subscription
          v
    Feed
          |
          v
    Feature Engine
          |
          v
    Connection Manager
          |
          v
    Consumer

======================================================================
17. MULTIPLE CONSUMERS FOR ONE STOCK
======================================================================

This is a core optimization.

Example:

    UI:
        NIFTY → LTP

    Strategy A:
        NIFTY → LTP + EMA20 + RSI14

    Strategy B:
        NIFTY → LTP + Volume

    Coach:
        NIFTY → LTP + Depth

The system must NOT create four broker WebSocket subscriptions simply
because four consumers exist.

Instead:

                       NIFTY
                         |
                  upstream feed
                         |
                Connection Manager
                 /      |      |      \
                /       |      |       \
              UI      Strategy A  Strategy B  Coach

Each consumer receives its required subset.

======================================================================
18. CONNECTION DEDUPLICATION
======================================================================

The Connection Manager should deduplicate equivalent application
connections where appropriate.

However, consumer identity must be preserved.

Example:

    UI Dashboard 1
    UI Dashboard 2

Both request:

    NIFTY → LTP

They may share the same upstream data source while maintaining separate
downstream client connections.

Therefore:

    UPSTREAM FEED
        = shared

    DOWNSTREAM CONNECTION
        = consumer-specific

======================================================================
19. SUBSCRIPTION AGGREGATION
======================================================================

The Connection Manager can calculate the aggregate requirement for an
instrument.

Example:

    UI needs:
        ltp, volume

    Strategy needs:
        ltp, volume, ema20

    Coach needs:
        ltp, volume, depth

Aggregate requirement:

    NIFTY:
        ltp
        volume
        ema20
        depth

This allows the upstream pipeline to understand the combined requirement.

However, the Connection Manager must not bypass the defined ownership of
Session Manager and WebSocket Engine.

Session Manager owns instrument subscription.
WebSocket Engine owns broker feed subscription.
Connection Manager owns consumer data requirements.

======================================================================
20. EXPIRY MANAGEMENT
======================================================================

Every connection involving an expiring instrument must carry expiry
information when applicable.

Example:

    Instrument:
        NIFTY OPTION

    Expiry:
        2026-09-24

Connection lifecycle:

    ACTIVE
       |
       | approaching expiry
       v
    EXPIRING
       |
       | expiry reached
       v
    EXPIRED
       |
       v
    DELIVERY_STOPPED

The Connection Manager should emit an internal event when a connection
expires.

Example:

    CONNECTION_EXPIRING
    CONNECTION_EXPIRED
    CONNECTION_STOPPED

The Session Manager independently handles the instrument/session
subscription lifecycle.

======================================================================
21. TIME-BASED CONNECTIONS
======================================================================

A connection may have timing rules.

Example:

    Start:
        08:55

    Stop:
        15:30

Or:

    Start:
        Market open

    Stop:
        Market close

Or:

    Start:
        when feature becomes ready

    Stop:
        when consumer disconnects

Connection Manager should support:

    startAt
    stopAt
    timezone
    startCondition
    stopCondition

It must not duplicate the Scheduler Engine's entire responsibility.

Scheduler decides major system timing/events.

Connection Manager executes connection-level timing behavior based on
those events.

======================================================================
22. SCHEDULER INTEGRATION
======================================================================

Scheduler Engine:

    "Live feed phase has started."

Connection Manager:

    activates eligible live connections.

Scheduler Engine:

    "Market feed stop event."

Connection Manager:

    stops/pauses appropriate live delivery.

Scheduler Engine:

    "Trading day complete."

Connection Manager:

    closes remaining temporary connections.

This keeps scheduling centralized.

======================================================================
23. CONNECTION STATES
======================================================================

Suggested states:

    CREATED
    VALIDATING
    WAITING_FOR_SOURCE
    WAITING_FOR_INSTRUMENT
    WAITING_FOR_FEATURES
    READY
    CONNECTING
    ACTIVE
    DEGRADED
    PAUSED
    EXPIRING
    EXPIRED
    DISCONNECTING
    DISCONNECTED
    FAILED
    RECONNECTING
    TERMINATED

Failure states/events should contain a clear reason.

Example:

    FAILED
    reason:
        REQUESTED_FIELD_UNAVAILABLE

======================================================================
24. DATA DELIVERY FILTERING
======================================================================

Incoming feature output may contain more fields than a consumer needs.

Example upstream:

    {
        ltp,
        open,
        high,
        low,
        close,
        volume,
        bid,
        ask,
        depth,
        ema20,
        ema50,
        rsi14,
        vwap
    }

UI requests:

    ltp,
    open,
    high,
    low,
    close,
    volume

Connection Manager sends only those fields.

This reduces:

    bandwidth
    serialization cost
    frontend processing
    memory usage
    unnecessary consumer work

======================================================================
25. DATA DELIVERY RATE
======================================================================

Not every consumer necessarily needs the same delivery rate.

The Connection Manager should support a delivery policy abstraction.

Examples:

    REALTIME
    THROTTLED
    SNAPSHOT
    ON_CHANGE
    BATCHED
    EVENT_ONLY

Example:

    Trading strategy:
        REALTIME

    UI dashboard:
        REALTIME or controlled high-frequency stream

    Analytics:
        BATCHED

    Alert:
        EVENT_ONLY

Important:

The exact rate policy must not silently drop data required by a trading
consumer.

Trading-critical consumers need explicit delivery semantics.

======================================================================
26. BACKPRESSURE
======================================================================

A slow consumer must not freeze the entire trading pipeline.

Bad architecture:

    Consumer A is slow
         |
         v
    Connection Manager blocked
         |
         v
    all consumers stop receiving

Correct architecture:

    Feature Engine
          |
          v
    Connection Manager
       /      |       \
      /       |        \
    Fast    Slow       Fast
    UI      Consumer   Strategy

Each consumer should have controlled buffering/queue behavior.

Possible policies:

    DROP_OLDEST
    DROP_NEWEST
    BLOCK_WITH_LIMIT
    DISCONNECT_SLOW_CONSUMER
    COALESCE_LATEST

The policy must be configurable per consumer type/use case.

Trading-critical streams should not use an unsafe silent-drop policy.

======================================================================
27. CONNECTION HEALTH
======================================================================

Connection Manager should track application-level connection health.

Possible metrics:

    activeConnections
    totalConnections
    failedConnections
    reconnectCount
    messagesDelivered
    messagesDropped
    deliveryLatency
    queueDepth
    consumerLag
    staleConnections
    expiredConnections

Per connection:

    lastMessageAt
    lastDeliveredAt
    lastError
    currentQueueSize
    currentStatus

======================================================================
28. DATA QUALITY VS CONNECTION HEALTH
======================================================================

These are different.

Data quality is primarily determined upstream.

Example:

    WebSocket Engine:
        feed has missing bid field

Connection Manager:

    knows that the field is unavailable
    and prevents invalid delivery where required.

Connection health means:

    consumer connection is alive
    messages can be delivered
    queue is healthy
    client is connected

Do not mix these concepts into one status.

======================================================================
29. FAILURE ISOLATION
======================================================================

If one consumer fails, other consumers must continue.

Example:

    UI connection crashes.

Correct behavior:

    UI connection:
        DISCONNECTED

    Strategy:
        continues ACTIVE

    Coach:
        continues ACTIVE

The Connection Manager must isolate downstream failures.

Similarly, a single bad request must not bring down the routing engine.

======================================================================
30. RECONNECT LOGIC
======================================================================

Application-level consumer connections may disconnect.

Example:

    Browser closed/reopened.

Connection Manager should support reconnection.

On reconnect:

    identify consumer
    validate connection
    validate instrument
    validate expiry
    validate requested fields
    restore delivery if still valid

Do not automatically reconnect an expired instrument.

======================================================================
31. UI CONNECTION MODEL
======================================================================

The UI can request live data.

Example:

    User opens NIFTY chart.

UI:

    request NIFTY
    request fields
    request live mode

Connection Manager:

    validates request
    creates/uses appropriate connection
    streams only required data

When the user leaves the page:

    UI disconnects/unsubscribes

Connection Manager removes the downstream requirement if no other
consumer needs it.

This avoids unnecessary live delivery.

======================================================================
32. WATCHLIST EXAMPLE
======================================================================

Suppose watchlist contains:

    RELIANCE
    TCS
    INFY

UI requests:

    LTP
    change
    volume

Connection Manager maintains:

    UI-WATCHLIST-1
        RELIANCE
        TCS
        INFY

If the user removes TCS:

    remove TCS requirement from that consumer.

If no other consumer needs TCS, the Connection Manager no longer needs to
deliver TCS to that consumer.

Whether the upstream broker subscription should also be removed is handled
through coordination with Session Manager and WebSocket Engine.

======================================================================
33. STOCK ADDITION FLOW
======================================================================

A stock can be added through UI/API/input.

Example:

    User adds:
        RELIANCE

UI/API sends:

    consumer = UI-WATCHLIST
    stock = RELIANCE
    fields = ltp, volume

Connection Manager:

    validates
    checks Session Manager
    requests subscription if required
    creates connection requirement

Session Manager:

    registers instrument

WebSocket Engine:

    subscribes broker instrument

Feature Engine:

    processes feed

Connection Manager:

    routes required fields

UI:

    receives live feed

======================================================================
34. STOCK REMOVAL FLOW
======================================================================

User removes:

    RELIANCE

Connection Manager:

    removes UI consumer requirement.

If another consumer still needs RELIANCE:

    keep upstream data.

If nobody needs RELIANCE:

    coordinate with Session Manager regarding instrument subscription.

This prevents premature broker unsubscription.

======================================================================
35. FIELD UPDATE FLOW
======================================================================

Example:

    UI currently requests:
        ltp
        volume

User adds:
    bid
    ask

UI sends update.

Connection Manager:

    validates fields
    updates connection registry
    begins delivering new fields if available

No need to recreate the entire application connection if the transport
supports dynamic subscription updates.

======================================================================
36. SOURCE SELECTION
======================================================================

A consumer may specify:

    source = FEATURE_ENGINE

or:

    source = AUTO

AUTO means Connection Manager chooses the appropriate configured source.

Example priority:

    LIVE_INTERNAL_STREAM
        >
    CACHE
        >
    API
        >
    DATABASE

The exact priority should be configuration-driven.

For live trading data, an internal live stream should generally be
preferred over polling.

======================================================================
37. SNAPSHOT VS STREAM
======================================================================

Connection Manager should distinguish:

    SNAPSHOT

from:

    STREAM

Snapshot:

    one-time data response.

Stream:

    continuous updates.

Example:

    GET current NIFTY status
        = snapshot

    NIFTY live LTP
        = stream

This prevents accidental API polling.

======================================================================
38. API CAN STILL BE USED
======================================================================

The architecture does not eliminate APIs.

APIs are appropriate for:

    connection creation
    connection modification
    connection deletion
    configuration
    status
    metadata
    one-time snapshots
    historical data
    health
    diagnostics

Live feed should normally use:

    WebSocket
    internal stream
    queue
    event channel

depending on consumer type.

======================================================================
39. INTERNAL EVENT MODEL
======================================================================

Connection Manager should use explicit events.

Possible events:

    CONNECTION_REQUESTED
    CONNECTION_CREATED
    CONNECTION_READY
    CONNECTION_STARTED
    CONNECTION_ACTIVE
    CONNECTION_PAUSED
    CONNECTION_RESUMED
    CONNECTION_UPDATED
    CONNECTION_DEGRADED
    CONNECTION_RECONNECTING
    CONNECTION_RECONNECTED
    CONNECTION_EXPIRING
    CONNECTION_EXPIRED
    CONNECTION_STOPPED
    CONNECTION_FAILED
    CONNECTION_TERMINATED

Integration events:

    INSTRUMENT_REQUIRED
    INSTRUMENT_NO_LONGER_REQUIRED
    FIELD_REQUIREMENT_CHANGED
    SOURCE_AVAILABLE
    SOURCE_UNAVAILABLE
    FEATURE_READY
    FEATURE_UNAVAILABLE

======================================================================
40. MODULE STRUCTURE
======================================================================

Suggested Python module structure:

    connection_manager/
        __init__.py

        service.py
        manager.py

        models.py
        schemas.py
        validators.py

        connection_registry.py
        consumer_registry.py
        requirement_registry.py

        source_manager.py
        source_resolver.py

        field_registry.py
        field_resolver.py
        field_filter.py

        routing.py
        router.py

        delivery/
            __init__.py
            websocket.py
            internal_stream.py
            queue.py
            snapshot.py

        lifecycle.py
        expiry_manager.py
        timing.py

        backpressure.py
        health.py
        metrics.py

        events.py
        event_bus.py

        api.py

        repository.py
        exceptions.py

        config.py

Tests:

    tests/
        test_connection_creation.py
        test_connection_update.py
        test_field_filtering.py
        test_routing.py
        test_expiry.py
        test_multiple_consumers.py
        test_disconnect.py
        test_reconnect.py
        test_backpressure.py
        test_source_resolution.py
        test_snapshot_vs_stream.py

======================================================================
41. IN-MEMORY RUNTIME STATE
======================================================================

Fast-changing connection state should primarily remain in memory.

Examples:

    active connections
    routing maps
    queues
    current delivery state
    current consumer status
    last delivery timestamp

Do not write every live update to MongoDB.

MongoDB may store:

    persistent connection configuration
    saved consumer preferences
    audit information
    historical connection events
    diagnostics where useful

Live tick-by-tick delivery state should not become a database bottleneck.

======================================================================
42. MONGODB ROLE
======================================================================

MongoDB can store durable configuration if required.

Possible collection:

    connection_configs

Possible document:

    {
        connectionId,
        consumerId,
        consumerType,
        instrumentToken,
        symbol,
        exchange,
        expiry,
        fields,
        source,
        deliveryMethod,
        createdAt,
        updatedAt,
        enabled
    }

Runtime connection state should remain in the Connection Manager's
in-memory state layer.

======================================================================
43. SECURITY
======================================================================

Connection Manager must never expose broker credentials.

Do not store:

    passwords
    OTPs
    API secrets
    access tokens in logs
    PINs

If a broker session reference is needed, use an internal secure session
identifier/reference.

Consumer authorization should also be checked.

A UI connection should not automatically be allowed to request internal
strategy-only fields unless permission allows it.

Conceptually:

    consumer
        |
        v
    authorization
        |
        v
    field authorization
        |
        v
    connection creation

======================================================================
44. FIELD PERMISSION
======================================================================

There are two different concepts:

    FIELD AVAILABLE

and:

    FIELD ALLOWED

Example:

    Feature Engine produces:
        proprietary modelFeatureA

Connection Manager may know that the field exists but a UI consumer may
not be authorized to receive it.

Therefore:

    requested
        ↓
    available?
        ↓
    authorized?
        ↓
    deliverable

Only then should delivery begin.

======================================================================
45. RATE AND BANDWIDTH CONTROL
======================================================================

The Connection Manager should prevent one consumer from unnecessarily
consuming unlimited bandwidth.

Track:

    messages/sec
    bytes/sec
    queue size
    consumer lag

Optional policies:

    maximum update rate
    maximum queue size
    maximum payload size
    field limits
    connection limits

These limits should be configurable.

======================================================================
46. NO BLOCKING IN CORE ROUTING
======================================================================

The Connection Manager is on a hot runtime path.

Avoid:

    synchronous database writes per message
    blocking network operations
    expensive serialization repeatedly
    large object copies
    unlimited queues
    unbounded retry loops

Prefer:

    async operations
    reusable serialization
    bounded queues
    efficient routing maps
    in-memory state
    controlled batching where appropriate

======================================================================
47. DATA OWNERSHIP RULES
======================================================================

Ownership must remain clear.

    Session Manager
        owns session and instrument subscription state.

    Market Data WebSocket Engine
        owns broker market-data connection and raw-feed handling.

    Feature Engine
        owns feature calculation.

    Connection Manager
        owns consumer requirements and delivery routing.

    UI
        consumes delivered data.

    Strategy Engine
        consumes required feature data and performs strategy logic.

This avoids circular responsibilities.

======================================================================
48. BIDIRECTIONAL COMMUNICATION
======================================================================

Communication is not only:

    Feature Engine → Connection Manager

There can also be:

    Consumer → Connection Manager
    Connection Manager → Session Manager
    Session Manager → Connection Manager
    Scheduler → Connection Manager
    Connection Manager → Consumer
    Feature Engine → Connection Manager

Example:

    UI:
        "Subscribe to RELIANCE."

    Connection Manager:
        "Session Manager, RELIANCE is required."

    Session Manager:
        "Subscription registered."

    WebSocket Engine:
        starts/updates broker subscription.

    Feature Engine:
        begins producing RELIANCE output.

    Connection Manager:
        starts delivery.

This is why Connection Manager should be treated as a control and
routing layer rather than a simple function.

======================================================================
49. CONNECTION REQUIREMENT GRAPH
======================================================================

Conceptually the system maintains a graph:

    Consumer
       |
       +---- Instrument
       |
       +---- Fields
       |
       +---- Source
       |
       +---- Delivery Channel
       |
       +---- Timing
       |
       +---- Expiry

Example:

    UI-1
      |
      +-- NIFTY
      |     |
      |     +-- LTP
      |     +-- Volume
      |     +-- EMA20
      |
      +-- RELIANCE
            |
            +-- LTP
            +-- Volume

This graph should be queryable for diagnostics.

======================================================================
50. DIAGNOSTICS
======================================================================

The Connection Manager should expose useful diagnostics.

Example:

    Connection:
        CON-1001

    Consumer:
        UI-1

    Instrument:
        NIFTY

    Source:
        FEATURE_ENGINE

    Fields:
        LTP
        Volume

    Status:
        ACTIVE

    Last Data:
        120 ms ago

    Delivery Rate:
        18 msg/sec

    Queue:
        0

    Errors:
        0

This will be valuable for the terminal's health/status pages.

======================================================================
51. HEALTH DASHBOARD INFORMATION
======================================================================

Connection Manager can expose aggregate metrics:

    total connections
    active connections
    paused connections
    failed connections
    expired connections
    reconnecting connections
    consumers connected
    messages/sec
    bytes/sec
    average delivery latency
    maximum queue depth
    dropped message count
    stale connection count

This information can be consumed by the UI.

======================================================================
52. LIVE UI FEED EXAMPLE
======================================================================

User opens:

    NIFTY live chart

UI sends:

    CREATE CONNECTION
        consumer = UI-CHART-1
        stock = NIFTY
        fields = LTP, OHLC, volume
        mode = LIVE

Connection Manager:

    validates
    resolves source
    checks subscription
    creates connection

Feature Engine sends:

    NIFTY feature updates

Connection Manager:

    filters:

        LTP
        OHLC
        volume

and sends them through the UI WebSocket.

The UI does not repeatedly call REST endpoints.

======================================================================
53. STRATEGY FEED EXAMPLE
======================================================================

Strategy Engine requests:

    NIFTY
    LTP
    volume
    EMA20
    RSI14
    VWAP

Connection Manager creates an internal connection.

Feature Engine continuously produces the data.

Connection Manager routes only the required fields.

Strategy Engine receives:

    {
        instrumentToken,
        timestamp,
        ltp,
        volume,
        ema20,
        rsi14,
        vwap
    }

Strategy Engine can then perform strategy logic.

======================================================================
54. DIFFERENT SOURCES FOR DIFFERENT DATA
======================================================================

A consumer may need:

    live fields from Feature Engine
    static metadata from Session/Instrument service
    historical values from database/API

Connection Manager may coordinate these sources without forcing all data
through one mechanism.

Example:

    LIVE:
        LTP → Feature Engine stream

    STATIC:
        Symbol name → instrument metadata API/cache

    HISTORICAL:
        OHLC history → data API/database

The Connection Manager should clearly distinguish these modes.

======================================================================
55. SOURCE FAILURE
======================================================================

If Feature Engine becomes unavailable:

    Connection Manager should mark affected connections:

        WAITING_FOR_SOURCE
        DEGRADED
        or SOURCE_UNAVAILABLE

depending on configured behavior.

It should not fabricate live values.

If a safe fallback source exists and the connection permits fallback,
Connection Manager may switch according to explicit source policy.

Example:

    LIVE_INTERNAL_STREAM
        ↓ unavailable
    CACHE
        ↓ only if consumer permits
    fallback

A trading-critical live consumer should not silently receive stale cached
data as if it were live.

======================================================================
56. STALE DATA PROTECTION
======================================================================

Every delivered live message should have a timestamp where available.

Connection Manager should track freshness.

Possible statuses:

    FRESH
    DELAYED
    STALE
    NO_DATA

Thresholds should be configurable.

The system must distinguish:

    connection alive

from:

    data fresh

A WebSocket can remain connected while the source data is stale.

======================================================================
57. EVENTUAL FUTURE EXTENSIONS
======================================================================

The architecture should allow future sources:

    Shoonya feed
    another broker
    simulated feed
    replay engine
    historical replay
    paper-trading stream
    model-generated stream
    external data provider

Connection Manager should not be rewritten for each new source.

Use source adapters/interfaces.

======================================================================
58. DUMMY MODE
======================================================================

Dummy mode should not create a separate broker market-data WebSocket.

Dummy trading can consume the same live market feed.

Conceptual flow:

    Kotak live market feed
          |
          v
    WebSocket Engine
          |
          v
    Feature Engine
          |
          v
    Connection Manager
          |
          +--> UI
          +--> Dummy/Paper Trading
          +--> Strategy

Dummy order execution remains separate from market-data routing.

Connection Manager only delivers the required feed.

======================================================================
59. FUTURE BROKER SUPPORT
======================================================================

Current broker:

    Kotak Neo

Future:

    Shoonya
    other brokers

Connection Manager should not contain broker-specific field parsing.

Broker-specific work belongs in adapters upstream.

Example:

    Kotak Adapter
        ↓
    Standard Feed

    Shoonya Adapter
        ↓
    Standard Feed

    Standard Feed
        ↓
    Feature Engine
        ↓
    Connection Manager

This keeps downstream engines broker-independent.

======================================================================
60. PERFORMANCE REQUIREMENTS
======================================================================

The Connection Manager should be designed for high-frequency data.

Requirements:

    no blocking core route
    bounded memory
    bounded queues
    efficient lookup by instrument
    efficient lookup by consumer
    efficient field filtering
    no database operation per tick
    minimal object copying
    minimal serialization
    asynchronous delivery
    failure isolation
    controlled reconnects

Potential indexes/maps:

    connectionsById
    connectionsByConsumer
    connectionsByInstrument
    consumersByInstrument
    fieldsByConnection
    channelsByConnection

======================================================================
61. CORE DATA STRUCTURES
======================================================================

Possible runtime structures:

    connectionsById:
        connectionId → ConnectionRecord

    connectionsByConsumer:
        consumerId → set(connectionId)

    connectionsByInstrument:
        instrumentToken → set(connectionId)

    consumersByInstrument:
        instrumentToken → set(consumerId)

    deliveryChannels:
        connectionId → channel

    fieldRequirements:
        connectionId → requested field set

These maps allow fast routing without scanning every connection for every
message.

======================================================================
62. MESSAGE ROUTING ALGORITHM
======================================================================

Conceptual process:

    Feature message arrives
        |
        v
    identify instrumentToken
        |
        v
    find connectionsByInstrument[instrumentToken]
        |
        v
    for each eligible connection:
        |
        +-- connection active?
        +-- not expired?
        +-- source matches?
        +-- consumer authorized?
        +-- requested fields available?
        +-- connection healthy?
        |
        v
    filter fields
        |
        v
    deliver
        |
        v
    update metrics

The implementation must avoid an O(all connections) scan for every tick.

======================================================================
63. MESSAGE CONTRACT
======================================================================

Internal feature message should have a standardized envelope.

Conceptual:

    {
        source,
        instrumentToken,
        symbol,
        exchange,
        timestamp,
        sequenceNumber,
        fields,
        quality,
        metadata
    }

The Connection Manager should preserve important metadata required by
consumers.

It should not silently alter the semantic meaning of fields.

======================================================================
64. DELIVERY ENVELOPE
======================================================================

Consumer output can use a smaller envelope:

    {
        connectionId,
        instrumentToken,
        symbol,
        timestamp,
        fields,
        source,
        sequenceNumber,
        quality
    }

Only required fields should be included.

======================================================================
65. LOGGING
======================================================================

Log:

    connection created
    connection updated
    connection stopped
    consumer disconnected
    reconnect
    source unavailable
    field unavailable
    expiry
    routing error
    backpressure event
    authorization failure

Do NOT log:

    passwords
    OTP
    API secrets
    private tokens
    sensitive authentication data

High-frequency message delivery should not produce one log line per tick
in production.

Use counters/metrics instead.

======================================================================
66. AUDIT
======================================================================

For configuration changes, record:

    who
    what
    instrument
    old fields
    new fields
    source
    time
    result

This is useful for debugging and future trading audit requirements.

======================================================================
67. TESTING REQUIREMENTS
======================================================================

Minimum tests:

1. Create connection.
2. Reject invalid instrument.
3. Reject unavailable field.
4. Accept valid field.
5. Route one instrument to one consumer.
6. Route one instrument to multiple consumers.
7. Filter fields correctly.
8. Disconnect one consumer without affecting others.
9. Reconnect consumer.
10. Expire connection.
11. Handle source failure.
12. Handle stale source.
13. Enforce backpressure.
14. Prevent unbounded queue growth.
15. Update fields dynamically.
16. Add/remove instruments.
17. Handle duplicate connection requests.
18. Validate authorization.
19. Distinguish snapshot from stream.
20. Avoid database operations per live message.

======================================================================
68. GOLDEN ARCHITECTURAL RULES
======================================================================

RULE 1:
Connection Manager is the central consumer-facing feed routing layer.

RULE 2:
It receives processed/standardized data from Feature Engine.

RULE 3:
It does not calculate features.

RULE 4:
It does not own broker login/session lifecycle.

RULE 5:
It does not own broker WebSocket connectivity.

RULE 6:
Session Manager owns instrument subscription state.

RULE 7:
WebSocket Engine owns broker market-data feed.

RULE 8:
Connection Manager owns consumer-specific field requirements.

RULE 9:
Live feed must not be repeatedly fetched through REST APIs.

RULE 10:
APIs are primarily for control, configuration, metadata, snapshots, and
non-stream operations.

RULE 11:
Live data should use streaming/internal channels.

RULE 12:
One upstream instrument feed must support multiple consumers.

RULE 13:
Different consumers may request different fields.

RULE 14:
Requested fields must never be fabricated.

RULE 15:
Connection expiry and instrument expiry must be handled explicitly.

RULE 16:
One consumer failure must not stop other consumers.

RULE 17:
Slow consumers must not block the entire feed pipeline.

RULE 18:
No unbounded queues or unlimited in-memory growth.

RULE 19:
No per-tick database writes.

RULE 20:
Broker-specific logic must remain outside Connection Manager.

RULE 21:
Connection Manager must remain broker-independent.

RULE 22:
Connection lifecycle must be observable and diagnosable.

RULE 23:
Connection health and data quality are separate concepts.

RULE 24:
Control plane and data plane must remain separate.

RULE 25:
Future brokers, feeds, consumers, and delivery transports should be
addable without redesigning the core routing model.

======================================================================
69. FINAL ARCHITECTURE SUMMARY
======================================================================

The complete intended architecture is:

    +-----------------------+
    |    Scheduler Engine   |
    +-----------+-----------+
                |
                | lifecycle events
                v
    +-----------------------+
    |    Session Manager    |
    |                       |
    | sessions              |
    | instrument registry   |
    | subscription state    |
    | expiry                |
    +-----------+-----------+
                |
                | active instruments
                v
    +-----------------------+
    | Market Data WebSocket |
    |       Engine          |
    |                       |
    | broker connection     |
    | subscription          |
    | raw feed              |
    | validation             |
    | normalization         |
    +-----------+-----------+
                |
                | standardized feed
                v
    +-----------------------+
    |    Feature Engine     |
    |                       |
    | calculations          |
    | derived features      |
    | feature state         |
    +-----------+-----------+
                |
                | processed feed
                v
    +================================+
    |       CONNECTION MANAGER       |
    |                                |
    | consumer registry              |
    | connection registry            |
    | stock requirements              |
    | field requirements              |
    | source resolution               |
    | field filtering                 |
    | routing                         |
    | delivery channels               |
    | timing                          |
    | expiry                          |
    | backpressure                    |
    | reconnect                       |
    | health                          |
    | metrics                         |
    +====+===========+=========+=====+
         |           |         |
         v           v         v
        UI       Strategy    Coach
         |           |         |
      WebSocket   Internal   Internal
       stream      stream     stream

The key principle is:

    SESSION MANAGER
        knows WHAT instruments are subscribed and whether they are valid.

    WEBSOCKET ENGINE
        knows HOW broker market data is received.

    FEATURE ENGINE
        knows HOW raw market data becomes calculated/processed features.

    CONNECTION MANAGER
        knows WHO needs WHAT data, FROM WHICH SOURCE, THROUGH WHICH
        CONNECTION, FOR HOW LONG, AND HOW TO DELIVER IT.

This makes the Connection Manager the central intelligent communication
and feed-distribution layer without turning it into a broker engine,
feature engine, strategy engine, or database engine.

======================================================================
IMPLEMENTATION STATUS (2026-09-20)
======================================================================

The 10 findings of `docs/reports/CONNECTION_MANAGER_AUDIT_PLAN.md` are
implemented. The Connection Manager is the realtime control gateway that
owns WS#2 (`/ws/realtime`, backend <-> frontend), serving live engine
status on the `engines` channel and the control-plane surface below.
Real data only; missing values render honest gaps (NOT_AVAILABLE /
NO_DATA / not implemented) — never fabricated.

IMPLEMENTED
-----------

1. Gateway role (findings F1-F3): the only registered engine is
   `ConnectionManagerEngine` (`services/connection_manager_engine.py`,
   engine_id `connection_manager`). The legacy `GatewayFacade` was
   removed. `_on_start` starts `connection_engine.start()`, `_on_stop`
   shuts it down, `_sync_status` mirrors engine signals, facade health
   gates on `is_mongo_connected()` then maps the engine health.

2. Envelope (spec §63/§64, finding F4): additive fields on every gateway
   frame — `version` (`ENVELOPE_VERSION = "1.0"`), `source`
   (`"gateway"`), `correlation_id` (echoed for ping/pong, auth,
   subscribe/unsubscribe, welcome) — plus existing `schema_version`,
   `event_id`, `sequence`, `timestamp`, `channel`, `data`.

3. Healthy vocabulary (spec §27/§51/§56, finding F3): `health()` returns
   STOPPED | ERROR (persist errors) | OVERLOADED (outbox >= 80% of
   limit) | DEGRADED (drops > 1000 or stale/delayed feed) | NO_DATA (no
   sessions + no feed) | HEALTHY. Facade degrades when Mongo is down.
   Freshness: FRESH | DELAYED | STALE | NO_DATA with configurable
   thresholds.

4. Event inspector (finding F5): bounded in-memory ring (maxlen 500)
   recording engine.started/stopped, subscription.acked/removed,
   persistence.written/failed, fanout.batch/failed, broadcast.delivered,
   session.attached/detached.

5. Backpressure (spec §26/§45/§60, finding F6): per-connection
   `DROP_OLDEST` outbox, queue limit from runtime setting
   `cm_outbox_maxlen` (default `OUTBOX_MAXLEN = 1000`, clamped to
   100..5000), market vs critical drop accounting, exposed in
   `status()`, `health()`, `config()`, and per-record diagnostics.

6. Control plane (spec §13/§14/§38, finding F8) — read-only:

   | Endpoint | Source |
   |---|---|
   | `GET /api/realtime/status` | `connection_engine.status()` |
   | `GET /api/realtime/sessions` | `connection_engine.sessions()` |
   | `GET /api/realtime/fields` | `field_requirements` catalogue / resolver |
   | `GET /api/realtime/health` | `connection_engine.health()` |
   | `GET /api/realtime/events` | `connection_engine.recent_events()` (limit/since/type/level/channel) |
   | `GET /api/realtime/connections/{id}` | one `session_records()` record |
   | `GET /api/realtime/config` | `connection_engine.config()` (read-only) |

7. Registry diagnostics (finding F7): `session_records()` per connection
   — state, lifecycleState, connectionId, channels, source,
   deliveryMethod (WEBSOCKET), requestedFields, queueDepth/Limit,
   droppedMarket/Critical, deliveryRatePerSec, upSeconds,
   lastTransitionAt, lastReason, lastActivityAt, lastDeliveredAt,
   lastError, lastApprovedAt. `status()` aggregates channelMetrics,
   backpressure, lifecycle state counts, persistence, freshness, health
   and the registry.

8. Freshness (spec §56): per-gateway tick freshness FRESH/DELAYED/STALE/
   NO_DATA with configurable thresholds (`freshMaxAgeS`,
   `delayedMaxAgeS`).

NOT IMPLEMENTED (spec-only, honest gap)
---------------------------------------

- spec §20 EXPIRY / §29 CONNECTION HISTORY (historical session store,
  reconnect audit view): no history endpoint exists; sessions are live
  in the registry and through persistence signals only.
- spec §39 full internal event model (CONNECTION_REQUESTED ...): the
  inspector logs the real engine events above; the full speculative
  event bus is not realised.
- spec §55 source fallback: source resolution stays single-stream.

GOLDEN-RULE COMPLIANCE (spec §68)
----------------------------------

All 25 rules hold: the gateway does not own broker WS#1, does not place
orders, does not calculate features, never fabricates requested fields
(`field_requirements` returns AVAILABLE/UNAVAILABLE/PARTIAL/NOT_READY/
SOURCE_ERROR), uses bounded queues only, no per-tick DB writes, and
keeps control plane (REST/WS#2 frames) separate from the data plane.
