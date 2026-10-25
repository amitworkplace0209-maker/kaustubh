"""MongoDB persistence for VM monitoring.

All writes go through this module so validation, retention and incident
deduplication live in one place. The API layer never talks to collections
directly. Collections are deliberately small and indexed:

``vm_current``       one document per VM (latest accepted snapshot)
``vm_snapshots``     bounded history (TTL)
``vm_incidents``     deduplicated incidents (unique partial index while active)
``vm_events``        recent service/reboot/agent events (TTL)
``vm_remediations``  audited restart requests and results
"""
from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

from database.connection import get_db, is_mongo_connected
from services.vm_policy import (
    Finding,
    RecoveryPolicy,
    Thresholds,
    agent_state,
    can_remediate,
    evaluate_snapshot,
    parse_ts,
    stale_finding,
)

log = logging.getLogger("app.vm")

COLL_CURRENT = "vm_current"
COLL_SNAPSHOTS = "vm_snapshots"
COLL_INCIDENTS = "vm_incidents"
COLL_EVENTS = "vm_events"
COLL_ACTIONS = "vm_remediations"

_indexes_ready = False
_MAX_TEXT = 300


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _clean(value: Any, limit: int = _MAX_TEXT) -> str:
    text = str(value if value is not None else "")
    text = "".join(ch for ch in text if ch == "\n" or ch == "\t" or ord(ch) >= 32)
    return text[:limit]


def _iso(value: Any) -> str | None:
    dt = parse_ts(value)
    return dt.isoformat() if dt else None


def _public(doc: dict | None) -> dict | None:
    """Serialize a Mongo document for JSON without leaking internals."""
    if not doc:
        return None
    out: dict[str, Any] = {}
    for key, value in doc.items():
        if key == "_id":
            out["id"] = str(value)
        elif isinstance(value, ObjectIdLike):
            out[key] = str(value)
        elif isinstance(value, datetime):
            out[key] = value.isoformat()
        elif key == "expires_at":
            continue
        elif isinstance(value, dict):
            out[key] = _public(value)
        elif isinstance(value, list):
            out[key] = [_public(v) if isinstance(v, dict) else (v.isoformat() if isinstance(v, datetime) else v) for v in value]
        else:
            out[key] = value
    return out


try:  # avoid importing bson just for a type check
    from bson import ObjectId as ObjectIdLike  # type: ignore
except Exception:  # pragma: no cover - bson always ships with motor
    class ObjectIdLike:  # type: ignore
        pass


async def ensure_indexes() -> None:
    global _indexes_ready
    if _indexes_ready:
        return
    db = get_db()
    await db[COLL_SNAPSHOTS].create_index([("vm_id", 1), ("collected_at", -1)])
    await db[COLL_SNAPSHOTS].create_index([("vm_id", 1), ("seq", 1)], unique=True, name="uniq_vm_seq")
    await db[COLL_SNAPSHOTS].create_index("expires_at", expireAfterSeconds=0, name="ttl_snapshots")
    await db[COLL_CURRENT].create_index("vm_id", unique=True)
    await db[COLL_INCIDENTS].create_index(
        [("vm_id", 1), ("dedupe_key", 1), ("active", 1)], unique=True,
        partialFilterExpression={"active": True}, name="uniq_active_incident",
    )
    await db[COLL_INCIDENTS].create_index([("vm_id", 1), ("status", 1), ("last_seen", -1)])
    await db[COLL_INCIDENTS].create_index([("severity", 1), ("last_seen", -1)])
    await db[COLL_EVENTS].create_index([("vm_id", 1), ("ts", -1)])
    await db[COLL_EVENTS].create_index("expires_at", expireAfterSeconds=0, name="ttl_events")
    await db[COLL_ACTIONS].create_index([("vm_id", 1), ("requested_at", -1)])
    await db[COLL_ACTIONS].create_index([("incident_id", 1), ("requested_at", -1)])
    _indexes_ready = True


def available() -> bool:
    return is_mongo_connected()


def _require_db():
    if not is_mongo_connected():
        raise RuntimeError("MongoDB is not connected; VM telemetry is unavailable")
    return get_db()


