"""VM management API — central health, incidents and audited remediation.

Authentication model
--------------------
Every endpoint is authorised at this boundary; the Next.js session gate is
defence in depth, not the only control.

* **Humans** need the operator JWT for *all* reads (overview, host detail,
  history, incidents, events, remediation history) and for every mutation
  (acknowledge / resolve / request restart). The JWT is minted from the single
  owner account and is the same credential used by other terminal actions.
  The browser obtains it from the session-gated ``/api/auth/trading-token``
  route and keeps it in memory only. A direct request to the Python port
  without a valid JWT is rejected with 401: the API is not readable merely
  because the port is reachable.
* **Agents** (VM1/VM2) POST heartbeats with ``X-KDS-Agent-VM`` and
  ``X-KDS-Agent-Token``. Each host has a separate revocable token; the backend
  stores/compares only SHA-256 digests in constant time. A token for VM1 can
  never submit as VM2. An operator JWT is not accepted in place of an agent
  token, and agent credentials cannot read human endpoints.

No endpoint ever returns an agent token, MongoDB URI, SSH key or env contents.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator

from config.settings import settings
from services import vm_store
from services.jwt_auth import verify_token
from services.vm_policy import (
    RecoveryPolicy,
    Thresholds,
    VM_META,
    agent_state,
    summarize,
)

router = APIRouter(prefix="/api/vm", tags=["vm-management"])
log = logging.getLogger("app.vm.api")

MAX_SERVICES = 50
MAX_EVENTS = 20
MAX_FAILED_UNITS = 50


# ---------------------------------------------------------------------------
# configuration
# ---------------------------------------------------------------------------

def thresholds() -> Thresholds:
    return Thresholds(
        cpu_warn_pct=settings.vm_cpu_warn_pct,
        cpu_critical_pct=settings.vm_cpu_critical_pct,
        cpu_warn_sustain_s=settings.vm_cpu_warn_sustain_s,
        cpu_critical_sustain_s=settings.vm_cpu_critical_sustain_s,
        ram_warn_available_pct=settings.vm_ram_warn_pct,
        ram_critical_available_pct=settings.vm_ram_critical_pct,
        ram_sustain_s=settings.vm_ram_sustain_s,
        disk_warn_pct=settings.vm_disk_warn_pct,
        disk_critical_pct=settings.vm_disk_critical_pct,
        inode_warn_pct=settings.vm_inode_warn_pct,
        inode_critical_pct=settings.vm_inode_critical_pct,
        backup_max_age_hours=settings.vm_backup_max_age_hours,
        stale_seconds=settings.vm_stale_seconds,
        disconnected_seconds=settings.vm_disconnected_seconds,
    )


def recovery_policy() -> RecoveryPolicy:
    allow = tuple(s.strip() for s in (settings.vm_recovery_allowlist or "").split(",") if s.strip())
    return RecoveryPolicy(
        enabled=bool(settings.vm_auto_recovery_enabled),
        allowlist=allow,
        cooldown_seconds=max(60, settings.vm_recovery_cooldown_seconds),
        max_per_incident=max(1, settings.vm_recovery_max_per_incident),
        max_per_hour=max(1, settings.vm_recovery_max_per_hour),
    )


# ---------------------------------------------------------------------------
# auth
# ---------------------------------------------------------------------------

def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _configured_agent_tokens() -> dict[str, str]:
    return {
        "vm1": (settings.vm_agent_token_vm1 or "").strip(),
        "vm2": (settings.vm_agent_token_vm2 or "").strip(),
    }


def require_agent(
    vm: str = Header(..., alias="X-KDS-Agent-VM"),
    token: str = Header(..., alias="X-KDS-Agent-Token"),
) -> str:
    vm_id = (vm or "").strip().lower()
    tokens = _configured_agent_tokens()
    if vm_id not in tokens:
        raise HTTPException(403, detail={"code": "UNKNOWN_AGENT", "message": "unknown agent VM"})
    expected = tokens[vm_id]
    if not expected:
        # Fail closed: an unconfigured server must never accept anonymous
        # telemetry. Operators get a clear setup error instead.
        raise HTTPException(503, detail={
            "code": "AGENT_TOKEN_NOT_CONFIGURED",
            "message": f"VM_AGENT_TOKEN_{vm_id.upper()} is not configured on the backend",
        })
    if not token or not hmac.compare_digest(_digest(token), _digest(expected)):
        raise HTTPException(401, detail={"code": "INVALID_AGENT_TOKEN", "message": "invalid agent token"})
    return vm_id


def require_operator(request: Request) -> dict:
    header = request.headers.get("authorization") or ""
    token = header[7:].strip() if header.lower().startswith("bearer ") else ""
    if not token:
        token = (request.headers.get("x-operator-jwt") or "").strip()
    if not token:
        raise HTTPException(401, detail={"code": "OPERATOR_JWT_REQUIRED", "message": "operator JWT required"})
    try:
        payload = verify_token(token)
    except ValueError as exc:
        raise HTTPException(401, detail={"code": "INVALID_OPERATOR_JWT", "message": str(exc)}) from exc
    role = str(payload.get("role") or "")
    if role != "admin" and str(payload.get("sub") or "") != (settings.app_username or "kaustubh"):
        raise HTTPException(403, detail={"code": "FORBIDDEN", "message": "admin role required"})
    return payload


def _actor(payload: dict) -> str:
    return str(payload.get("sub") or "operator")[:80]


# ---------------------------------------------------------------------------
# request models
# ---------------------------------------------------------------------------

class VmMetrics(BaseModel):
    cpu_pct: float | None = Field(None, ge=0, le=100)
    load1: float | None = Field(None, ge=0, le=100000)
    load5: float | None = Field(None, ge=0, le=100000)
    load15: float | None = Field(None, ge=0, le=100000)
    mem_total_mb: float | None = Field(None, ge=0, le=10_000_000)
    mem_available_mb: float | None = Field(None, ge=0, le=10_000_000)
    mem_available_pct: float | None = Field(None, ge=0, le=100)
    swap_total_mb: float | None = Field(None, ge=0, le=10_000_000)
    swap_used_mb: float | None = Field(None, ge=0, le=10_000_000)
    swap_used_pct: float | None = Field(None, ge=0, le=100)
    disk_total_gb: float | None = Field(None, ge=0, le=1_000_000)
    disk_used_gb: float | None = Field(None, ge=0, le=1_000_000)
    disk_used_pct: float | None = Field(None, ge=0, le=100)
    inode_total: float | None = Field(None, ge=0, le=10**12)
    inode_used: float | None = Field(None, ge=0, le=10**12)
    inode_used_pct: float | None = Field(None, ge=0, le=100)
    boot_time: str | None = Field(None, max_length=64)


class VmService(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    exists: bool = True
    active: str = Field(default="", max_length=40)
    sub: str = Field(default="", max_length=40)
    restarts: int | None = Field(None, ge=0, le=1_000_000_000)
    since: str | None = Field(None, max_length=64)


class VmCheck(BaseModel):
    configured: bool = False
    ok: bool | None = None
    authenticated: bool | None = None
    status_code: int | None = Field(None, ge=0, le=999)
    latency_ms: float | None = Field(None, ge=0, le=600_000)
    target: str | None = Field(None, max_length=200)
    error: str | None = Field(None, max_length=500)
    error_kind: str | None = Field(None, max_length=40)
    last_backup_at: str | None = Field(None, max_length=64)
    age_hours: float | None = Field(None, ge=0, le=1_000_000)


class VmEventIn(BaseModel):
    ts: str | None = Field(None, max_length=64)
    severity: Literal["info", "warning", "error", "critical", "success"] = "info"
    source: str = Field(default="agent", max_length=40)
    message: str = Field(min_length=1, max_length=300)


class AgentHeartbeat(BaseModel):
    vm_id: Literal["vm1", "vm2"]
    seq: int = Field(ge=0, le=10**12)
    collected_at: str = Field(min_length=10, max_length=64)
    boot_id: str | None = Field(None, max_length=100)
    uptime_seconds: float | None = Field(None, ge=0, le=10**12)
    agent_version: str = Field(default="unknown", max_length=40)
    metrics: VmMetrics
    services: list[VmService] = Field(default_factory=list, max_length=MAX_SERVICES)
    failed_units: list[str] = Field(default_factory=list, max_length=MAX_FAILED_UNITS)
    checks: dict[str, VmCheck] = Field(default_factory=dict)
    events: list[VmEventIn] = Field(default_factory=list, max_length=MAX_EVENTS)

    @field_validator("collected_at")
    @classmethod
    def _clock_skew(cls, value: str) -> str:
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("collected_at must be ISO-8601") from exc
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        if dt > now + timedelta(minutes=5):
            raise ValueError("collected_at is more than 5 minutes in the future")
        if dt < now - timedelta(days=1):
            raise ValueError("collected_at is older than 24 hours")
        return value

    @field_validator("failed_units")
    @classmethod
    def _units(cls, values: list[str]) -> list[str]:
        return [str(v)[:120] for v in values if str(v).strip()][:MAX_FAILED_UNITS]

    @field_validator("checks")
    @classmethod
    def _checks(cls, values: dict[str, VmCheck]) -> dict[str, VmCheck]:
        allowed = {"backend_health", "mongo_tcp", "mongo_ping", "backup", "disk"}
        return {k: v for k, v in values.items() if k in allowed}


class IncidentAction(BaseModel):
    reason: str = Field(default="", max_length=300)


class RemediationRequest(BaseModel):
    vm_id: Literal["vm1", "vm2"]
    service: str = Field(min_length=1, max_length=80)
    confirm: bool = False
    reason: str = Field(default="", max_length=300)


class RemediationResult(BaseModel):
    success: bool
    verified: bool = False
    duration_ms: int = Field(default=0, ge=0, le=3_600_000)
    result: str = Field(default="", max_length=1000)


# ---------------------------------------------------------------------------
# read endpoints
# ---------------------------------------------------------------------------

def _ok(data: Any) -> dict:
    return {"ok": True, "data": data}


def _guard(exc: Exception) -> HTTPException:
    log.warning("VM telemetry unavailable: %s", exc)
    return HTTPException(503, detail={
        "code": "VM_TELEMETRY_UNAVAILABLE",
        "message": "MongoDB is unavailable; VM telemetry cannot be read right now.",
    })


def _host_view(host: dict) -> dict:
    """Add static metadata + derived status to one host row."""
    vm_id = host["vm"]
    meta = VM_META[vm_id]
    incidents = [i for i in (host.get("incidents") or []) if i]
    severity = "info"
    rank = {"info": 1, "warning": 2, "critical": 3}
    for inc in incidents:
        if rank.get(inc.get("severity"), 1) > rank.get(severity, 1):
            severity = inc.get("severity")
    found = []
    # Light-weight Finding-like objects only for summarize(); no values invented.
    for inc in incidents:
        found.append(type("F", (), {"severity": inc.get("severity")})())
    status = summarize(found, host.get("agent_state") or "NEVER_CONNECTED")
    return {
        **host,
        "meta": meta,
        "status": status,
        "incident_counts": {
            "critical": sum(1 for i in incidents if i.get("severity") == "critical"),
            "warning": sum(1 for i in incidents if i.get("severity") == "warning"),
            "info": sum(1 for i in incidents if i.get("severity") == "info"),
            "total": len(incidents),
        },
        "highest_severity": severity,
    }


@router.get("/overview")
async def vm_overview(auth: dict = Depends(require_operator)):
    try:
        data = await vm_store.overview(thresholds())
    except Exception as exc:  # database down / unconfigured
        raise _guard(exc) from exc
    hosts = [_host_view(h) for h in data["hosts"]]
    critical = sum(h["incident_counts"]["critical"] for h in hosts)
    warning = sum(h["incident_counts"]["warning"] for h in hosts)
    connected = sum(1 for h in hosts if h["agent_state"] == "CONNECTED")
    if connected == 0:
        overall = "DISCONNECTED"
    elif critical:
        overall = "CRITICAL"
    elif warning:
        overall = "DEGRADED"
    elif connected < len(hosts):
        overall = "STALE"
    else:
        overall = "HEALTHY"
    return _ok({
        "overall": overall,
        "connected_agents": connected,
        "total_agents": len(hosts),
        "open_incidents": {"critical": critical, "warning": warning, "total": critical + warning},
        "hosts": hosts,
        "pending_actions": data.get("pending_actions") or [],
        "generated_at": data.get("generated_at"),
        "thresholds": {
            "cpu_warn_pct": settings.vm_cpu_warn_pct,
            "cpu_critical_pct": settings.vm_cpu_critical_pct,
            "cpu_warn_sustain_s": settings.vm_cpu_warn_sustain_s,
            "ram_warn_available_pct": settings.vm_ram_warn_pct,
            "ram_critical_available_pct": settings.vm_ram_critical_pct,
            "disk_warn_pct": settings.vm_disk_warn_pct,
            "disk_critical_pct": settings.vm_disk_critical_pct,
            "stale_seconds": settings.vm_stale_seconds,
            "disconnected_seconds": settings.vm_disconnected_seconds,
        },
    })


@router.get("/agents")
async def vm_agents(auth: dict = Depends(require_operator)):
    try:
        agents = await vm_store.agent_status(thresholds())
    except Exception as exc:
        raise _guard(exc) from exc
    return _ok({"agents": agents, "tokens_configured": {vm: bool(tok) for vm, tok in _configured_agent_tokens().items()}})


@router.get("/incidents")
async def vm_incidents(
    auth: dict = Depends(require_operator),
    vm: str = Query("", pattern="^(vm1|vm2)?$"),
    severity: str = Query("", pattern="^(info|warning|critical)?$"),
    status: str = Query("", pattern="^(open|acknowledged|resolved)?$"),
    service: str = Query("", max_length=80),
    resource: str = Query("", max_length=80),
    start: str = Query("", max_length=64),
    end: str = Query("", max_length=64),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0, le=100000),
):
    try:
        data = await vm_store.list_incidents(
            vm_id=vm, severity=severity, status=status, service=service,
            resource=resource, start=start, end=end, limit=limit, offset=offset,
        )
    except Exception as exc:
        raise _guard(exc) from exc
    return _ok(data)


@router.get("/incidents/{incident_id}")
async def vm_incident_detail(incident_id: str, auth: dict = Depends(require_operator)):
    try:
        data = await vm_store.get_incident(incident_id)
    except Exception as exc:
        raise _guard(exc) from exc
    if not data:
        raise HTTPException(404, detail={"code": "INCIDENT_NOT_FOUND", "message": "incident not found"})
    return _ok(data)


@router.post("/incidents/{incident_id}/acknowledge")
async def vm_incident_ack(
    incident_id: str,
    body: IncidentAction | None = None,
    auth: dict = Depends(require_operator),
):
    try:
        data = await vm_store.update_incident(
            incident_id, actor=_actor(auth), action="acknowledge", reason=(body.reason if body else ""),
        )
    except Exception as exc:
        raise _guard(exc) from exc
    if not data:
        raise HTTPException(404, detail={"code": "INCIDENT_NOT_FOUND", "message": "incident not found"})
    return _ok(data)


@router.post("/incidents/{incident_id}/resolve")
async def vm_incident_resolve(
    incident_id: str,
    body: IncidentAction | None = None,
    auth: dict = Depends(require_operator),
):
    try:
        data = await vm_store.update_incident(
            incident_id, actor=_actor(auth), action="resolve", reason=(body.reason if body else ""),
        )
    except Exception as exc:
        raise _guard(exc) from exc
    if not data:
        raise HTTPException(404, detail={"code": "INCIDENT_NOT_FOUND", "message": "incident not found"})
    return _ok(data)


@router.get("/events")
async def vm_events(
    auth: dict = Depends(require_operator),
    vm: str = Query("", pattern="^(vm1|vm2)?$"),
    severity: str = Query("", pattern="^(info|warning|error|critical|success)?$"),
    limit: int = Query(100, ge=1, le=300),
    before: str = Query("", max_length=64),
):
    try:
        data = await vm_store.list_events(vm_id=vm, severity=severity, limit=limit, before=before)
    except Exception as exc:
        raise _guard(exc) from exc
    return _ok(data)


@router.get("/remediations")
async def vm_remediations(
    auth: dict = Depends(require_operator),
    vm: str = Query("", pattern="^(vm1|vm2)?$"),
    limit: int = Query(50, ge=1, le=200),
):
    try:
        data = await vm_store.list_actions(vm_id=vm, limit=limit)
    except Exception as exc:
        raise _guard(exc) from exc
    return _ok(data)


@router.get("/{vm_id}")
async def vm_detail(vm_id: str, auth: dict = Depends(require_operator)):
    if vm_id not in VM_META:
        raise HTTPException(404, detail={"code": "VM_NOT_FOUND", "message": "unknown VM"})
    th = thresholds()
    try:
        # Refresh staleness so a silent host opens one incident even if nobody
        # else is polling, then read the real rows.
        await vm_store.refresh_staleness(vm_id, th)
        current = await vm_store.get_current(vm_id)
        history = await vm_store.get_history(vm_id, hours=6, limit=180)
        incidents = await vm_store.incidents_for_vm(vm_id, limit=80)
        events = await vm_store.list_events(vm_id=vm_id, limit=80)
        actions = await vm_store.list_actions(vm_id=vm_id, limit=30)
    except Exception as exc:
        raise _guard(exc) from exc
    last_seen = current.get("received_at") if current else None
    state = agent_state(
        datetime.fromisoformat(last_seen) if last_seen else None, th,
    )
    active = [i for i in incidents if i.get("active")]
    found = [type("F", (), {"severity": i.get("severity")})() for i in active]
    return _ok({
        "vm": vm_id,
        "meta": VM_META[vm_id],
        "agent_state": state,
        "status": summarize(found, state),
        "snapshot": current,
        "history": history,
        "incidents": incidents,
        "events": events.get("events") or [],
        "actions": actions.get("actions") or [],
        "thresholds": {
            "cpu_warn_pct": th.cpu_warn_pct,
            "cpu_critical_pct": th.cpu_critical_pct,
            "ram_warn_available_pct": th.ram_warn_available_pct,
            "ram_critical_available_pct": th.ram_critical_available_pct,
            "disk_warn_pct": th.disk_warn_pct,
            "disk_critical_pct": th.disk_critical_pct,
            "backup_max_age_hours": th.backup_max_age_hours,
            "stale_seconds": th.stale_seconds,
            "disconnected_seconds": th.disconnected_seconds,
        },
        "recovery": {
            "enabled": bool(settings.vm_auto_recovery_enabled),
            "allowlist": list(recovery_policy().allowlist),
            "cooldown_seconds": recovery_policy().cooldown_seconds,
            "max_per_incident": recovery_policy().max_per_incident,
            "max_per_hour": recovery_policy().max_per_hour,
            "automatic_restart_scope": "allowlisted systemd services only; never a VM reboot",
        },
    })


@router.get("/{vm_id}/history")
async def vm_history(
    vm_id: str,
    auth: dict = Depends(require_operator),
    hours: float = Query(6, gt=0, le=168),
    limit: int = Query(240, ge=1, le=1000),
):
    if vm_id not in VM_META:
        raise HTTPException(404, detail={"code": "VM_NOT_FOUND", "message": "unknown VM"})
    try:
        rows = await vm_store.get_history(vm_id, hours=hours, limit=limit)
    except Exception as exc:
        raise _guard(exc) from exc
    return _ok({"vm": vm_id, "hours": hours, "points": rows})


# ---------------------------------------------------------------------------
# agent ingestion + remediation
# ---------------------------------------------------------------------------

@router.post("/heartbeat")
async def vm_heartbeat(body: AgentHeartbeat, agent_vm: str = Depends(require_agent)):
    if body.vm_id != agent_vm:
        raise HTTPException(403, detail={"code": "AGENT_VM_MISMATCH", "message": "token is not valid for this VM"})
    payload = body.model_dump()
    payload["agent"] = {"version": body.agent_version}
    try:
        result = await vm_store.ingest_snapshot(
            payload, thresholds(), recovery_policy(), settings.vm_history_retention_days,
        )
    except Exception as exc:
        log.warning("heartbeat rejected for %s: %s", body.vm_id, exc)
        raise _guard(exc) from exc
    return _ok(result)


@router.post("/remediations")
async def vm_request_remediation(body: RemediationRequest, auth: dict = Depends(require_operator)):
    if not body.confirm:
        raise HTTPException(400, detail={
            "code": "CONFIRMATION_REQUIRED",
            "message": "explicit confirmation is required before any service restart",
        })
    policy = recovery_policy()
    if body.service not in policy.allowlist:
        raise HTTPException(400, detail={
            "code": "SERVICE_NOT_ALLOWLISTED",
            "message": f"{body.service} is not in the approved restart allowlist",
        })
    try:
        action, reason = await vm_store.request_remediation(body.vm_id, body.service, _actor(auth), policy)
    except Exception as exc:
        raise _guard(exc) from exc
    if action is None:
        raise HTTPException(409, detail={"code": "REMEDIATION_REFUSED", "message": reason})
    return _ok({"action": action, "message": reason})


@router.post("/remediations/{action_id}/result")
async def vm_remediation_result(
    action_id: str,
    body: RemediationResult,
    agent_vm: str = Depends(require_agent),
):
    try:
        action = await vm_store.finish_action(action_id, agent_vm, body.model_dump())
    except Exception as exc:
        raise _guard(exc) from exc
    if not action:
        raise HTTPException(404, detail={"code": "ACTION_NOT_FOUND", "message": "action not found for this VM"})
    return _ok({"action": action})
