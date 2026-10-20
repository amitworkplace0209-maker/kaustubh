# PENDING-001-live-verification.md

## Task ID
PENDING-001

## Date Created
2026-09-28

## Priority
**P0 — CRITICAL**

## Title
Live runtime verification of the KAUSTUBH backend

## Status
`PARTIAL` (2026-10-07 read-only evidence below; mutation steps blocked — see note)

> **Update 2026-10-07 — read-only live evidence (no POST ran).**
> Detail: `docs/verification/028-market-watch-terminal-redesign-and-live-verification.md`.
> Observed against the running backend (market hours, `broker_mode=dummy`):
> step 2 — `/api/services/engines/summary` → total **17** (RUNNING 15, REGISTERED 2),
> matching the corrected count; step 3 — `/api/settings` + `/api/settings/runtime`
> contain **no secret values** (`mongodb_uri` empty, no `mongodb+srv://` credentials);
> step 4 — `/health`, `/api/health`, `/api/system/health` all 200 with Mongo up
> (`/api/health` returns a minimal body, the other two the full component payload);
> step 6b — `/ws/realtime` TCP-connects but requires `?token=<JWT>` (401 + close 4401
> without it); step 8 — broker status shows Kotak CONNECTED for trading+marketData,
> no failover (as documented).
> **BLOCKED mutation steps**: `/health` reports the effective database as the
> production-named **`kaustubh`** on shared Atlas — per this file's own precondition 5,
> OpenAPI-diff writes aside, every step that writes state stays blocked until a
> `kaustubh_test` backend is available. The 503-without-Mongo check was not run
> (would need stopping shared Mongo).

## Source
`docs/FINAL_REPORT.md` §11, `docs/testing/VERIFICATION_MATRIX.md`, `docs/PROJECT_GAPS.md`

---

## Blocking Reason
All 20 runtime verification items require a running system. None were performed.

> **Update 2026-10-01 — partial live-runtime evidence only; this task stays `PENDING`.**
> Implementation 021 (`docs/implementation/021-trade-page-realtime-performance.md`,
> `docs/verification/021-trade-page-realtime-performance-verification.md`) ran the
> backend on the **live** Kotak dummy feed and measured endpoint latency, process RSS,
> and `engine_ram_percent`. That is *supporting* evidence, not a substitute: the
> engine-registry enumeration (step 2), secret-redaction check (step 3), health-503
> check (step 4), OpenAPI reconciliation (step 5), MongoDB inspection (step 6),
> WebSocket transport test (step 6b) and broker-selection probe (step 8) were **not**
> performed. None of the Success Criteria above are ticked by 021.

---

## Preconditions
1. Valid `MONGODB_URI` pointing at a **test** database (`kaustubh_test`), never production
2. `broker_mode=dummy` to avoid real-money operations
3. Kotak/Shoonya credentials either absent or unused (dummy mode)
4. Environment must be non-production
5. Confirm the **effective** database name before proceeding. `35_AI_AGENT_CONTEXT.md` claims
   `kaustubh_trading`; that claim is `NOT_VERIFIED`. If the resolved name is a production
   database, **stop**.

> ### ⚠ Do not use the `python -m kaushub.*` commands
> `32_ARCHITECTURE_GAPS.md` and `34_DEVELOPER_ONBOARDING.md` prescribe a
> `python -m kaushub.engine …` / `kaushub.cli …` CLI for engine management.
> **That package does not exist** (finding D-13). Those commands fail immediately.
> A real **backend** CLI exists — `python start_backend.py run|status|stop|restart` —
> but engine control is **HTTP-only**. See `docs/ENGINE_CONTROL_API.md` for the
> endpoint map and the fictional→real command mapping.

> ### 🔴 STOP-AND-CHECK BEFORE STEP 1: the backend binds all interfaces, unauthenticated
> `python-service\.env` sets **`HOST=0.0.0.0`** and **`CORS_ORIGINS=*`**, and **37 of
> the 40 routers have no authentication** — including engine start/stop/restart and
> broker selection.
>
> **Therefore, before starting anything:**
> 1. **Confirm the machine's network position.** If this host is reachable from an
>    untrusted network, starting the backend exposes engine control to that network.
> 2. **Prefer to override the bind for the verification run** so the exposure does not
>    persist after the test:
>    ```powershell
>    $env:HOST = "127.0.0.1"
>    ```
>    `start_backend.py` reads `settings.host`, and `.env` does not override real
>    environment variables — a set `$env:HOST` wins.
> 3. **Confirm `JWT_SECRET` is set** (do not print it):
>    ```powershell
>    python -c "from config.settings import settings; print('SET' if settings.jwt_secret else 'EMPTY -> dev-insecure fallback ACTIVE')"
>    ```
>    If it reports EMPTY, the fallback literal is in effect and any token can be forged.
> 4. **Do not call any `POST` endpoint** during this task except `/heartbeat-all`.
>    `stop`/`restart` and `broker/*/select` are not reversible from outside the process.
>
> Full analysis: `docs/security/AUTHENTICATION_AND_CONTROL_PLANE_EXPOSURE.md` (R-17, R-18).