async def ingest_snapshot(snapshot: dict, thresholds: Thresholds, policy: RecoveryPolicy, retention_days: int) -> dict:
    """Persist one agent heartbeat, evaluate policy, return the response."""
    await ensure_indexes()
    db = _require_db()
    vm_id = snapshot["vm_id"]
    now = _now()
    collected = parse_ts(snapshot.get("collected_at")) or now
    seq = int(snapshot.get("seq") or 0)

    previous = await db[COLL_CURRENT].find_one({"vm_id": vm_id})
    # Refuse to regress "current" when a queued/older heartbeat arrives late.
    accept_current = True
    if previous:
        prev_ts = parse_ts(previous.get("collected_at"))
        prev_seq = int(previous.get("seq") or 0)
        if prev_ts and (collected < prev_ts or (collected == prev_ts and seq < prev_seq)):
            accept_current = False

    history_doc = dict(snapshot)
    history_doc.update({
        "received_at": now,
        "expires_at": now + timedelta(days=max(1, retention_days)),
    })
    try:
        await db[COLL_SNAPSHOTS].update_one(
            {"vm_id": vm_id, "seq": seq},
            {"$setOnInsert": history_doc},
            upsert=True,
        )
    except Exception as exc:  # duplicate race is harmless
        log.debug("snapshot duplicate ignored vm=%s seq=%s: %s", vm_id, seq, exc)

    if accept_current:
        await db[COLL_CURRENT].replace_one(
            {"vm_id": vm_id},
            {**snapshot, "received_at": now},
            upsert=True,
        )

    # Reboot / sequence-reset events (only when we have a real previous boot id).
    if previous:
        prev_boot, boot = previous.get("boot_id"), snapshot.get("boot_id")
        if prev_boot and boot and prev_boot != boot:
            await record_event(vm_id, "info", "reboot", "Host reboot detected (boot id changed).", now)
        prev_seq = int(previous.get("seq") or 0)
        if seq and prev_seq and seq < prev_seq:
            await record_event(vm_id, "info", "agent", "Agent sequence reset (service/reinstall).", now)

    # Agent event batch (agent already limits count and dedupes locally).
    for event in snapshot.get("events") or []:
        await record_event(
            vm_id,
            _clean(event.get("severity") or "info", 16),
            _clean(event.get("source") or "agent", 40),
            _clean(event.get("message") or "", 300),
            parse_ts(event.get("ts")) or collected,
        )

    # Build the evaluation window: last ~30 snapshots (covers 10 min at 60s).
    cursor = db[COLL_SNAPSHOTS].find({"vm_id": vm_id}).sort("collected_at", -1).limit(30)
    rows = [row async for row in cursor]
    rows.reverse()

    findings = evaluate_snapshot(vm_id, snapshot, rows, thresholds, now)
    incidents = await _sync_incidents(vm_id, findings, now, thresholds)
    await _sync_stale(vm_id, now, thresholds)
    await _maybe_queue_recovery(vm_id, incidents, policy, now)

    state = agent_state(now, thresholds, now)
    return {
        "ok": True,
        "vm_id": vm_id,
        "received_at": now.isoformat(),
        "agent_state": state,
        "incidents": incidents,
        "actions": await claim_actions(vm_id),
        "next_check_seconds": 60,
    }


