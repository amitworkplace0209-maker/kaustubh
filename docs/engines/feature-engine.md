FEATURE ENGINE
DETAILED RESPONSIBILITY, SCOPE & ARCHITECTURE
Version: Current Locked Scope

============================================================
1. PURPOSE
============================================================

The Feature Engine is the application's calculation and feature-generation
engine.

Its primary purpose is to consume clean, validated and standardized live
market data from the Market Data WebSocket Engine and transform that data
into:

- Calculations
- Indicators
- Derived features
- Custom features
- Calculation state required by future strategies/models

The exact indicator and feature list is NOT finalized at this stage.

The indicator/feature list will be designed after the complete broker
feed-field inventory is known.

Therefore, this document defines the Feature Engine's responsibility and
architecture, not the final list of indicators.

============================================================
2. CURRENT ARCHITECTURE
============================================================

SESSION MANAGER
      |
      | Stock / subscription information
      v
MARKET DATA WEBSOCKET ENGINE
      |
      | Broker live feed
      | Validation
      | Duplicate removal
      | Normalization
      v
FEATURE ENGINE
      |
      | Calculations
      | Indicators
      | Derived Features
      | Feature State
      v
FUTURE DOWNSTREAM ENGINES

The Feature Engine receives data from the WebSocket Engine.

It does not connect directly to the broker WebSocket.

============================================================
3. MAIN RESPONSIBILITY
============================================================

The Feature Engine answers:

"What useful calculated information can be produced from the clean
market data received from the WebSocket Engine?"

Its responsibilities are:

1. Consume standardized live market feed.
2. Understand available input fields.
3. Maintain calculation state.
4. Perform required calculations.
5. Calculate required indicators.
6. Generate derived features.
7. Support custom project-specific features.
8. Handle calculations independently per instrument.
9. Support calculation windows/history where required.
10. Produce standardized feature output.
11. Report calculation availability/status.
12. Remain modular so new calculations can be added without rewriting
    the engine.

============================================================
4. WHAT THE FEATURE ENGINE RECEIVES
============================================================

The Feature Engine receives the standardized MarketFeed produced by the
Market Data WebSocket Engine.

Potential fields may include:

- LTP
- OHLC
- Volume
- Bid
- Ask
- Bid Quantity
- Ask Quantity
- Market Depth / L8
- Timestamp
- Sequence information
- Other broker-supported normalized fields

IMPORTANT:

This is a conceptual list only.

The final input-field list will be created after the actual broker
WebSocket responses are inspected and documented.

The Feature Engine must not assume that a field exists merely because it
is common in market-data systems.

============================================================
5. RAW BROKER DATA IS NOT THE INPUT CONTRACT
============================================================

The Feature Engine must NOT depend directly on Kotak-specific field
names or payload structures.

Correct:

Kotak Raw Feed
    ->
Kotak Adapter
    ->
Validation
    ->
Deduplication
    ->
Normalization
    ->
Standard MarketFeed
    ->
Feature Engine

Incorrect:

Kotak Raw Feed
    ->
Feature Engine

This keeps the Feature Engine broker-independent.

============================================================
6. FIELD-DRIVEN FEATURE DESIGN
============================================================

The final Feature Engine feature set will be designed after the actual
feed fields are known.

Process:

STEP 1
Inspect complete broker feed response.

STEP 2
Create exact field inventory.

STEP 3
Identify what each field means.

STEP 4
Identify which fields are always available, optional or unavailable.

STEP 5
Group fields by purpose.

STEP 6
Identify possible calculations.

STEP 7
Identify required indicators.

STEP 8
Identify custom/derived features.

STEP 9
Design Feature Engine modules.

STEP 10
Implement and test calculations.

This prevents unnecessary indicators and calculations from being added
without a valid input source.

============================================================
7. CALCULATION CATEGORIES
============================================================

The Feature Engine can eventually contain multiple calculation groups.

Possible categories include:

- Price calculations
- Return/change calculations
- Volume calculations
- Volatility calculations
- Momentum calculations
- Trend calculations
- Technical indicators
- Market-depth calculations
- Bid/ask calculations
- Time-based calculations
- Custom derived features
- Strategy-specific features
- Model input features

These are categories, not a finalized indicator list.

The actual list will be decided after the feed-field analysis.

============================================================
8. INDICATORS
============================================================

Indicators will be added later based on actual available fields and
project requirements.

Examples of possible indicator families include:

- Trend indicators
- Momentum indicators
- Volatility indicators
- Volume indicators
- Price-based indicators
- Depth/order-book indicators

The Feature Engine should not be designed around a fixed list.

Instead, it should provide a framework where an indicator can be added
as an independent calculation module.

Example conceptual structure:

Feature Engine
    |
    +-- Price Features
    +-- Volume Features
    +-- Volatility Features
    +-- Momentum Features
    +-- Depth Features
    +-- Technical Indicators
    +-- Custom Features

============================================================
9. DERIVED FEATURES
============================================================

The engine is not limited to traditional technical indicators.

It can generate custom derived features.

Conceptual flow:

Raw Standardized Field(s)
        |
        v
Calculation
        |
        v
Derived Feature

Examples of conceptual relationships:

Price fields
    ->
price-derived feature

Volume fields
    ->
volume-derived feature

Bid/Ask fields
    ->
spread-related feature

Depth fields
    ->
depth-related feature

The exact formulas will be defined later.

============================================================
10. PER-INSTRUMENT STATE
============================================================

Feature calculations must remain isolated per instrument.

Example:

NIFTY
    |
    +-- calculation state
    +-- rolling values
    +-- indicator state
    +-- timeframe state

BANKNIFTY
    |
    +-- calculation state
    +-- rolling values
    +-- indicator state
    +-- timeframe state

RELIANCE
    |
    +-- calculation state
    +-- rolling values
    +-- indicator state
    +-- timeframe state

One instrument's calculation state must never accidentally mix with
another instrument's state.

============================================================
11. ROLLING / HISTORICAL CONTEXT
============================================================

Some calculations require previous observations.

Conceptual:

Current MarketFeed
        +
Previous/rolling state
        |
        v
Calculation
        |
        v
Feature

The engine should maintain the minimum required rolling state for
high-frequency calculations.

The exact state-management design will be finalized when the indicator
list is known.

============================================================
12. DATABASE USAGE
============================================================

The Feature Engine should not perform a database query for every
incoming tick merely to obtain previous calculation values.

High-frequency calculations should use appropriate in-memory/rolling
state.

Persistent storage can be used for:

- Historical data
- Feature history where required
- Recovery data where required
- Analytics
- Offline research

The exact persistence architecture will be defined separately.

============================================================
13. MISSING FIELD HANDLING
============================================================

The Feature Engine must respect the field-status information from the
Market Data WebSocket Engine.

Possible states:

AVAILABLE
NOT_RECEIVED
NULL
INVALID
UNSUPPORTED

Example:

Volume = NOT_RECEIVED

A volume-based feature should not silently convert that into:

Volume = 0

unless the source protocol explicitly defines zero as the actual value.

Similarly, missing OI should not be fabricated.

============================================================
14. CALCULATION AVAILABILITY
============================================================

Every feature should have a meaningful calculation state.

Conceptual states:

AVAILABLE
WARMING_UP
INSUFFICIENT_DATA
MISSING_INPUT
INVALID_INPUT
NOT_SUPPORTED
ERROR

Example:

EMA(20)

At startup, if fewer than the required observations exist:

Status:
WARMING_UP / INSUFFICIENT_DATA

The engine should not present an invalid calculation as a valid feature.

============================================================
15. WARM-UP PERIOD
============================================================

Some indicators require a minimum amount of data before they become
meaningful.

Conceptual flow:

Start
  |
  v
Collect required observations
  |
  v
Minimum data reached?
  |          |
 NO         YES
  |          |
  v          v
WARMING    CALCULATE
 UP            |
               v
           AVAILABLE

The exact warm-up requirement belongs to each calculation module.

