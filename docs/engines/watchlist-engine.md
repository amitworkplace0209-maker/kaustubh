**STATUS: MIGRATED 2026-09-23 — now 4-WS (WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend per 08_WEBSOCKET_ARCHITECTURE.md).**

Today 12:04 AM
to mere project me  bahut se engine se bnaya hai enginmtlb project alg alg componete  ab unka list niklana hai or kon sa engine well defie hai or project folw kasa hai kon sa engin bna gya hai or kitna kam kr rha hai or kon sa engin ka doc .md file abhi bna hai or kiska bna hua hai ye sab reopt bna ke do or list bhi ahr conpornte or project acn kro or C:\project\docs\ARCHITECTURE.md ko upadte krne  bolo or chat me ak reot file bna ke do   or C:\project\docs\ARCHITECTURE.md ko flow or point time or detils ke sath updatr kro  bto kon sa model select kru es  kam ke liye or promt do master wala  ollama nhi baki koe or 
ENGINE_INVENTORY(1).md
File
ENGINE_AUDIT_REPORT.md
File
Direct Answer & Key Points:

Haan, exactly — agar tum intended architecture aisa rakhna chahte ho, to Watchlist Engine ka WebSocket Engine ke saath direct lena-dena nahi hoga.

Watchlist Engine ? Connection Manager: stock list/details dega aur live data receive karega.
WebSocket Engine broker se live feed handle karega, lekin Watchlist Engine usko directly call nahi karega.
Watchlist Engine ko jo live stock data chahiye, woh Connection Manager ke through milega.
Naya stock add hua ? Watchlist Engine Connection Manager ko stock/token details dega.
Connection Manager existing connection mein stock add karega ya required subscription handle karega.
Us stock ka live data ? Connection Manager ? Watchlist Engine ? Watchlist UI.
Reality Check & Critique:

Tumhara intended flow:

                 KOTAK
                   ¦
                   ?
            WebSocket Engine
                   ¦
                   ?
          Connection Manager
                   ¦
             +-----------+
             ¦           ¦
             ?           ?
      Watchlist Engine   Other consumers
             ¦
             ?
        Watchlist Page

Aur Watchlist Engine ka Connection Manager ke saath interface roughly:

Watchlist Engine
      ¦
      ¦  "Mujhe ye stocks chahiye"
      ?
Connection Manager
      ¦
      ¦  live stock updates
      ?
Watchlist Engine
      ¦
      ¦ refined watchlist data
      ?
Watchlist UI

Yahi boundary documentation mein clearly lock karni chahiye.

Problems & Risk Points:

Ek cheez confirm karni padegi: agar current code mein watchlist_engine.py directly websocket_engine import/use karta hai, to tumhari desired architecture aur current implementation alag hain. Abhi bina code dekhe main ye claim nahi karunga ki current implementation exactly isi tarah hai.

Upgrades & Next Steps:

Watchlist Engine ke liye ab hum ye rule maan kar design discuss kar sakte hain:

No direct Watchlist Engine ? WebSocket Engine communication.

Primary interface:

Watchlist Engine ? Connection Manager

Aur next hum specifically discuss karenge:

1. Watchlist Engine Connection Manager ko stock add karte waqt exactly kya data dega?
Symbol? Token? Exchange? Instrument ID? Watchlist ID?

2. Connection Manager Watchlist Engine ko live tick ka exact payload kya dega?

3. Watchlist Engine us payload ko kaise refine karke Stock Card ko dega?

Ye 3 cheezein lock hone ke baad watchlist-engine.md banana safe hoga.

Clarify the Watchlist–Connection Manager contract

Define the stock-add request payload
Define the live tick response payload
ab to flow hua data ka ab wtchlist engine or ui pafge ka ka feture bto 
Direct Answer & Key Points:

Watchlist Engine + Watchlist UI Page ka feature set mainly 4 parts mein hoga: user watchlists, live stock cards, dynamic market watchlists, aur advanced filters/metrics.

1. User Custom Watchlist

UI par user apni watchlist bana sake:

