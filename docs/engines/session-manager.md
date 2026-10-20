SESSION MANAGER ENGINE
FULL DETAILED ARCHITECTURE, FLOW & RESPONSIBILITIES
Updated Design

============================================================
1. PURPOSE
============================================================

Session Manager Engine ka main kaam:
- Kotak Neo session lifecycle manage karna.
- Shoonya session lifecycle manage karna.
- Dono broker sessions independently maintain karna.
- Stock/instrument registry maintain karna.
- Subscription registry maintain karna.
- Kisi bhi allowed UI/API/engine ko stock add/remove karne ka mechanism dena.
- Instrument expiry track karna.
- Expired instruments ko active subscription list se automatically remove karna.
- WebSocket Engine ko stock/subscription changes ke events dena.

IMPORTANT:
Session Manager LIVE MARKET DATA receive, process ya distribute nahi karega.

============================================================
2. CORE ARCHITECTURE
============================================================

UI / API / Engine
        |
        v
SESSION MANAGER
    |-- Session Store
    |-- Stock Registry
    |-- Subscription Registry
    |-- Expiry Manager
    |-- Session API / Service
    |-- Event Publisher
        |
        +---- active stock list ----> WebSocket Engine
        |
        +---- stock events ---------> WebSocket Engine

WebSocket Engine
        |
        v
Kotak WebSocket
        |
        v
LIVE TICKS
        |
        +--> Feature Engine
        +--> Position Engine
        +--> P&L Engine
        +--> Watchlist / UI
        +--> Dummy Engine

Session Manager ko tick nahi milega.

============================================================
3. BROKER SESSION MANAGEMENT
============================================================

Supported broker sessions:
1. Kotak Neo
2. Shoonya

Dono independently operate karenge.

Example:
Kotak = READY
Shoonya = ERROR

Result:
Kotak usable rahega; Shoonya failure Kotak ko affect nahi karega.

Reverse case bhi same.

Recommended conceptual structure:

SessionManager
    |-- KotakSession
    |-- ShoonyaSession

============================================================
4. KOTAK SESSION
============================================================

Kotak primary live market-data architecture ka broker hai.

Session Manager:
- Kotak login/session lifecycle maintain karega.
- Session state maintain karega.
- Session validity/expiry state maintain karega.
- Required session metadata available rakhega.

Session Manager khud Kotak WebSocket par ticks receive nahi karega.

============================================================
5. SHOONYA SESSION
============================================================

Shoonya session SDK/API ke according independently manage hoga.

Shoonya login fail hone par Kotak session continue karega.

Shoonya state aur Kotak state ek doosre ko overwrite nahi karenge.

============================================================
6. DUMMY MODE
============================================================

Dummy mode ka:
- koi separate broker session nahi.
- koi separate Dummy WebSocket nahi.
- koi separate Dummy login nahi.

Dummy mode live market price ke liye common Kotak WebSocket feed use karega.

Execution virtual hogi:
Kotak LTP -> WebSocket Engine -> Dummy Engine
Dummy Engine -> virtual order -> virtual position/P&L

Dummy mode select karne par Kotak session logout/disconnect nahi hona chahiye.

============================================================
7. SESSION STATES
============================================================

Normal states:
NO_SESSION
LOGIN_REQUIRED
LOGIN_IN_PROGRESS
SESSION_CREATED
SESSION_VALIDATING
SESSION_READY
SESSION_ACTIVE
SESSION_EXPIRING
SESSION_REFRESH
SESSION_EXPIRED
RELOGIN_REQUIRED
LOGOUT_REQUESTED
LOGGING_OUT

Failure states:
LOGIN_FAILED
SESSION_VALIDATION_FAILED
SESSION_REFRESH_FAILED
LOGOUT_FAILED
SESSION_ERROR

Kotak aur Shoonya ke states independently maintain honge.

============================================================
8. SESSION DATA
============================================================

Session Manager operational metadata maintain karega:

broker
status
session_created_at
session_expires_at
last_validated_at
last_login_at
last_error