> ### 🔴 NEW STOP-CHECK (2026-09-28): operator access needs no credentials at all
> Three findings, all read directly from source, mean the live app is **unlocked by
> default** and the "session" that gates it is **forgeable offline**:
>
> 1. **The session token is unsigned.** `lib/auth-crypto.ts` builds `kaustubh_session`
>    as base64 of plaintext JSON — no signature, and **no `expires` field**. A cookie can
>    be constructed by hand with no credentials. (**R-36**)
> 2. **The app lock fails open.** `app/api/auth/login/route.ts` grants operator access
>    when `!appLock` or `!user`; `app_lock_enabled` defaults **false** in `config.py` with
>    no env override; `.env` has no `APP_LOCK_PIN`; `.auth/` is gitignored. A fresh
>    checkout is therefore **unlocked**, and `POST /api/auth/login {"direct": true}` is
>    then a documented no-credential operator path. (**R-37**)
> 3. **A forged session escalates to a backend operator JWT.**
>    `/api/realtime/token` checks only the forgeable cookie, then calls
>    `acquireOperatorJwt()` with server-side `APP_USERNAME`/`APP_PASSWORD` and returns
>    that JWT **to the browser**. Those vars are currently unset so it degrades to
>    anonymous, but the escalation becomes live the moment they are configured.
>    (**R-38**)
>
> **Consequence for this task**: a `POST /api/auth/login {"direct": true}` is a
> *successful* operator login in the current configuration, not a failed one. Treat any
> result of that call as an incident, not a test. **Do not run step 3's escalation probe
> against a funded account or a shared network.**
>
> **Recommended before any live run** (all require code changes, so they are *not*
> done here): make the lock fail **closed**, sign the session, and stop returning
> operator credentials to the client.
> Detail: `docs/security/SESSION_TOKEN_FORGERY_AND_AUTH_BYPASS.md`.

---

## Steps

