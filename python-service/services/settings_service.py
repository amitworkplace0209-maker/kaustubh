"""
Settings service — key-value store backed by MongoDB with 90+ built-in defaults.

Mirrors the Node.js settingsService.js exactly so the frontend needs no changes.

Schedule single source of truth
------------------------------
The ``sched_*`` keys are the ONLY authoritative daily-schedule values. Several
legacy keys (``scheduler_login_time``, ``data_collection_start``,
``auto_login_time``, ``square_off_time`` …) used to carry their own, DIFFERENT
times (09:00 / 09:15 / 15:15 …) and were read by nothing. They are still
rendered in the Settings UI, so an operator editing one silently got no effect
— and the UI happily displayed two contradictory times for the same action.

They are now declared as ALIASES of the authoritative key (see
``SCHEDULE_ALIASES``). Reads, writes and resets all resolve through the
authoritative key, so a stale alias can never disagree with the real schedule
and editing an alias genuinely changes the schedule.
"""
from __future__ import annotations

import logging
import json
from datetime import datetime, timezone

from database.connection import get_db

logger = logging.getLogger("app")


def _installed_sdk_version() -> str:
    """Version of the installed kotakneoapi distribution (honest, not pinned)."""
    try:
        from importlib.metadata import PackageNotFoundError, version

        return version("kotakneoapi")
    except Exception:  # PackageNotFoundError and any metadata failure
        return "unknown"

# Legacy setting key -> authoritative ``sched_*`` key it mirrors.
# Keeping these as aliases (instead of deleting them) preserves the existing
# Settings UI layout and any stored preference while guaranteeing exactly one
# value per schedule action.
SCHEDULE_ALIASES: dict[str, str] = {
    "scheduler_login_time": "sched_login_time",
    "scheduler_logout_time": "sched_logout_time",
    "auto_login_time": "sched_login_time",
    "data_collection_start": "sched_tick_collection_start_time",
    "data_collection_stop": "sched_ws_stop_time",
    "square_off_time": "sched_square_off_time",
    "default_square_off": "sched_square_off_time",
    "auto_square_off_time": "sched_square_off_time",
}


def resolve_schedule_alias(key: str) -> str:
    """Map a legacy schedule key onto the authoritative ``sched_*`` key.

    Alias chains are resolved to a fixed point, so an alias may safely point at
    another alias. Unknown keys are returned unchanged.
    """
    seen: set[str] = set()
    current = key
    while current in SCHEDULE_ALIASES and current not in seen:
        seen.add(current)
        current = SCHEDULE_ALIASES[current]
    return current