My Watchlist
+-- Add Watchlist
+-- Rename
+-- Delete
+-- Stocks
    +-- Add Stock
    +-- Remove Stock
    +-- Reorder

Example:

My Stocks
[RELIANCE] [TCS] [INFY] [HDFCBANK]
2. Live Stock Cards

Watchlist mein selected stock ka live card:

RELIANCE
?1,425.40

+12.40
+0.88%

Volume     18.2L
Bid        ?1,425.35
Ask        ?1,425.45
Spread     ?0.10

5 Min      +0.42%
10 Min     +0.71%

? LIVE

Tick aate hi sirf us stock ka card update hona chahiye, poora page nahi.

3. Dynamic Watchlists

User predefined/dynamic market lists dekh sake:

Market Watch
¦
+-- Top Gainers
+-- Top Losers
+-- Price Gainers
+-- Price Losers
+-- % Gainers
+-- % Losers
+-- +1% Movers
+-- -1% Movers
+-- 5 Min Gainers
+-- 5 Min Losers
+-- 10 Min Gainers
+-- 10 Min Losers

Ye lists live market data ke according automatically change hongi.

Example:

5-Min Gainers

RELIANCE    +1.42%
TCS         +1.17%
INFY        +0.94%
SBIN        +0.81%

Agar next tick/interval par ranking change hoti hai, list dynamically update hogi.

4. Advanced Custom Watchlist

User apne conditions bana sake:

Create Smart Watchlist

Name:
"Fast Movers"

Conditions:
Price Change > +1%
AND
5 Min Change > +0.50%
AND
Volume > X

[Create]

Result:

Fast Movers
----------------
RELIANCE
TCS
INFY
...
Reality Check & Critique:

UI aur Engine ki responsibility alag rakho.

Watchlist UI Page

UI ka kaam:

Watchlists display karna
Stock cards/table render karna
Search/Add/Remove controls
Filters/sorting controls
Dynamic-watchlist selection
User interaction
Live updates render karna
Watchlist Engine

Engine ka kaam:

Watchlist state maintain karna
Stock add/remove process karna
Connection Manager ko required stocks dena
Incoming live data ko watchlist stocks se map karna
Data refine/normalize karna
1%, 5-min, 10-min metrics maintain/calculate karna
Dynamic watchlist conditions evaluate karna
Rankings generate/update karna
UI ko clean structured data dena
Problems & Risk Points:

Sabse important: 5-min/10-min watchlist ko sirf current LTP se calculate nahi kar sakte.

Engine ko reference price/time maintain karna padega:

10:00 ? ?100
10:05 ? ?102
         +2%

10:10 ? ?103
         +3%

Aur Top Gainer ke liye universe bhi define karna padega:

Top Gainer
    ?
600+ stock universe?
    ?
Ya sirf user's subscribed stocks?
    ?
Ya selected market segment?

Ye specification mein explicitly define karna hoga.

Upgrades & Next Steps:

Phase 1/2 ke liye Watchlist UI ko main conceptual structure mein aise rakhunga:

WATCHLIST PAGE
¦
+-- Watchlist Selector
¦   +-- My Watchlist
¦   +-- Custom Watchlist
¦   +-- Dynamic Watchlists
¦
+-- Search & Add Stock
¦
+-- Stock Cards / Table
¦   +-- Symbol
¦   +-- LTP
¦   +-- Change
¦   +-- Change %
¦   +-- Volume
¦   +-- Bid
¦   +-- Ask
¦   +-- Spread
¦   +-- 5-Min %
¦   +-- 10-Min %
¦   +-- Status
¦
+-- Live Updates
    +-- Connection Manager
Refined Perspective:

Watchlist Engine = brain of Watchlist.
Watchlist Page = visual interface.

USER
 ¦
 ?
Watchlist Page
 ¦
 ¦ add/remove/filter/create
 ?
Watchlist Engine
 ¦
 +-- watchlist management
 +-- live-data processing
 +-- advanced metrics
 +-- dynamic screening
 +-- ranking
 ¦
 ?
Connection Manager
 ¦
 ?
Live Data
 ¦
 ?
