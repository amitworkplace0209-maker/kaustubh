ORDER ENGINE — ADVANCED UI + ENGINE DETAILED DESIGN

1. Executive Definition

Order Engine is the single authoritative trading-order orchestration engine.

It handles:

Manual orders

AI-generated orders

Single orders

Basket orders

Order validation/orchestration

Risk Engine integration

Broker submission

Broker execution/status responses

Partial fills

Rejections with full broker reason

Cancellation/status verification

Execution result normalization

System/UI updates

Audit integration

Order lifecycle tracking

Basket Engine is NOT a separate engine. Basket functionality is part of Order Engine.

Core principle:

Every trading order, whether created manually, by AI, or through a basket, passes through one controlled Order Engine path before reaching the broker.

2. Architectural Position

Manual UI ───────┐
                 │
AI Engine ───────┤
                 │
Basket UI ───────┤
                 ↓
            ORDER ENGINE
                 │
          Order Validation
                 │
             Risk Engine
                 │
          Order Preparation
                 │
          Broker Adapter
                 │
              Broker
                 │
       Execution / Rejection
                 │
        Order Engine Normalize
                 │
       ┌─────────┼─────────┐
       ↓         ↓         ↓
    System     Audit       UI

The UI must never call the broker directly.

3. Responsibility Boundary

Order Engine owns

receiving manual order requests

receiving AI order requests

basket creation

basket modification

basket execution orchestration

order validation/orchestration

source identification

order lifecycle

broker submission

broker response normalization

execution status

partial fill state

cancellation orchestration

broker rejection reason preservation

execution summaries

idempotency

correlation IDs

system/UI result delivery

Order Engine does NOT own

final risk policy decisions

broker authentication

canonical broker terminal state

P&L calculation

position calculation

market data feed

capital-risk policy itself

notification rendering

audit database ownership

These remain with their respective engines.

4. Sources

Every order must identify its source:

MANUAL
AI
BASKET_MANUAL
BASKET_AI
SYSTEM
SQUAREOFF

For baskets, the parent basket and individual order source must both be preserved.

Example:

source = BASKET_AI
basket_id = BASKET_102
child_order_id = ORD_204

5. Order Types

The engine should support broker/project-supported types such as:

MARKET

LIMIT

STOP_LOSS

STOP_LIMIT

Product types should be capability-driven:

Intraday/MIS

Delivery/CNC

Other broker-supported products

The engine must not expose unsupported order types merely because the UI contains the option.

6. Single Order Lifecycle

REQUEST
  ↓
NORMALIZE
  ↓
VALIDATE
  ↓
RISK CHECK
  ↓
PREPARE
  ↓
SUBMIT TO BROKER
  ↓
BROKER RESPONSE
  ↓
STATUS VERIFICATION
  ↓
EXECUTION NORMALIZATION
  ↓
SYSTEM / AUDIT / UI

Validation failure stops before broker submission.

Risk failure stops before broker submission.

Broker rejection occurs after submission attempt and must be represented separately from local validation failure.

7. Manual Order Flow

User
 ↓
Order UI
 ↓
Order Engine
 ↓
Normalize Request
 ↓
Validate
 ↓
Risk Engine
 ↓
Broker Adapter
 ↓
Broker
 ↓
Execution Response
 ↓
Order Engine
 ↓
UI + System + Audit + Notification

Manual orders must not silently enter AI capital allocation rules.

If a manual order is placed inside a basket, basket policy applies because the user explicitly selected basket execution.

8. AI Order Flow

AI
 ↓
Trade Suggestion
 ↓
Order Engine
 ↓
Source = AI
 ↓
Risk Engine
 ↓
Broker
 ↓
Execution Result
 ↓
System/UI/Audit/Notification

If AI allocation is required, Margin Engine may provide the capital-allocation result before Order Engine execution.

Order Engine remains responsible for the actual order lifecycle.

9. Basket Architecture

Basket is an Order Engine capability.

ORDER ENGINE
│
├── Single Order
│
└── Basket
    ├── Manual Basket
    ├── AI Basket
    ├── Child Orders
    ├── Selection Policy
    ├── Max Executable Orders
    ├── Capital Policy
    └── Execution Summary

A basket can contain any configured number of orders subject to system limits.

Example:

Basket: Morning Basket
Orders: 20
Max Executable: 5
Selection Policy: HIGHEST_VALUE

10. Basket Creation

Basket can be created:

manually

by AI

from existing order

from selected instruments

from a saved basket template

Basket metadata:

basket_id
name
source
owner
orders
max_executable_orders
selection_policy
priority_policy
capital_limit
allocation_policy
failure_policy
remaining_order_policy
status
created_at
updated_at

11. Basket Child Orders

Each child order must have:

child_order_id
basket_id
sequence
symbol
token
side
quantity
order_type
price
product
estimated_value
priority
status
broker_order_id
executed_quantity
remaining_quantity
average_price
rejection_reason

A child order is independently traceable.

12. Maximum Executable Orders

Example:

Basket has 20 orders
Max executable = 5

Only 5 eligible orders should be submitted according to the selected policy.

Remaining 15 must receive an explicit state:

NOT_SELECTED
SKIPPED
CANCELLED

Do not silently disappear.

13. Selection Policies

Supported policies should be explicit and configurable.

Possible policies:

ORDER_PRIORITY
HIGHEST_VALUE
LOWEST_VALUE
CUSTOM_PRIORITY
AI_PRIORITY

Example:

20 orders
Max = 5
Policy = HIGHEST_VALUE

The five highest eligible order values are selected.

If:

Policy = ORDER_PRIORITY

orders are selected by their configured sequence/priority.

Selection policy must be visible before execution.

14. Capital Allocation

Basket execution must consider available capital and the configured allocation policy.

Example:

Basket Capital Limit = ₹100,000
Selected Orders = 5

The engine calculates the executable capacity for each selected order based on the authoritative capital/risk information available from the relevant engines.

Order Engine must not invent available funds.

If capital is insufficient:

FULL_EXECUTION
PARTIAL_EXECUTION
STOP_BASKET
SKIP_ORDER

must be determined by explicit basket policy.

15. Important Capital Rule

The largest-value orders must NOT automatically receive priority unless that selection policy is explicitly configured.

Example:

Policy = HIGHEST_VALUE

means highest eligible order value first.

But:

Policy = ORDER_PRIORITY

means configured order priority wins.

This prevents hidden execution behavior.

16. Basket Execution Modes

Recommended modes:

Sequential

Order 1
 ↓
result
 ↓
Order 2
 ↓
result
 ↓
Order 3

Useful where capital availability depends on earlier executions.

Parallel

Multiple eligible orders may be submitted concurrently within configured concurrency limits.

Useful for independent orders.

Controlled Parallel

Recommended general architecture:

Select K orders
 ↓
Concurrency = N
 ↓
Submit N at a time
 ↓
Process results
 ↓
Submit next batch if policy allows

The mode must be explicit.

17. Basket Failure Policies

Possible policies:

CONTINUE
STOP_ON_FIRST_FAILURE
STOP_ON_CRITICAL_FAILURE
CONTINUE_ELIGIBLE

Example:

5 selected
Order 1 → Filled
Order 2 → Rejected
Order 3 → Filled
Order 4 → Broker Timeout
Order 5 → Pending

Basket status must represent the actual mixed state.

18. Broker Submission

Order Engine sends a normalized broker request.

Example:

{
  "symbol": "RELIANCE",
  "token": "2885",
  "side": "BUY",
  "quantity": 10,
  "order_type": "MARKET",
  "product": "MIS",
  "price": null,
  "source": "MANUAL",
  "basket_id": null,
  "correlation_id": "CORR123"
}

The broker adapter converts this into broker-specific fields.

Order Engine should not contain scattered broker-specific request formatting.

19. Broker Response

Order Engine must preserve both:

Raw broker response

Useful for exact diagnostics/audit.

Normalized response

Used by system/UI.

Example normalized response:

status
broker_order_id
accepted_quantity
executed_quantity
pending_quantity
average_execution_price
rejection_code
rejection_reason
broker_message
timestamp

20. Rejection Handling

There are multiple failure classes.

Local validation rejection

Example:

INVALID_QUANTITY
INVALID_PRICE
UNSUPPORTED_ORDER_TYPE
MISSING_SYMBOL

Risk rejection

Example:

DAILY_LOSS_LIMIT
EXPOSURE_LIMIT
CIRCUIT_PROXIMITY
TRADING_GATE_CLOSED

Broker rejection

Example:

INSUFFICIENT_MARGIN
INVALID_SYMBOL
MARKET_CLOSED
BROKER_RULE
BROKER_RMS_REJECTION

The UI must distinguish these.

21. Full Broker Rejection Reason

If broker returns:

rejection_code
rejection_message

the engine must preserve them.

UI should show:

Order Rejected

Reason:
Insufficient margin for requested quantity

Broker:
KOTAK

Broker Code:
XYZ123

Broker Message:
<exact broker message>

Order:
RELIANCE BUY 100

Time:
10:22:14

Internal normalized reason can be shown alongside the broker's original message.

Do not replace the broker message with a generic "Order failed".

22. Partial Fill

Partial execution is a first-class state.

Example:

Requested = 100
Executed = 60
Pending = 40

State:

PARTIALLY_FILLED

The system must preserve:

requested quantity

executed quantity

remaining quantity

average execution price

individual fill events where available

23. Fill Tracking

Where broker supports fill-level data:

Fill 1 → Qty 20 @ ₹100
Fill 2 → Qty 15 @ ₹101
Fill 3 → Qty 25 @ ₹100.50

Order Engine aggregates:

Executed = 60
Average Price = calculated broker-authoritative/normalized value

Raw fills remain traceable.

24. Order Status State Machine

Recommended:

CREATED
  ↓
VALIDATING
  ↓
RISK_PENDING
  ↓