============================================================
16. TIMEFRAMES
============================================================

The Feature Engine may eventually support calculations across multiple
timeframes.

Potential examples:

- Tick
- Seconds
- 1 minute
- 5 minutes
- 15 minutes
- Hourly
- Daily

However, the final timeframe architecture should be designed after the
required calculations are identified.

The engine should not create unnecessary timeframe pipelines.

============================================================
17. LIVE CALCULATION FLOW
============================================================

Market Data WebSocket Engine
        |
        v
Standard MarketFeed
        |
        v
Feature Engine
        |
        v
Identify instrument
        |
        v
Update calculation state
        |
        v
Run required calculations
        |
        v
Update feature state
        |
        v
Create standardized FeatureOutput

============================================================
18. FEATURE OUTPUT
============================================================

The exact final schema will be defined later.

Conceptually, FeatureOutput may contain:

instrumentToken
symbol
exchange
timestamp

priceFeatures
volumeFeatures
technicalFeatures
volatilityFeatures
momentumFeatures
depthFeatures
customFeatures

calculationStatus
missingInputs
featureVersion

Only fields/features that are actually calculated should be marked as
available.

============================================================
19. FEATURE VERSIONING
============================================================

Features should have version information.

Reason:

If a calculation formula changes, historical and current values may
otherwise become difficult to compare.

Conceptual:

featureVersion:
    v1

Future:

featureVersion:
    v2

The exact versioning system will be finalized during implementation.

============================================================
20. MODULAR CALCULATION ARCHITECTURE
============================================================

The Feature Engine must NOT become one giant calculation file.

Recommended conceptual structure:

feature_engine/
|
+-- engine.py
|     Main orchestration
|
+-- input/
|     MarketFeed handling
|
+-- calculators/
|     Independent calculation modules
|
+-- indicators/
|     Independent indicator modules
|
+-- features/
|     Custom/derived features
|
+-- state/
|     Per-instrument calculation state
|
+-- timeframes/
|     Time-based aggregation if required
|
+-- output/
|     Feature output generation
|
+-- validation/
|     Feature input/output validation
|
+-- models.py
|
+-- events.py
|
+-- exceptions.py

This structure can evolve after the final feature inventory is known.

============================================================
21. CALCULATOR PLUG-IN CONCEPT
============================================================

Each calculation should ideally behave like an independent component.

Conceptual:

Calculator
    |
    +-- accepts required inputs
    +-- maintains required state
    +-- calculates result
    +-- returns value/status

This allows a new feature to be added without changing unrelated
calculations.

Example:

Feature Engine
    |
    +-- Calculator A
    +-- Calculator B
    +-- Calculator C
    +-- Calculator D

============================================================
22. INPUT DEPENDENCY MAPPING
============================================================

Every feature should declare what input fields it requires.

Conceptual:

Feature:
    XYZ

Required:
    LTP
    Volume

Optional:
    Bid
    Ask

If required input is missing:

    Feature Status = MISSING_INPUT

This makes debugging and field coverage much easier.

============================================================
23. FIELD-TO-FEATURE MAPPING
============================================================

After the exact broker fields are known, create a mapping such as:

Field
    ->
Meaning
    ->
Possible Calculations
    ->
Indicators
    ->
Custom Features

Example concept:

LTP
    ->
price
    ->
price change / return
    ->
price-based indicators
    ->
custom price features

Volume
    ->
traded volume
    ->
volume change
    ->
volume indicators
    ->
custom volume features

Depth
    ->
order-book information
    ->
depth metrics
    ->
depth indicators
    ->
custom order-book features

The exact mapping is intentionally deferred.

============================================================
24. PERFORMANCE
============================================================

The Feature Engine will operate on live market data.

Therefore:

- Avoid unnecessary blocking operations.
- Avoid database access on every tick.
- Avoid expensive recalculation of unchanged state.
- Reuse rolling state where possible.
- Keep calculations modular.
- Avoid unnecessary data copying.
- Use efficient data structures.
- Measure calculation latency.
- Keep the live processing path bounded.

