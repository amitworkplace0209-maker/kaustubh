# VM Management

Central health monitoring, incident tracking and **narrow, audited** automatic
recovery for the two KDS hosts. The browser gets a read-only view of real
telemetry; the only write actions are acknowledge, resolve, and an allowlisted
`systemctl restart`.

> **Current deployment state (2026-10-25): code and tests are complete locally.
> Nothing has been deployed to either VM, no agent is installed, and no service
> has been restarted.** VM1 does not run the KDS app or a `kds-backend` unit
> yet, so a deployed agent would correctly show the backend as missing and the
> API as unreachable until that deployment is approved.

---

## 1. Inventory

| | VM1 | VM2 |
|---|---|---|
| Role | Backend / app | MongoDB |
| Hostname | `kds-vcn` | `kds-vcn` |
| Private IP | `10.1.1.133` | `10.1.2.178` |
| Public IP | `130.210.55.165` | none |
| Subnet | public | private |
| OS | Ubuntu 24.04.5 | Ubuntu 24.04.5 |
| Shape | `VM.Standard.E2.1.Micro` (1 OCPU, ~954 MB) | same |
| Managed unit | `kds-backend` | `mongod` |
| Listens on | `8000` (after deployment) | `27017` on `127.0.0.1` + `10.1.2.178` |
| Access | `ssh -i ~/.ssh/kds-backend.key ubuntu@130.210.55.165` (from WSL) | `ssh -i /home/ubuntu/db-key ubuntu@10.1.2.178` (from VM1) |

Both hosts have `systemd-journal` (group 999) and `/usr/bin/python3` 3.12.3.
VM2 has `mongosh`. Verified read-only on 2026-10-25; neither host had a
`kds-agent` user, `/etc/kds`, `/opt/kds-agent`, or any `kds-*` unit before this
work.

---

## 2. Architecture

```
browser ── /services/vm[/vm1|/vm2] ── Next proxy (kaustubh_session gate)
   │                                        │
   │ same-origin /api/vm/* + Bearer JWT      │ /api/auth/trading-token mints it
   ▼                                        ▼  (session-gated, in-memory only)
Next rewrite /api/:path* ───────────────> Python API on VM1 (all reads need JWT)
                                            ▲        │
                    X-KDS-Agent-Token       │        │ Mongo (Atlas or VM2)
                    (per-VM, POST only)     │        ▼
                       VM1 agent ───────────┘   collections: vm_current,
                       VM2 agent ───────────┘                 vm_snapshots,
                                                               vm_incidents,
                                                               vm_events,
                                                               vm_remediations
```

* `agents/kds_vm_agent.py` — one stdlib-only script, ~27 MB RSS, one heartbeat
  per minute via `kds-agent.timer`.
* `python-service/api/vm_management.py` — API mounted in the existing FastAPI
  app, no extra service or port.
* `python-service/services/vm_policy.py` — thresholds, findings, staleness,
  status summarisation, recovery policy (pure, unit-tested).
* `python-service/services/vm_store.py` — MongoDB documents, indexes, incident
  lifecycle, action claim/result.
* `lib/vm-management.ts` — browser-facing types and display rules (pure,
  node-tested); `lib/vm-management-client.ts` — same-origin fetch client;
  `hooks/use-vm-polling.ts` — 8 s polling while the tab is visible.

---

## 3. Data honesty rules

These are enforced in code, not just documented:

1. **No synthetic telemetry.** Every number comes from an agent heartbeat.
   Missing fields render as `UNKNOWN`, never as `0`.
2. **Freshness is explicit.** A sample older than `VM_STALE_SECONDS` (180 s) is
   `STALE`; an agent silent for `VM_DISCONNECTED_SECONDS` (600 s) is
   `DISCONNECTED`; a host that never reported is `NEVER_CONNECTED`.
3. **The last good sample is kept on screen** while a refresh fails, clearly
   marked STALE. The UI never replaces it with fabricated values.
4. **Backups are only "OK" when a real file exists.** No backup job is
   configured on VM2 today, so the UI shows `NOT_CONFIGURED`. Nothing is
   inferred from the absence of errors.
5. **The MongoDB authenticated ping is only "OK" when `mongosh` actually
   authenticated.** With no monitor credential the check is `NOT_CONFIGURED`,
   and the TCP reachability check is shown separately and labelled as such.
6. **Incidents come from findings**, deduplicated by a stable key. Acknowledging
   or resolving writes an audit event with the operator identity.
