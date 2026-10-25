"""Agent delivery-loop tests.

The agent is stdlib-only and lives outside ``python-service``; it is loaded by
path. These tests pin the behaviour that keeps a minute-timer run short while a
backend is unreachable: stop after the first network failure, never spend a
second timeout on the live sample, and keep the queue bounded.
"""
from __future__ import annotations

import importlib.util
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_AGENT_PATH = _REPO / "agents" / "kds_vm_agent.py"

_spec = importlib.util.spec_from_file_location("kds_vm_agent_delivery_test", _AGENT_PATH)
assert _spec and _spec.loader
agent = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = agent
_spec.loader.exec_module(agent)


def _snapshot(seq: int) -> dict:
    return {
        "vm_id": "vm2",
        "seq": seq,
        "collected_at": (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat(),
        "events": [],
        "metrics": {},
        "services": [],
        "failed_units": [],
        "checks": {},
    }


@pytest.fixture()
def harness(monkeypatch):
    """Replace every I/O boundary of run_once; capture POSTs and saved state."""
    calls: list[dict] = []
    saved: dict = {}
    config = {
        "vm_id": "vm2",
        "api_url": "http://10.1.1.133:8000",
        "token_file": "/etc/kds/agent-token",
        "state_file": "/var/lib/kds-agent/state.json",
    }

    monkeypatch.setattr(agent, "load_config", lambda _path: dict(config))
    monkeypatch.setattr(agent, "load_token", lambda _cfg: "t" * 48)
    monkeypatch.setattr(agent, "load_state", lambda _path: {"seq": 0})
    monkeypatch.setattr(agent, "save_state", lambda _path, state: saved.update(state))
    monkeypatch.setattr(agent, "handle_actions", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        agent, "collect",
        lambda _cfg, state: _snapshot(int(state.get("seq") or 0) + 1),
    )
    monkeypatch.setattr(agent, "post_json", lambda *_args, **_kwargs: (0, {"error": "not stubbed"}))

    class Harness:
        pass

    result = Harness()
    result.calls = calls
    result.saved = saved
    return result


def _record(harness, status: int):
    def fake_post(url, body, headers, timeout=15):
        harness.calls.append({"url": url, "body": body})
        return status, {"data": {"actions": []}}

    return fake_post


def test_network_failure_short_circuits_and_keeps_queue_bounded(harness, monkeypatch):
    monkeypatch.setattr(agent, "load_state", lambda _path: {
        "seq": 0, "queue": [_snapshot(i) for i in range(1, 6)],
    })
    monkeypatch.setattr(agent, "post_json", _record(harness, 0))

    code = agent.run_once("/tmp/does-not-exist.json")

    assert code == 1
    # One queued attempt, then the live sample is queued without a second wait.
    assert len(harness.calls) == 1
    assert len(harness.saved["queue"]) == agent.MAX_QUEUE


def test_success_drains_queue_and_delivers_live_sample(harness, monkeypatch):
    monkeypatch.setattr(agent, "load_state", lambda _path: {
        "seq": 0, "queue": [_snapshot(1), _snapshot(2)],
    })
    monkeypatch.setattr(agent, "post_json", _record(harness, 200))

    code = agent.run_once("/tmp/does-not-exist.json")

    assert code == 0
    assert len(harness.calls) == 3  # two queued + current
    assert harness.saved["queue"] == []


def test_auth_failure_stops_the_flush_instead_of_retrying_every_sample(harness, monkeypatch):
    monkeypatch.setattr(agent, "load_state", lambda _path: {
        "seq": 0, "queue": [_snapshot(1), _snapshot(2)],
    })
    monkeypatch.setattr(agent, "post_json", _record(harness, 401))

    code = agent.run_once("/tmp/does-not-exist.json")

    assert code == 1
    # First queued sample gets 401, then the live sample is attempted once.
    assert len(harness.calls) == 2
    assert len(harness.saved["queue"]) == 3