READY
  ↓
SUBMITTING
  ↓
SUBMITTED
  ↓
OPEN
  ↓
PARTIALLY_FILLED
  ↓
FILLED

Alternative terminal states:

REJECTED
CANCELLED
EXPIRED
FAILED
UNKNOWN

UNKNOWN is important when broker acknowledgement is ambiguous.

Do not mark an order rejected merely because a network timeout occurred.

25. Timeout / Ambiguous Submission

Critical case:

Order submitted
 ↓
network timeout
 ↓
no response

Order Engine must NOT blindly submit again.

Instead:

UNKNOWN
 ↓
Query broker order status
 ↓
FOUND → reconcile
NOT FOUND → apply safe retry policy

This prevents duplicate trading.

26. Idempotency

Every submission should carry an internal idempotency/correlation key.

Example:

idempotency_key =
terminal_id + client_order_reference

Repeated frontend clicks must not accidentally create duplicate orders when the first request is still processing.

27. Cancel Flow

UI / Basket / System
 ↓
Order Engine
 ↓
Verify current status
 ↓
Cancel through broker
 ↓
Broker response
 ↓
Verify cancellation
 ↓
Update order state
 ↓
UI/System/Audit

A cancel request is not equivalent to a confirmed cancellation.

28. Basket Remaining Orders

After selection:

Selected
→ submitted/executed according to policy

Not selected
→ NOT_SELECTED

Already submitted but later stopped
→ CANCEL_REQUESTED
→ CANCELLED / CANCEL_FAILED

The engine must distinguish these states.

29. Manual Order UI

Manual order ticket should support:

Symbol
Side
Quantity
Order Type
Price / Trigger
Product
Terminal/Broker

Additional options:

[ ] Place Order in Basket

When enabled:

Select Existing Basket
Create New Basket

30. Existing Basket Selection UI

Show:

Basket Name
Orders Count
Max Executable
Selection Policy
Capital Limit
Execution Mode
Failure Policy
Status
Last Run

Example:

Morning Momentum
20 Orders
Max 5
Highest Value
₹100,000
Controlled Parallel
Continue Eligible
READY

User must understand what will happen before submitting.

31. Basket Builder UI

Recommended layout:

┌─────────────────────────────────────────┐
│ Create Basket                           │
├─────────────────────────────────────────┤
│ Basket Name                             │
│ Source: Manual / AI                     │
│                                         │
│ Orders                                  │
│ ┌─────────────────────────────────────┐ │
│ │ RELIANCE BUY 100     Priority 1    │ │
│ │ TCS BUY 50           Priority 2    │ │
│ │ INFY SELL 30         Priority 3    │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ Max Executable Orders: [5]              │
│ Selection: [Highest Value ▼]             │
│ Execution: [Controlled Parallel ▼]      │
│ Capital Limit: [₹100,000]               │
│ Failure Policy: [Continue Eligible ▼]   │
│ Remaining: [Skip]                       │
│                                         │
│ [Save Basket] [Preview] [Cancel]        │
└─────────────────────────────────────────┘

32. Basket Preview

Before execution, provide a dry-run preview:

Basket: Morning Momentum

Total Orders: 20
Max Executable: 5
Selection Policy: Highest Value
Estimated Capital: ₹98,500

Selected:
1. RELIANCE
2. TCS
3. INFY
4. HDFCBANK
5. SBIN

Not Selected:
15 orders

[Confirm Execute]

This prevents accidental large basket submissions.

33. Basket Execution UI

During execution:

Basket: Morning Momentum

Overall: PARTIALLY EXECUTED

20 total
5 selected
3 filled
1 rejected
1 pending
15 not selected

--------------------------------
RELIANCE    FILLED
TCS         FILLED
INFY        FILLED
HDFCBANK    REJECTED
SBIN        PENDING

Every child order must be clickable.

34. Order Detail UI

Show:

Summary

Symbol

Side

Quantity

Order type

Product

Broker

Terminal

Source

Execution

Requested

Accepted

Executed

Pending

Average price

Fill timeline

Broker

broker order ID

status

rejection code

exact broker message

Risk

risk decision

decision

reason codes

policy version

Trace

correlation ID

audit event

basket ID

35. Order History

Filters:

date/time

source

broker

terminal

symbol

status

basket

side

order type

Search:

order ID

broker order ID

basket ID

correlation ID

symbol

36. Basket History

Show:

Basket ID
Name
Created
Source
Total Orders
Selected
Filled
Partial
Rejected
Cancelled
Skipped
Capital Used
Status

Possible basket states:

DRAFT
READY
VALIDATING
EXECUTING
PARTIALLY_EXECUTED
COMPLETED
FAILED
CANCELLED

37. System Integration

Order Engine sends normalized results to:

Position/Risk capability

Execution changes must become available to the relevant risk/position state.

Audit Engine

Record:

request

validation

risk result

broker submission

broker response

fill

rejection

cancellation

basket selection

Notification Engine

Examples:

