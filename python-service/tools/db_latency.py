"""READ-ONLY + tiny-write latency probe for the MongoDB connection.

Prints the real latency of the operations the request path depends on, so a
"the page hangs" report can be traced to the database instead of guessed at.
"""
from __future__ import annotations

import asyncio
import os
import sys
import time

_PY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)


async def main() -> int:
    from database.connection import connect_mongo, get_db

    t = time.time()
    await connect_mongo()
    print(f"connect      {int((time.time() - t) * 1000)} ms")

    db = get_db()

    t = time.time()
    await db.command("ping")
    print(f"ping         {int((time.time() - t) * 1000)} ms")

    t = time.time()
    s = await db.command("dbStats")
    total = (s.get("storageSize", 0) + s.get("indexSize", 0)) / 1048576
    print(f"dbStats      {int((time.time() - t) * 1000)} ms  storage+index={total:.1f} MB")

    t = time.time()
    n = await db["market_candles_1m"].count_documents({"date": {"$gte": "2026-10-20"}})
    print(f"count        {int((time.time() - t) * 1000)} ms  n={n}")

    t = time.time()
    try:
        await db["market_ticks"].insert_one({"probe": 1})
        print(f"write        {int((time.time() - t) * 1000)} ms  OK")
        await db["market_ticks"].delete_many({"probe": 1})
    except Exception as exc:
        print(f"write        {int((time.time() - t) * 1000)} ms  FAILED: {str(exc)[:140]}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
