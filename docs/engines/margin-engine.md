MARGIN ENGINE — DETAILED UI + BACKEND + EVENT ARCHITECTURE

1. Purpose

Margin Engine is the KDS AI/Automated Trading Capital Allocation Engine. Its job is not merely to display how much margin one stock needs. It controls how much available capital an AI order may consume, according to configurable per-order allocation rules, then calculates quantity capacity and manages reservations.

Manual orders bypass Margin Engine's AI allocation policy.

2. Core Rule — AI Only

Manual

USER → ORDER UI → ORDER ENGINE → RISK ENGINE → BROKER

Manual orders:

do not consume AI allocation slots

do not use AI allocation percentages

do not create AI reservations

AI

AI MODEL
 → TRADE SUGGESTION
 → MARGIN ENGINE
 → CAPITAL ALLOCATION
 → QUANTITY CAPACITY
 → RISK ENGINE
 → ORDER ENGINE
 → BROKER

AI must pass through Margin Engine before proceeding to the normal Risk → Order execution path.

3. Responsibility

Margin Engine owns:

AI capital allocation policy

order-slot percentages

allocatable-capital calculation

capital reservation

reservation lifecycle

quantity capacity

AI allocation/release events

allocation configuration

reconciliation of AI allocation state

Margin Engine does NOT own:

AI stock selection

trade-signal generation

manual-order allocation

final risk validation

broker order execution

broker login

broker WebSocket

positions/P&L ownership

4. Capital Allocation Principle

Never automatically allocate 100% of available balance to one stock.

Example:

Available Balance = ₹1,00,000

AI policy:
Order #1 = 20%
Order #2 = 15%
Order #3 = 10%
Order #4 = 10%

Slot #1 allocation ceiling:

₹1,00,000 × 20% = ₹20,000

Slot #2:

₹1,00,000 × 15% = ₹15,000

The percentage is a capital ceiling, not an unconditional order approval. Current broker/account state, reservations, margin, product constraints and Risk Engine rules still apply.

5. Service Phase UI

Margin Engine must have a real KDS Service Phase page.

Capital Overview

Show actual backend state:

Broker Available Balance

AI Allocatable Capital

AI Reserved Capital

AI Committed Capital

AI Free Capacity

AI Allocation Policy

Editable:

Order #1   [20 %]
Order #2   [15 %]
Order #3   [10 %]
Order #4   [10 %]
[+ Add Order Slot]

Show:

total configured %

AI allocation ON/OFF

active slots

last updated

Active Reservations

Columns:

Slot

Symbol

Side

Suggested Price

Allocated Capital

Margin / Qty

Max Qty

Reservation ID

Status

Created At

Allocation History

Show:

completed

released

rejected

cancelled

expired

The UI must use real backend data. No hard-coded balance, fake reservation, fake AI order or random market values.

6. Configuration Rules

Persist:

AI allocation enabled

slot percentages

maximum slots

reserve/buffer policy

reservation timeout

slot reuse policy

cancellation/rejection behavior

configuration version

updated timestamp

updated by

Validation:

0 <= percentage <= 100
SUM(slot percentages) <= policy maximum

For a simple full-session model:

SUM(slot percentages) <= 100%

Frontend validation is not sufficient; backend must validate again.

7. Order Slot

Example:

AI Suggestion A → Slot #1
AI Suggestion B → Slot #2
AI Suggestion C → Slot #3

Lifecycle:

AVAILABLE
 → RESERVED
 → ORDER SUBMITTED
 → FILLED / PARTIALLY FILLED / REJECTED / CANCELLED
 → SETTLED / RELEASED

Slot reuse must follow the configured policy.

8. Available Capital

Track separately:

Broker Available Balance
AI Allocation Capacity
AI Reserved Capital
AI Committed Capital
AI Free Allocatable Capacity

Manual orders do not consume AI slots, but their real impact on the broker/account balance must be reflected in future AI capacity calculations.

9. Reservation

An approved AI allocation creates a reservation.

Conceptual:

{
  "reservationId": "RES-...",
  "source": "AI",
  "orderSlot": 1,
  "symbol": "RELIANCE",
  "requestedPrice": 1420,
  "allocatedCapital": 20000,
  "estimatedMarginPerQty": 250,
  "maxQuantity": 80,
  "status": "RESERVED"
}

Reservation ID must remain traceable through the order lifecycle.

10. Quantity Calculation

Core:

Allocated Capital
÷
Applicable Required Capital / Quantity
=
Maximum Quantity Capacity

Example:

Available = ₹1,00,000
Slot #1 = 20%
Allocation ceiling = ₹20,000
Margin/Qty = ₹250

Maximum Qty = ₹20,000 ÷ ₹250 = 80

This is capacity, not final execution approval.

11. Suggested Price

AI suggestion may contain:

symbol

suggested entry price

side

product

requested quantity

Example:

RELIANCE
Suggested Price = ₹1,420

The applicable margin/required capital must be obtained from the approved broker/margin source. If actual order price or margin changes before execution, allocation must be revalidated.