Sensitive credentials plain text mein runtime state, logs ya UI mein
expose/store nahi karne hain.

OTP, PIN, password aur secret values log nahi karni hain.

============================================================
9. STOCK / INSTRUMENT REGISTRY
============================================================

Session Manager Stock Registry maintain karega.

Minimum fields:

symbol
instrumentToken
exchange
expiry
status

Recommended record:

StockSubscriptionRecord
    symbol
    instrumentToken
    exchange
    expiry
    status
    subscribers
    createdAt
    updatedAt

Ye instrument metadata hai, LIVE TICK DATA nahi.

============================================================
10. SUBSCRIPTION REGISTRY
============================================================

Multiple consumers same instrument request kar sakte hain.

Example:
Dashboard -> NIFTY
Watchlist -> NIFTY
Feature Engine -> NIFTY

Registry:

NIFTY
    subscribers:
        Dashboard
        Watchlist
        FeatureEngine

Actual WebSocket subscription:
ONE

3 consumers ka matlab 3 WebSocket subscriptions nahi hai.

============================================================
11. REFERENCE / SUBSCRIBER LOGIC
============================================================

Agar NIFTY ke subscribers:
Dashboard
Watchlist
FeatureEngine

Dashboard unsubscribe kare:
count = 2
WebSocket subscription remain.

Watchlist unsubscribe kare:
count = 1
WebSocket subscription remain.

Last subscriber unsubscribe kare:
count = 0
STOCK_REMOVED / unsubscribe event generate kiya ja sakta hai.

Isse accidental feed removal prevent hota hai.

============================================================
12. STOCK ADD API / INPUT
============================================================

Conceptual endpoint:

POST /session/stocks

Request:
{
    symbol,
    instrumentToken,
    exchange,
    expiry,
    subscriber
}

Flow:
1. Request receive.
2. Fields validate.
3. Instrument identify.
4. Expiry validate.
5. Expired instrument reject.
6. Existing record check.
7. New record create OR existing subscription update.
8. Subscriber register.
9. Active status maintain.
10. Event publish.
11. WebSocket Engine event consume kare.

============================================================
13. STOCK ADD FLOW
============================================================

UI / Engine
    |
    v
Session Manager API
    |
    v
Validation
    |
    +-- invalid --> ERROR
    |
    v
Expiry Check
    |
    +-- expired --> REJECT
    |
    v
Stock Registry
    |
    +-- new --> create record
    |
    +-- existing --> add subscriber
    |
    v
Subscription Registry
    |
    v
STOCK_ADDED / SUBSCRIPTION_UPDATED
    |
    v
WebSocket Engine
    |
    v
Subscribe if required

============================================================
14. DUPLICATE STOCK ADD
============================================================

Same instrument multiple times add hone par duplicate record nahi banana.

Example:
POST NIFTY
POST NIFTY
POST NIFTY

Result:
- one instrument record
- one subscriber relationship per subscriber
- one actual WebSocket subscription

Retry requests safe honi chahiye.

============================================================
15. STOCK REMOVE FLOW
============================================================

Conceptual:
DELETE /session/stocks/{instrument}

Preferred request identity:
instrumentToken
subscriber

Flow:
UI / Engine
    |
    v
Session Manager
    |
    v
Subscription Registry
    |
    v
Remove subscriber
    |
    +-- other subscribers exist --> keep active
    |
    +-- no subscribers --> remove/mark inactive
                                  |
                                  v
                              STOCK_REMOVED
                                  |
                                  v
                           WebSocket Engine
                                  |
                                  v
                              Unsubscribe

============================================================
16. ACTIVE STOCK LIST
============================================================

Conceptual endpoint:

GET /session/stocks/active

Response:
[
    {
        symbol,
        instrumentToken,
        exchange,
        expiry,
        status
    }
]

WebSocket Engine jab start hoga tab Session Manager se current active
subscription list lega.

Session Manager live feed nahi bhejega.

============================================================
17. DAILY WEBSOCKET START - 08:55
============================================================

Scheduler:
08:55 -> WebSocket Engine START