ORDER_ACCEPTED
ORDER_FILLED
ORDER_PARTIALLY_FILLED
ORDER_REJECTED
ORDER_CANCELLED
BASKET_STARTED
BASKET_COMPLETED
BASKET_PARTIAL
BASKET_FAILED

UI

Realtime incremental updates.

38. Order Event Contract

Example:

{
  "event_type": "ORDER_FILLED",
  "order_id": "ORD123",
  "broker_order_id": "K123",
  "basket_id": null,
  "source": "MANUAL",

  "symbol": "RELIANCE",
  "side": "BUY",

  "requested_quantity": 100,
  "executed_quantity": 100,
  "pending_quantity": 0,

  "average_execution_price": 1450.50,

  "broker": "KOTAK",
  "terminal_id": "terminal01",

  "timestamp": "2026-09-19T10:30:00Z",

  "correlation_id": "CORR123"
}

39. AI + Basket Integration

AI can create:

AI Basket

Example:

AI proposes 15 trades
 ↓
Create Basket
 ↓
Max Executable = 5
 ↓
Selection Policy = AI Priority
 ↓
Risk validation
 ↓
Broker execution

AI must not bypass Order Engine.

AI can propose; Order Engine controls execution.

40. Manual + AI Separation

Every order must expose:

MANUAL
AI
BASKET_MANUAL
BASKET_AI

This enables:

audit

permissions

analytics

notification filtering

source-specific policy

debugging

41. Permissions

Potential permissions:

ORDER_CREATE
ORDER_CANCEL
BASKET_CREATE
BASKET_EDIT
BASKET_EXECUTE
BASKET_CANCEL
AI_EXECUTION
MANUAL_EXECUTION

Dangerous operations require authenticated authorization.

42. Safety Gates

Before broker submission:

Order Valid?
      ↓
Risk Allowed?
      ↓
Trading State Open?
      ↓
Terminal Connected?
      ↓
Broker Capability Supported?
      ↓
Capital/Margin Available?
      ↓
Idempotency Safe?
      ↓
Submit

The Order Engine orchestrates these checks but does not own every decision.

43. Broker Capability Handling

Before execution:

Broker Terminal
      ↓
Capabilities
      ↓
Order Engine

Example:

Supports MARKET       YES
Supports SL           YES
Supports CNC          YES
Supports Basket API   NO

Basket execution can still be implemented by Order Engine through individual child orders if broker does not have a native basket API.

The broker's limitations must not be hidden from the user.

44. Concurrency

Basket execution must have explicit limits.

Example:

Max concurrent submissions = 3

Do not blindly submit hundreds of orders simultaneously.

Concurrency must consider:

broker rate limits

account state

capital

order dependencies

terminal health

45. Rate Limiting

Order Engine should respect broker/API limits.

Use:

submission queue

concurrency limits

retry backoff

status-query throttling

request deduplication

Never turn a broker outage into a request storm.

46. Retry Policy

Safe retry only when the previous state is known.

Timeout
 ↓
Query status
 ↓
Confirmed NOT SUBMITTED
 ↓
Retry allowed

If:

UNKNOWN

then reconcile before resubmission.

47. Observability

Metrics:

orders received

validation failures

risk blocks

broker submissions

broker rejections

fills

partial fills

cancellation success/failure

unknown orders

retry count

broker latency

basket execution duration

basket completion rate

capital utilization

Logs should contain:

order_id
broker_order_id
basket_id
correlation_id
source
terminal_id
broker
event_type
status

48. Data Integrity

Never overwrite important lifecycle states.

Instead maintain:

current_state
+
event/history

Example:

SUBMITTED
→ PARTIALLY_FILLED
→ FILLED

History remains available.

Broker state is authoritative for broker execution status when reconciled.

49. Recovery

On application restart:

Order Engine starts
 ↓
Load non-terminal orders
 ↓
Query broker
 ↓
Reconcile
 ↓
Update local state
 ↓
Notify UI if state changed

For baskets:

Load active baskets
 ↓
Reconcile child orders
 ↓
Recalculate basket status

Do not assume previous in-memory state is authoritative.

50. UI Realtime Behavior

A new fill should update:

order row

basket row

execution summary

relevant position/risk state

notification badge

without forcing a full application rerender.

Use event-driven incremental state updates.

51. Mobile / PWA

Order UI should remain usable on mobile.

Basket cards should prioritize:

status

executed/remaining

capital used

failures

broker

action buttons

Detailed broker response can open a drawer/detail page.

52. Non-Goals

Order Engine does not:

calculate final risk policy

calculate P&L

own broker login

own market data

own notification rules

own audit persistence

silently reroute orders between brokers

invent broker execution status

automatically retry ambiguous orders without reconciliation

53. Testing

Unit

normalization

validation

source handling

state transitions

rejection parsing

partial fill handling

idempotency

basket selection

basket limits

policy evaluation

Integration

Manual → Risk → Broker

AI → Risk → Broker

Basket → child orders → Broker

Broker rejection → UI

