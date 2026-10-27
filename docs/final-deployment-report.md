# KDS Project — Final Deployment Report

**Date:** 2026-10-27  
**Repository:** `C:\project`  
**Branch:** main, commit `29f94f0`  
**Status:** Phase 1-3 complete. Deployment to VMs pending operator approval.

---

## 1. Test & Build Results (executed, not claimed)

| Check | Command | Result | Details |
|-------|---------|--------|---------|
| Frontend unit tests | `npm test` | **PASS** | 475 tests, 0 failures, 0 skipped |
| Frontend lint | `npm run lint` | **PASS** | 0 errors, 259 warnings (all warnings, no errors) |
| Frontend production build | `npm run build` | **PASS** | `.next/` directory generated, exit code 0 |
| Frontend typecheck | `npx tsc --noEmit` | **TIMEOUT** | Did not complete within 120s |
| Backend unit tests | `python -m pytest` | **NOT RUN** | pip install of dependencies timed out in this environment; backend test suite exists under `python-service/tests/` (~70 test files) |

> No test result is claimed unless it was actually executed above.

---

## 2. Audit Findings Summary

### Confirmed defects (configuration-level, no code changes needed)

| ID | Issue | Severity | Fix |
|----|-------|----------|-----|
| F-01 | Nothing deployed on VM1/VM2 | HIGH | Deploy backend via systemd; install agents |
| F-02 | Scheduler times: 08:50/08:55 vs required 09:00/09:13 | MEDIUM | `.env.example` updated with correct times as comments; production VM env sets LOGIN_HOUR=9, WS_START_HOUR=9, WS_START_MINUTE=13 |
| F-03 | Backend binds to 0.0.0.0 by default | HIGH | VM1 env template sets `HOST=10.1.1.133` (private IP only) |
| F-04 | CORS_ORIGINS=* with credentials (FastAPI startup error) | HIGH | VM1 env template requires specific Vercel origin(s); `.env.example` documents the constraint |
| F-05 | BROKER_MODE default inconsistency (.env.example=kotak, code=dummy) | MEDIUM | `.env.example` and VM env template set `BROKER_MODE=dummy` |
| F-06 | KOTAK_ENABLED defaults to true | MEDIUM | VM1 env template sets `KOTAK_ENABLED=false` |

### Verified strengths
- `.gitignore` correctly excludes all `.env*` files (except `.env.example` templates), keys, tokens, logs
- No secrets committed to Git
- Frontend test suite: 475 pass, 0 fail
- Custom server (`server.mjs`) correctly proxies WebSocket to backend with session-gated HMAC auth
- Backend health endpoint: `GET /api/system/health` returns 503 when MongoDB is down (never false 200)
- Agent system: stdlib-only, bounded heartbeats, allowlisted restarts, no secrets in logs
- MongoDB URI validation: fails fast with redacted error messages (never prints URI)

---

## 3. Deliverables Created

| # | Deliverable | Path |
|---|-------------|------|
| 1 | Deployment audit report | `docs/deployment-audit.md` |
| 2 | Updated `.env.example` (frontend) | `C:\project\.env.example` |
| 3 | VM1 production env template | `deploy/vm1-backend.env.template` |
| 4 | VM1 systemd service file | `deploy/kds-backend.service` |
| 5 | VM1 deployment/verification script | `deploy/deploy-vm1-backend.sh` |
| 6 | VM agent deployment & troubleshooting | `docs/vm-agent-deployment.md` |
| 7 | Vercel deployment checklist | `docs/vercel-deployment.md` |
| 8 | Final deployment report | `docs/final-deployment-report.md` |

---

## 4. VM1 Deployment Readiness

### What must happen on VM1 (requires operator approval & SSH access)

1. **Clone the repo** to `/opt/kds/repo` (branch `main`, commit `29f94f0`)
2. **Create Python venv** at `/opt/kds/venv` and install `python-service/requirements.txt`
3. **Create `/etc/kds/backend.env`** from `deploy/vm1-backend.env.template`:
   - Owner: root, mode `600`
   - Fill all `<REPLACE_*>` placeholders (MONGODB_URI with VM2 IP `10.1.2.178`, user `poo`, authSource `admin`, db `kds`; JWT_SECRET; CORS_ORIGINS with Vercel origin; etc.)
   - `HOST=10.1.1.133`, `PORT=8000`
   - `BROKER_MODE=dummy`, `KOTAK_ENABLED=false`, `SHOONYA_ENABLED=0`
   - Scheduler: `LOGIN_HOUR=9`, `LOGIN_MINUTE=0`, `WS_START_HOUR=9`, `WS_START_MINUTE=13`, `WS_STOP_HOUR=15`, `WS_STOP_MINUTE=31`
4. **Install systemd service** from `deploy/kds-backend.service` to `/etc/systemd/system/kds-backend.service`
5. **Run deployment script** `deploy/deploy-vm1-backend.sh` (verifies git state, venv, env, starts service, checks health)
6. **Verify:** `curl -fsS http://10.1.1.133:8000/api/system/health` responds 200 or 503

### What must happen on VM2 (requires operator approval)

1. **Verify MongoDB 8.0** is running, bound to `10.1.2.178:27017` + `127.0.0.1:27017`, auth enabled
2. **Verify user `poo`** has `readWrite` on `kds`, authenticates against `admin`
3. **Verify VM1 can reach** `10.1.2.178:27017` and authenticate as `poo`
4. **Install VM2 agent** via `agents/install-agent.sh --vm-id vm2 --api-url http://10.1.1.133:8000`

