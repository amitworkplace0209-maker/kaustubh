DB WRITER ENGINE — DETAILED ARCHITECTURE SPECIFICATION
Project: Trading Terminal / Trading Platform
Engine Number: 06
Status: Architecture Definition
Language: English

======================================================================
1. PURPOSE
======================================================================

The DB Writer Engine is the dedicated live-market-data persistence engine.

Its responsibility is to receive the live feed made available through the
Connection Manager, validate it, remove true duplicates, measure data
quality and throughput, buffer accepted records safely, and persist the
accepted records into the configured database/storage system.

The DB Writer Engine must NOT connect directly to the broker market-data
WebSocket.

Primary flow:

    SESSION MANAGER
          |
          | subscribed instruments
          v
    MARKET DATA WEBSOCKET ENGINE
          |
          | broker feed
          v
    FEATURE ENGINE
          |
          | standardized/processed feed
          v
    CONNECTION MANAGER
          |
          | dedicated DB Writer connection
          v
    DB WRITER ENGINE
          |
          +--> Validation
          +--> Deduplication
          +--> Field/Data Quality Metrics
          +--> Throughput Metrics
          +--> Bounded Buffer
          +--> Batch Persistence
          v
       MONGODB

The DB Writer Engine is a persistence and observability layer, not a
broker-feed engine and not a feature-calculation engine.

======================================================================
2. PRIMARY OBJECTIVE
======================================================================

The DB Writer Engine must provide reliable persistent storage for live
feed data from subscribed instruments.

For each accepted feed record it should be possible to determine:

    when the data arrived
    which instrument it belongs to
    which source produced it
    which sequence/message identity it has
    which fields were present
    whether the record was valid
    whether it was a duplicate
    whether it was successfully persisted

The engine must also continuously report:

    ticks received/sec
    ticks accepted/sec
    ticks saved/sec
    duplicate rate
    invalid rate
    database write rate
    database write latency
    queue/buffer depth
    failed writes
    field availability
    field null rate
    field invalid rate
    stale/no-feed conditions

======================================================================
3. WHAT DB WRITER IS NOT
======================================================================

The DB Writer Engine must NOT:

1. Log in to Kotak Neo.
2. Log in to Shoonya.
3. Own broker credentials.
4. Open the broker market-data WebSocket.
5. Subscribe directly to broker instruments.
6. Calculate indicators.
7. Generate trading signals.
8. Place orders.
9. Manage positions.
10. Manage strategy logic.
11. Decide which broker instrument should be subscribed.
12. Replace the Session Manager.
13. Replace the Connection Manager.
14. Fetch every tick using REST APIs.
15. Perform uncontrolled per-record database operations.
16. Silently invent missing fields.
17. Treat every equal timestamp as a duplicate.
18. Use an unlimited in-memory queue.

======================================================================
4. RELATIONSHIP WITH SESSION MANAGER
======================================================================

The Session Manager is the source of truth for instrument subscription
state.

It knows:

    instrumentToken
    symbol
    exchange
    expiry
    subscription state
    broker/session relationship

The DB Writer Engine may receive the subscribed-stock/instrument
requirement through the Connection Manager or a controlled integration
with the Session Manager.

The preferred architecture is:

    Session Manager
        ↓
    Connection Manager
        ↓
    DB Writer connection requirement

This keeps Connection Manager responsible for who needs what data and
keeps DB Writer responsible for persistence.

======================================================================
5. RELATIONSHIP WITH CONNECTION MANAGER
======================================================================

Connection Manager is the DB Writer Engine's upstream connection layer.

Connection Manager determines:

    which instrument DB Writer requires
    which fields DB Writer requires
    which source should provide the data
    which delivery channel should be used
    when the connection should be active
    when the connection should stop

Example:

    Consumer:
        DB_WRITER

    Instrument:
        RELIANCE

    Fields:
        FULL_AVAILABLE_FEED

    Source:
        FEATURE_ENGINE

    Mode:
        LIVE

    Delivery:
        INTERNAL_STREAM

The DB Writer then consumes that connection.

Important:

    Connection Manager owns routing.
    DB Writer owns persistence.

======================================================================
6. FULL LIVE FEED RECORDING
======================================================================

A core DB Writer feature is full live feed recording.

For a subscribed instrument with no expiry, the system can configure:

    saveFullLiveFeed = true

Example instruments:

    RELIANCE
    TCS
    INFY
    ONGC

If the instrument is actively subscribed and recording is enabled:

    live feed
        ↓
    Connection Manager
        ↓
    DB Writer
        ↓
    persistent storage

The recording continues while the instrument and recording policy remain
valid.

======================================================================
7. NON-EXPIRING VS EXPIRING INSTRUMENTS
======================================================================

Non-expiring instruments:

    regular equities
    other instruments whose validity does not have a trading-contract
    expiry

For these, recording can remain active according to the subscription and
recording configuration.

Expiring instruments:

    options
    futures
    other contracts with explicit expiry

For these, the DB Writer must respect the instrument expiry.

Example:

    Instrument:
        NIFTY option

    Expiry:
        2026-09-24

