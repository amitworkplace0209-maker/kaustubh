MARKET DATA WEBSOCKET ENGINE — WS#1 (Kotak → Backend Market Data)
ADVANCED & UPDATED FULL ARCHITECTURE
Version: Migrated 2026-09-23 to 4-WS model (WebSocket_ConnectionManager_Flow.md)
Mapping: This engine owns WS#1 ONLY (SFeed market data via ws_socket.ws_manager + ws_socket.engine). Order & Position streaming (WS#2) is owned by ws_socket.order_feed_manager.OrderFeedManager (create_order_feed) — not this engine. See docs/architecture/08_WEBSOCKET_ARCHITECTURE.md for the four-socket ownership matrix.

MARKET DATA WEBSOCKET ENGINE
ADVANCED & UPDATED FULL ARCHITECTURE
Version: Locked Design Draft

============================================================
1. PURPOSE
============================================================

The Market Data WebSocket Engine is the application's dedicated
live-market-data ingestion engine.

Its responsibility is intentionally narrow:

1. Start at 08:55 AM.
2. Obtain the current active subscribed-instrument list from Session Manager.
3. Connect to the broker WebSocket.
4. Subscribe to the required instruments.
5. Receive live market data from the broker WebSocket.
6. Handle broker-specific feed responses through a broker adapter.
7. Validate every incoming feed response.
8. Detect and remove duplicate messages/ticks where the broker protocol
   provides enough information to identify them safely.
9. Normalize broker-specific data into the application's standard
   market-feed schema.
10. Monitor feed quality, field availability, message rate, latency,
    stale feeds and other measurable feed-health signals.
11. Deliver the clean standardized live feed to the Feature Engine.
12. Stop and close the WebSocket at 03:31 PM.

The WebSocket Engine is NOT a general-purpose data distributor.

It does not directly deliver live data to:
- UI
- Position Engine
- P&L Engine
- Dummy Engine
- Order Engine
- Watchlist Engine
- Other downstream engines

The Feature Engine is the defined downstream consumer in this
architecture.

============================================================
2. HIGH-LEVEL ARCHITECTURE
============================================================

                    SCHEDULER
                        |
                        | 08:55 START
                        v
              MARKET DATA WEBSOCKET ENGINE
                        |
             +----------+-----------+
             |                      |
             v                      v
      SESSION MANAGER          BROKER ADAPTER
             |                      |
      Active Instrument        Kotak Neo Adapter
          List                     |
             |                      |
             +----------+-----------+
                        |
                        v
               KOTAK BROKER
                WEBSOCKET
                        |
                        | RAW LIVE FEED
                        v
              MARKET DATA ENGINE
                        |
        +---------------+----------------+
        |               |                |
        v               v                v
     Validate       Deduplicate       Normalize
        |               |                |
        +---------------+----------------+
                        |
                        v
               Feed Quality Monitor
                        |
                        v
                 FEATURE ENGINE
                        |
                        v
              Feature Calculations

============================================================
3. CORE RESPONSIBILITY BOUNDARY
============================================================

SESSION MANAGER:

"Which instruments should be active/subscribed?"

It owns:
- broker session state
- stock/instrument registry
- subscription registry
- instrument expiry

WEBSOCKET ENGINE:

"How do I receive the live market feed for those instruments?"

It owns:
- broker WebSocket connection
- subscription execution
- live feed reception
- broker adapter
- feed validation
- duplicate handling
- normalization
- feed-quality monitoring
- Feature Engine handoff
- WebSocket shutdown

FEATURE ENGINE:

"What calculations/features should be produced from the clean feed?"

It owns:
- indicators
- calculations
- derived features
- strategy/feature processing as defined later

============================================================
4. DAILY LIFECYCLE
============================================================

08:55 AM
    |
    v
START
    |
    v
Check/obtain required broker session state
    |
    v
Ask Session Manager for active subscription list
    |
    v
Connect to broker WebSocket
    |
    v
Subscribe active instruments
    |
    v
Receive live feed
    |
    v
Adapter
    |
    v
Validation
    |
    v
Duplicate detection
    |
    v
Normalization
    |
    v
Feed-quality monitoring
    |
    v
Feature Engine
    |
    v
03:31 PM
    |
    v
Stop receiving
    |
    v