Watchlist Engine
 ¦
 ?
Watchlist Page

Ab feature scope lock karne ke liye next discussion specifically “Watchlist Page par exactly kya-kya UI features honge” par karna chahiye; uske baad engine ke features final karke detailed doc banayenge.

Define the watchlist contract

Design the Watchlist UI page
Map the end-to-end data flow
Define Watchlist Engine features
thik ab wthchlist engin ka detils flow digream doc bna ke jisme ui or angin dono ka feture or detils do 
Direct Answer & Key Points:

Watchlist Engine + Watchlist UI ka detailed flow document bana diya hai, aur documentation checklist mein Watchlist Engine ko COMPLETE mark kiya hai.

UI features: search, add/remove, custom watchlists, cards/table, filters, sorting, live status.
Engine features: watchlist management, live-data processing, normalization, advanced metrics, dynamic screening, ranking.
Connection Manager contract aur end-to-end live-data flow included.
Phase 1 aur Phase 2 scope separately defined.
Current implementation vs proposed Phase 1/2 design ko explicitly separate kiya hai, taaki future feature ko accidentally “already implemented” na samjha jaye.
5-min/10-min metrics, Top Gainers/Losers, ±1% movers aur dynamic screening included.

Document: 
Download watchlist-engine-detailed.md

Reality Check & Critique:

Audit ke according current watchlist_engine active, native EngineBase, auto-started aur TICK_VALIDATED events consume karta hai, aur LTP cache maintain karta hai.

Lekin current audit inventory mein Watchlist Engine ka dependency websocket_engine via event bus listed hai. Isliye document mein tumhari desired Connection Manager boundary ko target architecture ke roop mein clearly mark kiya hai; ise current code ka verified fact nahi banaya.

Problems & Risk Points:

Document mein 4 items intentionally unchecked rakhe hain:

Exact Connection Manager API payload
Actual 5-min/10-min implementation
Actual dynamic-screening implementation
Dedicated Watchlist Engine tests

Audit mein dedicated test_watchlist_engine.py bhi nahi mila tha.

Upgrades & Next Steps:

Checklist status:

1. feature_engine       ?
2. scheduler_engine     ?
3. session_manager      ?
4. websocket_engine     ?
5. db_writer_engine     ?*
6. watchlist_engine     ?

* db_writer_engine ka spec-vs-implementation reconciliation abhi separate issue hai.

Next hum 7th engine — search_engine — par isi process se kaam kar sakte hain: pehle flow/features lock, phir detailed doc, phir checklist tick.

Continue with the watchlist design

Specify the Watchlist Engine APIs
Define the Watchlist UI screens
Create the end-to-end sequence diagram 
watchlist-engine-detailed.md
Document

Library
/
kds
/
watchlist-engine-detailed.md
Watchlist Engine — UI & Engine Detailed Flow
1. Purpose

The Watchlist system provides a real-time market-watch experience for Phase 1/2.

Users can:

Search and select stocks.
Add/remove stocks from watchlists.
Create custom watchlists.
View live stock cards/table data.
Use dynamic market watchlists.
Filter, sort and monitor advanced price-movement metrics.

The Watchlist Page is the frontend interaction/presentation layer. The Watchlist Engine is the backend orchestration layer for watchlist state, live-data processing, derived metrics, dynamic screening and ranking.

2. Responsibility Boundary
Watchlist Page
Watchlist selection/navigation.
Search UI.
Add/remove stock actions.
Create/rename/delete watchlist UI.
Filters and sorting controls.
Stock card/table rendering.
Dynamic-watchlist selection.
Loading/empty/error/connection states.
Incremental live-update rendering.
Watchlist Engine
Watchlist state and symbol registry.
Process live data relevant to watchlists.
Normalize/refine data into stable Watchlist fields.
Calculate derived metrics such as change %, 5-minute % and 10-minute %.
Apply dynamic screening rules.
Rank/sort dynamic results.
Send required stock/subscription details to Connection Manager.
Map incoming live updates to the correct watchlists.
Connection Manager
Live backend-to-frontend connection/channel.
Receive Watchlist Engine stock/subscription requirements.
Maintain/extend the live stock delivery path.
Deliver live Watchlist data.
WebSocket Engine
Broker/Kotak market-feed connectivity.
Broker-side market-data stream handling.

