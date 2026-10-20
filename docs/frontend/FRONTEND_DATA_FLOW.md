# FRONTEND_DATA_FLOW.md

## KAUSTUBH Trading Platform - Frontend Data Flow

**Last Updated**: 2026-09-28
**Status**: ACTIVE
**Verification**: Inferred from module names and route structure. Runtime behavior NOT_VERIFIED.

---

## Dual-Transport Pattern

Every data-carrying page uses **two** transports:

```
REST (pull)  → initial load, gap recovery, mutations
WS   (push)  → live updates after initial load
```

```
┌──────────────┐
│  Page loads  │
└──────┬───────┘
       │ 1. REST fetch initial state
       ▼
  lib/backend.ts ──────► FastAPI ──────► Engines ──────► MongoDB / Broker
       │
       │ 2. state rendered
       ▼
┌──────────────┐
│  WS connect  │  GET /api/realtime/token  →  WS /ws/realtime
└──────┬───────┘
       │ 3. subscribe to topics
       ▼
  lib/realtime-ws.ts ◄──── WS#3 push events ◄──── connection_engine
       │
       ▼
  hooks (use-live-stocks, use-tick-stream)
       │
       ▼
  components re-render
```

**WS#4 (frontend → backend)** handles commands: place/cancel/modify order, subscribe/unsubscribe, engine control.

---

## Transport Selection by Data Type

| Data | Initial Load | Live Update | Mutation Transport |
|------|--------------|-------------|--------------------|
| Market ticks (LTP) | REST `/api/market-watch` | WS#3 `market.*` | — |
| Market Watch rank | REST `/api/market-watch/rank` | WS#3 `market_watch.*` | — |
| Orders | REST `/api/trading/orders` | WS#3 `orders.*` | REST or WS#4 |
| Positions | REST `/api/trading/positions` | WS#3 `positions.*` | REST `squareoff` |
| Margin | REST `/api/trading/margin` | WS#3 `margin.*` | — |
| Funds | REST `/api/trading/funds` | — | — |
| Holdings | REST `/api/trading/holdings` | — | — |
| Engine state | REST `/api/services/engines` | WS#3 `engine.status` | REST start/stop |
| Session state | REST `/api/phase3/session-manager/status` | WS#3 `session.*` | REST instrument actions |
| Scheduler | REST `/api/scheduler/status` | WS#3 `scheduler.*` | — |
| Notifications | REST `/api/notifications` | WS#3 `notifications.*` | REST read/ack |
| Alerts | REST `/api/alerts` | WS#3 `alerts.*` | REST create/delete |
| WS health | REST `/api/services/websocket/health` | WS#3 `ws_engine.*` | REST reconnect |
| Storage/DB | REST `/api/services/storage` | WS#3 `storage.*` | REST snapshot |
| Quality | REST `/api/data-quality/*` | — | REST scan |
| Watchlist | REST `/api/watchlist-engine/*` | WS#3 | REST mutations |

**Event topic names are INFERRED** from API/module naming. Actual WS#3 message envelope is `NOT_VERIFIED`.

---

## Page → Endpoint Map (Representative)

| Page | REST Endpoints |
|------|----------------|
| `/dashboard` | `/api/system/dashboard`, `/api/services/engines/summary`, `/api/system/market` |
| `/orders` | `/api/trading/orders`, `/api/trading/order/history` |
| `/positions` | `/api/trading/positions` |
| `/portfolio` | `/api/trading/positions`, `/api/trading/funds`, `/api/trading/holdings` |
| `/funds` | `/api/trading/funds` |
| `/holdings` | `/api/trading/holdings` |
| `/market-watch` | `/api/market-watch/*` (40 routes) |
| `/live-ticks` | `/api/ticks/recent`, `/api/ticks/stats` |
| `/notifications` | `/api/notifications/*` |
| `/services/session-manager/*` | `/api/phase3/session-manager/*` (29 routes) |
| `/services/scheduler/*` | `/api/scheduler/*`, `/api/schedule-events/*` |
| `/services/websocket-engine` | `/api/services/websocket/*` (44 routes) |
| `/services/order-engine/*` | `/api/trading/*`, `/api/baskets/*` |
| `/services/connection-manager/*` | `/api/realtime/*`, `/api/services/websocket/connections` |
| `/data-saver/*` | `/api/data-saver/insights/*`, `/api/data-quality/*`, `/api/downloads/*` |
| `/settings` | `/api/settings/*` |
| `/trading/*` | `/api/trading/*`, `/api/terminal/*` |
| `/search` | `/api/search`, `/api/trading/search-local` |
| `/system` | `/api/system/*` |

**NOT VERIFIED**: Exact endpoint-to-page binding requires reading each `page.tsx`.

---

## Realtime Client Lifecycle

```
1. Component mounts → use-realtime-client
2. GET /api/realtime/token          (short-lived auth token)
3. new WebSocket(ws://host/ws/realtime?token=...)
4. onopen   → send subscribe messages for mounted topics
5. onmessage → route to subscribed consumers
6. onclose  → reconnect with backoff
                • re-fetch REST to fill the gap
                • re-subscribe
7. onunmount → unsubscribe + close
```

**Gap recovery** is essential: events during disconnect are lost, so the client re-fetches authoritative state via REST after reconnect.

---

## Error & Staleness Handling

| Situation | UI Behavior (per project rules) |
|-----------|-------------------------------|
| No data | `NO_DATA` — not zeros, not blank |
| Stale data | `STALE` badge with age indicator |
| Unknown value | `UNKNOWN` — never guess |
| WS disconnected | Connection indicator; fall back to REST polling |
| Backend 503 (Mongo down) | Service-unavailable banner |
| Auth expired | Redirect to `/login` |

**Rule**: The frontend never computes official values (ranking, margin, eligibility). It renders backend results.

---

## Form Submission (WS#4 Example)

```
Order entry form (react-hook-form + zod)
  → client-side validation
  → lib/trading-service.ts
  → WS#4 { type: "place_order", payload }
     (or REST POST /api/trading/order/place)
  → backend validates → risk → margin → audit
  → broker call
  → WS#2 → order_feed_manager
  → WS#3 { type: "order_update", payload }
  → frontend order table updates
```

**WS#4 availability check**: If WS#4 is unavailable, REST fallback exists. `NOT_VERIFIED` whether the client implements automatic fallback.

---

## Caching

**UNKNOWN**. No evidence of a caching layer (SWR, React Query, Next.js fetch cache) was confirmed. Likely pattern is `useEffect` + local state.

---

## Related Documents
- `FRONTEND_ARCHITECTURE.md` — Component/library structure
- `FRONTEND_ROUTE_MAP.md` — Route inventory
- `../architecture/WEBSOCKET_ARCHITECTURE.md` — WS channel design
- `../api/API_CATALOG.md` — Backend endpoints
- `../DATA_FLOW_MAP.md` — End-to-end flows
