Notification Engine — Advanced UI + Engine Detailed Design

1. Purpose

Notification Engine is the project's centralized event-to-notification infrastructure.

It is responsible for receiving meaningful project events, classifying them, applying notification policy, persisting notification state, and delivering notifications to the appropriate UI and external channels.

Core principle:

Engines publish standardized events. Notification Engine decides whether, how, where, and when those events become notifications.

Alerts are a first-class notification type/section inside Notification Engine. There is no separate Alert Engine.

2. Architecture

Project Engines
    |
    | Standardized Events
    v
Notification Engine
    |
    +-- Event Intake
    +-- Classification
    +-- Phase Resolution
    +-- Broker/Terminal Resolution
    +-- Category Resolution
    +-- Severity
    +-- Policy / Rule Engine
    +-- Deduplication
    +-- Cooldown
    +-- Grouping / Aggregation
    +-- Persistence
    +-- Delivery Router
    |
    +-------------------------------+
    |               |               |
    v               v               v
In-App UI         Toast          Sound
    |                               |
    +---------------+---------------+
                    |
                    v
              Browser / PWA

Notification Engine must remain independent from the individual source engines.

3. Responsibility Boundary

Notification Engine owns

notification event intake

notification classification

notification metadata

phase filtering

broker/terminal attribution

severity

notification policies

rule evaluation

deduplication

cooldown

grouping

persistence

notification lifecycle

delivery routing

sound selection

PWA/browser delivery

notification preferences

alert rules

deep-link metadata

notification history

acknowledgement/resolution state

notification observability

Notification Engine does NOT own

broker connectivity

order execution

risk calculation

P&L calculation

position calculation

AI signal generation

WebSocket market feed

squareoff execution

business logic belonging to source engines

Those engines publish events. Notification Engine reacts to them.

4. Standard Event Contract

Every notification-capable event should use a common structure.

{
  "event_id": "evt_123",
  "event_type": "ORDER_FILLED",
  "timestamp": "2026-09-19T10:15:20Z",

  "phase": "PHASE_2",
  "category": "TRADING",
  "severity": "INFO",

  "source_engine": "order_engine",

  "terminal_id": "terminal_kotak_01",
  "broker": "KOTAK",

  "symbol": "RELIANCE",
  "token": "2885",
  "order_id": "ORD123",

  "actor_type": "USER",

  "title": "Order Filled",
  "message": "RELIANCE buy order filled",

  "related": {
    "order_id": "ORD123",
    "position_id": null,
    "risk_decision_id": null,
    "audit_event_id": "audit123"
  },

  "metadata": {}
}

Required metadata dimensions:

Phase

Category

Broker/Terminal

Severity

Event Type

Source Engine

Timestamp

Optional contextual metadata:

symbol

token

order_id

position_id

risk_decision_id

squareoff_run_id

audit_event_id

correlation_id

actor

configuration version

5. Event Categories

Recommended categories:

SYSTEM

TRADING

BROKER

RISK

MARKET

POSITION

PNL

MARGIN

SQUAREOFF

AI

SESSION

SCHEDULER

SECURITY

CONFIGURATION

ENGINE

Categories are classification metadata, not separate engines.

6. Severity Model

INFO
SUCCESS
WARNING
ERROR
CRITICAL
EMERGENCY

Severity determines default visual priority, delivery channels, sound policy, retention priority, and escalation behavior.

Example:

Order Filled        → SUCCESS
Broker reconnecting → WARNING
Order Rejected      → ERROR
Risk Hard Block     → ERROR
Squareoff Incomplete→ CRITICAL
Security Incident   → EMERGENCY

A source engine may suggest severity, but notification policy may refine it.

7. Phase Model

Supported contexts:

PHASE_1

PHASE_2

PHASE_3

KUMBH_AI

GLOBAL

Phase-specific notifications must remain scoped to their phase.

Example:

PHASE_1 + MARKET

should not automatically appear inside a Phase 2-only notification panel.

GLOBAL notifications may appear across the project where appropriate.

Global critical/security/system events can remain phase-independent.

8. Broker / Terminal Model

Every broker-related notification should identify its source where possible.

Supported terminals:

KOTAK

SHOONYA

DUMMY

The UI should display broker/terminal attribution consistently.

Example:

[KOTAK] Broker Disconnected
[SHOONYA] Margin Sync Failed
[DUMMY] Simulated Order Filled

Combined portfolio views must preserve source attribution.

9. Notification Lifecycle

EVENT
  ↓
CLASSIFY
  ↓
PHASE RESOLVE
  ↓
