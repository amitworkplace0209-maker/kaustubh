Risk Engine — Advanced UI + Engine + Decision Flow Design

1. Purpose

Risk Engine is the configurable, explainable, multi-rule Trading Risk Decision Engine.

Every new trading request must pass through it before Order Engine execution:

Manual Order ────────┐
AI Suggestion ───────┤
Basket Order ────────┤
Other Trading Path ──┘
                      ↓
                 RISK ENGINE
                      ↓
        ┌─────────────┼─────────────┐
        ↓             ↓             ↓
      ALLOW         WARNING       BLOCK
        ↓             ↓             ↓
   Order Engine     Audit        Audit/UI
        ↓
      Broker

It must explain not only the final decision, but every applicable rule, actual value, configured threshold, reason, source, timestamp, and policy version.

2. Core Principles

Backend enforcement

The UI controls configuration; the backend enforces it. Direct frontend-to-broker or frontend-to-Order-Engine bypasses are not allowed.

AI is not the final safety authority

AI can provide risk analysis, confidence and contextual recommendations, but deterministic hard safety rules remain authoritative.

Evaluate all applicable rules

Do not stop at the first failure.

Evaluate ALL
→ collect PASS / WARNING / BLOCK
→ calculate final decision
→ persist complete decision trace

3. Decision Outcomes

PASS
WARNING
BLOCK
EMERGENCY_BLOCK

PASS: mandatory rules pass.

WARNING: warning rules trigger but no block exists; order may continue.

BLOCK: one or more normal blocking rules fail; broker order must not be sent.

EMERGENCY_BLOCK: global/high-severity trading gate is closed.

Priority:

EMERGENCY_BLOCK
      ↓
HARD_BLOCK
      ↓
CONFIGURED_BLOCK
      ↓
WARNING
      ↓
PASS

4. Rule Categories

P&L

Daily Net P&L

Realized P&L

Unrealized P&L

Daily loss limit

Profit threshold

Drawdown %

Maximum loss from session peak

Optional consecutive-loss limits

Example:

IF Daily Net P&L <= -₹5,000
THEN BLOCK_NEW_ORDERS

Positive P&L does not mean unlimited trading; it only satisfies the relevant configured condition.

Circuit Protection

Use actual instrument circuit data.

For BUY:

upper_distance_pct =
((upper_circuit - current_price) / upper_circuit) × 100

For SELL/short exposure, evaluate lower-circuit distance.

Example:

Upper Circuit = ₹100
Current Price = ₹98
Distance = 2%

If minimum configured distance is 2%, the configured boundary is reached and the rule can block.

Capital / Margin

available capital

available margin

required margin

maximum capital/order

maximum total capital usage

margin utilization

Margin Engine allocation/reservation

Exposure

maximum total exposure

symbol exposure

sector exposure

strategy exposure

AI exposure

manual exposure

simultaneous positions

Quantity / Position

maximum order quantity

maximum position quantity

maximum symbol quantity

maximum open positions

maximum orders/day

maximum orders/symbol

Market Quality

spread

spread %

liquidity

volume

stale LTP

stale tick

abnormal movement

market-data availability

instrument tradability

Trading State

trading hours

trading freeze

squareoff mode

broker session

broker API health

market status

instrument status

AI Risk

minimum AI confidence

signal freshness

model version

AI allocation

AI-specific exposure

AI-specific daily loss

maximum AI size

AI risk score

5. Source Types

Every request carries:

MANUAL
AI
BASKET
SQUAREOFF
SYSTEM

Rules can be source-specific.

Example:

AI max capital/order = ₹10,000
Manual max capital/order = ₹25,000

Universal hard safety rules still apply.

6. Squareoff Interaction

Squareoff is a separate position-closure path, not a normal new-entry path.

Risk Engine should distinguish:

NEW_ENTRY
POSITION_INCREASE
POSITION_REDUCTION
SQUAREOFF

