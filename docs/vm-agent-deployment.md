# KDS VM Agent Deployment & Troubleshooting

**VMs:** VM1 (10.1.1.133, backend host), VM2 (10.1.2.178, MongoDB host)  
**Agent script:** `agents/kds_vm_agent.py` (stdlib-only Python)  
**Installer:** `agents/install-agent.sh` (run as root on the target VM)  
**Heartbeat interval:** every 60 s via `kds-agent.timer`  
**Token file:** `/etc/kds/agent-token` (0640 root:kds-agent)  
**Config file:** `/etc/kds/kds-agent.json` (0640 root:kds-agent)

---

## 1. Agent Login / Startup Flow

### VM1 (backend host)

```
SSH: ssh -i ~/.ssh/kds-backend.key ubuntu@130.210.55.165 (from WSL)
     sudo -i
```

1. **Backend must be running first** (`kds-backend` systemd unit on port 8000 at 10.1.1.133).
2. Copy agent files to VM1: `install-agent.sh`, `kds_vm_agent.py`, `kds-agent.service`, `kds-agent.timer`.
3. Generate VM1 token (once, on a trusted machine): `openssl rand -hex 32 > ~/vm1-agent-token`
4. Install as root on VM1:
   ```bash
   sudo bash /tmp/kds-agent/install-agent.sh \
     --vm-id vm1 \
     --api-url http://10.1.1.133:8000 \
     --token-file /root/vm1-agent-token
   ```
5. The installer:
   - Creates `kds-agent` system user
   - Installs agent binary to `/opt/kds-agent/kds_vm_agent.py`
   - Writes `/etc/kds/kds-agent.json` (config, no secrets)
   - Writes `/etc/kds/agent-token` (0640 root:kds-agent, value never printed)
   - Adds one sudoers rule: `kds-agent ALL=(root) NOPASSWD: /usr/bin/systemctl restart kds-backend`
   - Installs `kds-agent.service` + `kds-agent.timer`, enables timer
   - Runs local `--check` self-test before enabling (aborts if it fails)

### VM2 (MongoDB host)

1. SSH through VM1: `ssh -i /home/ubuntu/db-key ubuntu@10.1.2.178` (from VM1).
2. Copy the same four agent files from VM1 to VM2.
3. Generate VM2 token: `openssl rand -hex 32 > ~/vm2-agent-token`
4. Install as root on VM2:
   ```bash
   sudo bash /tmp/kds-agent/install-agent.sh \
     --vm-id vm2 \
     --api-url http://10.1.1.133:8000 \
     --token-file /root/vm2-agent-token
   ```
   - VM2 agent allowlists only `mongod` restarts (not `kds-backend`).
   - MongoDB authenticated ping is `NOT_CONFIGURED` unless a read-only monitor user exists and `--mongo-uri-file` is provided.
   - TCP reachability check to `10.1.2.178:27017` runs from VM1 agent (configured in `mongo_tcp_target`).

---

## 2. Token Requirements

The backend must have matching values for both VMs in `/etc/kds/backend.env`:

| Variable | Matches | File on VM |
|----------|---------|------------|
| `VM_AGENT_TOKEN_VM1` | `/etc/kds/agent-token` on VM1 | VM1 only |
| `VM_AGENT_TOKEN_VM2` | `/etc/kds/agent-token` on VM2 | VM2 only |

The agent reads its token from:
1. `KDS_AGENT_TOKEN` environment variable (if set), or
2. `token_file` from `/etc/kds/kds-agent.json` (default `/etc/kds/agent-token`)

Token must be 32+ chars of `[A-Za-z0-9._~+/=-]`. Backend compares SHA-256 digests in constant time. A VM1 token cannot submit as VM2.

**Never display token values.** Never commit them. Never paste into chat.

---

## 3. Backend Configuration for Agents

In `/etc/kds/backend.env` on VM1:

```ini
VM_AGENT_TOKEN_VM1=<32+ hex chars — matches /etc/kds/agent-token on VM1>
VM_AGENT_TOKEN_VM2=<32+ hex chars — matches /etc/kds/agent-token on VM2>

VM_STALE_SECONDS=180
VM_DISCONNECTED_SECONDS=600
VM_AUTO_RECOVERY_ENABLED=true
VM_RECOVERY_ALLOWLIST=kds-backend,mongod
VM_RECOVERY_COOLDOWN_SECONDS=600
VM_RECOVERY_MAX_PER_INCIDENT=2
VM_RECOVERY_MAX_PER_HOUR=2
```

If a token is not configured, the backend heartbeat endpoint returns `503 AGENT_TOKEN_NOT_CONFIGURED` for that VM.

---

## 4. Useful Commands

### On VM1

