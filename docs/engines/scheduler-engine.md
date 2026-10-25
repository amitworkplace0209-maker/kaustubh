KAUSTUBH TRADING TERMINAL
ENGINE-BY-ENGINE ARCHITECTURE

ENGINE #01 — SCHEDULER ENGINE
==============================

1. PURPOSE
-----------
Scheduler Engine poore trading system ka TIME + ORCHESTRATION controller hai.

Iska main question:
    "KAB kya hona chahiye?"

Iska kaam:
- defined time par engine ko trigger karna
- trading phases change karna
- engine readiness check karna
- square-off trigger karna
- feed/websocket stop sequence trigger karna
- logout sequence trigger karna
- duplicate/missed events handle karna

Scheduler khud:
- order place nahi karega
- tick calculate nahi karega
- P&L calculate nahi karega
- broker-specific API logic nahi karega
- UI rendering nahi karega
- heavy database work nahi karega


2. HIGH-LEVEL FLOW
------------------

SYSTEM START
    |
    v
SCHEDULER
    |
    +--> SESSION MANAGER
    |
    +--> CONNECTION MANAGER
    |
    +--> WEBSOCKET ENGINE
    |
    +--> FEATURE ENGINE READY
    |
    +--> MODEL GROUP READY
    |
    +--> TRADING WINDOW
    |
    +--> SQUARE-OFF
    |
    +--> FEED STOP
    |
    +--> WEBSOCKET CLOSE
    |
    +--> LOGOUT
    |
    v
DAY COMPLETE


3. DAILY TIMELINE
-----------------

08:50 AM
    -> Login

08:55 AM
    -> WebSocket start

08:55–09:00 AM
    -> Ensure engines/backend are running

09:00–09:05 AM
    -> Pre-market

09:05–09:10 AM
    -> Limit-order phase

09:10–09:12 AM
    -> Equilibrium

09:12–09:15 AM
    -> Buffer

09:15 AM
    -> Starting live feed

03:16 PM
    -> Square-off trigger/input

03:30 PM
    -> Broker-side stop-feed phase

03:31 PM
    -> WebSocket close

04:00 PM
    -> Logout

NOTE:
Notebook mein 03:16 PM aur 03:30 PM dono separate timing points hain.
Inhe automatically merge nahi karna hai. Production mein timings configurable
hon.


4. 08:50 AM — LOGIN TRIGGER
---------------------------

Step 1:
Scheduler trading-day cycle start karta hai.

Step 2:
Market timezone aur current date/time verify karta hai.

Step 3:
Session Manager ko LOGIN trigger deta hai.

Step 4:
Session Manager broker session create karta hai.

Step 5:
Scheduler result wait karta hai.

SUCCESS:
    SESSION_READY

FAILURE:
    SESSION_FAILED
    -> retry policy
    -> notification
    -> trading start nahi


5. 08:55 AM — WEBSOCKET START
-----------------------------

Scheduler:
    START_WEBSOCKET

Connection Manager:
    required connections/subscriptions prepare karta hai

WebSocket Engine:
    broker websocket connect karta hai

Flow:

Scheduler
    |
    v
Connection Manager
    |
    v
WebSocket Engine
    |
    v
Broker WebSocket
    |
    v
CONNECTED
    |
    v
SUBSCRIPTIONS READY
    |
    v
LIVE_FEED_READY


Important:
Scheduler "start()" ko success assume nahi karega.
Actual READY event ka wait karega.


6. 08:55–09:00 — READINESS CHECK
-------------------------------

Scheduler critical components ki readiness verify karega:

1. Session Manager
    -> session valid?

2. Connection Manager
    -> required connection available?

3. WebSocket Engine
    -> connected?

4. Subscriptions
    -> required stock subscriptions active?

5. Feature Engine
    -> ready?

6. Model Group
    -> ready?

7. Position Engine
    -> initial state synchronized?

8. Margin Engine
    -> margin/balance state available?

9. Order Engine
    -> ready?

10. Storage
    -> required persistence available?

Critical failure:
    -> system NOT_READY
    -> notification
    -> trading silently start nahi hoga


7. 09:00–09:05 — PRE-MARKET
---------------------------

Scheduler phase:

    PRE_MARKET

Possible actions:

Market Coach:
    -> stock universe prepare

Watchlist:
    -> selected symbols prepare

Connection Manager:
    -> subscriptions prepare

Feature Engine:
    -> ready