BROKER RESOLVE
  ↓
CATEGORY
  ↓
SEVERITY
  ↓
POLICY
  ↓
DEDUPLICATE
  ↓
COOLDOWN
  ↓
GROUP
  ↓
PERSIST
  ↓
RENDER
  ↓
DELIVER
  ↓
READ
  ↓
ACKNOWLEDGE
  ↓
RESOLVE

Important:

READ != ACKNOWLEDGED != RESOLVED

A user reading a broker-disconnect notification does not mean the broker has reconnected.

10. Notification Types

Examples:

Informational

order accepted

order filled

session started

market opened

sync completed

Warning

broker latency elevated

margin approaching threshold

stale position data

market data delayed

Error

order rejected

margin allocation failed

broker API error

risk validation failure

Critical

squareoff incomplete

critical risk threshold reached

broker disconnected during trading

reconciliation mismatch

Emergency

security event

emergency trading shutdown

catastrophic system state

11. Alert System

Alerts are a specialized notification type.

UI structure:

Notifications
├── All
├── Unread
├── Critical
├── Trading
├── Broker
├── Risk
├── AI
├── System
└── Alerts
    ├── Active Alerts
    ├── Alert History
    ├── Alert Rules
    └── Alert Settings

Examples:

P&L threshold reached

risk limit reached

broker disconnected

AI risk breach

squareoff incomplete

repeated broker failures

Alerts require lifecycle tracking.

TRIGGERED
ACTIVE
ACKNOWLEDGED
RESOLVED

12. Deduplication

Identical events must not generate notification spam.

Example:

BROKER_DISCONNECTED
BROKER_DISCONNECTED
BROKER_DISCONNECTED
BROKER_DISCONNECTED

should normally become one active notification/alert with updated metadata.

Suggested deduplication key:

event_type
+ terminal_id
+ broker
+ symbol
+ related_object_id

The exact key is configurable per event type.

13. Cooldown

Cooldown prevents repeated delivery of the same condition.

Example:

P&L < -5000

may trigger a warning.

It should not generate a new toast every second.

Possible policy:

trigger: threshold_crossed
cooldown: 5 minutes
re-notify: only on recovery and re-cross

Critical events may bypass normal cooldown when policy requires it.

14. Grouping

High-volume events should be aggregated.

Example:

12 orders rejected
3 broker API errors
5 market data warnings

can become grouped notifications instead of 20 individual cards.

Grouping must preserve access to underlying events.

15. Notification Persistence

Notifications must survive page refresh and session reload.

Conceptual record:

notification_id
event_id
correlation_id
created_at
updated_at

phase
category
severity
event_type

source_engine
broker
terminal_id

title
message

state
delivery_state

related_object_ids

policy_id
policy_version

dedupe_key
group_id

read_at
acknowledged_at
resolved_at

metadata

Persistence should support:

history

unread count

alert state

audit trace

deep links

analytics

recovery after restart

16. Delivery Channels

Initial practical channels:

In-App Notification Center

Toast

Sound

Browser Notification

PWA Service Worker Notification

Future:

Email

Telegram

WhatsApp

SMS

The delivery layer should be extensible without changing source engines.

17. Sound System

Settings should support:

master sound ON/OFF

master volume

critical volume

notification-type sound

severity sound

broker-specific sound

category-specific sound

test button

mute

quiet hours

Critical/emergency policies should not be silently suppressed by normal quiet hours.

18. Broker-Specific Customization

For Kotak, Shoonya, and Dummy:

Broker
 ├── notification icon
 ├── theme
 ├── sound
 ├── volume
 ├── toast duration
 ├── browser/PWA behavior
 ├── priority
 └── enabled notification types

Broker customization must not change the underlying event semantics.

19. Notification Rule Builder

UI should support:

IF
    event = RISK_ORDER_BLOCKED
AND
    broker = KOTAK
AND
    phase = PHASE_2

THEN
    severity = ERROR
    toast = ON
    sound = risk_block
    browser = ON
    cooldown = 60s

Rules should support:

event

phase

broker

category

severity

symbol

source engine

thresholds

channels

sound

cooldown

grouping

escalation

Rules must be versioned.

20. UI Architecture

Recommended structure:

NotificationCenter
├── NotificationHeader
│   ├── UnreadCount
│   ├── MarkAllRead
│   └── NotificationSettings
│
├── NotificationFilters
│   ├── Phase
│   ├── Category
│   ├── Broker
│   ├── Severity
│   └── State
│
├── NotificationTabs
│   ├── All
│   ├── Unread
│   ├── Critical
│   ├── Trading
│   ├── Broker
│   ├── Risk
│   ├── AI
│   ├── System
│   └── Alerts
│
├── NotificationList
│   └── NotificationCard
│
└── NotificationDetailDrawer