At expiry:

    recording state
        ACTIVE
          ↓
        EXPIRING
          ↓
        EXPIRED
          ↓
        STOPPED

No record should be accepted as a valid live record after the configured
instrument validity boundary unless an explicit replay/historical mode is
being used.

======================================================================
8. DATA SOURCE
======================================================================

The preferred source is the standardized internal live feed.

Preferred path:

    Broker
      ↓
    Market Data WebSocket Engine
      ↓
    Feature Engine
      ↓
    Connection Manager
      ↓
    DB Writer

DB Writer must not independently reconnect to the broker.

This prevents:

    duplicate broker connections
    duplicate subscriptions
    inconsistent feed processing
    multiple independent market-data pipelines

======================================================================
9. SNAPSHOT VS LIVE STREAM
======================================================================

DB Writer primarily consumes:

    LIVE STREAM

It should not poll APIs continuously.

API/control requests can be used for:

    configuration
    status
    health
    historical backfill
    diagnostics
    manual operations

Live data should come through a persistent stream/internal channel.

======================================================================
10. DB WRITER INPUT CONTRACT
======================================================================

The input should use a standardized internal feed envelope.

Conceptual:

    {
        source,
        instrumentToken,
        symbol,
        exchange,
        timestamp,
        receiveTimestamp,
        sequenceNumber,
        messageId,
        feedType,
        fields,
        quality,
        metadata
    }

Example:

    {
        source: "FEATURE_ENGINE",
        instrumentToken: "12345",
        symbol: "RELIANCE",
        exchange: "NSE",
        timestamp: "...",
        receiveTimestamp: "...",
        sequenceNumber: 987654,
        fields: {
            ltp: 1450.20,
            open: 1442.00,
            high: 1455.00,
            low: 1438.50,
            close: 1441.25,
            volume: 1823400,
            bid: 1450.15,
            ask: 1450.25
        }
    }

The exact field list must be based on actual upstream feed contracts.

======================================================================
11. VALIDATION PIPELINE
======================================================================

Every incoming record must pass validation before persistence.

Pipeline:

    RECEIVE
       ↓
    BASIC VALIDATION
       ↓
    INSTRUMENT VALIDATION
       ↓
    TIMESTAMP VALIDATION
       ↓
    FIELD VALIDATION
       ↓
    DEDUPLICATION
       ↓
    QUALITY CLASSIFICATION
       ↓
    ACCEPT
       ↓
    BUFFER
       ↓
    WRITE

Validation should be fast and should not block unrelated instruments.

======================================================================
12. BASIC VALIDATION
======================================================================

Validate required envelope fields:

    instrumentToken
    timestamp
    source
    fields

Optional fields such as sequenceNumber should be validated when present.

Reject or classify records with:

    missing instrument identity
    malformed timestamp
    invalid envelope
    unsupported source
    structurally invalid payload

Do not silently modify invalid input into a valid record.

======================================================================
13. INSTRUMENT VALIDATION
======================================================================

DB Writer should verify that the incoming instrument is one of the
currently authorized recording requirements.

Example:

    DB Writer is configured for:
        RELIANCE
        TCS

Incoming:

    INFY

If INFY was not requested for recording:

    do not persist it under the RELIANCE/TCS recording stream.

It may be counted as:

    UNREQUESTED_INSTRUMENT

This protects the database from accidental uncontrolled ingestion.

======================================================================
14. EXPIRY VALIDATION
======================================================================

For instruments with expiry:

    current data time
        <
    instrument expiry boundary

must be satisfied for normal live recording.

For non-expiring instruments:

    expiry = NONE

Recording continues according to the active recording configuration.

The exact expiry boundary and exchange calendar behavior should be
configured rather than hard-coded.

======================================================================
15. FIELD VALIDATION
======================================================================

Each field should be classified.

Possible field states:

    VALID
    NULL
    MISSING
    INVALID
    UNSUPPORTED

Example:

    ltp:
        VALID

    bid:
        NULL

    ask:
        VALID

    someUnknownField:
        UNSUPPORTED

Do not replace missing/null values with zero unless the field's schema
explicitly defines zero as the correct semantic value.

======================================================================
16. DUPLICATE REMOVAL
======================================================================

Duplicate removal is mandatory.

However:

    same timestamp != automatically duplicate

Two valid ticks can have the same timestamp.

Preferred duplicate identity priority:

    1. broker sequence number
    2. broker message ID
    3. broker-provided unique update identifier
    4. carefully defined fallback identity

The fallback identity must include enough information to avoid removing
valid updates.

Possible fallback components:

    instrumentToken
    timestamp
    feed type
    normalized payload hash

The exact fallback rule must be validated against actual broker feed
semantics.

======================================================================
17. DUPLICATE METRICS
======================================================================

Track:

    totalReceived
    totalDuplicates
    duplicateRate

Per instrument:

    RELIANCE
        received = 1,000,000
        duplicates = 500
        duplicateRate = 0.05%

Duplicate counts should be observable but duplicate records should not be
written again when they are confirmed duplicates.

