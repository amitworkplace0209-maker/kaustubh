"""Notifications API.

The notification store is MongoDB (`notifications`). Every notification is
created through `services.notification_center` (the event-driven engine) or
`services.notification_service.notify(...)` — BOTH of which chain the row to a
real Event Ledger entry (`related_event_id`). The POST endpoint below routes
through `notify()` so even manual/test rows trace back to a real event, never a
fabricated one.

All mutations publish frames on the ONE centralized realtime channel plus the
live unread count, so the topbar and Notifications page stay in sync without
page reloads or polling.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from database.connection import get_db
from services import notification_center as center
from services.notification_center import (
    delete_all_notifications,
    delete_notification,
    delete_notifications_many,
    delete_read_notifications,
    get_notification,
    get_notification_settings,
    list_notifications,
    mark_all_notifications_read,
    mark_notification_read,
    mark_notification_unread,
    mark_notifications_many,
    notification_summary,
    update_notification_settings,
)
from services.notification_service import notify as _ledger_notify

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


class CreateNotificationRequest(BaseModel):
    category: str = "system"
    level: str = "info"
    severity: str | None = None
    title: str
    message: str
    source: str | None = None
    event_type: str | None = None
    meta: dict | None = None


class PatchNotificationRequest(BaseModel):
    read: bool | None = None
    severity: str | None = None
    title: str | None = None
    message: str | None = None


class MarkManyRequest(BaseModel):
    notification_ids: list[str] | None = None
    read: bool = True


class DeleteManyRequest(BaseModel):
    notification_ids: list[str] | None = None


def _parse_iso(value: str) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


@router.get("")
async def get_notifications(
    category: str = "",
    unread_only: str = "false",
    limit: str | None = Query(None),
    offset: str | None = Query(None),
    severity: str = "",
    source: str = "",
    search: str = "",
    status: str = "",
    event_type: str = "",
    importance: str = "",
    since: str = "",
):
    read: bool | None = None
    if unread_only.lower() == "true":
        read = False
    data = await list_notifications(
        category=category,
        status=status if status in ("unread", "read") else "",
        severity=severity,
        importance=importance,
        event_type=event_type,
        search=search,
        since=_parse_iso(since),
        limit=int(limit) if limit else 100,
        offset=int(offset) if offset else 0,
    )
    return data


@router.get("/summary")
async def get_summary():
    return await notification_summary()


@router.get("/unread-count")
async def get_unread_count():
    summary = await notification_summary()
    return {"unreadCount": summary["unread"], "live": summary["live"]}


@router.get("/settings")
async def get_settings():
    return await get_notification_settings()


@router.patch("/settings")
async def patch_settings(payload: dict):
    return await update_notification_settings(payload)


class PushSubscriptionRequest(BaseModel):
    endpoint: str
    keys: dict
    label: str = ""
    userAgent: str = ""


@router.get("/push/status")
async def push_status():
    """PWA push readiness: VAPID configured + stored subscription count."""
    from services import push_delivery as push

    subs = await push.list_subscriptions()
    return {
        "ok": True,
        "enabled": push.push_enabled(),
        "vapidPublicKey": push.vapid_public_key() or None,
        "subscriptions": len(subs),
    }


@router.get("/push/vapid-public-key")
async def push_vapid_key():
    from services import push_delivery as push

    key = push.vapid_public_key()
    if not key:
        raise HTTPException(503, "Web Push is not configured on the backend")
    return {"ok": True, "publicKey": key}


@router.post("/push/subscription")
async def push_subscribe(req: PushSubscriptionRequest):
    from services import push_delivery as push

    if not push.push_enabled():
        raise HTTPException(503, "Web Push is not configured on the backend")
    try:
        return await push.register_subscription(
            {"endpoint": req.endpoint, "keys": req.keys,
             "userAgent": req.userAgent},
            label=req.label,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.delete("/push/subscription")
async def push_unsubscribe(endpoint: str = Query("")):
    from services import push_delivery as push

    if not endpoint.strip():
        raise HTTPException(400, "endpoint is required")
    return await push.unregister_subscription(endpoint.strip())


@router.post("/push/test")
async def push_send_test():
    from services import push_delivery as push

    if not push.push_enabled():
        raise HTTPException(503, "Web Push is not configured on the backend")
    return await push.push_test()


@router.post("")
async def create_notification(req: CreateNotificationRequest):
    severity = req.severity or req.level or "info"
    if severity not in {"info", "success", "warning", "error", "critical"}:
        raise HTTPException(400, "severity must be one of info/success/warning/error/critical")
    doc = await _ledger_notify(
        category=req.category,
        severity=severity,
        title=req.title,
        message=req.message,
        source=req.source or "data-saver",
        event_type=req.event_type or "",
        metadata=req.meta,
        bypass_enabled=True,
    )
    if doc is None:
        raise HTTPException(503, "Could not create notification (store unavailable)")
    return {"data": doc}


@router.post("/mark-many")
async def mark_many(req: MarkManyRequest):
    updated = await mark_notifications_many(req.notification_ids, bool(req.read))
    return {"updated": updated}


@router.post("/delete-many")
async def delete_many(req: DeleteManyRequest):
    deleted = await delete_notifications_many(req.notification_ids)
    return {"deleted": deleted}


@router.post("/delete-read")
async def delete_read():
    deleted = await delete_read_notifications()
    return {"deleted": deleted}


@router.patch("/{item_id}")
async def patch_notification(item_id: str, req: PatchNotificationRequest):
    if req.read is not None:
        ok = await (mark_notification_read(item_id) if req.read else mark_notification_unread(item_id))
        if not ok:
            raise HTTPException(404, "Notification not found")
    if req.severity is not None or req.title is not None or req.message is not None:
        from bson import ObjectId
        db = get_db()
        update: dict = {}
        if req.severity is not None:
            update["severity"] = req.severity
            update["level"] = req.severity
            update["importance"] = center.importance_for(req.severity)
        if req.title is not None:
            update["title"] = req.title
        if req.message is not None:
            update["message"] = req.message
        try:
            oid = ObjectId(item_id)
        except Exception:
            raise HTTPException(404, "Notification not found")
        if update:
            result = await db.notifications.update_one({"_id": oid}, {"$set": update})
            if result.matched_count == 0 and req.read is None:
                raise HTTPException(404, "Notification not found")
    return {"ok": True}


@router.put("/read/{item_id}")
async def mark_read(item_id: str):
    if not await mark_notification_read(item_id):
        raise HTTPException(404, "Notification not found")
    return {"ok": True}


@router.put("/unread/{item_id}")
async def mark_unread(item_id: str):
    if not await mark_notification_unread(item_id):
        raise HTTPException(404, "Notification not found")
    return {"ok": True}


@router.put("/read-all")
async def mark_all_read():
    updated = await mark_all_notifications_read()
    return {"updated": updated}


@router.delete("/{item_id}")
async def delete_notification_route(item_id: str):
    if not await delete_notification(item_id):
        raise HTTPException(404, "Notification not found")
    return {"deleted": 1}


@router.get("/{item_id}")
async def get_notification_detail(item_id: str):
    doc = await get_notification(item_id)
    if doc is None:
        raise HTTPException(404, "Notification not found")
    return {"data": doc}


@router.delete("")
async def clear_all(confirm: str = "false"):
    deleted = await delete_all_notifications(confirm=confirm.lower() in ("1", "true", "yes"))
    return {"deleted": deleted}