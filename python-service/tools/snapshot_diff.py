"""Diff two consecutive snapshot documents to find volatile fields.

    python -m tools.snapshot_diff [channel] [gap_seconds]
"""
from __future__ import annotations

import asyncio
import json
import sys

sys.path.insert(0, ".")

from connection_engine import snapshots  # noqa: E402


def walk(a, b, path=""):
    """Yield (path, a_value, b_value) for every leaf that differs."""
    if type(a) is not type(b):
        yield (path, a, b)
        return
    if isinstance(a, dict):
        for key in set(a) | set(b):
            if key not in a:
                yield (f"{path}.{key}", "<missing>", b[key])
            elif key not in b:
                yield (f"{path}.{key}", a[key], "<missing>")
            else:
                yield from walk(a[key], b[key], f"{path}.{key}")
    elif isinstance(a, list):
        if len(a) != len(b):
            yield (f"{path}[len]", len(a), len(b))
        for i, (x, y) in enumerate(zip(a, b)):
            yield from walk(x, y, f"{path}[{i}]")
    elif a != b:
        yield (path, a, b)


async def main() -> None:
    channel = sys.argv[1] if len(sys.argv) > 1 else "system"
    gap = float(sys.argv[2]) if len(sys.argv) > 2 else 2.0

    # Connect MongoDB so the snapshot looks like the running backend's.
    try:
        from database.connection import connect_mongo

        await connect_mongo()
    except Exception as exc:  # noqa: BLE001 — best effort
        print(f"mongo connect skipped: {exc!r}")

    first = await snapshots.build_snapshot(channel)
    await asyncio.sleep(gap)
    second = await snapshots.build_snapshot(channel)

    if first is None or second is None:
        print("build failed")
        return

    print(f"fingerprint equal: {snapshots.snapshot_fingerprint(first) == snapshots.snapshot_fingerprint(second)}")
    raw = list(walk(first, second))
    print(f"raw leaf diffs: {len(raw)}")
    stripped_first = snapshots._strip_volatile(first)
    stripped_second = snapshots._strip_volatile(second)
    diffs = list(walk(stripped_first, stripped_second))
    print(f"leaf diffs AFTER volatile strip: {len(diffs)}")
    for path, a, b in diffs[:80]:
        sa = json.dumps(a, default=str)
        sb = json.dumps(b, default=str)
        if len(sa) > 120:
            sa = sa[:120] + "…"
        if len(sb) > 120:
            sb = sb[:120] + "…"
        print(f"  {path}: {sa}  ->  {sb}")


if __name__ == "__main__":
    asyncio.run(main())
