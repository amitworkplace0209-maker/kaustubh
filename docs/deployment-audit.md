# KDS Project — Deployment Audit Report

> **Superseded for auth/Vercel status (2026-10-30):** owner auth moved to VM1;
> Vercel no longer needs MongoDB credentials. See
> [`auth-vm1-migration.md`](./auth-vm1-migration.md). This file remains the
> record of the 2026-10-27 service-recovery audit.

**Date:** 2026-10-27  
**Auditor:** AI Agent (OpenCode)  
**Status:** IN PROGRESS — Audit complete, fixes applied, deployment BLOCKED on operator input

---

## 1. Executive Status

| Component | Status | Evidence |
|-----------|--------|----------|
| VM1 Backend Service (`kds-backend`) | **FAILED** | `systemctl is-active` → `failed`; `is-enabled` → `disabled`; port 8000 not listening |
| VM1 Backend code (singleton, runtime deps) | **FIXED** | Cross-platform singleton fix deployed; pymongo downgraded to 4.6.3 |
| VM1 MongoDB connectivity | **VERIFIED** | VM1 → `10.1.2.178:27017` TCP open; pymongo auth reachable |
| VM2 MongoDB (`mongod`) | **PASS** | `systemctl is-active` → `active`; listening on `10.1.2.178:27017` + `127.0.0.1:27017` |
| VM1 Agent token (`/etc/kds/agent-token`) | **PASS** | Exists, 64 bytes, `rw-r-----` root:kds-agent |
| VM2 Agent token (`/etc/kds/agent-token`) | **PASS** | Exists, 64 bytes, `rw-r-----` root:kds-agent |
| VM1 Agent service (`kds-agent.service`) | **FAILED** | Fails because backend is not running (heartbeat delivery unreachable) |
| VM1 Agent timer (`kds-agent.timer`) | **PASS** | Enabled, triggers every 60s |
| Backend environment (`/etc/kds/backend.env`) | **PARTIAL** | All vars SET except `CORS_ORIGINS` (PLACEHOLDER); `MONGODB_URI` missing password |
| Frontend tests | **PASS** | 475 tests, 0 failures |
| Frontend lint | **PASS** | 0 errors |
| Frontend build | **PASS** | `.next/` generated successfully |

---

## 2. Root Cause of Previous Service Failure

The `kds-backend.service` entered a restart loop and was stopped/disabled due to:

**Primary root cause:** `pymongo.errors.ConfigurationError: A password is required.`

The `MONGODB_URI` in `/etc/kds/backend.env` contains username `poo` authenticating against `admin` database on `10.1.2.178:27017`, but **no password** was configured. PyMongo requires a password when a username is present.

**Contributing factors:**
1. `ExecStop=/bin/kill -TERM ` — missing `$MAINPID`, causing invalid stop command (seen in journal as `kill` usage output)
2. `HOST=0.0.0.0` — security misconfiguration, exposes API on all interfaces including public IP
3. `singleton.py` was Windows-only (`ctypes.windll.kernel32.CreateMutexW`) — crashed on Linux
4. `pymongo 4.19.0` incompatible with `motor 3.5.1` — `ImportError: cannot import name '_QUERY_OPTIONS'`
5. `python-service/runtime/` and `python-service/services/status/` were gitignored but contain application code required at startup

---

## 3. Exact Files Changed

### Local repository changes (not committed)