Model Group:
    -> ready

Position Engine:
    -> broker position sync

Margin Engine:
    -> margin/balance sync

Scheduler calculations nahi karega.


8. 09:05–09:10 — LIMIT ORDER WINDOW
-----------------------------------

Scheduler:

    phase = LIMIT_ORDER_WINDOW

Order Engine is phase ko check kar sakta hai.

Example:

Order Request
    |
    v
Is limit-order window open?
    |
    +--> YES -> continue validation
    |
    +--> NO  -> reject/disable


Scheduler order create/place nahi karega.


9. 09:10–09:12 — EQUILIBRIUM
----------------------------

Scheduler:

    phase = EQUILIBRIUM

Notebook mein equilibrium ka exact calculation defined nahi hai.

Isliye Scheduler sirf phase transition publish karega.

Example event:

    PHASE_CHANGED
    previous = LIMIT_ORDER_WINDOW
    current = EQUILIBRIUM
    timestamp = ...


10. 09:12–09:15 — BUFFER
------------------------

Scheduler:

    phase = BUFFER

Ye controlled transition phase hai.

Scheduler calculation nahi karega.


11. 09:15 — LIVE FEED START
---------------------------

Scheduler:

    phase = LIVE_FEED

Systems:

WebSocket Engine
    -> live ticks

Feature Engine
    -> calculations

Model Group
    -> model/rule processing

Position Engine
    -> position state

Suggestion Engine
    -> suggestions

Connection Manager
    -> connection health


12. NORMAL LIVE OPERATION
-------------------------

09:15 ke baad Scheduler mostly event-driven rahega.

Har tick par Scheduler ko run nahi karna chahiye.

BAD:
    while true:
        check everything

GOOD:
    scheduled event
    + health events
    + state transitions

Isse CPU overhead kam rahega aur trading pipeline fast rahegi.


13. 03:16 PM — SQUARE-OFF TRIGGER
---------------------------------

Scheduler:

    TRIGGER_SQUARE_OFF

Flow:

Scheduler
    |
    v
Square-Off Engine
    |
    v
Position Engine
    |
    v
Open positions identify
    |
    v
Order Engine
    |
    v
Broker Adapter
    |
    v
Broker


Responsibility:
Scheduler = trigger
Square-Off Engine = closing process
Order Engine = order validation/submission
Broker Adapter = broker-specific API


14. 03:30 PM — FEED STOP
-------------------------

Scheduler:

    FEED_STOPPING

Then:

Connection Manager
    -> subscriptions/feed stop policy execute kare

Ye 03:31 PM ke WebSocket close se separate event hai.


15. 03:31 PM — WEBSOCKET CLOSE
------------------------------

Scheduler:

    WEBSOCKET_STOP

Flow:

Scheduler
    |
    v
Connection Manager
    |
    v
Unsubscribe
    |
    v
WebSocket Engine
    |
    v
Close
    |
    v
WEBSOCKET_CLOSED

Actual closed state verify hona chahiye.


16. 04:00 PM — LOGOUT
---------------------

Scheduler:

    LOGOUT_TRIGGER

Session Manager:
    -> logout/invalidate session

Before final completion:
- final position state save
- final order state save
- important logs save
- scheduler state save

Then:

    DAY_COMPLETE


17. STATE MACHINE
-----------------

INIT
  |
  v
LOGIN_PENDING
  |
  v
SESSION_READY
  |
  v
CONNECTION_STARTING
  |
  v
CONNECTION_READY
  |
  v
PRE_MARKET
  |
  v
LIMIT_ORDER_WINDOW
  |
  v
EQUILIBRIUM
  |
  v
BUFFER
  |
  v
LIVE_FEED
  |
  v
SQUARE_OFF
  |
  v
FEED_STOPPING
  |
  v
WEBSOCKET_STOPPING
  |
  v
LOGOUT
  |
  v
DAY_COMPLETE


Failure states:
- LOGIN_FAILED
- CONNECTION_FAILED
- FEED_FAILED
- SQUARE_OFF_FAILED
- LOGOUT_FAILED


### Implementation note (§17 — audit F1)

The running implementation (`python-service/scheduler/__init__.py`) uses a
**richer state vocabulary** than the §17 canonical list. Per the runtime-truth
rule the implemented vocabulary is authoritative; the mapping below is the
documented bridge (no backend change required):