DEFAULTS: dict[str, dict] = {
    # ---- Profile ----
    "profile_name": {"value": "Trader", "category": "profile", "description": "Profile Name"},
    "profile_email": {"value": "trader@kaustubh.com", "category": "profile", "description": "Email"},
    "user_id": {"value": "KAU001", "category": "profile", "description": "User ID"},
    "app_version": {"value": "2.0.0", "category": "profile", "description": "App Version"},
    "trading_mode": {"value": "api", "category": "profile", "description": "Trading Mode (api/dummy)"},
    # Canonical Trading Terminal mode (kotak | shoonya | dummy) — the durable
    # identity written whenever /api/terminal/switch succeeds. Consumed by the
    # frontend settings store to restore the active terminal across reloads.
    "terminal_mode": {
        "value": "kotak", "category": "trading", "type": "select",
        "options": ["kotak", "shoonya", "dummy"],
        "description": "Active Trading Terminal (kotak/shoonya/dummy)",
    },
    # Per-mode trading settings snapshot (JSON object keyed by terminal id).
    # Kept as one flat setting to stay inside the existing key-value store.
    "terminal_mode_presets": {
        "value": "{}", "category": "trading", "type": "string",
        "description": "Per-mode trading settings (JSON)",
    },
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
    "default_square_off": {"value": "15:16", "category": "trading", "description": "Default Square Off Time (HH:MM) - mirrors 'Square Off Trigger Time' (sched_square_off_time)"},
    "confirm_before_order": {"value": True, "category": "trading", "description": "Confirm Before Order"},
    "auto_refresh_holdings": {"value": True, "category": "trading", "description": "Auto Refresh Holdings"},
    "auto_refresh_positions": {"value": True, "category": "trading", "description": "Auto Refresh Positions"},
    "max_risk_per_trade": {"value": 5, "category": "trading", "description": "Max Risk Per Trade (%)"},
    "max_daily_loss": {"value": 10, "category": "trading", "description": "Max Daily Loss (%)"},
    # ---- Order Defaults ----
    "order_default_side": {"value": "BUY", "category": "trading", "description": "Default Order Side"},
    "default_segment": {"value": "NSE_CM", "category": "trading", "description": "Default Segment"},
    "default_validity": {"value": "DAY", "category": "trading", "description": "Default Validity"},
    "default_disclosed_qty": {"value": 0, "category": "trading", "description": "Default Disclosed Quantity"},
    # ---- Risk Management ----
    "risk_max_order_value": {"value": 500000, "category": "trading", "description": "Max Order Value"},
    "risk_max_daily_loss": {"value": 50000, "category": "trading", "description": "Max Daily Loss Amount"},
    "risk_max_daily_profit": {"value": 100000, "category": "trading", "description": "Max Daily Profit Target"},
    "risk_max_daily_orders": {"value": 50, "category": "trading", "description": "Max Daily Orders"},
    "risk_max_open_positions": {"value": 10, "category": "trading", "description": "Max Open Positions"},
    "risk_max_qty_per_position": {"value": 500, "category": "trading", "description": "Max Quantity Per Position"},
    "risk_max_exposure": {"value": 2000000, "category": "trading", "description": "Max Exposure"},
    "risk_max_demo": {"value": 100000, "category": "trading", "description": "Max Demo Risk"},
    "risk_max_live": {"value": 500000, "category": "trading", "description": "Max Live Risk"},
    # ---- Target ----
    "target_enabled": {"value": False, "category": "trading", "description": "Target Enabled"},
    "target_mode": {"value": "PERCENT", "category": "trading", "description": "Target Mode"},
    "target_value": {"value": 2, "category": "trading", "description": "Target Value"},
    # ---- Stop Loss ----
    "sl_enabled": {"value": False, "category": "trading", "description": "Stop Loss Enabled"},
    "sl_mode": {"value": "PERCENT", "category": "trading", "description": "Stop Loss Mode"},
    "sl_value": {"value": 1, "category": "trading", "description": "Stop Loss Value"},
    # ---- Square Off ----
    "square_off_enabled": {"value": False, "category": "trading", "description": "Auto Square Off Enabled"},
    "square_off_time": {"value": "15:16", "category": "trading", "description": "Square Off Time - mirrors 'Square-off trigger time' (sched_square_off_time)"},
    "square_off_timezone": {"value": "Asia/Kolkata", "category": "trading", "description": "Square Off Timezone"},
    "square_off_apply_to": {"value": "MIS", "category": "trading", "description": "Square Off Apply To"},
    # ---- Confirmations ----
    "confirm_buy": {"value": True, "category": "trading", "description": "Confirm Buy Orders"},
    "confirm_sell": {"value": True, "category": "trading", "description": "Confirm Sell Orders"},
    "confirm_squareoff": {"value": True, "category": "trading", "description": "Confirm Square Off"},
    # ---- Python Service ----
    "python_enabled": {"value": True, "category": "python", "description": "Python Service Enable/Disable"},
    "python_path": {"value": "python3", "category": "python", "description": "Python Path"},
    "python_venv": {"value": "", "category": "python", "description": "Virtual Environment Path"},
    "sdk_status": {"value": "unknown", "category": "python", "description": "SDK Status"},
    # Resolved from the installed distribution so the settings UI can never
    # advertise a hardcoded (previously stale "2.0.2") SDK version. Uses
    # importlib.metadata to avoid importing auth.kotak_client here (circular
    # import via config).
    "sdk_version": {"value": _installed_sdk_version(), "category": "python", "description": "SDK Version"},
    "auto_login": {"value": True, "category": "python", "description": "Auto Login Enable"},
    "auto_logout": {"value": True, "category": "python", "description": "Auto Logout Enable"},
    "auto_reconnect": {"value": True, "category": "python", "description": "Auto Reconnect Enable"},
    "scheduler_enabled": {"value": True, "category": "python", "description": "Scheduler Enable"},
    "scheduler_login_time": {"value": "08:50", "category": "python", "description": "Scheduler Login Time (HH:MM) - mirrors 'Scheduled login time' (sched_login_time)"},
    "scheduler_logout_time": {"value": "16:00", "category": "python", "description": "Scheduler Logout Time (HH:MM) - mirrors 'Scheduled logout time' (sched_logout_time)"},
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
    "data_collection_start": {"value": "08:59", "category": "data_saver", "description": "Data Collection Start (HH:MM) - mirrors 'Scheduled tick collection start time' (sched_tick_collection_start_time)"},
    "data_collection_stop": {"value": "15:31", "category": "data_saver", "description": "Data Collection Stop (HH:MM) - mirrors 'Scheduled WebSocket stop time' (sched_ws_stop_time)"},
    "auto_login_time": {"value": "08:50", "category": "data_saver", "description": "Auto Login Time (HH:MM) - mirrors 'Scheduled login time' (sched_login_time)"},
    # ---- MongoDB ----
    # The connection string is a backend-only secret supplied through the
    # MONGODB_URI environment variable and is deliberately NOT stored or
    # exposed here (it must never reach the browser). These fields are
    # read-only descriptors of the live MongoDB target.
    "mongodb_uri": {"value": "", "category": "mongodb", "description": "MongoDB Connection URI (backend-only, configured via MONGODB_URI — never exposed to the browser)"},
    "mongodb_database": {"value": "kaustubh", "category": "mongodb", "description": "MongoDB Database Name"},
    "mongodb_collection": {"value": "ticks", "category": "mongodb", "description": "Tick Collection Name"},

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
    "scheduled_download_enabled": {"value": True, "category": "download", "description": "Scheduled Downloads Enabled"},
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
    # ---- Notification Events ----
    "notif_order_placed": {"value": True, "category": "notification", "description": "Order Placed Alert"},
    "notif_order_completed": {"value": True, "category": "notification", "description": "Order Completed Alert"},
    "notif_order_rejected": {"value": True, "category": "notification", "description": "Order Rejected Alert"},
    "notif_order_cancelled": {"value": True, "category": "notification", "description": "Order Cancelled Alert"},
    "notif_target_reached": {"value": True, "category": "notification", "description": "Target Reached Alert"},
    "notif_sl_triggered": {"value": True, "category": "notification", "description": "Stop Loss Triggered Alert"},
    "notif_squareoff_executed": {"value": True, "category": "notification", "description": "Square Off Executed Alert"},
    "notif_margin_warning": {"value": True, "category": "notification", "description": "Margin Warning Alert"},
    "notif_risk_limit": {"value": True, "category": "notification", "description": "Risk Limit Reached Alert"},
    "notif_broker_disconnected": {"value": True, "category": "notification", "description": "Broker Disconnected Alert"},
    "notif_broker_expired": {"value": True, "category": "notification", "description": "Broker Session Expired Alert"},
    "notif_market_open": {"value": True, "category": "notification", "description": "Market Open Alert"},
    "notif_market_closed": {"value": True, "category": "notification", "description": "Market Closed Alert"},
    # ---- Notification Channels ----
    "notif_channel_inapp": {"value": True, "category": "notification", "description": "In-App Notifications"},
    "notif_channel_browser": {"value": False, "category": "notification", "description": "Browser Notifications"},
    "notif_channel_sound": {"value": True, "category": "notification", "description": "Sound Notifications"},
    # ---- Security ----
    "security_pin": {"value": "", "category": "security", "description": "Security PIN"},
    "security_fingerprint": {"value": False, "category": "security", "description": "Fingerprint Unlock"},
    "security_biometric": {"value": False, "category": "security", "description": "Biometric Unlock"},
    "security_app_lock": {"value": False, "category": "security", "description": "App Lock"},
    "auto_lock_timeout": {"value": 5, "category": "security", "description": "Lock Timeout (minutes)"},
    "session_timeout": {"value": 30, "category": "security", "description": "Session Timeout (minutes)"},
    "auto_square_off_enabled": {"value": False, "category": "security", "description": "Auto Square Off Enable"},
    "auto_square_off_time": {"value": "15:16", "category": "security", "description": "Auto Square Off Time (HH:MM) - mirrors 'Square-off trigger time' (sched_square_off_time)"},
    # ---- Sound ----
    "sound_enabled": {"value": True, "category": "notification", "description": "Trading Sounds Enabled"},
    "sound_volume": {"value": 75, "category": "notification", "description": "Sound Volume"},
    "sound_order_success": {"value": True, "category": "notification", "description": "Order Success Sound"},
    "sound_order_rejection": {"value": True, "category": "notification", "description": "Order Rejection Sound"},
    "sound_target": {"value": True, "category": "notification", "description": "Target Sound"},
    "sound_sl": {"value": True, "category": "notification", "description": "Stop Loss Sound"},
    "sound_squareoff": {"value": True, "category": "notification", "description": "Square Off Sound"},
    # ---- Market Watch ----
    "market_watch_default_max_price": {"value": "800", "category": "market_watch", "description": "Default Max Stock Price (₹) for the Data Market Watch scanner"},
    "market_watch_scanner_filters": {"value": "", "category": "market_watch", "description": "Persisted Data Market Watch scanner filters (JSON)"},
    "market_watch_auto_refresh_sec": {"value": "30", "category": "market_watch", "description": "Data Market Watch auto-scan interval (seconds)"},
    # Abstract engine configuration (docs/engines/MARKET_WATCH.md §23).
    "mwr_ranking_interval_seconds": {"value": 30, "category": "market_watch", "type": "number", "min": 5, "max": 300, "unit": "s", "description": "Market Watch ranking/index interval (seconds)"},
    "mwr_max_pins": {"value": 5, "category": "market_watch", "type": "number", "min": 1, "max": 10, "description": "Maximum automatic Gainer/Loser pins per category"},
    "mwr_initial_section_limit": {"value": 50, "category": "market_watch", "type": "number", "min": 10, "max": 500, "description": "Initial rows returned per Market Watch section"},
    "mwr_page_size": {"value": 100, "category": "market_watch", "type": "number", "min": 10, "max": 1000, "description": "More/Search page size (Market Watch pagination)"},
    "mwr_stale_threshold_seconds": {"value": 30, "category": "market_watch", "type": "number", "min": 5, "max": 600, "unit": "s", "description": "Market Watch stale-tick threshold (seconds)"},
    "mwr_universe_refresh_seconds": {"value": 300, "category": "market_watch", "type": "number", "min": 60, "max": 3600, "unit": "s", "description": "Market Watch eligible-universe refresh interval (seconds)"},
# Market Watch WEEKLY INTRADAY SCREEN (weekly Sat+Sun universe build).
    # These were previously env-only, which made the screen rule impossible to
    # change without editing the process environment. Registering them here is
    # what puts the screen on the Settings page.
    "mwr_price_max": {"value": 800, "category": "market_watch", "type": "number", "min": 1, "max": 100000, "description": "Weekly screen: keep only stocks priced BELOW this cap (INR)"},
    "mwr_margin_required": {"value": False, "category": "market_watch", "type": "boolean", "description": "Weekly screen: require a broker margin answer and reject stocks below the multiplier threshold (the Friday scan always requires it)"},
    "mwr_margin_multiplier_threshold": {"value": 5.0, "category": "market_watch", "type": "number", "min": 1, "max": 50, "unit": "x", "description": "Weekly screen: minimum margin multiplier a stock must reach (notional / broker margin)"},
    "mwr_intraday_required": {"value": True, "category": "market_watch", "type": "boolean", "description": "Weekly screen: only keep stocks confirmed available for intraday trading"},
    "mwr_intraday_policy": {"value": "REQUIRE_ELIGIBLE", "category": "market_watch", "type": "string", "options": ["REQUIRE_ELIGIBLE", "ALLOW_UNKNOWN"], "description": "How an UNKNOWN intraday status is treated. REQUIRE_ELIGIBLE keeps unconfirmed stocks OUT of the final list (strict); ALLOW_UNKNOWN admits them but flags them as unconfirmed for review"},
# Market Watch persistence switches (docs/engines/MARKET_WATCH.md §23).
    # Registered here so the on/off control is reachable from the Settings UI and
    # persists through the one app_settings contract. Each is consumed LIVE by
    # services/market_watch_config.py on EVERY tick, so a flip takes effect on the
    # next tick without a backend restart.
    "mwr_persist_ticks": {"value": True, "category": "market_watch", "type": "boolean", "description": "Market Watch OFFER gate: offer each validated tick to the DB Writer (NOT the persistence decision — the DB Writer's dbw_market_watch_ticks permission decides)"},
    "mwr_persist_candles": {"value": True, "category": "market_watch", "type": "boolean", "description": "Save Market Watch 1m/2m/5m/10m/30m candles to MongoDB"},
    "mwr_persist_decisions": {"value": True, "category": "market_watch", "type": "boolean", "description": "Save Market Watch block/re-entry decisions to MongoDB"},
    "mwr_tick_retention_days": {"value": 2, "category": "market_watch", "type": "number", "min": 1, "max": 30, "unit": "d", "description": "Market Watch tick retention (days)"},
    # Friday 15:25 weekly universe refresh. Consumed LIVE by both the engine
    # (services/market_watch_config.py) and the scheduler ledger.
    "mwr_friday_scan_hhmm": {"value": "15:25", "category": "market_watch", "type": "string", "description": "Market Watch Friday universe scan time (HH:MM IST)"},
    # Market Watch Runtime Window (authoritative - engine ONLY runs inside this window)
    "mwr_runtime_start_hhmm": {"value": "08:50", "category": "market_watch", "type": "string", "description": "Market Watch engine runtime start (HH:MM IST)"},
    "mwr_runtime_stop_hhmm": {"value": "15:30", "category": "market_watch", "type": "string", "description": "Market Watch engine runtime stop (HH:MM IST)"},
    # Market Watch internal lifecycle phases (within runtime window)
    "mwr_pre_market_hhmm": {"value": "09:00", "category": "market_watch", "type": "string", "description": "Pre-market phase start (HH:MM IST)"},
    "mwr_discovery_hhmm": {"value": "09:10", "category": "market_watch", "type": "string", "description": "Discovery phase start (HH:MM IST)"},
    "mwr_filter_start_hhmm": {"value": "09:11", "category": "market_watch", "type": "string", "description": "Filter phase start (HH:MM IST)"},
    "mwr_filter_window_end_hhmm": {"value": "09:12", "category": "market_watch", "type": "string", "description": "Filter window end (HH:MM IST)"},
    "mwr_subscription_end_hhmm": {"value": "09:14", "category": "market_watch", "type": "string", "description": "Subscription reconciliation end (HH:MM IST)"},
    "mwr_active_from_hhmm": {"value": "09:14", "category": "market_watch", "type": "string", "description": "Frontend data-active phase start (HH:MM IST)"},
    "mwr_final_monitoring_hhmm": {"value": "15:05", "category": "market_watch", "type": "string", "description": "Final monitoring phase start (HH:MM IST)"},
    "mwr_stop_hhmm": {"value": "15:15", "category": "market_watch", "type": "string", "description": "Market Watch work stop (HH:MM IST)"},
    "mwr_report_hhmm": {"value": "15:20", "category": "market_watch", "type": "string", "description": "EOD report generation start (HH:MM IST)"},
    "mwr_report_ready_hhmm": {"value": "15:25", "category": "market_watch", "type": "string", "description": "Report ready target (HH:MM IST)"},
    # ---- Market Data ----
    "market_refresh_interval": {"value": "1000", "category": "trading", "description": "Quote Refresh Interval"},
    "market_show_ltp": {"value": True, "category": "trading", "description": "Show LTP"},
    "market_show_bid": {"value": True, "category": "trading", "description": "Show Bid"},
    "market_show_ask": {"value": True, "category": "trading", "description": "Show Ask"},
    "market_show_volume": {"value": True, "category": "trading", "description": "Show Volume"},
    "market_show_ohlc": {"value": True, "category": "trading", "description": "Show OHLC"},
    "market_show_circuit": {"value": True, "category": "trading", "description": "Show Circuit Limits"},
    "market_show_avg_price": {"value": True, "category": "trading", "description": "Show Average Price"},
    # ---- Display ----
    "display_theme": {"value": "dark", "category": "theme", "description": "Display Theme"},
    "display_density": {"value": "comfortable", "category": "theme", "description": "Display Density"},
    "display_number_format": {"value": "indian", "category": "theme", "description": "Number Format"},
    "display_decimal_places": {"value": 2, "category": "theme", "description": "Decimal Places"},
    # ---- Broker ----
    "broker_connected": {"value": False, "category": "python", "description": "Broker Connected"},
    "broker_session_valid": {"value": False, "category": "python", "description": "Broker Session Valid"},
    "broker_account_masked": {"value": "", "category": "python", "description": "Broker Account Masked"},
    "broker_available_margin": {"value": 0, "category": "python", "description": "Broker Available Margin"},
    "broker_last_sync": {"value": "", "category": "python", "description": "Broker Last Sync"},
    # ---- Advanced ----
    "adv_order_timeout": {"value": 30, "category": "python", "description": "Order API Timeout (s)"},
    "adv_quote_timeout": {"value": 10, "category": "python", "description": "Quote Timeout (s)"},
    "adv_retry_count": {"value": 3, "category": "python", "description": "Retry Count"},
    "adv_retry_delay": {"value": 1000, "category": "python", "description": "Retry Delay (ms)"},
    "adv_order_polling": {"value": 5000, "category": "python", "description": "Order Polling Interval (ms)"},
    "adv_position_refresh": {"value": 5000, "category": "python", "description": "Position Refresh Interval (ms)"},
    "adv_history_refresh": {"value": 10000, "category": "python", "description": "History Refresh Interval (ms)"},
    # ---- General ----
    "app_name": {"value": "KAUSTUBH Trading Platform", "category": "general", "description": "Application Name"},
    "sidebar_style": {"value": "default", "category": "general", "description": "Sidebar Style"},
    "card_style": {"value": "default", "category": "general", "description": "Card Style"},
    "dashboard_layout": {"value": "grid", "category": "general", "description": "Dashboard Layout"},
    # ---- General (settings organiser) ----
    "general_language": {"value": "en", "category": "general", "type": "select", "description": "Application language"},
    "general_timezone": {"value": "Asia/Kolkata", "category": "general", "type": "select", "description": "Time zone used for all timestamps"},
    "general_date_format": {"value": "YYYY-MM-DD", "category": "general", "type": "select", "description": "Date display format"},
    "general_time_format": {"value": "24h", "category": "general", "type": "select", "description": "Time display format (12h/24h)"},
    "general_landing_page": {"value": "/data-saver/dashboard", "category": "general", "type": "string", "description": "Default landing page after login"},
    "general_auto_refresh": {"value": True, "category": "general", "type": "boolean", "description": "Auto refresh data views"},
    "general_animation": {"value": True, "category": "general", "type": "boolean", "description": "Enable UI animations"},
    # ---- Appearance ----
    "appearance_theme": {"value": "dark", "category": "appearance", "type": "select", "description": "Theme (dark/light/amoled/custom)"},
    "appearance_accent": {"value": "#F59E0B", "category": "appearance", "type": "string", "description": "Accent colour"},
    "appearance_density": {"value": "comfortable", "category": "appearance", "type": "select", "description": "UI density"},
    "appearance_sidebar_behavior": {"value": "default", "category": "appearance", "type": "select", "description": "Sidebar behaviour (default/collapsible/overlay)"},
    "appearance_topbar_behavior": {"value": "default", "category": "appearance", "type": "select", "description": "Top bar behaviour"},
    # ---- Data Saver (management) ----
    "ds_collection_enabled": {"value": True, "category": "data_saver", "type": "boolean", "description": "Enable data collection"},
    "ds_live_tick_collection": {"value": True, "category": "data_saver", "type": "boolean", "description": "Collect live ticks"},
    "ds_market_watch_scanner": {"value": True, "category": "data_saver", "type": "boolean", "description": "Enable Market Watch scanner"},
    "ds_scanner_interval_sec": {"value": 30, "category": "data_saver", "type": "number", "min": 10, "max": 300, "unit": "s", "description": "Scanner scan interval (seconds)"},
    "ds_batch_size": {"value": 500, "category": "data_saver", "type": "number", "min": 50, "max": 5000, "description": "Ticks per write batch"},
    "ds_storage_schema": {"value": "legacy", "category": "data_saver", "type": "select", "options": ["legacy", "canonical_only"], "description": "Mongo tick storage schema: legacy (flat + extras) or canonical_only (master canonical only)"},
    "ds_max_price": {"value": 800, "category": "data_saver", "type": "number", "min": 100, "max": 100000, "description": "Maximum stock price for Market Watch scanner"},
    "ds_max_daily_change_pct": {"value": 20, "category": "data_saver", "type": "number", "min": 1, "max": 100, "unit": "%", "description": "Maximum daily change limit"},
    "ds_intraday_only": {"value": True, "category": "data_saver", "type": "boolean", "description": "Collect intraday data only"},
    "ds_circuit_safety": {"value": True, "category": "data_saver", "type": "boolean", "description": "Enable circuit limit safety"},
    "ds_circuit_buffer_pct": {"value": 5, "category": "data_saver", "type": "number", "min": 0, "max": 50, "unit": "%", "description": "Circuit breaker buffer percentage"},
    "ds_data_retention_days": {"value": 30, "category": "data_saver", "type": "number", "min": 1, "max": 365, "description": "Data retention (days)"},
    "ds_history_retention_days": {"value": 7, "category": "data_saver", "type": "number", "min": 1, "max": 90, "description": "History retention (days)"},
    "ds_cache_behavior": {"value": "auto", "category": "data_saver", "type": "select", "description": "Cache behaviour (auto/always/never)"},
    # ---- Market Data ----
    "md_broker_source": {"value": "kotak", "category": "market_data", "type": "select", "description": "Broker data source"},
    "md_quote_refresh_ms": {"value": 1000, "category": "market_data", "type": "number", "min": 250, "max": 60000, "unit": "ms", "description": "Quote refresh interval"},
    "md_websocket_usage": {"value": True, "category": "market_data", "type": "boolean", "description": "Use WebSocket for live data"},
    "md_rest_fallback": {"value": True, "category": "market_data", "type": "boolean", "description": "Fall back to REST when WebSocket unavailable"},
    "md_stale_threshold_ms": {"value": 5000, "category": "market_data", "type": "number", "min": 1000, "max": 60000, "description": "Stale data threshold (ms)"},
    "md_market_hours_behavior": {"value": "market_hours", "category": "market_data", "type": "select", "description": "Behaviour during market hours"},
    "md_nse_universe": {"value": "nse_cm", "category": "market_data", "type": "select", "description": "NSE universe behaviour"},
    # ---- WebSocket ----
    "ws_enabled": {"value": True, "category": "websocket", "type": "boolean", "description": "Enable broker WebSocket"},
    "ws_auto_reconnect": {"value": True, "category": "websocket", "type": "boolean", "description": "Automatically reconnect on disconnect"},
    "ws_max_reconnect_attempts": {"value": 0, "category": "websocket", "type": "number", "min": 0, "max": 100, "description": "Maximum reconnect attempts (0 = unlimited while market window is valid)"},
    "ws_reconnect_delay_ms": {"value": 5000, "category": "websocket", "type": "number", "min": 500, "max": 120000, "description": "Reconnect delay (ms)"},
    "ws_backoff": {"value": True, "category": "websocket", "type": "boolean", "description": "Use exponential backoff on reconnect"},
    "ws_heartbeat": {"value": True, "category": "websocket", "type": "boolean", "description": "Send heartbeat / ping"},
    "ws_tick_persistence": {"value": True, "category": "websocket", "type": "boolean", "description": "Persist ticks to MongoDB"},
    "ws_error_logging": {"value": True, "category": "websocket", "type": "boolean", "description": "Log WebSocket errors"},
    "ws_history_retention_days": {"value": 7, "category": "websocket", "type": "number", "min": 1, "max": 90, "description": "WebSocket history retention (days)"},
    # ---- Scheduler ----
    "sched_enabled": {"value": True, "category": "scheduler", "type": "boolean", "description": "Enable scheduler"},
    "sched_login_time": {"value": "08:50", "category": "scheduler", "type": "string", "description": "Scheduled login time (HH:MM)"},
    "sched_ws_start_time": {"value": "08:55", "category": "scheduler", "type": "string", "description": "Scheduled WebSocket connection time (HH:MM)"},
    "sched_tick_collection_start_time": {"value": "08:59", "category": "scheduler", "type": "string", "description": "Scheduled tick collection start time (HH:MM)"},
    "sched_ws_stop_time": {"value": "15:31", "category": "scheduler", "type": "string", "description": "Scheduled WebSocket stop time (HH:MM)"},
    "sched_logout_time": {"value": "16:00", "category": "scheduler", "type": "string", "description": "Scheduled logout time (HH:MM)"},
    "sched_pre_market_start_time": {"value": "09:00", "category": "scheduler", "type": "string", "description": "Pre-market phase start time (HH:MM)"},
    "sched_limit_order_start_time": {"value": "09:05", "category": "scheduler", "type": "string", "description": "Limit-order window start time (HH:MM)"},
    "sched_equilibrium_start_time": {"value": "09:10", "category": "scheduler", "type": "string", "description": "Equilibrium phase start time (HH:MM)"},
    "sched_buffer_start_time": {"value": "09:12", "category": "scheduler", "type": "string", "description": "Buffer phase start time (HH:MM)"},
    "sched_feed_start_time": {"value": "09:15", "category": "scheduler", "type": "string", "description": "Live feed phase start time (HH:MM)"},
    "sched_square_off_time": {"value": "15:16", "category": "scheduler", "type": "string", "description": "Square-off trigger time (HH:MM)"},
    "sched_feed_stop_time": {"value": "15:30", "category": "scheduler", "type": "string", "description": "Broker feed-stop time (HH:MM)"},
    "sched_square_off_enabled": {"value": True, "category": "scheduler", "type": "boolean", "description": "Allow the scheduler to trigger square-off at the configured time"},
    "sched_market_timezone": {"value": "Asia/Kolkata", "category": "scheduler", "type": "select", "description": "Market time zone"},
    "sched_trading_day_behavior": {"value": "trading_days", "category": "scheduler", "type": "select", "description": "Trading-day behaviour"},
    # ---- Security (settings organiser) ----
    "sec_app_lock": {"value": False, "category": "security", "type": "boolean", "description": "Lock the Data Saver UI after a timeout"},
    "sec_auto_lock": {"value": True, "category": "security", "type": "boolean", "description": "Automatically lock after the configured timeout"},
    "sec_auto_lock_timeout_min": {"value": 15, "category": "security", "type": "select", "description": "Auto-lock timeout (minutes)"},
    "sec_lock_on_background": {"value": True, "category": "security", "type": "boolean", "description": "Lock when the app is sent to the background"},
    "sec_lock_on_minimize": {"value": True, "category": "security", "type": "boolean", "description": "Lock when the PWA is minimised/backgrounded"},
    "sec_require_auth_unlock": {"value": True, "category": "security", "type": "boolean", "description": "Require authentication to unlock"},
    "sec_session_security": {"value": True, "category": "security", "type": "boolean", "description": "Secure the backend session"},
    "sec_clear_local_session": {"value": False, "category": "security", "type": "boolean", "description": "Clear local session on logout"},
    "sec_security_event_history": {"value": True, "category": "security", "type": "boolean", "description": "Record security events to history"},
    "sec_biometric_supported": {"value": False, "category": "security", "type": "boolean", "description": "Platform biometric authentication is currently available"},
    # ---- Notifications (settings organiser) ----
    "notif_enabled": {"value": True, "category": "notification", "type": "boolean", "description": "Enable notifications"},
    "notif_browser": {"value": False, "category": "notification", "type": "boolean", "description": "Browser notifications"},
    "notif_pwa": {"value": False, "category": "notification", "type": "boolean", "description": "PWA notifications"},
    "notif_sound_on": {"value": True, "category": "notification", "type": "boolean", "description": "Notification sound"},
    "notif_severity": {"value": "all", "category": "notification", "type": "select", "description": "Minimum notification severity to display"},
    "notif_system_events": {"value": True, "category": "notification", "type": "boolean", "description": "System event notifications"},
    "notif_websocket_alerts": {"value": True, "category": "notification", "type": "boolean", "description": "WebSocket alert notifications"},
    "notif_database_alerts": {"value": True, "category": "notification", "type": "boolean", "description": "Database alert notifications"},
    "notif_scheduler_alerts": {"value": True, "category": "notification", "type": "boolean", "description": "Scheduler alert notifications"},
    "notif_download_alerts": {"value": True, "category": "notification", "type": "boolean", "description": "Download alert notifications"},
    "notif_quality_alerts": {"value": True, "category": "notification", "type": "boolean", "description": "Data quality alert notifications"},
    "notif_scanner_alerts": {"value": True, "category": "notification", "type": "boolean", "description": "Scanner alert notifications"},
    "notif_retention_days": {"value": 60, "category": "notification", "type": "number", "min": 1, "max": 365, "description": "Days to keep read notifications before automatic cleanup (unread notifications are never auto-deleted)"},
    # ---- Notification engine knobs (real event -> notification pipeline) ----
    "notif_dedup_window_seconds": {"value": 300, "category": "notification", "type": "number", "min": 30, "max": 86400, "unit": "s", "description": "Grouping window — repeated real events within this window bump one notification instead of creating new ones"},
    "notif_recovery_notifications": {"value": True, "category": "notification", "type": "boolean", "description": "Send a notification when a recovery event resolves an alert"},
    "notif_realtime": {"value": True, "category": "notification", "type": "boolean", "description": "Publish notification changes to the live realtime channel"},
    # ---- Per-category notification display gates (Notifications page tabs) ----
    "notif_cat_market": {"value": True, "category": "notification", "type": "boolean", "description": "Market / session notifications"},
    "notif_cat_websocket": {"value": True, "category": "notification", "type": "boolean", "description": "WebSocket / broker feed notifications"},
    "notif_cat_session": {"value": True, "category": "notification", "type": "boolean", "description": "Login / trading session notifications"},
    "notif_cat_downloads": {"value": True, "category": "notification", "type": "boolean", "description": "Download notifications"},
    "notif_cat_exports": {"value": True, "category": "notification", "type": "boolean", "description": "Export notifications"},
    "notif_cat_subscriptions": {"value": True, "category": "notification", "type": "boolean", "description": "Subscription notifications"},
    "notif_cat_scheduler": {"value": True, "category": "notification", "type": "boolean", "description": "Scheduler notifications"},
    "notif_cat_data": {"value": True, "category": "notification", "type": "boolean", "description": "Tick persistence / data quality notifications"},
    "notif_cat_settings": {"value": True, "category": "notification", "type": "boolean", "description": "Settings-change notifications"},
    "notif_cat_system": {"value": True, "category": "notification", "type": "boolean", "description": "System / pipeline notifications"},
    "alert_retention_days": {"value": 90, "category": "notification", "type": "number", "description": "Days to keep resolved alerts before automatic cleanup"},
    # ---- DB Writer Tick Persistence (single authority) ----
    # The DB Write Engine is the ONLY owner of these three independent
    # permissions. Defaults are OFF. "1-day" is a session/subscription
    # classification, NOT a MongoDB TTL (no TTL index exists; expiry is
    # application-managed via expires_at / expiry_type).
    "dbw_personal_no_expiry_ticks": {"value": False, "category": "data_saver", "type": "boolean", "description": "[DB Writer] Persist ticks for personally subscribed stocks with NO expiry (permanent subscriptions)"},
    "dbw_personal_expiry_ticks": {"value": False, "category": "data_saver", "type": "boolean", "description": "[DB Writer] Persist ticks for personally subscribed stocks with 1-day/expiry lifecycle"},
    "dbw_market_watch_ticks": {"value": False, "category": "data_saver", "type": "boolean", "description": "[DB Writer] Persist ticks for Market Watch Engine's active universe"},
    # ---- DB Writer master switch (global kill-switch, NOT a per-stream rule) ----
    # Master OFF blocks EVERY tick write even if individual permissions are ON.
    # Master ON (default) means the three permissions above decide per stream.
    "dbw_ticks_enabled": {"value": True, "category": "data_saver", "type": "boolean", "description": "[DB Writer] Master switch: persist ANY ticks to MongoDB (OFF blocks every stream)"},
    # ---- DB Writer storage cap (operational brake, NOT a save rule) ----
    # A cap forces a stream OFF regardless of its permission above. It exists so
    # an operator can stop a high-volume stream while storage is tight, and it is
    # applied at the decision chokepoint so a direct settings write cannot defeat
    # it. Default OFF for all three: nothing is capped unless someone asks for it.
    "dbw_storage_cap_personal_no_expiry": {"value": False, "category": "data_saver", "type": "boolean", "description": "[DB Writer] Storage cap: temporarily block the personal no-expiry tick stream even if its permission is ON"},
    "dbw_storage_cap_personal_one_day": {"value": False, "category": "data_saver", "type": "boolean", "description": "[DB Writer] Storage cap: temporarily block the personal 1-day tick stream even if its permission is ON"},
    "dbw_storage_cap_market_watch_one_day": {"value": False, "category": "data_saver", "type": "boolean", "description": "[DB Writer] Storage cap: temporarily block the Market Watch tick stream even if its permission is ON"},
    "dbw_storage_cap_reason": {"value": "", "category": "data_saver", "type": "text", "description": "[DB Writer] Why a storage cap is active (shown verbatim in the DB Writer panel and API)"},

    # ---- Live Alert Center (notification center / alert engine knobs) ----
    "alerts_enabled": {"value": True, "category": "notification", "type": "boolean", "description": "Enable the alert engine (new alerts from real events)"},
    "alerts_severity_threshold": {"value": "all", "category": "notification", "type": "select", "options": ["all", "warning", "error", "critical"], "description": "Minimum severity that produces an alert"},
    "alerts_dedup_window_seconds": {"value": 600, "category": "notification", "type": "number", "min": 60, "max": 86400, "unit": "s", "description": "Dedupe / grouping window — repeated events within this window bump one alert instead of creating new ones"},
    "alerts_recovery_enabled": {"value": True, "category": "notification", "type": "boolean", "description": "Auto-resolve alerts when the recovery event fires"},
    "alerts_desktop_notifications": {"value": False, "category": "notification", "type": "boolean", "description": "Browser desktop notifications for new alerts"},
    # ---- Alert rule toggles (notification center / alert engine) ----
    "alert_ws_connected_enabled": {"value": True, "category": "alert", "type": "boolean", "description": "WebSocket connected alert"},
    "alert_ws_disconnected_enabled": {"value": True, "category": "alert", "type": "boolean", "description": "WebSocket disconnected alert"},
    "alert_ws_auth_failed_enabled": {"value": True, "category": "alert", "type": "boolean", "description": "WebSocket authentication failed alert"},
    "alert_db_connected_enabled": {"value": True, "category": "alert", "type": "boolean", "description": "Database connected alert"},
    "alert_db_disconnected_enabled": {"value": True, "category": "alert", "type": "boolean", "description": "Database disconnected alert"},
    "alert_market_open_enabled": {"value": True, "category": "alert", "type": "boolean", "description": "Market opened alert"},
    "alert_market_close_enabled": {"value": True, "category": "alert", "type": "boolean", "description": "Market closed alert"},
    "alert_subscriptions_enabled": {"value": True, "category": "alert", "type": "boolean", "description": "Subscription failure alert"},
    "alert_network_enabled": {"value": True, "category": "alert", "type": "boolean", "description": "Network error alert"},
    "alert_broker_error_enabled": {"value": True, "category": "alert", "type": "boolean", "description": "Broker error alert"},
    "alert_quality_enabled": {"value": True, "category": "alert", "type": "boolean", "description": "Data quality issue alert"},
    "alert_quality_resolved_enabled": {"value": True, "category": "alert", "type": "boolean", "description": "Data quality resolved alert"},
    "alert_persistence_enabled": {"value": True, "category": "alert", "type": "boolean", "description": "Persistence failure alert"},
    "alert_pipeline_enabled": {"value": True, "category": "alert", "type": "boolean", "description": "Pipeline failure alert"},
    "alert_scheduler_enabled": {"value": True, "category": "alert", "type": "boolean", "description": "Scheduler event alert"},
    "alert_scheduler_crash_enabled": {"value": True, "category": "alert", "type": "boolean", "description": "Scheduler crash alert"},
    "alert_login_enabled": {"value": True, "category": "alert", "type": "boolean", "description": "Login event alert"},
    "alert_mode_enabled": {"value": True, "category": "alert", "type": "boolean", "description": "Mode switch alert"},
    "alert_settings_enabled": {"value": True, "category": "alert", "type": "boolean", "description": "Settings change alert"},
    "alert_download_enabled": {"value": True, "category": "alert", "type": "boolean", "description": "Download event alert"},
    "alert_export_enabled": {"value": True, "category": "alert", "type": "boolean", "description": "Export event alert"},
    "alert_scanner_enabled": {"value": True, "category": "alert", "type": "boolean", "description": "Scanner event alert"},

    # ------------------------------------------------------------------
    # Per-engine settings.
    #
    # These back the Service Control Center's generic engine settings form
    # (core/engines/engine_config.py + GET/PATCH /api/services/engines/{id}/config).
    # Every key here is declared by exactly one engine's `config_fields`, so the
    # Control Center can offer a real, writable control for each engine instead
    # of showing knobs that only exist in a screenshot.
    # ------------------------------------------------------------------
    # Feature Engine
    "fe_rolling_window": {"value": 600, "category": "engine", "type": "number", "min": 1, "max": 86400, "description": "Feature Engine rolling window (seconds)"},
    # Market Coach Engine
    "mc_universe_size": {"value": 500, "category": "engine", "type": "number", "min": 10, "max": 5000, "description": "Market Coach universe size (stocks)"},
    "mc_refresh_interval_seconds": {"value": 300, "category": "engine", "type": "number", "min": 10, "max": 3600, "description": "Market Coach refresh interval (seconds)"},
    # Market Watch pin budgets — split from the legacy single mwr_max_pins so the
    # gainer and loser boards can be sized independently.
    "mwr_max_gainer_pins": {"value": 5, "category": "engine", "type": "number", "min": 0, "max": 50, "description": "Market Watch max gainer pins"},
    "mwr_max_loser_pins": {"value": 5, "category": "engine", "type": "number", "min": 0, "max": 50, "description": "Market Watch max loser pins"},
    # Session Manager
    "sm_session_lifetime_seconds": {"value": 3600, "category": "engine", "type": "number", "min": 60, "max": 86400, "description": "Session lifetime (seconds)"},
    "sm_expiry_warning_seconds": {"value": 900, "category": "engine", "type": "number", "min": 30, "max": 7200, "description": "Session expiry warning (seconds before)"},
    "sm_tick_active_window_seconds": {"value": 60, "category": "engine", "type": "number", "min": 1, "max": 3600, "description": "Tick-active window (seconds)"},
    # Storage Engine thresholds
    "stg_monitoring_enabled": {"value": True, "category": "engine", "type": "boolean", "description": "Storage Engine monitoring enabled"},
    "stg_sample_interval_seconds": {"value": 5, "category": "engine", "type": "number", "min": 1, "max": 300, "description": "Storage sample interval (seconds)"},
    "stg_history_max": {"value": 720, "category": "engine", "type": "number", "min": 10, "max": 100000, "description": "Storage history samples kept"},
    "stg_retention_seconds": {"value": 86400, "category": "engine", "type": "number", "min": 60, "max": 2592000, "description": "Storage sample retention (seconds)"},
    "stg_threshold_duration_samples": {"value": 3, "category": "engine", "type": "number", "min": 1, "max": 100, "description": "Samples a breach must persist"},
    "stg_cpu_warn_pct": {"value": 85, "category": "engine", "type": "number", "min": 1, "max": 100, "description": "CPU warn threshold (%)"},
    "stg_cpu_crit_pct": {"value": 95, "category": "engine", "type": "number", "min": 1, "max": 100, "description": "CPU critical threshold (%)"},
    "stg_mem_warn_pct": {"value": 85, "category": "engine", "type": "number", "min": 1, "max": 100, "description": "Memory warn threshold (%)"},
    "stg_mem_crit_pct": {"value": 95, "category": "engine", "type": "number", "min": 1, "max": 100, "description": "Memory critical threshold (%)"},
    "stg_disk_warn_pct": {"value": 85, "category": "engine", "type": "number", "min": 1, "max": 100, "description": "Disk warn threshold (%)"},
    "stg_disk_crit_pct": {"value": 95, "category": "engine", "type": "number", "min": 1, "max": 100, "description": "Disk critical threshold (%)"},
    "stg_queue_warn": {"value": 5000, "category": "engine", "type": "number", "min": 1, "max": 1000000, "description": "Queue warn depth"},
    "stg_queue_crit": {"value": 9000, "category": "engine", "type": "number", "min": 1, "max": 1000000, "description": "Queue critical depth"},
    "stg_latency_warn_ms": {"value": 250, "category": "engine", "type": "number", "min": 1, "max": 60000, "description": "Latency warn (ms)"},
    "stg_latency_crit_ms": {"value": 1000, "category": "engine", "type": "number", "min": 1, "max": 120000, "description": "Latency critical (ms)"},
    "stg_database_ping_enabled": {"value": True, "category": "engine", "type": "boolean", "description": "Ping the database each sample"},
    "stg_network_metrics_enabled": {"value": True, "category": "engine", "type": "boolean", "description": "Collect network metrics"},
    "stg_engine_health_aggregation_enabled": {"value": True, "category": "engine", "type": "boolean", "description": "Aggregate engine health into storage view"},
    # Square-Off Engine
    "sq_enabled": {"value": False, "category": "engine", "type": "boolean", "description": "Square-Off Engine auto square-off enabled"},
    "sq_trigger_time": {"value": "15:16", "category": "engine", "type": "string", "description": "Square-off trigger time (HH:MM IST)"},
    "sq_apply_to": {"value": "MIS", "category": "engine", "type": "select", "options": ["MIS", "CNC", "ALL"], "description": "Square-off applies to product"},
    # Margin Engine
    "mg_fallback_block_on_unavailable": {"value": True, "category": "engine", "type": "boolean", "description": "Block orders when broker margin is unavailable"},
    # Watchlist Engine
    "wl_default_watchlist": {"value": "my-stocks", "category": "engine", "type": "string", "description": "Default watchlist name"},
    # WebSocket Engine feed
    "ws_feed_broker": {"value": "kotak_neo_sfeed", "category": "engine", "type": "select", "options": ["kotak_neo_sfeed", "kotak_neo_ws", "dummy"], "description": "WebSocket feed source"},
    # Order Engine
    "oe_requires_broker_confirmation": {"value": True, "category": "engine", "type": "boolean", "description": "Require a broker order number before reporting accepted"},
}


