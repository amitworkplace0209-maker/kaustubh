"""
Download export — 25 formats with serializer architecture.
Supports multi-format download and multi-stock ZIP packaging.
"""
from __future__ import annotations

import io
import logging
import time
import zipfile
from collections import defaultdict
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, Response

from database.connection import get_db
from services.serializers import get_serializer, available_formats, REGISTRY

router = APIRouter(prefix="/api/downloads", tags=["downloads"])
logger = logging.getLogger("app")

FIELDS = [
    "symbol", "instrumentToken", "exchangeSegment",
    "timestamp", "ts", "receivedAt",
    "ltp", "open", "high", "low", "close",
    "averagePrice", "change", "changePercent",
    "volume", "ltq", "tbq", "tsq",
    "bp", "sp", "bq", "bs", "oi",
]

DEFAULT_FIELDS = [
    "symbol", "instrumentToken", "ltp", "open", "high", "low", "close",
    "volume", "ltq", "tbq", "tsq", "bp", "sp", "bq", "bs", "ts", "receivedAt",
]


def _iso_utc(dt: datetime) -> str:
    """Naive datetimes from Mongo are UTC — tag them explicitly."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def _map_tick(t: dict) -> dict:
    from services.tick_field_resolver import get_depth, get_field

    ts = t.get("ts")
    received_at = t.get("receivedAt")
    if isinstance(ts, datetime):
        ts = _iso_utc(ts)
    if isinstance(received_at, datetime):
        received_at = _iso_utc(received_at)
    buy = get_depth(t, "buy")
    sell = get_depth(t, "sell")
    return {
        "symbol": t.get("symbol", ""),
        "instrumentToken": t.get("instrumentToken", ""),
        "exchangeSegment": t.get("exchangeSegment", ""),
        "timestamp": ts or "",
        "ts": ts or "",
        "receivedAt": received_at or "",
        "ltp": get_field(t, "ltp"), "open": get_field(t, "open"),
        "high": get_field(t, "high"), "low": get_field(t, "low"),
        "close": get_field(t, "close"), "averagePrice": get_field(t, "averagePrice"),
        "change": get_field(t, "change"), "changePercent": get_field(t, "changePercent"),
        "volume": get_field(t, "volume"), "ltq": get_field(t, "ltq"),
        "tbq": get_field(t, "tbq"), "tsq": get_field(t, "tsq"),
        "bp": buy[0].get("price") if buy else None,
        "sp": sell[0].get("price") if sell else None,
        "bq": buy[0].get("quantity") if buy else None,
        "bs": buy[0].get("quantity") if buy else None,
        "oi": get_field(t, "oi"),
    }


async def _get_ticks(symbols, start, end, limit=50000):
    db = get_db()
    query: dict = {}
    if symbols:
        query["symbol"] = {"$in": [s.upper() for s in symbols]}
    if start or end:
        ts_filter: dict = {}
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


def _resolve_fields(fields_str: str) -> list[str]:
    if not fields_str or not fields_str.strip():
        return list(FIELDS)
    requested = [f.strip() for f in fields_str.split(",") if f.strip()]
    validated = [f for f in requested if f in FIELDS]
    return validated if validated else list(FIELDS)


def _render_filename(pattern: str, symbol: str, ext: str, run_date: str = "", time_str: str = "", date_range: str = "") -> str:
    """Render a naming pattern with variables."""
    from datetime import datetime as _dt
    now = _dt.now(timezone.utc)
    date_str = run_date or now.strftime("%Y-%m-%d")
    time_val = time_str or now.strftime("%H-%M-%S")
    return (
        pattern
        .replace("{symbol}", symbol)
        .replace("{date}", date_str)
        .replace("{ext}", ext)
        .replace("{format}", ext)
        .replace("{time}", time_val)
        .replace("{range}", date_range or date_str)
        .replace("{year}", date_str[:4] if len(date_str) >= 4 else str(now.year))
        .replace("{month}", date_str[5:7] if len(date_str) >= 7 else f"{now.month:02d}")
        .replace("{day}", date_str[8:10] if len(date_str) >= 10 else f"{now.day:02d}")
        .replace("{timestamp}", now.strftime("%Y%m%d_%H%M%S"))
    )


def _get_tick_date(tick: dict) -> str:
    """Extract YYYY-MM-DD date from a tick's ts field."""
    ts = tick.get("ts", "")
    if isinstance(ts, str) and len(ts) >= 10:
        return ts[:10]
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _date_range_str(start: str, end: str) -> str:
    """Build a date string for filenames from start/end params."""
    start_date = ""
    end_date = ""
    if start:
        try:
            start_date = datetime.fromisoformat(start.replace("Z", "+00:00")).strftime("%Y-%m-%d")
        except (ValueError, AttributeError):
            pass
    if end:
        try:
            end_date = datetime.fromisoformat(end.replace("Z", "+00:00")).strftime("%Y-%m-%d")
        except (ValueError, AttributeError):
            pass
    if start_date and end_date and start_date != end_date:
        return f"{start_date}_to_{end_date}"
    return start_date or end_date or datetime.now(timezone.utc).strftime("%Y-%m-%d")


