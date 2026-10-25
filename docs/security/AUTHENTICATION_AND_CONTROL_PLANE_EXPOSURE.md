# AUTHENTICATION_AND_CONTROL_PLANE_EXPOSURE.md

## Unauthenticated control plane on a network-bound trading backend

**Created**: 2026-09-28
**Method**: static source analysis only
**Severity**: **CRITICAL**
**Status**: `STATIC_VERIFIED` for the code and configuration facts below.
The *exploitability* of a running system is **`NOT_VERIFIED`** — nothing was executed.

---

## 1. Summary

The KAUSTUBH backend has a working JWT auth implementation, but it protects only
**3 of its 40 routers**. The unprotected set includes the engine **lifecycle control**
router and the **broker selection** router. The backend is configured to bind to
**all network interfaces** (`HOST=0.0.0.0`) with a **wildcard CORS origin**, and the
JWT signing secret falls back to a **hardcoded literal** when `JWT_SECRET` is unset —
which it is, in the committed `.env`.

Taken together: a host on the same network can stop, start, and restart trading engines
and switch the active trading broker, with no credential of any kind.

This is an independent finding from the already-recorded secret-exposure risk
(R-01 / `GET /api/settings`). It is worse in one respect: it needs **no** secret leak to
exploit.

---

## 2. Evidence

### 2.1 Auth exists and is sound in isolation
`services/jwt_auth.py` (90 lines, stdlib HMAC-SHA256, HS256) provides:
- `issue_token(username)` — line 35
- `verify_token(token)` — line 50 (validates signature, expiry, audience)
- `authenticate_user(username, password)` — line 75
- `read_token(request)` — line 86, accepts `Authorization: Bearer …` or `x-kaustubh-token`

`authenticate_user` is **fail-closed**: if `app_password` is empty it returns `False`
(line 78-80), and it uses `hmac.compare_digest` (line 83). No backdoor.

### 2.2 …but it is applied to only 3 of 40 routers
Router modules that reference the auth helpers:

| Module | Auth references |
|--------|-----------------|
| `api/terminal.py` | 6 |
| `api/ws_gateway.py` | 5 |
| `api/security.py` | 3 |

**The other 37 routers have no authentication.** Among them is
`api/engine_control.py` (211 lines), which is registered as a plain
`APIRouter(prefix="/api/services/engines", tags=["engine-control"])` — **no
`dependencies=`** (line 18), and no `Depends`, `HTTPBearer`, `APIKeyHeader`, or
`Authorization` check anywhere in the file. A grep for auth primitives across
`api\*.py` returns matches only in the three modules above.

Global check: `app.py` contains **40 `include_router()` calls and 0 with
`dependencies=`**. There is no global auth middleware — the only middleware registered
are `CORSMiddleware` (`app.py:872`) and `IstTimestampMiddleware` (`app.py:915`).

### 2.3 The unprotected endpoints

Base prefix `/api/services/engines`:

| Method | Path | Effect |
|--------|------|--------|
| **POST** | `/{engine_id}/start` | start an engine |
| **POST** | `/{engine_id}/stop` | **stop an engine** |
| **POST** | `/{engine_id}/restart` | **restart an engine** |
| POST | `/{engine_id}/heartbeat` | force heartbeat |
| POST | `/heartbeat-all` | heartbeat every engine |
| POST | `/health-check` | trigger health check |
| **POST** | `/broker/trading/select` | **switch the active trading broker** |
| **POST** | `/broker/market-data/select` | **switch the active market-data broker** |
| GET | `` , `/summary`, `/{engine_id}`, `/health`, `/metrics`, `/dependency-graph`, `/errors`, `/activity` | read engine internals |
| GET | `/broker/status`, `/broker/list`, `/broker/trading`, `/broker/market-data` | read broker internals |
| POST | `/db_writer_engine/flush` | force DB flush |

`stop` accepts a `{"confirm": true}` body, but that is a **client-supplied flag**, not an
authorization control (`engine_control.py:112-116`).

### 2.4 The backend binds to every network interface
- `config/settings.py:256` — `host` default `"0.0.0.0"`
- `python-service/.env` — `HOST=0.0.0.0`, `PORT=8000`
- `start_backend.py:195` — `Config("app:app", host=host, port=port, …)` with `host` from settings

