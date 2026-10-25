"""READ-ONLY storage inspection for the KAUSTUBH cluster.

Reports every database on the cluster with its real size, so the gap between
the APP-level storage guard (which measures one database) and the ATLAS-level
cluster quota (which measures the whole cluster) is visible.

Nothing is written or deleted by this script.

Run:  python tools/storage_report.py
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

    await connect_mongo()
    db = get_db()
    try:
        stats = await db.command("dbStats")
    except Exception as exc:
        print(f"dbStats failed: {exc}")
        return 1

    def mb(value) -> float:
        try:
            return round(int(value) / 1048576, 2)
        except (TypeError, ValueError):
            return 0.0

    print("=== this database ===")
    print(f"  name          : {stats.get('db')}")
    print(f"  data          : {mb(stats.get('dataSize'))} MB")
    print(f"  storage       : {mb(stats.get('storageSize'))} MB")
    print(f"  index         : {mb(stats.get('indexSize'))} MB")
    print(f"  total         : {mb(stats.get('dataSize')) + mb(stats.get('indexSize'))} MB")
    print(f"  objects       : {stats.get('objects')}")
    print(f"  collections   : {stats.get('collections')}")

    print("\n=== every collection in this database (by storage) ===")
    rows = []
    try:
        for name in await db.list_collection_names():
            try:
                c = await db.command("collStats", name)
                rows.append((mb(c.get("storageSize")) + mb(c.get("indexSize")),
                             mb(c.get("storageSize")), mb(c.get("indexSize")),
                             c.get("count", 0), name))
            except Exception:
                continue
    except Exception as exc:
        print(f"  collection list failed: {exc}")
    for total, data, index, count, name in sorted(rows, reverse=True):
        print(f"  {total:9.2f} MB  (data {data:8.2f} / idx {index:7.2f})  {count:>9} docs  {name}")

    print("\n=== other databases on the cluster (if visible) ===")
    try:
        from database import connection as conn_mod

        client = getattr(conn_mod, "_client", None)
        if client is None:
            print("  no client handle available")
        else:
            names = await client.list_database_names()
            for name in names:
                if name == stats.get("db"):
                    continue
                try:
                    s = await client["admin"].command("dbStats", name)
                    total = mb(s.get("storageSize")) + mb(s.get("indexSize"))
                    print(f"  {total:9.2f} MB  {name}  (collections={s.get('collections')})")
                except Exception as exc:
                    print(f"  {'?':>9}      {name}  ({exc})")
    except Exception as exc:
        print(f"  admin listing not permitted: {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