async def _record_download(db, symbols, fmt, count, fields, date_start, date_end,
                           source="manual", file_size=0, duration_ms=0):
    await db.download_history.insert_one({
        "symbols": symbols,
        "symbolCount": len(symbols),
        "format": fmt,
        "count": count,
        "fields": fields,
        "dateStart": date_start,
        "dateEnd": date_end,
        "source": source,
        "fileSizeBytes": file_size,
        "durationMs": round(duration_ms, 1),
        "status": "success",
        "ts": datetime.now(timezone.utc),
    })


_FIELD_SOURCE = {
    "symbol": "Broker tick stream",
    "instrumentToken": "Broker tick stream",
    "exchangeSegment": "Broker tick stream",
    "timestamp": "Broker tick stream",
    "ts": "Broker tick stream",
    "receivedAt": "System (ingest)",
    "ltp": "Broker tick stream",
    "open": "Broker tick stream",
    "high": "Broker tick stream",
    "low": "Broker tick stream",
    "close": "Broker tick stream",
    "averagePrice": "Broker tick stream",
    "change": "Derived (ltp - open)",
    "changePercent": "Derived (change / open)",
    "volume": "Broker tick stream",
    "ltq": "Broker tick stream",
    "tbq": "Broker tick stream",
    "tsq": "Broker tick stream",
    "bp": "Broker tick stream",
    "sp": "Broker tick stream",
    "bq": "Broker tick stream",
    "bs": "Broker tick stream",
    "oi": "Broker tick stream",
}

_FIELD_DESC = {
    "symbol": "Trading symbol / ticker (e.g. RELIANCE)",
    "instrumentToken": "NSE/Kotak instrument token",
    "exchangeSegment": "Exchange segment code (NSE_EQ etc.)",
    "timestamp": "Exchange timestamp of the tick",
    "ts": "Market timestamp of the tick (primary sort key)",
    "receivedAt": "UTC time the tick was ingested by this system",
    "ltp": "Last traded price",
    "open": "Open price",
    "high": "High price",
    "low": "Low price",
    "close": "Close price",
    "averagePrice": "Volume-weighted average price",
    "change": "Absolute change (ltp - open)",
    "changePercent": "Percentage change vs open",
    "volume": "Cumulative traded volume",
    "ltq": "Last traded quantity",
    "tbq": "Total buy quantity",
    "tsq": "Total sell quantity",
    "bp": "Best bid price",
    "sp": "Best ask price",
    "bq": "Best bid quantity",
    "bs": "Best ask quantity",
    "oi": "Open interest",
}


def _python_type_name(v) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "Boolean"
    if isinstance(v, (int, float)):
        return "Number"
    if isinstance(v, datetime):
        return "Datetime"
    if isinstance(v, str):
        return "Text"
    return type(v).__name__