Broker partial fill → UI

cancel → verification

timeout → reconciliation

Order → Notification

Order → Audit

Failure Tests

broker timeout

duplicate request

broker rejection

partial fill

broker disconnect

rate limit

restart during execution

restart during basket execution

inconsistent broker status

54. Acceptance Criteria

Order Engine is complete when:

manual orders use Order Engine

AI orders use Order Engine

basket functionality is inside Order Engine

any configured number of basket orders can be represented within safe system limits

max executable orders can be configured

selection policy is explicit

capital policy is explicit

sequential/controlled parallel execution is supported

partial fills are tracked

broker rejection reasons are preserved

broker order IDs are preserved

ambiguous submissions are reconciled before retry

cancellation is verified

execution state reaches system/UI in realtime

audit trace exists

notification events are generated

manual/AI source is preserved

basket child orders are independently traceable

restart reconciliation works

rate limiting prevents broker request storms

no direct broker calls originate from frontend

no fake execution data is used

55. Final Engine Definition

Order Engine = Single Order + Basket Orchestration + Broker Execution + Execution State + Result Distribution.

Final responsibility:

                    ORDER ENGINE
                         │
          ┌──────────────┴──────────────┐
          ↓                             ↓
    SINGLE ORDER                     BASKET
    Manual / AI                 Manual / AI
          │                             │
          └──────────────┬──────────────┘
                         ↓
                  Validation Flow
                         ↓
                    Risk Engine
                         ↓
                  Broker Adapter
                         ↓
                      Broker
                         ↓
             Execution / Rejection
                         ↓
                 Order Engine State
                         ↓
       ┌─────────────────┼─────────────────┐
       ↓                 ↓                 ↓
     System            Audit          Notification
       │                                   │
       └─────────────────┬─────────────────┘
                         ↓
                         UI

The Order Engine is the only controlled application path for actual order execution.

Basket is an orchestration capability of Order Engine, not a separate engine.



esme hi hoga target engin 
  mtlb ak hi name hoga oderengin 
  TARGET ENGINE — ADVANCED UI + ENGINE DETAILED DESIGN

1. Executive Definition

Target Engine is the position-target monitoring and automatic exit-trigger engine.

Its primary responsibility is:

When a Manual or AI order is created with a Target P&L configuration, register that target against the actually executed position, monitor the authoritative live P&L, and when the configured target condition is reached, trigger an opposite-side square-off order through Order Engine.

Target Engine does NOT directly call the broker.

The actual exit order always goes through:

Target Engine
    ↓
Order Engine
    ↓
Risk / execution controls
    ↓
Broker Adapter
    ↓
Broker

This preserves one controlled order-execution path.

2. Architectural Position

                  MANUAL / AI
                       ↓
                  ORDER ENGINE
                       ↓
                  RISK ENGINE
                       ↓
                    BROKER
                       ↓
                  ENTRY FILLED
                       ↓
                 TARGET ENGINE
                       ↓
              Monitor Live P&L
                       ↓
              Target Condition
                 Reached?
                  /       \
                NO         YES
                |           ↓
             Monitor   Trigger Exit
                            ↓
                       ORDER ENGINE
                            ↓
                    Opposite-side Order
                            ↓
                         BROKER
                            ↓
                       Exit Result
                            ↓
                   Target Engine State

3. Responsibility Boundary

Target Engine owns

target configuration

target P&L registration

target activation

target monitoring

target state machine

P&L trigger evaluation

position-to-target mapping

partial-fill-aware target registration

target modification

target cancellation

trigger deduplication

exit request creation

exit request tracking

target history

target recovery

target-specific audit events

target-specific notification events

target UI state

Target Engine does NOT own

broker login

broker WebSocket

broker direct order submission

final order execution

canonical P&L calculation

canonical position ownership

general risk policy

general squareoff policy

notification rendering

audit database ownership

These remain with the appropriate engines.

4. Relationship With Other Engines

Order Engine
     │
     │ execution result
     ↓
Target Engine
     │
     │ target reached
     ↓
Order Engine
     │
     ↓
Risk Engine
     │
     ↓
Broker

Target Engine also consumes:

Position State
Live P&L
Market Data
Trading State
Broker Execution State

The authoritative source for position/P&L must be clearly defined by the final architecture. Target Engine must never invent P&L from stale or incomplete information.

5. Target Configuration

A target is attached to an order/position through a target configuration.

Example:

Target P&L: ₹2,000
Trigger: NET_PNL >= ₹2,000
Action: SQUARE_OFF_POSITION
Status: ARMED

Recommended fields:

target_id
order_id
position_id
basket_id
source
terminal_id
broker
symbol
side

target_type
target_value
target_currency

trigger_mode
action

status
created_at
updated_at
triggered_at
completed_at

quantity_scope
configuration_version
correlation_id
metadata

6. Target Types

Initial target type:

P&L_TARGET

The architecture should remain extensible for future types such as:

PRICE_TARGET
PERCENT_RETURN_TARGET
TRAILING_PNL_TARGET