```bash
# Service status
systemctl status kds-backend
systemctl is-active kds-backend
systemctl is-enabled kds-backend

# Logs (redacted — no secrets printed)
journalctl -u kds-backend -n 50 --no-pager
journalctl -u kds-backend --since "1 hour ago" --no-pager

# Health endpoint (from VM1 or VM2 via private IP)
curl -fsS http://10.1.1.133:8000/api/system/health
curl -fsS http://10.1.1.133:8000/health

# Port binding (must be 10.1.1.133:8000, not 0.0.0.0:8000)
ss -ltnp | grep ':8000'

# Agent timer
systemctl list-timers kds-agent.timer --no-pager
systemctl status kds-agent.timer

# Agent service logs
journalctl -u kds-agent.service -n 50 --no-pager

# Agent self-test (no network, redacted output)
sudo -u kds-agent python3 /opt/kds-agent/kds_vm_agent.py --check

# Manual agent run (one heartbeat)
sudo -u kds-agent python3 /opt/kds-agent/kds_vm_agent.py --once

# Restart backend (only if verified as kds-backend)
systemctl restart kds-backend
```

### On VM2

```bash
# MongoDB status
systemctl status mongod
systemctl is-active mongod

# MongoDB port (must be bound to 127.0.0.1 + 10.1.2.178, not public)
ss -ltnp | grep ':27017'

# Agent timer
systemctl list-timers kds-agent.timer --no-pager
journalctl -u kds-agent.service -n 50 --no-pager

# Agent self-test
sudo -u kds-agent python3 /opt/kds-agent/kds_vm_agent.py --check
```

### From an authenticated browser session (VM pages)

```
GET /api/vm/overview        # both hosts, overall status, open incidents
GET /api/vm/agents          # per-host agent freshness + token configured (booleans only)
GET /api/vm/vm1             # VM1 detail: snapshot, history, incidents, actions
GET /api/vm/vm2             # VM2 detail: plus MongoDB ping and backup status
```

All VM read routes require a valid operator JWT (`Authorization: Bearer <token>`).

---

## 5. Troubleshooting

| Symptom | Likely cause | Check / fix |
|---------|-------------|-------------|
| Page shows `DISCONNECTED` | Timer not running, or token mismatch | `systemctl list-timers kds-agent.timer`; `journalctl -u kds-agent.service`; verify `VM_AGENT_TOKEN_VMx` in backend env matches `/etc/kds/agent-token` |
| `503 AGENT_TOKEN_NOT_CONFIGURED` in agent log | Backend env missing the token for that VM | Add `VM_AGENT_TOKEN_VM1`/`VM_AGENT_TOKEN_VM2` to `/etc/kds/backend.env`, restart `kds-backend` |
| `401 INVALID_AGENT_TOKEN` | Token file and backend env differ | Rewrite `/etc/kds/agent-token` to match backend env; no agent restart needed |
| API returns `503 VM_TELEMETRY_UNAVAILABLE` | Backend cannot read MongoDB | Check backend MongoDB connection and logs |
| Restart queued but nothing happens | Action delivered on next heartbeat (≤ 60 s) | Check `journalctl -u kds-agent.service`; verify local allowlist/caps |
| Restart refused "already active" | Working as intended — agent won't restart a healthy service | No action needed |
| `STALE` but agent logs look fine | Clock skew or backend time ahead | Compare `collected_at` in journal with API `generated_at` |
| VM2 backup `NOT_CONFIGURED` | Expected until a real backup job writes a file | Not an error; configure backups separately |
| Agent cannot reach backend (VM2) | Network/routing between VMs | Verify VM2 can reach `10.1.1.133:8000` (private subnet) |
| MongoDB port 27017 not on private IP | `mongod.conf` bind address | Check `/etc/mongod.conf` — must include `10.1.2.178` in `bindIp` |
| Backend won't start | Missing `MONGODB_URI` or MongoDB unreachable | Check `/etc/kds/backend.env`; verify VM1 can reach `10.1.2.178:27017` |

### Recovery from agent install failure

```bash
# Uninstall (keeps config/token/state)
sudo bash /tmp/kds-agent/install-agent.sh --uninstall

# Full purge (removes config, token, state, agent code, user)
sudo bash /tmp/kds-agent/install-agent.sh --uninstall --purge
```

### Backend rollback

```bash
# Restore previous env + service file from backup, then:
systemctl daemon-reload
systemctl restart kds-backend
```

---

## 6. What the Agent Never Does (Scope Limits)

- Never reboots a VM
- Never edits firewall rules, MongoDB users/database config, or OCI security lists
- Never restarts a service that is already active/healthy
- Never logs or transmits the agent token, MongoDB URI, or SSH material
- Never performs auto-failover, database repair, or SSH-key/credential actions
- Automatic recovery is limited to `systemctl restart <allowlisted-unit>` only