Unsubscribe/cleanup
    |
    v
Close broker WebSocket
    |
    v
WEBSOCKET CLOSED

============================================================
5. 08:55 START SEQUENCE
============================================================

At 08:55 the Scheduler triggers the Market Data WebSocket Engine.

Step 1:
Initialize engine state.

Step 2:
Verify that the required broker session is available.

Step 3:
Request active subscribed instruments from Session Manager.

Step 4:
Validate the received subscription list locally.

Step 5:
Initialize the broker-specific adapter.

Step 6:
Connect to the broker WebSocket.

Step 7:
Subscribe to the active instruments.

Step 8:
Enter LIVE state.

Step 9:
Start processing incoming broker feed messages.

Important:

The WebSocket Engine does NOT create the stock list itself.

Session Manager is the source of the active subscription list.

============================================================
6. SESSION MANAGER INPUT
============================================================

Conceptual request:

GET /session/stocks/active

The returned records may contain:

symbol
instrumentToken
exchange
expiry
status

Example:

{
    "symbol": "NIFTY...",
    "instrumentToken": "123456",
    "exchange": "NFO",
    "expiry": "2026-09-24",
    "status": "ACTIVE"
}

The WebSocket Engine uses this information to subscribe to the broker
feed.

It does not modify the authoritative stock registry.

============================================================
7. BROKER ADAPTER
============================================================

The broker adapter is a critical abstraction.

The broker can use any field names, payload structure, message type,
encoding or protocol-specific representation.

The application must not allow those broker-specific details to leak
into the Feature Engine.

Recommended structure:

market_data_websocket/
|
+-- engine.py
+-- connection.py
+-- subscription.py
+-- adapters/
|    +-- base.py
|    +-- kotak_neo.py
|    +-- future_broker.py
|
+-- validation/
|    +-- validator.py
|    +-- rules.py
|
+-- deduplication/
|    +-- deduplicator.py
|
+-- normalization/
|    +-- normalizer.py
|
+-- quality/
|    +-- monitor.py
|    +-- metrics.py
|
+-- models.py
+-- events.py
+-- exceptions.py

============================================================
8. KOTAK NEO ADAPTER
============================================================

Kotak Neo is the current primary broker feed.

The Kotak adapter is responsible for understanding the actual Kotak
WebSocket response format.

It should handle:

- connection-specific protocol details
- subscription message construction
- unsubscribe message construction
- broker message parsing
- broker field mapping
- message-type identification
- broker sequence information if provided
- broker timestamp if provided
- quote/depth payload interpretation
- broker error responses

The exact field mapping must be based on the actual Kotak SDK/WebSocket
response contract used by the project.

No invented field mapping should be used.

============================================================
9. STANDARD INTERNAL FEED
============================================================

After adapter processing, the application should use a stable internal
feed schema.

Conceptual structure:

MarketFeed
    symbol
    instrumentToken
    exchange
    timestamp
    receiveTimestamp
    ltp
    open
    high
    low
    close
    volume
    bid
    ask
    bidQuantity
    askQuantity
    depth
    feedType
    source
    sequenceNumber
    availableFields
    qualityStatus

Not every broker must provide every field.

Unavailable fields must remain explicitly unavailable.

The engine must NOT invent values.

For example:

bid = AVAILABLE
ask = AVAILABLE
depth = AVAILABLE
openInterest = NOT_AVAILABLE

============================================================
10. FIELD AVAILABILITY TRACKING
============================================================

The engine must know what fields are actually arriving.

For each instrument/feed type, track:

- total fields expected by the standard schema
- fields received
- fields missing
- fields null
- fields invalid
- fields successfully normalized

Example:

NIFTY

Expected fields: 24
Received: 21
Missing: 2
Null: 1
Invalid: 0

Field matrix:

LTP            -> RECEIVED
Open           -> RECEIVED
High           -> RECEIVED
Low            -> RECEIVED
Close          -> RECEIVED
Volume         -> RECEIVED
Bid            -> RECEIVED
Ask            -> RECEIVED
Depth          -> RECEIVED
OI             -> NOT_RECEIVED

The exact expected-field list must be based on the broker/feed type and
the application's standard schema.

============================================================
11. FIELD STATUS DEFINITIONS
============================================================

Every standardized field may have a status such as:

RECEIVED
NOT_RECEIVED
NULL_VALUE
INVALID
UNSUPPORTED

Important distinction:

NOT_RECEIVED:
The broker response did not contain the field.

NULL_VALUE:
The field existed but its value was null/empty.

INVALID:
The field existed but failed validation.

UNSUPPORTED:
The broker/feed type does not provide that field.

This prevents the system from incorrectly reporting missing data as a
broker failure.

============================================================
12. RESPONSE VALIDATION
============================================================

Every broker feed response should pass through validation before being
handed to the Feature Engine.

Validation layers:

1. Transport/message validation
2. Message-type validation
3. Schema validation
4. Instrument validation
5. Data-type validation
6. Value sanity validation
7. Timestamp validation
8. Sequence validation where supported

Conceptual flow:

RAW MESSAGE
    |
    v
Message Parser
    |
    v
Schema Validation
    |
    v
Instrument Validation
    |
    v
Field Validation
    |
    v
Value Validation
    |
    v
VALID / INVALID

Invalid data should not silently enter the Feature Engine.

============================================================
13. EXAMPLES OF BASIC VALIDATION
============================================================

Potential checks:

- expected message type
- valid instrument token
- valid exchange
- numeric LTP where LTP is present
- numeric quantity where quantity is present
- non-negative volume where applicable
- valid timestamp
- valid sequence number where provided
- valid depth structure
- valid bid/ask structure

The exact rules must be adapted to the actual broker protocol and market
data semantics.

============================================================
14. DUPLICATE DETECTION
============================================================

The engine must detect duplicate feed messages where safe identification
is possible.

Preferred identity signals:

1. Broker sequence number, if available.
2. Broker message ID, if available.
3. Otherwise a carefully constructed payload identity.

Do NOT blindly assume:

same timestamp = duplicate

because multiple legitimate updates may share the same timestamp.

Conceptual:

Instrument + Sequence Number
        |
        v
Already seen?
    /         YES        NO
   |          |
 DROP       ACCEPT

Duplicate counts should be monitored.

============================================================
15. SEQUENCE GAP DETECTION
============================================================

If the broker supplies sequence numbers:

Example:

1001
1002
1003
1005

The engine detects:

1004 missing

Status:

SEQUENCE_GAP

This should be reported to the Feed Quality Monitor.

If the broker does not provide a usable sequence number, the engine
must not fabricate sequence-gap metrics.

============================================================
16. NORMALIZATION
============================================================

The Feature Engine should never need to understand broker-specific
field names.

Flow:

Kotak Raw Feed
    |
    v
Kotak Adapter
    |
    v
Validated Broker Feed
    |
    v
Standard Normalizer
    |
    v
MarketFeed
    |
    v
Feature Engine

Normalization can include:

- field-name mapping
- type normalization
- timestamp normalization
- instrument identity normalization
- depth structure normalization
- feed-type normalization
- source metadata

============================================================
17. DEPTH / L8 DATA
============================================================

The WebSocket Engine can receive market-depth/L8 data when the broker
feed provides it.

Its responsibility is:

RAW DEPTH
    -> parse
    -> validate
    -> normalize
    -> pass to Feature Engine

It does NOT:
- calculate depth-based signals
- decide buy/sell
- calculate strategy features
- make trading decisions

Depth analysis belongs to the Feature Engine or the relevant downstream
calculation engine.

============================================================
18. FEED QUALITY MONITOR
============================================================

The WebSocket Engine should maintain a dedicated Feed Quality Monitor.

Per instrument, monitor:

- feed status
- last received time
- message count
- messages/second
- field availability
- missing fields
- null fields
- invalid fields
- duplicate count
- sequence gaps
- latency where measurable
- stale status
- connection status

Example:

NIFTY
--------------------------------
Status: LIVE
Fields Received: 21/24
Missing: 2
Null: 1
Invalid: 0
Duplicates: 17
Sequence Gaps: 0
Updates/sec: 145
Average Latency: 12 ms
Last Feed: 10:32:15.234

============================================================
19. FEED SPEED
============================================================

Track at least:

1. Overall messages per second.
2. Per-instrument messages per second.

Example:

Overall:
18,420 messages/sec

Per instrument:
NIFTY       180/sec
BANKNIFTY   165/sec
RELIANCE     42/sec
TCS          31/sec

