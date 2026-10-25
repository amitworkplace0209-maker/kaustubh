"""Bounded storage reclaim for the KAUSTUBH cluster.

Why this exists
---------------
The app-level storage guard measures ONE database (``kaustubh``), but Atlas
enforces the quota on the WHOLE CLUSTER. The cluster can therefore be
write-blocked ("you are over your space quota") while the app database still
reports ~43 % of the budget — the guard then never prunes, and every write
path in the product fails (tick persistence, the paper market feed, the
session store, the export worker).

Deletes are still accepted while the cluster is write-blocked, so reclaiming
space from the collections the product already treats as disposable and
regenerable unblocks the cluster.

What it NEVER touches
---------------------
Orders, positions, audit trail, sessions, settings, watchlists, notifications
and every other non-regenerable collection. Only these are pruned — the same
list the storage guard and the daily 06:00 IST wipe already treat as
disposable:

    market_ticks, ticks, market_candles_1m/2m/5m/10m/30m

Usage:
    python tools/storage_reclaim.py --dry-run
    python tools/storage_reclaim.py --max-docs 200000
    python tools/storage_reclaim.py --write-probe
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys

from pymongo import DeleteOne

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

#: Disposable, regenerable market data (same set the guard/wipe prune).
PRUNABLE = (
    "market_ticks",
    "ticks",
    "market_candles_1m",
    "market_candles_2m",
    "market_candles_5m",
    "market_candles_10m",
    "market_candles_30m",
)

BATCH = 5_000


async def _usage(db) -> tuple[float, float]:
    s = await db.command("dbStats")
    return (
        round((s.get("storageSize", 0) + s.get("indexSize", 0)) / 1048576, 2),
        round(s.get("dataSize", 0) / 1048576, 2),
    )


async def _write_probe(db) -> bool:
    """True when the cluster accepts a write again."""
    try:
        await db["_storage_probe"].insert_one({"at": asyncio.get_event_loop().time()})
        await db["_storage_probe"].delete_many({})
        return True
    except Exception as exc:
        print(f"  write probe FAILED: {str(exc)[:200]}")
        return False


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--max-docs", type=int, default=200_000)
    parser.add_argument("--write-probe", action="store_true")
    args = parser.parse_args()

    from database.connection import connect_mongo, get_db

    await connect_mongo()
    db = get_db()

    stored, logical = await _usage(db)
    print(f"before: stored+index={stored} MB  logical data={logical} MB")

    names = set(await db.list_collection_names())
    budget = max(0, args.max_docs)
    total_deleted = 0

    for name in PRUNABLE:
        if name not in names:
            continue
        coll = db[name]
        # Oldest first, by the indexed event time when the collection has it.
        try:
            dates = sorted({str(v) for v in await coll.distinct("date") if v not in (None, "")})
        except Exception:
            dates = []
        if not dates:
            continue
        oldest_day = dates[0]
        count = await coll.count_documents({"date": oldest_day})
        print(f"  {name}: day {oldest_day} -> {count} docs")
        if args.dry_run:
            continue

        deleted_here = 0
        while budget > 0:
            take = min(BATCH, budget)
            cursor = (
                coll.find({"date": oldest_day}, {"_id": 1})
                .sort([("lastTickAt", 1), ("ts", 1)])
                .limit(take)
            )
            ids = [doc["_id"] async for doc in cursor]
            if not ids:
                break
            try:
                # NOTE: a single `delete_many({"_id": {"$in": [...]}})` is
                # CANCELLED by the cluster's quota guard while it is
                # write-blocked (it reports acknowledged=True / deleted=0 and
                # silently removes nothing). Per-document DeleteOne ops in one
                # bulk write go through, so the reclaim uses that form.
                res = await coll.bulk_write([DeleteOne({"_id": i}) for i in ids])
            except Exception as exc:
                print(f"    DELETE BLOCKED on {name}: {str(exc)[:200]}")
                break
            n = int(res.deleted_count or 0)
            if n == 0:
                break
            deleted_here += n
            budget -= n
            total_deleted += n
            print(f"    {name}: deleted {n} (total {deleted_here})")
        if deleted_here:
            print(f"  {name}: {deleted_here} docs deleted")

    stored, logical = await _usage(db)
    print(f"after:  stored+index={stored} MB  logical data={logical} MB")
    print(f"total deleted: {total_deleted}")

    if args.write_probe:
        ok = await _write_probe(db)
        print(f"cluster writable: {'YES' if ok else 'NO'}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