async def _sync_incidents(vm_id: str, findings: list[Finding], now: datetime, thresholds: Thresholds) -> list[dict]:
    db = _require_db()
    active_keys = {f.dedupe_key for f in findings}
    touched: list[dict] = []
    for finding in findings:
        key = finding.dedupe_key
        existing = await db[COLL_INCIDENTS].find_one({"vm_id": vm_id, "dedupe_key": key, "active": True})
        if existing:
            await db[COLL_INCIDENTS].update_one(
                {"_id": existing["_id"]},
                {"$set": {
                    "severity": finding.severity,
                    "title": finding.title,
                    "message": finding.message,
                    "observed": finding.observed,
                    "threshold": finding.threshold,
                    "probable_cause": finding.probable_cause,
                    "remediation": finding.remediation,
                    "service": finding.service,
                    "last_seen": now,
                    "updated_at": now,
                }, "$inc": {"occurrences": 1}},
            )
            doc = await db[COLL_INCIDENTS].find_one({"_id": existing["_id"]})
        else:
            doc = {
                "vm_id": vm_id,
                "dedupe_key": key,
                "resource": finding.resource,
                "service": finding.service,
                "severity": finding.severity,
                "status": "open",
                "active": True,
                "title": finding.title,
                "message": finding.message,
                "observed": finding.observed,
                "threshold": finding.threshold,
                "probable_cause": finding.probable_cause,
                "remediation": finding.remediation,
                "first_seen": now,
                "last_seen": now,
                "occurrences": 1,
                "acknowledged_by": None,
                "acknowledged_at": None,
                "recovery_status": "not_attempted",
                "created_at": now,
                "updated_at": now,
            }
            try:
                result = await db[COLL_INCIDENTS].insert_one(doc)
                doc["_id"] = result.inserted_id
            except Exception:
                # Another concurrent request won the unique-key race.
                doc = await db[COLL_INCIDENTS].find_one({"vm_id": vm_id, "dedupe_key": key, "active": True})
        if doc:
            touched.append(_public(doc) or {})

    # Anything active that is no longer true has recovered.
    stale_cursor = db[COLL_INCIDENTS].find({"vm_id": vm_id, "active": True})
    async for doc in stale_cursor:
        if doc.get("dedupe_key") in active_keys:
            continue
        if doc.get("resource") == "agent":
            continue  # handled by _sync_stale
        await db[COLL_INCIDENTS].update_one(
            {"_id": doc["_id"]},
            {"$set": {
                "status": "resolved",
                "active": False,
                "resolved_at": now,
                "updated_at": now,
                "recovery_status": "recovered",
                "resolution": "condition cleared on a later heartbeat",
            }},
        )
        await record_event(vm_id, "success", "recovery", f"Recovered: {doc.get('title')}", now)
    return touched


async def _sync_stale(vm_id: str, now: datetime, thresholds: Thresholds) -> None:
    db = _require_db()
    current = await db[COLL_CURRENT].find_one({"vm_id": vm_id})
    last_seen = parse_ts(current.get("received_at")) if current else None
    finding = stale_finding(vm_id, last_seen, thresholds, now)
    existing = await db[COLL_INCIDENTS].find_one({"vm_id": vm_id, "resource": "agent", "active": True})
    if finding:
        if existing:
            await db[COLL_INCIDENTS].update_one(
                {"_id": existing["_id"]},
                {"$set": {
                    "severity": finding.severity, "title": finding.title,
                    "message": finding.message, "observed": finding.observed,
                    "last_seen": now, "updated_at": now,
                }, "$inc": {"occurrences": 1}},
            )
        else:
            doc = {
                "vm_id": vm_id, "dedupe_key": "agent", "resource": "agent", "service": None,
                "severity": finding.severity, "status": "open", "active": True,
                "title": finding.title, "message": finding.message,
                "observed": finding.observed, "threshold": finding.threshold,
                "probable_cause": finding.probable_cause, "remediation": finding.remediation,
                "first_seen": now, "last_seen": now, "occurrences": 1,
                "acknowledged_by": None, "acknowledged_at": None,
                "recovery_status": "not_attempted", "created_at": now, "updated_at": now,
            }
            try:
                await db[COLL_INCIDENTS].insert_one(doc)
            except Exception:
                pass
    elif existing:
        await db[COLL_INCIDENTS].update_one(
            {"_id": existing["_id"]},
            {"$set": {
                "status": "resolved", "active": False, "resolved_at": now,
                "updated_at": now, "recovery_status": "recovered",
                "resolution": "agent heartbeat resumed",
            }},
        )