WebSocket Engine:
1. Required Kotak session check.
2. Session Manager se active subscriptions request.
3. Kotak WebSocket connect.
4. Active instruments subscribe.
5. Live feed receive.
6. Feed normalize.
7. Downstream engines ko distribute.

Flow:

Scheduler
   |
   v
WebSocket Engine
   |
   v
Session Manager -> active stock list
   |
   v
Kotak WebSocket
   |
   v
LIVE FEED

============================================================
18. LIVE FEED BOUNDARY
============================================================

Correct:

Kotak WebSocket
    -> WebSocket Engine
    -> Feature / Position / P&L / Watchlist / Dummy / UI

Incorrect:

Kotak WebSocket
    -> Session Manager

Session Manager ko live ticks receive nahi karne.

============================================================
19. SESSION MANAGER MUST NOT
============================================================

Session Manager:
- LTP receive nahi karega.
- Tick stream process nahi karega.
- Indicators calculate nahi karega.
- P&L calculate nahi karega.
- Candles calculate nahi karega.
- Live feed broadcast nahi karega.
- WebSocket server nahi banega.
- Kotak WebSocket ko directly own nahi karega.
- Historical tick data RAM mein maintain nahi karega.

============================================================
20. EXPIRY MANAGEMENT
============================================================

Har relevant instrument ke saath expiry maintain hogi.

Example:
expiry = 2026-09-24

Expiry Manager active instruments ko check karega.

Expiry reach hone par:

ACTIVE
  |
  v
EXPIRED
  |
  v
Active list se remove
  |
  v
Subscription cleanup
  |
  v
STOCK_EXPIRED
  |
  v
WebSocket Engine
  |
  v
Unsubscribe if required

============================================================
21. EXPIRY FLOW
============================================================

Expiry Manager
    |
    v
Instrument expiry reached
    |
    v
Stock Registry -> EXPIRED
    |
    v
Remove from active registry
    |
    v
Subscription cleanup
    |
    v
Publish STOCK_EXPIRED
    |
    v
WebSocket Engine
    |
    v
Unsubscribe

Expired instrument next WebSocket startup par bhi active list mein
return nahi hona chahiye.

============================================================
22. STOCK EXPIRY VS SESSION EXPIRY
============================================================

Instrument expiry:
- Stock/instrument registry ki responsibility.

Broker session expiry:
- Session Store ki responsibility.

Dono concepts ko mix nahi karna.

============================================================
23. INTERNAL MODULE STRUCTURE
============================================================

session_manager/
|
+-- service.py
|     Main orchestration
|
+-- session_store.py
|     Broker session state
|
+-- broker_sessions/
|     +-- kotak_session.py
|     +-- shoonya_session.py
|
+-- stock_registry.py
|     Instrument metadata
|
+-- subscription_registry.py
|     Subscriber tracking/deduplication
|
+-- expiry_manager.py
|     Expiry detection/cleanup
|
+-- api.py
|     REST/API input
|
+-- events.py
|     Domain events
|
+-- models.py
|     Schemas/models
|
+-- validators.py
|     Input validation
|
+-- repository.py
|     Persistence access
|
+-- exceptions.py
|     Domain errors

============================================================
24. MODULE RESPONSIBILITIES
============================================================

session_store.py
- broker session state
- session timestamps
- session errors
- lifecycle

stock_registry.py
- symbol
- token
- exchange
- expiry
- status

subscription_registry.py
- subscriber -> instrument relationship
- duplicate prevention
- reference tracking
- active subscriber calculation

expiry_manager.py
- expiry check
- EXPIRED transition
- cleanup trigger
- STOCK_EXPIRED event

api.py
- request handling
- validation
- service invocation
- response formatting

events.py
- event definitions
- event publishing

service.py
- module coordination
- business orchestration
- giant catch-all logic nahi banna chahiye

============================================================
25. EVENT CONTRACT
============================================================

Session events:
SESSION_READY
SESSION_EXPIRED
SESSION_ERROR
SESSION_LOGOUT_COMPLETED

Stock events:
STOCK_ADDED
STOCK_UPDATED
STOCK_REMOVED
STOCK_EXPIRED

