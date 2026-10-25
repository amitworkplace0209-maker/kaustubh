Squareoff Engine — Detailed UI + Engine Flow Design

1. Purpose

Squareoff Engine is the end-of-trading safety and position-closure engine.

Its job is to:

freeze new trading activity before squareoff;

cancel pending orders;

fetch the latest broker-side open positions;

close remaining eligible open positions using MARKET exit orders;

verify fills and remaining quantity;

retry safely every 15 seconds when positions remain or an order attempt fails;

finish only after broker-side positions are verified closed, or enter SQUAREOFF_INCOMPLETE after the configured retry/deadline limit.

Squareoff is source-independent: positions created by AI trading and manual trading are handled by the same squareoff process.

2. Core Rules

Default Schedule

Default Squareoff Time: 15:16 IST

Default Trading Freeze: 15:15 IST

Default Retry Interval: 15 seconds

All timings must be configurable from Service Phase / Settings UI.

Important Safety Rule

A retry must NOT blindly place the same order again.

Every retry follows:

Cancel pending squareoff order -> broker position re-check -> calculate remaining quantity -> place fresh MARKET exit order -> wait 15 sec -> verify again

This prevents duplicate exits and accidental reverse positions.

3. Responsibility Boundary

Squareoff Engine owns

squareoff scheduling/state;

trading freeze coordination;

pending-order cancellation during squareoff;

broker-side position discovery;

squareoff position selection;

exit-side calculation;

remaining-quantity calculation;

MARKET exit order creation;

retry loop;

order/position verification;

idempotency and duplicate-order protection;

squareoff completion/incomplete state;

squareoff audit events;

final reconciliation.

Squareoff Engine does NOT own

broker login/session creation;

WebSocket market-data ownership;

normal order execution;

normal risk policy;

P&L calculation;

position master ownership;

AI signal generation;

manual trading UI;

frontend WebSocket transport.

It delegates normal execution to Order Engine where the existing architecture requires it, while retaining ownership of the squareoff workflow/state.

4. High-Level Architecture

Scheduler Engine
       |
       | squareoff lifecycle signal
       v
Squareoff Engine
       |
       +--> Trading Freeze
       |
       +--> Cancel Pending Orders
       |
       +--> Broker / Order Engine
       |       |
       |       +--> order status
       |       +--> cancel
       |       +--> MARKET exit
       |
       +--> Broker Position State
       |
       +--> Verification / Retry State Machine
       |
       +--> Audit Engine
       |
       +--> Notification Engine
       |
       v
Connection Manager
       |
       v
Service Phase UI

5. Daily Lifecycle

T-1 Minute — Trading Freeze

At the configured freeze time (default 15:15):

TRADING_FREEZE

The system must block:

AI order creation;

manual new orders;

new basket orders;

new AI capital allocations;

new trading suggestions that can execute;

trading-related actions that could create fresh exposure.

Do NOT kill every backend engine.

Keep alive as required:

Scheduler Engine;

Session Manager;

Squareoff Engine;

Audit Engine;

DB Writer / Storage;

Connection Manager;

Notification Engine.

These engines may be needed to drain, reconcile, report, and complete squareoff safely.

6. Squareoff State Machine

IDLE
  |
  v
PRE_SQUAREOFF
  |
  v
TRADING_FROZEN
  |
  v
CANCEL_PENDING
  |
  v
CHECK_POSITIONS
  |
  +---- qty = 0 ----------------------+
  |                                   |
  +---- qty > 0                       |
          |                           |
          v                           |
     CHECK_EXISTING_EXIT              |
          |                           |
          v                           |
     CANCEL_PENDING_EXIT              |
          |                           |
          v                           |
     RECHECK_POSITION                 |
          |                           |
          v                           |
     CALCULATE_REMAINING_QTY           |
          |                           |
          v                           |
     PLACE_MARKET_EXIT                |
          |                           |
          v                           |
     WAIT_15_SECONDS                  |
          |                           |
          v                           |
     VERIFY_BROKER_POSITION ----------+
          |
          +---- qty > 0 -> retry
          |
          +---- qty = 0 -> COMPLETE
          |
          +---- deadline reached -> INCOMPLETE

7. Pending Order Handling

At squareoff start:

Fetch all pending/open orders from broker.

Cancel them.

Re-fetch order status.

Account for any order that filled while cancellation was in progress.

Re-fetch positions.

Never assume cancellation succeeded solely from the cancel API response.

Cancel Race

Example:

Position = +100
Pending BUY order = 50

Cancel BUY
   |
   +--> broker fills 50 before cancellation completes
   |
Re-fetch orders + positions
   |
Position may now = +150

The next squareoff quantity must come from the fresh broker state, not the old local quantity.