Target architecture rule: Watchlist Engine communicates with the live-data/connection layer through Connection Manager rather than directly with the broker WebSocket Engine.

3. High-Level Architecture
                         KOTAK / BROKER
                               |
                               v
                       WebSocket Engine
                               |
                               v
                      Connection Manager
                               |
                               | live stock data
                               v
                    +---------------------+
                    |   Watchlist Engine  |
                    |                     |
                    | Watchlist State     |
                    | Live Data Processing|
                    | Metrics             |
                    | Dynamic Screening   |
                    | Ranking             |
                    +----------+----------+
                               |
                         refined data
                               |
                               v
                       Watchlist Page
                               |
                    +----------+----------+
                    |                     |
               User actions          Live rendering
                    |                     |
                    +----------+----------+
                               |
                               v
                       Watchlist Engine
4. End-to-End Data Flow
A. Open Watchlist Page
User
 -> Watchlist Page
 -> Request watchlist state
 -> Watchlist Engine
 -> watchlists + symbols + cached data + status
 -> Watchlist Page
B. Search and Add Stock
Watchlist Page
 -> Search Stock
 -> Select Instrument
 -> Add to Watchlist
 -> Watchlist Engine
 -> Register symbol/token
 -> Send required stock details to Connection Manager
 -> Connection Manager
 -> Add to existing live stock list/subscription
    OR establish required connection path
 -> Live data
 -> Connection Manager
 -> Watchlist Engine
 -> Refine/normalize/calculate
 -> Watchlist Page
 -> New stock card updates live
C. Existing Connection + New Stock
Watchlist Engine
 -> Connection Manager: ADD RELIANCE
 -> existing live connection/subscription
 -> RELIANCE live feed
 -> Connection Manager
 -> Watchlist Engine
 -> RELIANCE card

A new connection should not be created unnecessarily for every stock.

D. Remove Stock
Watchlist Page
 -> Remove RELIANCE
 -> Watchlist Engine
 -> remove from relevant watchlist
 -> update active-symbol set
 -> Connection Manager
 -> unsubscribe/remove only when no consumer still requires it
5. Watchlist Management
Personal Watchlists
My Watchlists
+-- My Stocks
+-- Intraday
+-- Banking
+-- IT
+-- High Volume

Operations:

Create.
Rename.
Delete.
Select.
Add stock.
Remove stock.
Reorder.
Prevent unintended duplicates.
Custom Watchlists

Example:

Banking Stocks
HDFCBANK
ICICIBANK
SBIN
AXISBANK
KOTAKBANK
6. Live Stock Card

The Watchlist Engine should expose a stable, normalized data model.

{
  "symbol": "RELIANCE",
  "exchange": "NSE",
  "ltp": 1425.40,
  "change": 12.40,
  "changePercent": 0.88,
  "volume": 1823400,
  "bid": 1425.35,
  "ask": 1425.45,
  "spread": 0.10,
  "fiveMinPercent": 0.42,
  "tenMinPercent": 0.71,
  "lastTick": "2026-09-18T10:15:20",
  "status": "LIVE"
}

Card fields:

Symbol.
Exchange.
LTP.
Absolute change.
Change %.
Volume.
Bid.
Ask.
Spread.
5-minute %.
10-minute %.
Last tick.
LIVE/STALE/CONNECTING/DISCONNECTED status.

A tick should update only the affected stock card rather than force a full Watchlist Page rerender.

7. Advanced Metrics
Current Change

Change = Current LTP - Reference Price

Current Change %

Change % = ((Current LTP - Reference Price) / Reference Price) × 100

5-Minute %

5-Min % = ((Current LTP - 5-Min Reference Price) / 5-Min Reference Price) × 100

10-Minute %

10-Min % = ((Current LTP - 10-Min Reference Price) / 10-Min Reference Price) × 100