Feature Engine performance should be measurable independently from
WebSocket performance.

============================================================
25. FEATURE CALCULATION METRICS
============================================================

Useful metrics may include:

feature_calculations_total
feature_calculation_errors_total
feature_calculation_latency_ms
feature_calculation_latency_p95_ms
feature_calculation_latency_p99_ms

feature_warmup_count
feature_missing_input_count
feature_invalid_input_count

These metrics help identify whether calculations are becoming a
performance bottleneck.

============================================================
26. ERROR ISOLATION
============================================================

One calculation failing should not automatically stop the entire
Feature Engine.

Example:

Feature A -> successful
Feature B -> successful
Feature C -> error
Feature D -> successful

The engine should isolate the failing calculation where practical.

Feature C can report:

ERROR

while other independent calculations continue.

Fatal engine-level failures should remain distinguishable from
individual feature-calculation failures.

============================================================
27. DATA QUALITY AWARENESS
============================================================

The Feature Engine depends on the quality of the input received from
the WebSocket Engine.

It should preserve the distinction between:

- valid input
- missing input
- null input
- invalid input
- unsupported input
- stale input

It should not hide upstream data-quality problems.

============================================================
28. FEATURE ENGINE DOES NOT OWN BROKER CONNECTION
============================================================

The Feature Engine must never:

- connect to Kotak WebSocket directly
- subscribe to broker instruments directly
- manage broker authentication
- manage broker sessions
- parse raw broker protocol directly

Those responsibilities belong to:

Session Manager
and
Market Data WebSocket Engine / Broker Adapter.

============================================================
29. FEATURE ENGINE DOES NOT OWN ORDERS
============================================================

The Feature Engine does not:

- place orders
- modify orders
- cancel orders
- manage broker order state
- square off positions

Those responsibilities belong to the relevant Order and Square-Off
engines.

============================================================
30. FEATURE ENGINE DOES NOT OWN POSITIONS OR P&L
============================================================

The Feature Engine may produce market features that can later be used
by Position/P&L/Strategy components.

But it does not become the authoritative owner of:

- trading positions
- realized P&L
- unrealized P&L
- order lifecycle

Those remain separate engine responsibilities.

============================================================
31. DUMMY MODE RELATIONSHIP
============================================================

Dummy mode can use market information ultimately originating from the
same Kotak live feed.

The Feature Engine can calculate the same standardized market features
for Dummy mode because the input contract is standardized.

Dummy execution itself remains outside the Feature Engine.

============================================================
32. FUTURE MODEL / STRATEGY SUPPORT
============================================================

A major purpose of the Feature Engine is to provide reusable features
that future strategy/model engines can consume.

Conceptually:

Live MarketFeed
      |
      v
Feature Engine
      |
      v
Feature Set
      |
      +--> Strategy Engine
      +--> Model Engine
      +--> Market Coach
      +--> Other analytical consumers

The exact downstream architecture will be defined later.

============================================================
33. TESTING STRATEGY
============================================================

Unit tests should eventually cover:

1. Input parsing
2. Field dependency handling
3. Per-instrument state isolation
4. Rolling calculations
5. Indicator calculations
6. Derived features
7. Missing input handling
8. Warm-up state
9. Invalid input handling
10. Feature output validation
11. Calculation error isolation
12. Feature versioning

Integration tests:

WebSocket Engine
    ->
Feature Engine
    ->
standard FeatureOutput

Performance tests:

- high tick rate
- multiple instruments
- multiple calculations
- multiple timeframes where supported
- sustained market-data load

============================================================
34. FUTURE EXPANSION
============================================================

The Feature Engine should be able to expand when the complete field list
is known.

Future additions may include:

- more technical indicators
- more price features
- volume features
- volatility features
- market-depth features
- custom strategy features
- model features
- multi-timeframe features
- advanced derived calculations

New features should be additive and modular.

============================================================
35. DEVELOPMENT ORDER
============================================================

Recommended implementation order:

PHASE 1
Define standard MarketFeed input contract.

PHASE 2
Inspect and finalize actual broker field inventory.

