SEARCH ENGINE — DETAILED UI + ENGINE DESIGN

1. Purpose

Search Engine KDS ka central discovery layer hai. Ye stocks/instruments ke saath pages, features, watchlists aur approved actions ko search/suggest karega. Search Engine discover/present/route karega; order execute, risk validate, margin independently calculate, ya broker WebSocket manage nahi karega.

2. Core Flow

USER
  ↓
Search UI
  ↓ 150–300ms debounce
Search Engine
  ├─ normalize query
  ├─ detect scope/intent
  ├─ search indexed providers
  ├─ rank
  ├─ deduplicate
  └─ shape result
  ↓
Search Results
  ├─ Stock
  ├─ Page
  ├─ Feature
  ├─ Watchlist
  └─ Action

3. Runtime Model

Search Engine ko har keystroke par start/stop nahi karna hai. Infrastructure available rahega, lekin actual search work query event par hoga.

IDLE → QUERY EVENT → DEBOUNCE → SEARCH → RESULTS/EMPTY/ERROR → IDLE

Agar user r → re → rel → reli → reliance type kare, expensive search ideally latest settled query par chale.

4. Stock Search

Canonical instrument metadata source/index se:

symbol

trading symbol

company/instrument name

exchange

segment

token

instrument type

eligibility/status

searchable aliases

Search Engine broker WebSocket khud nahi kholega.

Live values canonical market-data state se aayengi:

LTP

absolute change

change %

volume

bid

ask

timestamp

freshness/status

Architecture:

Kotak WebSocket
  ↓
WebSocket Engine
  ↓
Canonical Live Market State
  ↓
Search Engine
  ↓
Stock Result

5. Stock Result Card

Target UI:

┌────────────────────────────────────┐
│ RELIANCE                            │
│ Reliance Industries Ltd             │
│ NSE                                 │
│                                    │
│ LTP             ₹1,420.50          │
│ Change          +₹18.20            │
│ Change %        +1.30%             │
│                                    │
│ 1 Qty Margin    ₹XXX.XX            │
│ ● Live                              │
│                                    │
│ [ BUY ]          [ SELL ]          │
└────────────────────────────────────┘

1 Qty Margin ka meaning: intraday/MIS mein 1 quantity position ke liye applicable required capital/margin. Is value ko Search Engine khud hard-code ya guessed leverage se calculate nahi karega.

Margin unavailable ho to:

1 Qty Margin: Unavailable

Fake value nahi.

6. Search Categories

Stocks

reliance, tcs, hdfc, infy

Pages

watchlist, market watch, orders, positions, portfolio

Features

top gainers, top losers, volume, 5 minute, 10 minute

Actions

add to watchlist, open market watch, create watchlist

Watchlists

Existing user/configured watchlists.

Architecture extensible honi chahiye taaki future provider add ho sake.

7. Query Normalization

Examples:

" reliance " → "reliance"
"RELIANCE"  → "reliance"
"Reliance Industries" → normalized searchable tokens

Processing:

trim

case normalization for matching

whitespace normalization

tokenization

safe punctuation handling

Original input UI ke liye preserve kiya ja sakta hai.

8. Ranking

Deterministic ranking:

exact symbol

exact trading symbol

symbol prefix

exact company name

company-name prefix

alias/token match

fuzzy match

Same instrument ko stable identity, preferably exchange + token, ke basis par deduplicate karein.

9. Suggestions

Typing ke time compact suggestions:

reli

RELIANCE
Reliance Industries Ltd
NSE

Market Watch
Open Market Watch

Recommended:

5–10 suggestions

keyboard navigation

Enter select

Esc close

10. Buy/Sell Flow

Search Engine direct broker order nahi bhejega.

Recommended:

Search
 ↓
Stock Card
 ↓
BUY / SELL
 ↓
Existing Order Panel
 ↓
Quantity / Order Type / Product / Price
 ↓
User confirmation
 ↓
Order Engine
 ↓
Risk Engine
 ↓
Audit Engine
 ↓