Reliable 5-minute/10-minute metrics require maintaining the relevant historical/reference prices.

8. Dynamic Watchlists

Examples:

Top Gainers
Top Losers
Price Gainers
Price Losers
% Gainers
% Losers
+1% Movers
-1% Movers
5-Min Gainers
5-Min Losers
10-Min Gainers
10-Min Losers

Dynamic flow:

Live Market Data
 -> Watchlist Engine
 -> calculate metrics
 -> apply rule
 -> filter
 -> sort/rank
 -> dynamic result
 -> Connection Manager
 -> Watchlist Page
9. Advanced Custom Screening

Phase 2 can support rules such as:

Name: Fast Movers

Change % > 1%
AND
5-Min % > 0.50%
AND
Volume > configured threshold

The engine should evaluate rules against normalized market data rather than making the frontend perform the calculations.

10. Ranking

Examples:

Top Gainers: Change % descending.
Top Losers: Change % ascending.
Price Gainers: absolute price change descending.
5-Min Gainers: 5-Min % descending.
10-Min Losers: 10-Min % ascending.

Tie-breaking should be deterministic.

11. Connection Manager Contract

Conceptually:

{
  "watchlistId": "my-stocks",
  "symbols": [
    {
      "symbol": "RELIANCE",
      "exchange": "NSE",
      "token": "..."
    },
    {
      "symbol": "TCS",
      "exchange": "NSE",
      "token": "..."
    }
  ]
}

The exact production payload must follow the actual Connection Manager API.

Live direction:

Connection Manager
 -> Watchlist Engine
 -> normalize/calculate/screen
 -> Watchlist Page
12. UI Feature Map
WATCHLIST PAGE
|
+-- Header
|   +-- Active Watchlist
|   +-- Create Watchlist
|   +-- Watchlist Settings
|
+-- Search
|   +-- Search Instrument
|   +-- Select Instrument
|   +-- Add to Watchlist
|
+-- Watchlist Navigation
|   +-- My Watchlists
|   +-- Custom Watchlists
|   +-- Dynamic Watchlists
|
+-- Stock View
|   +-- Cards
|   +-- Table
|
+-- Filters
|   +-- Price
|   +-- Change %
|   +-- Volume
|   +-- 5-Min %
|   +-- 10-Min %
|
+-- Sorting
|   +-- LTP
|   +-- Change
|   +-- Change %
|   +-- Volume
|   +-- 5-Min %
|   +-- 10-Min %
|
+-- Status
    +-- LIVE
    +-- STALE
    +-- CONNECTING
    +-- DISCONNECTED
13. UI States
Empty

No stocks in this watchlist. [Search Stock]

Loading

Loading watchlist...

Connecting

Connecting to live market data...

Stale

Market data temporarily stale — Last update: ...

Error

Live data unavailable. [Retry]

The UI must not display fabricated prices when live data is unavailable.

14. Performance Requirements
Incremental stock-level updates.
No full-page rerender for every tick.
Stable symbol/token mapping.
Avoid duplicate subscriptions.
Remove subscriptions only when no consumer requires the symbol.
Efficient dynamic ranking.
Avoid sending unchanged fields unnecessarily.

Preferred behavior:

Tick for TCS
 -> process TCS
 -> update TCS state
 -> send TCS update
 -> render TCS card

Not:

Tick for TCS
 -> reload entire watchlist
 -> rerender every card
15. Lifecycle
Startup
Application startup
 -> Watchlist Engine initialization
 -> initialize/load watchlist state
 -> prepare live-data processing
 -> ACTIVE

The repository audit verifies that watchlist_engine is implemented as a native EngineBase, auto-started from application lifespan, and consumes validated tick events in the current implementation.

Shutdown
Application shutdown
 -> stop Watchlist Engine
 -> clean active subscriptions/state
 -> release resources
16. Current Implementation vs Target Design
Verified current implementation

The repository audit identifies:

python-service/services/watchlist_engine.py.
Native EngineBase.
Implemented + Active.
Auto-started from app.py lifespan.
Maintains an LTP cache per watchlist symbol.
Event-driven TICK_VALIDATED consumer.
Existing watchlist-engine.md is card-level.
No dedicated test_watchlist_engine.py was found in the audit.
Target Phase 1/2 design

