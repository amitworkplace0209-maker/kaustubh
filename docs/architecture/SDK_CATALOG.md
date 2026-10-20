# SDK_CATALOG.md

## KAUSTUBH Trading Platform - SDK & Library Catalog

**Last Updated**: 2026-09-28
**Version**: 1.0
**Status**: ACTIVE
**Source**: `python-service/requirements.txt`, `package.json`, and import-site inspection
**Verification**: Versions are pinned in manifests. Usage sites are inferred from imports; runtime behavior NOT_VERIFIED.

---

## Broker SDKs (Proprietary)

### 1. kotakneoapi 3.0.7

| Attribute | Value |
|-----------|-------|
| **Package** | `kotakneoapi` |
| **Version** | 3.0.7 (exact pin) |
| **Vendor** | Kotak Securities |
| **License** | Proprietary (requires broker account) |
| **Type** | Broker SDK (REST + WebSocket) |
| **Criticality** | CRITICAL — primary broker |

**Capabilities**
| Capability | Method / Endpoint | Notes |
|------------|------------------|-------|
| Login (OTP) | `neo_api.totp` + `verify_password_otp` | TOTP-based OTP |
| Session refresh | `refresh_token` | |
| Search | `search_instruments` | |
| Quote (LTP) | `quote` | Single instrument |
| Quotes (batch) | `quotes` | |
| LTP field | `ltp` | |
| OHLC | `ohlc` | |
| Depth (5-level) | `depth` | |
| Historical minute | `get_instrument_history` | |
| Place order | `place_order` | |
| Modify order | `modify_order` | |
| Cancel order | `cancel_order` | |
| Order status | `order_status` | |
| Order report | `order_report` | |
| Trade report | `trade_report` | |
| Positions | `positions` | Broker-confirmed |
| Holdings | `holdings` | |
| Funds | `funds` | |
| Market status | `market_status` | |

**WebSocket Feeds**
| Feed | Channel | Managed By |
|------|---------|------------|
| SFeed (market data) | WS#1 | `ws_socket/ws_manager.py` |
| OrderFeed (orders/positions) | WS#2 | `ws_socket/order_feed_manager.py` |

**Import Sites** (inferred)
- `python-service/auth/kotak_client.py` — session/login
- `python-service/brokers/kotak_adapter.py` — REST trading + market data
- `python-service/ws_socket/ws_manager.py` — SFeed
- `python-service/ws_socket/order_feed_manager.py` — OrderFeed
- `python-service/ws_socket/ws_engine/` — validation/normalization

**Version Constraint Notes** (from `requirements.txt` comments)
- 3.0.7 fixes a `RecursionError` present in 3.0.6
- Declares `websockets>=12.0` with no upper bound; pinned to 13.1 to satisfy uvicorn 0.30.6
- `websocket-client==1.9.1` is pulled in by the SDK

---

### 2. NorenRestApiOAuth 0.0.41

| Attribute | Value |
|-----------|-------|
| **Package** | `NorenRestApiOAuth` |
| **Version** | 0.0.41 (exact pin) |
| **Vendor** | Shoonya (Finvasia) |
| **License** | Proprietary |
| **Type** | Broker SDK (REST + WebSocket, OAuth) |
| **Criticality** | HIGH — secondary broker |

**Capabilities**
| Capability | Notes |
|------------|-------|
| OAuth login | Authorization-code flow; requires `SHOONYA_REDIRECT_URL` |
| Session info | |
| Quote | |
| Historical data | |
| Place/modify/cancel order | |
| Order/trade book | |
| Positions | |
| Holdings | |
| Funds | |
| WebSocket market data | `NorenWSTP` endpoint |

**Import Sites** (inferred)
- `python-service/brokers/shoonya_adapter.py`
- `python-service/api/terminal.py` (`shoonya_router`)

**Configuration** (backend-only, never exposed)
- `SHOONYA_API_KEY` · `SHOONYA_SECRET_KEY` · `SHOONYA_USER_ID` · `SHOONYA_ACCOUNT_ID` · `SHOONYA_REDIRECT_URL`

---

## Python Framework & Runtime