Subscription events:
SUBSCRIPTION_ADDED
SUBSCRIPTION_REMOVED
SUBSCRIPTION_ACTIVATED
SUBSCRIPTION_DEACTIVATED

============================================================
26. STOCK_ADDED EVENT
============================================================

Conceptual:

{
    "event": "STOCK_ADDED",
    "instrumentToken": "123456",
    "symbol": "NIFTY...",
    "exchange": "NFO",
    "expiry": "2026-09-24",
    "timestamp": "..."
}

WebSocket Engine:
- event receive kare.
- WebSocket active ho to subscribe kare.
- WebSocket inactive ho to next startup sync mein instrument milega.

============================================================
27. STOCK_EXPIRED EVENT
============================================================

Conceptual:

{
    "event": "STOCK_EXPIRED",
    "instrumentToken": "123456",
    "symbol": "NIFTY...",
    "expiry": "2026-09-24",
    "timestamp": "..."
}

WebSocket Engine:
- subscribed ho to unsubscribe kare.

Session Manager:
- us instrument ke baad live tick receive/process nahi karega.

============================================================
28. SESSION MANAGER + SCHEDULER
============================================================

Scheduler decides WHEN.

Session Manager maintains SESSION STATE.

08:50:
Scheduler -> broker login trigger
Session Manager -> Kotak/Shoonya login independently

08:55:
Scheduler -> WebSocket start trigger
WebSocket Engine -> Session Manager se active list

03:16 PM:
Scheduler -> Square-off trigger
Square-Off Engine -> square-off execution

Session Manager apni session responsibility par rahega.

============================================================
29. SESSION MANAGER + WEBSOCKET ENGINE
============================================================

Startup:
WebSocket Engine
    -> get active subscriptions
    -> Session Manager
    -> active list
    -> Kotak WebSocket subscribe

Runtime add:
UI/API/Engine
    -> Session Manager
    -> STOCK_ADDED
    -> WebSocket Engine
    -> Kotak subscribe

Runtime expiry:
Expiry Manager
    -> STOCK_EXPIRED
    -> WebSocket Engine
    -> Kotak unsubscribe

============================================================
30. SESSION MANAGER + DUMMY ENGINE
============================================================

Dummy Engine:
- login nahi karega.
- Dummy WebSocket nahi banayega.
- Dummy session nahi rakhega.

Flow:
Kotak WebSocket
    -> WebSocket Engine
    -> live LTP
    -> Dummy Engine
    -> virtual order
    -> virtual position
    -> virtual P&L

Dummy mode se Kotak session/WebSocket disconnect nahi hoga.

============================================================
31. MULTI-BROKER ISOLATION
============================================================

Preferred:

sessions:
    kotak:
        state
        metadata
        timestamps

    shoonya:
        state
        metadata
        timestamps

Avoid one global current_session object that can cause broker collisions.

============================================================
32. PERSISTENCE STRATEGY
============================================================

Fast runtime state:
- current broker session state
- active instrument registry
- active subscription registry

MongoDB / persistent storage:
- subscription configuration if persistence required
- stock configuration if required
- audit/history
- required session metadata

LIVE TICKS:
Session Manager mein store nahi honge.

Historical/live tick persistence Data Pipeline / Market Data Storage
layer ki responsibility hogi.

============================================================
33. STARTUP RECOVERY
============================================================

Application restart:

1. Session Manager initialize.
2. Persistent stock/subscription configuration load.
3. Expired instruments mark/remove.
4. Active registry rebuild.
5. Broker session state restore/re-login as appropriate.
6. WebSocket Engine start hone par active list request.
7. Valid instruments subscribe.

Stale/expired instruments subscribe nahi hone chahiye.

============================================================
34. IDEMPOTENCY
============================================================

Same add request repeat ho to duplicate create nahi hona chahiye.

Same remove request repeat ho to crash nahi hona chahiye.

UI retries, reconnects aur network retry scenarios safe hone chahiye.

============================================================
35. FAILURE HANDLING
============================================================

