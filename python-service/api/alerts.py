"""Alerts CRUD — the persisted, event-driven alert center.

Alerts are NEVER derived per-request. Every row in the ``alerts`` collection is
created by the Alert Rule Engine inside ``services/notification_center`` when a
real ledger event (``emit_event``) fires. This module only reads / manages the
lifecycle of those persisted alerts: list, filter, acknowledge, resolve, delete.

Every alert — active or resolved — expires 24 hours after it was created (TTL
index on ``expires_at``), so the center only ever reflects recent real events.
"""
from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from services import notification_center as ncenter

router = APIRouter(prefix="/api/alerts", tags=["alerts"])


class ResolveRequest(BaseModel):
    reason: str = ""


class UpdateAlertSettingsRequest(BaseModel):
    alerts_enabled: bool | None = None
    alerts_severity_threshold: str | None = None
    alerts_dedup_window_seconds: int | None = None
    alerts_recovery_enabled: bool | None = None
    alerts_desktop_notifications: bool | None = None


class DeleteManyRequest(BaseModel):
    alert_ids: list[str] = []


class DeleteAllRequest(BaseModel):
    confirm: bool = False
    status: str = ""
    category: str = ""
    severity: str = ""
    rule_id: str = ""


@router.get("")
async def get_alerts(
    status: str = "",
    severity: str = "",
    category: str = "",
    rule_id: str = "",
    search: str = "",
    symbol: str = "",
    limit: Optional[str] = Query(None),
    offset: Optional[str] = Query(None),
):
    # `limit` is optional with a safe default: an omitted parameter (which the
    # contract permits) must never 422. Clients that legitimately want only a
    # count use GET /api/alerts/summary.
    if limit is None:
        limit = 100
    else:
        limit = int(limit)
    if offset is None:
        offset = 0
    else:
        offset = int(offset)
    if status and status not in {"active", "acknowledged", "resolved"}:
        raise HTTPException(400, "status must be active|acknowledged|resolved")
    if severity and severity not in {"info", "success", "warning", "error", "critical"}:
        raise HTTPException(400, "invalid severity")
    return await ncenter.list_alerts(
        status=status, severity=severity, category=category, rule_id=rule_id,
        search=search, symbol=symbol, limit=limit, offset=offset,
    )


@router.get("/summary")
async def get_summary():
    # ``alert_summary`` already computes the active count in its single
    # aggregation; re-counting it here doubled the round trips. The unread
    # notification count is an independent collection, so run it concurrently.
    data, unread = await asyncio.gather(
        ncenter.alert_summary(),
        ncenter._notify_count(),
    )
    data["activeCount"] = data.get("active", 0)
    data["unreadCount"] = unread
    return data


@router.get("/rules")
async def get_rules():
    return {"rules": await ncenter.alert_rules_list()}


@router.get("/engine-reporter")
async def get_engine_reporter():
    """Self-reporting watcher diagnostics.

    Exists so the "did it actually fire, and what did it decide to stay quiet
    about?" question is answerable without reading logs: ``scans`` counts polls,
    ``emitted`` counts reports raised, and the gap between them is the repeat
    suppression working.
    """
    try:
        from services.engine_alert_reporter import engine_alert_reporter
        return {"ok": True, "reporter": engine_alert_reporter.status()}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "reporter": None}


@router.post("/rules/{rule_id}/enabled")
async def set_rule_enabled(rule_id: str, payload: dict):
    enabled = bool(payload.get("enabled"))
    if ncenter.get_rule(rule_id) is None:
        raise HTTPException(404, "Unknown alert rule")
    ok = await ncenter.set_rule_enabled(rule_id, enabled)
    return {"ok": ok, "ruleId": rule_id, "enabled": enabled}


@router.get("/settings")
async def get_settings():
    return {"settings": await ncenter.get_alert_settings()}


@router.patch("/settings")
async def update_settings(req: UpdateAlertSettingsRequest):
    if (req.alerts_severity_threshold is not None
            and req.alerts_severity_threshold not in {"all", "warning", "error", "critical"}):
        raise HTTPException(400, "alerts_severity_threshold must be all|warning|error|critical")
    payload = req.model_dump(exclude_none=True)
    return {"settings": await ncenter.update_alert_settings(payload)}


@router.post("/delete-many")
async def delete_many(req: DeleteManyRequest):
    if not req.alert_ids:
        raise HTTPException(400, "alert_ids must not be empty")
    deleted = await ncenter.delete_alerts_many(req.alert_ids)
    return {"ok": True, "deleted": deleted}


@router.post("/delete-all")
async def delete_all(req: DeleteAllRequest):
    if not req.confirm:
        raise HTTPException(400, "confirmation required (confirm=true)")
    deleted = await ncenter.delete_all_alerts(
        confirm=True,
        status=req.status, category=req.category,
        severity=req.severity, rule_id=req.rule_id,
    )
    return {"ok": True, "deleted": deleted}


@router.get("/{alert_id}")
async def get_one(alert_id: str):
    alert = await ncenter.get_alert(alert_id)
    if not alert:
        raise HTTPException(404, "Alert not found")
    return {"alert": alert}


@router.post("/{alert_id}/acknowledge")
async def acknowledge(alert_id: str):
    ok = await ncenter.acknowledge_alert(alert_id)
    if not ok:
        raise HTTPException(404, "Alert not found (or already resolved)")
    return {"ok": True, "alertId": alert_id}


@router.post("/acknowledge-all")
async def acknowledge_all():
    updated = await ncenter.acknowledge_all_alerts()
    return {"ok": True, "updated": updated}


@router.post("/{alert_id}/resolve")
async def resolve(alert_id: str, req: ResolveRequest):
    ok = await ncenter.resolve_alert(alert_id, req.reason)
    if not ok:
        raise HTTPException(404, "Alert not found (or already resolved)")
    return {"ok": True, "alertId": alert_id}


@router.delete("/{alert_id}")
async def delete(alert_id: str):
    ok = await ncenter.delete_alert(alert_id)
    if not ok:
        raise HTTPException(404, "Alert not found")
    return {"deleted": 1}


@router.delete("")
async def clear_resolved():
    deleted = await ncenter.clear_resolved_alerts()
    return {"deleted": deleted}


@router.post("/retention/run")
async def run_retention():
    return await ncenter.run_retention()