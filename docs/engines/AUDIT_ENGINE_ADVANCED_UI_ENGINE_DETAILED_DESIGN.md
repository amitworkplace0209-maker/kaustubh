Audit Engine — Advanced UI + Engine Detailed Design

1. Purpose

Audit Engine is the append-only decision and activity trail for the trading platform.

It records important trading, risk, broker, configuration, security, and operational events so that the platform can answer:

What happened?

When did it happen?

Who or what initiated it?

Which engine handled it?

What decision was made?

Why was it allowed, blocked, cancelled, rejected, or completed?

What state existed at the time?

Which configuration/policy version was active?

Which broker/terminal was involved?

What happened before and after the event?

Audit Engine is a record-keeping and traceability layer. It does not execute trades or make risk decisions.

2. Core Principle

Audit data must be:

append-only;

immutable after creation;

timestamped;

source-attributed;

correlation-aware;

queryable;

suitable for incident investigation.

Historical audit records must not be silently rewritten to match current state.

3. Architecture

AI / Manual / Basket / Squareoff / System
                    |
                    v
             Trading Engines
                    |
                    v
              Audit Engine
                    |
          +---------+---------+
          |                   |
          v                   v
      Audit Store       Live Audit Events
          |                   |
          v                   v
      History UI       Connection Manager
                              |
                              v
                             UI

Audit Engine receives events from:

Risk Engine

Order Engine

Position Engine

Squareoff Engine

Margin Engine

Broker Terminal Engine

Scheduler Engine

Session Manager

Notification Engine

configuration/admin actions

4. What Audit Engine Owns

append-only audit records;

event normalization;

correlation IDs;

decision trace storage;

order lifecycle audit;

risk decision audit;

broker operation audit;

configuration-change audit;

authentication/session events;

engine lifecycle events;

squareoff events;

error/failure records;

audit search/filtering;

audit retention policy;

integrity metadata;

audit export where authorized.

5. What Audit Engine Does NOT Own

Audit Engine does not:

place orders;

cancel orders;

approve risk;

calculate P&L;

calculate margin;

manage broker sessions;

manage WebSockets;

close positions;

modify trading configuration itself.

It records what those systems did.

6. Event Classification

Recommended categories:

TRADING
RISK
ORDER
POSITION
BROKER
SESSION
MARKET_DATA
SQUAREOFF
MARGIN
CONFIGURATION
SECURITY
ENGINE
SYSTEM
ERROR
NOTIFICATION

Example:

RISK
  RISK_DECISION

ORDER
  ORDER_SUBMITTED
  ORDER_FILLED
  ORDER_REJECTED

BROKER
  BROKER_CONNECTED
  BROKER_DISCONNECTED
  BROKER_RECONCILIATION_MISMATCH

7. Audit Event Structure

Conceptual event:

audit_id
event_id
correlation_id
parent_event_id

timestamp
event_type
category
severity

source_engine
source_type
actor_type
actor_id

terminal_id
broker
symbol
token
order_id
position_id

action
result

reason_codes[]
message

request_snapshot
decision_snapshot
state_snapshot

policy_version
configuration_version

metadata

created_at

Not every event needs every field.

8. Actor Model

Every event should identify its actor/source.

Possible actor types:

USER
AI
ENGINE
SCHEDULER
BROKER
SYSTEM
ADMIN

Example:

actor_type = AI
source_engine = risk_engine

or:

actor_type = USER
source_engine = order_engine

This is critical for distinguishing manual and automated actions.

9. Correlation and Trace IDs

A single trading action may travel through many engines.

Example:

AI Suggestion
   |
   v
Risk Evaluation
   |
   v
Audit
   |
   v
Order Engine
   |
   v
Broker Terminal
   |
   v
Broker
   |
   v
Position Update

All related events should share:

correlation_id

Example:

TRD-20260919-000182

Individual events can have:

event_id

This allows a complete end-to-end trace.

10. Example End-to-End Audit

09:42:10
AI_SUGGESTION_CREATED

09:42:10
RISK_EVALUATION_STARTED