======================================================================
18. ACCEPTED DATA
======================================================================

Accepted records are records that:

    belong to an authorized instrument
    are structurally valid
    satisfy recording rules
    are not confirmed duplicates
    pass required validation

Example accounting:

    received:
        1,000,000

    duplicates:
        500

    invalid:
        20

    accepted:
        999,480

The accounting must reconcile.

======================================================================
19. DATA-LOSS ACCOUNTING
======================================================================

The DB Writer must provide an explicit data accounting model.

Example:

    RECEIVED
        1,000,000

    DUPLICATE
        500

    INVALID
        20

    ACCEPTED
        999,480

    WRITTEN
        999,480

    WRITE_FAILED
        0

This makes it possible to identify exactly where data was lost or
rejected.

If:

    ACCEPTED = 999,480
    WRITTEN = 999,400
    WRITE_FAILED = 80

the system can clearly report the 80 failed records.

======================================================================
20. PER-TICK PERSISTENCE REQUIREMENT
======================================================================

The logical requirement is:

    every accepted valid tick must be persisted.

The physical implementation should normally use buffering and batch
writes rather than one blocking database operation per incoming tick.

Correct architecture:

    accepted tick
        ↓
    bounded write buffer
        ↓
    batch
        ↓
    MongoDB bulk write

This preserves every accepted record while reducing database overhead.

If strict synchronous durability is required for a special mode, it should
be an explicit configuration, not the default behavior for high-frequency
feed storage.

======================================================================
21. BOUNDED BUFFER
======================================================================

The DB Writer must use a bounded buffer.

Example:

    MAX_BUFFER_SIZE = configured value

When the buffer reaches capacity, the system must have an explicit
overflow policy.

Possible policies:

    BLOCK_WRITER
    PAUSE_SOURCE_IF_SUPPORTED
    FAIL_SAFE
    DROP_NON_CRITICAL_RECORDS
    ALERT_AND_STOP

For full historical live-feed recording, silently dropping records is
generally unsafe.

Therefore the preferred behavior should be to expose the condition,
apply controlled backpressure where possible, and fail visibly rather
than silently losing data.

======================================================================
22. BATCH WRITE
======================================================================

The DB Writer can batch records by:

    record count
    time interval
    instrument
    collection
    configured byte size

Example:

    flush when:
        500 records reached

    OR:

        100 ms elapsed

The actual values must be configuration-driven and tested against
expected feed rates.

======================================================================
23. MONGODB WRITE STRATEGY
======================================================================

Use efficient MongoDB write operations appropriate for the workload.

Potential strategy:

    bulk insert / bulk write

instead of:

    one network round-trip per tick

The writer should preserve ordering where the selected data model requires
it.

Database errors must be explicitly tracked.

======================================================================
24. DATABASE FAILURE
======================================================================

If MongoDB becomes unavailable:

    DB Writer detects failure
          ↓
    mark DB status unhealthy
          ↓
    stop successful-write accounting
          ↓
    retain records in bounded recovery buffer
          ↓
    retry with controlled backoff
          ↓
    reconnect
          ↓
    flush buffered records
          ↓
    restore HEALTHY

Do not create an infinite memory buffer.

If the configured recovery capacity is exceeded, generate a critical
data-loss/backpressure event rather than silently discarding records.

======================================================================
25. RETRY POLICY
======================================================================

Retries must be controlled.

Use:

    exponential backoff
    maximum retry delay
    maximum retry attempts per operation where appropriate
    circuit-breaker behavior if necessary

Avoid:

    infinite immediate retry loops

Such loops can overload both the application and MongoDB.

======================================================================
26. ORDERING
======================================================================

Where the feed provides sequence numbers, preserve sequence information.

Records should include:

    sequenceNumber

This allows later verification.

For instruments where ordering matters, the writer should avoid arbitrary
reordering during batching unless the data model explicitly permits it.

======================================================================
27. MONGODB DOCUMENT SCHEMA
======================================================================

Conceptual live-feed document:

    {
        _id,
        instrumentToken,
        symbol,
        exchange,

        marketDate,
        timestamp,
        receiveTimestamp,

        sequenceNumber,
        messageId,

        source,
        feedType,

        fields: {
            ltp,
            open,
            high,
            low,
            close,
            volume,
            bid,
            ask,
            bidQuantity,
            askQuantity,
            depth
        },

        fieldAvailability: {
            ltp: "VALID",
            bid: "VALID",
            ask: "NULL"
        },

        quality: {
            overall: "GOOD"
        },

        writer: {
            receivedAt,
            acceptedAt,
            writtenAt
        }
    }

The exact fields must follow the real standardized feed contract.

======================================================================
28. TIME FIELDS
======================================================================

Keep source and local timestamps separate.

Recommended:

    timestamp
        source/broker/feed timestamp

    receiveTimestamp
        time received by application

    writtenAt
        time persisted

This allows latency analysis.

Do not overwrite the original source timestamp.

======================================================================
29. COLLECTION STRATEGY
======================================================================