These should not be implemented merely because the UI has a field. They should be capability-driven.

Current authoritative target requirement is:

Target P&L amount.

7. Target P&L Semantics

Example:

Entry Position
Target P&L = ₹2,000

The target condition is evaluated against the configured P&L metric.

Possible P&L scope must be explicit:

NET_PNL
REALIZED_PNL
UNREALIZED_PNL

For an open position target, the practical trigger is normally the live position's relevant unrealized/net P&L.

The selected metric must be stored with the target so that a later configuration change does not silently alter historical behavior.

8. Target Registration

Target must be registered against the actual executed position, not merely the requested order.

Example:

Requested:
100 RELIANCE

Broker execution:
60 filled

Position:
60 RELIANCE

Target Engine:
Target applies to 60 executed quantity

If the remaining 40 are later filled, Target Engine must reconcile the target according to the configured target-quantity policy.

9. Partial Fill Policy

Partial fills require explicit behavior.

Possible policies:

ARM_ON_FIRST_FILL
ARM_ON_FULL_FILL
ARM_PROPORTIONAL_TO_EXECUTED

Recommended default:

ARM_ON_FIRST_FILL

because an actual position already exists and can incur P&L.

Example:

Requested = 100
Filled = 40

Target Engine:
Position target active for 40

When additional fills occur:

40 → 60 → 100

the target is recalculated/reconciled according to its stored policy.

10. Target State Machine

Recommended:

CREATED
   ↓
WAITING_FOR_EXECUTION
   ↓
ARMED
   ↓
MONITORING
   ↓
TRIGGERED
   ↓
EXIT_REQUESTED
   ↓
EXIT_SUBMITTED
   ↓
EXIT_PARTIAL
   ↓
CLOSED

Alternative terminal states:

CANCELLED
EXPIRED
FAILED
DISABLED

Important:

TARGET_REACHED

does NOT mean:

POSITION_CLOSED

The target is reached first; the exit order must still execute and be verified.

11. Trigger Flow

Live Position/P&L Update
          ↓
Target Engine
          ↓
Load Active Targets
          ↓
Evaluate Target
          ↓
Condition Met?
       /       \
     NO         YES
     |           ↓
 continue     Atomic Trigger
 monitoring       ↓
             Create Exit Request
                    ↓
                Order Engine

12. Trigger Condition

For a positive target:

NET_PNL >= TARGET_VALUE

Example:

Target = ₹2,000
Current P&L = ₹1,950
→ NOT TRIGGERED

Current P&L = ₹2,000
→ TRIGGERED

Current P&L = ₹2,050
→ already TRIGGERED

The target should trigger only once for the same active target instance.

13. Negative Target / Loss Protection

The architecture may support a negative threshold:

Target P&L = -₹1,000

Condition:

NET_PNL <= -₹1,000

This can provide a target-like loss exit.

However, it must be explicitly labeled in UI as a loss/stop target so the user does not confuse it with a profit target.

14. Trigger Deduplication

A target can receive many ticks:

₹2,000
₹2,010
₹2,025
₹2,040

Only one trigger is allowed.

Use an atomic state transition:

MONITORING → TRIGGERED

Only one process may successfully perform that transition.

Other concurrent evaluations must observe:

TRIGGERED

and do nothing.

15. Exit Order Generation

When target triggers:

Long Position
    ↓
SELL exit

Short Position
    ↓
BUY exit

Target Engine creates an internal exit request containing:

target_id
position_id
symbol
token
side
exit_side
exit_quantity
exit_reason = TARGET_PNL_REACHED
source = TARGET_ENGINE
correlation_id

Then:

Target Engine → Order Engine

16. Exit Quantity

Exit quantity must be based on actual open position, not original requested order quantity.

Example:

Entry requested = 100
Entry filled = 60
Current open position = 60

Target trigger
→ exit quantity = 60

If only 25 remain open:

Exit quantity = 25

This prevents over-execution.

17. Race Condition Protection

Critical scenario:

Target triggers
      +
Manual squareoff occurs
      +
Squareoff Engine triggers

Both may attempt to close the same position.

Target Engine must re-check current open position immediately before creating the exit request.

Possible result:

Open position = 0
→ no exit order

If:

Open position = 20

only 20 should be requested for exit.

Order Engine should also verify current order/position state before submission where appropriate.

18. Target vs Global Squareoff

These are different mechanisms.

Target Engine

Position-specific:

Target P&L reached
→ close that position

Squareoff Engine

Session/end-of-day policy:

Configured squareoff time
→ close eligible open positions

Target Engine must not replace Squareoff Engine.

19. Target vs Risk Engine

Target Engine requests an exit.

Risk Engine remains the policy authority for whether the exit request can proceed under the project's risk/trading rules.

However, risk architecture must explicitly permit position-reduction/squareoff operations where normal new-entry restrictions should not block necessary closure.

Target-triggered exit should be classified:

action = POSITION_REDUCTION
reason = TARGET_PNL_REACHED

