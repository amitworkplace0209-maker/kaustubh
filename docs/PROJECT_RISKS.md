# PROJECT_RISKS.md

## KAUSTUBH Trading Platform - Risk Register

**Last Updated**: 2026-09-28
**Status**: ACTIVE
**Method**: Static architecture and dependency analysis. Probabilities are qualitative, NOT statistically derived.

> **ID-collision repair, 2026-09-28.** This table previously used **R-17 through R-25
> twice**: a new block (unauthenticated control plane, JWT fallback, engine-registry drift,
> banner damage) had been appended using IDs the pre-existing block already occupied, which
> made the register unusable for tracking. The pre-existing block was renumbered to
> **R-25…R-33**; the security block keeps **R-17…R-24**; **R-34/R-35** are new.
> Cross-references in `SCHEDULER_AND_LIFECYCLE.md` and `SECURITY_ARCHITECTURE.md` were
> updated to match. **All IDs are now unique — verify against this revision, not an older one.**

---

## Risk Matrix

| ID | Risk | Likelihood | Impact | Severity | Mitigation |
|----|------|-----------|--------|----------|------------|
| R-01 | Secrets leaked via `/api/settings` responses | Medium | Critical | **Critical** | Live-verify redaction; add automated masking test; never log config |
| R-02 | `websockets` upgraded past 13.x breaks uvicorn backend | Medium | Critical | **Critical** | Keep `websockets==13.1` pin; CI test import of `uvicorn` |
| R-03 | Proprietary broker SDK breaking change | Medium | High | High | Adapter abstraction layer; pin exact versions |
| R-04 | Single-process SPOF | High | High | High | Process guard exists; add systemd/PM2 restart policy |
| R-05 | MongoDB startup hard dependency | High | High | High | Health endpoint reports 503; graceful degradation |
| R-06 | Engine health degradation in production (5 UNKNOWN) | Medium | High | High | Live health checks; alert on DEGRADED/UNKNOWN |
| R-07 | Position/MTM divergence from broker truth | Medium | High | High | REST `positions()` as authoritative; periodic reconcile |
| R-08 | WebSocket reconnect storms during market hours | Medium | High | High | Exponential backoff (configured); max-attempt cap |
| R-09 | Unverified order execution path | Low | Critical | High | Paper/dummy mode testing; audit trail on every decision |
| R-10 | Tick buffer memory exhaustion | Low | High | Medium | `buffer_max_size` + `buffer_flush_interval_ms` caps |
| R-11 | MongoDB pool starvation under bulk writes | Low | Medium | Medium | Tune `bulk_insert_size` vs `mongodb_max_pool_size` |
| R-12 | Dependency CVEs (25 Python, 41 Node, unscanned) | High | Medium | Medium | Run `pip-audit` + `npm audit`; schedule monthly |
| R-13 | ~~Route shadowing (`/{engine_id}` before `/broker/status`)~~ → **CLOSED 2026-09-28** | — | — | **None** | Disproven: `/{engine_id}` is a single segment and `/{engine_id}/health` has a literal `health`, so neither can shadow `/broker/status`. `/summary` is declared before `/{engine_id}`. See `ENGINE_CONTROL_API.md` §3 |
| R-14 | Watchlist triple-API divergence | High | Low | Medium | Consolidate to canonical API |
| ~~R-15~~ | ~~41 unverified frontend pages (dead code)~~ → **RESOLVED 2026-09-28**: import graph built. 74 files under `app\_pages\`, **only 1 live** (`_pages\dashboard\page`), 73 unreachable. No collision, no build risk. Residual concern is code hygiene only | ~~High~~ → **Low** | **Low** | **Low** | Left as-is by design; add a `README` to `app\_pages\`. Do not prune without owner approval. See `audits/FRONTEND_PAGES_AUDIT.md` §4 |
| R-16 | Documentation drift from code | High | Low | Medium | CI docs lint; link specs to code |
| **R-17** | **Unauthenticated engine control plane** — 37 of 40 routers have no auth, including engine start/stop/restart and broker selection; backend binds `0.0.0.0` | **High** | **Critical** | **CRITICAL** | **See `security/AUTHENTICATION_AND_CONTROL_PLANE_EXPOSURE.md`. Set `HOST=127.0.0.1`; add `verify_token` to `engine_control.py`; `dependencies=` on all 40 `include_router()` calls** |
| **R-18** | **JWT signing secret falls back to a hardcoded literal** `"dev-insecure-jwt-secret"` when `JWT_SECRET` is unset — and it is absent from `.env` | **High** | **Critical** | **CRITICAL** | Fail closed at signing time when the secret is empty and `NEO_ENVIRONMENT=prod`. Verify presence without printing the value |
| R-19 | Wildcard CORS (`CORS_ORIGINS=*`) combined with `allow_credentials=True`; shipped in `.env.example` | High | High | High | Pin to the real frontend origin; set `allow_credentials=False` while wildcard; fix `.env.example` |
| R-20 | Documented remediation commands do not exist (`python -m kaushub.*`) — `32_ARCHITECTURE_GAPS.md` cannot be acted on | High | Medium | High | `ENGINE_CONTROL_API.md` records the real substitutes; `engine reconcile` has **no** equivalent and Gap 1 is unexecutable |
| R-21 | AI-agent navigation doc teaches the wrong WebSocket model (4-WS banner over 2-WS body in `35_AI_AGENT_CONTEXT.md` and 4 others) | High | Medium | High | Fix or flag the bodies; add `DOCUMENTATION_AUTHORITY.md` pointer |
| R-22 | Engine registry mismatch — code registers 17, five documents say 15; `audit_engine`/`market_watch_engine` registered but contradicted in the inventory | High | Medium | High | Correct the five documents; decide on 6 unregistered `core/engines/` modules |
| R-23 | Banner character damage — `→` transliterated to `?` in all 36 numbered files; 1 corrupt byte in 28 | High | Low | Low | Repair alongside R-21 |
| R-24 | 6 implemented-but-unregistered `core/engines/` modules (`risk_engine`, `target_engine`, `pnl_engine`, `basket_engine`, + 2 facade-covered) — dead code or registration gap | Medium | Medium | Medium | Human decision required; audit before pruning |
| R-25 | Scheduler clock drift / missed phases | Low | High | Medium | NTP sync; phase-run ledger alerts |
| R-26 | Square-off skipped (config or failure) | Low | Critical | High | `square_off_enabled` guard; alert if positions remain after 15:20 |
| R-27 | JWT secret weakness or default | Low | Critical | High | Enforce strong secret at startup; rotate procedure |
| R-28 | CORS misconfiguration (`*` origin) | Low | High | Medium | Enforce explicit origin allowlist in production |
| R-29 | No rate limiting on auth endpoints | Medium | Medium | Medium | Add middleware or proxy-level rate limits |
| R-30 | No TLS enforcement observed | Medium | High | High | Terminate TLS at proxy; HSTS |
| R-31 | MongoDB Atlas SRV DNS dependency | Low | Medium | Low | `dnspython` pinned; local MongoDB fallback |
| R-32 | AI route group (14 routes) has no backend | High | Low | Low | Implement, hide, or remove routes |
| R-33 | Supabase dependency unused / misconfigured | Medium | Low | Low | Verify usage; remove if dead |
| **R-34** | **~98,000 lines of application code are uncommitted** — ~975 untracked files (~530 `.ts`/`.tsx`, 209 `.py`); HEAD has only 141 files and **5** commits. A fresh clone yields a different application than this documentation describes | **High** | **Catastrophic** | **CRITICAL** | Commit the application in logical slices. See `audits/VERSION_CONTROL_STATE.md` |
| ~~**R-35**~~ | ~~`tailwind.config.ts` deleted from the working tree~~ (it **was** tracked in `HEAD`; the deletion itself was never committed) → **CLOSED 2026-09-28**: restored from `HEAD` with owner approval; `git status` clean for that path. `darkMode`, the semantic palette, radius tokens, gradients, accordion animations and `tailwindcss-animate` plugin are all present again. The window in which the UI would have rendered unstyled is closed | ~~High~~ | **None** | **None** | Closed. Retained as a record: `tsc`/ESLint cannot detect a missing Tailwind config |
| **R-36** | **Session tokens are unsigned — clients can authenticate themselves.** `createSessionToken()` returns `base64` of plain JSON (`lib/auth-crypto.ts:52-59`); the only validator (`app/api/realtime/token/route.ts:30-38`) decodes and checks `authenticated === true && exp > now`. No HMAC, no `middleware.ts`, no server-side session. Forging a cookie requires only `printf '{"authenticated":true,"exp":99999999999999}' \| base64` | **High** | **Critical** | **CRITICAL** | **See `security/SESSION_TOKEN_FORGERY_AND_AUTH_BYPASS.md`. Sign the token (HMAC + `timingSafeEqual`) or store an opaque server-side session id. Never ship unsigned cookies** |
| **R-37** | **Auth fails open when app lock is unconfigured** — `isAppLockConfigured()` returns `false` when `.auth\app-lock.json` is missing/corrupt or `APP_LOCK_PIN` is unset, and `POST /api/auth/login {"direct":true}` then issues a session cookie with no credentials. `.auth/` is gitignored and `APP_LOCK_PIN` exists only in `.env.example`, so **a fresh clone is vulnerable by default**. Verified true in this tree | **High** | **Critical** | **CRITICAL** | Fail closed: refuse `direct:true` unless an explicit non-production flag is set; distinguish "absent" from "corrupt" in `loadConfig()` |
| **R-38** | **Forged session escalates to a backend operator JWT** — `/api/realtime/token` is gated *only* by the forgeable cookie, then calls `acquireOperatorJwt()` with server-side `APP_USERNAME`/`APP_PASSWORD` (8 h cache) and returns the JWT to the caller. Today those vars are unset so it degrades to anonymous; the moment they are configured, forging a cookie yields operator-level access to the 37 unauthenticated routers (R-17) | Medium | **Critical** | **High** | Resolve with R-36. Never return operator credentials to the browser — mint a scoped realtime token server-side |
| **R-39** | **No broker failover exists.** `brokers/manager.py` and `brokers/broker_registry.py` implement no health check, failure detection, retry, circuit breaker, or automatic switch. `get_trading_status()` / `get_market_data_status()` compute an honest state and **nothing consumes it**. A broker drop leaves the system pinned to that broker with no degradation path, even though `dummy` is a full paper adapter | **High** | **High** | **High** | Add an explicit policy: health probe + bounded retry + loud fallback to `dummy` flagged as simulated. See `broker/BROKER_SELECTION_AND_FAILOVER.md` |
| **R-40** | **Two independent broker-selection systems that never reconcile.** `manager.active_terminal()` (one terminal, session-aware, persists across restart) and `registry.get/set_trading_broker()` (in-memory, resets to `kotak` on restart, supports independent market-data selection). `switch_terminal()` never calls the registry and the registry setters never call `set_mode`, so "the active broker" has two sources of truth that can disagree — including only after a restart | **High** | **High** | **High** | Choose one source of truth; make the other derive from it. Persist the registry selection. See `broker/BROKER_SELECTION_AND_FAILOVER.md` |
| R-41 | `BROKER_CAPABILITIES["shoonya"]` declares every capability `False`, but `shoonya_adapter.py` is 448 lines / 34 defs / **16-of-18** `base.py` protocol methods — on par with `dummy`, which *is* declared implemented. `tests/test_engine_registry.py:301-314` asserts the "not implemented" claim, so the tests lock in the contradiction | Medium | Medium | Medium | Read the adapter bodies, then correct either the table or the tests. Treat the table as an **unverified claim** until then |
| R-42 | `get_market_data_status()` always reads the global `ws_manager`, so selecting `dummy` as market-data broker reports the **real** broker's live WS state (state, symbol count, ticks/s) as the dummy's. `dummy`'s own record is inconsistent: `market_data=True` with `websocket=False` | Medium | Medium | Medium | Gate the status read on the selected broker; reconcile the `dummy` capability record |
| R-43 | **RESOLVED 2026-09-28** (was High/High/High). Market Watch was a **co-owner** of tick persistence: `db_writer_engine.buffer_documents()` never called `_should_persist_tick()`, so `dbw_market_watch_ticks` (default OFF) had no effect on the Market Watch tick path. The only gate was `mwr_persist_ticks` (default **True**) — Market Watch ticks were persisted by default and the DB Writer's permission could not stop them | ~~High~~ None | ~~High~~ None | ~~High~~ None | **Fixed** — `ingest_market_watch_ticks()` routes the handoff through the DB Writer's authority; `mwr_persist_ticks` demoted to an ANDed offer gate. See `docs/logs/LOG-002-2026-09-28-db-writer-tick-persistence-authority.md` |
| R-44 | **RESOLVED 2026-09-28** (was Medium/Medium/Medium). The "persist at most once" rule was **dead code**: `_get_tick_source()` short-circuited on `market_watch`, so the overlapping-classification branch in `_should_persist_tick()` could never execute and `overlapping_sources_deduped` was structurally always `0`. A tick matching several classifications was untested and unenforced | ~~Medium~~ None | ~~Medium~~ None | ~~Medium~~ None | **Fixed** — `_get_tick_classifications()` returns the full set; regression test `test_overlapping_classifications_persist_at_most_once` |
| R-45 | **OPEN 2026-09-29** (High/High/**High** — likelihood raised). The Atlas cluster has only **~400 MB free** and tick history is **append-only with no retention policy**. The hard-coded `TICK_PERSISTENCE_HARD_CAP` was **removed** — a fixed source-code limit silently truncated production data and overrode the operator's settings. Storage is now bounded only by the three boolean `dbw_storage_cap_*` brakes, which **default to OFF**, so a deployment that enables a tick permission without capping it is **unbounded**, a worse default than the old stopgap. Both `personalNoExpiry` and `marketWatchOneDay` can therefore fill the remaining space. Note the cap is all-or-nothing: it STOPS a stream, it does not trim it. A capped collection, a retention/pruning job, or a dedicated tick cluster remains the only real fix. A cap does **not** delete existing `market_ticks` documents, so no space has been reclaimed yet | High | High | High | Provision real storage for tick history, or add a retention/pruning policy for `ticks` / `market_ticks`. As an interim brake only, set `dbw_storage_cap_personal_no_expiry` and `dbw_storage_cap_market_watch_one_day` to `true` (this stops those streams; it does not free space). Decide separately whether to purge existing data. See `docs/logs/LOG-003-2026-09-29-db-writer-tick-persistence-storage-cap.md` |
| R-46 | **RESOLVED 2026-09-29** (was High/High/High in the context of R-45). `buffer_documents(collection, docs)` is the *batching* method and applied **no** classification, permission check or storage cap, so calling it directly with `market_ticks` wrote Market Watch ticks with no gate at all — the exact volume that exhausted the disk. No production caller did this (`market_watch_ledger` writes `market_watch_decisions`, `market_watch_report` writes `market_watch_daily_report`, `buffer_candles` writes `market_candles_*`), but the invariant was unenforced and one careless caller away from a real bypass | ~~High~~ None | ~~High~~ None | ~~High~~ None | **Fixed** — `buffer_documents()` now refuses tick collections and records `mw_document_rejected`; gated internal paths call the private `_buffer_documents_unchecked()`. 2 regression tests |

---

## Highest-Priority Mitigations

### 1. Secret Exposure (R-01)
```
Test:    curl -s http://localhost:8000/api/settings | jq 'keys'
Assert:  no jwt_secret, mpin, totp_secret, consumer_key values present
Fix:     mask sensitive keys in api/settings.py response serializer
```

### 2. Dependency Pin Integrity (R-02)
```
Assert requirements.txt contains:
  uvicorn==0.30.6
  websockets==13.1
  kotakneoapi==3.0.7