21. Notification Card

Each card should show only useful information.

┌──────────────────────────────────────┐
│ ● ORDER FILLED              10:15 AM │
│                                      │
│ RELIANCE BUY 10 Qty                  │
│ Order ORD123 filled successfully     │
│                                      │
│ KOTAK • PHASE 2 • TRADING            │
│                                      │
│ [View Order] [Mark Read]             │
└──────────────────────────────────────┘

Optional metadata:

source engine

symbol

broker

terminal

severity

timestamp

correlation ID

Avoid displaying raw technical payloads in the primary card.

22. Notification Detail

Clicking a notification opens a detail drawer/page.

Sections:

Summary

title

message

severity

state

timestamp

Source

source engine

event type

broker

terminal

phase

Related Objects

order

position

risk decision

squareoff run

audit event

symbol

Timeline

10:14:58 Risk evaluated
10:14:59 Order submitted
10:15:00 Broker accepted
10:15:02 Order filled
10:15:02 Notification delivered

Actions

Actions must be permission-controlled.

23. Deep Links

Notifications should carry object references.

Examples:

ORDER_FILLED
→ /orders/ORD123

RISK_ORDER_BLOCKED
→ /risk/decisions/RISK123

SQUAREOFF_INCOMPLETE
→ /squareoff/run/RUN123

BROKER_DISCONNECTED
→ /brokers/terminal_kotak_01

Dangerous actions must require confirmation/authentication.

A notification must never directly execute a dangerous trading operation merely because the user clicked it.

24. Phase Integration

Phase 1

Relevant:

Market Watch

Watchlist

Search

Market data

Session

Broker connectivity

Example:

Market data delayed
Watchlist subscription failed
Kotak connection warning

Phase 2

Relevant:

Orders

Positions

Risk

Margin

P&L

Squareoff

Broker

Example:

Order Filled
Risk Blocked
Margin Allocation Failed
Position Closed
Squareoff Started
Squareoff Incomplete

Phase 3

Relevant:

Broker Terminal

portfolio synchronization

reconciliation

system health

Kumbh AI

Relevant:

AI suggestion

AI allocation

AI risk decision

AI execution

AI failure

AI threshold event

25. Engine Integration Matrix

Every engine should publish only meaningful notification-capable events.

Engine

Example Events

Broker Terminal

connected, disconnected, session expired, sync failure

WebSocket

feed connected, feed disconnected, severe feed degradation

Session Manager

session expired, session restored

Scheduler

market lifecycle transitions

Risk

order allowed, blocked, warning, emergency block

Order

submitted, accepted, rejected, filled, cancelled

Position

opened, changed, closed, reconciliation mismatch

P&L

threshold crossed, drawdown, recovery

Margin

allocation, reservation, failure, release

Squareoff

freeze, cancel, exit, retry, complete, incomplete

Market Watch

configured significant market events

AI

suggestion, allocation, decision, execution result

Audit

audit persistence failure / security-relevant event

Storage

persistence failure / degraded state

Configuration

important configuration changes

System

startup, shutdown, critical failure

Low-level tick/cache/DB-write events remain logs/audit unless promoted by policy.

26. Real-Time UI Data Flow

Engine Event
    ↓
Notification Engine
    ↓
Persistence
    ↓
Realtime Event Bus / Backend Stream
    ↓
Connection Manager
    ↓
Frontend Notification Store
    ↓
Notification Center

The frontend must not independently poll every engine for notification data.

27. Frontend State

Recommended notification store:

notifications[]
unreadCount
activeAlerts[]
filters
selectedNotification
connectionState
lastEventAt
loading
error

State updates must be incremental.

A single new notification should not force the entire dashboard to rerender.

28. Filtering

Filters:

Phase

Category

Broker

Terminal

Severity

Event Type

Source Engine

State

Time range

Symbol

Filters should be composable.

Example:

Phase 2
+ Risk
+ Kotak
+ ERROR
+ Unread

29. Search

Notification search should support:

title

message

symbol

order ID

position ID

terminal ID

broker

event type

source engine

correlation ID

Search should query indexed notification data rather than scanning all events in memory.

30. Notification Settings UI

Sections:

General

notifications enabled

master sound

master volume

quiet hours

Channels

in-app

toast

sound

browser

PWA

Categories

trading

broker

risk

market

AI

system

Severity

info

success