Kotak login fail:
Kotak = LOGIN_FAILED
Shoonya independent.

Shoonya login fail:
Shoonya = LOGIN_FAILED
Kotak independent.

WebSocket fail:
WebSocket Engine responsibility.
Session Manager automatically session invalid assume nahi karega.

Stock expiry:
Session Manager -> EXPIRED -> active removal -> STOCK_EXPIRED.

Invalid stock:
Request reject.
Registry corrupt nahi hona chahiye.
WebSocket action nahi hona chahiye.

============================================================
36. SECURITY
============================================================

Never expose/store unnecessarily:
- password
- PIN
- OTP
- secret credentials

Logs should contain:
- broker
- operation
- state
- timestamp
- error category

Logs should NOT contain authentication secrets.

============================================================
37. OBSERVABILITY
============================================================

Useful metrics:

session_state{broker}
session_login_success_total{broker}
session_login_failure_total{broker}

active_instruments
active_subscriptions
expired_instruments_total

subscription_add_total
subscription_remove_total

Useful events/logs:
SESSION_LOGIN_STARTED
SESSION_LOGIN_SUCCESS
SESSION_LOGIN_FAILED
STOCK_ADDED
STOCK_REMOVED
STOCK_EXPIRED
SUBSCRIPTION_ADDED
SUBSCRIPTION_REMOVED

============================================================
38. RESPONSIBILITY BOUNDARY
============================================================

SESSION MANAGER:
- Broker Sessions
- Stock Registry
- Subscription Registry
- Instrument Expiry
- Session/Stock/Subscription Events
- Add/Remove Stock API

WEBSOCKET ENGINE:
- Kotak WebSocket connection
- Subscribe
- Unsubscribe
- Receive ticks
- Normalize ticks
- Distribute live feed

FEATURE ENGINE:
- Indicators
- Calculations
- Features

POSITION ENGINE:
- Positions
- Position state
- Position calculations

P&L ENGINE:
- Real-time P&L

DUMMY ENGINE:
- Virtual orders
- Virtual positions
- Virtual P&L
- Uses live Kotak feed

ORDER ENGINE:
- Real order lifecycle

SQUARE-OFF ENGINE:
- Square-off execution

SCHEDULER:
- Time/event orchestration

============================================================
39. GOLDEN RULES
============================================================

1. Session Manager live ticks receive nahi karega.
2. WebSocket Engine live ticks receive karega.
3. WebSocket startup par Session Manager se active stock list lega.
4. UI/API/engine Session Manager ke through stock add kar sakta hai.
5. Duplicate instrument ki duplicate WebSocket subscription nahi hogi.
6. Multiple subscribers allowed hain, actual feed subscription single rahegi.
7. Last subscriber remove hone par actual WebSocket unsubscribe hoga.
8. Expired instrument active list se automatically remove hoga.
9. Expiry event WebSocket Engine ko unsubscribe ke liye notify karega.
10. Kotak aur Shoonya sessions independently operate karenge.
11. Dummy mode ka separate session/WebSocket nahi hoga.
12. Dummy mode select karne se Kotak session/WebSocket disconnect nahi hoga.
13. Session Manager historical/live tick storage engine nahi banega.
14. Sensitive credentials logs/UI/runtime responses mein expose nahi honge.
15. Session Manager state ownership rakhega; WebSocket, Feature, P&L,
    Order aur Position processing respective engines mein rahegi.

============================================================
40. FINAL END-TO-END FLOW
============================================================

                         SCHEDULER
                             |
                 +-----------+-----------+
                 |                       |
               08:50                   08:55
                 |                       |
                 v                       v
          SESSION MANAGER         WEBSOCKET ENGINE
                 |                       |
        +--------+--------+              |
        |                 |              |
      Kotak            Shoonya           |
        |                 |              |
      READY             READY            |
                                          |
                                          v
                              Get active stock list
                                          |
                                          v
                                  SESSION MANAGER
                                          |
                                          v
                                  Active subscriptions
                                          |
                                          v
                                KOTAK WEBSOCKET
                                          |
                                          v
                                    LIVE TICKS
                                          |
                 +------------------------+----------------------+
                 |              |           |         |         |
                 v              v           v         v         v
              Feature        Position      P&L      Watchlist  Dummy
              Engine         Engine       Engine      / UI      Engine

