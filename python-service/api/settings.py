"""Settings routes — CRUD for app settings."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.settings_service import (
    get_all_settings,
    get_setting_categories,
    set_setting,
    reset_setting,
    reset_all_settings,
)

router = APIRouter(prefix="/api/settings", tags=["settings"])


class UpdateSettingRequest(BaseModel):
    value: object


@router.get("")
async def get_settings():
    settings = await get_all_settings()
    return {"settings": settings}


@router.get("/categories")
async def get_categories():
    return {"categories": get_setting_categories()}


@router.put("/{key}")
async def update_setting(key: str, req: UpdateSettingRequest):
    try:
        doc = await set_setting(key, req.value)
        return {"setting": doc}
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@router.post("/{key}/reset")
async def reset_one(key: str):
    try:
        doc = await reset_setting(key)
        return {"setting": doc}
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@router.post("/reset-all")
async def reset_all():
    settings = await reset_all_settings()
    return {"settings": settings}

