"""Settings routes — CRUD + grouped APIs for app settings."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.settings_service import (
    DEFAULTS,
    get_all_settings,
    get_setting_categories,
    set_setting,
    reset_setting,
    reset_all_settings,
)

router = APIRouter(prefix="/api/settings", tags=["settings"])


class UpdateSettingRequest(BaseModel):
    value: object


class UpdateSettingsPatch(BaseModel):
    settings: dict


# Categories that Data Saver exposes in the Settings UI, in display order.
DATA_SAVER_CATEGORIES = [
    "general",
    "appearance",
    "data_saver",
    "market_data",
    "websocket",
    "database",
    "scheduler",
    "notification",
    "security",
    "advanced",
]


def _is_database_category(category: str) -> bool:
    return category in {"mongodb", "database"}


def _grouped(settings: dict) -> dict:
    """Group the flat settings map into the section structure used by the UI."""
    grouped: dict = {}
    for key, doc in settings.items():
        category = doc.get("category") or "general"
        grouped.setdefault(category, {})[key] = doc
    return grouped


def _record_settings_event(action: str, keys: list[str]) -> None:
    """Mirror a settings mutation onto the canonical event ledger (audit)."""
    try:
        from services.notification_center import emit_event as record_event
        record_event(
            "settings", "SETTINGS_CHANGED",
            "info" if action != "reset-all" else "warning",
            f"Settings {action}: {', '.join(sorted(keys))[:400]}",
            {"action": action, "keys": keys, "component": "settings",
             "severity": "info", "details": f"keys={len(keys)}"},
        )
    except Exception:
        pass


@router.get("")
async def get_settings():
    settings = await get_all_settings()
    return {"settings": settings, "grouped": _grouped(settings)}


@router.get("/categories")
async def get_categories():
    return {"categories": get_setting_categories()}


@router.get("/grouped")
async def get_grouped():
    settings = await get_all_settings()
    return {"grouped": _grouped(settings)}


@router.get("/runtime")
async def get_runtime_knobs():
    """Which settings keys drive the live runtime (scheduler, WS, tick buffer)."""
    from services.runtime_settings import LIVE_KEYS, snapshot
    return {
        "liveKeys": sorted(LIVE_KEYS),
        "snapshot": snapshot(),
    }


@router.get("/{key}")
async def get_one(key: str):
    from services.settings_service import get_setting
    if key not in DEFAULTS:
        raise HTTPException(404, "Unknown setting")
    value = await get_setting(key)
    return {"key": key, "value": value}


@router.patch("")
async def patch_settings(req: UpdateSettingsPatch):
    """Bulk update — each key is validated against its declared schema."""
    updated: dict = {}
    for key, value in req.settings.items():
        try:
            await set_setting(key, value)
            updated[key] = True
        except ValueError as exc:
            updated[key] = False
            raise HTTPException(400, f"{key}: {exc}")
    _record_settings_event("update", list(req.settings.keys()))
    settings = await get_all_settings()
    return {"updated": updated, "settings": settings, "grouped": _grouped(settings)}


@router.put("/{key}")
async def update_setting(key: str, req: UpdateSettingRequest):
    try:
        doc = await set_setting(key, req.value)
        _record_settings_event("update", [key])
        return {"setting": doc}
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@router.post("/{key}/reset")
async def reset_one(key: str):
    try:
        doc = await reset_setting(key)
        _record_settings_event("reset", [key])
        return {"setting": doc}
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@router.post("/reset-all")
async def reset_all():
    settings = await reset_all_settings()
    _record_settings_event("reset-all", list(settings.keys()))
    return {"settings": settings, "grouped": _grouped(settings)}