### 3. fastapi 0.115.0
| Attribute | Value |
|-----------|-------|
| **License** | MIT |
| **Criticality** | CRITICAL |
| **Used By** | `app.py`, all 40 `api/*` routers, `api/ws_gateway.py` (`WS /ws/realtime`) |
| **Role** | ASGI app, dependency injection, routing, OpenAPI generation |
| **Key Features Used** | `APIRouter`, `WebSocket`, `Depends`, `HTTPException`, Pydantic models, CORS |

### 4. uvicorn 0.30.6
| Attribute | Value |
|-----------|-------|
| **License** | BSD-3 |
| **Criticality** | CRITICAL |
| **Used By** | `app.py` (`uvicorn.run`), `start_backend.py` |
| **Role** | ASGI server |
| **Constraint** | Imports `websockets.legacy.*` → requires `websockets<=13.x` |

### 5. pydantic 2.9.0
| Attribute | Value |
|-----------|-------|
| **License** | MIT |
| **Criticality** | CRITICAL |
| **Used By** | `models/`, `config/settings.py`, every request/response schema |
| **Role** | Validation, settings, serialization |

---

## Data & Persistence

### 6. motor 3.5.1
| Attribute | Value |
|-----------|-------|
| **License** | Apache-2.0 |
| **Criticality** | CRITICAL |
| **Used By** | `database/connection.py`, `database/migrations.py`, storage/db-writer services |
| **Role** | Async MongoDB driver wrapping pymongo 4.8.0 |

### 7. pymongo 4.8.0
| Attribute | Value |
|-----------|-------|
| **License** | Apache-2.0 |
| **Criticality** | CRITICAL |
| **Used By** | Via motor |
| **Role** | Synchronous MongoDB driver (motor dependency) |

### 8. dnspython 2.7.0
| Attribute | Value |
|-----------|-------|
| **License** | MIT |
| **Criticality** | HIGH |
| **Used By** | `database/connection.py` |
| **Role** | Resolves `mongodb+srv://` Atlas SRV records |

---

## WebSocket & Networking

### 9. websockets 13.1
| Attribute | Value |
|-----------|-------|
| **License** | BSD-3 |
| **Criticality** | CRITICAL |
| **Used By** | uvicorn 0.30.6, kotakneoapi 3.0.7 |
| **Role** | Modern WebSocket protocol library |
| **Constraint** | **Hard pin at 13.1**; 14.x removed `websockets.legacy` required by uvicorn 0.30.6 |

### 10. websocket-client 1.9.1
| Attribute | Value |
|-----------|-------|
| **License** | BSD-3 |
| **Criticality** | HIGH |
| **Used By** | kotakneoapi 3.0.7 (sync client path) |
| **Role** | Legacy synchronous WebSocket client |

### 11. requests
| Attribute | Value |
|-----------|-------|
| **License** | Apache-2.0 |
| **Criticality** | MEDIUM |
| **Used By** | Various services, scheduled downloads, exports |
| **Role** | HTTP client for outbound calls |

---

## Security & Auth

### 12. pyjwt 2.13.0
| Attribute | Value |
|-----------|-------|
| **License** | MIT |
| **Criticality** | HIGH |
| **Used By** | `services/jwt_auth*`, `api/auth.py` |
| **Role** | JWT sign/verify for app-level auth (`APP_USERNAME`, `APP_PASSWORD`, `JWT_SECRET`) |

### 13. pyotp 2.10.0
| Attribute | Value |
|-----------|-------|
| **License** | MIT |
| **Criticality** | HIGH |
| **Used By** | `auth/kotak_client.py` |
| **Role** | TOTP generation from `TOTP_SECRET` for Kotak login |

### 14. cryptography 50.0.1
| Attribute | Value |
|-----------|-------|
| **License** | Apache-2.0 OR BSD-3 |
| **Criticality** | HIGH |
| **Used By** | `services/mode_lock`, `api/security.py` |
| **Role** | PBKDF2 PIN hashing, WebAuthn key handling |

