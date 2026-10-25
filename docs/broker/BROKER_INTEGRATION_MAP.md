# BROKER_INTEGRATION_MAP.md

## KAUSTUBH Trading Platform - Broker Integration Map

**Last Updated**: 2026-09-28
**Status**: ACTIVE
**Verification**: Adapter files confirmed. Capability mapping inferred from SDKs; `NOT_VERIFIED` at runtime.

---

## Broker Roster

| # | Broker | SDK | Role | Module |
|---|--------|-----|------|--------|
| 1 | **Kotak Neo** | `kotakneoapi` 3.0.7 | Primary (trading + market data) | `brokers/kotak_adapter.py` |
| 2 | **Shoonya** | `NorenRestApiOAuth` 0.0.41 | Secondary | `brokers/shoonya_adapter.py` |
| 3 | **Dummy** | none (mock) | Paper trading | `brokers/dummy.py` |

**Supporting modules** (existence confirmed; logic not audited):
- `brokers/manager.py` — active broker selection & routing
- `brokers/registry.py` — adapter registry

---

## Capability Matrix

| Capability | Kotak Neo | Shoonya | Dummy |
|-----------|-----------|---------|-------|
| Login (auth) | TOTP + MPIN (`totp`, `verify_password_otp`) | OAuth code flow | Mock (any string) |
| Session refresh | `refresh_token` | OAuth token | N/A |
| Logout | Yes | Yes | Reset |
| Instrument search | `search_instruments` | Yes | Local mock list |
| Quote (single) | `quote` | Yes | Simulated |
| Quotes (batch) | `quotes` | Yes | Simulated |
| LTP | `ltp` | Yes | Simulated |
| OHLC | `ohlc` | Yes | Simulated |
| Depth (5-level) | `depth` | Partial | No |
| Historical minute | `get_instrument_history` | Yes | No |
| Market status | `market_status` | Yes | Fixed calendar |
| **Place order** | `place_order` | Yes | Mock accepted |
| **Modify order** | `modify_order` | Yes | Mock |
| **Cancel order** | `cancel_order` | Yes | Mock |
| Order status | `order_status` | Yes | Mock |
| Order report | `order_report` | Yes | Mock |
| Trade report | `trade_report` | Yes | Mock |
| Positions | `positions` | Yes | Simulated |
| Holdings | `holdings` | Yes | Simulated |
| Funds | `funds` | Yes | Simulated funds |
| **Market data WS** | SFeed (WS#1) | WebSocket | Uses live Kotak LTP |
| **Order/position WS** | OrderFeed (WS#2) | — | No |
| Square-off | Via `place_order` | Via `place_order` | Mock |
| Basket orders | Sequence of `place_order` | Sequence | Mock |

---

## Kotak Neo Integration Detail

**Auth flow**:
```
1. GET /api/auth/manual-login  (or scheduler 08:50 trigger)
2. Backend reads CLIENT_ID, CONSUMER_KEY, MOBILE_NUMBER, MPIN, TOTP_SECRET
3. neo_api.totp(totp=TOTP_SECRET)  → TOTP code
4. neo_api.verify_password_otp(totp_code)  → session token
5. Store token in kotak_client / session manager
```

**Market data**: WS#1 SFeed — subscribe by instrument token + feed (`CM`, `FO`, `NFO`).

**Order feed**: WS#2 — order and position updates pushed by broker.

**REST fallback**: When WS#2 unavailable, poll `order_status` / `order_report` / `trade_report` and `positions`.

**Config (SECRET)**: `client_id`, `consumer_key`, `mobile_number`, `mpin`, `totp_secret` — backend-only.

---

## Shoonya Integration Detail

**Auth flow**:
```
1. GET /api/terminal/oauth-link  → returns Shoonya login URL
2. User authenticates, redirected to SHOONYA_REDIRECT_URL
3. POST /api/terminal/oauth-code  { code }  → exchange for session token
4. Store token
```

**Config (SECRET)**: `shoonya_api_key`, `shoonya_secret_key`, `shoonya_user_id`, `shoonya_account_id`, `shoonya_redirect_url`

**Routes**: `shoonya_router` under `/api/shoonya` (in `api/terminal.py`; route details assembled dynamically — `NOT_VERIFIED`).

---

## Dummy (Paper Trading) Integration Detail

**Purpose**: Simulate full trading lifecycle without real money, using live market prices.

**Behavior**:
- Maintains in-memory/virtual portfolio
- Accepts orders, tracks fills, positions, funds
- Uses live Kotak LTP (via WS#1) for realistic pricing
- Full REST surface: 48 endpoints under `/api/dummy/*`
- Supports alerts, targets, watchlists, baskets, calendar events, notifications, comparisons, audit

**Key routes**:
```
GET  /api/dummy/portfolio        GET  /api/dummy/holdings
GET  /api/dummy/positions        GET  /api/dummy/risk
POST /api/dummy/order/place      POST /api/dummy/order/cancel
POST /api/dummy/order/modify     POST /api/dummy/position/squareoff
GET  /api/dummy/history          GET  /api/dummy/audit
POST /api/dummy/session/reset    POST /api/dummy/reset
GET  /api/dummy/prefs            POST /api/dummy/prefs
```

**Config**: `broker_mode=dummy` selects it.

---

## Broker Selection & Routing

**Config**:
```
broker_mode    = kotak | shoonya | dummy
kotak_enabled  = true | false
shoonya_enabled = true | false
```

**Selection API**:
```
GET  /api/services/engines/broker/status
GET  /api/services/engines/broker/list
GET  /api/services/engines/broker/trading         (active trading broker)
GET  /api/services/engines/broker/market-data     (active MD broker)
POST /api/services/engines/broker/trading/select  { broker }
POST /api/services/engines/broker/market-data/select { broker }
```

**Architectural note**: Trading broker and market-data broker are **separable** — e.g. Kotak for orders, Shoonya for quotes. This is an intentional design for resilience.

**Failover**: `06_BROKER_ARCHITECTURE.md` documents automatic Kotak → Shoonya → Dummy failover. `brokers/manager.py` exists. **Actual failover logic NOT_VERIFIED** — read the module to confirm.

---

## Broker Terminal (Per-Broker Sessions)

**Module**: `api/terminal.py` (`terminal_router` under `/api/terminal`)

```
GET  /api/terminal/list                     list terminals
GET  /api/terminal/state                    current state
POST /api/terminal/switch                   switch active terminal
POST /api/terminal/connect                  connect broker session
POST /api/terminal/disconnect               disconnect
GET  /api/terminal/oauth-link               Shoonya OAuth URL
POST /api/terminal/oauth-code               exchange code
GET  /api/terminal/account/{terminal}       account info
GET  /api/terminal/positions/{terminal}     positions for terminal
GET  /api/terminal/holdings/{terminal}      holdings for terminal
GET  /api/terminal/orders/{terminal}        orders for terminal
GET  /api/terminal/orders/{terminal}/{id}/history
GET  /api/terminal/trades/{terminal}        trades
GET  /api/terminal/search | /quote | /margin | /audit
POST /api/terminal/order | /order/modify | /order/cancel
POST /api/terminal/order/square-off | /order/basket
GET  /api/terminal/targets   POST /api/terminal/target   DELETE /api/terminal/target/{symbol}
```

---

## Security Boundary

```
Backend process
  ├── kotak_adapter    → holds CLIENT_ID, CONSUMER_KEY, MPIN, TOTP_SECRET
  ├── shoonya_adapter  → holds SHOONYA_* secrets
  └── dummy            → no secrets
        │
        │  REST + WS (no credentials to frontend)
        ▼
Frontend
  └── NEVER receives broker credentials
  └── NEVER calls broker APIs directly
  └── All broker interaction via /api/trading/*, /api/terminal/*, /ws/realtime
```

**Verification**: `NOT_VERIFIED` — requires runtime inspection of API responses.

---

## Related Documents
- `../architecture/SDK_CATALOG.md` — SDK versions and constraints
- `../api/API_CATALOG.md` — All broker routes
- `../config/CONFIGURATION_CATALOG.md` — Broker env vars
- `06_BROKER_ARCHITECTURE.md` — Canonical broker doc (claims failover)
- `../security/SECURITY_ARCHITECTURE.md` — Credential isolation
