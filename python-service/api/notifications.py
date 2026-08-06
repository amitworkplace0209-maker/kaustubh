"""Notifications CRUD."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database.connection import get_db

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


class CreateNotificationRequest(BaseModel):
    category: str = "system"
    level: str = "info"
    title: str
    message: str
    meta: dict | None = None


@router.get("")
async def get_notifications(category: str = "", unread_only: str = "false"):
    db = get_db()
    query = {}
    if category:
        query["category"] = category
    if unread_only.lower() == "true":
        query["read"] = False
    cursor = db.notifications.find(query).sort("ts", -1).limit(200)
    items = await cursor.to_list(length=200)
    for item in items:
        item["_id"] = str(item["_id"])
        if "ts" in item and isinstance(item["ts"], datetime):
            item["ts"] = item["ts"].isoformat()
    unread_count = await db.notifications.count_documents({"read": False})
    return {"notifications": items, "unreadCount": unread_count}


@router.post("")
async def create_notification(req: CreateNotificationRequest):
    db = get_db()
    doc = {
        "category": req.category,
        "level": req.level,
        "title": req.title,
        "message": req.message,
        "meta": req.meta,
        "read": False,
        "ts": datetime.now(timezone.utc),
    }
    result = await db.notifications.insert_one(doc)
    doc["_id"] = str(result.inserted_id)
    return {"data": doc}


@router.put("/read/{item_id}")
async def mark_read(item_id: str):
    from bson import ObjectId
    db = get_db()
    result = await db.notifications.update_one({"_id": ObjectId(item_id)}, {"$set": {"read": True}})
    if result.modified_count == 0:
        raise HTTPException(404, "Notification not found")
    return {"ok": True}


@router.put("/read-all")
async def mark_all_read():
    db = get_db()
    result = await db.notifications.update_many({"read": False}, {"$set": {"read": True}})
    return {"updated": result.modified_count}


@router.delete("/{item_id}")
async def delete_notification(item_id: str):
    from bson import ObjectId
    db = get_db()
    result = await db.notifications.delete_one({"_id": ObjectId(item_id)})
    if result.deleted_count == 0:
        raise HTTPException(404, "Notification not found")
    return {"deleted": 1}


@router.delete("")
async def clear_all():
    db = get_db()
    result = await db.notifications.delete_many({})
    return {"deleted": result.deleted_count}
