# Owner auth migration: Vercel → VM1

**Status:** Implemented and verified locally (2026-10-30). VM1 deployment and
Cloudflare tunnel recovery require SSH access to VM1.

## 1. Root cause

The Vercel auth routes used to execute the owner-auth logic in the Next.js
process (`lib/auth-db.ts`, `lib/auth-sessions.ts`, …). That code needs a
MongoDB connection, but Vercel has no route to MongoDB and no
`AUTH_MONGODB_URI` in its environment. Every auth call therefore failed with:

> The auth database is unavailable: MongoDB is not configured.
> Add MONGODB_URI (or AUTH_MONGODB_URI) to .env.local / python-service/.env.

Copying the production MongoDB URI to Vercel would have been the wrong fix: it
duplicates a secret, exposes the database to a second network, and still leaves
the auth state split across two runtimes.

## 2. Architecture

VM1 FastAPI is the single authority for MongoDB, the owner account, sessions,
OTP/MPIN/biometric state, and the trading/realtime operator JWT. Vercel keeps
only thin proxies:

```
Browser ──same-origin──▶ Next route (/api/auth/*) ──HTTPS──▶ VM1 FastAPI
                              │                                  │
                              └── forwards cookies, real IP,     └── MongoDB (VM2, private)
                                  body, and Set-Cookie back
```

Key modules:

| File | Role |
|------|------|
| `python-service/api/auth_app.py` | All `/api/auth/*` contracts: signup, login, OTP, session, devices, MPIN, PIN, events, WebAuthn data plane, operator token, liveness. |
| `lib/auth-proxy.ts` | Central proxy: cookie/IP/proto forwarding, `Set-Cookie`, timeouts, 503 policy, session gate. |
| `lib/auth-payload.ts` | Flattens the backend's global `{"ok":false,"detail":{…}}` envelope so the login UI sees `message`, `code`, `database:false`. |
| `proxy.ts` | Page/API gate. Decodes the cookie only to read `sid`, then asks VM1 `/api/auth/live?sid=…`; fails closed. |
| `app/api/auth/*/route.ts` | One thin route per browser endpoint. |
| `app/api/auth/trading-token/route.ts` | Session-gated (`requireMpin`) operator JWT via VM1. |
| `app/api/realtime/token/route.ts` | Session-gated gateway token; operator JWT minted by VM1. |
| `lib/api-base.ts` | Same-origin realtime by default; `NEXT_PUBLIC_WS_URL` override for serverless. |

### Route map

| Browser route | VM1 endpoint |
|---------------|--------------|
| `POST /api/auth/signup` | `POST /api/auth/signup` |
| `POST /api/auth/login` | `POST /api/auth/login` |
| `POST /api/auth/login/verify-otp` | `POST /api/auth/login/verify-otp` |
| `GET /api/auth/status` | `GET /api/auth/status` |
| `GET /api/auth/session` | `GET /api/auth/session` |
| `POST /api/auth/logout` | `POST /api/auth/session/revoke` |
| `GET /api/auth/devices` | `GET /api/auth/devices` |
| `POST /api/auth/devices/revoke` | `POST /api/auth/devices/revoke` |
| `GET /api/auth/events` | `GET /api/auth/events` |
| `POST /api/auth/mpin/*` | `POST /api/auth/mpin/*` |
| `POST /api/auth/pin/*` | `POST /api/auth/pin/*` |
| `GET /api/auth/overview` | `GET /api/auth/overview` |
| `GET /api/auth/setup` | `GET /api/auth/setup` |
| `* /api/auth/biometric/*` | `* /api/auth/webauthn/*` + credentials/remove |
| `GET /api/auth/trading-token` | `POST /api/auth/operator-token` |
| `GET /api/realtime/token` | `POST /api/auth/operator-token` then `GET /api/realtime/token` |

### Security invariants

- The backend verifies the session signature and the live session row. Vercel's
  decode-only step is never sufficient: a forged `sid` cannot pass
  `/api/auth/live`.
- Cookies, `Set-Cookie`, the real client IP headers (`x-forwarded-for`,
  `x-real-ip`, `cf-connecting-ip`, `x-vercel-forwarded-for`) and
  `x-forwarded-proto` are forwarded unchanged.
- A missing/unreachable backend returns `503 BACKEND_UNAVAILABLE`; no route
  fabricates `authenticated:true`.
- `/api/auth/operator-token` and both token routes require a live session with
  MPIN or biometric setup completed. `APP_PASSWORD` never reaches Vercel.