7. **Agent/API failures are visible.** `/api/vm/*` returns `503
   VM_TELEMETRY_UNAVAILABLE` when MongoDB cannot be read; the pages show the
   error and keep the last successful payload, rather than an empty "healthy"
   screen.
8. No endpoint returns tokens, connection strings, SSH material, env contents,
   or full log files. Journal lines are bounded and redacted.

---

## 4. Frontend routes

| Route | Purpose |
|---|---|
| `/services/vm` | Overview: both hosts, overall status, open incidents, pending actions |
| `/services/vm/vm1` | VM1 detail: live snapshot, 6 h history, incidents, events, remediation audit, restart dialog |
| `/services/vm/vm2` | VM2 detail: same, plus MongoDB ping and backup status |

Navigation: **Services → System → VM Management** (children: Overview, VM1,
VM2), defined in `components/layout/nav.ts`.

Polling is 8 s and pauses when the document is hidden; a failed request keeps
the previous payload and shows its age. Nothing polls in the background while
the page is not visible.

---

## 5. API

All routes are mounted under `/api/vm` in the existing FastAPI app
(`python-service/app.py`).

### Read (operator JWT required on every row)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/vm/overview` | Both hosts, overall status, counts, pending actions, thresholds |
| GET | `/api/vm/agents` | Per-host agent freshness + whether each token is configured (booleans only) |
| GET | `/api/vm/incidents` | Filters: `vm`, `severity`, `status`, `service`, `resource`, `start`, `end`, `limit`, `offset` |
| GET | `/api/vm/incidents/{id}` | One incident with its audit fields |
| GET | `/api/vm/events` | Filters: `vm`, `severity`, `limit`, `before` |
| GET | `/api/vm/remediations` | Filters: `vm`, `limit` |
| GET | `/api/vm/{vm_id}` | `vm1`/`vm2`: snapshot, agent state, 6 h history, incidents, events, actions, thresholds, recovery policy |
| GET | `/api/vm/{vm_id}/history` | `hours` 0–168 (default 6), `limit` 1–1000 |

All eight read routes reject a request with `401 OPERATOR_JWT_REQUIRED` when no
valid operator JWT is present, `401 INVALID_OPERATOR_JWT` for a bad signature or
expired token, and `403 FORBIDDEN` for a correctly signed token that is not the
owner/admin. Agent headers do not satisfy any read route.

### Operator mutations

| Method | Path | Body | Auth |
|---|---|---|---|
| POST | `/api/vm/incidents/{id}/acknowledge` | `{"reason": "..."}` | session + operator JWT |
| POST | `/api/vm/incidents/{id}/resolve` | `{"reason": "..."}` | session + operator JWT |
| POST | `/api/vm/remediations` | `{"vm_id","service","confirm":true,"reason":""}` | session + operator JWT |

`confirm: true` is mandatory. The service must be in
`VM_RECOVERY_ALLOWLIST`; the agent applies its own local allowlist and caps on
top.

### Agent-only

| Method | Path | Headers |
|---|---|---|
| POST | `/api/vm/heartbeat` | `X-KDS-Agent-VM: vm1|vm2`, `X-KDS-Agent-Token: <token>` |
| POST | `/api/vm/remediations/{action_id}/result` | same |

### Authentication model

Enforcement happens at the Python boundary. The Next session gate is defence in
depth, not the only control, so reaching the port directly confers nothing.

* **Browser reads and writes** first fetch a short-lived JWT from
  `/api/auth/trading-token`, which verifies the live `kaustubh_session` cookie
  and MongoDB session row (MPIN/biometric enrolment included). The client keeps
  the token in memory, refreshes it shortly before expiry, and retries once on
  a `401`. `proxy.ts` independently rejects any `/api/*` call without a
  session, so the browser needs both controls to reach the data.
* **Every Python VM route except the two agent endpoints** requires
  `Authorization: Bearer <operator JWT>` (or the `X-Operator-JWT` header) and
  the owner/admin identity. Reads are no longer anonymous: a direct
  `curl http://10.1.1.133:8000/api/vm/overview` returns `401`.
* **Agents** call the Python service directly on port 8000 and must present the
  per-VM token. Tokens are compared as SHA-256 digests in constant time; a VM1
  token cannot submit as VM2, an operator JWT cannot submit telemetry, and an
  agent token cannot read human endpoints. If a token is not configured the
  endpoint fails closed with `503 AGENT_TOKEN_NOT_CONFIGURED`.