| §17 canonical | Implemented state(s) | Difference |
| --- | --- | --- |
| INIT | `STARTING` | roomier semantics (boot/loop-convergence) |
| LOGIN_PENDING / SESSION_READY | `WAITING_FOR_LOGIN` / `LOGGING_IN` / `SESSION_ACTIVE` | login split into wait → in-progress → established |
| CONNECTION_STARTING / CONNECTION_READY | `WAITING_FOR_WS` / `WS_CONNECTING` / `WS_ACTIVE` | WS split into wait → connect → active |
| — (not in §17) | `WS_RECONNECTING` | explicit feed-reconnect loop |
| PRE_MARKET | `TICK_COLLECTION` / `TICK_COLLECTION_RUNNING` → phase `PRE_MARKET` etc. | tick-collection prep added |
| LIMIT_ORDER_WINDOW … LOGOUT | phases `LIMIT_ORDER_WINDOW` … `LOGOUT` (see §13 phase machine) | phases live in the separate 12-phase machine + settings clocks |
| DAY_COMPLETE | `MARKET_CLOSED` → `WAITING_FOR_NEXT_TRADING_DAY` (then `STARTING` next day) | end-of-day recycling modelled explicitly |
| LOGIN_FAILED | `LOGIN_FAILED` | same |
| CONNECTION_FAILED / FEED_FAILED | `WS_FAILED` | consolidated |
| SQUARE_OFF_FAILED / LOGOUT_FAILED | `ERROR` | consolidated with loop restart |

Implemented state machine (15 states): `STARTING → WAITING_FOR_LOGIN → LOGGING_IN → SESSION_ACTIVE → WAITING_FOR_WS → WS_CONNECTING → WS_ACTIVE (↔ WS_RECONNECTING) → TICK_COLLECTION → TICK_COLLECTION_RUNNING → WS_DISCONNECTING → LOGGING_OUT → LOGGED_OUT → MARKET_CLOSED → WAITING_FOR_NEXT_TRADING_DAY`; failure states `LOGIN_FAILED / WS_FAILED / ERROR`. The 12 phases (CLOSED, READINESS, PRE_MARKET, LIMIT_ORDER_WINDOW, EQUILIBRIUM, BUFFER, LIVE_FEED, SQUARE_OFF, FEED_STOPPING, WEBSOCKET_STOPPING, LOGOUT, DAY_COMPLETE) are clock-driven from runtime settings (`sched_login_time` 08:50, `sched_ws_start_time` 08:55, `sched_tick_collection_start_time` 08:59, square-off 15:16, feed stop 15:30 — two separate timings, never merged, WS stop 15:31, logout 16:00).


18. INTERNAL EVENTS
-------------------

Recommended events:

TRADING_DAY_STARTED
LOGIN_TRIGGER
SESSION_READY
WEBSOCKET_START_TRIGGER
CONNECTION_READY
PRE_MARKET_STARTED
LIMIT_ORDER_WINDOW_STARTED
EQUILIBRIUM_STARTED
BUFFER_STARTED
LIVE_FEED_STARTED
SQUARE_OFF_TRIGGERED
FEED_STOP_TRIGGERED
WEBSOCKET_STOP_TRIGGERED
WEBSOCKET_CLOSED
LOGOUT_TRIGGERED
SESSION_CLOSED
TRADING_DAY_COMPLETED


19. DUPLICATE TRIGGER PROTECTION
--------------------------------

Important real-world case:

03:16 PM trigger accidentally fires twice.

BAD:
    square-off
    square-off again

GOOD:

SQUARE_OFF_TRIGGER
    |
    v
already started?
    |
    +--> YES -> ignore duplicate
    |
    +--> NO  -> start square-off

Every critical event/state transition should be idempotent.


20. MISSED EVENT RECOVERY
-------------------------

Example:

Square-off time = 03:16 PM
Server comes back = 03:20 PM

Scheduler checks:

- current time
- event status
- square-off completion
- recovery policy

If square-off not completed:
    -> execute configured recovery process

If already completed:
    -> do not execute again


21. TIMEZONE
------------

Scheduler ko explicitly configured MARKET_TIMEZONE use karna chahiye.

Browser/server timezone par blindly depend nahi karna.

Configuration concept:

    MARKET_TIMEZONE
    LOGIN_TIME
    WEBSOCKET_START_TIME
    PRE_MARKET_START
    LIMIT_ORDER_START
    EQUILIBRIUM_START
    BUFFER_START
    FEED_START
    SQUARE_OFF_TIME
    FEED_STOP_TIME
    WEBSOCKET_CLOSE_TIME
    LOGOUT_TIME