async def _derive_field_details(db) -> list[dict]:
    """Real per-field metadata derived from a live sample tick document and the
    export field registry. Types come from actual Mongo values — never wrapped."""
    sample = None
    try:
        cursor = db.ticks.find({}).sort("ts", -1).limit(1)
        docs = await cursor.to_list(length=1)
        sample = docs[0] if docs else None
    except Exception as exc:
        logger.warning("Field sample failed: %s", exc)

    fmt_ids = [f["id"] for f in available_formats()]
    default_set = set(DEFAULT_FIELDS)
    details = []
    for name in FIELDS:
        value = sample.get(name) if isinstance(sample, dict) else None
        details.append({
            "name": name,
            "type": _python_type_name(value) if isinstance(sample, dict) else "—",
            "source": _FIELD_SOURCE.get(name, "System"),
            "description": _FIELD_DESC.get(name, ""),
            "isDefault": name in default_set,
            "formatIds": list(fmt_ids),
        })
    return details


@router.get("/formats")
async def list_formats():
    from services import settings_service
    default_format = await settings_service.get_setting("download_default_format")
    fmts = available_formats()
    return {
        "formats": fmts,
        "defaultFormat": default_format,
        "total": len(fmts),
        "availableCount": sum(1 for f in fmts if f.get("available")),
        "categories": sorted({f.get("category", "Other") for f in fmts}),
    }


@router.get("/fields")
async def list_fields():
    db = get_db()
    details = await _derive_field_details(db)
    return {
        "fields": FIELDS,
        "defaultFields": DEFAULT_FIELDS,
        "fieldDetails": details,
    }


@router.get("/preview")
async def download_preview(
    symbol: str = "",
    symbols: str = "",
    start: str = "",
    end: str = "",
    limit: int = 50000,
    format: str = "csv",
    all: str = "false",
    fields: str = "",
):
    """Real pre-download estimates for the Data Center preview panel.

    Counts documents with the SAME query the export will run (no fabricated
    numbers) and measures average serialized bytes per record from a small
    sample of actual ticks to project file size.
    """
    db = get_db()

    if all.lower() == "true" or (not symbol and not symbols):
        cursor = db.stocks.find({"active": True})
        active = await cursor.to_list(length=None)
        sym_list = [s["symbol"] for s in active]
    else:
        sym_list = [s.strip().upper() for s in (symbols or symbol).split(",") if s.strip()]

    if not sym_list:
        return {
            "symbolCount": 0,
            "symbols": [],
            "estimatedRecords": 0,
            "serverRowLimit": 0,
            "effectiveRecords": 0,
            "estimatedSizeBytes": 0,
            "willTruncate": False,
        }

    selected_fields = _resolve_fields(fields)

    # Same query construction as _get_ticks, used only for counting.
    query: dict = {}
    if sym_list:
        query["symbol"] = {"$in": sym_list}
    if start or end:
        ts_filter: dict = {}
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

    total_matching = await db.ticks.count_documents(query)
    limit = min(max(limit, 1), 100000)
    effective_records = min(total_matching, limit)

    ser = get_serializer((format.split(",")[0] if format else "csv").strip().lower())
    fmt_available = bool(ser and ser.available)

    # Measure real average serialized size from a sample (falls back to 0
    # when there is no data — never invented).
    avg_bytes = 0.0
    if fmt_available and total_matching > 0:
        sample_docs = await db.ticks.find(query).limit(200).to_list(200)
        if sample_docs:
            sample = [{f: _map_tick(d).get(f) for f in selected_fields} for d in sample_docs]
            sample_bytes = len(ser.serialize(sample, selected_fields))
            avg_bytes = sample_bytes / len(sample)

    return {
        "symbolCount": len(sym_list),
        "symbols": sym_list[:50],
        "estimatedRecords": total_matching,
        "effectiveRecords": effective_records,
        "serverRowLimit": limit,
        "willTruncate": total_matching > limit,
        "estimatedSizeBytes": round(avg_bytes * effective_records),
        "bytesPerRecordAvg": round(avg_bytes, 1),
        "formatAvailable": fmt_available,
        "sampleSize": min(200, total_matching),
    }