Normal entry restrictions such as AI confidence or new-position exposure should not accidentally prevent Squareoff from closing an existing position.

Squareoff Engine owns the closure workflow; Risk Engine must not replace it.

7. Full Risk Evaluation Flow

ORDER REQUEST
     ↓
Normalize Request
     ↓
Identify Source
     ↓
Check Trading Gate
     ↓
Load Active Risk Policy
     ↓
Load Instrument State
     ↓
Load Current P&L
     ↓
Load Position / Exposure
     ↓
Load Margin / Capital
     ↓
Load Market Quality
     ↓
Evaluate P&L
     ↓
Evaluate Circuit
     ↓
Evaluate Capital / Margin
     ↓
Evaluate Exposure
     ↓
Evaluate Position / Quantity
     ↓
Evaluate Market Quality
     ↓
Evaluate Trading State
     ↓
Evaluate AI Rules if applicable
     ↓
Collect ALL Results
     ↓
Apply Priority
     ↓
FINAL DECISION
   ├── PASS
   ├── WARNING
   ├── BLOCK
   └── EMERGENCY_BLOCK

8. Multi-Reason Decision

A decision must preserve all failures.

Example:

FINAL: BLOCKED

BLOCKING REASONS

1. DAILY_PNL_LIMIT
   Actual: -₹6,240
   Limit: -₹5,000

2. CIRCUIT_PROXIMITY
   Distance: 1.4%
   Required: 2.0%

3. MAX_EXPOSURE
   Current: ₹98,000
   New: ₹12,000
   Limit: ₹1,00,000

WARNINGS

4. HIGH_SPREAD
   Actual: 0.6%
   Warning: 0.5%

PASSED
✓ Market open
✓ Session health
✓ Quantity
✓ Position
✓ Margin
✓ Data freshness

The engine must not return only BLOCK.

9. Risk Decision Record

decision_id
request_id
source
symbol
token
side
quantity
requested_price

final_decision
policy_version

passed_rules[]
warning_rules[]
blocking_rules[]

market_snapshot
account_snapshot
position_snapshot

evaluated_at

Example:

Decision ID: RSK-20260919-000182
Source: AI
Symbol: XYZ
Side: BUY
Quantity: 100
Final: BLOCK
Rules Evaluated: 14
Passed: 9
Warnings: 2
Failed: 3

10. Rule Evaluation Snapshot

Every result must preserve actual decision-time values.

Rule:
DAILY_PNL_LIMIT

Configured:
-₹5,000

Actual:
-₹6,240

Operator:
<=

Result:
BLOCK

Timestamp:
15:02:31.482 IST

Rule Version:
17

Historical decisions must remain reproducible even after settings change.

11. Rule Schema

Conceptual rule:

rule_id
name
category
description
enabled
priority
severity

source_scope
instrument_scope

metric
operator
threshold
unit

action
conditions[]
logic

created_at
updated_at
version

Example:

rule_id: PNL-001
category: PNL
metric: DAILY_NET_PNL
operator: <=
threshold: -5000
unit: INR
severity: BLOCK
action: BLOCK_NEW_ORDERS
enabled: true

12. Multiple Conditions

Support:

AND
OR
NOT

Example:

IF
  Daily P&L <= -₹5,000
AND
  Drawdown >= 3%
THEN
  EMERGENCY_BLOCK

Or:

IF
  Spread > 0.5%
OR
  Data Age > 3 seconds
THEN
  BLOCK

Nested logic must remain understandable in the UI.

13. P&L Configuration UI

P&L RISK CONTROLS

Daily Loss Warning       [ ₹3,000 ]
Daily Loss Block         [ ₹5,000 ]
Emergency Loss Limit     [ ₹10,000 ]

Drawdown Warning         [ 2% ]
Drawdown Block           [ 3% ]
Emergency Drawdown       [ 5% ]

Positive P&L Rules
[ Configure ]

[ SAVE ]

Actions:

WARNING
BLOCK NEW ORDERS
BLOCK AI ONLY
BLOCK MANUAL ONLY
EMERGENCY BLOCK