* **Prerequisite**: the Next server needs `APP_USERNAME` / `APP_PASSWORD` (it
  already reads `python-service/.env.local`) to mint the operator JWT. If they
  are missing, `/api/auth/trading-token` returns `502 NO_OPERATOR_CREDENTIALS`
  and the VM pages show that error rather than data. Reads fail loudly; they
  never fall back to anonymous access.
* The Python port still stays bound to `10.1.1.133` (see §7). Authentication
  now makes a leak survivable, but network isolation remains the first layer.

Responses use `{"ok": true, "data": ...}` or
`{"detail": {"code", "message"}}`.

---

## 6. Thresholds and status

Defaults (all overridable in `python-service/.env`):

| Signal | Warning | Critical | Sustain |
|---|---|---|---|
| CPU busy | ≥ 85 % | ≥ 95 % | 300 s / 600 s |
| RAM available | ≤ 15 % | ≤ 8 % | 120 s |
| Disk used | ≥ 80 % | ≥ 90 % | immediate |
| Inodes used | ≥ 80 % | ≥ 90 % | immediate |
| Backup age | > 30 h | — | immediate |
| No heartbeat | > 180 s → STALE | > 600 s → DISCONNECTED | immediate |

CPU and RAM findings require sustained samples, so a single scrape or a brief
build spike does not open an incident. Disk/inode findings are immediate.

`summarize()` derives `HEALTHY` / `DEGRADED` / `CRITICAL` / `STALE` /
`DISCONNECTED` from real findings only.

---

## 7. Backend configuration (VM1)

Add to `python-service/.env` on VM1 (template updated in
`python-service/.env.example`; never commit real values):

```ini
# Bind only to the private VCN address. This keeps the API off the public
# interface without touching the OCI security list or the host firewall.
HOST=10.1.1.133
PORT=8000

VM_AGENT_TOKEN_VM1=<openssl rand -hex 32>
VM_AGENT_TOKEN_VM2=<different openssl rand -hex 32>

VM_STALE_SECONDS=180
VM_DISCONNECTED_SECONDS=600
VM_HISTORY_RETENTION_DAYS=14
VM_EVENT_RETENTION_DAYS=30

VM_AUTO_RECOVERY_ENABLED=true
VM_RECOVERY_ALLOWLIST=kds-backend,mongod
VM_RECOVERY_COOLDOWN_SECONDS=600
VM_RECOVERY_MAX_PER_INCIDENT=2
VM_RECOVERY_MAX_PER_HOUR=2
```

Then the Next app on VM1 uses the same private origin:

```ini
BACKEND_URL=http://10.1.1.133:8000
WS_BACKEND_URL=http://10.1.1.133:8000
```

Why not `0.0.0.0`? Because the Python read endpoints rely on the Next proxy for
session gating (§5). Binding to the private IP means only hosts in the VCN
(VM1 itself, VM2) can reach port 8000; the public interface cannot. Do **not**
open 8000 in the OCI security list.

`MONGODB_URI` should point at the same database the app already uses. Creating
the VM indexes needs normal collection/index permissions on that database.

---

## 8. Agent install

The installer is in the repo, not on the VM. Copy only the agent files you need
(`agents/install-agent.sh`, `kds_vm_agent.py`, `kds-agent.service`,
`kds-agent.timer`) with `scp`, then run it with `bash` as root **on the VM**
(the file does not need the executable bit).

From WSL, on the machine that holds the SSH key:

```bash
cd /mnt/c/project
scp -i ~/.ssh/kds-backend.key \
  agents/install-agent.sh agents/kds_vm_agent.py \
  agents/kds-agent.service agents/kds-agent.timer \
  ubuntu@130.210.55.165:/tmp/kds-agent/
```

Generate one token per VM on a trusted machine (or on the VM) and keep it in a
mode-0600 file; paste the same value into the backend env for the matching VM:

```bash
openssl rand -hex 32 > ~/vm1-agent-token   # VM1
openssl rand -hex 32 > ~/vm2-agent-token   # VM2
chmod 600 ~/vm*-agent-token
```

Install on VM1:

```bash
ssh -i ~/.ssh/kds-backend.key ubuntu@130.210.55.165
sudo bash /tmp/kds-agent/install-agent.sh \
  --vm-id vm1 \
  --api-url http://10.1.1.133:8000 \
  --token-file /home/ubuntu/vm1-agent-token
```

