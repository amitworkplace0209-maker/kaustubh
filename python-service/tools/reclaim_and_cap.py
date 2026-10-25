"""Reclaim the Atlas quota and cap the tick write flood (one-off operator tool).

1. Deletes the oldest regenerable market data until the cluster accepts writes
   again (the cluster only lets a limited amount of delete work through while
   it is write-blocked, so the tool is run in rounds).
2. Turns the DB Writer's Market-Watch tick persistence OFF (the setting
   ``dbw_storage_cap_market_watch_one_day``) so the cluster is not refilled
   as fast as it is trimmed — that flood is what pushed the 512 MB cluster
   over its quota and made every page feel hung.

Run:  python tools/reclaim_and_cap.py
"""
from __future__ import annotations

import asyncio
import os
import sys

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)


async def main() -> int:
    from database.connection import connect_mongo, get_db
    from services import storage_guard

    await connect_mongo()
    db = get_db()

    print("--- storage before ---")
    status = await storage_guard.storage_guard_status()
    print(f"  usedMb={status.get('usedMb')} usagePct={status.get('usagePct')} "
          f"budget={status.get('budgetMb')} overBudget={status.get('overBudget')}")

    print("--- trimming (rounds) ---")
    for round_no in range(1, 7):
        report = await storage_guard.run_storage_guard(trigger="manual-reclaim")
        deleted = report.get("deleted") or {}
        total = sum(deleted.values()) if isinstance(deleted, dict) else 0
        print(f"  round {round_no}: deleted={total} usedAfter={report.get('usedMbAfter')} "
              f"reason={report.get('reason')}")
        if not total:
            break
        if report.get("usedMbAfter") is not None and report.get("usedMbAfter", 999) <= 180:
            break

    print("--- capping the Market Watch tick stream ---")
    try:
        await db["app_settings"].update_one(
            {"key": "dbw_storage_cap_market_watch_one_day"},
            {"$set": {
                "value": True,
                "category": "data_saver",
                "description": (
                    "[DB Writer] Storage cap: the Market Watch tick stream is capped — the "
                    "512 MB Atlas cluster is write-blocked by it, which makes every page hang"
                ),
                "updatedAt": None,
            }},
            upsert=True,
        )
        print("  dbw_storage_cap_market_watch_one_day = true")
    except Exception as exc:
        print(f"  could not set the cap: {str(exc)[:200]}")

    print("--- write probe ---")
    try:
        await db["market_ticks"].insert_one({"probe": 1})
        print("  cluster writable: YES")
        await db["market_ticks"].delete_many({"probe": 1})
    except Exception as exc:
        print(f"  cluster writable: NO — {str(exc)[:160]}")

    status = await storage_guard.storage_guard_status()
    print(f"--- storage after: usedMb={status.get('usedMb')} usagePct={status.get('usagePct')}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
