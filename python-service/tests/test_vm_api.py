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
    assert client.get("/api/vm/vm9").status_code == 404


def test_incident_filter_validation(client):
    assert client.get("/api/vm/incidents?severity=nope").status_code == 422
    assert client.get("/api/vm/incidents?limit=0").status_code == 422


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
