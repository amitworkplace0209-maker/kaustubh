"""VM monitoring policy — pure, dependency-free evaluation logic.

This module deliberately has NO database, FastAPI or agent imports so the
threshold/dedupe/recovery rules can be unit-tested in isolation and reused by
the API and the tests. Real values come only from the agent payload; anything
missing stays ``None`` and is rendered as UNKNOWN by the UI.

Design rules
------------
* Sustained checks need real samples spanning the window. A single spike (or a
  fresh agent that has only sent one sample) never opens an incident.
* Every incident has a stable ``dedupe_key``; the store upserts on that key so
  repeated polls cannot duplicate an incident.
* Recovery is conservative: allowlisted services only, verified failure only,
  per-incident attempt cap, per-service cooldown and hourly cap.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterable

SEVERITY_RANK = {"info": 1, "warning": 2, "critical": 3}

#: Human-facing metadata for the two managed hosts. Purely static
#: infrastructure facts supplied by the operator — never live metrics.
VM_META: dict[str, dict[str, Any]] = {
    "vm1": {
        "id": "vm1",
        "name": "VM1 — Backend",
        "role": "backend",
        "privateIp": "10.1.1.133",
        "publicIp": "130.210.55.165",
        "os": "Ubuntu 24.04.5",
        "shape": "VM.Standard.E2.1.Micro",
        "subnet": "public",
        "criticalServices": ["kds-backend"],
        "dependency": "MongoDB 10.1.2.178:27017",
    },
    "vm2": {
        "id": "vm2",
        "name": "VM2 — MongoDB",
        "role": "mongodb",
        "privateIp": "10.1.2.178",
        "publicIp": None,
        "os": "Ubuntu 24.04.5",
        "shape": "VM.Standard.E2.1.Micro",
        "subnet": "private",
        "criticalServices": ["mongod"],
        "dependency": None,
    },
}


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def parse_ts(value: Any) -> datetime | None:
    """Parse an ISO timestamp/epoch into an aware UTC datetime; None if bad."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(float(value), tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


@dataclass(frozen=True)
class Thresholds:
    """Operator-tunable thresholds (see VM_* environment variables)."""

    cpu_warn_pct: float = 85.0
    cpu_critical_pct: float = 95.0
    cpu_warn_sustain_s: int = 300
    cpu_critical_sustain_s: int = 600
    ram_warn_available_pct: float = 15.0
    ram_critical_available_pct: float = 8.0
    ram_sustain_s: int = 120
    disk_warn_pct: float = 80.0
    disk_critical_pct: float = 90.0
    inode_warn_pct: float = 80.0
    inode_critical_pct: float = 90.0
    swap_warn_pct: float = 80.0
    swap_sustain_s: int = 600
    service_fail_samples: int = 2
    check_fail_samples: int = 3
    backup_max_age_hours: float = 30.0
    stale_seconds: int = 180
    disconnected_seconds: int = 600


@dataclass(frozen=True)
class RecoveryPolicy:
    enabled: bool = True
    allowlist: tuple[str, ...] = ("kds-backend", "mongod")
    cooldown_seconds: int = 600
    max_per_incident: int = 2
    max_per_hour: int = 2
    stale_action_seconds: int = 300


@dataclass
class Finding:
    resource: str
    severity: str
    title: str
    message: str
    observed: str
    threshold: str
    probable_cause: str
    remediation: str
    service: str | None = None
    key_suffix: str = ""

    @property
    def dedupe_key(self) -> str:
        return f"{self.resource}{self.key_suffix}"