14. Circuit Configuration UI

CIRCUIT PROTECTION

Upper Circuit Buffer     [ 2.0% ]
Lower Circuit Buffer     [ 2.0% ]

BUY near Upper Circuit:
[ BLOCK ]

SELL near Lower Circuit:
[ BLOCK ]

Missing Circuit Data:
[ BLOCK ]

Stale Circuit Data:
[ BLOCK ]

[ SAVE ]

Actual instrument circuit values should be visible during simulation/evaluation.

15. Capital / Exposure UI

CAPITAL & EXPOSURE

Maximum Capital / Order     [ ₹25,000 ]
Maximum Total Exposure      [ ₹1,00,000 ]
Maximum Symbol Exposure     [ ₹25,000 ]
Maximum AI Exposure         [ ₹50,000 ]
Maximum Manual Exposure     [ ₹50,000 ]

Margin Warning              [ 70% ]
Margin Block                [ 85% ]

[ SAVE ]

16. Advanced Rule Builder

IF
[ Daily Net P&L ]
[ <= ]
[ -5000 ]

AND

[ Circuit Distance ]
[ <= ]
[ 2% ]

THEN

[ BLOCK NEW ORDERS ]

Severity:
[ BLOCK ]

Scope:
[ ALL ]

[ SAVE RULE ]

Support nested AND/OR groups.

17. Rule Validation

Before saving, detect:

duplicate rules

contradictory rules

impossible thresholds

unreachable rules

invalid units

missing required data

conflicting severity/actions

invalid condition trees

Example:

WARNING

New rule:
Daily Loss <= -₹5,000 → BLOCK

Existing:
Daily Loss <= -₹10,000 → EMERGENCY_BLOCK

Rules overlap.

[ CANCEL ] [ SAVE ANYWAY ]

18. Rule Versioning

Every configuration change creates a new version.

Policy Version 17
Circuit buffer:
1.5% → 2.0%

Changed by:
Authorized user

Changed at:
14:32 IST

Every risk decision stores its policy version.

Never rewrite historical policies.

19. Service Phase Sidebar

SERVICE PHASE

Dashboard
Market Watch
Watchlist
Search
Orders
Positions
P&L
Margin
Squareoff
Notifications

Risk Engine
  ├── Overview
  ├── Rule Builder
  ├── P&L Controls
  ├── Circuit Controls
  ├── Capital & Exposure
  ├── Position Limits
  ├── Market Quality
  ├── AI Risk
  ├── Trading Gates
  ├── Decision History
  ├── Blocked Orders
  ├── Allowed Orders
  ├── Simulator
  └── Advanced Settings

20. Risk Engine Overview

┌──────────────────────────────────────────────┐
│ RISK ENGINE                    ● ACTIVE      │
│                                              │
│ Trading Gate        OPEN                    │
│ Policy              v17                     │
│ Active Rules        37                      │
│ Net P&L             ₹ +3,240                │
│ Drawdown            1.8%                    │
│ Margin Utilization  42%                     │
│                                              │
│ TODAY                                        │
│ Evaluated           128                     │
│ Allowed             91                      │
│ Warnings            22                      │
│ Blocked             15                      │
│                                              │
│ [RULE BUILDER] [SIMULATOR] [HISTORY]        │
└──────────────────────────────────────────────┘

All values must be real backend values; no fake financial values.

21. Decision History

TIME    SYMBOL  SOURCE   QTY   RESULT
09:31   ABC     AI       100   ALLOW
09:42   XYZ     AI       200   BLOCK
10:02   TCS     MANUAL    50   WARNING
10:31   DEF     AI       100   BLOCK

Filters:

date

symbol

source

result

rule

strategy

AI/manual

blocking reason

22. Decision Detail

RISK DECISION

Decision: BLOCK
Decision ID: RSK-00182

Source: AI
Symbol: XYZ
Side: BUY
Quantity: 100