- WebAuthn cryptography stays in the Next Node layer, but credentials and
  challenges are stored behind VM1. The browser receives only public options.

## 3. Environment split

### VM1 `/etc/kds/backend.env` (root:root, 0600)

Redacted inventory (values never committed or printed):

| Group | Variables |
|-------|-----------|
| Database | `MONGODB_URI`, `MONGODB_DATABASE` |
| Service | `HOST=10.1.1.133`, `PORT=8000`, `CORS_ORIGINS` |
| Operator JWT | `APP_USERNAME`, `APP_PASSWORD`, `JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE`, `JWT_TTL_SECONDS` |
| Owner auth | `AUTH_SESSION_SECRET`, `AUTH_SIGNUP_EMAIL`, `AUTH_SIGNUP_MPIN`, `AUTH_MAX_ACTIVE_SESSIONS`, `AUTH_ORIGIN`, `AUTH_OTP_DEV_FALLBACK` |
| OTP delivery | `AUTH_SMTP_HOST`, `AUTH_SMTP_PORT`, `AUTH_SMTP_SECURE`, `AUTH_SMTP_USER`, `AUTH_SMTP_PASS`, `AUTH_EMAIL_FROM`, `AUTH_EMAIL_TO` (or `AUTH_OTP_WEBHOOK_URL`) |
| Broker (unchanged) | broker mode/credentials, scheduler, agent tokens |

### Vercel

| Variable | Required | Notes |
|----------|----------|-------|
| `BACKEND_URL` | Yes | Public HTTPS base URL of VM1. |
| `NEXT_PUBLIC_WS_URL` | Optional | `wss://<host>/ws/realtime`; without it realtime degrades to REST polling. |
| `AUTH_RP_ID`, `AUTH_ORIGIN`, `AUTH_RP_NAME` | Optional | Only for WebAuthn biometrics. |

No MongoDB, SMTP, signup gate, session secret, or `APP_PASSWORD` on Vercel.

## 4. Deployment

1. Push the verified commit to `main`.
2. On VM1: back up the current commit, `/etc/kds/backend.env`,
   `/etc/systemd/system/kds-backend.service`, and `git status`.
3. Fetch/reset `/opt/kds/repo` to the exact commit (never force-push; preserve
   local runtime state and untracked `.env` files).
4. `/opt/kds/venv/bin/pip install -r python-service/requirements.txt` if
   dependencies changed.
5. Add only missing env keys to `/etc/kds/backend.env`; keep existing valid
   values and never rotate secrets automatically.
6. `systemctl daemon-reload && systemctl restart kds-backend`.
7. Verify:
   - `curl -fsS http://10.1.1.133:8000/api/system/health`
   - `curl -fsS http://10.1.1.133:8000/api/auth/status`
   - `POST /api/auth/operator-token` without a cookie → 401/403 (not 404/405)
8. Start/recover the tunnel and record the exact public URL.
9. Update Vercel `BACKEND_URL` (and `NEXT_PUBLIC_WS_URL`), then redeploy.

## 5. Verification performed locally

| Check | Result |
|-------|--------|
| `npm test` | 485 passed, 0 failed |
| `npm run typecheck` | Clean |
| `npm run build` | Succeeds, no Turbopack warnings |
| `pytest tests/test_auth_app.py tests/test_timezones.py` | 55 passed |
| Full Python suite (excluding `test_event_ledger.py`) | 1799 passed, 11 failed — all 11 reproduce at `HEAD` (10 directly, 1 order-dependent local-env leak) |
| Contract tests | Browser route ↔ VM1 method/path, cookie/IP forwarding, 503 policy, error flattening, session-minted tokens |
| WebSocket URL tests | Public override accepted; invalid override falls back; `WS_BACKEND_URL` priority |

## 6. Rollback

### Vercel

Promote the previous deployment or `vercel rollback`. Restore the previous
`BACKEND_URL` value if the tunnel changed.

### VM1 code

```bash
cd /opt/kds/repo
git fetch origin
git checkout <previous-verified-commit>
sudo systemctl restart kds-backend
```

### VM1 env / unit

```bash
sudo cp /etc/kds/backend.env.bak-<timestamp> /etc/kds/backend.env
sudo chmod 600 /etc/kds/backend.env && sudo chown root:root /etc/kds/backend.env
sudo cp /etc/systemd/system/kds-backend.service.bak-<timestamp> /etc/systemd/system/kds-backend.service
sudo systemctl daemon-reload && sudo systemctl restart kds-backend
```

No MongoDB schema migration is required; the `app_auth_*` collections are
reused unchanged.