### Agent installation (both VMs)

- VM1 agent: `--vm-id vm1 --api-url http://10.1.1.133:8000 --token-file <vm1-token-file>`
- VM2 agent: `--vm-id vm2 --api-url http://10.1.1.133:8000 --token-file <vm2-token-file>`
- Tokens: `openssl rand -hex 32` per VM, written to `/etc/kds/agent-token` (0640 root:kds-agent)
- Backend env must contain matching `VM_AGENT_TOKEN_VM1` / `VM_AGENT_TOKEN_VM2`

---

## 5. Vercel Frontend Deployment Readiness

### Pre-deployment (local, already verified)
- `npm test` → 475 pass, 0 fail
- `npm run lint` → 0 errors
- `npm run build` → completed successfully (`.next/` generated)

### Vercel environment variables (set in Vercel dashboard, not committed)

**Required for production:** `BACKEND_URL`, `WS_BACKEND_URL`, `AUTH_SESSION_SECRET`, `AUTH_MONGODB_URI`, `AUTH_MONGODB_DB`, `AUTH_SIGNUP_EMAIL`, `AUTH_SIGNUP_MPIN`, `AUTH_OTP_DEV_FALLBACK=false`

**Do NOT set (backend-only secrets):** `APP_USERNAME`, `APP_PASSWORD`, `JWT_SECRET`, `MONGODB_URI`, VM agent tokens, broker credentials

### Critical blocker for Vercel → VM1 connectivity

VM1's backend listens on `10.1.1.133:8000` (private IP only). Vercel cannot reach a private IP. Before deploying to Vercel, you need:
- A public HTTPS endpoint for the backend (reverse proxy + TLS on VM1, or OCI Load Balancer)
- OR deploy the backend to a publicly accessible HTTPS host
- CORS on backend must include the Vercel production origin

**Do not assume 130.210.55.165 (VM1 public IP) is HTTPS-ready.** TLS termination and a domain are required.

---

## 6. Trading Safety (enforced by configuration)

| Setting | Value | Source |
|---------|-------|--------|
| `BROKER_MODE` | `dummy` | VM1 env template |
| `KOTAK_ENABLED` | `false` | VM1 env template |
| `SHOONYA_ENABLED` | `0` | VM1 env template |
| Market schedule | Login 09:00, WS 09:13, Disconnect 15:31 IST | VM1 env template |

No live broker orders will be submitted. No real broker sessions will be activated. No secrets are printed, committed, or transmitted.

---

## 7. Remaining Blockers (require operator action)

| Blocker | Action needed |
|---------|---------------|
| SSH access to VM1 (130.210.55.165) and VM2 (10.1.2.178) | Operator provides keys/access |
| MongoDB credentials for user `poo` | Operator configures `MONGODB_URI` in `/etc/kds/backend.env` (never shared in chat) |
| JWT secret generation | Operator runs `openssl rand -hex 48` locally on VM1, sets in `/etc/kds/backend.env` |
| Vercel project setup | Operator creates Vercel project, sets environment variables, deploys |
| Public HTTPS endpoint for VM1 backend | Operator configures reverse proxy + TLS (OCI LB, Cloudflare Tunnel, or Nginx) |
| CORS origins for production | Operator sets `CORS_ORIGINS` to actual Vercel origin(s) |
| VM agent tokens | Operator generates `openssl rand -hex 32` per VM, places in backend env + `/etc/kds/agent-token` |

---

## 8. Verification Checklist (post-deployment)

```
VM1:
  [ ] systemctl is-active kds-backend → active
  [ ] curl http://10.1.1.133:8000/api/system/health → 200 or 503
  [ ] ss -ltnp | grep ':8000' → 10.1.1.133:8000 (not 0.0.0.0)
  [ ] journalctl -u kds-backend -n 20 → no startup errors
  [ ] MongoDB: database.connected=true in health response

VM2:
  [ ] systemctl is-active mongod → active
  [ ] ss -ltnp | grep ':27017' → 10.1.2.178:27017 + 127.0.0.1:27017
  [ ] VM1 can reach 10.1.2.178:27017 and authenticate as poo

Agents:
  [ ] systemctl list-timers kds-agent.timer → active on both VMs
  [ ] journalctl -u kds-agent.service → OK heartbeat messages
  [ ] GET /api/vm/agents → tokens_configured {vm1:true, vm2:true}
  [ ] GET /api/vm/overview → connected_agents = 2

Vercel:
  [ ] npm run build → success (verified locally)
  [ ] Vercel deployment → dashboard confirms production deploy
  [ ] https://<vercel-url>/api/system/health → JSON response
  [ ] No CORS errors in browser console

Trading safety:
  [ ] BROKER_MODE=dummy in /etc/kds/backend.env
  [ ] KOTAK_ENABLED=false in /etc/kds/backend.env
  [ ] SHOONYA_ENABLED=0 in /etc/kds/backend.env
```

---

## 9. Files Not Modified

- No source code files were changed (all fixes are configuration-level via `.env.example` and VM env templates)
- No `.env` files were committed (all gitignored)
- No secrets were printed, committed, or transmitted
- The uncommitted change `python-service/data/instrument_master.json` was preserved