This document additionally defines:

Watchlist Page ? Watchlist Engine contract.
Connection Manager as live-data/connection boundary.
Stable normalized stock data model.
5-minute and 10-minute metrics.
Dynamic screening.
Ranking.
Advanced custom rules.
Explicit live/stale/connecting/disconnected UI states.

These target features must not be treated as implemented unless verified in source.

17. Important Architectural Rule

Desired dependency direction:

WebSocket Engine
 -> Connection Manager
 -> Watchlist Engine
 -> Watchlist Page

Stock requirement direction:

Watchlist Page
 -> Watchlist Engine
 -> Connection Manager
 -> live market data

The Watchlist Engine should not create independent broker WebSocket connections per stock.

18. Failure Handling
Subscription failure
Keep pending/error state.
Do not show fake live values.
Surface status to UI.
Feed interruption
Preserve last known data with stale status.
Do not claim stale values are live.
Recovery/reconnection remains with the live connection layer.
Duplicate request
Deduplicate by canonical instrument identity/token.
Same stock in multiple watchlists

One active live subscription should serve all relevant watchlists.

19. Phase Split
Phase 1 — Core Watchlist
[?] Watchlist Page
[?] Search Stock
[?] Add Stock
[?] Remove Stock
[?] Custom Watchlist
[?] Live Stock Cards
[?] LTP
[?] Change
[?] Change %
[?] Volume
[?] Bid / Ask
[?] Spread
[?] Live Status
[?] Connection Manager integration
Phase 2 — Advanced Watchlist
[ ] Multiple custom watchlists
[ ] Reordering
[ ] 1% up/down movers
[ ] 5-minute %
[ ] 10-minute %
[ ] Top Gainers
[ ] Top Losers
[ ] Price Gainers
[ ] Price Losers
[ ] Percentage Gainers/Losers
[ ] Dynamic screening
[ ] User-defined screening rules
[ ] Dynamic ranking
[ ] Advanced filters
20. Watchlist Engine Documentation Checklist

Watchlist Engine identified and verified as active.

UI ? Engine responsibility boundary defined.

Add/remove stock flow defined.

Connection Manager contract defined conceptually.

Live-data processing flow defined.

Refined stock data model defined.

Advanced metrics defined.

Dynamic watchlist concept defined.

Ranking model defined.

UI feature map defined.

Loading/empty/error states defined.

Performance requirements defined.

Lifecycle defined.

Current implementation vs target design separated.

Exact Connection Manager API payload verified against source.

Exact 5-minute/10-minute implementation verified against source.

Exact dynamic-screening implementation verified against source.

Dedicated Watchlist Engine tests added/verified.

21. Final Flow
+------------------------------+
|        WATCHLIST PAGE        |
| Search / Add / Remove        |
| Create / Select Watchlist    |
| Filter / Sort                |
| Dynamic Watchlists           |
| Stock Cards / Table           |
+---------------+--------------+
                |
                | user actions
                v
+------------------------------+
|       WATCHLIST ENGINE       |
| Watchlist Management         |
| Symbol Registry              |
| Live Data Processing         |
| Data Normalization           |
| Advanced Metrics             |
| Dynamic Screening            |
| Ranking                      |
+---------------+--------------+
                |
                | stock/subscription requirements
                v
+------------------------------+
|      CONNECTION MANAGER      |
| Live Connection / Delivery   |
| Active Stock List            |
+---------------+--------------+
                |
                | live market data
                v
+------------------------------+
|       WEBSOCKET ENGINE       |
| Kotak/Broker Feed            |
| Market Data Stream           |
+---------------+--------------+
                |
                v
        Connection Manager
                |
                v
        Watchlist Engine
                |
       refine / calculate / rank
                |
                v
        Watchlist Page
Documentation Status

Watchlist Engine detailed design: COMPLETE

The remaining unchecked items are implementation/source-verification items, not reasons to leave the documentation card incomplete.
