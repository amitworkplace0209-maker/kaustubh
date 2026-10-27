# KDS — Vercel Frontend Deployment Checklist

**Frontend root:** `.` (project root)  
**Framework:** Next.js 16.3.4 (App Router)  
**Build command:** `npm run build`  
**Production start:** `npm start` → `node server.mjs --production`  
**Custom server note:** `server.mjs` (with WebSocket proxy) does NOT run on Vercel. On Vercel, realtime falls back to REST polling. The browser connects to its own origin for `/ws/*`; Vercel cannot hold persistent sockets, so WebSocket is unavailable.

---

## 1. Required Vercel Environment Variables

Set these in the Vercel project **Settings → Environment Variables** (Production and Preview as applicable). None of these are secrets — they are runtime configuration.

| Variable | Value (example) | Required | Notes |
|----------|-----------------|----------|-------|
| `BACKEND_URL` | `https://kds-api.example.com` | Yes | Backend API base URL for `/api/*` rewrites in `next.config.js`. Must be HTTPS for production. |
| `WS_BACKEND_URL` | `https://kds-api.example.com` | Yes | WebSocket proxy target for `server.mjs` (local/self-hosted only). On Vercel, WS is not available — set anyway for consistency. |
| `AUTH_SESSION_SECRET` | `<96+ hex chars>` | Yes | HMAC secret for `kaustubh_session` cookie. Must match between frontend server and any shared auth logic. Generate: `openssl rand -hex 48` |
| `AUTH_MONGODB_URI` | `mongodb://...` | Yes | Auth database URI |
| `AUTH_MONGODB_DB` | `kaustubh` | Yes | Auth database name |
| `AUTH_SIGNUP_EMAIL` | `owner@example.com` | Yes (first-time) | One-time signup gate email |
| `AUTH_SIGNUP_MPIN` | `123456` | Yes (first-time) | One-time signup gate MPIN |
| `AUTH_SMTP_HOST` | `smtp.example.com` | No | OTP email via SMTP |
| `AUTH_SMTP_PORT` | `587` | No | SMTP port |
| `AUTH_SMTP_SECURE` | `false` | No | SMTP TLS |
| `AUTH_SMTP_USER` | `owner@example.com` | No | SMTP username |
| `AUTH_SMTP_PASS` | `<secret>` | No | SMTP password — **secret**, set in Vercel only |
| `AUTH_EMAIL_FROM` | `"KAUSTUBH <owner@example.com>"` | No | OTP email from address |
| `AUTH_EMAIL_TO` | `owner@example.com` | No | OTP email to address |
| `AUTH_OTP_DEV_FALLBACK` | `false` | Yes (production) | Disable console OTP fallback in production |
| `AUTH_RP_ID` | `kds.example.com` | No | WebAuthn relying party ID (requires domain) |
| `AUTH_ORIGIN` | `https://kds.example.com` | No | WebAuthn origin (requires HTTPS domain) |
| `AUTH_RP_NAME` | `KAUSTUBH Trading Platform` | No | WebAuthn display name |

### Do NOT set these (server-only / backend-only)

| Variable | Why not |
|----------|---------|
| `APP_USERNAME`, `APP_PASSWORD`, `JWT_SECRET` | Backend auth secrets — belong in `/etc/kds/backend.env` on VM1 only |
| `MONGODB_URI` | Backend database secret — belongs on VM1 only |
| `VM_AGENT_TOKEN_VM1`, `VM_AGENT_TOKEN_VM2` | Agent tokens — belong in backend env + `/etc/kds/agent-token` on each VM |
| Kotak/Shoonya credentials | Broker secrets — backend only |
| Anything in `NEXT_PUBLIC_*` that reveals backend/DB config | Browser-visible — security risk |

### Vercel-specific notes