CI:  python -c "import uvicorn; import websockets.legacy"
```

### 3. Square-Off Safety (R-18)
```
At 15:20 IST: assert positions count == 0
Alert if not
```

---

## Operational Risks (Runtime-Dependent)

| Risk | Trigger | Detection | Response |
|------|--------|-----------|----------|
| Broker login failure | 08:50 | Scheduler run log | Manual login via `/api/auth/manual-login` |
| SFeed disconnect | Market hours | `/api/services/engines/websocket_engine/health` | Auto-reconnect; manual `/api/services/websocket/reconnect` |
| MongoDB loss | Any | `/health` → 503 | Restart DB; check `mongodb_connect_attempts` |
| **MongoDB storage nearly full** | Any | `db.stats()` / Atlas metrics | **Stop tick growth first** — check `storageCapActive` on `GET /api/services/engines/db_writer_engine/tick-persistence`. The cap is a stopgap; escalate to R-45 for a real fix |
| Order stuck pending | Any | `GET /api/trading/orders` filter | Query `order_status` via broker |
| Engine DEGRADED | Any | `/api/services/engines/summary` | Inspect `/api/services/engines/{id}/errors` |
| Duplicate backend process | Any | Process guard log | Kill duplicate; verify `runtime/singleton.py` |

---

## Architectural Debt

| Item | Debt | Impact |
|------|------|--------|
| Route shadowing | Path params declared before static paths | Fragile; breaks silently on reorder |
| Watchlist triplication | 3 APIs, 1 responsibility | Confusion, divergence |
| `_pages/` legacy dir | **73 unreachable** pages of 74 | Bundle bloat, maintenance burden |
| No OpenAPI in VCS | Schemas undocumented | Contract drift |
| Engine dep graph mismatch | Docs vs code disagree | Onboarding errors |
| Undated MIGRATED docs | Stale markers | Misleading status |

---

## Risk Acceptance Criteria

Before a change is considered safe, confirm:
- [ ] No new secrets in code, docs, or logs
- [ ] `websockets` pin unchanged (unless uvicorn upgraded simultaneously)
- [ ] Engine responsibility boundaries preserved
- [ ] Session Manager remains subscription authority
- [ ] WS#1/WS#2 remain broker-owned
- [ ] DB Writer remains sole persistence owner
- [ ] No route shadowing introduced
- [ ] Tests pass (Python + TypeScript)

---

## Related Documents
- `PROJECT_GAPS.md` — Gap register
- `PROJECT_ASSUMPTIONS.md` — Stated assumptions
- `../config/CONFIGURATION_CATALOG.md` — Config surface
- `../DEPENDENCY_MAP.md` — Dependency constraints
- `../security/SECURITY_ARCHITECTURE.md` — Security controls