Install on VM2 (private path through VM1; omit `--mongo-uri-file` until a
read-only monitor credential exists). Copy the four files from VM1 to VM2:

```bash
# from VM1
scp -i /home/ubuntu/db-key /tmp/kds-agent/* ubuntu@10.1.2.178:/tmp/kds-agent/
ssh -i /home/ubuntu/db-key ubuntu@10.1.2.178
sudo bash /tmp/kds-agent/install-agent.sh \
  --vm-id vm2 \
  --api-url http://10.1.1.133:8000 \
  --token-file /home/ubuntu/vm2-agent-token
```

If a MongoDB monitor user and URI already exist, add
`--mongo-uri-file /home/ubuntu/mongo-monitor-uri`. That enables the
authenticated ping; the TCP check is always shown separately.

The installer:

* creates the unprivileged `kds-agent` user and `/var/lib/kds-agent`;
* installs `/opt/kds-agent/kds_vm_agent.py` root-owned;
* writes `/etc/kds/kds-agent.json` (0640 `root:kds-agent`, no secrets) and
  `/etc/kds/agent-token` (0640 `root:kds-agent`, value never printed);
* adds **one** exact sudoers rule:
  `kds-agent ALL=(root) NOPASSWD: /usr/bin/systemctl restart kds-backend`
  (vm2: `mongod`) — no shell, no wildcard;
* installs `kds-agent.service` + `kds-agent.timer` and enables the timer,
  unless `--no-start` is given;
* runs a read-only `--check` self-test **before** enabling the timer, and
  aborts if the self-test fails;
* refuses to overwrite an existing config unless `--force` is given (and
  keeps a timestamped backup when it does).

The service runs as `kds-agent` with `ProtectSystem=strict`, `ProtectHome=yes`,
`PrivateTmp=yes`, `PrivateDevices=yes`, `RestrictAddressFamilies`,
`MemoryMax=96M`, `CPUQuota=25%`, and read access to the journal through the
`systemd-journal` supplementary group. `NoNewPrivileges` stays off only because
of the single sudo restart rule.

Useful commands:

```bash
systemctl list-timers kds-agent.timer
journalctl -u kds-agent.service -n 50 --no-pager
sudo -u kds-agent python3 /opt/kds-agent/kds_vm_agent.py --check
```

---

## 9. Agent configuration reference

`/etc/kds/kds-agent.json` (generated; no secrets). Keys actually read by the
agent:

| Key | Meaning |
|---|---|
| `vm_id` | `vm1` or `vm2`; must match the token header |
| `api_url` | Backend base URL |
| `token_file` | Path to the token (default `/etc/kds/agent-token`) |
| `state_file` | Bounded queue + restart bookkeeping (default `/var/lib/kds-agent/state.json`) |
| `services` | Units to report every heartbeat |
| `restart_allowlist` | Units the agent may restart (subset of the API allowlist) |
| `recovery_enabled` | Local kill switch; `false` refuses every restart |
| `backend_health_url` | VM1: HTTP health probe (`<api>/health`) |
| `mongo_tcp_target` | VM1: dependency TCP check (`10.1.2.178:27017`) |
| `mongo_ping_enabled` | VM2: run an authenticated `mongosh` ping |
| `mongo_uri_file` | VM2: path to the 0640 URI file (never in argv) |
| `backup_dir`, `backup_glob`, `backup_max_age_hours` | VM2: real backup file check; empty dir → `NOT_CONFIGURED` |
| `journal_events` | Read bounded priority ≤ 3 journal lines since the last send |

The agent never reboots a host, never edits the firewall, users, database
configuration, OCI lists or SSH files, never logs the token/URI, keeps at most
5 queued heartbeats (30 min / 5 samples), and caps journal output at 10 lines.

Offline behaviour: a failed delivery is queued and retried on the next run; the
queue is bounded and old entries are dropped. It never blocks for more than the
HTTP timeout (15 s) plus collection time.

---

## 10. Recovery policy

Automatic recovery is **on by default but narrow**:

1. A finding must be a real service failure (`ActiveState=failed` or the unit
   missing while it is a critical service) — not high CPU, RAM or disk.
2. The service must be in the backend allowlist. Default:
   `kds-backend,mongod`. The agent must also allow it locally.
3. The backend caps attempts: 2 per incident, 2 per hour per service, 600 s
   cooldown. The agent independently enforces 2 per hour and a 600 s cooldown
   (60 s for a manual request).
