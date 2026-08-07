"""Logs query + clear."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database.connection import get_db

router = APIRouter(prefix="/api/logs", tags=["logs"])


class ClearLogsRequest(BaseModel):
    category: str | None = None


@router.get("")
async def get_logs(
    category: str = "",
    level: str = "",
    start: str = "",
    end: str = "",
    limit: int = 200,
):
    db = get_db()
    query = {}
    if category:
        query["category"] = category
    if level:
        query["level"] = level
    if start:
        try:
            query.setdefault("ts", {})["$gte"] = datetime.fromisoformat(start.replace("Z", "+00:00"))
        except ValueError:
            pass
    if end:
        try:
            query.setdefault("ts", {})["$lte"] = datetime.fromisoformat(end.replace("Z", "+00:00"))
        except ValueError:
            pass
    limit = min(max(limit, 1), 5000)
    cursor = db.app_logs.find(query).sort("ts", -1).limit(limit)
    logs = await cursor.to_list(length=limit)
    for l in logs:
        l["_id"] = str(l["_id"])
        if "ts" in l and isinstance(l["ts"], datetime):
            l["ts"] = l["ts"].isoformat()
    return {"logs": logs}