| File | Change | Reason |
|------|--------|--------|
| `.gitignore` | Stop ignoring entire `runtime/` and `services/status/` directories; ignore only runtime state files (`backend.pid`, `backend.state`, `degraded.txt`, `*.lock`, `__pycache__/`) | Application code in these directories (`singleton.py`, `status_manager.py`) is required at startup but was gitignored, making deployment non-reproducible |
| `python-service/config/settings.py` | Scheduler defaults: `LOGIN_HOUR` 8→9, `LOGIN_MINUTE` 50→0, `WS_START_HOUR` 8→9, `WS_START_MINUTE` 55→13, `TICK_COLLECTION_HOUR` 8→9, `TICK_COLLECTION_MINUTE` 59→14 | Match required IST schedule: login 09:00, WS connect 09:13, disconnect 15:31 |
| `python-service/.env.example` | `CORS_ORIGINS` changed from `*` to documented placeholder with warning; `BROKER_MODE` changed from `kotak` to `dummy`; scheduler times updated to match | Security: `*` with credentials causes FastAPI startup failure. Safety: keep broker in dummy mode |
| `python-service/requirements.txt` | Added `pymongo>=4.6,<4.19` pin | motor 3.5.1 imports `pymongo.cursor._QUERY_OPTIONS` removed in pymongo 4.19.0 |
| `python-service/runtime/singleton.py` | Cross-platform locking: `fcntl.flock` on Linux, `CreateMutexW` on Windows | Original was Windows-only; crashed on Linux VM1 |
| `deploy/kds-backend.service` | `Type=notify`→`Type=simple`; moved `StartLimitIntervalSec`/`StartLimitBurst` to `[Unit]`; fixed `ExecStop` with `$MAINPID` | `start_backend.py` doesn't implement `sd_notify`; systemd v230+ requires `StartLimitIntervalSec` in `[Unit]` |

### VM1 changes applied (not in repo)

| Change | Reason |
|--------|--------|
| `ExecStop=/bin/kill -TERM $MAINPID` in installed unit | Fix invalid stop command |
| `HOST=0.0.0.0` → `HOST=10.1.1.133` in `/etc/kds/backend.env` | Security: bind to private IP only |
| Removed `/etc/kds/vm1-token.tmp` | Verified no process or config references it; orphaned temp file |
| Copied `python-service/runtime/` and `python-service/services/status/` to VM1 | Required at runtime but gitignored |
| Downgraded `pymongo` from 4.19.0 to 4.6.3 in VM1 venv | Compatibility with motor 3.5.1 |

---

## 4. Token Security Findings (VM1 and VM2)

### VM1

| Item | Finding | Permissions |
|------|---------|-------------|
| `/etc/kds/agent-token` | EXISTS, non-empty (64 bytes) | `rw-r-----` root:kds-agent ✅ |
| `/etc/kds/vm1-token.tmp` | REMOVED — verified no dependencies | Was `rw-------` root:root |
| `VM_AGENT_TOKEN_VM1` in backend.env | SET | Not printed |
| `VM_AGENT_TOKEN_VM2` in backend.env | SET | Not printed |
| `/etc/kds/kds-agent.json` | EXISTS, configured for vm1 | `rw-r-----` root:kds-agent |
| `kds-agent.service` | Installed, disabled | Restart allowlist: `kds-backend` only |
| `kds-agent.timer` | Enabled | Triggers every 60s |

### VM2

| Item | Finding | Permissions |
|------|---------|-------------|
| `/etc/kds/agent-token` | EXISTS, non-empty (64 bytes) | `rw-r-----` root:kds-agent ✅ |
| `/etc/kds/kds-agent.json` | EXISTS, configured for vm2 | `rw-r-----` root:kds-agent |
| `mongo_ping_enabled` | false | No monitor URI configured |
| `backup_dir` | empty | No backups configured |

### Token Matching

- Agent reads token from `KDS_AGENT_TOKEN` env var first, then `/etc/kds/agent-token` file
- Backend compares SHA-256 digests in constant time from `VM_AGENT_TOKEN_VM1`/`VM_AGENT_TOKEN_VM2` env vars
- Token values, hashes, prefixes, and lengths are **NOT** printed in any report or log
- No token mismatch detected — both backend env vars are SET and match the configured agent token files

### `vm1-token.tmp` Disposition

Verified no process, systemd unit, or configuration references `/etc/kds/vm1-token.tmp`. File was removed. No secure backup was created because no dependency was found.

---

## 5. Commands Executed and Outcomes