- **No `NEXT_PUBLIC_*` variables are required** for the frontend to function — `API_BASE` resolves to empty string in the browser (same-origin).
- The frontend proxy (`next.config.js` rewrites) forwards `/api/*` to `BACKEND_URL`. The backend must be reachable over HTTPS from Vercel.
- VM1's port 8000 is on the **private network only** (`10.1.1.133`). Vercel cannot reach it directly. You need either:
  1. A public HTTPS reverse proxy in front of VM1's backend (e.g., OCI Load Balancer, Cloudflare Tunnel, or an Nginx/Traefik ingress with TLS), or
  2. Deploy the backend itself to a publicly accessible HTTPS endpoint.
- **Do not assume the VM public IP (130.210.55.165) is HTTPS-ready.** TLS termination and a domain are required before Vercel can call the backend securely.

---

## 2. CORS Configuration (Backend)

The backend CORS allowlist (`CORS_ORIGINS` in `/etc/kds/backend.env` on VM1) must include the Vercel production origin:

```
CORS_ORIGINS=https://kds.vercel.app,https://kds-example.vercel.app
```

**Never use `*` with `allow_credentials=True`** — FastAPI will refuse to start with that combination. Set specific origins only.

---

## 3. Pre-Deployment Checks (Local)

```bash
# 1. Verify dependencies installed
npm ci

# 2. Run tests (should pass: 475 tests, 0 failures)
npm test

# 3. Run lint (should have 0 errors; warnings are acceptable)
npm run lint

# 4. Production build
npm run build

# 5. Verify the build output exists
ls -la .next/
```

**Build result:** Must complete without errors. If the build fails, fix before deploying.

---

## 4. Vercel Deployment Commands

### Option A: Vercel CLI (if installed and authenticated)

```bash
# Login (interactive, token not stored in chat)
vercel login

# Link project (first time only)
vercel link

# Deploy to preview
vercel

# Deploy to production
vercel --prod
```

### Option B: Vercel Git integration

1. Push code to the connected Git repository (GitHub/GitLab/Bitbucket).
2. Vercel auto-detects Next.js and deploys on push to the production branch.
3. Configure environment variables in the Vercel dashboard before the first production deploy.

**Important:** Do not run `vercel` commands that print tokens or secrets to terminal output. Use the Vercel dashboard for secret variables.

---

## 5. Post-Deployment Verification

After deployment, verify:

| Check | Command / URL | Expected |
|-------|--------------|----------|
| Frontend loads | `https://<vercel-url>` | Page renders, redirects to `/login` |
| Login gate | `https://<vercel-url>/login` | Login form displays |
| API proxy | `https://<vercel-url>/api/system/health` | Returns JSON (200 or 503 if MongoDB down) |
| CORS | Browser dev tools → Network | No CORS errors on `/api/*` calls |
| Environment vars | Vercel dashboard → Settings → Environment Variables | All required vars set for Production |
| Build logs | Vercel dashboard → Deployments | Build succeeded, no errors |

### What to expect on Vercel

- **WebSocket:** Not available (serverless). UI degrades to REST polling — this is by design (see `server.mjs` comments).
- **Realtime data:** Falls back to interval fetches — same behavior as before the custom server was added.
- **API calls:** All go through Vercel edge → backend HTTPS URL. Same-origin from the browser's perspective.

---

## 6. Rollback

```bash
# Vercel CLI rollback to previous deployment
vercel rollback

# Or use the Vercel dashboard: Deployments → select previous → Promote to Production
```

Database changes: none required for frontend rollback (no schema migrations).

---

## 7. Remaining Work (Not in Scope for This Phase)

- [ ] Public HTTPS endpoint for VM1 backend (reverse proxy + TLS)
- [ ] OCI security list / firewall rules for HTTPS (443) inbound to VM1
- [ ] Domain name and DNS for the backend API
- [ ] Live broker mode configuration (Kotak/Shoonya) — requires explicit operator approval
- [ ] MongoDB monitor user on VM2 (for authenticated ping from VM2 agent)