Useful rolling metrics can include:

- current rate
- average rate
- minimum rate
- maximum rate

A short rolling window should be used rather than relying only on a
single instantaneous count.

============================================================
20. LATENCY
============================================================

If broker timestamp is available:

Broker Timestamp
       |
       v
Local Receive Timestamp
       |
       v
Measured Feed Latency

Track:

- minimum
- average
- maximum
- p50
- p95
- p99

Example:

Broker timestamp: 10:30:00.120
Receive timestamp: 10:30:00.132
Measured latency: approximately 12 ms

If broker timestamp is unavailable, only local receive timing should be
reported. The engine must not invent broker latency.

============================================================
21. STALE FEED DETECTION
============================================================

A subscribed instrument may stop producing data.

Track:

lastFeedTimestamp
currentTime
elapsedTime

Possible statuses:

LIVE
DEGRADED
STALE
NO_FEED

Thresholds must be configurable and appropriate for the specific feed
type/instrument.

Do not use an arbitrary universal timeout for every instrument.

============================================================
22. OVERALL FEED HEALTH
============================================================

The engine should maintain both:

A. Per-instrument health
B. Overall WebSocket/feed health

Example overall snapshot:

Total Instruments: 250
LIVE: 244
DEGRADED: 2
STALE: 3
NO_FEED: 1

Messages/sec: 18,420
Invalid Messages: 23
Duplicates: 841
Sequence Gaps: 3

This data is for monitoring/diagnostics and does not change the core
feed-routing responsibility.

============================================================
23. RUNTIME STOCK ADD
============================================================

If Session Manager adds a new active instrument while the WebSocket is
already running:

UI / Engine
    |
    v
Session Manager
    |
    v
Stock Registry
    |
    v
STOCK_ADDED
    |
    v
WebSocket Engine
    |
    v
Broker Adapter
    |
    v
Broker Subscribe

The WebSocket Engine should not independently create authoritative stock
records.

============================================================
24. RUNTIME STOCK EXPIRY
============================================================

Session Manager detects instrument expiry.

Flow:

Expiry Manager
    |
    v
STOCK_EXPIRED
    |
    v
WebSocket Engine
    |
    v
Broker Unsubscribe
    |
    v
Feed monitoring cleanup

The expired instrument should no longer be treated as an active feed.

============================================================
25. SUBSCRIPTION SYNC
============================================================

At WebSocket startup:

Session Manager = source of truth.

The engine obtains:

ACTIVE INSTRUMENT LIST

It should:

- validate list
- remove duplicate instrument identifiers locally
- ignore expired/inactive records
- subscribe valid instruments

The engine should not overwrite Session Manager's registry.

============================================================
26. CONNECTION STATE MACHINE
============================================================

Recommended states:

STOPPED
STARTING
SESSION_CHECK
LOADING_SUBSCRIPTIONS
CONNECTING
CONNECTED
SUBSCRIBING
LIVE
DEGRADED
RECONNECTING
STOPPING
CLOSED
ERROR

Typical flow:

STOPPED
  -> STARTING
  -> SESSION_CHECK
  -> LOADING_SUBSCRIPTIONS
  -> CONNECTING
  -> CONNECTED
  -> SUBSCRIBING
  -> LIVE
  -> STOPPING
  -> CLOSED

============================================================
27. CONNECTION FAILURE
============================================================

If broker WebSocket connection fails:

CONNECTED
    |
    v
CONNECTION_ERROR
    |
    v
RECONNECTING
    |
    v
CONNECTING
    |
    v
CONNECTED

Reconnection policy must be controlled and bounded.

The engine should not create unlimited reconnect loops.

Backoff, retry count and retry state should be observable.

============================================================
28. SESSION FAILURE VS WEBSOCKET FAILURE
============================================================

These are different failure domains.

Broker Session failure:
Session Manager responsibility.

WebSocket connection failure:
WebSocket Engine responsibility.

A WebSocket disconnect does NOT automatically mean the broker session
has expired.

The engine should request/revalidate session state when required instead
of making assumptions.

============================================================
29. 03:31 PM SHUTDOWN
============================================================

At 03:31 PM Scheduler triggers shutdown.

Recommended sequence:

1. Stop accepting/processing new market-data messages.
2. Stop downstream feed handoff.
3. Stop active subscriptions.
4. Close broker WebSocket.
5. Clear connection-specific runtime state.
6. Finalize feed metrics.
7. Emit WEBSOCKET_CLOSED.
8. Enter CLOSED state.

The exact broker-specific unsubscribe/close order must follow the actual
broker WebSocket contract.

============================================================
30. 03:30 VS 03:31
============================================================

These remain separate events.

03:30 PM:
Broker-side feed stop event as defined by the Scheduler architecture.

03:31 PM:
Application WebSocket Engine shutdown.

Do not merge these two times into one responsibility.

============================================================
31. PROJECT WEBSOCKET
============================================================

The WebSocket Engine described here is primarily responsible for the
broker market-data WebSocket ingestion and Feature Engine handoff.

A separate project/frontend WebSocket, if required, should not be mixed
into this engine's core broker-feed responsibility.

The engine should not become a general UI broadcast server.

============================================================
32. FEATURE ENGINE HANDOFF
============================================================

Only clean standardized feed should cross the boundary.

Correct:

Broker
  -> Adapter
  -> Validator
  -> Deduplicator
  -> Normalizer
  -> Quality Metadata
  -> Feature Engine

Incorrect:

Broker
  -> raw broker payload
  -> Feature Engine

Feature Engine should receive a stable internal contract independent of
Kotak-specific field names.

============================================================
33. FEED QUALITY DOES NOT MODIFY DATA SILENTLY
============================================================

Monitoring and normalization must not hide data problems.

Example:

If OI is missing:

Correct:
    OI = NOT_RECEIVED

Incorrect:
    OI = 0

unless the broker's protocol explicitly defines 0 as the actual value.

Similarly:

Missing volume should not silently become zero.

This is important for calculation correctness.

============================================================
34. DATA PRESERVATION
============================================================

The engine should preserve enough metadata for diagnostics:

- source broker
- original message type
- instrument identity
- broker timestamp if available
- receive timestamp
- sequence/message ID if available
- validation status
- normalized field availability

However, the WebSocket Engine is not the historical market-data storage
engine.

Long-term tick storage belongs to the dedicated Data Pipeline/Storage
architecture.

============================================================
35. PERFORMANCE REQUIREMENTS
============================================================

Because live market data can be high-frequency:

- Avoid blocking operations in the receive path.
- Avoid database writes for every tick.
- Avoid synchronous heavy calculations in the WebSocket receive loop.
- Use efficient parsing.
- Use bounded queues where queues are required.
- Avoid unnecessary object copying.
- Keep broker adapter lightweight.
- Keep validation efficient.
- Keep metrics aggregation in memory and flush/aggregate separately.
- Apply backpressure deliberately rather than allowing unlimited memory
  growth.

The Feature Engine should process the standardized feed asynchronously
where the final architecture requires it.

============================================================
36. BACKPRESSURE
============================================================

If Feature Engine processing becomes slower than incoming feed:

Do NOT allow an unlimited queue.

Possible states:

NORMAL
    |
    v
QUEUE_BUILDUP
    |
    v
BACKPRESSURE
    |
    v
DEGRADED

The final drop/coalescing policy must be explicitly defined according to
the importance of each feed type.

Critical trading/calculation data must never be silently dropped without
a defined policy.

============================================================
37. MEMORY SAFETY
============================================================

The engine must avoid:

- unlimited tick buffers
- unlimited duplicate caches
- unlimited metrics history
- unbounded reconnect state
- per-tick database persistence

Use bounded/TTL-based structures where appropriate.

Duplicate detection state should expire according to the protocol and
required replay window.

============================================================
38. OBSERVABILITY
============================================================

Useful metrics:

websocket_connection_state
websocket_reconnect_total
websocket_connection_errors_total

subscribed_instruments
active_feed_instruments

feed_messages_total
feed_messages_per_second

feed_invalid_total
feed_duplicate_total
feed_sequence_gap_total

feed_stale_total
feed_no_feed_total

feed_latency_ms
feed_latency_p95_ms
feed_latency_p99_ms

field_received_total
field_missing_total
field_invalid_total

============================================================
39. LOGGING
============================================================

Important logs:

WEBSOCKET_STARTING
SESSION_CHECKED
SUBSCRIPTION_LIST_LOADED
WEBSOCKET_CONNECTING
WEBSOCKET_CONNECTED
SUBSCRIPTION_STARTED
SUBSCRIPTION_FAILED

FEED_VALIDATION_FAILED
DUPLICATE_FEED_DROPPED
SEQUENCE_GAP_DETECTED
STALE_FEED_DETECTED

WEBSOCKET_RECONNECTING
WEBSOCKET_STOPPING
WEBSOCKET_CLOSED

Logs should identify:
- broker
- instrument
- event
- timestamp
- error category

Avoid logging sensitive session credentials.

============================================================
40. TESTING STRATEGY
============================================================

Unit tests:

1. Adapter field mapping
2. Message parsing
3. Validation
4. Duplicate detection
5. Sequence-gap detection
6. Normalization
7. Field availability
8. Stale detection
9. Latency calculation
10. Subscription handling

Integration tests:

1. Session Manager -> WebSocket Engine
2. WebSocket Engine -> Kotak adapter
3. Broker feed -> normalized feed
4. Normalized feed -> Feature Engine

Failure tests:

1. Broker disconnect
2. Session expired
3. Invalid payload
4. Missing field
5. Duplicate message
6. Sequence gap
7. No feed
8. Reconnect
9. Instrument expiry
10. 03:31 shutdown

============================================================
41. IDEMPOTENCY
============================================================

Subscribe operation should be safe against repeated requests.

Example:

Subscribe NIFTY
Subscribe NIFTY

Result:
one effective subscription.

Unsubscribe operation should also tolerate repeated calls.

The engine should not create duplicate local subscription state.

============================================================
42. BROKER EXPANSION
============================================================

Current primary:

Kotak Neo Adapter

Future:

Shoonya Adapter
Other Broker Adapter

The Feature Engine should continue consuming the same standard MarketFeed
contract.

Architecture:

             Broker A
                |
             Adapter A
                |
                v
          Standard Feed
                ^
                |
             Adapter B
                |
             Broker B

This makes broker expansion possible without rewriting Feature Engine
logic.

============================================================
43. FINAL END-TO-END FLOW
============================================================

                 SCHEDULER
                     |
                   08:55
                     |
                     v
          MARKET DATA WEBSOCKET ENGINE
                     |
                     v
              SESSION MANAGER
                     |
                     v
         ACTIVE SUBSCRIBED INSTRUMENTS
                     |
                     v
             KOTAK WEB SOCKET
                     |
                     v
              RAW LIVE FEED
                     |
                     v
             KOTAK NEO ADAPTER
                     |
                     v
                VALIDATOR
                     |
                     v
              DEDUPLICATOR
                     |
                     v
               NORMALIZER
                     |
                     v
          FEED QUALITY MONITOR
                     |
                     v
               FEATURE ENGINE
                     |
                     v
              Feature Processing

At 03:31:

Scheduler
    |
    v
WebSocket Engine STOP
    |
    v
Unsubscribe / Cleanup
    |
    v
Close Broker WebSocket
    |
    v
WEBSOCKET CLOSED

============================================================
44. GOLDEN RULES
============================================================

1. WebSocket Engine starts at 08:55 AM.
2. Session Manager provides the active subscription list.
3. Broker WebSocket is the source of live market data.
4. Current primary broker feed is Kotak Neo.
5. Broker-specific responses are handled through an adapter.
6. Feature Engine never depends directly on broker-specific field names.
7. Every incoming feed response must pass validation.
8. Duplicate messages must be removed when safely identifiable.
9. Sequence gaps must be detected when broker sequence information exists.
10. Field availability must be measurable per instrument/feed.
11. Missing, null and invalid fields must be distinguished.
12. The engine must report feed speed.
13. The engine must report measurable feed latency.
14. The engine must detect stale/no-feed conditions.
15. Market depth/L8 data is received, validated and normalized when
    provided by the broker.
16. The engine sends clean standardized live data to the Feature Engine.
17. It does not directly distribute live data to every other engine.
18. It does not perform Feature/P&L/Position/Order calculations.
19. It does not own the authoritative stock registry.
20. It does not become the historical tick-storage engine.
21. WebSocket connection failure and broker-session failure remain separate
    failure domains.
22. 03:30 broker feed-stop and 03:31 application WebSocket shutdown remain
    separate events.
