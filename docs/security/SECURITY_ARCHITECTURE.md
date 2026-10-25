# SECURITY_ARCHITECTURE.md

## KAUSTUBH Trading Platform - Security Architecture

**Last Updated**: 2026-09-28
**Status**: ACTIVE
**Verification**: Controls identified by static inspection. **No security testing performed.** Findings below are architectural observations, not audit results.

---

## Trust Boundaries

```
┌─ BROWSER (untrusted) ────────────────────────────────────┐
│  Next.js frontend                                       │
│  - No broker credentials                                │
│  - No DB access                                         │
│  - No SDK imports                                       │
└──────────────────┬───────────────────────────────────────┘
                   │ HTTPS/WSS (assumed, NOT_VERIFIED)
                   │ JWT bearer token
┌──────────────────▼───────────────────────────────────────┐
│  BACKEND PROCESS (trusted)                               │
│  ┌────────────┐  ┌────────────┐  ┌────────────────────┐ │
│  │ Kotak creds│  │ Shoonya    │  │ JWT_SECRET         │ │
│  │ CLIENT_ID  │  │ creds      │  │ MPIN / TOTP_SECRET │ │
│  └─────┬──────┘  └─────┬──────┘  └────────┬───────────┘ │
│        │                │                  │             │
│        ▼                ▼                  ▼             │
│  ┌────────────────────────────────────────────────────┐ │
│  │ Broker Adapters — ONLY place importing broker SDKs  │ │
│  └────────────────────────────────────────────────────┘ │
│        │                                                 │
│        ▼                                                 │
│  ┌────────────────────────────────────────────────────┐ │
│  │ MongoDB (MONGODB_URI) — internal network only       │ │
│  └────────────────────────────────────────────────────┘ │
└──────────────────┬───────────────────────────────────────┘
                   │ HTTPS + proprietary auth
┌──────────────────▼───────────────────────────────────────┐
│  BROKER APIs (external, semi-trusted)                    │
│  Kotak Neo · Shoonya                                    │
└──────────────────────────────────────────────────────────┘
```

---

## Authentication

### Application-Level (backend API)
| Control | Implementation | Status |
|---------|---------------|--------|
| JWT issuance | `services/jwt_auth*`, `api/auth.py` | `VERIFIED` (exists) |
| JWT library | `pyjwt` 2.13.0 | `VERIFIED` |
| Claims | `iss`, `aud`, `ttl` configurable | `VERIFIED` (config) |
| Credential source | `APP_USERNAME`, `APP_PASSWORD` | `VERIFIED` (config) |
| Secret strength | `JWT_SECRET` | **`NOT_VERIFIED`** — no enforcement found |

### Broker-Level
| Broker | Method | Credentials |
|--------|--------|-------------|
| Kotak Neo | TOTP (MPIN + TOTP secret) | `CLIENT_ID`, `CONSUMER_KEY`, `MOBILE_NUMBER`, `MPIN`, `TOTP_SECRET` |
| Shoonya | OAuth 2.0 authorization code | `SHOONYA_*` (7 vars) |

---

## Authorization

| Mechanism | Detail | Status |
|-----------|--------|--------|
| Terminal lock (PIN) | `api/security.py` `/lock`, `/unlock`, `/pin` | `VERIFIED` (exists) |
| Mode lock | `services/mode_lock` — prevents trading in certain modes | `VERIFIED` (exists) |
| WebAuthn | `/webauthn/register/*`, `/webauthn/authenticate/*` | `VERIFIED` (exists) |
| Role model | `users.role` (admin/trader/viewer) | `INFERRED` — enforcement `NOT_VERIFIED` |
| Rate limiting | — | **`UNKNOWN` — no evidence found** |
| API key scoping | — | **`UNKNOWN`** |

---

## Cryptography

| Use | Library | Detail |
|-----|---------|--------|
| PIN hashing | `cryptography` PBKDF2 | `services/mode_lock` |
| JWT signing | `pyjwt` | HS256 (assumed; algorithm `NOT_VERIFIED`) |
| TOTP | `pyotp` | 6-digit, 30s step (configurable) |
| WebAuthn | `cryptography` | FIDO2 key handling |
| Transport encryption | — | **`UNKNOWN` — no TLS/HSTS evidence found** |

---

## Secrets Management

### Storage
| Secret | Location | Protection |
|--------|----------|-----------|
| `CLIENT_ID`, `CONSUMER_KEY`, `MOBILE_NUMBER`, `MPIN`, `TOTP_SECRET` | env / `.env` / `config/.env.local` | Env vars, gitignored files |
| `SHOONYA_*` (7 vars) | env / `.env.local` | Same |
| `APP_PASSWORD`, `JWT_SECRET` | env / `.env` | Same |
| `MONGODB_URI` | env / `.env` | Contains credentials if Atlas |
| `users.password_hash` | MongoDB `users` | PBKDF2 |

