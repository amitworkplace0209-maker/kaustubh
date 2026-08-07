"""
Settings service — key-value store backed by MongoDB with 90+ built-in defaults.

Mirrors the Node.js settingsService.js exactly so the frontend needs no changes.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from database.connection import get_db

logger = logging.getLogger("app")

DEFAULTS: dict[str, dict] = {
    # ---- Profile ----
    "profile_name": {"value": "Trader", "category": "profile", "description": "Profile Name"},
    "profile_email": {"value": "trader@kaustubh.com", "category": "profile", "description": "Email"},
    "user_id": {"value": "KAU001", "category": "profile", "description": "User ID"},
    "app_version": {"value": "2.0.0", "category": "profile", "description": "App Version"},
    "trading_mode": {"value": "api", "category": "profile", "description": "Trading Mode (api/dummy)"},
    "custom_primary_color": {"value": "#0f7a52", "category": "profile", "description": "Custom Primary Color"},
    "custom_accent_color": {"value": "#0d9488", "category": "profile", "description": "Custom Accent Color"},
    "custom_secondary_color": {"value": "#64748b", "category": "profile", "description": "Custom Secondary Color"},
    # ---- Theme ----
    "theme": {"value": "dark", "category": "theme", "description": "Theme (dark/light/system/amoled)"},
    "card_radius": {"value": 12, "category": "theme", "description": "Card Border Radius (px)"},
    "font_size": {"value": 14, "category": "theme", "description": "Font Size (px)"},
    "compact_mode": {"value": False, "category": "theme", "description": "Compact Mode"},
    "primary_color": {"value": "#0f7a52", "category": "theme", "description": "Primary Color"},
    "secondary_color": {"value": "#64748b", "category": "theme", "description": "Secondary Color"},
    # ---- Trading ----
    "trading_enabled": {"value": True, "category": "trading", "description": "Trading Enable"},
    "intraday_default": {"value": "MIS", "category": "trading", "description": "Intraday Default Product"},
    "cnc_default": {"value": "CNC", "category": "trading", "description": "CNC Default Product"},
    "default_exchange": {"value": "nse_cm", "category": "trading", "description": "Default Exchange"},
    "default_product": {"value": "MIS", "category": "trading", "description": "Default Product"},
    "default_quantity": {"value": 1, "category": "trading", "description": "Default Quantity"},
    "default_order_type": {"value": "MKT", "category": "trading", "description": "Default Order Type"},
    "default_stop_loss": {"value": 0, "category": "trading", "description": "Default Stop Loss (%)"},
    "default_target": {"value": 0, "category": "trading", "description": "Default Target (%)"},
    "default_square_off": {"value": "15:20", "category": "trading", "description": "Default Square Off Time (HH:MM)"},
    "confirm_before_order": {"value": True, "category": "trading", "description": "Confirm Before Order"},
    "auto_refresh_holdings": {"value": True, "category": "trading", "description": "Auto Refresh Holdings"},
    "auto_refresh_positions": {"value": True, "category": "trading", "description": "Auto Refresh Positions"},
    "max_risk_per_trade": {"value": 5, "category": "trading", "description": "Max Risk Per Trade (%)"},
    "max_daily_loss": {"value": 10, "category": "trading", "description": "Max Daily Loss (%)"},
    # ---- Python Service ----
    "python_enabled": {"value": True, "category": "python", "description": "Python Service Enable/Disable"},
    "python_path": {"value": "python3", "category": "python", "description": "Python Path"},
    "python_venv": {"value": "", "category": "python", "description": "Virtual Environment Path"},
    "sdk_status": {"value": "unknown", "category": "python", "description": "SDK Status"},
    "sdk_version": {"value": "2.0.2", "category": "python", "description": "SDK Version"},
    "auto_login": {"value": True, "category": "python", "description": "Auto Login Enable"},
    "auto_logout": {"value": True, "category": "python", "description": "Auto Logout Enable"},
    "auto_reconnect": {"value": True, "category": "python", "description": "Auto Reconnect Enable"},
    "scheduler_enabled": {"value": True, "category": "python", "description": "Scheduler Enable"},
    "scheduler_login_time": {"value": "09:00", "category": "python", "description": "Scheduler Login Time (HH:MM)"},
    "scheduler_logout_time": {"value": "15:35", "category": "python", "description": "Scheduler Logout Time (HH:MM)"},
    "python_service_url": {"value": "http://localhost:8000", "category": "python", "description": "Python Service URL"},
    # ---- Data Saver ----
    "data_saver_enabled": {"value": True, "category": "data_saver", "description": "Enable Data Saver"},
    "tick_interval_ms": {"value": 1000, "category": "data_saver", "description": "Tick Interval (ms)"},
    "batch_size": {"value": 500, "category": "data_saver", "description": "Batch Size"},
    "buffer_size": {"value": 5000, "category": "data_saver", "description": "Buffer Size"},
    "bulk_insert_size": {"value": 1000, "category": "data_saver", "description": "Bulk Insert Size"},
    "retry_count": {"value": 3, "category": "data_saver", "description": "Retry Count"},
    "flush_interval_ms": {"value": 1000, "category": "data_saver", "description": "Flush Interval (ms)"},
    "auto_save": {"value": True, "category": "data_saver", "description": "Auto Save"},
    "save_path": {"value": "./downloads", "category": "data_saver", "description": "Save Path"},
    "data_collection_start": {"value": "09:15", "category": "data_saver", "description": "Data Collection Start (HH:MM)"},
    "data_collection_stop": {"value": "15:30", "category": "data_saver", "description": "Data Collection Stop (HH:MM)"},
    "auto_login_time": {"value": "09:00", "category": "data_saver", "description": "Auto Login Time (HH:MM)"},
    # ---- MongoDB ----
    "mongodb_uri": {"value": "mongodb://localhost:27017/kaustubh", "category": "mongodb", "description": "MongoDB Connection URI"},
    "mongodb_database": {"value": "kaustubh", "category": "mongodb", "description": "Database Name"},
    "mongodb_collection": {"value": "ticks", "category": "mongodb", "description": "Collection Name"},
    # ---- Downloads ----
    "download_csv": {"value": True, "category": "download", "description": "CSV Download Enabled"},
    "download_json": {"value": True, "category": "download", "description": "JSON Download Enabled"},
    "download_jsonl": {"value": True, "category": "download", "description": "JSONL Download Enabled"},
    "download_ndjson": {"value": True, "category": "download", "description": "NDJSON Download Enabled"},
    "download_txt": {"value": True, "category": "download", "description": "TXT Download Enabled"},
    "download_xlsx": {"value": True, "category": "download", "description": "XLSX Download Enabled"},
    "download_zip": {"value": False, "category": "download", "description": "ZIP Compression Enabled"},
    "download_compression": {"value": False, "category": "download", "description": "Compression Enabled"},
    "download_folder": {"value": "./downloads", "category": "download", "description": "Download Folder"},
    "download_date_range_days": {"value": 1, "category": "download", "description": "Default Date Range (days)"},
    "download_default_format": {"value": "csv", "category": "download", "description": "Default Download Format"},
    # ---- Logs ----
    "log_level": {"value": "info", "category": "log", "description": "Log Level"},
    "log_error_enabled": {"value": True, "category": "log", "description": "Error Log Enabled"},
    "log_api_enabled": {"value": True, "category": "log", "description": "API Log Enabled"},
    "log_scheduler_enabled": {"value": True, "category": "log", "description": "Scheduler Log Enabled"},
    "log_mongo_enabled": {"value": True, "category": "log", "description": "Mongo Log Enabled"},
    "log_trading_enabled": {"value": True, "category": "log", "description": "Trading Log Enabled"},
    "log_python_enabled": {"value": True, "category": "log", "description": "Python Log Enabled"},
    "log_download_enabled": {"value": True, "category": "log", "description": "Download Log Enabled"},
    "log_login_enabled": {"value": True, "category": "log", "description": "Login Log Enabled"},
    "log_retention_days": {"value": 30, "category": "log", "description": "Log Retention (days)"},
    # ---- Notifications ----
    "notification_desktop": {"value": True, "category": "notification", "description": "Desktop Notifications"},
    "notification_trading": {"value": True, "category": "notification", "description": "Trading Alerts"},
    "notification_login": {"value": True, "category": "notification", "description": "Login Alerts"},
    "notification_connection": {"value": True, "category": "notification", "description": "Connection Alerts"},
    "notification_scheduler": {"value": True, "category": "notification", "description": "Scheduler Alerts"},
    "notification_mongo": {"value": True, "category": "notification", "description": "MongoDB Alerts"},
    "notification_download": {"value": True, "category": "notification", "description": "Download Alerts"},
    "notification_system": {"value": True, "category": "notification", "description": "System Alerts"},
    "notification_error": {"value": True, "category": "notification", "description": "Error Alerts"},
    "notification_order": {"value": True, "category": "notification", "description": "Order Alerts"},
    "notification_position": {"value": True, "category": "notification", "description": "Position Alerts"},
    "notification_sound": {"value": True, "category": "notification", "description": "Sound Enabled"},
    "notification_popup": {"value": True, "category": "notification", "description": "Popup Enabled"},
    "notification_push": {"value": False, "category": "notification", "description": "Push Notification Enabled"},
    # ---- Security ----
    "security_pin": {"value": "", "category": "security", "description": "Security PIN"},
    "security_fingerprint": {"value": False, "category": "security", "description": "Fingerprint Unlock"},
    "security_biometric": {"value": False, "category": "security", "description": "Biometric Unlock"},
    "security_app_lock": {"value": False, "category": "security", "description": "App Lock"},
    "auto_lock_timeout": {"value": 5, "category": "security", "description": "Lock Timeout (minutes)"},
    "session_timeout": {"value": 30, "category": "security", "description": "Session Timeout (minutes)"},
    "auto_square_off_enabled": {"value": False, "category": "security", "description": "Auto Square Off Enable"},
    "auto_square_off_time": {"value": "15:20", "category": "security", "description": "Auto Square Off Time (HH:MM)"},
    # ---- General ----
    "app_name": {"value": "KAUSTUBH Trading Platform", "category": "general", "description": "Application Name"},
    "sidebar_style": {"value": "default", "category": "general", "description": "Sidebar Style"},
    "card_style": {"value": "default", "category": "general", "description": "Card Style"},
    "dashboard_layout": {"value": "grid", "category": "general", "description": "Dashboard Layout"},
}


async def get_setting(key: str):
    db = get_db()
    doc = await db.app_settings.find_one({"key": key})
    if doc:
        return doc["value"]
    return DEFAULTS.get(key, {}).get("value")


async def set_setting(key: str, value) -> dict:
    if key not in DEFAULTS:
        raise ValueError(f"Unknown setting: {key}")
    db = get_db()
    now = datetime.now(timezone.utc)
    doc = {
        "key": key,
        "value": value,
        "category": DEFAULTS[key]["category"],
        "description": DEFAULTS[key]["description"],
        "updatedAt": now,
    }
    await db.app_settings.update_one({"key": key}, {"$set": doc}, upsert=True)
    logger.info("Setting updated: %s", key)
    return doc


async def get_all_settings() -> dict:
    db = get_db()
    docs = {d["key"] async for d in db.app_settings.find({})}
    result = {}
    for key, defn in DEFAULTS.items():
        doc = docs.get(key)
        result[key] = {
            "key": key,
            "value": doc["value"] if doc else defn["value"],
            "category": defn["category"],
            "description": defn["description"],
            "updatedAt": doc.get("updatedAt") if doc else None,
        }
    return result


def get_setting_categories() -> list[str]:
    return list({d["category"] for d in DEFAULTS.values()})


async def reset_setting(key: str) -> dict:
    if key not in DEFAULTS:
        raise ValueError(f"Unknown setting: {key}")
    db = get_db()
    await db.app_settings.delete_one({"key": key})
    return {
        "key": key,
        "value": DEFAULTS[key]["value"],
        "category": DEFAULTS[key]["category"],
        "description": DEFAULTS[key]["description"],
        "updatedAt": None,
    }


async def reset_all_settings() -> dict:
    db = get_db()
    await db.app_settings.delete_many({})
    return await get_all_settings()