23. Dummy mode does not create a Dummy WebSocket.
24. Dummy mode uses the common Kotak live feed downstream as designed.
25. The receive path must remain lightweight and performance-safe.

============================================================
45. FINAL DESIGN STATEMENT
============================================================

The Market Data WebSocket Engine is a controlled ingestion and
normalization layer.

Its clean contract is:

Session Manager:
    "These are the instruments that should be subscribed."

WebSocket Engine:
    "I will connect to the broker WebSocket, subscribe to those
     instruments, receive the live feed, validate it, remove safe
     duplicates, normalize it, measure feed quality, and provide the
     clean standardized feed to the Feature Engine."

Feature Engine:
    "I will consume the standardized feed and perform calculations."

This separation keeps broker-specific protocol logic, feed-quality
control and live-feed transport isolated from feature/calculation logic,
while keeping the high-frequency receive path fast, observable and
extensible.

============================================================
46. IMPLEMENTATION STATUS (REALIZED ARCHITECTURE)
============================================================

The design above is intentionally narrow and it is preserved exactly in
the running system. This section records how the implemented runtime
maps onto the design. It is NOT a new spec; it documents where each
design element physically lives so the UI and future changes can be
traced to the actual certified source of truth.

46.1 Single-owner WebSocket rule (confirmed)