The exact MongoDB collection strategy should be designed after measuring
the expected volume.

Possible models:

    one collection per market/feed type
    one collection per date
    partitioned/date-based collections
    time-series collection where appropriate

Avoid creating an unlimited number of tiny collections.

A date-based or time-series-oriented design may be appropriate for large
live-feed datasets, but the final choice must be validated against actual
query patterns and MongoDB capabilities.

======================================================================
30. INDEX STRATEGY
======================================================================

Likely query dimensions:

    instrumentToken
    timestamp
    marketDate
    sequenceNumber

Potential indexes:

    instrumentToken + timestamp
    instrumentToken + sequenceNumber

Unique constraints should only be introduced when the feed's identity
semantics are known well enough to guarantee correctness.

Do not make timestamp alone a unique key.

======================================================================
31. STORAGE CONFIGURATION
======================================================================

Recording configuration can contain:

    recordingId
    instrumentToken
    symbol
    exchange
    expiry
    enabled
    saveFullLiveFeed
    fieldsMode
    source
    destination
    retentionPolicy
    startedAt
    stoppedAt

Possible fieldsMode:

    FULL_AVAILABLE_FEED
    SELECTED_FIELDS

For the requested full-feed feature:

    fieldsMode = FULL_AVAILABLE_FEED

======================================================================
32. RECORDING LIFECYCLE
======================================================================

Recording states:

    CREATED
    WAITING_FOR_SOURCE
    WAITING_FOR_INSTRUMENT
    STARTING
    ACTIVE
    DEGRADED
    PAUSED
    EXPIRING
    EXPIRED
    STOPPING
    STOPPED
    FAILED

Example:

    CREATED
       ↓
    WAITING_FOR_SOURCE
       ↓
    STARTING
       ↓
    ACTIVE
       ↓
    STOPPING
       ↓
    STOPPED

======================================================================
33. NON-EXPIRING EQUITY RECORDING
======================================================================

Example:

    RELIANCE
    expiry = NONE
    saveFullLiveFeed = TRUE

At 08:55:

    recording starts when source and subscription are ready.

During market session:

    all accepted available feed updates are persisted.

At the configured end-of-day/feed-stop event:

    recording stops for the day.

Next trading day:

    recording can start again automatically if the configuration remains
    enabled.

This should integrate with Scheduler Engine rather than duplicating the
entire trading-day schedule.

======================================================================
34. EXPIRING CONTRACT RECORDING
======================================================================

Example:

    NIFTY option
    expiry = specific date

The DB Writer follows both:

    daily feed lifecycle

and:

    instrument expiry lifecycle

At daily feed stop:

    stop for the session.

On next valid trading session before expiry:

    resume if configured.

After expiry:

    do not resume normal live recording.

======================================================================
35. SCHEDULER INTEGRATION
======================================================================

Scheduler Engine provides system-level lifecycle events.

Example:

    LIVE_FEED_STARTED
        ↓
    DB Writer activates eligible recordings.

    FEED_STOP_TRIGGERED
        ↓
    DB Writer flushes pending buffer.

    FEED_STOPPED
        ↓
    DB Writer closes live recording for the session.

    TRADING_DAY_COMPLETED
        ↓
    finalize daily recording state.

DB Writer must flush pending accepted records before declaring a clean
shutdown where possible.

======================================================================
36. FLUSH ON SHUTDOWN
======================================================================

Shutdown flow:

    STOP_REQUESTED
        ↓
    stop accepting new records
        ↓
    flush in-memory buffer
        ↓
    confirm database write result
        ↓
    close database writer
        ↓
    mark recording stopped

If flush fails:

    report explicit failure
    preserve retry/recovery information where possible

Never report successful shutdown while known accepted records remain
unaccounted for.

======================================================================
37. TICK RATE METRICS
======================================================================

The DB Writer must measure:

    received ticks/sec
    accepted ticks/sec
    duplicate ticks/sec
    invalid ticks/sec
    written ticks/sec

Metrics should be available:

    globally
    per instrument
    optionally per feed type/source

Example:

    Overall:
        12,450 ticks/sec

    RELIANCE:
        42 ticks/sec

    NIFTY:
        180 ticks/sec

======================================================================
38. RATE WINDOWS
======================================================================

Avoid relying only on lifetime averages.

Provide:

    current rate
    rolling 1-second rate
    rolling 5-second rate
    rolling 1-minute rate
    session average
    session peak

This makes feed-speed monitoring meaningful.

======================================================================
39. FIELD METRICS
======================================================================

For every instrument and important field, track:

    received count
    valid count
    null count
    missing count
    invalid count
    unsupported count

Example:

    RELIANCE

    Field:
        ltp

    received:
        1,245,799

    valid:
        1,245,799

    null:
        0

    invalid:
        0

This provides a precise field-level feed report.

======================================================================
40. FIELD FREQUENCY
======================================================================

Measure how frequently each field appears.

Example:

    bid:
        99.98% present

    ask:
        99.98% present

    depth:
        85.40% present

This can identify fields that are not continuously supplied by the
upstream source.

