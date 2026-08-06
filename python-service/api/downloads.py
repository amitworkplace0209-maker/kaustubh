"""Download export — CSV, JSON, JSONL, NDJSON, TXT, XLSX."""
from __future__ import annotations

import csv
import io
import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse, Response

from database.connection import get_db

router = APIRouter(prefix="/api/downloads", tags=["downloads"])
logger = logging.getLogger("app")

FIELDS = [
    "symbol", "timestamp", "ltp", "open", "high", "low", "close",
    "volume", "ltq", "tbq", "tsq", "bp", "sp", "bq", "bs",
    "averagePrice", "change", "changePercent", "oi",
]


def _map_tick(t: dict) -> dict:
    ts = t.get("ts")
    if isinstance(ts, datetime):
        ts = ts.isoformat()
    return {
        "symbol": t.get("symbol", ""),
        "timestamp": ts or "",
        "ltp": t.get("ltp"),
        "open": t.get("open"),
        "high": t.get("high"),
        "low": t.get("low"),
        "close": t.get("close"),
        "volume": t.get("volume"),
        "ltq": t.get("ltq"),
        "tbq": t.get("tbq"),
        "tsq": t.get("tsq"),
        "bp": t.get("bp"),
        "sp": t.get("sp"),
        "bq": t.get("bq"),
        "bs": t.get("bs"),
        "averagePrice": t.get("averagePrice"),
        "change": t.get("change"),
        "changePercent": t.get("changePercent"),
        "oi": t.get("oi"),
    }


async def _get_ticks(symbols: list[str], start: str | None, end: str | None, limit: int = 50000) -> list[dict]:
    db = get_db()
    query = {}
    if symbols:
        query["symbol"] = {"$in": [s.upper() for s in symbols]}
    if start or end:
        ts_filter = {}
        if start:
            try:
                ts_filter["$gte"] = datetime.fromisoformat(start.replace("Z", "+00:00"))
            except ValueError:
                pass
        if end:
            try:
                ts_filter["$lte"] = datetime.fromisoformat(end.replace("Z", "+00:00"))
            except ValueError:
                pass
        if ts_filter:
            query["ts"] = ts_filter
    limit = min(max(limit, 1), 100000)
    cursor = db.ticks.find(query).sort("ts", 1).limit(limit)
    ticks = await cursor.to_list(length=limit)
    return [_map_tick(t) for t in ticks]


async def _record_download(db, symbols: list[str], fmt: str, count: int):
    await db.download_history.insert_one({
        "symbols": symbols,
        "format": fmt,
        "count": count,
        "ts": datetime.now(timezone.utc),
    })


@router.get("")
async def download_data(
    request: Request,
    symbol: str = "",
    symbols: str = "",
    start: str = "",
    end: str = "",
    limit: int = 50000,
    format: str = "csv",
    all: str = "false",
):
    db = get_db()

    if all.lower() == "true" or (not symbol and not symbols):
        cursor = db.stocks.find({"active": True})
        active = await cursor.to_list(length=None)
        sym_list = [s["symbol"] for s in active]
    else:
        sym_list = [s.strip() for s in (symbols or symbol).split(",") if s.strip()]

    ticks = await _get_ticks(sym_list, start or None, end or None, limit)
    await _record_download(db, sym_list, format, len(ticks))

    ts_str = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    name = sym_list[0] if len(sym_list) == 1 else f"{len(sym_list)}stocks"
    filename = f"ticks_{name}_{ts_str}"

    fmt = format.lower()

    if fmt == "csv":
        output = io.StringIO()
        writer = csv.DictWriter(output, fieldnames=FIELDS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(ticks)
        return Response(
            content=output.getvalue(),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{filename}.csv"'},
        )

    if fmt == "json":
        return Response(
            content=json.dumps(ticks, indent=2, default=str),
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{filename}.json"'},
        )

    if fmt in ("jsonl", "ndjson"):
        lines = "\n".join(json.dumps(t, default=str) for t in ticks)
        return Response(
            content=lines,
            media_type="application/x-ndjson",
            headers={"Content-Disposition": f'attachment; filename="{filename}.{fmt}"'},
        )

    if fmt == "txt":
        output = io.StringIO()
        output.write("\t".join(FIELDS) + "\n")
        for t in ticks:
            output.write("\t".join(str(t.get(f, "")) for f in FIELDS) + "\n")
        return Response(
            content=output.getvalue(),
            media_type="text/plain",
            headers={"Content-Disposition": f'attachment; filename="{filename}.txt"'},
        )

    if fmt in ("xlsx", "excel"):
        output = io.StringIO()
        output.write("<table>\n<tr>")
        for f in FIELDS:
            output.write(f"<th>{f}</th>")
        output.write("</tr>\n")
        for t in ticks:
            output.write("<tr>")
            for f in FIELDS:
                output.write(f"<td>{t.get(f, '')}</td>")
            output.write("</tr>\n")
        output.write("</table>")
        return Response(
            content=output.getvalue(),
            media_type="application/vnd.ms-excel",
            headers={"Content-Disposition": f'attachment; filename="{filename}.xls"'},
        )

    # Fallback: CSV
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=FIELDS, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(ticks)
    return Response(
        content=output.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}.csv"'},
    )
