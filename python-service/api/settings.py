"""Settings routes — CRUD + grouped APIs for app settings."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.settings_service import (
    DEFAULTS,
    export_settings,
    get_all_settings,
    get_setting_categories,
    get_settings_audit,
    get_settings_health,
    get_settings_schema,
    import_settings,
    is_sensitive_setting,
    reset_all_settings,
    reset_setting,
    reset_settings_category,
    set_setting,
    validate_settings_bulk,
)

router = APIRouter(prefix="/api/settings", tags=["settings"])


class UpdateSettingRequest(BaseModel):
    value: object


class UpdateSettingsPatch(BaseModel):
    settings: dict
    dryRun: bool = False


class ImportSettingsRequest(BaseModel):
    settings: dict
    dryRun: bool = False


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


@router.get("/schema")
async def get_schema():
    """Full typed catalogue — the advanced Settings UI is driven by this."""
    rows = await get_settings_schema()
    return {
        "settings": rows,
        "categories": get_setting_categories(),
        "sensitiveKeys": sorted(key for key in DEFAULTS if is_sensitive_setting(key)),
    }


@router.get("/health")
async def get_health():
    return await get_settings_health()


@router.get("/audit")
async def get_audit(limit: int = 100, key: str | None = None, action: str | None = None):
    return {
        "changes": await get_settings_audit(limit=limit, key=key, action=action),
        "limit": max(1, min(limit or 100, 500)),
    }


@router.get("/export")
async def export_settings_snapshot():
    return await export_settings()


@router.post("/import")
async def import_settings_snapshot(req: ImportSettingsRequest):
    try:
        result = await import_settings(req.settings, dry_run=req.dryRun)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if not result.get("ok"):
        _record_settings_event("import-rejected", list(result.get("rejected", {}).keys()))
        raise HTTPException(400, detail={"message": "Import rejected", "errors": result.get("rejected", {})})
    if not req.dryRun:
        _record_settings_event("import", list(req.settings.keys()))
    return result


@router.post("/reset-category/{category}")
async def reset_category(category: str):
    try:
        settings = await reset_settings_category(category)
    except ValueError as exc:
        raise HTTPException(404, str(exc))
    _record_settings_event("reset-category", [category])
    return {"settings": settings, "grouped": _grouped(settings), "category": category}


@router.get("/{key}")
async def get_one(key: str):
    from services.settings_service import get_setting
    if key not in DEFAULTS:
        raise HTTPException(404, "Unknown setting")
    value = await get_setting(key)
    return {"key": key, "value": value}


@router.patch("")
async def patch_settings(req: UpdateSettingsPatch):
    """Bulk update — validate the whole patch before writing anything.

    The previous implementation wrote key-by-key and raised in the middle,
    leaving a partially applied configuration. Validation now runs first, so a
    patch is atomic from the caller's perspective.
    """
    errors = validate_settings_bulk(req.settings)
    if errors:
        raise HTTPException(400, detail={"message": "Settings patch rejected", "errors": errors})
    if req.dryRun:
        return {
            "ok": True,
            "dryRun": True,
            "validated": sorted(req.settings.keys()),
            "settings": await get_all_settings(),
        }
    updated: dict = {}
    for key, value in req.settings.items():
        try:
            await set_setting(key, value, source="bulk")
            updated[key] = True
        except ValueError:
            updated[key] = False
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