▼ Final Decision
BLOCK

▼ Blocking Reasons
3

▼ Warnings
2

▼ Passed Rules
9

▼ Rule Evaluation
14 total

▼ Market Snapshot
LTP
Circuit
Spread
Volume
Data Age

▼ Account Snapshot
P&L
Margin
Exposure

▼ Policy Version
17

▼ AI Context
Model
Confidence
Signal Age

▼ Audit Trail
...

23. Blocked and Allowed Views

Blocked Orders

Show counts and top reasons:

Daily P&L       6
Circuit         4
Exposure        3
Stale Data      2

Allowed Orders

Also explain why they passed:

✓ P&L
✓ Margin
✓ Circuit
✓ Exposure
✓ Quantity
✓ Market Quality
✓ Trading State

Warnings:
⚠ Elevated volatility

24. Risk Simulator

The simulator never places a broker order.

Inputs:

Symbol
Side
Quantity
Price
Source
Strategy

Output:

SIMULATION RESULT

FINAL: BLOCK

Passed: 9
Warnings: 2
Blocked: 3

Reasons:
1. DAILY_PNL_LIMIT
2. CIRCUIT_PROXIMITY
3. MAX_EXPOSURE

This is for testing policy before enabling it.

25. What-If Analysis

Advanced simulator can show:

What would need to change for this order to be allowed?

Example:

Current:
P&L = -₹6,240
Exposure = ₹98,000
Circuit Distance = 1.4%

Blocking:
- P&L
- Exposure
- Circuit

Potential qualifying changes:
- P&L above configured limit
- Exposure below configured limit
- Circuit distance above configured threshold

This is advisory only and must not automatically change configuration.

26. AI Risk Layer

Optional:

Deterministic Risk Rules
        ↓
Optional AI Risk Analysis
        ↓
Final Policy Decision

AI can produce:

risk_score
confidence
context
warnings
recommended_action

But:

AI recommendation != safety override

Hard safety blocks remain authoritative.

27. AI Order Flow

AI Model
   ↓
Trade Suggestion
   ↓
Risk Engine
   ↓
Evaluate:
P&L
Circuit
Margin
Exposure
Quantity
Market
AI confidence
Trading state
   ↓
ALLOW / WARNING / BLOCK
   ↓
If allowed:
Audit Engine
   ↓
Order Engine
   ↓
Broker

If blocked, no executable broker order is sent.

28. Order Engine Integration

Order Engine
     ↓
Risk Engine.evaluate()
     ↓
BLOCK → rejection returned
     ↓
EMERGENCY_BLOCK → rejection + gate state
     ↓
WARNING → continue + audit
     ↓
PASS → continue
     ↓
Audit Engine
     ↓
Broker Adapter

Order Engine must never execute before Risk evaluation.

29. Audit Integration

Send to Audit Engine:

decision_id
request_id
order request
source
final decision
blocking reasons
warnings
passed rules
policy version
market snapshot
account snapshot
timestamp

This preserves the full decision trail.

30. Data Freshness / Failure Closed

Every critical input has age:

LTP age       220 ms
P&L age       1.2 sec
Position age  0.8 sec
Margin age    1.1 sec
Circuit age   2.0 sec

If a mandatory safety input is unavailable or too stale:

UNKNOWN
→ NOT SAFE
→ BLOCK

Examples:

position unavailable

margin unavailable

required circuit unavailable

market data stale

trading gate unknown

Do not treat missing values as safe.

31. Concurrency and Atomicity

Risk state can change between evaluation and execution.

Example:

Risk sees exposure = ₹90,000
New order = ₹10,000
Risk allows

Another order executes first

Actual exposure = ₹1,05,000

Therefore critical limits require execution-time revalidation or reservation.

Recommended:

Evaluate
  ↓
Reserve relevant risk capacity
  ↓
Execute
  ↓
Release / update reservation

Margin Engine owns AI capital allocation reservations; Risk Engine owns its policy-level risk constraints.