So the default and the configured value agree: **all interfaces**.

### 2.5 CORS is a wildcard, with credentials
`app.py:872-878`:
```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins.split(",") if settings.cors_origins != "*" else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```
- `config/settings.py:261` — default `http://localhost:3000` (restrictive)
- `python-service/.env` — **`CORS_ORIGINS=*`** (permissive — the deployed value)
- `.env.example` also ships `CORS_ORIGINS=*`

Result: `allow_origins=["*"]` together with `allow_credentials=True`. Under Starlette this
combination makes the middleware reflect the caller's `Origin` and emit
`Access-Control-Allow-Credentials: true`, so a **browser on any site** can make
credentialed cross-origin calls to this API. (Exact header behaviour is
Starlette-version-dependent; `fastapi==0.115.0` is pinned. Not executed — treat the
header detail as `NOT_VERIFIED`, the configuration as `STATIC_VERIFIED`.)

**CORS is not an authorization control.** It constrains browser JavaScript only. It does
nothing against `curl`, a Python script, another machine on the LAN, a local process, or
any non-browser client.

### 2.6 The JWT signing secret falls back to a hardcoded literal
`services/jwt_auth.py:30`:
```python
secret = (settings.jwt_secret or "dev-insecure-jwt-secret").encode("utf-8")
```
- `config/settings.py:351` — `jwt_secret: str = field(default_factory=lambda: _env("JWT_SECRET"))`
- `config/settings.py:34` — `def _env(name, default=""): return os.getenv(name) or default`
- **`JWT_SECRET` is not present in `python-service/.env`** (verified by listing key names
  only — see §4)

So unless `JWT_SECRET` is supplied by the OS environment or by `.env.local`, the signing
secret is the literal string `dev-insecure-jwt-secret`, which is published in the source
repository. **Anyone can then mint a valid HS256 token** with the correct issuer
(`kaustubh-backend`) and audience (`kaustubh-terminal`) and pass `verify_token`.

For the three routers that *do* check auth, this converts authentication into
theatre: the attacker simply signs their own token.

> `jwt_auth.py:5-6` asserts *"Secrets (JWT_SECRET / APP_PASSWORD) never leave the
> backend."* That is a design intent in a docstring, not an enforced invariant — and the
> `jwt_secret` half of it is currently satisfied only by a public fallback constant.

---

## 3. What is `NOT_VERIFIED`

Stated plainly, because it bounds this finding:

1. **Whether the backend is currently running, and on which interface.** Nothing was
   executed; no port was probed.
2. **Whether `JWT_SECRET` is set in the OS environment or in `.env.local`.** Both are
   plausible. `python-service/.env.local` exists (234 bytes) and is gitignored, and
   `settings.py:14-19` loads it. I deliberately did not read its values.
   - Confirmed: `JWT_SECRET` is **absent from `.env`**
   - Unconfirmed: whether the fallback is actually in effect
3. **Whether a network path exists** to the host (VPN, firewall, NAT).
4. **The exact CORS response headers.** Not executed.
5. **Whether a reverse proxy, WAF, or tunnel** sits in front of port 8000 and performs
   authentication. None was found in the repository, but deployment topology is outside
   the codebase.
6. **Whether `engine_control.py`'s `stop` is guarded at the registry layer.** The
   `EngineRegistry._safety_check` / `_check_dependencies` methods
   (`services/engine_registry.py:235`, `:247`) may refuse some transitions. I read their
   signatures, not their bodies.

---

## 4. Method and secret-handling discipline

To establish the configuration facts above I read **key names only** from
`python-service/.env` via a pattern that captured the left-hand side and reported
`<set>` / `<EMPTY>` for the right-hand side. **No secret value was read, printed, or
recorded.** The keys confirmed present include `MPIN`, `TOTP_SECRET`, `CONSUMER_SECRET`,
`CLIENT_ID`, `CONSUMER_KEY`, `MONGODB_URI` — all treated as opaque.