not:

NEW_ENTRY

20. Target Exit Through Order Engine

The exit path is:

Target Engine
      ↓
Exit Request
      ↓
Order Engine
      ↓
Risk / Safety Checks
      ↓
Broker Adapter
      ↓
Broker
      ↓
Exit Execution
      ↓
Order Engine
      ↓
Target Engine
      ↓
Closed / Partial / Failed

Target Engine never bypasses Order Engine.

21. Exit Failure

Example:

Target reached
↓
Exit request
↓
Broker rejected

Target state must become something like:

EXIT_FAILED

while position state remains:

OPEN

The engine must NOT report:

Position Closed

until broker execution/reconciliation confirms it.

22. Exit Retry

Retry must be policy-controlled.

Safe flow:

EXIT_FAILED
   ↓
Re-read open position
   ↓
Position still open?
   ├── NO → CLOSED
   └── YES
         ↓
     Retry policy
         ↓
     Order Engine

Never repeatedly submit identical exit orders without checking current position state.

23. Partial Exit

Example:

Open = 100
Target triggered
Exit order = 100

Broker fills = 60
Remaining = 40

Target state:

EXIT_PARTIAL

Position remains open.

Engine must continue reconciliation until:

Remaining = 0

or policy moves it into an explicit failure/escalation state.

24. Target Modification

Before trigger:

₹2,000 → ₹2,500

allowed if user permissions and policy permit.

After:

TRIGGERED

target modification should normally be prohibited or require an explicit recovery/admin workflow.

This prevents a triggered exit from being silently moved away.

25. Target Cancellation

Before trigger:

ARMED → CANCELLED

After exit submission:

EXIT_REQUESTED / EXIT_SUBMITTED

cannot be treated as simply cancelled.

The actual broker order must be managed through Order Engine.

26. Target Recovery

After application restart:

Load active targets
       ↓
Load current broker position state
       ↓
Load current P&L
       ↓
Reconcile
       ↓
Restore MONITORING

If target was triggered before restart:

TRIGGERED / EXIT_REQUESTED

must resume reconciliation rather than create a duplicate exit.

27. UI — Order Ticket

Manual and AI-supported order UI should contain:

Target P&L
[ ] Enable Target

Target Amount
₹ [________]

Target Type
[Profit Target ▼]

P&L Metric
[Net P&L ▼]

Optional advanced section:

Target Scope
[Executed Position]

Partial Fill Policy
[Arm on First Fill]

On Target
[Square Off Position]

28. UI — Target Status

After order execution:

RELIANCE
BUY 60 Qty

Entry: ₹1,450
Current: ₹1,472

Current P&L: +₹1,320
Target: +₹2,000

Progress: 66%

Status: MONITORING

Progress must be calculated from real backend data.

No fake/static P&L.

29. Target Triggered UI

RELIANCE

Target P&L Reached
Target: ₹2,000
Actual: ₹2,018

Exit:
60 Qty SELL

Status:
EXIT SUBMITTED

Then update:

FILLED

only after broker confirmation.

30. Target Dashboard

Recommended page:

Target Engine
├── Overview
├── Active Targets
├── Triggered Targets
├── Completed
├── Failed
├── Cancelled
└── Settings

Overview:

Active Targets
Triggered Today
Completed
Failed
Open Target Positions

31. Active Target Table

Columns:

Symbol
Side
Quantity
Entry
Current Price
Current P&L
Target P&L
Progress
Broker
Source
Status
Last Update
Action

Actions:

View
Modify
Cancel

Modification/cancellation availability must depend on state.

32. Target Detail Drawer

Sections:

Position

symbol

side

executed quantity

open quantity

entry price

current price

Target

target value

P&L metric

trigger mode

target status

Exit

exit requested quantity

submitted quantity

executed quantity

remaining quantity

exit status

Trace

order ID

exit order ID

target ID

correlation ID

audit event

33. Target History

Filters:

date

symbol

broker

source

status

target type

triggered/completed

basket ID

History should preserve:

Target configured
→ Position filled
→ Monitoring
→ Target reached
→ Exit requested
→ Exit submitted
→ Exit filled

34. Basket Integration

If a basket contains target configurations:

Basket
 ├── Order A → Target ₹1000
 ├── Order B → Target ₹1500
 ├── Order C → No Target

Each executed child order can have its own target.

Target IDs remain independent.

Basket completion must not automatically mean all targets are completed.

35. AI Integration

AI may specify:

Target P&L = ₹2,000

Order Engine preserves this configuration.

After execution:

Order Engine
→ Target Engine

AI does not directly trigger the broker exit.

Target Engine controls the target lifecycle.

36. Notification Integration

Target Engine should publish meaningful events:

TARGET_CREATED
TARGET_ARMED
TARGET_MODIFIED
TARGET_CANCELLED
TARGET_REACHED
EXIT_REQUESTED
EXIT_SUBMITTED
EXIT_PARTIAL
EXIT_FILLED
EXIT_FAILED
TARGET_RECOVERY