### Loading Order
```
process env  >  python-service/.env  >  config/.env.local  >  MongoDB config  >  code defaults
```

### Exposure Vectors — TO VERIFY

| Vector | Risk | Status |
|--------|------|--------|
| `GET /api/settings` returning raw secrets | **Critical** | **`NOT_VERIFIED` — TOP PRIORITY** |
| `GET /api/system/*` leaking config | High | `NOT_VERIFIED` |
| Error messages including stack traces | Medium | `NOT_VERIFIED` |
| Logs containing credentials | Medium | `NOT_VERIFIED` |
| `audit_log` storing request payloads with secrets | Medium | `NOT_VERIFIED` |
| Frontend bundle containing secrets | Critical | `NOT_VERIFIED` |

---

## Input Validation

| Layer | Control |
|-------|---------|
| Request bodies | Pydantic 2.9.0 models |
| Path params | FastAPI validation |
| Query params | FastAPI validation |
| Frontend forms | React Hook Form + Zod 3.24.0 |
| MongoDB queries | Motor (parameterized — no string interpolation) |
| Broker payloads | WebSocket Engine field validation |

**SQL/NoSQL injection**: Not applicable (MongoDB with parameterized queries). `NOT_VERIFIED` for raw `$where` or JS eval usage.

---

## CORS

```python
cors_origins  # config setting
```

**Status**: `NOT_VERIFIED`. If set to `*` in production, this disables origin isolation. **Verify actual value.**

---

## Logging & Audit

| Log | Location | Content | Secret Risk |
|-----|----------|---------|-------------|
| `audit_log` collection | MongoDB | All trading decisions, 7y TTL | Medium (request payloads) |
| structlog output | stdout/file | Structured events | Medium |
| `/api/services/engines/{id}/errors` | API | Per-engine errors | Low |
| `/api/data-saver/insights/errors` | API | Correlated errors | Low |
| `/api/logs` | API | Application logs | Medium |

**No PII redaction mechanism confirmed.** `NOT_VERIFIED`.

---

## Process Security

| Control | Detail | Status |
|---------|--------|--------|
| Process guard | `runtime/singleton.py` (psutil) | `VERIFIED` (exists) |
| Duplicate process prevention | Mutex/lock | `NOT_VERIFIED` (mechanism) |
| Secrets in memory only | Env vars | `VERIFIED` (design) |
| Secrets never logged | — | `NOT_VERIFIED` |

---

## Known Security Concerns

| # | Concern | Severity | Action |
|---|---------|----------|--------|
| S-01 | `/api/settings` may return secrets | **Critical** | Verify + mask + add test |
| S-02 | No TLS/HSTS evidence | High | Deploy behind TLS-terminating proxy |
| S-03 | No rate limiting evidence | High | Add middleware |
| S-04 | `JWT_SECRET` strength unenforced | High | Enforce minimum length/complexity at startup |
| S-05 | CORS value unknown | Medium | Verify and restrict |
| S-06 | No dependency CVE scan | High | Run `pip-audit` / `npm audit` |
| S-07 | `audit_log` may store sensitive payloads | Medium | Redact before persist |
| S-08 | No security headers evidence | Medium | Add HSTS, X-Content-Type-Options, CSP |
| S-09 | WebSocket auth token lifetime unknown | Medium | Use short-lived tokens |
| S-10 | No security testing performed | High | Commission penetration test |

---

## Security Verification Checklist

- [ ] `GET /api/settings` returns no secret values
- [ ] `GET /api/system/*` returns no credentials
- [ ] Frontend bundle contains no secrets (`grep` built `.next/` output)
- [ ] CORS `Access-Control-Allow-Origin` is not `*` in production
- [ ] `JWT_SECRET` is strong and not a default
- [ ] `JWT_SECRET` is not in git history
- [ ] `.env` and `.env.local` are gitignored
- [ ] `pip-audit` reports no critical CVEs
- [ ] `npm audit` reports no critical CVEs
- [ ] Rate limiting exists on `/api/auth/*`
- [ ] TLS enforced; HSTS header present
- [ ] WebSocket requires token authentication
- [ ] Logs contain no credentials
- [ ] `audit_log` payloads are redacted

---

## Related Documents
- `../config/CONFIGURATION_CATALOG.md` — All secret variables
- `../database/DATABASE_COLLECTION_CATALOG.md` — Sensitive fields
- `../broker/BROKER_INTEGRATION_MAP.md` — Credential isolation
- `../PROJECT_RISKS.md` — R-01, R-27, R-28, R-29, R-30
- `../PROJECT_GAPS.md` — GAP-002, GAP-021