The only values actually read were `HOST`, `PORT`, and `CORS_ORIGINS`, which are
connectivity settings, not secrets.

## 5. Impact if exploitable

This is a live-money trading terminal. Unauthenticated access to the engine control
router permits, by `curl` from any reachable host:

| Action | Endpoint | Trading consequence |
|--------|----------|---------------------|
| Stop end-of-day squareoff | `POST /api/services/engines/squareoff_engine/stop` | positions left unmanaged overnight |
| Stop order routing | `POST /api/services/engines/order_engine/stop` | orders accepted but never placed |
| Stop risk checks | `POST /api/services/engines/risk_engine/stop` | pre-trade limits possibly unenforced |
| Stop market data | `POST /api/services/engines/websocket_engine/stop` | blind trading, stale marks |
| Stop position tracking | `POST /api/services/engines/position_engine/stop` | incorrect margin and P&L |
| Switch trading broker | `POST /api/services/engines/broker/trading/select` | order routing redirected |
| Read all config | `GET /api/settings` (R-01) | broker credentials, if masking fails |

Note that `margin_engine`, `squareoff_engine`, `order_engine`, and `position_engine`
are already **not auto-started** (`app.py:629` — see `DOCUMENTATION_AUTHORITY.md` §4), so
their runtime state needs checking regardless of security.

## 6. Recommendations

**Not implemented — these are code/config changes requiring your approval.**

### Immediate (no code change)
1. **Confirm the deployment posture.** Is port 8000 reachable beyond the operator's
   machine? Is anything in front of it? This determines urgency.
2. **Verify `JWT_SECRET` is set** in the OS environment or `.env.local` for any
   non-loopback deployment. Confirm without printing the value, e.g.:
   ```powershell
   python -c "from config.settings import settings; print('SET' if settings.jwt_secret else 'EMPTY -> dev-insecure fallback ACTIVE')"
   ```

### Configuration (low risk, high value)
3. **Set `HOST=127.0.0.1`** unless remote access is genuinely required. Bind to the
   loopback and reach it via an SSH tunnel or a reverse proxy that authenticates.
4. **Tighten `CORS_ORIGINS`** to the actual frontend origin. Also fix `.env.example`,
   which currently ships `CORS_ORIGINS=*` and will reproduce this on the next deployment.
5. **Consider `allow_credentials=False`** while the origin list is `*` — the combination
   is a known misconfiguration.

### Code (needs a decision and a review)
6. **Add authentication to `engine_control.py`**, at minimum to the `POST` lifecycle and
   `broker/*/select` routes. The mechanism already exists — `verify_token` /
   `read_token` from `services/jwt_auth.py`, as used in `terminal.py`.
7. **Refuse to start with the fallback secret in production.** `jwt_auth._sign` should
   raise if `jwt_secret` is empty and `NEO_ENVIRONMENT` is `prod` (currently the default
   at `settings.py:300`). Fail-closed, like `authenticate_user` already does.
8. **Apply `dependencies=` to all 40 `include_router()` calls** (or move auth into global
   middleware) so new routers are protected by default rather than by memory.
9. **Add route-level authorisation for engine control** — engine start/stop is an
   operator capability and should not be available to a read-only terminal session.

### Documentation
10. `docs/security/SECURITY_ARCHITECTURE.md` and `docs/architecture/25_SECURITY_ARCHITECTURE.md`
    should state the actual auth coverage (3 of 40 routers) rather than implying
    uniform protection. **Not yet audited — listed for the next pass.**

## 7. Related

| Item | Reference |
|------|-----------|
| Secret exposure via `/api/settings` (unverified) | R-01, GAP-002, `PENDING-001` step 3 |
| Engine registry, 17 engines, auto-start gaps | `DOCUMENTATION_AUTHORITY.md` §4, D-15 |
| Fictional `kaushub` CLI — real replacement documented | D-13, `ENGINE_CONTROL_API.md` |
| Security catalog (bootstrap) | `docs/security/SECURITY_ARCHITECTURE.md` |
| Risk register | `docs/PROJECT_RISKS.md` |

---
*Static analysis only. No code executed, no port probed, no secret value read or
recorded. Exploitability `NOT_VERIFIED`.*