09:42:10
RISK_RULE_FAILED
DAILY_PNL_LIMIT

09:42:10
RISK_DECISION_BLOCK

09:42:10
ORDER_NOT_EXECUTED

09:42:10
NOTIFICATION_CREATED

The complete chain is visible under one correlation ID.

11. Risk Decision Audit

Risk Engine decisions must preserve:

decision_id
request_id
source
symbol
side
quantity

final_decision

passed_rules[]
warning_rules[]
blocking_rules[]

actual_values
thresholds

market_snapshot
account_snapshot
position_snapshot

policy_version
evaluated_at

Example:

FINAL = BLOCK

Reasons:
- DAILY_PNL_LIMIT
- CIRCUIT_PROXIMITY
- MAX_EXPOSURE

Audit Engine stores the decision; Risk Engine owns the decision logic.

12. Order Lifecycle Audit

Track:

ORDER_REQUESTED
RISK_EVALUATED
ORDER_APPROVED
ORDER_BLOCKED
ORDER_SUBMITTED
BROKER_ACCEPTED
BROKER_REJECTED
PARTIALLY_FILLED
FILLED
CANCEL_REQUESTED
CANCELLED
MODIFY_REQUESTED
MODIFIED
UNKNOWN

The audit trail should preserve transitions rather than only the final order state.

13. Broker Audit

Record:

broker
terminal_id
broker_request_id
broker_order_id
operation
status
latency
error_code
broker_message

Never store secrets.

Do not store raw authentication tokens in audit records.

14. Squareoff Audit

Squareoff events:

SQUAREOFF_SCHEDULED
TRADING_FREEZE_STARTED
PENDING_ORDERS_DISCOVERED
CANCEL_REQUESTED
CANCEL_COMPLETED
POSITIONS_CHECKED
EXIT_ORDER_PLACED
EXIT_PARTIAL_FILL
EXIT_FILLED
SQUAREOFF_RETRY
FINAL_VERIFICATION
SQUAREOFF_COMPLETED
SQUAREOFF_INCOMPLETE

Each retry should reference:

run_id
attempt_id
correlation_id

15. Configuration Audit

Every important setting change should create an audit event.

Examples:

RISK_RULE_CREATED
RISK_RULE_UPDATED
RISK_RULE_DISABLED
RISK_POLICY_ACTIVATED

SQUAREOFF_TIME_CHANGED
TERMINAL_ENABLED
TERMINAL_DISABLED
BROKER_CONFIGURATION_CHANGED
AI_TRADING_CHANGED

Record:

old_value
new_value
changed_by
changed_at
configuration_version
reason

Sensitive secrets must be masked or excluded.

16. Security Audit

Security-related events:

LOGIN
LOGOUT
SESSION_EXPIRED
AUTH_FAILED
PERMISSION_DENIED
ADMIN_ACTION
EMERGENCY_TRADING_LOCK
TRADING_UNLOCK

Repeated permission failures can trigger notifications.

17. Engine Lifecycle Audit

Record important engine lifecycle changes:

ENGINE_STARTED
ENGINE_STOPPED
ENGINE_DEGRADED
ENGINE_RECOVERED
ENGINE_ERROR
ENGINE_RESTART

Useful for diagnosing startup and shutdown issues.

18. Severity

Recommended levels:

DEBUG
INFO
WARNING
ERROR
CRITICAL
SECURITY

Examples:

ORDER_FILLED → INFO
RISK_BLOCK → WARNING
BROKER_DISCONNECTED → ERROR
SQUAREOFF_INCOMPLETE → CRITICAL
UNAUTHORIZED_ADMIN_ACTION → SECURITY

Severity should describe operational importance, not determine business outcome.

19. Immutable Record Principle

Once an audit record is written:

CREATE
  ↓
IMMUTABLE

Corrections should create a new event:

AUDIT_CORRECTION

Do not overwrite the original record.

20. Audit Integrity

Advanced integrity metadata may include:

record_hash
previous_record_hash
sequence_number

Conceptual chain:

Record 001
hash → A

