#!/usr/bin/env python3
"""KDS VM monitoring agent — one small stdlib-only heartbeat per minute.

Installed on VM1 (backend) and VM2 (MongoDB). It collects real host metrics,
service state and dependency checks, then POSTs a heartbeat to the KDS API.
The API answers with at most one approved remediation action; the agent executes
only allowlisted ``systemctl restart`` operations after verifying a genuine
failure, and reports the result back.

Deliberate scope limits
-----------------------
* Never reboots a VM.
* Never edits firewall rules, MongoDB users/database config or security lists.
* Never restarts a service that is already active/healthy.
* Never logs or transmits the agent token, MongoDB URI or SSH material.
* Bounded log output, bounded offline queue, bounded journal lines.

Usage
-----
    kds_vm_agent.py --once          # one heartbeat (systemd timer)
    kds_vm_agent.py --check         # collect + print a redacted summary
    kds_vm_agent.py --config PATH   # override config path

Config: /etc/kds/kds-agent.json (0640 root:kds-agent)
Token:  /etc/kds/agent-token     (0640 root:kds-agent)
State:  /var/lib/kds-agent/state.json (0600 kds-agent)
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import platform
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

AGENT_VERSION = "1.0.0"
DEFAULT_CONFIG = "/etc/kds/kds-agent.json"
MAX_QUEUE = 5
MAX_EVENTS = 10
MAX_EVENT_AGE_S = 900
MAX_QUEUE_AGE_S = 1800
LOCAL_RESTART_COOLDOWN_S = 600
LOCAL_RESTART_MAX_PER_HOUR = 2
SECRET_PATTERNS = re.compile(
    r"(mongodb(?:\+srv)?://[^\s'\"]+|password\s*[=:]\s*\S+|passwd\s*[=:]\s*\S+|"
    r"token\s*[=:]\s*\S+|secret\s*[=:]\s*\S+|authorization:\s*\S+)",
    re.IGNORECASE,
)

#: Units the agent may restart. The API has its own allowlist; both must allow.
DEFAULT_ALLOWLIST = {"vm1": ["kds-backend"], "vm2": ["mongod"]}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def redact(text: str, limit: int = 300) -> str:
    text = SECRET_PATTERNS.sub("[REDACTED]", str(text or ""))
    text = "".join(ch for ch in text if ch in "\n\t" or ord(ch) >= 32)
    return text[:limit]


def read_text(path: str) -> str:
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read().strip()


def run(cmd: list[str], timeout: float = 10, env: dict | None = None) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout,
            env=env, check=False,
        )
        return proc.returncode, proc.stdout or "", proc.stderr or ""
    except FileNotFoundError:
        return 127, "", f"{cmd[0]} not found"
    except subprocess.TimeoutExpired:
        return 124, "", f"{cmd[0]} timed out after {timeout}s"
    except Exception as exc:  # defensive: an agent must never crash the timer
        return 1, "", redact(str(exc))


# ---------------------------------------------------------------------------
# collection
# ---------------------------------------------------------------------------

def _read(path: str) -> str:
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def cpu_percent(sample_seconds: float = 0.5) -> float | None:
    """CPU busy percentage from /proc/stat (stdlib, no psutil)."""
    def sample() -> tuple[int, int] | None:
        line = (_read("/proc/stat").splitlines() or [""])[0]
        if not line.startswith("cpu "):
            return None
        parts = [int(p) for p in line.split()[1:] if p.isdigit()]
        if len(parts) < 4:
            return None
        idle = parts[3] + (parts[4] if len(parts) > 4 else 0)
        return sum(parts), idle

    first = sample()
    if not first:
        return None
    time.sleep(max(0.1, min(sample_seconds, 2.0)))
    second = sample()
    if not second:
        return None
    total_delta = second[0] - first[0]
    idle_delta = second[1] - first[1]
    if total_delta <= 0:
        return None
    return round(max(0.0, min(100.0, 100.0 * (total_delta - idle_delta) / total_delta)), 1)


def load_average() -> tuple[float | None, float | None, float | None]:
    parts = _read("/proc/loadavg").split()
    if len(parts) < 3:
        return None, None, None
    try:
        return float(parts[0]), float(parts[1]), float(parts[2])
    except ValueError:
        return None, None, None


def memory() -> dict:
    values: dict[str, float] = {}
    for line in _read("/proc/meminfo").splitlines():
        if ":" not in line:
            continue
        key, rest = line.split(":", 1)
        number = rest.strip().split()[0] if rest.strip() else ""
        if number.isdigit():
            values[key] = int(number) / 1024.0  # kB -> MiB
    total = values.get("MemTotal")
    available = values.get("MemAvailable")
    swap_total = values.get("SwapTotal")
    swap_free = values.get("SwapFree")
    return {
        "mem_total_mb": round(total, 1) if total else None,
        "mem_available_mb": round(available, 1) if available else None,
        "mem_available_pct": round(100.0 * available / total, 1) if total and available is not None else None,
        "swap_total_mb": round(swap_total, 1) if swap_total else None,
        "swap_used_mb": round(swap_total - swap_free, 1) if swap_total is not None and swap_free is not None else None,
        "swap_used_pct": round(100.0 * (swap_total - swap_free) / swap_total, 1) if swap_total and swap_free is not None else None,
    }


def disk_usage(path: str = "/") -> dict:
    try:
        st = os.statvfs(path)
    except OSError:
        return {
            "disk_total_gb": None, "disk_used_gb": None, "disk_used_pct": None,
            "inode_total": None, "inode_used": None, "inode_used_pct": None,
        }
    total = st.f_blocks * st.f_frsize
    free = st.f_bfree * st.f_frsize
    used = max(0, total - free)
    inode_total = st.f_files
    inode_free = st.f_ffree
    inode_used = max(0, inode_total - inode_free)
    return {
        "disk_total_gb": round(total / (1024 ** 3), 2),
        "disk_used_gb": round(used / (1024 ** 3), 2),
        "disk_used_pct": round(100.0 * used / total, 1) if total else None,
        "inode_total": int(inode_total),
        "inode_used": int(inode_used),
        "inode_used_pct": round(100.0 * inode_used / inode_total, 1) if inode_total else None,
    }


def uptime_and_boot() -> tuple[float | None, str | None]:
    parts = _read("/proc/uptime").split()
    boot_id = _read("/proc/sys/kernel/random/boot_id").strip() or None
    if not parts:
        return None, boot_id
    try:
        return round(float(parts[0]), 1), boot_id
    except ValueError:
        return None, boot_id


def service_state(name: str) -> dict:
    code, out, _ = run([
        "systemctl", "show", name,
        "-p", "LoadState", "-p", "ActiveState", "-p", "SubState",
        "-p", "NRestarts", "-p", "ExecMainStartTimestamp",
        "--no-pager",
    ], timeout=5)
    props: dict[str, str] = {}
    for line in out.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            props[key] = value.strip()
    exists = props.get("LoadState", "not-found") != "not-found"
    restarts = props.get("NRestarts", "")
    return {
        "name": name,
        "exists": exists,
        "active": props.get("ActiveState", ""),
        "sub": props.get("SubState", ""),
        "restarts": int(restarts) if restarts.isdigit() else None,
        "since": props.get("ExecMainStartTimestamp") or None,
    }


def failed_units(limit: int = 20) -> list[str]:
    code, out, _ = run([
        "systemctl", "list-units", "--state=failed", "--no-legend",
        "--plain", "--no-pager",
    ], timeout=5)
    units = []
    for line in out.splitlines():
        parts = line.split()
        if parts and parts[0].endswith(".service"):
            units.append(parts[0][:120])
    return units[:limit]


def journal_events(since_epoch: float) -> list[dict]:
    """Bounded, redacted warning/error lines. Never full logs."""
    code, out, _ = run([
        "journalctl", "-p", "3", "-n", str(MAX_EVENTS), "--since",
        datetime.fromtimestamp(max(0, since_epoch), tz=timezone.utc).isoformat(),
        "--no-pager", "-o", "short-iso",
    ], timeout=8)
    events = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        stamp = now_iso()
        first = line.split(" ", 1)[0]
        if first.count(":") >= 2:
            try:
                stamp = datetime.fromisoformat(first.replace("Z", "+00:00")).isoformat()
                line = line.split(" ", 1)[1] if " " in line else line
            except ValueError:
                pass
        events.append({
            "ts": stamp, "severity": "error", "source": "journal",
            "message": redact(line, 240),
        })
    return events[-MAX_EVENTS:]


def http_health(url: str, timeout: float = 5.0) -> dict:
    if not url:
        return {"configured": False, "ok": None}
    started = time.monotonic()
    try:
        request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": f"kds-agent/{AGENT_VERSION}"})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(4096)
            status = response.status
        latency = round((time.monotonic() - started) * 1000, 1)
        ok = 200 <= status < 300
        try:
            doc = json.loads(raw.decode("utf-8", errors="replace"))
            if isinstance(doc, dict) and "ok" in doc:
                ok = bool(doc.get("ok")) and ok
        except json.JSONDecodeError:
            pass
        return {"configured": True, "ok": ok, "status_code": status, "latency_ms": latency, "error": None if ok else f"HTTP {status}"}
    except Exception as exc:
        return {
            "configured": True, "ok": False,
            "latency_ms": round((time.monotonic() - started) * 1000, 1),
            "error": redact(f"{type(exc).__name__}: {exc}", 300),
        }


def tcp_check(target: str, timeout: float = 3.0) -> dict:
    if not target:
        return {"configured": False, "ok": None}
    host, _, port_text = target.rpartition(":")
    try:
        port = int(port_text)
    except ValueError:
        return {"configured": True, "ok": False, "target": target, "error": "invalid target"}
    started = time.monotonic()
    try:
        with socket.create_connection((host, port), timeout=timeout):
            pass
        return {"configured": True, "ok": True, "target": target, "latency_ms": round((time.monotonic() - started) * 1000, 1)}
    except Exception as exc:
        return {
            "configured": True, "ok": False, "target": target,
            "latency_ms": round((time.monotonic() - started) * 1000, 1),
            "error": redact(str(exc), 200), "error_kind": "connection",
        }


def mongo_ping(uri: str, timeout: float = 10.0) -> dict:
    """Authenticated ping via mongosh. The URI is passed in the environment,
    never in argv (argv is visible to other local users)."""
    if not uri:
        return {"configured": False, "ok": None, "authenticated": None}
    script = (
        "const u=process.env.KDS_MONGO_URI;"
        "const c=connect(u, 5000);"
        "const r=c.getDB('admin').runCommand({ping:1});"
        "print(JSON.stringify({ok:r.ok===1}));c.close();"
    )
    env = dict(os.environ)
    env["KDS_MONGO_URI"] = uri
    started = time.monotonic()
    code, out, err = run(["mongosh", "--nodb", "--quiet", "--eval", script], timeout=timeout, env=env)
    env.pop("KDS_MONGO_URI", None)
    latency = round((time.monotonic() - started) * 1000, 1)
    combined = f"{out}\n{err}".lower()
    if code == 0 and '"ok":true' in out.replace(" ", ""):
        return {"configured": True, "ok": True, "authenticated": True, "latency_ms": latency}
    auth_failure = any(token in combined for token in (
        "authentication failed", "auth failed", "scram", "bad auth", "unauthorized", "not authorized",
    ))
    return {
        "configured": True, "ok": False, "authenticated": False,
        "latency_ms": latency,
        "error": redact(err or out or "mongosh ping failed", 300),
        "error_kind": "authentication" if auth_failure else "connection",
    }


def mongo_active_ops(uri: str) -> int | None:
    """Count non-idle currentOp entries before a restart; None when unknown."""
    if not uri:
        return None
    script = (
        "const c=connect(process.env.KDS_MONGO_URI, 5000);"
        "const ops=c.getDB('admin').aggregate([{$currentOp:{allUsers:true,idleConnections:false}}]).toArray();"
        "print(JSON.stringify({ops:ops.length}));c.close();"
    )
    env = dict(os.environ)
    env["KDS_MONGO_URI"] = uri
    code, out, _ = run(["mongosh", "--nodb", "--quiet", "--eval", script], timeout=10, env=env)
    env.pop("KDS_MONGO_URI", None)
    if code != 0:
        return None
    try:
        return int(json.loads(out.strip().splitlines()[-1]).get("ops", 0))
    except Exception:
        return None


def backup_status(cfg: dict) -> dict:
    directory = str(cfg.get("backup_dir") or "").strip()
    if not directory:
        return {"configured": False, "ok": None}
    pattern = str(cfg.get("backup_glob") or "*")
    try:
        files = [p for p in glob.glob(os.path.join(directory, pattern)) if os.path.isfile(p)]
    except Exception as exc:
        return {"configured": True, "ok": False, "error": redact(str(exc), 200)}
    if not files:
        return {"configured": True, "ok": False, "error": f"no backup matching {pattern} in {directory}"}
    newest = max(files, key=lambda p: os.path.getmtime(p))
    age_hours = round((time.time() - os.path.getmtime(newest)) / 3600.0, 1)
    size = os.path.getsize(newest)
    return {
        "configured": True,
        "ok": size > 0 and age_hours <= float(cfg.get("backup_max_age_hours") or 30),
        "last_backup_at": datetime.fromtimestamp(os.path.getmtime(newest), tz=timezone.utc).isoformat(),
        "age_hours": age_hours,
        "error": None if size > 0 else "newest backup is empty",
    }


def collect(cfg: dict, state: dict) -> dict:
    metrics = {
        "cpu_pct": cpu_percent(),
        "load1": None, "load5": None, "load15": None,
        **memory(), **disk_usage("/"),
    }
    metrics["load1"], metrics["load5"], metrics["load15"] = load_average()
    uptime, boot_id = uptime_and_boot()
    metrics["boot_time"] = (
        datetime.fromtimestamp(time.time() - uptime, tz=timezone.utc).isoformat()
        if uptime is not None else None
    )

    services = [service_state(name) for name in (cfg.get("services") or DEFAULT_ALLOWLIST.get(cfg["vm_id"], []))]

    checks: dict[str, dict] = {}
    role = cfg.get("vm_id")
    if role == "vm1":
        checks["backend_health"] = http_health(str(cfg.get("backend_health_url") or ""))
        checks["mongo_tcp"] = tcp_check(str(cfg.get("mongo_tcp_target") or ""))
    if role == "vm2":
        uri = ""
        uri_file = str(cfg.get("mongo_uri_file") or "").strip()
        if uri_file:
            try:
                uri = read_text(uri_file)
            except OSError:
                uri = ""
        if cfg.get("mongo_ping_enabled"):
            checks["mongo_ping"] = mongo_ping(uri)
        checks["backup"] = backup_status(cfg)

    last_journal = float(state.get("last_journal_ts") or (time.time() - MAX_EVENT_AGE_S))
    events = journal_events(last_journal) if cfg.get("journal_events", True) else []

    return {
        "vm_id": role,
        "seq": int(state.get("seq") or 0) + 1,
        "collected_at": now_iso(),
        "boot_id": boot_id,
        "uptime_seconds": uptime,
        "agent_version": AGENT_VERSION,
        "hostname": socket.gethostname(),
        "platform": f"{platform.system()} {platform.release()}",
        "metrics": metrics,
        "services": services,
        "failed_units": failed_units(),
        "checks": checks,
        "events": events,
    }


# ---------------------------------------------------------------------------
# transport + state
# ---------------------------------------------------------------------------

def post_json(url: str, body: dict, headers: dict, timeout: float = 15) -> tuple[int, dict]:
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        url, data=data, method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": f"kds-agent/{AGENT_VERSION}",
            **headers,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(65536)
            status = response.status
    except urllib.error.HTTPError as exc:
        raw = exc.read(4096)
        status = exc.code
    except Exception as exc:
        return 0, {"error": redact(f"{type(exc).__name__}: {exc}", 200)}
    try:
        payload = json.loads(raw.decode("utf-8", errors="replace")) if raw else {}
    except json.JSONDecodeError:
        payload = {"error": "non-JSON response"}
    return status, payload


def load_state(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(path: str, state: dict) -> None:
    try:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(state, handle, indent=2, sort_keys=True)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except OSError as exc:
        print(f"WARN could not write state: {redact(str(exc))}", file=sys.stderr)


def queue_snapshot(state: dict, snapshot: dict) -> None:
    queue = list(state.get("queue") or [])
    queue.append(snapshot)
    cutoff = time.time() - MAX_QUEUE_AGE_S
    kept = []
    for item in queue[-MAX_QUEUE:]:
        try:
            ts = datetime.fromisoformat(str(item.get("collected_at")).replace("Z", "+00:00")).timestamp()
        except ValueError:
            ts = 0
        if ts >= cutoff:
            kept.append(item)
    state["queue"] = kept


# ---------------------------------------------------------------------------
# remediation (allowlisted, verified, never a reboot)
# ---------------------------------------------------------------------------

def _local_restart_allowed(state: dict, service: str, trigger: str) -> tuple[bool, str]:
    stamps = [float(x) for x in (state.get("restarts") or {}).get(service, []) if str(x).replace(".", "", 1).isdigit()]
    now = time.time()
    stamps = [s for s in stamps if now - s < 3600]
    if len(stamps) >= LOCAL_RESTART_MAX_PER_HOUR:
        return False, f"local hourly restart cap reached ({LOCAL_RESTART_MAX_PER_HOUR}/h)"
    if stamps:
        cooldown = 60 if trigger == "manual" else LOCAL_RESTART_COOLDOWN_S
        if now - max(stamps) < cooldown:
            return False, f"local cooldown active ({cooldown}s)"
    return True, "ok"


def _record_restart(state: dict, service: str) -> None:
    bucket = dict(state.get("restarts") or {})
    stamps = [float(x) for x in bucket.get(service, []) if str(x).replace(".", "", 1).isdigit()]
    now = time.time()
    bucket[service] = [s for s in stamps if now - s < 3600] + [now]
    state["restarts"] = bucket


def _restart_service(cfg: dict, state: dict, action: dict) -> dict:
    service = str(action.get("service") or "")
    trigger = str(action.get("trigger") or "manual")
    allowlist = set(cfg.get("restart_allowlist") or DEFAULT_ALLOWLIST.get(cfg["vm_id"], []))
    if service not in allowlist:
        return {"success": False, "verified": False, "duration_ms": 0,
                "result": f"refused: {service} is not in the local restart allowlist"}
    allowed, reason = _local_restart_allowed(state, service, trigger)
    if not allowed:
        return {"success": False, "verified": False, "duration_ms": 0, "result": f"refused: {reason}"}

    state_before = service_state(service)
    if not state_before.get("exists"):
        return {"success": False, "verified": False, "duration_ms": 0, "result": "refused: unit not found"}
    if state_before.get("active") == "active":
        return {"success": False, "verified": True, "duration_ms": 0,
                "result": "refused: service is already active; no genuine failure"}

    if service == "mongod" and cfg.get("vm_id") == "vm2":
        uri = ""
        uri_file = str(cfg.get("mongo_uri_file") or "").strip()
        if uri_file:
            try:
                uri = read_text(uri_file)
            except OSError:
                uri = ""
        ops = mongo_active_ops(uri)
        if ops is not None and ops > int(cfg.get("mongo_max_active_ops") or 0):
            return {"success": False, "verified": False, "duration_ms": 0,
                    "result": f"refused: {ops} active MongoDB operation(s) in progress"}

    started = time.monotonic()
    _record_restart(state, service)
    code, _out, err = run(["sudo", "-n", "/usr/bin/systemctl", "restart", service], timeout=45)
    if code != 0:
        return {"success": False, "verified": False,
                "duration_ms": int((time.monotonic() - started) * 1000),
                "result": f"systemctl restart failed ({code}): {redact(err, 300)}"}

    verified = False
    for _ in range(10):
        time.sleep(1.5)
        if service_state(service).get("active") == "active":
            verified = True
            break
    duration = int((time.monotonic() - started) * 1000)
    return {
        "success": True, "verified": verified, "duration_ms": duration,
        "result": "restarted; active state verified" if verified else "restart command succeeded but active state was not verified within 15s",
    }


def handle_actions(cfg: dict, state: dict, actions: list[dict], api_url: str, headers: dict) -> None:
    if not actions:
        return
    for action in actions[:1]:  # one at a time, never parallel restarts
        if action.get("action") != "restart_service":
            continue
        action_id = str(action.get("id") or "")
        if not cfg.get("recovery_enabled", True):
            result = {"success": False, "verified": False, "duration_ms": 0,
                      "result": "refused: local recovery is disabled (recovery_enabled=false)"}
        else:
            result = _restart_service(cfg, state, action)
        if not action_id:
            continue
        status, payload = post_json(
            f"{api_url.rstrip('/')}/api/vm/remediations/{action_id}/result",
            result, headers, timeout=15,
        )
        if status < 200 or status >= 300:
            # Keep the result for the next run instead of losing the audit trail.
            state["pending_result"] = {"action_id": action_id, "body": result}
            print(f"WARN result not accepted ({status}); queued for retry", file=sys.stderr)
        else:
            state.pop("pending_result", None)


def flush_pending_result(state: dict, api_url: str, headers: dict) -> None:
    pending = state.get("pending_result")
    if not isinstance(pending, dict) or not pending.get("action_id"):
        return
    status, _ = post_json(
        f"{api_url.rstrip('/')}/api/vm/remediations/{pending['action_id']}/result",
        pending.get("body") or {}, headers, timeout=15,
    )
    if 200 <= status < 300:
        state.pop("pending_result", None)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def load_config(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as handle:
        cfg = json.load(handle)
    if not isinstance(cfg, dict):
        raise ValueError("config must be a JSON object")
    if cfg.get("vm_id") not in {"vm1", "vm2"}:
        raise ValueError("vm_id must be vm1 or vm2")
    if not str(cfg.get("api_url") or "").startswith(("http://", "https://")):
        raise ValueError("api_url must start with http:// or https://")
    return cfg


def load_token(cfg: dict) -> str:
    env_token = os.environ.get("KDS_AGENT_TOKEN", "").strip()
    if env_token:
        return env_token
    token_file = str(cfg.get("token_file") or "")
    if not token_file:
        raise ValueError("token_file is not configured")
    token = read_text(token_file)
    if len(token) < 24:
        raise ValueError("agent token file is empty or too short")
    return token


def run_once(config_path: str, check_only: bool = False) -> int:
    try:
        cfg = load_config(config_path)
        token = load_token(cfg)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"ERROR config: {redact(str(exc))}", file=sys.stderr)
        return 2

    state_path = str(cfg.get("state_file") or "/var/lib/kds-agent/state.json")
    state = load_state(state_path)
    api_url = str(cfg["api_url"]).rstrip("/")
    headers = {"X-KDS-Agent-VM": cfg["vm_id"], "X-KDS-Agent-Token": token}

    try:
        snapshot = collect(cfg, state)
    except Exception as exc:
        print(f"ERROR collect: {redact(str(exc))}", file=sys.stderr)
        return 3

    if check_only:
        safe = {
            "vm_id": snapshot["vm_id"], "collected_at": snapshot["collected_at"],
            "metrics": snapshot["metrics"], "services": snapshot["services"],
            "failed_units": snapshot["failed_units"], "checks": snapshot["checks"],
            "events": len(snapshot["events"]), "seq": snapshot["seq"],
        }
        print(json.dumps(safe, indent=2))
        return 0

    state["seq"] = snapshot["seq"]
    if snapshot["events"]:
        state["last_journal_ts"] = time.time()

    # A previous remediation result that could not be delivered is retried first.
    flush_pending_result(state, api_url, headers)

    # Deliver a small bounded offline queue oldest-first, then the current sample.
    queue = list(state.get("queue") or [])
    delivered = 0
    for queued in queue[:MAX_QUEUE]:
        status, payload = post_json(f"{api_url}/api/vm/heartbeat", queued, headers)
        if 200 <= status < 300:
            delivered += 1
        elif status in (401, 403, 503):
            break
    if delivered:
        state["queue"] = queue[delivered:]

    status, payload = post_json(f"{api_url}/api/vm/heartbeat", snapshot, headers)
    if status in (200, 201):
        state["queue"] = []
        data = payload.get("data") or {}
        handle_actions(cfg, state, data.get("actions") or [], api_url, headers)
        save_state(state_path, state)
        print(f"OK heartbeat vm={cfg['vm_id']} seq={snapshot['seq']} agent={data.get('agent_state')}")
        return 0

    # Do not lose telemetry during an API/network outage; bounded by MAX_QUEUE.
    queue_snapshot(state, snapshot)
    save_state(state_path, state)
    message = payload.get("detail") or payload.get("error") or "unreachable"
    print(f"WARN heartbeat failed status={status}: {redact(str(message), 200)}", file=sys.stderr)
    return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="KDS VM monitoring agent")
    parser.add_argument("--once", action="store_true", help="send one heartbeat (default)")
    parser.add_argument("--check", action="store_true", help="collect and print a redacted summary; no network")
    parser.add_argument("--config", default=os.environ.get("KDS_AGENT_CONFIG", DEFAULT_CONFIG))
    args = parser.parse_args(argv)
    if not args.once and not args.check:
        parser.print_help()
        return 2
    return run_once(args.config, check_only=args.check)


if __name__ == "__main__":
    sys.exit(main())