Broker Adapter

Search se instant order execute karna accidental-trade risk create karta hai. Search result sirf order intent/prefill handoff kare.

Conceptual action:

{
  "type": "OPEN_ORDER",
  "symbol": "RELIANCE",
  "token": "<TOKEN>",
  "exchange": "NSE",
  "side": "BUY",
  "source": "SEARCH"
}

Final validation downstream Order/Risk layer ki responsibility hai.

11. Watchlist Flow

Search RELIANCE
 ↓
Stock Result
 ↓
Add to Watchlist
 ↓
Watchlist Engine
 ↓
selected stock registration/subscription flow
 ↓
Connection Manager / realtime architecture
 ↓
Watchlist UI

Search Engine watchlist ownership nahi karega.

12. Market Watch Flow

Search RELIANCE
 ↓
Open in Market Watch
 ↓
Market Watch Engine

Search Engine Market Watch ranking logic duplicate nahi karega.

13. Project-Wide Search Boundary

“Anything inside project” ko unrestricted filesystem/source search nahi banana hai.

Searchable allowlisted entities:

registered pages

enabled features

watchlists

instruments

user-visible actions

configured commands

approved help/documentation entries

Directly expose nahi karna:

API keys

passwords

broker/session secrets

cookies/tokens

environment secrets

private backend data

arbitrary source code

14. API/Event Contract

Target request:

{
  "query": "reliance",
  "scope": ["stocks"],
  "limit": 10,
  "cursor": null
}

Target response:

{
  "query": "reliance",
  "results": [
    {
      "type": "stock",
      "id": "NSE:<TOKEN>",
      "symbol": "RELIANCE",
      "name": "Reliance Industries Ltd",
      "exchange": "NSE",
      "token": "<TOKEN>",
      "ltp": 1420.50,
      "change": 18.20,
      "changePct": 1.30,
      "oneQtyMargin": 250.00,
      "liveStatus": "live"
    }
  ],
  "hasMore": false
}

Ye target contract hai; current implementation ka proof nahi.

14.1 IMPLEMENTED CONTRACT (2026-09-30)

Section 14 ka target ab implemented hai. Reference:
docs/implementation/018-search-engine-single-canonical-instrument-discovery.md

Canonical route — the only instrument-discovery contract:

  GET  /api/search?q=<query>&scope=stocks&limit=10&cursor=0&withMargin=true
  POST /api/search {"query":"...","scope":["stocks"],"limit":10}
  GET  /api/search/suggest?q=...
  GET  /api/search/status

Implemented result fields (superset of the target above):

  identity   type, id, symbol, name, tradingSymbol, series,
             exchange, exchangeSegment, token, isin,
             instrumentType, lotSize, tickSize, source
  market     ltp, prevClose, change, changePct, volume,
             bid, ask, spread, upperCircuit, lowerCircuit,
             timestamp (ISO-8601 UTC), tickAgeSeconds,
             liveStatus, dataStatus
  margin     oneQtyMargin, marginStatus, marginSource, marginReason

Response envelope: query, normalized, results, total, hasMore,
nextCursor, scopes, tookMs, errorCode.

Status values use the section 15 vocabulary in UPPERCASE:
liveStatus/dataStatus in {LIVE, STALE, UNAVAILABLE};
marginStatus in {AVAILABLE, UNAVAILABLE, REQUIRES_ORDER_CONTEXT}.

Error codes: EMPTY_QUERY, QUERY_TOO_LONG, SEARCH_INVALID_SCOPE,
SEARCH_INDEX_UNAVAILABLE.

Freshness rules as implemented:

- A tick with no usable clock is NEVER LIVE. It reports STALE.
- Timestamp shapes normalized: tz-aware datetime, epoch seconds,
  epoch milliseconds, ISO-8601 string.
- A price from the local LTP cache is STALE with source="ltp_cache".
  It is never presented as live.
- Missing values are null with an explicit status. Never 0, never a guess.
- Margin comes only from the authoritative broker provider, never derived
  from LTP or leverage. A provider REQUIRES_ORDER_CONTEXT status passes
  through rather than being flattened to UNAVAILABLE.