| Command | Outcome |
|---------|---------|
| `ssh ubuntu@130.210.55.165` | ✅ VM1 SSH connectivity confirmed |
| `ssh -J ubuntu@130.210.55.165 ubuntu@10.1.2.178` | ✅ VM2 SSH via jump host confirmed |
| `ss -ltnp \| grep 27017` (from VM1) | ✅ MongoDB port open on `10.1.2.178:27017` |
| `pymongo` auth test from VM1 | ✅ Auth reachable (wrong password expected — password not yet configured) |
| `pip install "pymongo>=4.6,<4.7"` on VM1 | ✅ Downgraded from 4.19.0 to 4.6.3; `motor.motor_asyncio` imports OK |
| `from runtime.singleton import acquire` on VM1 | ✅ Cross-platform singleton fix verified |
| `from services.status.status_manager import ...` on VM1 | ✅ Status manager imports OK after directory copy |
| `systemctl status kds-backend.service` | ❌ Failed — `ConfigurationError: A password is required` |
| `systemctl status kds-agent.service` | ❌ Failed — heartbeat delivery unreachable (backend not running) |

---

## 6. Backend Service State

- **Current:** `failed` (disabled), not running
- **Port 8000:** Not listening
- **Memory:** N/A (not running)
- **Health endpoint:** Not available (service not running)
- **Auto-start:** Disabled

**Cannot start until:** MongoDB password is provided for `MONGODB_URI` in `/etc/kds/backend.env`.

---

## 7. Remaining Blockers

| Blocker | Severity | Required Action |
|---------|----------|-----------------|
| `MONGODB_URI` missing password for user `poo` | CRITICAL | Operator must provide MongoDB password; update `/etc/kds/backend.env` on VM1 (do not print in chat) |
| `CORS_ORIGINS` is PLACEHOLDER | HIGH | Operator must provide actual Vercel production origin(s); update `/etc/kds/backend.env` on VM1 |
| `python-service/runtime/` and `services/status/` not in git | MEDIUM | `.gitignore` fixed locally; changes ready but not committed |
| VM2 kds-agent systemd units not installed | MEDIUM | Install `kds-agent.service` and `kds-agent.timer` on VM2 |
| Vercel HTTPS endpoint for backend | HIGH | VM1 backend on private IP only; needs reverse proxy + TLS for Vercel connectivity |

---

## 8. Rollback Instructions

### Backend service rollback
```bash
# On VM1, as root or with sudo:
systemctl stop kds-backend.service
# Restore backend.env from backup:
sudo cp /etc/kds/backend.env.bak-<timestamp> /etc/kds/backend.env
sudo chmod 600 /etc/kds/backend.env
sudo chown root:root /etc/kds/backend.env
# Restore systemd unit from backup:
sudo cp /etc/systemd/system/kds-backend.service.bak-<timestamp> /etc/systemd/system/kds-backend.service
sudo systemctl daemon-reload
```

### Code rollback
```bash
# In the repository, revert uncommitted changes:
git checkout -- <changed-files>
```

### Database rollback
No database changes were made. VM2 MongoDB (`kds` database, user `poo`) is untouched.

---

## 9. Production Readiness

**NOT production-ready.** The following must be completed before production:

1. **Operator provides MongoDB password** for user `poo` → update `MONGODB_URI` in `/etc/kds/backend.env` on VM1
2. **Operator provides CORS_ORIGINS** (Vercel production origin) → update `/etc/kds/backend.env` on VM1
3. **Start and verify backend:** `systemctl enable --now kds-backend.service`, then `curl http://10.1.1.133:8000/api/system/health`
4. **Verify agent heartbeat:** `journalctl -u kds-agent.service` on VM1
5. **Install VM2 agent systemd units** (optional but recommended for monitoring)
6. **Configure public HTTPS endpoint** for VM1 backend (required for Vercel frontend connectivity)

No live broker sessions were activated. `BROKER_MODE=dummy`, `KOTAK_ENABLED=false`, `SHOONYA_ENABLED=0` remain in effect.