@router.get("/naming/preview")
async def naming_preview(
    pattern: str = "{symbol}_{date}.{ext}",
    symbol: str = "RELIANCE",
    ext: str = "csv",
    date: str = "",
):
    return {"preview": _render_filename(pattern, symbol, ext, date)}


@router.get("")
async def download_data(
    symbol: str = "",
    symbols: str = "",
    start: str = "",
    end: str = "",
    limit: int = 50000,
    format: str = "csv",
    all: str = "false",
    fields: str = "",
    source: str = "manual",
    naming: str = "",
):
    t0 = time.monotonic()
    db = get_db()

    if all.lower() == "true" or (not symbol and not symbols):
        cursor = db.stocks.find({"active": True})
        active = await cursor.to_list(length=None)
        sym_list = [s["symbol"] for s in active]
    else:
        sym_list = [s.strip().upper() for s in (symbols or symbol).split(",") if s.strip()]

    if not sym_list:
        return Response(content=b'{"error":"no stocks selected"}', media_type="application/json", status_code=400)

    selected_fields = _resolve_fields(fields)
    ticks = await _get_ticks(sym_list, start or None, end or None, limit)

    if not ticks:
        return Response(content=b'{"error":"no data found for the selected parameters"}', media_type="application/json", status_code=404)

    duration_ms = (time.monotonic() - t0) * 1000

    fmt_list = [f.strip().lower() for f in format.split(",") if f.strip()]
    if not fmt_list:
        fmt_list = ["csv"]

    valid_fmts = [f for f in fmt_list if (s := get_serializer(f)) and s.available]
    if not valid_fmts:
        valid_fmts = ["csv"]

    num_stocks = len(sym_list)
    num_formats = len(valid_fmts)

    ticks_by_symbol: dict[str, list[dict]] = defaultdict(list)
    for t in ticks:
        sym = t.get("symbol", "").upper()
        ticks_by_symbol[sym].append(t)

    sym_list = [s for s in sym_list if s in ticks_by_symbol]

    if not sym_list:
        return Response(content=b'{"error":"no tick data for selected stocks"}', media_type="application/json", status_code=404)

    ts_str = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")

    # ── Single stock + single format → direct file ──
    if num_stocks == 1 and num_formats == 1:
        fmt_id = valid_fmts[0]
        ser = get_serializer(fmt_id)
        sym = sym_list[0]
        sym_ticks = ticks_by_symbol[sym]
        filtered = [{f: t.get(f) for f in selected_fields} for t in sym_ticks]
        file_data = ser.serialize(filtered, selected_fields)
        file_size = len(file_data)

        tick_date = _get_tick_date(sym_ticks[0]) if sym_ticks else _date_range_str(start, end)
        if naming:
            filename = _render_filename(naming, sym, ser.extension, tick_date)
        else:
            filename = f"{sym}_{tick_date}.{ser.extension}"

        await _record_download(
            db, sym_list, fmt_id, len(sym_ticks), selected_fields,
            start or None, end or None, source=source,
            file_size=file_size, duration_ms=duration_ms,
        )

        return Response(
            content=file_data,
            media_type=ser.mime_type,
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "X-Record-Count": str(len(sym_ticks)),
                "X-File-Size": str(file_size),
                "X-Duration-Ms": str(round(duration_ms, 1)),
            },
        )

    # ── Single stock + multiple formats → ZIP with format files ──
    if num_stocks == 1:
        sym = sym_list[0]
        sym_ticks = ticks_by_symbol[sym]
        filtered = [{f: t.get(f) for f in selected_fields} for t in sym_ticks]
        tick_date = _get_tick_date(sym_ticks[0]) if sym_ticks else _date_range_str(start, end)

        zip_buf = io.BytesIO()
        with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for fmt_id in valid_fmts:
                ser = get_serializer(fmt_id)
                if ser and ser.available:
                    data = ser.serialize(filtered, selected_fields)
                    zf.writestr(f"{sym}.{ser.extension}", data)

        file_data = zip_buf.getvalue()
        file_size = len(file_data)
        filename = f"{sym}_{tick_date}.zip"

        await _record_download(
            db, sym_list, "zip", len(sym_ticks), selected_fields,
            start or None, end or None, source=source,
            file_size=file_size, duration_ms=duration_ms,
        )

        return Response(
            content=file_data,
            media_type="application/zip",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "X-Record-Count": str(len(sym_ticks)),
                "X-File-Size": str(file_size),
                "X-Duration-Ms": str(round(duration_ms, 1)),
            },
        )

    # ── Multiple stocks → ZIP with per-symbol folder structure ──
    total_rows = 0

    from services.exporter import build_export_name, safe_archive_root
    export_name = build_export_name(symbols=sym_list)
    root = safe_archive_root(export_name)

    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for sym in sym_list:
            sym_ticks = ticks_by_symbol[sym]
            filtered = [{f: t.get(f) for f in selected_fields} for t in sym_ticks]
            total_rows += len(sym_ticks)
            for fmt_id in valid_fmts:
                ser = get_serializer(fmt_id)
                if ser and ser.available:
                    data = ser.serialize(filtered, selected_fields)
                    path = f"{root}/{sym}/tick-data.{ser.extension}"
                    zf.writestr(path, data)

    file_data = zip_buf.getvalue()
    file_size = len(file_data)
    filename = f"{root}.zip"

    await _record_download(
        db, sym_list, "zip", total_rows, selected_fields,
        start or None, end or None, source=source,
        file_size=file_size, duration_ms=duration_ms,
    )

    return Response(
        content=file_data,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Record-Count": str(total_rows),
            "X-File-Size": str(file_size),
            "X-Duration-Ms": str(round(duration_ms, 1)),
        },
    )