### 1. Start backend
```bash
cd C:\project\python-service
# confirm .env / .env.local exist with MONGODB_URI and broker_mode=dummy
python start_backend.py
```
`start_backend.py` is at `python-service\`, **not** the repository root.
Capture the startup log. It prints `"Engine Registry: %d engines registered"` (`app.py:644`).

### 2. Verify engine registry (P0)
```bash
curl http://localhost:8000/api/services/engines
curl http://localhost:8000/api/services/engines/summary
```
(These are `GET` — safe. Endpoint map: `docs/ENGINE_CONTROL_API.md` §2.)
**Assert: 17 engines**, not 15. The architecture documents' 15-engine claim is **wrong** —
code registers 14 native + 3 facade (`app.py:609-626`,
`services/legacy_engine_facades.py:428-432`). See `docs/DOCUMENTATION_AUTHORITY.md` §4.
If the live count differs, **record the actual number** and reconcile.

**Record**: Which engines are RUNNING vs REGISTERED vs ERROR.

**Specifically resolve these four contradictions** (findings D-15, D-16):
| Engine | Documented as | Code says | Check |
|--------|---------------|-----------|-------|
| `market_watch_engine` | "NOT IMPLEMENTED / no standalone engine" | **registered + auto-started** (`app.py:615,629`) | Present? |
| `audit_engine` | "UNKNOWN — not started, start manually" | **registered + auto-started** (`app.py:620,629`) | Running? |
| `watchlist_target_engine` | "UNKNOWN — not initialized" | **absent from all code** | Confirm absent |
| `margin_engine`, `squareoff_engine` | — | registered but **omitted from auto-start** (`app.py:629`) | Actually running? |

### 3. Verify secret redaction (P0, CRITICAL)
```bash
curl http://localhost:8000/api/settings
curl http://localhost:8000/api/settings/runtime
```
**Assert**: Response contains **no** values for `jwt_secret`, `mpin`, `totp_secret`, `consumer_key`, `shoonya_secret_key`, `mongodb_uri`.
**If any secret is present → escalate immediately as a P0 security incident.**

### 4. Verify health endpoints
```bash
curl -i http://localhost:8000/health
curl -i http://localhost:8000/api/health
curl -i http://localhost:8000/api/system/health
```
**Assert**: `/api/system/health` returns 503 when MongoDB is stopped.
**Note**: Record which module's `/api/health` wins (conflicts with D-01).

### 5. Capture OpenAPI spec
```bash
curl http://localhost:8000/openapi.json -o C:\Users\1208a\AppData\Local\Temp\opencode\openapi.json
```
**Then**: diff against `docs/api/API_CATALOG.md` (~450 static route definitions) and
reconcile the path count. Note any duplicate operation IDs.
Write to the temp directory, **not** into `docs/api/`, to avoid committing a generated
artifact as if it were hand-maintained documentation.

### 6. Verify MongoDB
```bash
# list collections
# check indexes
# check document counts
```
**Record**: Actual collection names and the **effective database name** vs
`docs/database/DATABASE_COLLECTION_CATALOG.md` and the `kaustubh_trading` claim in
`35_AI_AGENT_CONTEXT.md`.

> **Update 2026-09-28**: the earlier caveat here ("`migrations.py` and
> `connection.py` have not been read") is **stale** — both have now been read.
> `database/migrations.py` is a custom forward-only ledger (not Alembic) with no
> rollback path; startup does **not** use `dry_run`, and its lock is released
> fire-and-forget with a 60-second stale window. The `session_manager_*` index
> definitions are catalogued in `docs/database/DATABASE_COLLECTION_CATALOG.md`
> (18 unique on `instruments`, 6 on `events`, 1 owner on `revisions`).
> **Still open**: the *effective* database name, the *live* index set, the migration
> state, and all document counts remain `NOT_VERIFIED`.
>
> **Also check TTL**: no TTL index exists — expiry is application-managed
> (`expires_at` + `expiry_type`). Do not expect TTL to clean up anything.
>
> **Migration repair semantics**: the repair path **reassigns** `event_id` on duplicate
> documents and **preserves** every record; it does **not** delete. (An earlier
> documentation claim that it deletes the remainder was wrong and has been corrected.)

### 6b. Verify the WebSocket transport
There is exactly **one** WebSocket route in the backend:
`@router.websocket("/ws/realtime")` at `api/ws_gateway.py:278`.
```bash
# e.g. with websocat, wscat, or a small Python script
ws://127.0.0.1:8000/ws/realtime
```
**Assert**: a connection succeeds and a message round-trips.
The 4-WS model in `WebSocket_ConnectionManager_Flow.md` describes **logical channels
multiplexed over this single route**, not four separate endpoints. Confirm the
multiplexing, message envelope types, and auth. A separate backend→frontend fan-out layer
is started at `app.py:652` (`connection_engine`).

> **Statically verified already (D-23)** — do not re-test these, they were false positives:
> - internal `engine_snapshot` **does** map to wire type **`engine.status`**, channel
>   `engines`, payload nested under `data`. A grep for `engine.status` in the frontend
>   types fails and is **not** evidence of a missing type.
> - `welcome.heartbeatIntervalS` **is** present and is in **seconds** as the backend
>   sends it.
> - The **4-WS banner contradiction is a documentation problem, not a code defect** (D-07):
>   one route, four logical channels. The claim in `34_DEVELOPER_ONBOARDING.md` about four
>   separate endpoints is fiction.
>
> **Still worth confirming at runtime**: delivery, auth, and reconnect. Also note the
> backend emits a monotonic per-session `sequence` and **the client ignores it**, so
> there is no stale-frame detection; and once the first realtime frame arrives, the
> frontend suppresses REST updates for the rest of the session.

### 7. Test route collisions
```bash
curl http://localhost:8000/api/services/engines/broker/status
curl http://localhost:8000/api/health
curl http://localhost:8000/api/system/health
```
**Assert**: `/api/services/engines/broker/status` returns broker status, not an
engine-detail response for `engine_id="broker"`. Record which module's `/api/health`
wins (conflict D-01).

> **Update 2026-09-28 — the `broker` shadowing hazard is DISCONFIRMED.** The two path
> shapes cannot collide (`/broker/status` is two segments; `/{engine_id}` is one), so
> FastAPI ordering cannot swallow it. This check is now low-value; keep it only as a
> cheap regression guard, or drop it.
>
> **What this test does NOT cover**: the **frontend** `/trading` route collision
> hypothesis (D-05) is withdrawn — 151 routable pages yield 151 distinct route strings,
> and `HEAD` does not contain both pages either. See `FRONTEND_PAGES_AUDIT.md` §2.

### 8. (new, 2026-09-28) Broker selection and failover — observe, do not fix
```bash
curl http://localhost:8000/api/services/engines/broker/status
```
**What to record**:
- There is **no failover** to test. No health check, failure detection, retry, or circuit
  breaker exists; status is computed and never acted on. Do not expect a switch when a
  broker drops. (**R-39**)
- `manager.active_terminal()` and `registry.get_trading_broker()` are **independent**
  sources of truth that never reconcile. Switch a terminal, then read the registry, and
  demonstrate the split (no real broker login needed). (**R-40**)
- If the market-data broker is `dummy`, `get_market_data_status()` will report the
  **real** broker's live WebSocket state. Treat any "dummy CONNECTED, 850 symbols" line
  as this bug, not as success. (**R-42**)
- Shoonya is declared all-capabilities-`False` while its adapter is the largest in the
  codebase; confirm whether selecting it is genuinely rejected. (**R-41**)
Detail: `docs/broker/BROKER_SELECTION_AND_FAILOVER.md`.

---

## Success Criteria
- [ ] Backend started; startup log captured with UTC timestamp
- [ ] **17** engines enumerated with state and health (record the actual count)
- [ ] The 4 engine-count contradictions in step 2 resolved
- [ ] No secret values in any settings response
- [ ] `/api/system/health` returns 503 without MongoDB
- [ ] OpenAPI exported and reconciled with `API_CATALOG.md`
- [ ] WebSocket `/ws/realtime` connects and round-trips a message
- [ ] Actual collections, live indexes, migration state, and database name recorded
- [ ] Broker selection divergence demonstrated (step 8) — **no failover to verify**
- [ ] **No production data touched; no real broker login attempted**
- [ ] **No `POST` to `/api/auth/login` or `/api/realtime/token` without explicit owner
      sign-off** — in the current configuration those are no-credential operator paths

### Deliberately NOT success criteria
These were previously listed and are now removed, because they are already settled or
were wrong:
- ~~Route collision behavior recorded~~ — statically disconfirmed (D-01, D-05)
- ~~Engine `engine.status` type present~~ — statically verified present (D-23)
- ~~TTL indexes present~~ — **no TTL exists by design**; expiry is application-managed

---

## Deliverable
Update `docs/testing/VERIFICATION_MATRIX.md` and `docs/engines/ENGINE_INVENTORY.md` with **observed** values. Create `docs/verification/016-live-runtime-verification.md`.

---

## Related
- `docs/PROJECT_GAPS.md` GAP-001, GAP-002, GAP-010, GAP-026, GAP-027, GAP-028
- `docs/PROJECT_RISKS.md` R-01, R-05, R-17, R-18, R-36, R-37, R-38, R-39, R-40, R-41, R-42
- `docs/security/SESSION_TOKEN_FORGERY_AND_AUTH_BYPASS.md` — the unsigned-session stop-check
- `docs/security/AUTHENTICATION_AND_CONTROL_PLANE_EXPOSURE.md` — R-17 unauthenticated control plane
- `docs/broker/BROKER_SELECTION_AND_FAILOVER.md` — step 8 detail
- `docs/database/DATABASE_COLLECTION_CATALOG.md` — step 6 expectations
- `docs/audits/FRONTEND_PAGES_AUDIT.md` — the withdrawn route-collision claim

---

## Related serial-022 evidence (added 2026-10-01)

`docs/implementation/022-data-center-realtime-snapshot-push-and-page-redesign.md`
+ `docs/verification/022-data-center-realtime-snapshot-push-and-page-redesign-verification.md`
contribute live-verification evidence to this pending file:

- Backend restarted onto the new code (`start_backend.py status` → `health: OK`,
  pid 11920).
- `GET /api/system/data-center/snapshot` observed 200 with
  `realtime.available=True`, `health.overall=DEGRADED` (previously `UNKNOWN`),
  `database.connected=True`, cold `buildMs=4697`.
- WS#2 observed end-to-end: `welcome` advertised the `data_center` state channel,
  `subscribe {"channel":"data_center"}` acked ok, and a
  `type=data_center.snapshot channel=data_center source=data_center` frame was
  delivered within one 5 s cycle.

**This does NOT close PENDING-001.** The Data Center page itself was not verified
in a browser (no UI pass), and the other live-verification rows (broker session,
Atlas behaviour, the 017-019 surfaces) still have no observation from this task.