Legacy routes (deprecated, still functional) now resolve through the SAME
index via the canonical_instrument_rows() adapter in api/search.py, keeping
their legacy envelopes:

  GET  /api/stocks/search          deprecated -> /api/search
  POST /api/stocks/search          deprecated -> /api/search
  POST /api/trading/search-local   deprecated -> /api/search
  POST /api/trading/search         broker scrip passthrough, not instrument
                                   discovery; not owned by the Search Engine
  GET  /api/market-watch/search    Market Watch engine's own universe search

Frontend shared modules — the only client/hook for instrument discovery:

  lib/instrument-search.ts          import-free types, constants, normalizer
  lib/instrument-search-client.ts   one-shot canonical client
  hooks/use-instrument-search.ts    debounce/abort/sequence/cache hook

15. State Model

Search UI:

IDLE
QUERYING
RESULTS
EMPTY
ERROR

Live stock:

LIVE
STALE
UNAVAILABLE

Margin:

AVAILABLE
UNAVAILABLE
STALE

Null/blank values se ambiguous state create nahi karni.

16. Stale Query Protection

Race condition:

A = "reli"
B = "reliance"
B returns first
A returns later

A ka response B ko overwrite nahi kare.

Possible implementation:

request ID

sequence number

AbortController

response version

17. Pagination / Limits

Suggestions:

5–10 results

Expanded search:

20–50 results/request

Exact limits configurable hon.

Thousands of results browser ko ek saath nahi bhejne.

18. Performance

Full ~2700+ intraday universe ko har keystroke par DB scan karna avoid karein.

Use:

indexed instrument search

debounce

result limits

query cache where safe

deduplication

stale request cancellation

scoped live updates

Static metadata cache ho sakta hai. LTP ko cache mein authoritative live truth na maana jaye.

19. Data Freshness

Static:

symbol

name

exchange

token

Dynamic:

LTP

change

change %

volume

bid/ask

timestamp

UI ko clearly distinguish karna chahiye:

Live / Stale / Unavailable

Market closed hone par last-known/approved value dikha sakte hain, but status clear hona chahiye.

20. Error Handling

Index unavailable

SEARCH_INDEX_UNAVAILABLE

Live state unavailable

Instrument result return ho sakta hai with liveStatus=unavailable.

Margin unavailable

oneQtyMargin unavailable.

Provider timeout

Safe partial results allowed.

Broker/session unavailable

Fake market data nahi.

21. Security

Backend must:

query length limit

query size limit

input normalization

safe DB/query construction

unsupported operators reject

authorization enforce

private data allowlist

secrets never expose/log

22. Observability

Useful metrics:

search count

latency

zero-result rate

result count

provider latency

timeout/error count

cache hit/miss

stale-request rejection

action handoff failures

Sensitive credentials/tokens logs mein nahi.

23. Testing

Unit

normalization

tokenization

ranking

deduplication

limits

scopes

empty/invalid query

Integration

Search → Instrument Index → Live State → Result
Search → BUY → Order Intent → Order Engine

Race condition

Latest query must win.

Failure

index failure

market state failure

margin failure

timeout

session unavailable

UI

suggestions

debounce

keyboard navigation

selection

BUY/SELL

loading

empty

error

24. Accessibility

keyboard navigation

visible focus

semantic labels

screen-reader-friendly result descriptions

explicit BUY/SELL labels

gain/loss/live status not conveyed by color alone

25. Mobile

Desktop:

Search bar → suggestions → result/card

Mobile:

Full-width search → compact result cards → reachable actions

26. Responsibilities by Engine

Component

Responsibility

Search Engine

Find, rank, dedupe, shape, route

Instrument Cache/Search Index

Canonical instrument metadata

WebSocket Engine

Broker live feed

Market Data State

Current live values

Margin Engine

Margin data/calculation authority where applicable

Risk Engine

Final trade validation

Order Engine

Order lifecycle/execution