======================================================================
41. FIELD VALUE QUALITY
======================================================================

Metrics should distinguish:

    field absent
    field present as null
    field present but invalid
    field valid

Do not combine these into one generic "missing" counter.

This distinction is useful for debugging broker feed behavior.

======================================================================
42. LATENCY METRICS
======================================================================

Where timestamps permit:

    source timestamp
        ↓
    application receive timestamp

calculate:

    feed-to-application latency

Also:

    application receive timestamp
        ↓
    database write timestamp

calculate:

    persistence latency

And optionally:

    total source-to-database latency

Never claim broker latency when the source does not provide a reliable
source timestamp.

======================================================================
43. DATABASE WRITE METRICS
======================================================================

Track:

    writes/sec
    records/write
    write latency
    average write latency
    p50
    p95
    p99
    write failures
    retry count
    batch size
    flush frequency

Example:

    Batch size:
        500 records

    Average write latency:
        12 ms

    P95:
        25 ms

======================================================================
44. BUFFER METRICS
======================================================================

Track:

    current buffer size
    maximum buffer size
    buffer utilization %
    oldest buffered record age
    flush count
    flush failures
    overflow events

Example:

    Buffer:
        3,200 / 10,000

    Utilization:
        32%

    Oldest record:
        85 ms

======================================================================
45. DATA-LOSS MONITORING
======================================================================

The DB Writer should continuously calculate:

    received
    duplicates
    invalid
    accepted
    written
    failed

Expected relationship:

    received
      =
    duplicates
      +
    invalid
      +
    accepted

And:

    accepted
      =
    written
      +
    writeFailed
      +
    pending

This accounting should be exposed for diagnostics.

======================================================================
46. HEALTH STATES
======================================================================

Suggested overall states:

    STARTING
    HEALTHY
    DEGRADED
    SOURCE_UNAVAILABLE
    DATABASE_UNAVAILABLE
    BUFFER_WARNING
    BUFFER_CRITICAL
    FAILED
    STOPPING
    STOPPED

Example:

    HEALTHY
      ↓
    MongoDB unavailable
      ↓
    DATABASE_UNAVAILABLE
      ↓
    recovery
      ↓
    HEALTHY

======================================================================
47. PER-INSTRUMENT HEALTH
======================================================================

Each instrument can have independent state.

Example:

    RELIANCE:
        HEALTHY

    TCS:
        HEALTHY

    INFY:
        NO_FEED

A problem with INFY must not stop RELIANCE.

======================================================================
48. SOURCE/CONNECTION HEALTH
======================================================================

The DB Writer should distinguish:

    source disconnected
    source connected but no data
    source sending stale data
    source sending invalid data
    DB unavailable
    consumer connection unavailable

This prevents incorrect diagnosis.

======================================================================
49. API DESIGN
======================================================================

Possible endpoints:

    GET /db-writer/status

    GET /db-writer/health

    GET /db-writer/metrics

    GET /db-writer/metrics/instruments

    GET /db-writer/recordings

    GET /db-writer/recordings/{recordingId}

    POST /db-writer/recordings

    PATCH /db-writer/recordings/{recordingId}

    DELETE /db-writer/recordings/{recordingId}

    POST /db-writer/recordings/{recordingId}/start

    POST /db-writer/recordings/{recordingId}/stop

    GET /db-writer/fields/{instrumentToken}

These are control/diagnostic APIs, not tick-fetch APIs.

======================================================================
50. RECORDING REQUEST
======================================================================

Conceptual request:

    {
        consumerType: "DB_WRITER",

        instrument: {
            symbol: "RELIANCE",
            instrumentToken: "12345",
            exchange: "NSE",
            expiry: null
        },

        saveFullLiveFeed: true,

        source: "FEATURE_ENGINE",

        mode: "LIVE",

        destination: "MONGODB"
    }

The Connection Manager can translate this requirement into the actual
live connection.

======================================================================
51. RECORDING CONFIGURATION FOR MULTIPLE STOCKS
======================================================================

Example:

    RELIANCE
        full feed = true

    TCS
        full feed = true

    INFY
        full feed = true

    ONGC
        full feed = true

The DB Writer should process all configured instruments independently.

One instrument's failure must not stop all other recordings.

======================================================================
52. FIELD STORAGE POLICY
======================================================================

For full-feed mode:

    store all available standardized fields allowed by the feed contract.

Do not store imaginary fields.

If a field is not available:

    record its availability state in metrics/configuration as appropriate.

If a field is temporarily null:

    preserve the null according to schema semantics.

If the system needs compact storage, compression can be considered at the
database/storage layer after correctness is established.

======================================================================
53. RAW VS PROCESSED DATA
======================================================================

The DB Writer described here should primarily persist the standardized
feed supplied by Connection Manager.

If the project later requires raw broker payload archival, create a
separate explicit raw-data recording mode.

Do not mix raw broker payloads and processed feature documents without
clear schema/version information.

Possible future modes:

    STANDARDIZED_FEED
    RAW_FEED_ARCHIVE
    FEATURE_FEED
    REPLAY_DATA

