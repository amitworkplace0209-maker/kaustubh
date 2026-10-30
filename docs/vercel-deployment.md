# KDS — Vercel Frontend Deployment Checklist

**Frontend root:** `.` (project root)  
**Framework:** Next.js 16.3.4 (App Router)  
**Build command:** `npm run build`  
**Production start (self-hosted):** `npm start` → `node server.mjs --production`

**Current architecture (2026-10-30):** VM1 FastAPI owns MongoDB, the owner
account, sessions, OTP/MPIN state and the operator JWT. Every `/api/auth/*`
route on Vercel is a thin proxy (`lib/auth-proxy.ts`) to VM1. Vercel has **no**
MongoDB credentials and does **not** need `APP_PASSWORD`. See
[`auth-vm1-migration.md`](./auth-vm1-migration.md) for the full migration
record.

---

## 1. Required Vercel Environment Variables

Set these in **Settings → Environment Variables** for Production (and Preview
if you use previews).

| Variable | Value | Required | Notes |
|----------|-------|----------|-------|
| `BACKEND_URL` | `https://<public-backend-host>` | **Yes** | VM1 FastAPI over HTTPS (Cloudflare Tunnel or reverse proxy). Used by all server-side proxies and `next.config.js` rewrites. Server-only. |
| `NEXT_PUBLIC_WS_URL` | `wss://<public-backend-host>/ws/realtime` | Optional | Full public realtime endpoint. Vercel cannot proxy WebSocket upgrades, so without this the UI falls back to REST polling. The gateway still requires the short-lived `?token=`. |
| `AUTH_RP_ID` | `kds.example.com` | Optional | WebAuthn relying-party ID (domain, not IP). Only for biometrics. |
| `AUTH_ORIGIN` | `https://kds.example.com` | Optional | Comma-separated allowed WebAuthn origins. Only for biometrics. |
| `AUTH_RP_NAME` | `KAUSTUBH Trading Platform` | Optional | WebAuthn display name. |

### Do NOT set these on Vercel

| Variable | Why not |
|----------|---------|
| `MONGODB_URI`, `AUTH_MONGODB_URI`, `AUTH_MONGODB_DB` | Database access lives exclusively on VM1. |
| `AUTH_SESSION_SECRET`, `APP_SESSION_SECRET` | Session signing is verified by VM1. Vercel only decodes the cookie to obtain `sid` and asks VM1 whether the session is live. |
| `AUTH_SIGNUP_EMAIL`, `AUTH_SIGNUP_MPIN` | One-time signup gate, enforced by VM1. |
| `AUTH_SMTP_*`, `AUTH_OTP_WEBHOOK_URL` | OTP delivery happens on VM1. |
| `APP_USERNAME`, `APP_PASSWORD`, `JWT_SECRET` | Operator JWT is minted by VM1 via `POST /api/auth/operator-token`. |
| Kotak/Shoonya credentials | Broker secrets — `/etc/kds/backend.env` only. |
| Any secret in `NEXT_PUBLIC_*` | Browser-visible. `NEXT_PUBLIC_WS_URL` must never contain a token. |

`NEXT_PUBLIC_WS_URL` is the only public backend address. It is a hostname, not
a credential. Leave it unset for local/self-hosted deploys — the browser then
uses same-origin `/ws/realtime` and `server.mjs` tunnels the upgrade.

---

## 2. VM1 Backend Requirements

`/etc/kds/backend.env` (owner `root`, mode `0600`) must contain at least:

```dotenv
MONGODB_URI=mongodb://<user>:<password>@10.1.2.178:27017/kds?authSource=admin
MONGODB_DATABASE=kds
HOST=10.1.1.133
PORT=8000
CORS_ORIGINS=https://<vercel-production-origin>

APP_USERNAME=<operator>
APP_PASSWORD=<operator-password>
JWT_SECRET=<jwt-secret>
JWT_ISSUER=kaustubh-backend
JWT_AUDIENCE=kaustubh-terminal
JWT_TTL_SECONDS=28800

AUTH_SESSION_SECRET=<48+ random chars>
AUTH_SIGNUP_EMAIL=<owner email>
AUTH_SIGNUP_MPIN=<one-time gate MPIN>
AUTH_MAX_ACTIVE_SESSIONS=2
AUTH_ORIGIN=https://<vercel-production-origin>
AUTH_OTP_DEV_FALLBACK=false
# AUTH_SMTP_* or AUTH_OTP_WEBHOOK_URL for second-device OTP
```

Never print these values. Validate presence and placeholders with
`deploy/deploy-vm1-backend.sh`; it never echoes secrets.