### 15. python-dotenv 1.0.0
| Attribute | Value |
|-----------|-------|
| **License** | BSD-3 |
| **Criticality** | HIGH |
| **Used By** | `config/settings.py` |
| **Role** | Loads `.env` and optional `config/.env.local` |

### 16. python-decouple 3.8
| Attribute | Value |
|-----------|-------|
| **License** | MIT |
| **Criticality** | MEDIUM |
| **Used By** | `config/settings.py` |
| **Role** | Alternate config parsing helper |

---

## Reliability & Observability

### 17. tenacity 9.1.4
| Attribute | Value |
|-----------|-------|
| **License** | Apache-2.0 |
| **Criticality** | MEDIUM |
| **Used By** | Broker calls, DB ops, WS reconnect paths |
| **Role** | Retry with backoff |

### 18. structlog 26.1.0
| Attribute | Value |
|-----------|-------|
| **License** | Apache-2.0 |
| **Criticality** | MEDIUM |
| **Used By** | `logger/`, `app.py` request middleware |
| **Role** | Structured JSON logging with IST timestamps |

### 19. psutil 6.0.0
| Attribute | Value |
|-----------|-------|
| **License** | BSD-3 |
| **Criticality** | MEDIUM |
| **Used By** | `runtime/singleton.py` (process guard), system metrics |
| **Role** | Process/system introspection, duplicate-instance detection |

---

## Export & Serialization

### 20. openpyxl 3.1.5
| Attribute | Value |
|-----------|-------|
| **License** | MIT |
| **Criticality** | LOW |
| **Used By** | `api/export_jobs.py`, `api/downloads.py` |
| **Role** | XLSX generation |

### 21. odfpy 1.4.1
| Attribute | Value |
|-----------|-------|
| **License** | Apache-2.0 |
| **Criticality** | LOW |
| **Used By** | Export services |
| **Role** | ODS generation |

### 22. fastavro 1.12.2
| Attribute | Value |
|-----------|-------|
| **License** | MIT |
| **Criticality** | LOW |
| **Used By** | Serializer services |
| **Role** | Avro read/write |

### 23. pyyaml 6.0.3
| Attribute | Value |
|-----------|-------|
| **License** | MIT |
| **Criticality** | LOW |
| **Used By** | Config loading |
| **Role** | YAML parse/emit |

### 24. tzdata 2026.3
| Attribute | Value |
|-----------|-------|
| **License** | Apache-2.0 |
| **Criticality** | HIGH |
| **Used By** | `core/timezones.py` |
| **Role** | Timezone database (IST handling on all platforms) |

### 25. typing_extensions 4.16.0
| Attribute | Value |
|-----------|-------|
| **License** | PSF-2.0 |
| **Criticality** | MEDIUM |
| **Used By** | Engine type hints |
| **Role** | Backported typing constructs |

---

## Node Dependencies (Frontend)

### 26. next 16.3.4
| Attribute | Value |
|-----------|-------|
| **License** | MIT |
| **Criticality** | CRITICAL |
| **Role** | React framework, App Router, API routes, build |
| **Location** | `package.json`, `app/api/*` proxy routes |

### 27. react / react-dom 19.2.8
| Attribute | Value |
|-----------|-------|
| **License** | MIT |
| **Criticality** | CRITICAL |
| **Role** | UI runtime |
| **Note** | React 19 — new concurrent features available |

### 28. typescript 5.9.3
| Attribute | Value |
|-----------|-------|
| **License** | Apache-2.0 |
| **Criticality** | CRITICAL |
| **Role** | Type checking, build-time safety |
| **Config** | `tsconfig.json` |

### 29. tailwindcss 3.4.17 + autoprefixer 10.4.21 + postcss 8.4.49
| Attribute | Value |
|-----------|-------|
| **License** | MIT |
| **Criticality** | HIGH |
| **Role** | Utility CSS, vendor prefixes |
| **Note** | Tailwind 3.x (not 4.x) — config-file based |

### 30. @radix-ui/* (20+ primitives)
| Attribute | Value |
|-----------|-------|
| **License** | MIT |
| **Criticality** | HIGH |
| **Role** | Accessible unstyled primitives (dialog, dropdown, tabs, tooltip, popover, select, etc.) |
| **Location** | `components/ui/*` |