async def get_setting(key: str):
    """Read a setting, resolving legacy schedule aliases to the live value."""
    db = get_db()
    key = resolve_schedule_alias(key)
    doc = await db.app_settings.find_one({"key": key})
    if doc:
        return doc["value"]
    return DEFAULTS.get(key, {}).get("value")


_SETTING_TYPE_VALIDATORS: dict = {}


def _validate_setting(key: str, value) -> None:
    """Validate a setting value against its declared type/min/max/options.

    Only the keys declared in DEFAULTS are accepted, and only values that
    match the declared schema. This prevents the browser from persisting
    arbitrary/unsafe values blindly.
    """
    defn = DEFAULTS.get(key)
    if defn is None:
        raise ValueError(f"Unknown setting: {key}")

    # terminal_mode_presets: must be a JSON object (string or raw dict).
    if key == "terminal_mode_presets":
        candidate = value if isinstance(value, dict) else (json.loads(value) if isinstance(value, str) else None)
        if not isinstance(candidate, dict):
            raise ValueError("terminal_mode_presets must be a JSON object")
        return

    dtype = defn.get("type")

    if dtype == "boolean":
        if not isinstance(value, bool):
            raise ValueError(f"Setting {key} must be a boolean")
        return

    if dtype in ("number", "select", "string", "text", None):
        # A few legacy keys store non-typed values; only enforce when typed.
        # "text" is the declared type of free-text operator notes (e.g.
        # dbw_storage_cap_reason); it validates exactly like "string" — without
        # it here the declared type was unwritable and every write was a 400.
        if dtype == "number":
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"Setting {key} must be a number")
            lo = defn.get("min")
            hi = defn.get("max")
            if lo is not None and value < lo:
                raise ValueError(f"Setting {key} must be >= {lo}")
            if hi is not None and value > hi:
                raise ValueError(f"Setting {key} must be <= {hi}")
        elif dtype == "select":
            options = defn.get("options")
            if options is not None and value not in options:
                raise ValueError(f"Setting {key} must be one of {', '.join(map(str, options))}")
        return

    raise ValueError(f"Setting {key} has an unknown type: {dtype}")