PHASE 3
Map every field to its meaning and availability.

PHASE 4
Define calculation groups.

PHASE 5
Define required indicators.

PHASE 6
Define derived/custom features.

PHASE 7
Define per-instrument calculation state.

PHASE 8
Define timeframe/rolling requirements.

PHASE 9
Implement modular calculators.

PHASE 10
Implement standardized FeatureOutput.

PHASE 11
Add metrics and observability.

PHASE 12
Run unit, integration and performance tests.

============================================================
36. FINAL END-TO-END FLOW
============================================================

              SESSION MANAGER
                     |
                     v
        ACTIVE STOCK / SUBSCRIPTION
                     |
                     v
        MARKET DATA WEBSOCKET ENGINE
                     |
                     v
              BROKER WEBSOCKET
                     |
                     v
                RAW FEED
                     |
                     v
             BROKER ADAPTER
                     |
                     v
               VALIDATION
                     |
                     v
             DEDUPLICATION
                     |
                     v
              NORMALIZATION
                     |
                     v
            STANDARD MARKETFEED
                     |
                     v
              FEATURE ENGINE
                     |
          +----------+----------+
          |          |          |
          v          v          v
     Calculators  Indicators  Derived
                              Features
          |          |          |
          +----------+----------+
                     |
                     v
             FEATURE OUTPUT
                     |
                     v
          FUTURE DOWNSTREAM ENGINES

============================================================
37. GOLDEN RULES
============================================================

1. Feature Engine consumes clean standardized market data.
2. It does not consume raw broker-specific payloads.
3. It does not connect directly to the broker WebSocket.
4. It does not manage broker sessions.
5. It does not manage stock subscriptions.
6. It performs calculations and feature generation.
7. The final indicator list will be decided only after the actual feed
   field inventory is known.
8. Features must declare their input dependencies.
9. Missing inputs must not be silently fabricated.
10. Invalid inputs must not be treated as valid values.
11. Per-instrument calculation state must remain isolated.
12. Required rolling/history state should be managed efficiently.
13. High-frequency calculations should avoid per-tick database queries.
14. Individual calculation failures should be isolated where possible.
15. Feature output should use a stable internal contract.
16. Feature versioning should be considered for formula changes.
17. Performance and calculation latency must be measurable.
18. The Feature Engine does not place or manage orders.
19. The Feature Engine does not own positions or P&L.
20. The Feature Engine is the calculation/feature layer between clean
    market data and future analytical/strategy/model engines.

============================================================
38. FINAL DESIGN STATEMENT
============================================================

The Feature Engine is the central calculation layer of the trading
system.

Its clean responsibility is:

"Take the clean, validated and standardized live market data from the
Market Data WebSocket Engine, maintain the required calculation state,
and generate the calculations, indicators and derived features required
by the rest of the system."

The exact calculations are intentionally deferred.

Once the complete broker feed-field inventory is available, the system
will determine:

    Available Fields
        ->
    Field Meaning
        ->
    Calculation Opportunities
        ->
    Required Indicators
        ->
    Derived Features
        ->
    Feature Modules
        ->
    Standard Feature Output

This keeps the Feature Engine data-driven, modular, extensible and
aligned with the actual market-data feed rather than an arbitrary
predefined indicator list.

============================================================
39. PERFORMANCE UPDATE (2026-10-01) — implementation 021
============================================================

See `docs/implementation/021-trade-page-realtime-performance.md` and
`docs/verification/021-trade-page-realtime-performance-verification.md`.

- `CalculatorState` now maintains incremental VWAP (`_pv_sum`, `_vol_sum`,
  `_vol_count`) and a version-memoised `prices()` list, and exposes
  `volume_observed()` / `vwap()`. `VwapCalculator` consumes them instead of
  rescanning history on every access.

This directly serves golden rules 12 (efficient rolling/history state),
13 (avoid per-tick database queries) and 17 (measurable calculation latency).
The standard FeatureOutput contract, per-instrument state isolation and the
"no fabricated values" rules are unchanged.