4. Before restarting, the agent re-checks that the unit is **not** already
   active (if it is, it refuses: no genuine failure). For MongoDB it also
   refuses when authenticated `currentOp` shows more than
   `mongo_max_active_ops` (default 0) in-flight operations.
5. The action runs `sudo -n /usr/bin/systemctl restart <unit>` only. No reboot,
   no `kill`, no config edits, no firewall/DB changes.
6. The result (success, verified active within 15 s, duration) is posted back
   and written to the remediation audit and events.

Manual remediation uses the same path but requires an operator JWT and
`confirm: true`. Automatic recovery can be disabled entirely with
`VM_AUTO_RECOVERY_ENABLED=false`; manual actions still work. The agent also has
its own `recovery_enabled` switch.

There is deliberately **no auto-reboot, no auto-failover, no database repair,
no OCI API call, and no SSH-key/credential action** in this feature.

---

## 11. Deployment sequence (requires explicit approval)

Nothing below has been executed. Each step needs approval and a backup of the
file being changed.

1. **Approve and record a rollback point.** Note the current units, the
   `git` commit, and copy any existing env file to a root-only backup.
2. **Deploy the Python service to VM1** with a `kds-backend` unit; set
   `python-service/.env` from §7. Do not open port 8000 publicly. Confirm:
   `curl -fsS http://10.1.1.133:8000/health`.
3. **Deploy the Next app to VM1** with `BACKEND_URL=http://10.1.1.133:8000`.
   Confirm the login gate and `/services/vm`.
4. **Install the VM1 agent** (§8) and confirm one heartbeat in
   `journalctl -u kds-agent.service` and on `/services/vm`.
5. **Create a read-only MongoDB monitor user on VM2** only if approved. This
   is a database change and therefore a separate approval. Store the URI in a
   0640 file, install the VM2 agent with `--mongo-uri-file`, and confirm the
   authenticated ping turns `OK`.
6. **Configure real backups on VM2** separately (out of scope here). Until a
   file exists the UI must keep showing `NOT_CONFIGURED`.
7. **Only after both agents report**, consider enabling automatic recovery.
   It is already on by default in code; set
   `VM_AUTO_RECOVERY_ENABLED=false` first if a staged rollout is preferred.

Verification checklist (evidence must be captured, not assumed):

```bash
# VM1, private address only
curl -fsS http://10.1.1.133:8000/health
ss -ltnp | grep ':8000'          # must be 10.1.1.133:8000, not 0.0.0.0
# agents
systemctl list-timers kds-agent.timer
journalctl -u kds-agent.service -n 20 --no-pager
# API (from an authenticated browser session)
GET /api/vm/overview            # connected_agents = 2, agents CONNECTED
GET /api/vm/agents              # tokens_configured {vm1:true, vm2:true}
# after a deliberate test restart (with approval)
GET /api/vm/remediations        # actor, reason, result, verified
```

A deploy is **not** successful merely because the page renders. It is
successful when `/api/vm/overview` shows two CONNECTED agents with fresh
timestamps and the detail pages show real service/check data.

---

## 12. Rollback

Agent rollback is local and reversible:

```bash
sudo /path/to/install-agent.sh --uninstall          # stop/disable, remove units+sudoers
sudo /path/to/install-agent.sh --uninstall --purge  # also remove config/token/state/user
```

Backend rollback: restore the previous `kds-backend` unit/env from the recorded
backup, then `systemctl daemon-reload && systemctl restart kds-backend`. The VM
collections (`vm_*`) can be left in place; they are read-only to the UI and
expire via TTL indexes. Dropping them is optional data loss, not required for
rollback.

Frontend rollback: revert the commit that added `app/(services)/services/vm`,
`app/_pages/vm`, `lib/vm-management*`, `hooks/use-vm-polling.ts` and the nav
entry. No database migration is required for the UI.

If only automatic recovery is a problem, set
`VM_AUTO_RECOVERY_ENABLED=false` and restart the backend. This does not require
touching the agents.

---

## 13. Resource footprint

Measured locally (Linux, Python 3.14, `--check`, 0.5 s CPU sample):

| Metric | Value |
|---|---|
| Max RSS | 26.9 MB |
| CPU time per run | ~0.21 s user+sys |
| Wall time per run | ~1.0 s (includes the 0.5 s sample) |
| Schedule | every 60 s |
| State file | < 10 KB, atomic replace |
| Queue cap | 5 heartbeats / 30 min |
| Service limits | `MemoryMax=96M`, `CPUQuota=25%` |