32. Idempotency

Each order request has a unique request ID.

risk_request_id

Same request ID repeated:

→ return existing risk decision

Do not create inconsistent duplicate decisions.

33. Global Trading Gate

Risk Engine exposes:

OPEN
WARNING
RESTRICTED
CLOSED
EMERGENCY_CLOSED

Meaning:

OPEN → normal new orders

WARNING → normal orders with warnings

RESTRICTED → only configured sources/types

CLOSED → no new orders

EMERGENCY_CLOSED → all new exposure blocked

Squareoff remains a separate closure operation.

34. Emergency Controls

Service Phase may expose:

[ CLOSE NEW TRADING ]
[ RESTRICT AI ]
[ RESTRICT MANUAL ]
[ OPEN TRADING ]

Require authorization and confirmation.

Example:

CLOSE NEW TRADING

This prevents:
- AI new orders
- Manual new orders
- Basket new orders

Existing positions are not automatically closed.

[ CANCEL ] [ CONFIRM ]

All actions are audited.

35. Notifications

Notify on:

emergency block

daily loss threshold

repeated blocks

risk configuration changes

broker risk-data failure

stale market data

abnormal exposure

AI restriction

trading gate closure

Example:

RISK ALERT

Trading gate CLOSED.

Reason:
Daily P&L reached emergency loss limit.

P&L:
-₹10,240

New orders blocked.

36. Observability

Metrics:

risk_evaluations_total
risk_allowed_total
risk_warning_total
risk_blocked_total
risk_emergency_block_total
risk_rule_failures_total
risk_rule_warnings_total
risk_evaluation_latency
risk_data_staleness
risk_config_changes_total
risk_gate_changes_total

Logs include:

decision_id
request_id
symbol
source
final_decision
failed_rule_ids
policy_version

Never log secrets.

37. Testing

Unit

Test:

P&L thresholds

positive/negative P&L

circuit distance

BUY upper-circuit protection

SELL lower-circuit protection

margin

exposure

quantity

position

spread

stale data

trading hours

freeze

AI confidence

multiple simultaneous failures

warnings

emergency rules

priority

AND/OR logic

disabled rules

versioning

duplicate requests

Integration

AI → Risk → BLOCK
→ Order Engine must NOT call broker

AI → Risk → ALLOW
→ Audit → Order Engine → Broker

Manual → Risk → BLOCK

Squareoff → closure path
→ normal new-entry rules must not accidentally prevent closure

Failure

Test:

broker timeout

missing margin

stale LTP

missing circuit

position API failure

simultaneous orders

duplicate request

configuration update during evaluation

freeze/evaluation race

38. Performance

Risk evaluation should be fast enough for every order.

Avoid:

full DB scans per order

unnecessary network calls

expensive repeated calculations

AI calls for every simple deterministic rule

Prefer:

Cached/streamed state
+
fast deterministic evaluation
+
optional AI analysis when configured

Critical broker state may be revalidated immediately before execution.

39. Security

Service Phase authentication required.

Sensitive configuration changes require confirmation.

Every configuration change is audited.

Risk APIs require authorization.

Broker credentials remain backend-only.

Frontend cannot directly modify internal risk state.

AI cannot modify hard safety rules.

Emergency actions are audited.

40. Non-Goals

Risk Engine does not:

generate trading signals

select stocks

perform AI capital allocation

execute broker orders

own broker WebSocket

manage normal positions

perform end-of-day squareoff

replace Audit Engine

replace Margin Engine

replace Order Engine

It decides whether a proposed trading action satisfies active risk policy.

41. Engine Relationships

Feature / Market Data
        ↓
Instrument + Market State

P&L Engine
        ↓
P&L State

Position Engine
        ↓
Position / Exposure State

Margin Engine
        ↓
Capital / Margin State

AI
        ↓
Suggestion + AI Context

              ┌──────────────┐
              │ RISK ENGINE  │
              └──────┬───────┘
                     ↓
                Risk Decision
                     ↓
                Audit Engine
                     ↓
                Order Engine
                     ↓
                  Broker