Do not treat AI's suggested price as guaranteed execution price.

12. Partial Capacity

If AI requests:

200 Qty

but capacity is:

80 Qty

return:

status = PARTIAL_CAPACITY
requestedQuantity = 200
allowedQuantity = 80

Do not silently reduce the AI order unless an explicit policy permits automatic reduction.

13. Multiple AI Suggestions

Example:

Balance = ₹1,00,000
#1 = 20%
#2 = 15%
#3 = 10%

Then:

Suggestion A → #1 → ceiling ₹20,000
Suggestion B → #2 → ceiling ₹15,000
Suggestion C → #3 → ceiling ₹10,000

Allocations must be atomic.

14. Concurrency Protection

Prevent:

AI A reads ₹50k free
AI B reads ₹50k free
A reserves ₹40k
B reserves ₹40k

when only ₹50k is actually available.

Use the project's appropriate atomic database/transaction/locking mechanism so simultaneous requests cannot over-allocate capital.

15. Full Allocation Lifecycle

AI REQUEST
 → validate source
 → identify slot
 → read current capital
 → read policy
 → read required margin
 → calculate ceiling
 → calculate max quantity
 → create reservation
 → return allocation result
 → RISK ENGINE
 → ORDER ENGINE

After order outcome:

FILLED → settle/commit
PARTIAL FILL → adjust reservation
CANCELLED → release
REJECTED → release

16. Manual Isolation

Manual request:

{
  "source": "MANUAL",
  "symbol": "RELIANCE",
  "quantity": 10
}

must not:

consume AI slot

consume AI percentage

create AI reservation

alter AI slot sequence

But manual orders still affect real broker/account capital, so future AI capacity must observe the changed financial state.

17. Source Identification

AI intent:

{
  "source": "AI",
  "suggestionId": "SUG-123",
  "strategyId": "strategy-01",
  "symbol": "RELIANCE"
}

Backend must enforce routing. Do not rely only on a frontend source field to authorize automated trading.

18. AI Integration

Current deterministic flow:

AI Model
 → Trade Suggestion
 → Margin Engine
 → Risk Engine
 → Order Engine

Future model-assisted allocation may recommend an allocation, but hard capital constraints remain deterministic and authoritative:

AI
 → Trade Proposal
 → Allocation Policy
 → optional Allocation Model
 → Hard Capital Constraints
 → Risk Engine
 → Order Engine

Margin Engine does not generate the AI trade signal.

19. Search Integration

Search may display:

1 Qty Margin: ₹250

only from the approved margin/data source.

Search Engine does not invent the value.

AI quantity flow:

AI Suggested Price
 + Applicable Margin
 + AI Allocation %
 → Margin Engine
 → Maximum Quantity

20. Event-Driven Architecture

Potential events, following existing KDS event conventions:

AI_TRADE_SUGGESTION
AI_ALLOCATION_REQUESTED
AI_ALLOCATION_RESERVED
AI_ALLOCATION_REJECTED
AI_ALLOCATION_RELEASED
AI_ORDER_SUBMITTED
AI_ORDER_FILLED
AI_ORDER_PARTIALLY_FILLED
AI_ORDER_CANCELLED
AI_ORDER_REJECTED
BALANCE_UPDATED
MARGIN_UPDATED

Flow:

AI_TRADE_SUGGESTION
 → MARGIN_ALLOCATION_REQUESTED
 → Margin Engine
 → MARGIN_ALLOCATED
 → Risk Engine
 → Order Engine
 → Broker
 → Order Event
 → Margin Engine
 → SETTLE / RELEASE / ADJUST

Use existing EngineEventBus conventions instead of inventing a parallel event system.

21. API — Conceptual

Use existing KDS API conventions and avoid duplicate routes.

GET  /margin-engine/config
PUT  /margin-engine/config
GET  /margin-engine/capital
GET  /margin-engine/reservations
POST /margin-engine/allocate
POST /margin-engine/reservations/{id}/release

Allocation request:

{
  "source": "AI",
  "suggestionId": "SUG-123",
  "symbol": "RELIANCE",
  "token": "<TOKEN>",
  "exchange": "NSE",
  "side": "BUY",
  "product": "MIS",
  "suggestedPrice": 1420,
  "requestedQuantity": 100
}

Response:

{
  "status": "ALLOCATED",
  "reservationId": "RES-123",
  "orderSlot": 1,
  "allocatedCapital": 20000,
  "requiredMarginPerQty": 250,
  "maximumQuantity": 80
}

These are target contracts, not claims about existing routes.

22. Failure States

Handle:

insufficient broker balance

insufficient AI capacity

no slot available

missing/stale margin

invalid configuration

reservation conflict

duplicate request

order rejected

cancelled

partial fill

broker/API unavailable

session unavailable

database failure

engine restart

Never silently allocate above policy.

23. Idempotency

If an AI allocation request times out and is retried, it must not create a second reservation.

Use an appropriate combination of:

suggestionId

order/request ID

idempotency key

24. Restart Recovery

On startup:

Margin Engine
 → load persisted config
 → load active reservations
 → reconcile broker/account state
 → rebuild allocation state

Do not blindly reset reservations on restart.

25. Trading-Day Lifecycle

Start:

load config

reconcile balance

clear expired reservations

initialize state

verify dependencies

During market:

process allocation events

maintain reservations

reconcile fills/cancellations

update capacity

End:

settle/release appropriate reservations

persist final state

prepare next session

Scheduler controls lifecycle timing; Margin Engine does not replace Scheduler or Session Manager.

26. Engine Relationships

Engine

Relationship

Session Manager

broker/session/account state

Margin Engine

AI capital allocation/reservation

Risk Engine

final risk validation

Order Engine

order lifecycle/execution

Audit Engine

allocation/execution audit

Position Engine

position/capital effects

Search Engine

may consume approved margin display data

Watchlist Engine

may display related margin data

Market Watch Engine

may display related capital data

Scheduler

lifecycle orchestration

27. Security

Because this engine controls financial allocation:

backend authorization mandatory

UI cannot bypass allocation

AI cannot directly call broker

allocation requests authenticated

source validated

reservation IDs protected

configuration changes audited

no credentials/secrets in logs

client cannot be authority for capital decisions

28. Observability

Track:

AI allocation requests

success/rejection rate

reserved capital

committed capital

released capital

free AI capacity

slot utilization

reservation age/expiry

duplicate requests

allocation latency

broker reconciliation mismatch

Use request/trace IDs without sensitive data.

29. Testing

Unit

percentage validation

slot selection

capital calculation

quantity calculation

reservation state

release

partial capacity

source routing

manual bypass

idempotency

Integration

AI Suggestion → Margin → Allocation → Risk → Order
Manual → Order

Verify Manual does not invoke AI allocation.

Concurrency

Simultaneous reservations must never over-allocate.

Restart

Persisted configuration/reservations recover correctly.

Failure

Test margin unavailable, broker balance unavailable, DB failure, rejection, cancellation, partial fill, timeout.

UI

Test configuration save/load, capital state, reservations, history, loading, empty, error and stale states.

30. Performance

Support multiple AI suggestions with:

atomic reservations

low-latency allocation

bounded event processing

no unnecessary broker calls

persisted configuration cache where safe

fresh financial state where required

bounded reservation growth

31. Current vs Target

Current project audit identified Margin Engine as an existing registered/on-demand trading engine connected to session/broker infrastructure and used in the existing order/risk path.

Target behavior in this document is more specific:

AI/automated trading only

configurable per-order allocation slots

capital allocation

reservation

quantity capacity

event-driven lifecycle

manual-order bypass

real Service Phase UI

persistent configuration

real account state

AI integration

concurrency protection

restart recovery

tests and observability

Audit current code before changing it. Do not assume target behavior already exists.

32. Implementation Order

Audit current Margin Engine.

Implement capital-state/reconciliation layer.

Implement persistent AI allocation configuration.

Implement slot allocation and quantity capacity.

Implement atomic reservations/release/adjustment.

Integrate AI allocation/order events.

Connect AI → Margin → Risk → Order.

Ensure Manual → Order bypasses AI allocation.

Build/update Service Phase Margin Engine page.

Implement restart/reconciliation/failure recovery.

Add unit/integration/concurrency/UI tests.

Update architecture/inventory/audit documentation after verification.

33. Acceptance Checklist

AI/automated orders use Margin Engine.

Manual orders bypass AI allocation.

Manual capital impact is reflected in future AI capacity.

AI allocation can be enabled/disabled.

Per-order slot percentages are configurable.

Configuration persists.

Backend validates configuration.

Total allocation respects policy.

Slots are deterministic.

Reservations are atomic.

Duplicate AI requests cannot double-reserve.

Suggested price is part of allocation context.

Applicable required margin/capital per quantity is used.

Maximum quantity is calculated.

Execution-time state can trigger revalidation.

Partial fills adjust reservations.

Rejected/cancelled orders release capital.

Restart recovers configuration/reservations.

AI path reaches Risk Engine before Order Engine.

Search can consume approved margin information.

No fake financial data exists in production UI.

Real Margin Engine Service Phase page exists.

Capital overview works.

Allocation configuration works.

Active reservations work.

History works.

Loading/empty/error/stale states work.

Unit/integration/concurrency/UI tests exist.

Documentation matches verified code.

34. Final Principle

MANUAL:
User
 → Order Engine
 → Risk Engine
 → Broker

AI:
AI Model
 → Trade Suggestion
 → Margin Engine
 → Configured Capital Allocation
 → Reservation
 → Quantity Capacity
 → Risk Engine
 → Order Engine
 → Broker

Margin Engine = AI Capital Control Layer.

AI proposes the trade. Margin Engine controls how much capital that AI trade may consume according to the configured policy and current financial state. Risk Engine performs final validation. Order Engine executes.