======================================================================
54. SCHEMA VERSIONING
======================================================================

Stored records should support schema/version information.

Example:

    schemaVersion:
        1

This is important because the feed contract may evolve.

Future changes such as:

    new fields
    renamed fields
    changed depth structure

must not make old stored records impossible to interpret.

======================================================================
55. REPLAY SUPPORT
======================================================================

The stored live feed should be designed so a future Replay Engine can
read it.

Replay requirements may include:

    instrument
    date/time range
    original timestamp
    sequence number
    fields
    source
    schema version

The DB Writer does not perform replay.

It only stores enough correct information for future replay.

======================================================================
56. BACKTESTING SUPPORT
======================================================================

The same stored data can later support:

    historical feature calculation
    strategy backtesting
    simulation
    model training
    debugging

The DB Writer must therefore preserve data fidelity rather than only
storing a UI-friendly subset when full-feed recording is enabled.

======================================================================
57. STORAGE RETENTION
======================================================================

Retention should be configurable.

Possible policies:

    keep forever
    keep N days
    keep N months
    archive after N days
    export then delete

For full-feed storage, retention must be planned because data volume can
be very large.

Do not silently delete data because storage is full.

Storage-pressure conditions should produce alerts and explicit policy
actions.

======================================================================
58. STORAGE CAPACITY MONITORING
======================================================================

Monitor:

    database size
    collection size
    daily growth
    estimated remaining capacity
    write throughput
    retention impact

Useful calculation:

    average daily feed volume

    estimated monthly volume

    estimated storage requirement

These metrics can be exposed to the Downloads/Data Saver dashboard.

======================================================================
59. DATA SAVER INTEGRATION
======================================================================

If the project has a Data Saver feature, the DB Writer can consume its
configuration.

Example:

    Data Saver:
        RELIANCE
        TCS
        INFY
        ONGC

    Recording:
        FULL LIVE FEED

The Data Saver configuration should ultimately create/update the
appropriate DB Writer recording requirements through the Connection
Manager/control layer.

The DB Writer itself should not become the Data Saver UI.

======================================================================
60. SECURITY AND ACCESS
======================================================================

Only authorized internal services/users should be able to:

    create recording rules
    stop recordings
    modify retention
    access diagnostics
    access stored data

DB credentials must not be exposed through APIs.

Database connection secrets must be kept in secure configuration.

Never log database passwords or authentication secrets.

======================================================================
61. MODULE STRUCTURE
======================================================================

Suggested Python structure:

    db_writer/
        __init__.py

        service.py
        manager.py

        models.py
        schemas.py
        validators.py

        recording_registry.py
        instrument_registry.py

        input_consumer.py
        stream_consumer.py

        deduplicator.py
        validator.py
        field_quality.py

        buffer.py
        batcher.py
        writer.py
        mongo_writer.py

        retry.py
        backpressure.py

        expiry_manager.py
        lifecycle.py

        metrics.py
        health.py
        monitoring.py

        events.py
        api.py

        repository.py
        config.py
        exceptions.py

    tests/
        test_validation.py
        test_deduplication.py
        test_field_quality.py
        test_buffer.py
        test_batch_write.py
        test_mongo_failure.py
        test_retry.py
        test_expiry.py
        test_metrics.py
        test_reconciliation.py
        test_multiple_instruments.py
        test_shutdown_flush.py

======================================================================
62. RUNTIME STATE
======================================================================

Fast-changing state should remain in memory.

Examples:

    active recordings
    current buffers
    deduplication cache
    current tick rates
    current field counters
    connection health
    database health
    pending write count

Persistent configuration may be stored in MongoDB.

Do not use MongoDB as the runtime coordination mechanism for every tick.

======================================================================
63. DEDUPLICATION CACHE
======================================================================

Deduplication requires bounded memory.

The cache should use:

    TTL
    maximum entries
    per-instrument limits where appropriate

Never maintain an unlimited set of all historical message IDs in RAM.

The retention window should match the feed's duplicate semantics.

======================================================================
64. MEMORY SAFETY
======================================================================

The DB Writer must have bounded:

    input queue
    batch buffer
    deduplication cache
    retry queue

Memory utilization should be observable.

When memory thresholds are reached:

    generate warning
    apply configured backpressure
    protect the rest of the system

======================================================================
65. OBSERVABILITY
======================================================================

Metrics should be exportable to the application's monitoring layer.

Useful categories:

    INPUT
    VALIDATION
    DEDUPLICATION
    FIELD_QUALITY
    BUFFER
    DATABASE
    LATENCY
    STORAGE
    EXPIRY
    CONNECTION
    DATA_LOSS

This allows the UI to build a DB Writer health panel.

======================================================================
66. EXAMPLE HEALTH PANEL
======================================================================

DB WRITER

    Status:
        HEALTHY

    Instruments:
        24 active

    Input:
        12,450 ticks/sec

    Accepted:
        12,430 ticks/sec

    Duplicates:
        20/sec

    Invalid:
        0/sec

    DB Write:
        12,430 records/sec

    Average write latency:
        14 ms

    Buffer:
        8%

    Failed writes:
        0

    Data loss:
        0