warning

error

critical

emergency

Broker

Kotak

Shoonya

Dummy

Advanced

deduplication

cooldown

grouping

escalation

31. PWA / Browser Notification

For installed PWA:

Backend
   ↓
Notification Delivery
   ↓
Service Worker
   ↓
OS Notification
   ↓
User taps notification
   ↓
PWA opens
   ↓
Deep Link

The notification should preserve:

notification ID

related object

phase

broker

event type

The service worker must not expose sensitive trading payload unnecessarily.

32. Security

Notification Engine handles potentially sensitive trading data.

Requirements:

authenticated access

authorization-aware notification queries

no unauthorized cross-user data

broker credentials never inside notification payload

secrets/tokens never shown

sensitive payload minimized

dangerous actions require confirmation

audit notification policy changes

audit notification acknowledgements where required

33. Failure Handling

If Notification Engine fails:

source engines must continue operating unless notification is a hard safety dependency

critical trading logic must NOT depend on successful UI notification delivery

failed notifications should be retried according to channel policy

persistent failures should be observable

notification delivery failure must not silently imply that the underlying business event failed

Example:

Order successfully filled
+
Notification delivery failed

must remain:

ORDER = FILLED
NOTIFICATION = DELIVERY_FAILED

These are separate states.

34. Observability

Metrics:

events received

notifications generated

notifications suppressed

deduplicated count

cooldown suppressions

delivery success/failure

channel latency

unread count

active alerts

resolution time

PWA delivery failures

rule evaluation failures

Logs should include:

event_id
notification_id
correlation_id
source_engine
event_type
policy_id
delivery_channel
result

35. Performance

The system must support high event volume without turning every event into a UI operation.

Requirements:

asynchronous processing

event classification before delivery

deduplication

cooldown

grouping

indexed persistence

bounded in-memory queues

batched persistence where appropriate

incremental frontend updates

virtualized notification history for large lists

36. Data Retention

Notification history and audit history are related but not identical.

Notification records may have a shorter UI retention period.

Audit records remain governed by Audit Engine retention policy.

Deleting a notification must not delete the underlying audit event.

37. Testing

Required tests:

Unit

event classification

severity resolution

phase resolution

broker resolution

rule evaluation

deduplication

cooldown

grouping

lifecycle transitions

Integration

Risk → Notification

Order → Notification

Broker Terminal → Notification

Margin → Notification

Squareoff → Notification

AI → Notification

Notification → Connection Manager

Notification → Frontend

UI

unread count

filtering

detail drawer

deep links

mark read

acknowledge

resolve

alert lifecycle

sound settings

PWA notification behavior

Failure

notification persistence failure

delivery failure

duplicate event

event burst

broker disconnect storm

reconnect recovery

frontend reconnect

38. Acceptance Criteria

Notification Engine is complete only when:

every notification-capable engine publishes standardized events

notification events are persisted

phase filtering works

broker attribution works

severity works

deduplication works

cooldown works

grouping works

alerts are implemented inside Notification Engine

notification lifecycle is implemented

Notification Center uses real backend data

existing notification UI no longer uses fake/static data

phase-specific notification pages consume Notification Engine

broker-specific notifications work

sound settings work

browser/PWA notifications work

deep links work

permissions are enforced

critical events are not silently lost

notification delivery failure does not alter business-event truth

Audit Engine can trace important notification decisions

frontend receives incremental realtime updates

tests cover engine integrations and UI behavior

39. Implementation Order

Do not implement the UI first.

Recommended order:

Notification event contract

Notification Engine core

persistence model

classification

severity

phase/broker routing

deduplication/cooldown

lifecycle

delivery router

Alert subsystem

engine integrations

Connection Manager realtime delivery

frontend store

Notification Center

phase-specific pages

settings

sound

browser/PWA

deep links

observability

full integration testing

40. Final Architecture Principle

SOURCE ENGINES
    ↓
STANDARD PROJECT EVENTS
    ↓
NOTIFICATION ENGINE
    ↓
POLICY + CLASSIFICATION
    ↓
DEDUP + COOLDOWN + GROUPING
    ↓
PERSISTENCE
    ↓
DELIVERY
    ↓
NOTIFICATION CENTER / PHASE UI / TOAST / SOUND / PWA

Notification Engine is the project's central communication layer for meaningful operational events.

It does not replace Risk, Order, Broker, P&L, Position, Margin, Squareoff, AI, or Audit engines.

Those engines remain authoritative for their own domains.

Notification Engine only transforms their meaningful events into controlled, traceable, user-facing notifications and alerts.