def _num(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def _pct(part: Any, total: Any) -> float | None:
    p, t = _num(part), _num(total)
    if p is None or t is None or t <= 0:
        return None
    return max(0.0, min(100.0, (p / t) * 100.0))


def _samples(history: Iterable[dict], now: datetime, window_s: int) -> list[dict]:
    cutoff = now - timedelta(seconds=window_s)
    out: list[dict] = []
    for snap in history:
        ts = parse_ts(snap.get("collected_at") or snap.get("ts"))
        if ts is not None and ts >= cutoff:
            out.append(snap)
    out.sort(key=lambda s: parse_ts(s.get("collected_at") or s.get("ts")) or now)
    return out


def _sustained(
    history: Iterable[dict],
    now: datetime,
    window_s: int,
    predicate: Callable[[dict], bool],
    *,
    min_span_ratio: float = 0.8,
) -> tuple[bool, int, datetime | None]:
    """All samples inside the window must satisfy ``predicate`` AND the samples
    must actually span most of the window. This prevents a single sample (or a
    burst of retries) from being treated as a sustained condition."""
    rows = _samples(history, now, window_s)
    if not rows:
        return False, 0, None
    times = [parse_ts(r.get("collected_at") or r.get("ts")) for r in rows]
    times = [t for t in times if t is not None]
    if not times:
        return False, 0, None
    span = (times[-1] - times[0]).total_seconds()
    if span < window_s * min_span_ratio:
        return False, len(rows), None
    ok = all(predicate(r) for r in rows)
    return ok, len(rows), times[0]


def _consecutive(history: Iterable[dict], predicate: Callable[[dict], bool], count: int) -> bool:
    rows = sorted(
        history,
        key=lambda s: parse_ts(s.get("collected_at") or s.get("ts")) or datetime.min.replace(tzinfo=timezone.utc),
    )
    tail = rows[-count:]
    return len(tail) >= count and all(predicate(r) for r in tail)


def _metric(snap: dict, name: str) -> Any:
    metrics = snap.get("metrics") or {}
    return metrics.get(name)


def _mem_available_pct(snap: dict) -> float | None:
    direct = _num(_metric(snap, "mem_available_pct"))
    if direct is not None:
        return direct
    return _pct(_metric(snap, "mem_available_mb"), _metric(snap, "mem_total_mb"))


def _check(snap: dict, name: str) -> dict:
    checks = snap.get("checks") or {}
    value = checks.get(name)
    return value if isinstance(value, dict) else {}


def _service(snap: dict, name: str) -> dict:
    for svc in snap.get("services") or []:
        if isinstance(svc, dict) and svc.get("name") == name:
            return svc
    return {}


def _fmt(value: float | None, suffix: str = "%") -> str:
    return "UNKNOWN" if value is None else f"{value:.1f}{suffix}"


CAUSES = {
    "cpu": ("A runaway process, an expensive query/scan, or normal load above the host's capacity.",
            "Inspect top processes on the host. Do not restart a service on load alone; reduce load first."),
    "memory": ("Memory pressure from application growth, caches, or a leak; low available RAM can trigger the OOM killer.",
               "Inspect the largest RSS processes and recent OOM/journal entries. Plan a service restart only after confirming the culprit."),
    "swap": ("Sustained swap use means the host is short on physical memory.",
             "Confirm which processes are swapped out; treat as a memory-pressure symptom."),
    "disk": ("Log growth, database growth, package caches, or unrotated files.",
             "Identify the largest directories. Archive/rotate logs. Never delete database files manually."),
    "inode": ("Many small files (logs, sessions, caches) exhausting the inode table.",
              "Find directories with a high file count; rotate/clean application caches."),
    "service": ("The systemd unit is failed/inactive or repeatedly restarting.",
                "Read `systemctl status` and `journalctl -u <unit>` first. A single restart is allowed only for an allowlisted service."),
    "backend": ("The backend health endpoint is failing or the process is not serving requests.",
                "Check the backend journal, port 8000 listener, and MongoDB connectivity. Restart only after the failure is confirmed."),
    "mongo": ("MongoDB is unreachable from the backend host, or the authenticated ping fails.",
              "Check the mongod unit, disk space and network path. Never reboot the VM or change firewall/auth config automatically."),
    "backup": ("No recent verifiable backup exists, or the last backup job failed.",
               "Check the backup timer/logs and verify a real restore before relying on the backup."),
    "failed-units": ("One or more systemd units entered the failed state.",
                     "Inspect each failing unit's journal. Do not mass-restart unrelated services."),
    "agent": ("No heartbeat from the monitoring agent: the host, agent timer, network path or API may be down.",
              "Check the agent timer and journal on the host. An agent inside a stopped VM cannot report its own outage — use OCI alarms for full-host failure."),
}


def evaluate_snapshot(
    vm_id: str,
    snapshot: dict,
    history: list[dict],
    thresholds: Thresholds,
    now: datetime | None = None,
) -> list[Finding]:
    """Return the findings that are currently true for one host.

    ``history`` must include the current snapshot and enough previous samples
    for sustained checks. Missing values never produce a finding.
    """
    now = now or datetime.now(timezone.utc)
    findings: list[Finding] = []
    resources = (VM_META.get(vm_id) or {}).get("criticalServices") or []

    # ---- CPU (sustained) ----
    cpu_samples = _samples(history, now, thresholds.cpu_critical_sustain_s)
    cpu_values = [v for v in (_num(_metric(s, "cpu_pct")) for s in cpu_samples) if v is not None]
    cpu_now = _num(_metric(snapshot, "cpu_pct"))
    if cpu_values and cpu_now is not None:
        critical, count, since = _sustained(
            history, now, thresholds.cpu_critical_sustain_s,
            lambda s: (_num(_metric(s, "cpu_pct")) or 0) >= thresholds.cpu_critical_pct,
        )
        if critical:
            findings.append(Finding(
                resource="cpu", severity="critical", title="CPU critically high",
                message=f"CPU stayed at or above {thresholds.cpu_critical_pct:.0f}% for {thresholds.cpu_critical_sustain_s // 60} minutes.",
                observed=f"{cpu_now:.1f}% now; {len(cpu_values)} sustained samples",
                threshold=f">= {thresholds.cpu_critical_pct:.0f}% for {thresholds.cpu_critical_sustain_s}s",
                probable_cause=CAUSES["cpu"][0], remediation=CAUSES["cpu"][1],
            ))
        else:
            warn, _, _ = _sustained(
                history, now, thresholds.cpu_warn_sustain_s,
                lambda s: (_num(_metric(s, "cpu_pct")) or 0) >= thresholds.cpu_warn_pct,
            )
            if warn:
                findings.append(Finding(
                    resource="cpu", severity="warning", title="CPU high",
                    message=f"CPU stayed at or above {thresholds.cpu_warn_pct:.0f}% for {thresholds.cpu_warn_sustain_s // 60} minutes.",
                    observed=f"{cpu_now:.1f}% now; {len(cpu_values)} samples",
                    threshold=f">= {thresholds.cpu_warn_pct:.0f}% for {thresholds.cpu_warn_sustain_s}s",
                    probable_cause=CAUSES["cpu"][0], remediation=CAUSES["cpu"][1],
                ))

    # ---- Available RAM (sustained) ----
    ram_now = _mem_available_pct(snapshot)
    if ram_now is not None:
        crit, _, _ = _sustained(
            history, now, thresholds.ram_sustain_s,
            lambda s: (_mem_available_pct(s) is not None and _mem_available_pct(s) < thresholds.ram_critical_available_pct),
        )
        warn, _, _ = _sustained(
            history, now, thresholds.ram_sustain_s,
            lambda s: (_mem_available_pct(s) is not None and _mem_available_pct(s) < thresholds.ram_warn_available_pct),
        )
        if crit:
            findings.append(Finding(
                resource="memory", severity="critical", title="Available RAM critically low",
                message=f"Available RAM stayed below {thresholds.ram_critical_available_pct:.0f}% for {thresholds.ram_sustain_s}s.",
                observed=f"{ram_now:.1f}% available",
                threshold=f"< {thresholds.ram_critical_available_pct:.0f}% for {thresholds.ram_sustain_s}s",
                probable_cause=CAUSES["memory"][0], remediation=CAUSES["memory"][1],
            ))
        elif warn:
            findings.append(Finding(
                resource="memory", severity="warning", title="Available RAM low",
                message=f"Available RAM stayed below {thresholds.ram_warn_available_pct:.0f}% for {thresholds.ram_sustain_s}s.",
                observed=f"{ram_now:.1f}% available",
                threshold=f"< {thresholds.ram_warn_available_pct:.0f}% for {thresholds.ram_sustain_s}s",
                probable_cause=CAUSES["memory"][0], remediation=CAUSES["memory"][1],
            ))

    # ---- Swap (sustained) ----
    swap_now = _num(_metric(snapshot, "swap_used_pct"))
    if swap_now is not None:
        swap, _, _ = _sustained(
            history, now, thresholds.swap_sustain_s,
            lambda s: (_num(_metric(s, "swap_used_pct")) or 0) >= thresholds.swap_warn_pct,
        )
        if swap:
            findings.append(Finding(
                resource="swap", severity="warning", title="Sustained swap usage",
                message=f"Swap usage stayed at or above {thresholds.swap_warn_pct:.0f}% for {thresholds.swap_sustain_s // 60} minutes.",
                observed=f"{swap_now:.1f}% swap used",
                threshold=f">= {thresholds.swap_warn_pct:.0f}% for {thresholds.swap_sustain_s}s",
                probable_cause=CAUSES["swap"][0], remediation=CAUSES["swap"][1],
            ))

    # ---- Disk / inodes (instant, capacity is not transient) ----
    for metric, resource, label, warn, crit in (
        ("disk_used_pct", "disk", "Disk", thresholds.disk_warn_pct, thresholds.disk_critical_pct),
        ("inode_used_pct", "inode", "Inode", thresholds.inode_warn_pct, thresholds.inode_critical_pct),
    ):
        value = _num(_metric(snapshot, metric))
        if value is None:
            continue
        if value >= crit:
            severity, limit = "critical", crit
        elif value >= warn:
            severity, limit = "warning", warn
        else:
            continue
        findings.append(Finding(
            resource=resource, severity=severity, title=f"{label} usage {severity}",
            message=f"{label} usage is at {value:.1f}% on /.",
            observed=f"{value:.1f}%",
            threshold=f">= {limit:.0f}%",
            probable_cause=CAUSES[resource][0], remediation=CAUSES[resource][1],
        ))

    # ---- Monitored services ----
    for name in resources:
        svc = _service(snapshot, name)
        if not svc or not svc.get("exists", True):
            continue  # not deployed yet -> UNKNOWN, never a fabricated failure
        failed = str(svc.get("active") or "") != "active"
        if not failed:
            continue
        confirmed = _consecutive(
            history,
            lambda s, n=name: (
                bool((_service(s, n) or {}).get("exists", True))
                and str((_service(s, n) or {}).get("active") or "") != "active"
            ),
            thresholds.service_fail_samples,
        )
        severity = "critical" if confirmed else "warning"
        findings.append(Finding(
            resource=f"service:{name}", service=name, severity=severity,
            title=f"{name} is not running",
            message=(
                f"systemd reports {name} as {svc.get('active') or 'unknown'}"
                f"{'/' + str(svc.get('sub')) if svc.get('sub') else ''}."
            ),
            observed=f"active={svc.get('active')}, sub={svc.get('sub')}, restarts={svc.get('restarts')}",
            threshold=f"active state required for {thresholds.service_fail_samples} consecutive samples",
            probable_cause=CAUSES["service"][0], remediation=CAUSES["service"][1],
        ))

    # ---- Failed units ----
    units = [str(u) for u in (snapshot.get("failed_units") or []) if u]
    if units:
        findings.append(Finding(
            resource="failed-units", severity="warning",
            title=f"{len(units)} failed systemd unit(s)",
            message=", ".join(units[:8]) + ("…" if len(units) > 8 else ""),
            observed=f"{len(units)} failed",
            threshold="0 failed units",
            probable_cause=CAUSES["failed-units"][0], remediation=CAUSES["failed-units"][1],
        ))

    # ---- Backend health (VM1) ----
    backend = _check(snapshot, "backend_health")
    if backend.get("configured") and backend.get("ok") is False:
        confirmed = _consecutive(
            history,
            lambda s: (_check(s, "backend_health").get("configured")
                       and _check(s, "backend_health").get("ok") is False),
            thresholds.check_fail_samples,
        )
        findings.append(Finding(
            resource="backend-health", severity="critical" if confirmed else "warning",
            title="Backend health check failing",
            message=str(backend.get("error") or "The backend health endpoint did not return OK.")[:300],
            observed=f"HTTP {backend.get('status_code') or 'no response'}; latency={backend.get('latency_ms')}ms",
            threshold=f"{thresholds.check_fail_samples} consecutive failures",
            probable_cause=CAUSES["backend"][0], remediation=CAUSES["backend"][1],
        ))

    # ---- VM1 -> VM2 MongoDB TCP reachability ----
    mongo_tcp = _check(snapshot, "mongo_tcp")
    if mongo_tcp.get("configured") and mongo_tcp.get("ok") is False:
        confirmed = _consecutive(
            history,
            lambda s: (_check(s, "mongo_tcp").get("configured")
                       and _check(s, "mongo_tcp").get("ok") is False),
            thresholds.check_fail_samples,
        )
        findings.append(Finding(
            resource="mongo-connectivity", severity="critical" if confirmed else "warning",
            title="MongoDB port unreachable",
            message=str(mongo_tcp.get("error") or "TCP 27017 did not accept a connection from VM1.")[:300],
            observed=f"target={mongo_tcp.get('target') or VM_META['vm1']['dependency']}",
            threshold=f"{thresholds.check_fail_samples} consecutive failures",
            probable_cause=CAUSES["mongo"][0], remediation=CAUSES["mongo"][1],
        ))

    # ---- VM2 authenticated MongoDB ping ----
    mongo_ping = _check(snapshot, "mongo_ping")
    if mongo_ping.get("configured") and mongo_ping.get("ok") is False:
        kind = str(mongo_ping.get("error_kind") or "connection")
        confirmed = _consecutive(
            history,
            lambda s: (_check(s, "mongo_ping").get("configured")
                       and _check(s, "mongo_ping").get("ok") is False),
            thresholds.check_fail_samples,
        )
        severity = "critical" if (confirmed and kind != "authentication") else "warning"
        findings.append(Finding(
            resource="mongo-ping-auth" if kind == "authentication" else "mongo-ping",
            severity=severity,
            title="MongoDB ping failing" + (" (authentication)" if kind == "authentication" else ""),
            message=str(mongo_ping.get("error") or "The authenticated MongoDB ping failed.")[:300],
            observed=f"kind={kind}; latency={mongo_ping.get('latency_ms')}ms",
            threshold=f"{thresholds.check_fail_samples} consecutive failures",
            probable_cause=CAUSES["mongo"][0] if kind != "authentication" else "The monitoring credential is missing, wrong, or not authorised.",
            remediation=CAUSES["mongo"][1] if kind != "authentication" else "Fix the agent's protected MongoDB credential file. Do NOT restart mongod for an authentication error.",
        ))

    # ---- Backup freshness (only when the agent is configured to verify one) ----
    backup = _check(snapshot, "backup")
    age = _num(backup.get("age_hours"))
    if backup.get("configured"):
        if backup.get("ok") is False or (age is not None and age > thresholds.backup_max_age_hours):
            if age is not None:
                message = str(backup.get("error") or f"Last verified backup is {age:.1f}h old.")
            else:
                message = str(backup.get("error") or "No verified backup found.")
            findings.append(Finding(
                resource="backup", severity="warning", title="Backup is stale or failed",
                message=message[:300],
                observed=f"age={_fmt(age, 'h')}, last={backup.get('last_backup_at') or 'UNKNOWN'}",
                threshold=f"<= {thresholds.backup_max_age_hours:.0f}h old",
                probable_cause=CAUSES["backup"][0], remediation=CAUSES["backup"][1],
            ))

    return findings


def stale_finding(vm_id: str, last_seen: datetime | None, thresholds: Thresholds, now: datetime | None = None) -> Finding | None:
    """Agent-staleness incident. Warning when quiet, critical when disconnected."""
    now = now or datetime.now(timezone.utc)
    if last_seen is None:
        return Finding(
            resource="agent", severity="critical", title="Monitoring agent never reported",
            message="No heartbeat has ever been received for this VM. Telemetry is UNKNOWN.",
            observed="no heartbeat", threshold=f"heartbeat every 60s; stale after {thresholds.stale_seconds}s",
            probable_cause=CAUSES["agent"][0], remediation=CAUSES["agent"][1],
        )
    age = (now - last_seen).total_seconds()
    if age < thresholds.stale_seconds:
        return None
    if age >= thresholds.disconnected_seconds:
        severity = "critical"
    elif age >= thresholds.stale_seconds:
        severity = "warning"
    else:
        return None
    return Finding(
        resource="agent", severity=severity,
        title="Agent disconnected" if severity == "critical" else "Agent data stale",
        message=f"No heartbeat for {int(age)}s. Metrics are STALE — not live.",
        observed=f"last heartbeat {int(age)}s ago",
        threshold=f"stale > {thresholds.stale_seconds}s; disconnected > {thresholds.disconnected_seconds}s",
        probable_cause=CAUSES["agent"][0], remediation=CAUSES["agent"][1],
    )


def agent_state(last_seen: datetime | None, thresholds: Thresholds, now: datetime | None = None) -> str:
    if last_seen is None:
        return "NEVER_CONNECTED"
    age = ((now or datetime.now(timezone.utc)) - last_seen).total_seconds()
    if age >= thresholds.disconnected_seconds:
        return "DISCONNECTED"
    if age >= thresholds.stale_seconds:
        return "STALE"
    return "CONNECTED"


def can_remediate(
    *,
    incident: dict,
    actions: list[dict],
    service: str,
    policy: RecoveryPolicy,
    now: datetime | None = None,
) -> tuple[bool, str]:
    """Conservative auto/manual recovery gate. Returns (allowed, reason)."""
    now = now or datetime.now(timezone.utc)
    if service not in policy.allowlist:
        return False, f"{service} is not in the approved restart allowlist"
    if incident.get("status") == "resolved":
        return False, "incident is already resolved"
    if incident.get("resource") != f"service:{service}":
        return False, "only a confirmed service failure can trigger a restart"

    def when(action: dict) -> datetime | None:
        return parse_ts(action.get("finished_at") or action.get("requested_at") or action.get("created_at"))

    for_incident = [a for a in actions if a.get("incident_id") == incident.get("id") or a.get("incident_id") == incident.get("_id")]
    if len(for_incident) >= policy.max_per_incident:
        return False, f"restart limit reached for this incident ({policy.max_per_incident})"

    same_service = [a for a in actions if a.get("service") == service]
    latest = max((when(a) for a in same_service if when(a)), default=None)
    if latest is not None and (now - latest).total_seconds() < policy.cooldown_seconds:
        return False, f"cooldown active for {service} ({policy.cooldown_seconds}s)"

    last_hour = [a for a in same_service if when(a) and (now - when(a)).total_seconds() < 3600]
    if len(last_hour) >= policy.max_per_hour:
        return False, f"hourly restart cap reached for {service} ({policy.max_per_hour}/h)"

    # A failed attempt requires a longer backoff before trying again.
    last = max(same_service, key=lambda a: when(a) or datetime.min.replace(tzinfo=timezone.utc), default=None)
    if last and str(last.get("status")) == "failed" and latest is not None:
        if (now - latest).total_seconds() < policy.cooldown_seconds * 2:
            return False, f"last restart failed; backoff is {policy.cooldown_seconds * 2}s"

    return True, "eligible"


def summarize(findings: list[Finding], state: str) -> str:
    """Overall host status from real findings + agent state."""
    if state in {"DISCONNECTED", "NEVER_CONNECTED"}:
        return "DISCONNECTED"
    if any(f.severity == "critical" for f in findings):
        return "CRITICAL"
    if any(f.severity == "warning" for f in findings):
        return "DEGRADED"
    if state == "STALE":
        return "STALE"
    return "HEALTHY"