async def _maybe_queue_recovery(vm_id: str, incidents: list[dict], policy: RecoveryPolicy, now: datetime) -> None:
    if not policy.enabled:
        return
    db = _require_db()
    for incident in incidents:
        if incident.get("resource") != "service:%s" % (incident.get("service") or ""):
            continue
        service = incident.get("service")
        if not service or service not in policy.allowlist:
            continue
        if incident.get("severity") != "critical" or incident.get("status") == "resolved":
            continue
        pending = await db[COLL_ACTIONS].count_documents({
            "vm_id": vm_id, "incident_id": incident.get("id"),
            "status": {"$in": ["pending", "queued", "running"]},
        })
        if pending:
            continue
        cursor = db[COLL_ACTIONS].find({"service": service}).sort("requested_at", -1).limit(10)
        actions = [a async for a in cursor]
        allowed, reason = can_remediate(
            incident=incident, actions=actions, service=service, policy=policy, now=now,
        )
        if not allowed:
            continue
        await db[COLL_ACTIONS].insert_one({
            "vm_id": vm_id, "incident_id": incident.get("id"), "service": service,
            "action": "restart_service", "trigger": "automatic", "requested_by": "policy",
            "requested_at": now, "status": "pending", "reason": reason,
            "created_at": now,
        })
        await record_event(vm_id, "warning", "recovery", f"Restart queued for {service} (automatic, confirmed failure).", now)


async def claim_actions(vm_id: str) -> list[dict]:
    """Hand at most one approved action to the agent, marking it queued."""
    db = _require_db()
    now = _now()
    # Expire anything the agent never claimed (API restart / agent offline).
    await db[COLL_ACTIONS].update_many(
        {"vm_id": vm_id, "status": "queued", "claimed_at": {"$lt": now - timedelta(minutes=10)}},
        {"$set": {"status": "failed", "finished_at": now, "result": "agent did not report a result within 10 minutes"}},
    )
    doc = await db[COLL_ACTIONS].find_one(
        {"vm_id": vm_id, "status": "pending"},
        sort=[("requested_at", 1)],
    )
    if not doc:
        return []
    await db[COLL_ACTIONS].update_one(
        {"_id": doc["_id"], "status": "pending"},
        {"$set": {"status": "queued", "claimed_at": now}},
    )
    doc = await db[COLL_ACTIONS].find_one({"_id": doc["_id"]})
    return [_public(doc) or {}] if doc else []


async def finish_action(action_id: str, vm_id: str, body: dict) -> dict | None:
    await ensure_indexes()
    db = _require_db()
    now = _now()
    try:
        oid = ObjectIdLike(action_id)
    except Exception:
        return None
    doc = await db[COLL_ACTIONS].find_one({"_id": oid, "vm_id": vm_id})
    if not doc:
        return None
    if doc.get("status") not in {"queued", "running", "pending"}:
        return _public(doc)
    result = _clean(body.get("result") or "", 1000)
    success = bool(body.get("success"))
    await db[COLL_ACTIONS].update_one(
        {"_id": oid},
        {"$set": {
            "status": "succeeded" if success else "failed",
            "finished_at": now,
            "result": result,
            "verified": bool(body.get("verified")),
            "duration_ms": int(body.get("duration_ms") or 0),
        }},
    )
    if doc.get("incident_id"):
        try:
            inc_oid = ObjectIdLike(str(doc["incident_id"]))
            await db[COLL_INCIDENTS].update_one(
                {"_id": inc_oid},
                {"$set": {
                    "recovery_status": "restart_succeeded" if success else "restart_failed",
                    "recovery_result": result,
                    "updated_at": now,
                }},
            )
        except Exception:
            pass
    await record_event(
        vm_id, "success" if success else "error", "recovery",
        f"Restart of {doc.get('service')} {'succeeded' if success else 'FAILED'}: {result}", now,
    )
    return _public(await db[COLL_ACTIONS].find_one({"_id": oid}))