async def set_setting(key: str, value) -> dict:
    if key not in DEFAULTS:
        raise ValueError(f"Unknown setting: {key}")
    # Normalize a raw dict into the string contract for terminal_mode_presets.
    if key == "terminal_mode_presets" and isinstance(value, dict):
        value = json.dumps(value)
    # A legacy schedule alias (e.g. data_collection_start) is validated and
    # stored against its authoritative sched_* key, so the live schedule and
    # every UI mirror stay identical.
    target = resolve_schedule_alias(key)
    _validate_setting(key, value)
    db = get_db()
    now = datetime.now(timezone.utc)
    doc = {
        "key": target,
        "value": value,
        "category": DEFAULTS[key]["category"],
        "description": DEFAULTS[key]["description"],
        "updatedAt": now,
    }
    await db.app_settings.update_one({"key": target}, {"$set": doc}, upsert=True)
    # Drop any stale alias row so it can never re-shadow the authoritative value.
    if target != key:
        await db.app_settings.delete_one({"key": key})
    logger.info("Setting updated: %s -> %s", key, target)

    # Live runtime propagation: refresh the TTL cache, notify the state store
    # (system SSE stream) and apply the few settings with immediate side effects.
    try:
        from services.runtime_settings import refresh_runtime_settings
        await refresh_runtime_settings()
    except Exception as exc:
        logger.debug("Runtime settings cache refresh failed: %s", exc)

    try:
        from services.state_store import set_entity_state
        await set_entity_state(
            "settings", {"changed": key, "value": value, "updatedAt": now.isoformat()},
            reason=f"setting:{key}",
        )
    except Exception as exc:
        logger.debug("Settings change event not published: %s", exc)

    try:
        from services.event_bus import publish_event
        await publish_event(
            {
                "type": "settings_changed",
                "key": key,
                "value": value,
                "ts": now.isoformat(),
            }
        )
    except Exception as exc:
        logger.debug("Settings bus event not published: %s", exc)

    # ── Immediate side effects (live, never fake) ────────────────────────────
    # Route on the resolved target so that writing a legacy alias (e.g.
    # "data_collection_start") still re-evaluates the live lifecycle.
    try:
        if target == "sched_enabled":
            from scheduler import request_reconcile, start_scheduler, stop_scheduler
            if bool(value) is False:
                stop_scheduler()
            elif scheduler_is_running():
                request_reconcile()
            else:
                start_scheduler()
        elif target.startswith("sched_") or target == "ws_enabled":
            # Times / gating change → re-evaluate the lifecycle in a few ms.
            from scheduler import request_reconcile
            request_reconcile()
        elif target == "ds_collection_enabled":
            from services import tick_buffer
            if bool(value) is True:
                await tick_buffer.start()
            else:
                await tick_buffer.stop()
    except Exception as exc:
        logger.warning("Setting side-effect failed for %s: %s", key, exc)

    return doc