---

## 3. Public HTTPS Endpoint

VM1 listens on the private address `10.1.1.133:8000`. Vercel cannot reach it
directly, so expose it with TLS:

1. **Cloudflare Quick Tunnel (temporary):**
   ```bash
   cloudflared tunnel --url http://127.0.0.1:8000 --no-autoupdate
   ```
   The command prints a `https://<random>.trycloudflare.com` URL. This URL
   changes on every restart, so re-read it after each restart and update Vercel.
2. **Named tunnel / reverse proxy (stable):** configure a Cloudflare named
   tunnel or Nginx/Traefik with a real certificate and a DNS name.

Then set on Vercel:

```
BACKEND_URL=https://<tunnel-host>
NEXT_PUBLIC_WS_URL=wss://<tunnel-host>/ws/realtime
```

Do **not** open port 8000 or MongoDB port 27017 in the OCI security list. The
tunnel is outbound-only from VM1.

---

## 4. Pre-Deployment Checks (Local)

```bash
npm ci
npm test          # 485 tests, 0 failures
npm run typecheck
npm run build     # must complete without warnings/errors
```

Backend checks on VM1:

```bash
cd /opt/kds/repo
/opt/kds/venv/bin/python -m pytest python-service/tests/test_auth_app.py -q
curl -fsS http://10.1.1.133:8000/api/auth/status
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  http://10.1.1.133:8000/api/auth/operator-token   # expect 401/403
```

---

## 5. Deploy / Redeploy

### Git integration (recommended)

1. Push the verified commit to `main`.
2. Vercel builds automatically.
3. Confirm the new deployment uses the environment variables from section 1.
4. Redeploy after changing any variable — Vercel does not inject new values
   into an existing build.

### Vercel CLI

```bash
vercel link
vercel --prod
```

Never paste tokens/secrets into terminal output or chat.

---

## 6. Post-Deployment Verification

| Check | Command / URL | Expected |
|-------|--------------|----------|
| Login page | `https://<vercel-url>/login` | Renders; `/api/auth/status` is proxied |
| Auth status | `https://<vercel-url>/api/auth/status` | JSON with `hasOwner`/`signupConfigured` |
| Backend outage policy | Stop the tunnel briefly | Login shows a retryable 503, never a fake success |
| Session | Sign in | `kaustubh_session` set by VM1 through the proxy |
| Trading token | Sign in → trade page | Minted by VM1 (`/api/auth/operator-token`), no `APP_PASSWORD` on Vercel |
| Realtime | Browser devtools → WS | `wss://<tunnel-host>/ws/realtime?token=…` opens when `NEXT_PUBLIC_WS_URL` is set; otherwise REST polling continues honestly |
| Devices/MPIN/biometrics | Settings → Security | Data comes from VM1 |

### Common failure modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `BACKEND_UNAVAILABLE` 503 | `BACKEND_URL` unset, wrong, or tunnel down | Fix the variable / restart tunnel / redeploy |
| Login says "auth database unavailable" | VM1 cannot reach MongoDB | Check `/api/system/health` on VM1; fix `MONGODB_URI` |
| Login works, trade page has no session | Deployed code predates `/api/auth/operator-token` and Vercel has no `APP_PASSWORD` | Deploy the current backend |
| WebSocket never opens | `NEXT_PUBLIC_WS_URL` unset/invalid or tunnel down | Set the exact `wss://.../ws/realtime` URL and redeploy |
| Cookies not persisted | Backend URL is HTTP or proxy strips `Set-Cookie` | Use HTTPS and the bundled proxy; check `x-forwarded-proto` |

---

## 7. Rollback

```bash
# Vercel CLI
vercel rollback

# Or Vercel dashboard → Deployments → previous deployment → Promote to Production
```

Backend rollback: restore the previous commit in `/opt/kds/repo`, reinstall
dependencies if needed, then `systemctl restart kds-backend`. Restore
`/etc/kds/backend.env` from its timestamped backup only if you changed it.
No MongoDB schema migration is performed by this frontend.

---

## 8. Remaining Operator Actions

- [ ] Stable public HTTPS endpoint (named Cloudflare tunnel or reverse proxy + DNS)
- [ ] Set `CORS_ORIGINS` and `AUTH_ORIGIN` to the real Vercel origin
- [ ] Configure SMTP or OTP webhook so a second device can log in
- [ ] Strong `AUTH_SIGNUP_MPIN` before first production signup
- [ ] Rotate any secret that was ever pasted into chat/logs