async def request_remediation(vm_id: str, service: str, actor: str, policy: RecoveryPolicy) -> tuple[dict | None, str]:
    await ensure_indexes()
    db = _require_db()
    now = _now()
    if service not in policy.allowlist:
        return None, f"{service} is not in the approved restart allowlist"
    incident = await db[COLL_INCIDENTS].find_one({
        "vm_id": vm_id, "active": True, "resource": f"service:{service}",
    })
    if not incident:
        return None, "no active service incident for this host/service"
    pending = await db[COLL_ACTIONS].find_one({
        "vm_id": vm_id, "service": service,
        "status": {"$in": ["pending", "queued", "running"]},
    })
    if pending:
        return _public(pending), "an action for this service is already queued"
    cursor = db[COLL_ACTIONS].find({"service": service}).sort("requested_at", -1).limit(10)
    actions = [a async for a in cursor]
    allowed, reason = can_remediate(
        incident=_public(incident) or {}, actions=actions, service=service, policy=policy, now=now,
    )
    if not allowed:
        return None, reason
    doc = {
        "vm_id": vm_id, "incident_id": str(incident["_id"]), "service": service,
        "action": "restart_service", "trigger": "manual", "requested_by": _clean(actor, 80),
        "requested_at": now, "status": "pending", "reason": "operator confirmed",
        "created_at": now,
    }
    result = await db[COLL_ACTIONS].insert_one(doc)
    doc["_id"] = result.inserted_id
    await record_event(vm_id, "warning", "recovery", f"Restart requested for {service} by {actor}.", now)
    return _public(doc), "queued"


async def record_event(vm_id: str, severity: str, source: str, message: str, ts: datetime | None = None, retention_days: int = 30) -> None:
    if not message:
        return
    db = _require_db()
    ts = ts or _now()
    digest = hashlib.sha256(f"{vm_id}|{source}|{ts.isoformat()}|{message}".encode("utf-8")).hexdigest()[:32]
    await db[COLL_EVENTS].update_one(
        {"fingerprint": digest},
        {"$setOnInsert": {
            "vm_id": vm_id, "ts": ts, "severity": _clean(severity, 16),
            "source": _clean(source, 40), "message": _clean(message, 500),
            "fingerprint": digest,
            "expires_at": ts + timedelta(days=max(1, retention_days)),
        }},
        upsert=True,
    )


async def get_current(vm_id: str) -> dict | None:
    db = _require_db()
    return _public(await db[COLL_CURRENT].find_one({"vm_id": vm_id}))


async def refresh_staleness(vm_id: str, thresholds: Thresholds) -> None:
    """Public wrapper used by read endpoints (keeps stale incidents current)."""
    await ensure_indexes()
    await _sync_stale(vm_id, _now(), thresholds)


async def incidents_for_vm(vm_id: str, limit: int = 80) -> list[dict]:
    await ensure_indexes()
    db = _require_db()
    cursor = db[COLL_INCIDENTS].find({"vm_id": vm_id}).sort("last_seen", -1).limit(max(1, min(limit, 300)))
    return [_public(d) async for d in cursor]


async def get_history(vm_id: str, hours: float = 6, limit: int = 240) -> list[dict]:
    db = _require_db()
    since = _now() - timedelta(hours=max(0.1, min(hours, 168)))
    cursor = db[COLL_SNAPSHOTS].find({"vm_id": vm_id, "collected_at": {"$gte": since}}).sort("collected_at", -1).limit(max(1, min(limit, 1000)))
    rows = [row async for row in cursor]
    rows.reverse()
    return [_public(row) or {} for row in rows]


async def overview(thresholds: Thresholds) -> dict:
    await ensure_indexes()
    db = _require_db()
    now = _now()
    hosts = []
    for vm_id in ("vm1", "vm2"):
        await _sync_stale(vm_id, now, thresholds)
        current = await db[COLL_CURRENT].find_one({"vm_id": vm_id})
        last_seen = parse_ts(current.get("received_at")) if current else None
        state = agent_state(last_seen, thresholds, now)
        open_cursor = db[COLL_INCIDENTS].find({"vm_id": vm_id, "active": True})
        incidents = [d async for d in open_cursor]
        recent_cursor = db[COLL_EVENTS].find({"vm_id": vm_id}).sort("ts", -1).limit(5)
        events = [d async for d in recent_cursor]
        hosts.append({
            "vm": vm_id,
            "agent_state": state,
            "last_seen": _iso(last_seen),
            "snapshot": _public(current),
            "incidents": [_public(i) for i in incidents],
            "recent_events": [_public(e) for e in events],
        })
    applies = db[COLL_ACTIONS].find({"status": {"$in": ["pending", "queued", "running"]}})
    pending = [_public(a) for a in [x async for x in applies]]
    return {"hosts": hosts, "pending_actions": pending, "generated_at": now.isoformat()}