Expected storage with both agents online: ~2 × 1,440 snapshot docs/day; the
TTL index removes them after 14 days (≈ 40k small documents total). Events are
bounded to 10 per heartbeat and expire after 30 days. The agents add no
listener, no open port and no extra package.

Memory on each host is ~1 GB, so these caps leave the rest to MongoDB/backend.
Re-measure on the real VM after install with:

```bash
/usr/bin/time -v sudo -u kds-agent python3 /opt/kds-agent/kds_vm_agent.py --check
systemctl show kds-agent.service -p MemoryMax -p CPUQuota -p TasksMax
```

---

## 14. Security boundaries

* No secret is returned by any API, written to logs, or committed. `.env`,
  `*.key`, `id_rsa*`, dumps/backups and agent secrets are git-ignored;
  `.env.example` templates are explicitly kept.
* The agent runs unprivileged. Its only privilege escalation is one exact
  `systemctl restart` command via sudoers.
* MongoDB port 27017 is unchanged: bound to loopback + private IP, auth
  enabled. This feature does not modify `mongod.conf`, users, roles or the OCI
  security list.
* The API stays on the private network. The browser reaches it through the
  session-gated Next layer, and every read is independently authorised by an
  operator JWT at the Python boundary. Network isolation is a second layer, not
  the only one.
* Journal content is redacted for URIs/passwords/tokens and truncated; only
  priority ≤ 3 (error and worse) lines are read.

### Residual risks / known gaps

1. **Not deployed yet.** No agent is installed; no VM telemetry exists. The UI
   will show `DISCONNECTED`/`NEVER_CONNECTED` until deployment is approved.
2. **VM1 has no app/backend unit.** A VM1 agent would report
   `kds-backend` as missing and health checks as unconfigured/failed.
3. **No authenticated MongoDB ping.** No monitor user/URI is configured, so
   VM2 shows the ping as `NOT_CONFIGURED`. TCP reachability is still real.
4. **No backups exist on VM2.** Backup status is `NOT_CONFIGURED`, not "OK".
5. **VM reads need the server-side operator credentials.** If `APP_USERNAME` /
   `APP_PASSWORD` are missing from the Next server's environment, the token
   route returns `502 NO_OPERATOR_CREDENTIALS` and the pages show it. This is
   intentional fail-closed behaviour, not an anonymous fallback.
6. **One shared operator identity.** The single owner account is the only
   operator, so audit fields record that account rather than distinct humans.
   Any valid owner session + JWT can restart the allowlisted units; there is no
   separate read-only role.
7. **No push channel.** Actions are delivered in the heartbeat response, so a
   manual restart can take up to 60 s to reach the agent.
8. **No external alerting.** Incidents are visible in the UI, not emailed or
   paged. Email/SMS is out of scope.
9. **No log retention beyond the UI limits** (10 events/heartbeat, 30-day TTL).
10. **Topology constants.** `VM_META` (IPs, shape) and the installer's VM1
    dependency target (`10.1.2.178:27017`) are static; changing the VCN layout
    requires a code/config update.

---

## 15. Troubleshooting

| Symptom | Check |
|---|---|
| Page shows `DISCONNECTED` | Is the timer running? `journalctl -u kds-agent.service`; is `VM_AGENT_TOKEN_VMx` set in the backend env? |
| `503 AGENT_TOKEN_NOT_CONFIGURED` in agent log | Backend env is missing the token for that VM. Add it and restart the backend (approved). |
| `401 INVALID_AGENT_TOKEN` | Token file and backend env differ. Rewrite the token file; no need to restart the agent. |
| API returns `503 VM_TELEMETRY_UNAVAILABLE` | The backend cannot read MongoDB. Check the backend's Mongo connection and logs. |
| Restart queued but nothing happens | The action is claimed on the next heartbeat (≤ 60 s). Then check the agent's local allowlist/caps and `journalctl`. |
| Restart refused "already active" | Working as intended: the agent will not restart a healthy service. |
| `STALE` but agent logs look fine | Clock/key mismatch or the backend time is ahead. Compare `collected_at` in `journalctl` with the API `generated_at`. |
| VM2 backup `NOT_CONFIGURED` | Expected until a real backup job writes a file; pass `--backup-dir` at install to point at it. |