### 31. recharts 2.15.1
| Attribute | Value |
|-----------|-------|
| **License** | MIT |
| **Criticality** | MEDIUM |
| **Role** | Charts for dashboard/analytics |

### 32. date-fns 3.6.0
| Attribute | Value |
|-----------|-------|
| **License** | MIT |
| **Criticality** | MEDIUM |
| **Role** | Date formatting/manipulation |

### 33. zod 3.24.0
| Attribute | Value |
|-----------|-------|
| **License** | MIT |
| **Criticality** | HIGH |
| **Role** | Runtime schema validation for API payloads and forms |
| **Note** | zod 3.x (v4 not used) |

### 34. react-hook-form 7.87.0
| Attribute | Value |
|-----------|-------|
| **License** | MIT |
| **Criticality** | MEDIUM |
| **Role** | Order entry and settings forms |

### 35. react-resizable-panels 2.1.8
| Attribute | Value |
|-----------|-------|
| **License** | MIT |
| **Criticality** | HIGH |
| **Role** | Trading terminal layout |

### 36. sonner 1.7.4
| Attribute | Value |
|-----------|-------|
| **License** | MIT |
| **Criticality** | MEDIUM |
| **Role** | Toast notifications |

### 37. lucide-react 0.468.0
| Attribute | Value |
|-----------|-------|
| **License** | ISC |
| **Criticality** | LOW |
| **Role** | Icon set |

### 38. @supabase/supabase-js 2.58.0
| Attribute | Value |
|-----------|-------|
| **License** | MIT |
| **Criticality** | MEDIUM |
| **Role** | Optional auth/storage integration |
| **Note** | **UNKNOWN** whether actively used; no Supabase backend config confirmed |

### 39. next-themes 0.4.6
| Attribute | Value |
|-----------|-------|
| **License** | MIT |
| **Criticality** | LOW |
| **Role** | Dark/light theme |

### 40. Utility stack (class-variance-authority, clsx, tailwind-merge, cmdk, vaul, embla-carousel-react, input-otp, tailwindcss-animate)
| Attribute | Value |
|-----------|-------|
| **License** | MIT |
| **Criticality** | LOW–MEDIUM |
| **Role** | UI composition helpers, command palette, drawer, carousel, OTP input, animation |

### 41. eslint 9.30.0 + eslint-config-next 16.3.4 + eslint-plugin-react-hooks 7.1.1
| Attribute | Value |
|-----------|-------|
| **License** | MIT |
| **Criticality** | MEDIUM |
| **Role** | Linting (quality gate) |

---

## Dependency Constraint Chains (Critical to Preserve)

```
uvicorn 0.30.6
  └─ imports websockets.legacy.*  (removed in websockets 14.x)
       └─ THEREFORE websockets MUST stay <= 13.1

kotakneoapi 3.0.7
  └─ requires websockets >= 12.0  (no upper bound)
  └─ requires websocket-client 1.9.1
       └─ SATISFIED BY websockets 13.1  ✅

fastapi 0.115.0
  └─ pydantic 2.9.0
  └─ starlette (transitive)

motor 3.5.1
  └─ pymongo 4.8.0
  └─ dnspython 2.7.0 (Atlas SRV)
```

**DO NOT** upgrade `websockets` to 14.x without upgrading uvicorn and re-testing Kotak SFeed.

---

## License Risk Summary

| Category | Packages | Risk |
|----------|----------|------|
| Proprietary (broker) | kotakneoapi, NorenRestApiOAuth | Vendor lock-in, redistribution prohibited |
| Permissive (MIT/BSD/Apache) | 20+ Python, most Node | Low |
| PSF | typing_extensions | Low |
| ISC | lucide-react | Low |

---

## Related Documents
- `../DEPENDENCY_MAP.md` — Full dependency graph
- `../config/CONFIGURATION_CATALOG.md` — Env vars per SDK
- `../broker/BROKER_INTEGRATION_MAP.md` — SDK capability matrix
- `../PROJECT_RISKS.md` — Supply-chain risk register