async def list_incidents(
    *, vm_id: str = "", severity: str = "", status: str = "", service: str = "",
    resource: str = "", start: str = "", end: str = "", limit: int = 100, offset: int = 0,
) -> dict:
    await ensure_indexes()
    db = _require_db()
    query: dict[str, Any] = {}
    if vm_id:
        query["vm_id"] = vm_id
    if severity:
        query["severity"] = severity
    if status:
        query["status"] = status
    else:
        query["active"] = True
    if service:
        query["service"] = service
    if resource:
        query["resource"] = resource
    if start or end:
        window: dict[str, Any] = {}
        if start:
            window["$gte"] = parse_ts(start)
        if end:
            window["$lte"] = parse_ts(end)
        query["last_seen"] = window
    total = await db[COLL_INCIDENTS].count_documents(query)
    cursor = db[COLL_INCIDENTS].find(query).sort("last_seen", -1).skip(max(0, offset)).limit(max(1, min(limit, 500)))
    rows = [_public(d) async for d in cursor]
    return {"incidents": rows, "total": total, "limit": limit, "offset": offset}


async def get_incident(incident_id: str) -> dict | None:
    db = _require_db()
    try:
        oid = ObjectIdLike(incident_id)
    except Exception:
        return None
    return _public(await db[COLL_INCIDENTS].find_one({"_id": oid}))


async def update_incident(incident_id: str, *, actor: str, action: str, reason: str = "") -> dict | None:
    db = _require_db()
    try:
        oid = ObjectIdLike(incident_id)
    except Exception:
        return None
    doc = await db[COLL_INCIDENTS].find_one({"_id": oid})
    if not doc:
        return None
    now = _now()
    if action == "acknowledge":
        update = {
            "status": "acknowledged" if doc.get("status") == "open" else doc.get("status"),
            "acknowledged_by": _clean(actor, 80), "acknowledged_at": now, "updated_at": now,
        }
    elif action == "resolve":
        update = {
            "status": "resolved", "active": False, "resolved_at": now, "updated_at": now,
            "resolved_by": _clean(actor, 80),
            "resolution": _clean(reason or "resolved by operator", 300),
            "recovery_status": "manually_resolved",
        }
    else:
        return None
    await db[COLL_INCIDENTS].update_one({"_id": oid}, {"$set": update})
    await record_event(doc["vm_id"], "info", "incident", f"Incident {action}d by {actor}: {doc.get('title')}", now)
    return _public(await db[COLL_INCIDENTS].find_one({"_id": oid}))


async def list_events(vm_id: str = "", severity: str = "", limit: int = 100, before: str = "") -> dict:
    await ensure_indexes()
    db = _require_db()
    query: dict[str, Any] = {}
    if vm_id:
        query["vm_id"] = vm_id
    if severity:
        query["severity"] = severity
    before_dt = parse_ts(before) if before else None
    if before_dt:
        query["ts"] = {"$lt": before_dt}
    cursor = db[COLL_EVENTS].find(query).sort("ts", -1).limit(max(1, min(limit, 300)))
    rows = [_public(d) async for d in cursor]
    return {"events": rows, "limit": limit}


async def list_actions(vm_id: str = "", limit: int = 50) -> dict:
    await ensure_indexes()
    db = _require_db()
    query = {"vm_id": vm_id} if vm_id else {}
    cursor = db[COLL_ACTIONS].find(query).sort("requested_at", -1).limit(max(1, min(limit, 200)))
    rows = [_public(d) async for d in cursor]
    return {"actions": rows}


async def agent_status(thresholds: Thresholds) -> list[dict]:
    db = _require_db()
    now = _now()
    out = []
    for vm_id in ("vm1", "vm2"):
        current = await db[COLL_CURRENT].find_one({"vm_id": vm_id})
        last_seen = parse_ts(current.get("received_at")) if current else None
        out.append({
            "vm": vm_id,
            "state": agent_state(last_seen, thresholds, now),
            "last_seen": _iso(last_seen),
            "age_seconds": int((now - last_seen).total_seconds()) if last_seen else None,
        })
    return out