Runtime stock add:
UI / API / Engine
    -> Session Manager
    -> Stock + Subscription Registry
    -> STOCK_ADDED
    -> WebSocket Engine
    -> Kotak Subscribe

Runtime expiry:
Expiry Manager
    -> Instrument Expired
    -> Active registry removal
    -> STOCK_EXPIRED
    -> WebSocket Engine
    -> Kotak Unsubscribe

============================================================
41. FINAL DESIGN STATEMENT
============================================================

Session Manager is the authoritative manager for:

1. Broker session lifecycle
2. Stock/instrument registry
3. Subscription registry
4. Instrument expiry
5. Session/stock/subscription events

It is NOT a market-data engine.

Clean boundary:

Session Manager says:
"Kaunse instruments active/subscribed hone chahiye?"

WebSocket Engine says:
"Main un instruments ka live feed connect, subscribe, receive aur
distribute karunga."

This separation keeps the system modular, fast, independently testable,
and ready for future broker/engine expansion.

============================================================
42. CONFIGURATION (runtime settings)
============================================================

Session Manager runtime behaviour ko configurable settings ke through
control kiya jaata hai. Settings ek dedicated service
(services/session/session_manager_config.py) ke through manage hoti hain.

FIXED DEFAULTS:

| Key                        | Default | Min  | Max    | Effect |
|----------------------------|---------|------|--------|--------|
| session_lifetime_seconds   | 3600    | 300  | 86400  | New session login par apply hota hai (session expiry). |
| expiry_warning_seconds     | 900     | 60   | 3600   | Expiry-se horizon; is window ke andar instruments EXPIRING dikhte hain. |
| tick_active_window_seconds | 60.0    | 10   | 300    | Subscription ACTIVE consider hone ke liye fresh tick window. |

ARCHITECTURE:

1. Defaults in-memory constant hota hai (hamesha available).
2. Persisted value optional hai -> MongoDB collection "session_manager_config",
   per-key document (pk_key, value, default, min, max, step, description,
   updated_at, updated_by).
3. Runtime sync cache hota hai -> engines/live code bina await ke padh sakte
   hain (session_lifetime_seconds(), expiry_warning_seconds(),
   tick_active_window_seconds()).
4. Cache "cacheSource" report karta hai: mongo (persisted) ya defaults
   (Mongo down ya kabhi set nahi hua).

EFFECTIVE / LIVE APPLICATION:

- session_lifetime_seconds: mark_login_success / login par sikh ke NEW session
  par apply hota hai. Puraana active session expiry time change NAHI hota.
- expiry_warning_seconds: expiry-checks (canonical_status -> EXPIRING) live
  par apply hota hai.
- tick_active_window_seconds: fresh_tick / active-window logic live par apply
  hota hai.

UNKNOWN KEYS REJECTED:
Kisi bhi allowed key ke alawa PUT/validation reject hota hai.

RESET:
- POST /config/{key}/reset -> ek key default par.
- POST /config/reset -> sab keys default par.
- Persisted values delete; cache defaults se refresh; events published.

PERSISTENCE:
- get_config / set_config / reset_config / refresh_config async hain aur
  Mongodb I/O karte hain.
- Har setting event "session" -> event_history + engine_event_bus par best
  effort publish hota hai.
- Failures ko swallow nahi kiya jaata: async path works best effort; runtime
  cache pehle se loaded default values se kam karta rehta hai.

BOUNDARY:
- Session Manager config OWN karta hai (Session/Expiry/Subscription related).
- WebSocket Engine / broker depth / connection settings iske SCOPE MEIN NAHI
  hain (Connection Manager ka settings system hai).

FRONTEND (Session Manager page "Configuration" tab):
- Har key: current value input + Save + Reset.
- Guards: min <= value <= max; number parse MUST.
- Drafts sirf missing keys par fill hote hain -> refresh kabhi user edits
  override nahi karta.