======================================================================
67. EXAMPLE PER-STOCK PANEL
======================================================================

RELIANCE

    Status:
        LIVE

    Ticks/sec:
        42

    Received:
        1,245,799

    Accepted:
        1,245,780

    Duplicate:
        18

    Invalid:
        1

    Saved:
        1,245,780

    Last tick:
        <source timestamp>

    Last write:
        <database timestamp>

    Fields:

        LTP
            valid: 1,245,780
            null: 0
            invalid: 0

        Volume
            valid: 1,245,780
            null: 0
            invalid: 0

        Bid
            valid: 1,245,700
            null: 80
            invalid: 0

======================================================================
68. FAILURE ISOLATION
======================================================================

If one instrument produces invalid data:

    RELIANCE:
        continue

    TCS:
        continue

    INFY:
        continue

    BAD_INSTRUMENT:
        isolated

If MongoDB write for one batch fails, retry according to policy without
crashing the entire DB Writer process.

If one consumer/connection fails, the Connection Manager handles the
connection problem and the DB Writer should continue other healthy
recording streams.

======================================================================
69. GRACEFUL RESTART
======================================================================

On application restart:

    load recording configuration
        ↓
    restore eligible recordings
        ↓
    recreate Connection Manager connections
        ↓
    resume DB Writer streams
        ↓
    reset only runtime state that cannot safely be persisted
        ↓
    continue recording

Deduplication state may need to be reconstructed according to the
configured duplicate-detection strategy.

Do not assume that in-memory state survives process restart.

======================================================================
70. CRASH RECOVERY
======================================================================

If the DB Writer crashes:

    accepted but not persisted records may exist in memory.

Therefore, the system must make the durability boundary explicit.

Possible architecture:

    source
      ↓
    bounded in-memory buffer
      ↓
    persistent DB

For stronger guarantees, a future durable local queue/write-ahead log may
be introduced.

The first implementation should clearly report any records that could
not be persisted rather than pretending zero data loss.

======================================================================
71. DATA INTEGRITY
======================================================================

Every stored record should be traceable to:

    source
    instrument
    source timestamp
    receive timestamp
    sequence/message identity where available
    schema version

This supports:

    debugging
    replay
    auditing
    backtesting
    feed-quality analysis

======================================================================
72. TIMEZONE
======================================================================

Trading-day and market-session calculations must use the configured market
timezone.

Do not assume server local timezone.

Store timestamps in a consistent canonical representation and retain the
market-date/session context required for queries.

======================================================================
73. NO SILENT DATA TRANSFORMATION
======================================================================

DB Writer may normalize storage representation when the schema requires
it, but must not silently change the meaning of incoming values.

Examples of unsafe behavior:

    missing volume → 0
    missing bid → 0
    missing ask → 0

unless the source contract explicitly defines that representation.

======================================================================
74. EXACT ACCEPTANCE ACCOUNTING
======================================================================

At any moment the engine should be able to report:

    RECEIVED
    - DUPLICATES
    - INVALID
    = ACCEPTED

and:

    ACCEPTED
    - WRITTEN
    - WRITE_FAILED
    = PENDING

This is a core correctness property.

======================================================================
75. GOLDEN ARCHITECTURAL RULES
======================================================================

RULE 1:
DB Writer does not connect directly to the broker.

RULE 2:
DB Writer receives its live feed through Connection Manager.

RULE 3:
Session Manager remains the source of truth for instrument subscriptions.

RULE 4:
Connection Manager remains responsible for consumer connections and field
requirements.

RULE 5:
Feature Engine remains responsible for calculations/features.

RULE 6:
DB Writer remains responsible for persistence.

RULE 7:
Live data must use streaming/internal delivery, not repeated REST polling.

RULE 8:
Every accepted valid tick should be persistable and accounted for.

RULE 9:
Confirmed duplicates must not be written again.

RULE 10:
Timestamp alone must never be assumed to identify a duplicate.

RULE 11:
Missing fields must not be fabricated.

RULE 12:
Full-feed mode stores all available standardized fields allowed by the
feed contract.

RULE 13:
Non-expiring subscribed instruments can have continuously enabled
recording.

RULE 14:
Expiring instruments must stop recording at their validity boundary.

RULE 15:
Daily start/stop follows Scheduler Engine lifecycle events.

RULE 16:
Database writes should normally use bounded buffering and efficient batch
operations.

RULE 17:
Queues and caches must be bounded.

RULE 18:
Database failures must be visible and recoverable.

RULE 19:
One instrument failure must not stop other instruments.

RULE 20:
One failed downstream connection must not stop unrelated consumers.

RULE 21:
Tick-level metrics must be available globally and per instrument.

RULE 22:
Field-level quality metrics must distinguish valid, null, missing, and
invalid values.

RULE 23:
Feed latency and database persistence latency must be measured separately.

RULE 24:
Data-loss accounting must reconcile received, rejected, accepted,
written, failed, and pending records.