@router.get("/stats")
async def download_stats():
    db = get_db()
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    total_pipeline = [
        {"$group": {
            "_id": None,
            "totalDownloads": {"$sum": 1},
            "totalRecords": {"$sum": "$count"},
            "totalSizeBytes": {"$sum": "$fileSizeBytes"},
        }},
    ]
    total_result = await db.download_history.aggregate(total_pipeline).to_list(1)
    total = total_result[0] if total_result else {
        "totalDownloads": 0, "totalRecords": 0, "totalSizeBytes": 0,
    }

    today_pipeline = [
        {"$match": {"ts": {"$gte": today_start}}},
        {"$group": {"_id": None, "count": {"$sum": 1}, "records": {"$sum": "$count"}}},
    ]
    today_result = await db.download_history.aggregate(today_pipeline).to_list(1)
    today = today_result[0] if today_result else {"count": 0, "records": 0}

    return {
        "totalDownloads": total["totalDownloads"],
        "totalRecords": total["totalRecords"],
        "totalSizeBytes": total["totalSizeBytes"],
        "todayDownloads": today["count"],
        "todayRecords": today["records"],
    }


@router.delete("/history/bulk")
async def bulk_delete_history():
    """Delete all download history records and their artifacts."""
    from services.exporter import delete_stored_file
    db = get_db()
    cursor = db.download_history.find({}, {"fileId": 1})
    entries = await cursor.to_list(length=None)
    files_deleted = 0
    for entry in entries:
        fid = entry.get("fileId")
        if fid and delete_stored_file(str(fid)):
            files_deleted += 1
    result = await db.download_history.delete_many({})
    return {"deleted": result.deleted_count, "filesDeleted": files_deleted}


@router.delete("/history/{entry_id}")
async def delete_history_entry(entry_id: str):
    """Delete a history record and its generated export file if safe.

    NEVER touches market/tick/stock data — only the export record and the
    generated artifact stored under the controlled export directory.
    """
    from bson import ObjectId
    from bson.errors import InvalidId
    from services.exporter import delete_stored_file

    db = get_db()
    try:
        oid = ObjectId(entry_id)
    except (InvalidId, TypeError):
        return Response(content=b'{"error":"invalid id"}', media_type="application/json", status_code=400)

    entry = await db.download_history.find_one({"_id": oid})
    if not entry:
        raise HTTPException(status_code=404, detail="History entry not found")

    file_deleted = False
    file_id = entry.get("fileId")
    if file_id:
        file_deleted = delete_stored_file(str(file_id))

    job_deleted = 0
    if entry.get("jobId"):
        res = await db.export_jobs.delete_one({"_id": ObjectId(entry["jobId"])})
        job_deleted = res.deleted_count
    elif file_id:
        # Legacy link: find the completed job that points at this artifact.
        job = await db.export_jobs.find_one({"fileId": str(file_id)})
        if job:
            await db.export_jobs.delete_one({"_id": job["_id"]})
            job_deleted = 1

    await db.download_history.delete_one({"_id": oid})
    logger.info(
        "Deleted export history %s (file=%s, linkedJob=%s)",
        entry_id, "yes" if file_deleted else "no", job_deleted,
    )
    return {"deleted": True, "fileDeleted": file_deleted, "jobDeleted": job_deleted}