Watchlist Engine

Watchlist behavior

Market Watch Engine

Market ranking/watch behavior

Connection Manager

Backend → frontend realtime bridge

Session Manager

Broker session lifecycle

27. Non-Goals

Search Engine will not:

create broker WebSocket

manage broker login/session

execute orders

bypass Risk Engine

own watchlists

own Market Watch ranking

own positions/P&L

hard-code full stock universe

expose secrets

independently invent margin values

28. Current vs Target

Current project audit identified search_engine as an active core engine for instrument metadata search and live LTP cache integration. At the audit point its documentation was basic/card-level.

UPDATE 2026-09-30: sections 1–7, 14, 15, 17–20, 23 and 30 of this document are
now implemented and live-verified for the stock path. See section 14.1 and
docs/verification/018-search-engine-single-canonical-instrument-discovery-verification.md
for the implemented contract, the live HTTP evidence, and the list of
remaining limitations. Pages / Features / Actions / Watchlists scopes
(section 6, phase 6) remain partially implemented; the stock path is complete.

Target architecture expands it into shared search infrastructure with:

stock search

suggestions

pages/features/actions/watchlists

deterministic ranking

deduplication

live market data

1 Qty Margin

safe Buy/Sell handoff

watchlist/Market Watch navigation

tests

observability

security boundaries

Target behavior ko current implementation ka proof nahi maana jana chahiye.

29. Implementation Order

Phase 1 — Core

Normalization, indexed search, ranking, dedupe, limits.

Phase 2 — Suggestions

Debounce, keyboard navigation, states.

Phase 3 — Live Data

Canonical live-state integration, LTP/change/change%, freshness.

Phase 4 — Margin

Authoritative 1 Qty Margin provider, unavailable/stale state.

Phase 5 — Actions

BUY/SELL → Order Panel, Add Watchlist, Open Market Watch.

Phase 6 — Global Search

Pages, features, actions, watchlists, approved project entities.

Phase 7 — Hardening

Race tests, performance, security, observability, accessibility, responsive UI.

30. Acceptance Checklist

Stock symbol/name search works

Suggestions use debounce

Ranking is deterministic

Duplicates removed

Stock card has symbol/name/exchange

LTP comes from canonical live state

Change and Change % are correct when available

1 Qty Margin comes from approved source

Missing margin is not fabricated

BUY opens approved order flow

SELL opens approved order flow

Search never directly executes broker orders

Search never creates broker WebSocket

Add to Watchlist handoff works

Open Market Watch handoff works

Pages/features/actions search works where enabled

Project search does not expose secrets/private data

Stale requests cannot overwrite newer results

Loading/empty/error states exist

Unit/integration/UI tests exist

Full-universe performance is acceptable

Documentation matches implemented behavior

31. Final Architecture

                 ┌──────────────────┐
                 │      USER        │
                 └────────┬─────────┘
                          ↓
                 ┌──────────────────┐
                 │    SEARCH UI     │
                 └────────┬─────────┘
                          ↓
                 ┌──────────────────┐
                 │  SEARCH ENGINE   │
                 │ Find / Rank      │
                 │ Dedupe / Route   │
                 └───┬────┬────┬────┘
                     │    │    │
                     ↓    ↓    ↓
                Stocks  Pages Actions
                     │
                     ↓
             Instrument/Search Index
                     │
                     ↓
             Canonical Live State
                     │
                     ↓
                Stock Card
                 │       │
              BUY/SELL   Add/Open
                 ↓       ↓
             Order   Watchlist/
             Panel   Market Watch
                 ↓
             Order Engine
                 ↓
             Risk Engine
                 ↓
             Audit Engine
                 ↓
            Broker Adapter

32. Refined Principle

Search Engine = Find + Rank + Present + Route.

It should remain a lightweight, reusable discovery layer. Market data, broker connectivity, margin authority, watchlist ownership, Market Watch ranking, risk, and execution must stay with their respective engines. This prevents Search Engine from becoming a dependency-heavy “god engine”.