8. Position Closure Logic

For every eligible open position:

if net_quantity > 0:
    exit_side = SELL

if net_quantity < 0:
    exit_side = BUY

if net_quantity == 0:
    no exit order

Exit quantity:

remaining_qty = abs(fresh_broker_net_quantity)

The engine must calculate this from the latest verified broker position.

9. 15-Second Retry Logic

The retry loop is mandatory for incomplete closure.

Example:

15:16:00
  -> cancel pending
  -> position = +100
  -> SELL 100 MARKET

15:16:15
  -> fetch order status
  -> fetch broker position
  -> position = +40
  -> cancel any remaining pending squareoff order
  -> SELL 40 MARKET

15:16:30
  -> verify
  -> position = 0
  -> COMPLETE

If an order completely failed:

15:16:00 -> SELL 100 -> rejected
15:16:15 -> verify position = +100
          -> fresh SELL 100 MARKET

The new order is based on verified remaining quantity.

10. Duplicate Order Protection

Before placing a fresh exit order, the engine must establish:

whether a previous squareoff order is still pending;

whether it was filled;

whether it was partially filled;

whether it was rejected/cancelled;

the latest broker position.

Never place a new exit for quantity already covered by a still-live order.

Use a unique squareoff run ID:

SQO-YYYYMMDD-<unique-id>

Each exit attempt gets its own attempt ID:

SQO-...-ATTEMPT-001
SQO-...-ATTEMPT-002

This makes retries auditable and prevents local duplicate attempts.

11. Partial Fill Handling

Example:

Required exit = 100

MARKET SELL 100
       |
       +--> filled = 65
       +--> remaining = 35

At the next verification cycle:

fresh broker position -> 35

new exit quantity = 35

Never submit another 100 just because the original order was for 100.

12. Completion Conditions

Squareoff is COMPLETE only when:

pending orders are handled;

eligible open position quantity is zero;

broker-side verification confirms zero;

final reconciliation is recorded.

No open position:

position = 0

The squareoff process still runs, but it places no squareoff order.

UI should show:

No open positions — nothing to close

13. Failure / Incomplete State

If positions remain after the configured maximum retry duration/deadline:

SQUAREOFF_INCOMPLETE

Store:

symbol;

remaining quantity;

side;

last order ID;

last order status;

last error;

retry count;

last verification timestamp.

Trigger a high-priority notification.

Do not silently mark the day complete.

14. Position Scope

The engine must have an explicit configurable position scope.

Recommended default:

Intraday / MIS positions only

Delivery/long-term holdings must not be closed accidentally.

The UI must make the scope visible.

If broker/product semantics differ, use broker-supported product/type identifiers rather than relying only on UI labels.

15. UI — Service Phase

Squareoff Card

┌──────────────────────────────────────────────┐
│ SQUAREOFF ENGINE                             │
│                                              │
│ Automatic Squareoff       [ ON ]             │
│ Squareoff Time            [ 15:16 ]          │
│ Freeze Before             [ 1 min ]          │
│ Retry Interval            [ 15 sec ]         │
│ Max Retry Duration        [ configurable ]   │
│ Position Scope            [ Intraday ]       │
│                                              │
│ Status: PRE-SQUAREOFF                        │
│                                              │
│ Pending Orders              3                 │
│ Open Positions              5                 │
│ Positions To Close          5                 │
│                                              │
│ [ RUN SQUAREOFF NOW ]                        │
└──────────────────────────────────────────────┘

No fake financial values. All counts/statuses come from the backend.

16. UI Statuses

Recommended statuses:

IDLE

SCHEDULED

PRE_SQUAREOFF

TRADING_FROZEN

CANCEL_PENDING

CHECKING_POSITIONS

PLACING_EXIT

WAITING_RETRY

VERIFYING

COMPLETE

NO_POSITIONS

SQUAREOFF_INCOMPLETE

ERROR

Use explicit status text rather than ambiguous colors alone.

17. Live Progress Panel

During an active run:

Squareoff Run: SQO-20260919-ABC123

Status              VERIFYING
Started              15:16:00
Last Check           15:16:30
Next Retry           15:16:45

Pending Orders       0
Open Positions       1
Remaining Qty        40
Retry Count          2

Last Order
Symbol              ABC
Side                SELL
Requested Qty       40
Filled Qty          40
Status              COMPLETE

For multiple positions, show a compact table:

Symbol

Net Qty

Exit Side

Last Exit Qty

Filled

Status

Retry

ABC

0

SELL

100

100

CLOSED

0

XYZ

40

SELL

40

0

RETRYING

2

Values must be live backend state.

18. Last Run Summary

After completion:

LAST SQUAREOFF

Result: COMPLETE

Pending Orders Cancelled     3
Positions Found               5
Positions Closed              5
Exit Attempts                 7
Retries                       2
Started                       15:16:00
Completed                     15:16:47

If incomplete:

Result: SQUAREOFF_INCOMPLETE

Positions Remaining: 1
Symbol: XYZ
Remaining Qty: 40
Last Error: <broker error>

19. Configuration UI

Settings should expose:

Automatic Squareoff        ON/OFF
Squareoff Time             15:16
Freeze Before               1 min
Retry Interval              15 sec
Maximum Retry Duration      configurable
Cancel Pending Orders       ON
Exit Order Type             MARKET
Position Scope              Intraday
Emergency Manual Run        enabled/disabled

Dangerous settings require explicit confirmation before saving.

20. RUN SQUAREOFF NOW

A manual emergency action can trigger the same engine workflow immediately.

It should require strong confirmation:

RUN SQUAREOFF NOW?

This will:
- freeze new trading;
- cancel pending orders;
- place MARKET orders for eligible open positions;
- retry incomplete exits according to policy.

[ CANCEL ] [ CONFIRM SQUAREOFF ]

This action must be audited.

21. Backend -> UI Events

Conceptual events:

SQUAREOFF_SCHEDULED
TRADING_FREEZE_STARTED
SQUAREOFF_STARTED
PENDING_ORDERS_CANCEL_STARTED
PENDING_ORDERS_CANCELLED
POSITIONS_CHECKED
EXIT_ORDER_PLACED
EXIT_ORDER_FILLED
EXIT_ORDER_PARTIAL
EXIT_ORDER_REJECTED
SQUAREOFF_RETRYING
SQUAREOFF_COMPLETED
SQUAREOFF_NO_POSITIONS
SQUAREOFF_INCOMPLETE
SQUAREOFF_ERROR

Connection Manager delivers these to the frontend.

Squareoff Engine should not own frontend WebSocket transport.

22. Data Model

A squareoff run should persist at least:

run_id
trading_date
started_at
freeze_at
scheduled_at
completed_at
status

position_scope
retry_interval
max_retry_duration
retry_count

pending_orders_found
pending_orders_cancelled

positions_found
positions_closed
positions_remaining

attempts[]

errors[]
last_error

created_at
updated_at

Each attempt:

attempt_id
run_id
symbol
token
product
side
requested_qty
filled_qty
remaining_qty
broker_order_id
status
placed_at
updated_at
error

23. Audit Requirements

Every important action must be auditable:

freeze started
pending orders discovered
cancel requested
cancel result
position snapshot
exit order submitted
order status changed
partial fill
retry
final verification
completion/incomplete
manual squareoff trigger

Never overwrite history to make the final state look clean.

24. Error Handling

Important error classes:

Broker timeout

Do not assume order failed.

Action:

timeout
 -> fetch order status
 -> fetch position
 -> decide next action

Order rejected

rejection
 -> record error
 -> verify position
 -> retry if policy allows

Cancel failed

cancel failure
 -> re-fetch order
 -> if still pending, retry cancellation
 -> verify position

Position API failure

Do not place a blind new exit order.

cannot verify position
 -> DO NOT DUPLICATE EXIT
 -> retry verification

WebSocket unavailable

Squareoff must not depend on WebSocket ticks to know whether the position is closed.

Use authoritative broker/API position state for squareoff verification.

25. Trading Freeze Coordination

The freeze must be centrally recognized by trading paths.

At freeze:

Trading Gate = CLOSED

Order Engine, Basket Engine, AI allocation/execution path and manual order APIs must reject new trading requests with an explicit reason such as:

TRADING_FROZEN_FOR_SQUAREOFF

Existing squareoff operations remain permitted.

26. Scheduler Integration

Scheduler Engine determines the configured daily time.

Conceptually:

Scheduler
   |
   +--> freeze event at T-1
   |
   +--> squareoff event at T

The exact scheduling source remains Scheduler Engine; Squareoff Engine owns the squareoff state machine.

Timezone:

Asia/Kolkata

Trading-day logic must avoid executing the daily schedule on non-trading days.

27. Position Source of Truth

For squareoff safety:

Broker-side position state is authoritative for final verification.

Local Position Engine state can be used for display/context, but must not be the sole source for deciding whether another exit order is required.

This is critical for:

fills occurring outside the local update timing;

partial fills;

cancel/fill races;

reconnects;

stale caches.

28. Performance / Concurrency

The engine must prevent two squareoff workers from operating on the same trading day simultaneously.

Use a single active run lock:

trading_date -> active_squareoff_run_id

If a duplicate scheduler event arrives:

existing active run -> ignore duplicate start

Position processing should be deterministic and idempotent.

29. Security

Squareoff configuration requires authenticated Service Phase access.

Manual RUN SQUAREOFF NOW requires explicit confirmation.

All configuration changes are audited.

Broker credentials/tokens never go to the frontend.

UI receives sanitized order/position information.

No secrets in logs.

30. Observability

Metrics:

squareoff_runs_total
squareoff_completed_total
squareoff_incomplete_total
squareoff_retry_total
squareoff_orders_cancelled_total
squareoff_exit_orders_total
squareoff_partial_fill_total
squareoff_rejection_total
squareoff_duration_seconds
squareoff_remaining_positions

Useful logs:

[SQUAREOFF] freeze started
[SQUAREOFF] run started
[SQUAREOFF] cancelling pending orders
[SQUAREOFF] broker position snapshot
[SQUAREOFF] exit attempt
[SQUAREOFF] partial fill
[SQUAREOFF] retry scheduled
[SQUAREOFF] final verification
[SQUAREOFF] complete
[SQUAREOFF] incomplete

31. Testing Requirements

Unit Tests

positive quantity -> SELL;

negative quantity -> BUY;

zero quantity -> no order;

partial fill -> remaining quantity only;

rejected order -> retry;

cancel race -> fresh position wins;

stale local position -> broker state wins;

duplicate scheduler event -> one active run;

pending order cancellation;

maximum retry deadline;

no-position squareoff;

manual squareoff trigger;

trading freeze blocks new orders.

Integration Tests

Test:

freeze -> cancel -> position fetch -> market exit -> partial fill
-> 15 sec retry -> final position zero -> complete

And failure path:

freeze -> cancel -> exit rejected
-> retry -> still rejected
-> deadline -> SQUAREOFF_INCOMPLETE

32. End-to-End Example

Assume:

Squareoff = 15:16
Freeze = 15:15
Retry = 15 sec

At 15:15:

TRADING_FROZEN

At 15:16:

Cancel pending orders
Fetch positions

Broker reports:

RELIANCE +100
INFY     -50
TCS       0

Orders:

RELIANCE SELL 100 MARKET
INFY     BUY   50 MARKET

At 15:16:15:

RELIANCE = +20
INFY     = 0

Engine places only:

RELIANCE SELL 20 MARKET

At 15:16:30:

RELIANCE = 0
INFY = 0
TCS = 0

Result:

SQUAREOFF_COMPLETE

No duplicate order is created for already-closed quantities.

33. Non-Goals

Squareoff Engine does not:

generate trading signals;

decide whether a trade was good/bad;

calculate normal P&L;

manage the broker WebSocket;

discover the Market Watch universe;

allocate capital for AI suggestions;

replace Risk Engine;

replace Order Engine;

manually decide which positions are profitable.

Its purpose is operational closure and end-of-day exposure removal according to configured policy.

34. Implementation Order

Recommended implementation sequence:

Define Squareoff state machine.

Define trading-freeze contract.

Define broker order/position verification contract.

Implement pending-order cancellation + verification.

Implement position snapshot and eligibility filtering.

Implement safe exit-order placement.

Implement 15-second retry loop.

Implement partial-fill handling.

Implement duplicate-order protection/idempotency.

Implement completion/incomplete states.

Persist run/attempt/audit records.

Expose backend status/events to Connection Manager.

Build Service Phase UI.

Add Scheduler integration.

Add unit/integration/failure tests.

Add observability and operational alerts.

35. Acceptance Criteria

The implementation is acceptable only when:

Default squareoff is 15:16 IST.

Default freeze is 1 minute before squareoff.

Time and retry configuration are changeable from UI.

New trading is blocked during freeze.

Pending orders are cancelled and cancellation is verified.

Broker positions are re-fetched before every new exit attempt.

Market exit side is derived from current net quantity.

Partial fills result in orders only for remaining quantity.

Retry interval defaults to 15 seconds.

No blind duplicate exit order can be created.

Zero positions produce no squareoff order.

AI and manual positions are treated identically by squareoff.

Broker state is authoritative for final closure.

Retry deadline produces SQUAREOFF_INCOMPLETE rather than silent success.

Every attempt and important state transition is auditable.

UI shows real backend status/counts, not fake values.

Duplicate scheduler events cannot create concurrent squareoff runs.

36. Final Principle

Squareoff Engine = Trading Freeze + Pending Order Cancellation + Broker-Verified Position Closure + Safe 15-Second Retry + Final Reconciliation.

The critical rule is:

Never retry using the old quantity. Re-check broker state first, calculate the remaining exposure, and place a fresh MARKET exit only for the verified remaining quantity.