Examples:

Target P&L reached
RELIANCE +₹2,015
Exit order submitted

or:

Target reached but exit failed
RELIANCE
Position still open: 40 Qty

37. Audit Integration

Audit important events:

target creation

target modification

target cancellation

target trigger

exit request

exit submission

exit rejection

partial exit

target completion

recovery

configuration change

Every target lifecycle should be traceable through correlation ID.

38. Real-Time Data Flow

Broker / Position State
        ↓
P&L State
        ↓
Target Engine
        ↓
Trigger Evaluation
        ↓
Order Engine
        ↓
Broker
        ↓
Execution Result
        ↓
Target Engine
        ↓
Connection Manager
        ↓
Frontend

Frontend must not independently calculate the authoritative trigger.

UI may display progress, but backend Target Engine is authoritative for trigger decisions.

39. Event Frequency

Target monitoring should be responsive to live market updates.

However, it must not create uncontrolled CPU load.

Recommended:

Market/P&L event
      ↓
Evaluate only affected active targets

Do not scan every target for every unrelated symbol tick.

40. Data Model

Conceptual target record:

target_id
order_id
basket_id
position_id

source
broker
terminal_id

symbol
token
side

target_type
target_value
pnl_metric

quantity_scope
partial_fill_policy

status

current_pnl
last_evaluated_at

triggered_at
exit_order_id
exit_requested_quantity
exit_executed_quantity
exit_remaining_quantity

created_at
updated_at

correlation_id
configuration_version
metadata

41. Security

Target configuration changes are trading-impacting actions.

Requirements:

authenticated user

authorization

audit target changes

prevent unauthorized target cancellation

protect broker/account metadata

do not expose credentials

confirmation for dangerous changes where appropriate

AI-generated targets must identify their source.

42. Performance

Target Engine should:

maintain an active-target index by symbol/position

evaluate only affected targets

avoid full-table scans on every tick

use atomic state transitions

keep active state bounded

persist lifecycle changes

recover after restart

Example index:

symbol → active target IDs
position_id → target ID
order_id → target ID

43. Failure Isolation

If Target Engine is temporarily unavailable:

existing broker positions remain real

Order Engine remains authoritative for orders

no position should be falsely marked closed

recovery must reconcile active targets

safety-critical target monitoring availability should be visible to the user

The system must make the monitoring state explicit rather than pretending targets are active when they are not being evaluated.

44. Observability

Metrics:

active_targets
targets_triggered
targets_completed
targets_failed
target_trigger_latency
exit_submission_latency
exit_failure_count
partial_exit_count
duplicate_trigger_prevented
recovery_count
stale_target_count

Logs:

target_id
position_id
order_id
exit_order_id
symbol
broker
event_type
current_pnl
target_value
status
correlation_id

45. Testing

Unit

target comparison

positive target

negative target

P&L metric selection

partial fill handling

state transitions

duplicate trigger prevention

exit quantity calculation

target modification

target cancellation

Integration

Order → Target registration

Fill → Target activation

P&L → Target trigger

Target → Order Engine exit

Exit → Target completion

Target → Notification

Target → Audit

Failure

broker rejection

timeout

partial exit

duplicate ticks

simultaneous manual squareoff

global squareoff race

application restart

stale P&L

broker disconnection

46. Acceptance Criteria

Target Engine is complete when:

manual orders can configure Target P&L

AI orders can configure Target P&L

target is registered only against actual executed position

partial fills are handled correctly

active targets monitor authoritative live P&L

target trigger is atomic and idempotent

target trigger creates an opposite-side exit request

exit goes through Order Engine

Target Engine never directly submits to broker

exit quantity equals current open position

broker rejection does not mark position closed

partial exits remain open until reconciled

duplicate target triggers are prevented

target modification/cancellation is state-aware

restart recovery works

target and exit lifecycle are persisted

UI receives realtime state

notifications are generated

audit trace exists

target state is never falsely reported as closed

target monitoring health is observable

47. Final Engine Definition

Target Engine = Target P&L Monitoring + Trigger Detection + Position-Specific Exit Orchestration.

Final flow:

MANUAL / AI ORDER
       ↓
ORDER ENGINE
       ↓
BROKER
       ↓
EXECUTED POSITION
       ↓
TARGET ENGINE
       ↓
LIVE P&L MONITORING
       ↓
TARGET REACHED
       ↓
RE-CHECK OPEN POSITION
       ↓
CREATE EXIT REQUEST
       ↓
ORDER ENGINE
       ↓
RISK / SAFETY
       ↓
BROKER
       ↓
EXIT RESULT
       ↓
TARGET ENGINE RECONCILIATION
       ↓
CLOSED / PARTIAL / FAILED
       ↓
SYSTEM + UI + AUDIT + NOTIFICATION

The Target Engine therefore does not become a second Order Engine or a second Squareoff Engine.

It is the automatic position-target trigger layer, while Order Engine remains the single execution authority and Squareoff Engine remains responsible for scheduled/global squareoff.