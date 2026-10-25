"""VM API tests — agent auth, operator auth, validation and remediation gates.

The store is monkeypatched in the happy paths: these tests prove the HTTP
contract and authorization rules without requiring MongoDB or the VMs.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from api import vm_management  # noqa: E402
from config.settings import settings  # noqa: E402
from fastapi.routing import APIRoute  # noqa: E402
from services.jwt_auth import issue_token  # noqa: E402

VM1_TOKEN = "test-agent-token-vm1-0123456789abcdef"
VM2_TOKEN = "test-agent-token-vm2-0123456789abcdef"


@pytest.fixture(autouse=True)
def agent_tokens(monkeypatch):
    monkeypatch.setattr(settings, "vm_agent_token_vm1", VM1_TOKEN)
    monkeypatch.setattr(settings, "vm_agent_token_vm2", VM2_TOKEN)


@pytest.fixture()
def client():
    app = FastAPI()
    app.include_router(vm_management.router)
    return TestClient(app)


def heartbeat_body(vm: str = "vm1") -> dict:
    return {
        "vm_id": vm,
        "seq": 42,
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "boot_id": "boot-abc",
        "uptime_seconds": 1000,
        "agent_version": "1.0.0",
        "metrics": {
            "cpu_pct": 12.5, "load1": 0.2, "load5": 0.1, "load15": 0.05,
            "mem_total_mb": 954, "mem_available_mb": 500, "mem_available_pct": 52.4,
            "swap_total_mb": 2047, "swap_used_mb": 0, "swap_used_pct": 0,
            "disk_total_gb": 45, "disk_used_gb": 5.2, "disk_used_pct": 12,
            "inode_total": 5980160, "inode_used": 131083, "inode_used_pct": 3,
            "boot_time": "2026-10-19T15:00:00Z",
        },
        "services": [
            {"name": "kds-backend", "exists": False, "active": "", "sub": "", "restarts": None},
        ],
        "failed_units": [],
        "checks": {
            "backend_health": {"configured": False},
            "mongo_tcp": {"configured": True, "ok": True, "target": "10.1.2.178:27017", "latency_ms": 2},
        },
        "events": [],
    }


def agent_headers(vm: str = "vm1", token: str = VM1_TOKEN) -> dict:
    return {"X-KDS-Agent-VM": vm, "X-KDS-Agent-Token": token}


def operator_headers(username: str | None = None) -> dict:
    token = issue_token(username or settings.app_username or "kaustubh")
    return {"Authorization": f"Bearer {token}"}


# Every human-facing read. The direct Python port must reject all of these
# without a valid operator JWT — a reachable port is not an authorisation.
READ_PATHS = [
    "/api/vm/overview",
    "/api/vm/agents",
    "/api/vm/incidents",
    "/api/vm/incidents/507f1f77bcf86cd799439011",
    "/api/vm/events",
    "/api/vm/remediations",
    "/api/vm/vm1",
    "/api/vm/vm1/history",
]


def test_agent_headers_required(client):
    assert client.post("/api/vm/heartbeat", json=heartbeat_body()).status_code == 422


def test_unconfigured_agent_token_fails_closed(client, monkeypatch):
    monkeypatch.setattr(settings, "vm_agent_token_vm1", "")
    res = client.post("/api/vm/heartbeat", json=heartbeat_body(), headers=agent_headers())
    assert res.status_code == 503
    assert res.json()["detail"]["code"] == "AGENT_TOKEN_NOT_CONFIGURED"


def test_wrong_agent_token_rejected(client):
    res = client.post("/api/vm/heartbeat", json=heartbeat_body(), headers=agent_headers(token="wrong"))
    assert res.status_code == 401


def test_agent_token_cannot_post_as_another_vm(client):
    res = client.post("/api/vm/heartbeat", json=heartbeat_body("vm2"), headers=agent_headers("vm1"))
    assert res.status_code == 403
    assert res.json()["detail"]["code"] == "AGENT_VM_MISMATCH"


def test_valid_heartbeat_is_accepted(client, monkeypatch):
    captured = {}

    async def fake_ingest(snapshot, thresholds, policy, retention_days):
        captured["snapshot"] = snapshot
        return {"ok": True, "vm_id": snapshot["vm_id"], "agent_state": "CONNECTED", "actions": []}

    monkeypatch.setattr(vm_management.vm_store, "ingest_snapshot", fake_ingest)
    res = client.post("/api/vm/heartbeat", json=heartbeat_body(), headers=agent_headers())
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["ok"] is True and body["data"]["vm_id"] == "vm1"
    assert captured["snapshot"]["vm_id"] == "vm1"
    # Raw token is never echoed or stored.
    assert VM1_TOKEN not in res.text


def test_heartbeat_validation_rejects_impossible_metrics(client):
    body = heartbeat_body()
    body["metrics"]["cpu_pct"] = 150
    res = client.post("/api/vm/heartbeat", json=body, headers=agent_headers())
    assert res.status_code == 422


def test_heartbeat_rejects_future_clock(client):
    body = heartbeat_body()
    body["collected_at"] = "2099-01-01T00:00:00Z"
    res = client.post("/api/vm/heartbeat", json=body, headers=agent_headers())
    assert res.status_code == 422


def test_operator_endpoints_require_jwt(client):
    res = client.post("/api/vm/incidents/507f1f77bcf86cd799439011/acknowledge", json={"reason": "x"})
    assert res.status_code == 401
    res = client.post(
        "/api/vm/incidents/507f1f77bcf86cd799439011/acknowledge",
        json={"reason": "x"}, headers={"Authorization": "Bearer not-a-jwt"},
    )
    assert res.status_code == 401


def test_operator_acknowledge_happy_path(client, monkeypatch):
    async def fake_update(incident_id, *, actor, action, reason=""):
        return {"id": incident_id, "status": "acknowledged", "acknowledged_by": actor}

    monkeypatch.setattr(vm_management.vm_store, "update_incident", fake_update)
    token = issue_token(settings.app_username or "kaustubh")
    res = client.post(
        "/api/vm/incidents/507f1f77bcf86cd799439011/acknowledge",
        json={"reason": "investigating"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["data"]["acknowledged_by"] == (settings.app_username or "kaustubh")


def test_unknown_vm_detail_404(client):
    assert client.get("/api/vm/vm9", headers=operator_headers()).status_code == 404


def test_incident_filter_validation(client):
    assert client.get("/api/vm/incidents?severity=nope", headers=operator_headers()).status_code == 422
    assert client.get("/api/vm/incidents?limit=0", headers=operator_headers()).status_code == 422


# ---------------------------------------------------------------------------
# read authorisation — the reported direct-port gap
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("path", READ_PATHS)
def test_read_endpoints_require_operator_jwt(client, path):
    res = client.get(path)
    assert res.status_code == 401, f"{path} leaked without a credential"
    body = res.json()
    assert body["detail"]["code"] == "OPERATOR_JWT_REQUIRED"
    assert "data" not in body


@pytest.mark.parametrize("path", READ_PATHS)
def test_read_endpoints_reject_agent_credentials(client, path):
    # A valid agent token proves the caller is a VM, not an operator.
    res = client.get(path, headers=agent_headers())
    assert res.status_code == 401, f"{path} accepted agent credentials"
    assert VM1_TOKEN not in res.text


def test_read_endpoints_reject_forged_jwt(client):
    res = client.get("/api/vm/overview", headers={"Authorization": "Bearer nope.nope.nope"})
    assert res.status_code == 401
    assert res.json()["detail"]["code"] == "INVALID_OPERATOR_JWT"


def test_read_endpoints_reject_non_owner_jwt(client):
    # Correctly signed, but not the single owner account and no admin role.
    res = client.get("/api/vm/overview", headers=operator_headers("someone-else"))
    assert res.status_code == 403
    assert res.json()["detail"]["code"] == "FORBIDDEN"
    assert "data" not in res.json()


def test_owner_can_read_overview(client, monkeypatch):
    async def fake_overview(_thresholds):
        return {"hosts": [], "pending_actions": [], "generated_at": None}

    monkeypatch.setattr(vm_management.vm_store, "overview", fake_overview)
    res = client.get("/api/vm/overview", headers=operator_headers())
    assert res.status_code == 200, res.text
    data = res.json()["data"]
    # No hosts means no proof of life: DISCONNECTED, never a green default.
    assert data["overall"] == "DISCONNECTED"
    assert data["connected_agents"] == 0


def test_owner_can_read_vm_detail_honestly(client, monkeypatch):
    async def refresh(_vm, _th):
        return None

    async def empty(*_args, **_kwargs):
        return []

    async def no_current(_vm):
        return None

    async def no_events(**_kwargs):
        return {"events": []}

    async def no_actions(**_kwargs):
        return {"actions": []}

    monkeypatch.setattr(vm_management.vm_store, "refresh_staleness", refresh)
    monkeypatch.setattr(vm_management.vm_store, "get_current", no_current)
    monkeypatch.setattr(vm_management.vm_store, "get_history", empty)
    monkeypatch.setattr(vm_management.vm_store, "incidents_for_vm", empty)
    monkeypatch.setattr(vm_management.vm_store, "list_events", no_events)
    monkeypatch.setattr(vm_management.vm_store, "list_actions", no_actions)

    res = client.get("/api/vm/vm1", headers=operator_headers())
    assert res.status_code == 200, res.text
    data = res.json()["data"]
    assert data["snapshot"] is None
    assert data["agent_state"] == "NEVER_CONNECTED"
    assert data["history"] == []


def test_operator_jwt_is_not_an_agent_credential(client):
    # The two credential families are separate: a valid operator JWT cannot
    # submit telemetry, because heartbeat requires the agent headers.
    res = client.post("/api/vm/heartbeat", json=heartbeat_body(), headers=operator_headers())
    assert res.status_code == 422
    assert str(res.json()["detail"][0]["loc"][-1]).lower() == "x-kds-agent-vm"

    # ... and it cannot report a remediation result either.
    res = client.post(
        "/api/vm/remediations/act1/result",
        json={"success": True},
        headers=operator_headers(),
    )
    assert res.status_code == 422


def test_remediation_result_requires_agent_headers(client):
    res = client.post("/api/vm/remediations/act1/result", json={"success": True})
    assert res.status_code == 422


def _dependency_names(route: APIRoute) -> set[str]:
    names: set[str] = set()
    stack = [route.dependant]
    while stack:
        dependant = stack.pop()
        if dependant.call is not None:
            names.add(dependant.call.__name__)
        stack.extend(dependant.dependencies)
    return names


def test_every_vm_route_requires_operator_or_agent_auth():
    """Guard against a future route shipping without an auth dependency."""
    routes = [r for r in vm_management.router.routes if isinstance(r, APIRoute)]
    assert len(routes) == 13, [r.path for r in routes]
    for route in routes:
        auth = _dependency_names(route) & {"require_agent", "require_operator"}
        assert auth, f"{sorted(route.methods)} {route.path} has no auth dependency"


def test_remediation_requires_confirmation(client):
    token = issue_token(settings.app_username or "kaustubh")
    res = client.post(
        "/api/vm/remediations",
        json={"vm_id": "vm2", "service": "mongod", "confirm": False},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 400
    assert res.json()["detail"]["code"] == "CONFIRMATION_REQUIRED"


def test_remediation_allowlist_enforced(client):
    token = issue_token(settings.app_username or "kaustubh")
    res = client.post(
        "/api/vm/remediations",
        json={"vm_id": "vm2", "service": "sshd", "confirm": True},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 400
    assert res.json()["detail"]["code"] == "SERVICE_NOT_ALLOWLISTED"


def test_remediation_queued_for_allowlisted_service(client, monkeypatch):
    async def fake_request(vm_id, service, actor, policy):
        return {"id": "act1", "vm_id": vm_id, "service": service, "status": "pending"}, "queued"

    monkeypatch.setattr(vm_management.vm_store, "request_remediation", fake_request)
    token = issue_token(settings.app_username or "kaustubh")
    res = client.post(
        "/api/vm/remediations",
        json={"vm_id": "vm2", "service": "mongod", "confirm": True},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["data"]["action"]["status"] == "pending"