@router.get("/history/{entry_id}/file")
async def download_history_file(entry_id: str):
    """Stream the stored artifact for a history entry (scheduled exports etc.)."""
    import re
    from bson import ObjectId
    from bson.errors import InvalidId
    from services.exporter import resolve_stored_file

    db = get_db()
    try:
        oid = ObjectId(entry_id)
    except (InvalidId, TypeError):
        raise HTTPException(status_code=400, detail="invalid id")

    entry = await db.download_history.find_one({"_id": oid})
    if not entry:
        raise HTTPException(status_code=404, detail="History entry not found")

    file_id = entry.get("fileId")
    if not file_id or not re.fullmatch(r"[0-9a-f]{8,}_[0-9a-f]{12}", str(file_id)):
        raise HTTPException(
            status_code=410,
            detail="File no longer stored on the server — use Re-export instead",
        )

    path = resolve_stored_file(str(file_id))
    if path is None:
        raise HTTPException(
            status_code=410,
            detail="File no longer stored on the server — use Re-export instead",
        )
    filename = entry.get("fileName") or f"{file_id}.zip"
    return FileResponse(
        str(path),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/history")
async def download_history(
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    search: str = "",
    format: str = "",
    source: str = "",
    status: str = "",
):
    db = get_db()
    query: dict = {}
    if search:
        query["$or"] = [
            {"symbols": {"$regex": search, "$options": "i"}},
            {"format": {"$regex": search, "$options": "i"}},
            {"fileName": {"$regex": search, "$options": "i"}},
        ]
    if format:
        query["format"] = format
    if source:
        query["source"] = source
    if status:
        query["status"] = status

    total = await db.download_history.count_documents(query)
    cursor = (
        db.download_history.find(query)
        .sort("ts", -1)
        .skip(offset)
        .limit(limit)
    )
    items = await cursor.to_list(length=limit)

    status_counts_pipeline = [
        {"$group": {"_id": "$status", "count": {"$sum": 1}}},
    ]
    status_counts_raw = await db.download_history.aggregate(status_counts_pipeline).to_list(50)
    status_counts = {r["_id"]: r["count"] for r in status_counts_raw if r.get("_id")}

    total_size_pipeline = [
        {"$group": {"_id": None, "totalSize": {"$sum": "$fileSizeBytes"}, "totalRecords": {"$sum": "$count"}}},
    ]
    totals_raw = await db.download_history.aggregate(total_size_pipeline).to_list(1)
    totals = totals_raw[0] if totals_raw else {"totalSize": 0, "totalRecords": 0}

    for item in items:
        item["_id"] = str(item["_id"])
        if isinstance(item.get("ts"), datetime):
            item["ts"] = _iso_utc(item["ts"])
        if isinstance(item.get("dateStart"), datetime):
            item["dateStart"] = _iso_utc(item["dateStart"])
        if isinstance(item.get("dateEnd"), datetime):
            item["dateEnd"] = _iso_utc(item["dateEnd"])
        if "jobId" in item:
            item["jobId"] = str(item["jobId"]) if item["jobId"] else None

    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "items": items,
        "summary": {
            "totalSize": totals.get("totalSize", 0),
            "totalRecords": totals.get("totalRecords", 0),
            "statusCounts": status_counts,
            "totalJobs": total,
        },
    }
