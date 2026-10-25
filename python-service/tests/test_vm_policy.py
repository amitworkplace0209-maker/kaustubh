"""VM monitoring policy tests — thresholds, dedupe, staleness, recovery limits.

These are pure-logic tests: no MongoDB, no FastAPI, no VM access. The values
below are synthetic *test fixtures* used to prove the evaluator; the running
product never substitutes them for real telemetry.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from services.vm_policy import (  # noqa: E402
    RecoveryPolicy,
    Thresholds,
    agent_state,
    can_remediate,
    evaluate_snapshot,
    stale_finding,
)

NOW = datetime(2026, 10, 25, 12, 0, tzinfo=timezone.utc)
TH = Thresholds()


def snap(minutes_ago: float, *, cpu: float = 5.0, avail_pct: float = 50.0,
         disk: float = 20.0, inode: float = 10.0, swap: float = 0.0,
         services=None, checks=None, failed=None, events=None) -> dict:
    return {
        "vm_id": "vm1",
        "seq": int(minutes_ago * 100),
        "collected_at": (NOW - timedelta(minutes=minutes_ago)).isoformat(),
        "metrics": {
            "cpu_pct": cpu,
            "mem_total_mb": 954,
            "mem_available_mb": 954 * avail_pct / 100,
            "mem_available_pct": avail_pct,
            "swap_used_pct": swap,
            "disk_used_pct": disk,
            "inode_used_pct": inode,
        },
        "services": services if services is not None else [
            {"name": "kds-backend", "exists": True, "active": "active", "sub": "running", "restarts": 0},
        ],
        "failed_units": failed or [],
        "checks": checks or {},
        "events": events or [],
    }


def ids(findings) -> set[str]:
    return {f.dedupe_key for f in findings}


def test_cpu_spike_does_not_fire_but_sustained_does():
    # One high sample inside a 5 min window is NOT sustained.
    history = [snap(4), snap(2), snap(0, cpu=99)]
    assert "cpu" not in ids(evaluate_snapshot("vm1", history[-1], history, TH, NOW))

    # Six samples spanning the full 5 minutes all above 85% -> warning.
    history = [snap(m, cpu=90) for m in (5, 4, 3, 2, 1, 0)]
    findings = evaluate_snapshot("vm1", history[-1], history, TH, NOW)
    cpu = [f for f in findings if f.resource == "cpu"]
    assert len(cpu) == 1 and cpu[0].severity == "warning"
    assert cpu[0].dedupe_key == "cpu"


def test_cpu_critical_wins_over_warning():
    history = [snap(m, cpu=97) for m in (10, 8, 6, 4, 2, 0)]
    cpu = [f for f in evaluate_snapshot("vm1", history[-1], history, TH, NOW) if f.resource == "cpu"]
    assert cpu and cpu[0].severity == "critical"


def test_ram_critical_threshold_and_sustain():
    # Low for a single sample -> no finding (needs 120s span).
    history = [snap(3, avail_pct=50), snap(1, avail_pct=5), snap(0, avail_pct=5)]
    assert "memory" not in ids(evaluate_snapshot("vm1", history[-1], history, TH, NOW))

    history = [snap(m, avail_pct=5) for m in (3, 2, 1, 0)]
    mem = [f for f in evaluate_snapshot("vm1", history[-1], history, TH, NOW) if f.resource == "memory"]
    assert mem and mem[0].severity == "critical"


def test_disk_and_inode_are_instant_capacity_alerts():
    history = [snap(0, disk=91, inode=85)]
    findings = evaluate_snapshot("vm1", history[-1], history, TH, NOW)
    by = {f.resource: f for f in findings}
    assert by["disk"].severity == "critical"
    assert by["inode"].severity == "warning"
    # Stable dedupe key across severity changes (prevents duplicate incidents).
    history2 = [snap(0, disk=95, inode=95)]
    by2 = {f.resource: f for f in evaluate_snapshot("vm1", history2[-1], history2, TH, NOW)}
    assert by2["disk"].dedupe_key == by["disk"].dedupe_key == "disk"


def test_service_needs_two_consecutive_failures_for_critical():
    down = {"name": "kds-backend", "exists": True, "active": "failed", "sub": "failed", "restarts": 1}
    history = [snap(1, services=[down]), snap(0, services=[down])]
    svc = [f for f in evaluate_snapshot("vm1", history[-1], history, TH, NOW) if f.service == "kds-backend"]
    assert svc and svc[0].severity == "critical"
    assert svc[0].dedupe_key == "service:kds-backend"

    history = [snap(1, services=[{"name": "kds-backend", "exists": True, "active": "active"}]),
               snap(0, services=[down])]
    svc = [f for f in evaluate_snapshot("vm1", history[-1], history, TH, NOW) if f.service == "kds-backend"]
    assert svc and svc[0].severity == "warning"


def test_absent_service_is_unknown_not_failed():
    history = [snap(0, services=[{"name": "kds-backend", "exists": False, "active": ""}])]
    assert not [f for f in evaluate_snapshot("vm1", history[-1], history, TH, NOW) if f.service == "kds-backend"]


def test_mongo_auth_failure_never_becomes_restart_severity():
    check = {"mongo_ping": {"configured": True, "ok": False, "error_kind": "authentication", "error": "bad auth"}}
    history = [snap(m, checks=check) for m in (3, 2, 1, 0)]
    findings = evaluate_snapshot("vm2", history[-1], history, TH, NOW)
    mongo = [f for f in findings if f.resource.startswith("mongo-ping")]
    assert mongo and mongo[0].resource == "mongo-ping-auth" and mongo[0].severity == "warning"


def test_mongo_connection_failure_can_be_critical():
    check = {"mongo_ping": {"configured": True, "ok": False, "error_kind": "connection", "error": "refused"}}
    history = [snap(m, checks=check) for m in (3, 2, 1, 0)]
    mongo = [f for f in evaluate_snapshot("vm2", history[-1], history, TH, NOW) if f.resource == "mongo-ping"]
    assert mongo and mongo[0].severity == "critical"


def test_backup_stale_only_when_configured():
    checks = {"backup": {"configured": False}}
    history = [snap(0, checks=checks)]
    assert "backup" not in ids(evaluate_snapshot("vm2", history[-1], history, TH, NOW))
    checks = {"backup": {"configured": True, "ok": False, "age_hours": 40, "last_backup_at": "2026-10-23T00:00:00Z"}}
    history = [snap(0, checks=checks)]
    assert "backup" in ids(evaluate_snapshot("vm2", history[-1], history, TH, NOW))


def test_stale_and_disconnected_states():
    assert agent_state(None, TH, NOW) == "NEVER_CONNECTED"
    assert agent_state(NOW - timedelta(seconds=30), TH, NOW) == "CONNECTED"
    assert agent_state(NOW - timedelta(seconds=200), TH, NOW) == "STALE"
    assert agent_state(NOW - timedelta(seconds=700), TH, NOW) == "DISCONNECTED"
    stale = stale_finding("vm1", NOW - timedelta(seconds=200), TH, NOW)
    assert stale and stale.severity == "warning"
    gone = stale_finding("vm1", NOW - timedelta(seconds=700), TH, NOW)
    assert gone and gone.severity == "critical"
    assert stale_finding("vm1", NOW - timedelta(seconds=10), TH, NOW) is None


def _incident(**overrides):
    base = {"id": "inc1", "status": "open", "resource": "service:mongod", "service": "mongod"}
    base.update(overrides)
    return base


def _action(when: datetime, status="queued", service="mongod", incident_id="inc1", success=True):
    return {"service": service, "incident_id": incident_id, "status": status,
            "requested_at": when.isoformat(), "finished_at": when.isoformat(), "success": success}


def test_recovery_requires_allowlist_and_confirmed_service_failure():
    policy = RecoveryPolicy()
    ok, reason = can_remediate(incident=_incident(), actions=[], service="mongod", policy=policy, now=NOW)
    assert ok, reason
    ok, reason = can_remediate(incident=_incident(), actions=[], service="nginx", policy=policy, now=NOW)
    assert not ok and "allowlist" in reason
    ok, reason = can_remediate(incident=_incident(resource="disk"), actions=[], service="mongod", policy=policy, now=NOW)
    assert not ok and "confirmed service failure" in reason


def test_recovery_cooldown_and_hourly_cap():
    policy = RecoveryPolicy(cooldown_seconds=600, max_per_hour=2, max_per_incident=5)
    recent = [_action(NOW - timedelta(seconds=120))]
    ok, reason = can_remediate(incident=_incident(), actions=recent, service="mongod", policy=policy, now=NOW)
    assert not ok and "cooldown" in reason

    fresh_incident = _incident(id="inc2")
    two = [_action(NOW - timedelta(minutes=30), incident_id="old1"), _action(NOW - timedelta(minutes=20), incident_id="old2")]
    ok, reason = can_remediate(incident=fresh_incident, actions=two, service="mongod", policy=policy, now=NOW)
    assert not ok and "hourly" in reason


def test_recovery_per_incident_cap_and_failed_backoff():
    policy = RecoveryPolicy(cooldown_seconds=600, max_per_incident=2, max_per_hour=10)
    actions = [_action(NOW - timedelta(hours=3)), _action(NOW - timedelta(hours=2))]
    ok, reason = can_remediate(incident=_incident(), actions=actions, service="mongod", policy=policy, now=NOW)
    assert not ok and "limit" in reason

    policy = RecoveryPolicy(cooldown_seconds=600, max_per_incident=5, max_per_hour=10)
    failed = [_action(NOW - timedelta(minutes=15), status="failed", success=False)]
    ok, reason = can_remediate(incident=_incident(id="inc3"), actions=failed, service="mongod", policy=policy, now=NOW)
    assert not ok and "backoff" in reason