- LIVE APPLY badge jab cacheSource = mongo (persisted).

CONFIGURATION IS NOT MARKET DATA:
Kisi bhi config se live market data generate/fabricate NAHI hota.

============================================================
43. SESSION (current session + history + diagnostics)
============================================================

SESSION STATE (GET /api/phase3/session-manager/session):

Current active session ka snapshot:
- identity:  session_id, session_reference, mode (live/scheduler),
  broker, user_id, login_source, login_time, expires_at, validated_at,
  session_duration_seconds (ACTIVE session ka ACTUAL lifetime,
  scheduler sessions ke liye config default NAHI, direct baaki info)
- lifecycle: active, lifecycle_state, state_message, remaining_seconds
- websocket: state (CONNECTED/DISCONNECTED), reconnect_count,
  connected_at, disconnected_at, disconnect_reason, last_message_at
- routing:   state, owner
- terminal_sessions: per-terminal independent sessions
- session_history: completed sessions (login_time, logout_time,
  session_duration, logout_reason, mode, broker)
- events:    recent session events (event, message, at)
- last_activity_at, last_auth_error, last_rest_error

NO SESSION SEMANTICS:
- Scheduler mode session (scheduled_expires_at ke through) 'active' ho sakta
  hai par login_source "scheduler" hota hai.
- Puraana session expire hone par STARTU me history me record hota hai.

SESSION HISTORY (GET /session/history?limit=):
- event_history.mongo_events() + recent_events() (in-memory ring) +
  session_manager snapshot ring se merge. Event hi source of truth hai.
- Ticks/dates sab real backend state se; kuch fabricate nahi.

DIAGNOSTICS (GET /api/phase3/session-manager/diagnostics):

Self-describing health of the engine + dependencies:
- engines:             registry par HAR engine ka state (registry is source).
- sessionHealth:       ok/healthy reasons.
- revisionStatus:      fully_applied boolean + desired revision.
- mongo:               connected + config collection.
- config:              effective (live) config + cacheSource.
- recentSessionEvents: count in ring.
- connections:         broker connections + last_applied_revision.
- lastRestError:       truthful last error.

SESSION+CONFIG BOUNDARY:
- Session tab UI live status dikhaata hai; koI action
  (login/logout/manual) UI se FORCE nahi kiya jaata (Scheduler decides).

============================================================
44. UI REAL-TIME CADENCE
============================================================

Session Manager page detail tabs (session / instruments / subscriptions /
sources / pins / expiry / connections / diagnostics) Connection Manager ke
"engine.status" push frames par refresh hote hain — local timer nahi.

- Har frame par active detail tab ka data refetch hota hai.
- Overview already realtime (engine.status snapshot).
- Configuration / History tabs kabhi auto-refresh NAHI hote (edit/first
  refresh user control mein).
- Instrument detail drawer (Sheet) per-instrument lifecycle events
  (/events?instrument_id=...) manual refresh + live refetch on frame.
- Counts remain truthful: desired/subscribed/active sab backend-confirmed.

============================================================
45. PERFORMANCE UPDATE (2026-10-01) — implementation 021
============================================================

See `docs/implementation/021-trade-page-realtime-performance.md` and
`docs/verification/021-trade-page-realtime-performance-verification.md`.

- `active_registry()` is now memoised on `subs_revision`
  (`_active_registry_cache` / `_active_registry_cache_rev`). The DB Writer's
  1 s registry TTL previously rebuilt the full ~2682-entry registry ~1x/s on the
  event loop (~350 ms stall/s). Safe because `mark_instrument_tick()` mutates
  `last_tick_at`/`last_update_at` without bumping revision, and no
  `active_registry()` consumer reads those fields (DB Writer classifies by
  source/expiry; Trade API reads `active`/`desired`/`state`). Returned shape is
  unchanged.
- `subscription_snapshot()` now computes `_subscribers(rec)` once per row
  (previously twice).

Ownership, the golden rules (section 39) and the "not a market-data engine"
boundary are unchanged.