There is exactly one broker/session WebSocket in the entire Python
service. It is owned by the ws_manager module singleton:

    WebSocketFacade   (services/legacy_engine_facades.py:262, compat only)
      -> WebSocketEngine
         -> ws_manager/SFeedWebSocket   (ws_socket/ws_manager.py, WS#1 owner)
            -> Broker WebSocket  #1

- No UI, library, feature, watchlist or market-watch component opens a
  broker socket.
- `set_publish_hook` is the only path from WS#1 into the engine.
- Only the engine emits `TICK_*` events.
- `api/ws_engine.py::_get_engine()` is the only wire-up; it attaches the
  publish hook and the owner reference on first use and never creates a
  second socket or registry.

The project/frontend realtime channel (WS#2, Connection Manager) is a
separate monitor WebSocket and is NOT part of this engine.

46.2 Runtime module map

| Design block              | Implementation                                      |
|---------------------------|-----------------------------------------------------|
| Engine facade             | `ws_socket/engine/engine.py` (status/metrics/quality/resources/live_feed/raw_stream) |
| Broker WS connection      | `ws_socket/ws_manager.py` `SFeedWebSocket` + `BrokerWebSocketSupervisor` |
| Subscription execution    | `ws_manager.subscribe()` / `unsubscribe()` (message-1109 ack) |
| Broker adapter            | Kotak Neo SDK feed classes via `_on_websocket_*` handlers |
| Validation                | `ws_socket/engine/validation.py` (rules + per-field statuses) |
| Deduplication             | sequence/token identity in feed ingestion pipeline |
| Normalization             | `ws_socket/engine/fields.py` -> standard internal feed schema |
| Field availability        | `ws_socket/engine/field_verification.py` per feed level |
| Feed-quality monitor      | `ws_socket/engine/quality.py` (summary + thresholds + per-instrument) |
| Feed speed / latency      | `ws_socket/engine/metrics.py` (rolling window rates, latency p50/p95/p99) |
| Stale / no-feed detection | `quality.py` per-instrument feed status (`LIVE/DEGRADED/STALE/NO_FEED`) |
| Reconnect backoff         | `ws_manager._get_reconnect_delay` (configurable, bounded, observable) |
| Subscription sync         | `services/websocket_engine.py` `subscribe_to_desired_pins` (idempotent regenerate+regroup) |
| Session Manager input     | subscription registry (`/subscriptions` desired vs subscribed) + pin reconciliation |
| Runtime stock add/expiry  | registry/pin lifecycle drives subscription re-sync; engine never writes the stock registry |
| 03:31 shutdown            | Scheduler window (08:50 login, 08:55 connect, 08:59 ticks, 15:31 stop) |
| Observability / logs      | `WS_*` logs + persisted `websocket_history_service` events + in-memory `_connection_history` |

46.3 Control plane surfaces (clicked by the frontend)

Control plane router: `api/ws_engine.py` behind `/api/services/websocket`,
proxied from `app/api/phase2/websocket-engine/[...path]/route.ts`.

- Subscribe / Unsubscribe (desired-subscription registry changes)
- Pins CRUD (add `POST /pins`, remove `DELETE /pins/{id}`)
- Consumers list + toggle (`PUT /consumers/{id}`)
- Live feed (`/live_feed`), Raw stream (`/raw_stream`), metrics (`/metrics`),
  quality summary (`/quality`), field verification (`/field-verification`)
- Status (`/status`), connect/reconnect/disconnect control actions
- History surface (new, read-only):
  `GET /history` -> `websocket_history_service.get_history` (persisted)
  `GET /events` -> `websocket_history_service.get_events_filtered` (persisted)
  `GET /history/{connection_id}` -> `get_record` detail
- Configuration surface (new, read-only): `GET /config` returns runtime
  reconnect knobs (`ws_reconnect_delay_ms`, `ws_backoff`,
  `ws_auto_reconnect`, `ws_max_reconnect_attempts`), canonical schema/SDK
  versions, feed-level config, resource thresholds and quality thresholds.
  It performs no writes.

Legacy diagnostics (`api/websocket.py` `/history`, `/events`, `/daily`,
`/metrics`, `/telemetry`, `/export`) remain for compatibility; the control
plane reuses the same `websocket_history_service` so logic is not
duplicated.

46.4 Reconnect observability (new)

Reconnect transitions are now recorded in the in-memory
`_connection_history` deque (previously only connect/disconnect):
`reconnecting` (attempt + backoff_sec), `reconnected` (attempt),
`reconnect_exhausted` (status `stopped`). Persisted events already emitted
via `_emit_ws_event`. Both surfaces back the UI History tab.

46.5 Version facts

The runtime reports `schema_version == '1.0'` and `sdk_version == '3.0.6'`
from the certified runtime values, and `feed_levels()` returns the real
configured level counts (`L4/L8/L16/INDEX`). The UI renders these values
from the live payload; no version string is hard-coded in the UI.

46.6 Frontend (Service Phase tabs)

`app/_pages/websocket-engine/page.tsx` renders tabs (Overview, Connection,
Live Feed, Quality, Subscriptions, Pins, Consumers, Field Verification,
Raw Stream, Resources, History, Configuration). Live Overview rides WS#2
`engines` channel via `useEngineStatus('websocket_engine', WE/status)`;
each `engine.status` frame refreshes the active detail tab. All values come
from backend payloads; missing values render `\u2014`/`NO_FEED`/
`DISCONNECTED`/`UNKNOWN`, never invented.

46.7 Testing

- `tests/test_ws_engine_surfaces.py` covers the new history/events/daily/
  config endpoints and reconnect-history recording.
- Existing suites: `test_ws_engine.py`, `test_websocket_engine.py`,
  `test_ws_availability.py`, `test_ws_engine_quality.py`,
  `test_ws_supervisor_sdk.py`, `test_scheduler_ws_prep.py`,
  `test_engine_control_api.py`, `test_master_canonical.py`.
- Frontend gates: `npx tsc --noEmit`, `npx eslint`.

The single-owner engine, its narrow purpose, the Session Manager input
boundary and the "no invented values" rule remain exactly as designed in
sections 1-45.

============================================================
47. PERFORMANCE UPDATE (2026-10-01) — implementation 021
============================================================

See `docs/implementation/021-trade-page-realtime-performance.md` and
`docs/verification/021-trade-page-realtime-performance-verification.md`.

- `RAW_BUCKET_DEPTH` reduced 2000 -> 64 per token. Each raw entry is ~3.4 KB
  JSON (full `master_canonical` + depth book) across ~2.7 k tokens; this was the
  ~7 GB heap driver. The 512 intermediate value did not reduce the footprint
  (observed per-token count ~450 < 512). The only consumer, the Raw Tick
  Inspector, requests `limit=20` (API clamps to 200) and `live_feed` only needs
  the window (<=120 s), so 64 serves both fully. The `/raw_stream` contract is
  unchanged.
- `live_feed()` is memoised per window for `LIVE_FEED_TTL_SEC = 2.0 s`.

Golden rule 25 (receive path lightweight and performance-safe) is thereby
honoured. Single-owner WS#1, the subscribe/unsubscribe boundary and the
validation/dedup/normalization contract are unchanged.
