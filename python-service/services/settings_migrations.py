"""Startup migrations for persisted settings.

The session-lifecycle schedule uses 09:00 login / 09:13 WebSocket connect /
09:14 tick collection (required market-day schedule). Fresh installs pick
these values up from ``settings_service.DEFAULTS`` automatically; existing
installs may have already persisted the OLD default times (08:50/08:55/08:59)
into MongoDB. This module bumps ONLY values that still equal the legacy
default, so a genuine operator override is never clobbered. It is safe
and idempotent.
"""
from __future__ import annotations

import logging

logger = logging.getLogger("runtime_settings")

LEGACY_LOGIN_DEFAULT = "08:50"   # old persisted default -> new 09:00
LEGACY_WS_DEFAULT = "08:55"      # old persisted default -> new 09:13
LEGACY_PREP_DEFAULT = "08:25"    # old persisted prep time -> removed
LEGACY_TICK_DEFAULT = "08:59"    # old persisted tick collection -> new 09:14


async def migrate_scheduler_times() -> None:
    """Migrate legacy-default scheduler times in MongoDB to the required defaults.

    - ``sched_login_time`` == "08:50"  -> "09:00"
    - ``sched_ws_start_time`` == "08:55" -> "09:13"
    - ``sched_ws_start_time`` == "08:25" (prep) -> "09:13"
    - ``sched_tick_collection_start_time`` == "08:59" -> "09:14"

    Only exact legacy-default matches are migrated (operator overrides are
    left untouched), and running it repeatedly is a no-op.
    """
    try:
        from database.connection import get_db
        from services.settings_service import set_setting

        db = get_db()
        applied: list[str] = []
        docs = {
            d["key"]: d["value"]
            async for d in db.app_settings.find({"key": {"$in": ["sched_login_time", "sched_ws_start_time", "sched_tick_collection_start_time"]}})
        }
        if docs.get("sched_login_time") == LEGACY_LOGIN_DEFAULT:
            await set_setting("sched_login_time", "09:00")
            applied.append("sched_login_time")
        if docs.get("sched_ws_start_time") in {LEGACY_WS_DEFAULT, LEGACY_PREP_DEFAULT}:
            await set_setting("sched_ws_start_time", "09:13")
            applied.append("sched_ws_start_time")
        if docs.get("sched_tick_collection_start_time") == LEGACY_TICK_DEFAULT:
            await set_setting("sched_tick_collection_start_time", "09:14")
            applied.append("sched_tick_collection_start_time")
        if applied:
            logger.info(
                "Migrated legacy scheduler times to the 09:00/09:13/09:14 schedule: %s",
                ", ".join(applied),
            )
    except Exception as exc:
        logger.warning("Scheduler settings migration skipped: %s", exc)


async def migrate_schedule_aliases() -> None:
    """Delete legacy schedule rows that shadow the authoritative ``sched_*`` key.

    Several legacy keys (``scheduler_login_time``, ``data_collection_start``,
    ``auto_login_time``, ``square_off_time`` …) each persisted their own time
    that contradicted the real schedule (e.g. ``scheduler_login_time`` = "08:55"
    while the scheduler logs in at 08:50). Those keys were never read by the
    scheduler, so their stored value is meaningless and MUST NOT be promoted
    into the authoritative key — the ``sched_*`` default/current value is the
    single source of truth. ``settings_service`` now resolves these names as
    aliases on read/write, so the Settings UI keeps working and always shows
    the live value.

    Idempotent: a second run finds no legacy rows and does nothing.
    """
    try:
        from database.connection import get_db
        from services.settings_service import SCHEDULE_ALIASES

        db = get_db()
        aliases = sorted(SCHEDULE_ALIASES)
        stale = [
            d["key"]
            async for d in db.app_settings.find(
                {"key": {"$in": aliases}}, {"key": 1, "_id": 0}
            )
        ]
        if not stale:
            return
        await db.app_settings.delete_many({"key": {"$in": stale}})
        logger.info(
            "Removed %d legacy schedule key(s) that shadowed the sched_* source of truth: %s",
            len(stale),
            ", ".join(stale),
        )
    except Exception as exc:
        logger.warning("Schedule alias migration skipped: %s", exc)