42. End-to-End ALLOW Example

AI suggests:

BUY ABC
Qty: 200
Confidence: 84%

State:

Daily P&L        +₹2,800
Exposure         ₹72,000
Margin available ₹35,000
Circuit distance 4.2%
Spread           0.2%
Data age         180 ms

Results:

P&L              PASS
Circuit          PASS
Exposure         PASS
Margin           PASS
Quantity         PASS
Spread           PASS
Data freshness   PASS
AI confidence    PASS
Trading gate     PASS

Final:

ALLOW

Then:

Audit
 ↓
Order Engine
 ↓
Broker

43. End-to-End BLOCK Example

AI suggests:

BUY XYZ
Qty: 100
Confidence: 81%

State:

Daily P&L        -₹6,240
Circuit distance 1.4%
Projected exposure ₹1,05,000

Results:

P&L              BLOCK
Circuit          BLOCK
Exposure         BLOCK
AI confidence    PASS
Margin           PASS
Quantity         PASS

Final:

BLOCK

Order Engine must not send an executable broker order.

UI shows all three blocking reasons.

44. Daily Lifecycle

Before market:

Load policy
Validate policy
Initialize state
Check broker/session
Set gate OPEN only when trading conditions permit

During market:

Order request
→ evaluate
→ record decision
→ allow/block
→ update state

Risk event:

Trigger rule
→ update gate if required
→ notify
→ audit
→ block affected orders

Before squareoff:

Squareoff freeze
→ new orders blocked

After squareoff:

Risk gate remains closed for new trading

Next trading day:

Reset daily metrics
Load active policy
Validate configuration
Open only when scheduler/session permits

45. Configuration Lifecycle

UI Edit
  ↓
Validate
  ↓
Conflict Check
  ↓
Preview
  ↓
User Confirmation
  ↓
Create Policy Version
  ↓
Persist
  ↓
Audit
  ↓
Activate

Historical versions are immutable.

46. Acceptance Criteria

The implementation is acceptable only when:

Every new order passes through Risk Engine.

AI cannot bypass Risk Engine.

Manual cannot bypass Risk Engine.

Basket cannot bypass Risk Engine.

All applicable rules are evaluated.

Multiple failures are preserved.

Every block has explicit reasons.

Every allow has evaluated-rule evidence.

Actual decision-time values are stored.

Policy version is stored.

P&L rules are configurable.

Circuit rules are configurable.

Capital/margin rules are configurable.

Exposure rules are configurable.

Quantity/position rules are configurable.

Market-quality rules are configurable.

AI-specific rules are configurable.

Trading-gate rules are configurable.

Rule priority is deterministic.

AND/OR conditions work.

Rule conflicts are detected.

Rule changes are versioned and audited.

Risk Simulator exists.

Decision History exists.

Blocked and Allowed views exist.

Emergency global gate exists.

Missing critical data fails closed.

Duplicate requests are idempotent.

Execution-time state changes are handled.

Squareoff has a separate closure path.

Risk decisions reach Audit Engine.

UI has no fake risk/account values.

AI cannot override hard safety rules.

47. Final Architecture Principle

Risk Engine = Configurable + Explainable + Deterministic Safety Gate + Optional AI Risk Intelligence.

The decision pipeline is:

PROPOSE
   ↓
EVALUATE ALL
   ↓
EXPLAIN
   ↓
DECIDE
   ↓
AUDIT
   ↓
EXECUTE ONLY IF ALLOWED

Every decision must answer:

WHAT?
WHY?
WHICH RULE?
WHAT VALUE?
WHAT LIMIT?
WHAT SOURCE?
WHAT POLICY VERSION?
WHAT WAS THE FINAL DECISION?

This makes Risk Engine suitable for AI trading, manual trading, basket trading and future strategy expansion without making the UI or AI layer an unsafe execution authority.