22. ENGINE COMMUNICATION
------------------------

Scheduler commands/events publish kare.

Example:

Scheduler
    |
    | START_WEBSOCKET
    v
Connection Manager


Another:

Scheduler
    |
    | TRIGGER_SQUARE_OFF
    v
Square-Off Engine


Scheduler ko doosre engine ki internal implementation nahi pata honi chahiye.


23. SCHEDULER SHOULD KNOW
------------------------

- market schedule
- market timezone
- phase timings
- current phase
- engine readiness
- critical health state
- event execution state
- retry policy
- recovery policy


24. SCHEDULER SHOULD NOT KNOW
-----------------------------

- broker-specific order API
- exact MongoDB tick schema
- feature formulas
- ML model implementation
- P&L implementation
- position calculation implementation
- WebSocket message parsing
- UI rendering
- search implementation


25. UI
------

Trading Terminal UI scheduler se state read kare.

Example:

MARKET STATUS
    Phase: LIVE FEED
    Session: Connected
    WebSocket: Connected
    Feed: Healthy
    Next Event: Square-Off
    Next Event Time: 03:16 PM

UI ko scheduler ke internal variables directly modify nahi karne chahiye.


26. MULTI-TERMINAL SUPPORT
--------------------------

One Trading Terminal UI:

    Terminal Dropdown
       |
       +--> Kotak Neo
       +--> Shoonya
       +--> Dummy Mode

Scheduler common lifecycle trigger kare.

Broker-specific implementation:

    Broker Adapter
        |
        +--> Kotak Adapter
        +--> Shoonya Adapter
        +--> Dummy Adapter

Scheduler ko Kotak/Shoonya API ki internal details nahi pata hongi.


27. PERFORMANCE RULES
---------------------

Fast, non-hanging terminal ke liye:

1. Scheduler tick-by-tick data process na kare.
2. Scheduler every-tick MongoDB write na kare.
3. Scheduler heavy calculation na kare.
4. Scheduler UI ko block na kare.
5. Long work correct engine ko delegate kare.
6. Event handlers lightweight rakhe.
7. Critical triggers idempotent rakhe.
8. Scheduler state observable rakhe.
9. Failure par unsafe trading state silently allow na ho.
10. Scheduler trading data pipeline ka bottleneck na bane.


28. LOGGING
-----------

Every important scheduler event ka structured log:

    timestamp
    event
    previous_phase
    new_phase
    result
    terminal
    error
    duration

Example:

    09:15:00
    EVENT = LIVE_FEED_STARTED
    RESULT = SUCCESS


29. CORE RESPONSIBILITY
-----------------------

SCHEDULER ENGINE = TIME + ORCHESTRATION

Scheduler ka kaam:
    "KAB?"

Baaki engines ka kaam:
    "KAISE?"

Examples:

Scheduler:
    "03:16 PM par square-off trigger karo."

Square-Off Engine:
    "Open positions kaise close karne hain."

Order Engine:
    "Closing order ko kaise validate/submit karna hai."

Broker Adapter:
    "Selected broker ki API ko kaise call karna hai."


30. NEXT ENGINE
---------------

ENGINE #02 — SESSION MANAGER ENGINE

Next detailed section mein:
- Login lifecycle
- Session creation
- Session token/reference
- Expiry tracking
- Re-login/recovery
- Kotak/Shoonya/Dummy abstraction
- Session health
- Logout
- Scheduler ke saath exact communication
- Failure handling
- Security boundaries
- Performance rules

END — ENGINE #01


PERFORMANCE UPDATE (2026-10-01) — implementation 021
----------------------------------------------------

See `docs/implementation/021-trade-page-realtime-performance.md` and
`docs/verification/021-trade-page-realtime-performance-verification.md`.

- `_refresh_readiness()` now reads `session_manager.is_active()` instead of
  `session_manager.snapshot().get("active")`. The two are exactly equal, but the
  old call materialised the full ~2682-row subscription view on the event loop
  every reconcile (a profile put ~22% of CPU on that path).

Performance rule 10 ("Scheduler trading data pipeline ka bottleneck na bane")
is thereby better satisfied. Lifecycle decisions, event orchestration and all
timings are unchanged.