Record 002
previous_hash = A
hash → B

Record 003
previous_hash = B
hash → C

This can make unauthorized historical modification detectable.

Implementation should consider database performance and operational complexity before enabling full cryptographic chaining.

21. Audit Store

Current architecture uses the database as the audit destination.

Recommended logical collection/table:

audit_trail

Indexes should support:

timestamp
correlation_id
event_type
category
source_engine
actor_type
terminal_id
broker
symbol
order_id
severity

Do not create unbounded indexes without measuring query workload.

22. Retention

Retention should be configurable by event category.

Example:

Trading audit       long retention
Risk decisions      long retention
Security events     long retention
Debug events        shorter retention
High-volume market events  separate policy

Audit Engine should not become a raw tick-storage system.

Market ticks belong to the appropriate market-data/storage pipeline.

23. Audit UI — Service Phase

Sidebar:

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
Risk Engine
Broker Terminals
Notifications

Audit
  ├── Overview
  ├── Event Explorer
  ├── Trading Audit
  ├── Risk Decisions
  ├── Order Timeline
  ├── Broker Events
  ├── Configuration Changes
  ├── Security Events
  ├── Engine Events
  └── System Errors

24. Audit Overview UI

┌─────────────────────────────────────────────────┐
│ AUDIT ENGINE                     ● ACTIVE       │
├─────────────────────────────────────────────────┤
│ Events Today          12,482                    │
│ Trading Events        1,280                     │
│ Risk Decisions        940                       │
│ Blocks                115                       │
│ Broker Errors         8                         │
│ Critical Events       2                         │
│                                                 │
│ Latest Event                                    │
│ 09:42:10 RISK_DECISION_BLOCK                   │
│                                                 │
│ [EVENT EXPLORER] [TRADING TRACE] [SECURITY]    │
└─────────────────────────────────────────────────┘

No fake counts.

25. Event Explorer

Filters:

Date / Time
Event Type
Category
Severity
Source Engine
Actor
Broker
Terminal
Symbol
Order ID
Correlation ID
Result

Example:

09:42:10  RISK_DECISION_BLOCK   AI
09:41:58  ORDER_FILLED          MANUAL
09:40:31  POSITION_UPDATED      BROKER
09:39:22  BROKER_RECONNECTED    SYSTEM

26. Event Detail

Click an event:

AUDIT EVENT

Event ID:
EVT-001829

Correlation:
TRD-000182

Time:
09:42:10.482 IST

Category:
RISK

Type:
RISK_DECISION_BLOCK

Actor:
AI

Source:
Risk Engine

Symbol:
XYZ

Decision:
BLOCK

Expandable sections:

Why
Rule Evaluation
Market Snapshot
Account Snapshot
Policy Version
Related Events
Broker Context
Raw Metadata

27. Trading Trace View

The most useful UI feature.

Search:

Correlation ID:
TRD-000182

Timeline:

09:42:10  AI suggestion
    ↓
09:42:10  Risk evaluation
    ↓
09:42:10  P&L rule failed
    ↓
09:42:10  Circuit rule failed
    ↓
09:42:10  Risk BLOCK
    ↓
09:42:10  Order prevented

For an allowed order:

AI
 ↓
Risk PASS
 ↓
Audit
 ↓
Order submitted
 ↓
Broker accepted
 ↓
Partial fill
 ↓
Filled
 ↓
Position updated
 ↓
P&L updated

28. Order Timeline

For an order:

ORDER ID: KTK-123

09:42:10 Requested
09:42:10 Risk Allowed
09:42:10 Submitted
09:42:11 Broker Accepted
09:42:12 Partial Fill 60/100
09:42:13 Filled 100/100
09:42:13 Position Updated

This avoids guessing what happened from the current order status alone.

29. Risk Decision Explorer

Filters:

ALLOW
WARNING
BLOCK
EMERGENCY_BLOCK

Show:

Decision ID
Symbol
Source
Quantity
Result
Top Block Reason
Policy Version
Time

Clicking opens the full Risk Engine decision record.

30. Configuration History

Show:

Time
Setting
Old Value
New Value
Changed By
Version
Reason

Example:

14:32
Circuit Buffer
1.5% → 2.0%
User
Policy v17
Safety adjustment

31. Security Audit Page

Show:

Login
Logout
Auth Failure
Permission Denied
Admin Change
Emergency Lock
Configuration Access

Sensitive values must never be displayed.

32. Error Explorer

Group errors:

Broker Errors
Risk Errors
Order Errors
Session Errors
Engine Errors
Sync Errors
Reconciliation Errors

Show frequency and latest occurrence.

33. Correlation Search

A global search field:

Correlation ID
Order ID
Decision ID
Audit ID
Broker Order ID
Request ID

This should jump directly to the complete event chain.

34. Real-Time Audit Feed

Optional live panel:

LIVE AUDIT

09:43:02 ORDER_FILLED
09:43:01 RISK_ALLOWED
09:42:58 POSITION_UPDATED
09:42:55 BROKER_EVENT

Use event streaming through Connection Manager.

Do not make the UI poll the audit database continuously.

35. Audit Export

Authorized users may export filtered audit records.

Formats may include:

CSV
JSON

Export should preserve:

event ID
timestamp
correlation ID
event type
actor
source
result
reasons

Large exports should be asynchronous.

36. Privacy / Sensitive Data

Never audit:

passwords

API secrets

private keys

raw authentication tokens

session secrets

Mask sensitive account identifiers.

Audit financial/trading data only as required for platform traceability.

37. Performance

Audit writes should not block trading execution unnecessarily.

Recommended:

Trading event
   ↓
Audit enqueue
   ↓
Fast acknowledgement where safe
   ↓
Persistent audit write

Critical decision records may require stronger persistence guarantees.

Do not sacrifice mandatory risk/order traceability for low latency.

38. Failure Handling

If Audit Store is temporarily unavailable:

Critical paths must follow an explicit policy.

Recommended:

Risk decision / order execution audit
→ stronger durability requirement

Debug/non-critical events
→ queue/buffer and retry

The system must never silently discard important audit records.

Queue overflow must produce an operational alert.

39. Audit Backpressure

Monitor:

queue_depth
write_latency
failed_writes
retry_count
oldest_unpersisted_event

If audit backlog becomes dangerous:

AUDIT_DEGRADED

and notify operations.

For trading-critical workflows, platform policy should determine whether new execution is temporarily restricted when required audit guarantees cannot be met.

40. Testing

Unit

Test:

event creation

normalization

correlation IDs

severity

category

immutability

masking

reason storage

policy version

timestamp handling

Integration

Test:

AI
→ Risk
→ Audit
→ Order
→ Broker
→ Position

Verify all events share the correct correlation ID.

Failure

Test:

database unavailable

queue full

duplicate event

out-of-order event

broker timeout

missing metadata

malformed event

restart recovery

41. Acceptance Criteria

Audit Engine is complete when:

important trading actions are audited;

Risk decisions are fully auditable;

order lifecycle is traceable;

broker operations are traceable;

Squareoff attempts are traceable;

configuration changes are traceable;

security events are traceable;

correlation IDs connect related events;

audit records are append-only;

historical records are not overwritten;

sensitive credentials are never stored;

event search/filtering exists;

trading trace exists;

order timeline exists;

risk decision explorer exists;

configuration history exists;

real-time audit feed exists where useful;

retention is configurable;

audit failures are observable;

important records are not silently lost.

42. Final Principle

Audit Engine = the platform's immutable operational memory.

The trading system should be able to reconstruct:

WHAT happened?
WHEN?
WHO/WHAT initiated it?
WHICH ENGINE handled it?
WHICH BROKER was involved?
WHAT state existed?
WHICH RULES were evaluated?
WHY was it allowed/blocked?
WHAT happened next?

Final architecture:

Trading / Risk / Broker / Scheduler / Config
                    ↓
               AUDIT ENGINE
                    ↓
          Immutable Audit Trail
                    ↓
        Search / Timeline / History
                    ↓
                    UI