def scheduler_is_running() -> bool:
    try:
        from scheduler import get_scheduler_info
        return bool(get_scheduler_info().get("running"))
    except Exception:
        return False


async def get_all_settings() -> dict:
    db = get_db()
    docs = {
    d["key"]: d
    async for d in db.app_settings.find({})
    }
    result = {}
    for key, defn in DEFAULTS.items():
        # Legacy schedule aliases render the authoritative row's value, so the
        # UI can never show two different times for the same action.
        source = docs.get(resolve_schedule_alias(key))
        result[key] = {
            "key": key,
            "value": source["value"] if source else defn["value"],
            "category": defn["category"],
            "description": defn["description"],
            "updatedAt": source.get("updatedAt") if source else None,
        }
    return result


def get_setting_categories() -> list[str]:
    return list({d["category"] for d in DEFAULTS.values()})


async def reset_setting(key: str) -> dict:
    if key not in DEFAULTS:
        raise ValueError(f"Unknown setting: {key}")
    db = get_db()
    target = resolve_schedule_alias(key)
    await db.app_settings.delete_one({"key": target})
    if target != key:
        await db.app_settings.delete_one({"key": key})
    fallback = DEFAULTS[target]["value"]
    return {
        "key": key,
        "value": fallback,
        "category": DEFAULTS[key]["category"],
        "description": DEFAULTS[key]["description"],
        "updatedAt": None,
    }


async def reset_all_settings() -> dict:
    db = get_db()
    await db.app_settings.delete_many({})
    return await get_all_settings()