RULE 25:
Stored data must preserve enough identity and timestamp information for
future replay and backtesting.

======================================================================
76. FINAL ARCHITECTURE
======================================================================

The final engine chain is:

    +-----------------------+
    |    Scheduler Engine   |
    +-----------+-----------+
                |
                v
    +-----------------------+
    |    Session Manager    |
    |                       |
    | sessions              |
    | instruments           |
    | subscriptions         |
    | expiry                |
    +-----------+-----------+
                |
                v
    +-----------------------+
    | Market Data WebSocket |
    |       Engine          |
    +-----------+-----------+
                |
                v
    +-----------------------+
    |    Feature Engine     |
    +-----------+-----------+
                |
                v
    +================================+
    |       CONNECTION MANAGER       |
    |                                |
    | consumer requirements          |
    | stock requirements             |
    | field requirements             |
    | routing                        |
    | live connections               |
    +===============+================+
                    |
                    |
                    v
          +====================+
          |    DB WRITER        |
          |                     |
          | receive             |
          | validate            |
          | deduplicate         |
          | field metrics       |
          | tick metrics        |
          | buffer              |
          | batch               |
          | retry               |
          | health              |
          +=========+===========+
                    |
                    v
                MongoDB

At the same time, Connection Manager can distribute the same upstream
feature feed independently to:

    UI
    Strategy Engine
    Market Coach
    Model Engine
    Suggestion Engine
    Alerts
    Other consumers

The DB Writer is therefore a specialized consumer of the Connection
Manager's live data infrastructure.

======================================================================
77. CORE DESIGN PRINCIPLE
======================================================================

The architecture should be understood as:

    Session Manager
        =
        "Which instruments are subscribed and valid?"

    Market Data WebSocket Engine
        =
        "How do we receive the broker's live market feed?"

    Feature Engine
        =
        "How do we calculate/process the feed?"

    Connection Manager
        =
        "Who needs which data, from which source, through which connection?"

    DB Writer Engine
        =
        "Which authorized live data must be persistently stored, and how do
        we guarantee validation, deduplication, measurement, buffering,
        writing, recovery, and data-accounting?"

This separation is mandatory for scalability, reliability, observability,
future replay/backtesting, and future broker/source expansion.

---

## Tick Persistence Authority (2026-09-28)

The DB Writer Engine is the **single authority** allowed to decide whether a live
tick is persisted to MongoDB. This section is normative.

```
MARKET WATCH / PERSONAL SUBSCRIPTIONS
    -> TICK EVENT
    -> DB WRITE ENGINE
    -> PERMISSION CHECK
    -> BUFFER
    -> BATCH WRITE
    -> MONGODB
```

### The three independent permissions

| Permission | Setting key | Classification | Default |
|---|---|---|---|
| `personalNoExpiry` | `dbw_personal_no_expiry_ticks` | `PERSONAL_NO_EXPIRY` | OFF |
| `personalOneDay` | `dbw_personal_expiry_ticks` | `PERSONAL_ONE_DAY` | OFF |
| `marketWatchOneDay` | `dbw_market_watch_ticks` | `MARKET_WATCH_ONE_DAY` | OFF |

- Each permission is **independent**. Flipping one never affects another.
- The keys are the pre-existing `dbw_*` settings, already `False` in
  `services/settings_service.py` and already in `runtime_settings.LIVE_KEYS`, so a
  flip applies on the next tick without a restart.
- **"1-day" is a session/subscription classification, not a MongoDB TTL.** No TTL
  index exists in this project; expiry is application-managed via `expires_at` /
  `expiry_type`.

### Classification

- Classification is **backend-owned** and derived from the Session Manager's
  authoritative subscription state. It is never inferred from a symbol name and
  never sent by the frontend.
- An **UNKNOWN** classification is never persisted.
- `_get_tick_classifications()` returns **every** applicable classification, so an
  instrument that is both personally subscribed and in the Market Watch universe is
  correctly seen as matching both. (The previous single-value accessor made the
  overlap branch unreachable.)

### Persist at most once

If a tick matches several classifications, the DB Writer evaluates every
applicable permission but writes **exactly one** document. `overlappingSourcesDeduped`
counts these.

### Market Watch's role

Market Watch receives, validates and publishes ticks, then **hands them off** via
`db_writer_engine.ingest_market_watch_ticks()`. It must never write ticks to
MongoDB and must never make the persistence decision. `mwr_persist_ticks` is only
the *offer* gate and is ANDed with the DB Writer's `marketWatchOneDay` permission,
so turning that permission OFF genuinely stops Market Watch tick writes.

### Configuration surface

`GET`/`PUT /api/services/engines/db_writer_engine/tick-persistence` — a read and
command surface over the existing settings service, not a second config system.
The Service page Settings panel renders backend state only; it holds no optimistic
state and re-reads the authoritative value after every write.

### Trace and evidence

- `docs/opencode/002-tick-persistence-ownership-trace.md`
- `docs/implementation/016-db-writer-single-tick-persistence-authority.md`
- `docs/verification/016-db-writer-single-tick-persistence-verification.md`
