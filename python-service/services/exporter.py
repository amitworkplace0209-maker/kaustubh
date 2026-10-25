"""
Export engine — shared by the Data Center export-job API and the scheduler.

Fetches REAL tick documents from the existing MongoDB `ticks` collection,
serializes them with the existing serializer registry and packages them as:

    <EXPORT_NAME>/
    ├── SYMBOL_A/
    │   └── tick-data.csv        (+ one file per extra selected format)
    ├── SYMBOL_B/
    │   └── tick-data.csv
    └── ...

Single stock + single format + packaging disabled returns the raw file
instead of an archive. Every selected symbol that HAS data is included;
symbols without data are reported back to the caller (never silently mixed).
"""

from __future__ import annotations

import io
import logging
import os
import re
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from database.connection import get_db
from services.serializers import get_serializer

logger = logging.getLogger("app")

# Controlled server-side storage for generated exports (requirement #34).
EXPORT_DIR = Path(
    os.getenv("DC_EXPORT_DIR", str(Path(__file__).resolve().parent.parent / "data" / "exports"))
)

# Only data type that exists in this backend today (live tick infrastructure).
DATA_TYPES: dict[str, dict] = {
    "tick-data": {
        "label": "Tick Data",
        "fileStem": "tick-data",
        "description": "Tick-by-tick market data captured from subscribed instruments",
    },
}
DEFAULT_DATA_TYPE = "tick-data"

BRAND_PREFIX = "KAUSTUBH"


def sanitize_name(text: str, max_len: int = 48) -> str:
    """Uppercase alnum+underscore token safe for filenames/zip roots."""
    cleaned = re.sub(r"[^A-Za-z0-9]+", "_", (text or "").strip()).strip("_")
    return cleaned[:max_len].upper() or "EXPORT"


def safe_archive_root(export_name: str, max_len: int = 80) -> str:
    """Safe ZIP-root / file base name that KEEPS date dashes intact
    (KAUSTUBH_IFCI_2026-08-24). Only truly unsafe characters are replaced."""
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "_", (export_name or "").strip()).strip("_")
    return cleaned[:max_len].upper() or "EXPORT"


def build_export_name(*, label: str | None = None, symbols: list[str], when: datetime | None = None) -> str:
    """KAUSTUBH_IFCI_2026-08-24 / KAUSTUBH_EXPORT_2026-08-24 / KAUSTUBH_<SCHEDULE>_date."""
    when = when or datetime.now(timezone.utc)
    date_str = when.astimezone().strftime("%Y-%m-%d")
    if label:
        stem = sanitize_name(label)
    elif len(symbols) == 1:
        stem = sanitize_name(symbols[0])
    else:
        stem = "EXPORT"
    return f"{BRAND_PREFIX}_{stem}_{date_str}"


def resolve_fields(fields_str: str | None, known_fields: list[str]) -> list[str]:
    if not fields_str or not fields_str.strip():
        return list(known_fields)
    requested = [f.strip() for f in fields_str.split(",") if f.strip()]
    validated = [f for f in requested if f in known_fields]
    return validated or list(known_fields)


def _map_tick(t: dict) -> dict:
    from services.tick_field_resolver import get_depth, get_field

    ts = t.get("ts")
    received_at = t.get("receivedAt")
    if isinstance(ts, datetime):
        ts = ts.isoformat()
    if isinstance(received_at, datetime):
        received_at = received_at.isoformat()
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


import inspect


async def _maybe_await(value):
    """Await the value when a callback returned a coroutine."""
    if inspect.isawaitable(value):
        return await value
    return value


async def fetch_ticks(symbols: list[str], start: str | None, end: str | None,
                      limit: int = 100_000, progress_cb=None):
    """Real tick documents for ALL given symbols (same query shape as the
    legacy download endpoint). Calls progress_cb(fetched, total_estimate)."""
    db = get_db()
    query: dict = {"symbol": {"$in": [s.upper() for s in symbols]}}
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

    limit = min(max(limit, 1), 200_000)
    total = await db.ticks.count_documents(query)
    cursor = db.ticks.find(query).sort("ts", 1).limit(limit)

    ticks: list[dict] = []
    batch: list[dict] = []
    fetched = 0
    async for doc in cursor:
        batch.append(_map_tick(doc))
        if len(batch) >= 5000:
            ticks.extend(batch)
            fetched += len(batch)
            batch = []
            if progress_cb:
                progress_cb(fetched, total)
    if batch:
        ticks.extend(batch)
        fetched += len(batch)
        if progress_cb:
            progress_cb(fetched, total)
    return ticks


def build_package(
    *,
    ticks_by_symbol: dict[str, list[dict]],
    symbols: list[str],
    selected_fields: list[str],
    valid_fmts: list[str],
    package_zip: bool,
    export_name: str,
) -> tuple[bytes, str, int]:
    """Generate files + package. Returns (data, file_extension, record_count).

    Folder structure inside the ZIP:  <export_name>/<SYMBOL>/<stem>.<ext>
    """
    stems: dict[str, str] = {}
    for fmt_id in valid_fmts:
        ser = get_serializer(fmt_id)
        if ser and ser.available:
            stems[fmt_id] = ser.extension

    total_rows = sum(len(v) for v in ticks_by_symbol.values())
    root = safe_archive_root(export_name)

    if not package_zip:
        # Single stock + single format → raw file.
        sym = symbols[0]
        sym_ticks = ticks_by_symbol[sym]
        ser = get_serializer(valid_fmts[0])
        filtered = [{f: t.get(f) for f in selected_fields} for t in sym_ticks]
        return ser.serialize(filtered, selected_fields), ser.extension, len(sym_ticks)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for sym in symbols:
            sym_ticks = ticks_by_symbol.get(sym) or []
            if not sym_ticks:
                continue  # reported separately by caller; never fabricated
            filtered = [{f: t.get(f) for f in selected_fields} for t in sym_ticks]
            for fmt_id in valid_fmts:
                ser = get_serializer(fmt_id)
                if not (ser and ser.available):
                    continue
                data = ser.serialize(filtered, selected_fields)
                arcname = f"{root}/{sym}/{DATA_TYPES[DEFAULT_DATA_TYPE]['fileStem']}.{ser.extension}"
                zf.writestr(arcname, data)
    return buf.getvalue(), "zip", total_rows


async def execute_export(
    *,
    symbols: list[str],
    start: str | None,
    end: str | None,
    fields_str: str | None,
    formats: list[str],
    package_zip: bool = True,
    label: str | None = None,
    source: str = "manual",
    schedule_id: str | None = None,
    schedule_name: str | None = None,
    limit: int = 100_000,
    progress_cb=None,
    should_abort=None,
) -> dict:
    """Full export pipeline: fetch real data → generate → package → persist.

    Writes the artifact into EXPORT_DIR and records a download_history entry.
    Returns metadata for the caller (job doc / run log).
    Raises ValueError with a user-safe message on failure.
    """
    from api.downloads import FIELDS

    db = get_db()
    t0 = time.monotonic()

    sym_list = [s.strip().upper() for s in symbols if s and s.strip()]
    if not sym_list:
        raise ValueError("No stocks selected")

    selected_fields = resolve_fields(fields_str, FIELDS)
    valid_fmts: list[str] = []
    for f in formats:
        ser = get_serializer(f)
        if ser and ser.available and f not in valid_fmts and f != "zip":
            valid_fmts.append(f)
    if not valid_fmts:
        valid_fmts = ["csv"]

    # ZIP is forced whenever the output contains more than one file.
    needs_zip = package_zip or len(sym_list) > 1 or len(valid_fmts) > 1

    def cb(done: int, est: int | None):
        if progress_cb:
            try:
                return progress_cb("fetching", done, est)
            except Exception:
                pass

    ticks = await fetch_ticks(sym_list, start, end, limit=limit, progress_cb=cb)

    if should_abort is not None and await _maybe_await(should_abort()):
        raise InterruptedError("Export cancelled")

    ticks_by_symbol: dict[str, list[dict]] = {}
    for t in ticks:
        sym = (t.get("symbol") or "").upper()
        ticks_by_symbol.setdefault(sym, []).append(t)

    symbols_with_data = [s for s in sym_list if ticks_by_symbol.get(s)]
    symbols_missing = [s for s in sym_list if not ticks_by_symbol.get(s)]

    if not symbols_with_data:
        raise ValueError(
            "No tick data found for the selected stocks"
            + (" in the selected date range" if start or end else "")
        )

    if progress_cb:
        await _maybe_await(progress_cb("generating", 0, None))

    when_utc = datetime.now(timezone.utc)
    export_name = build_export_name(label=label, symbols=symbols_with_data, when=when_utc)
    data, ext, total_rows = build_package(
        ticks_by_symbol=ticks_by_symbol,
        symbols=symbols_with_data,
        selected_fields=selected_fields,
        valid_fmts=valid_fmts,
        package_zip=needs_zip,
        export_name=export_name,
    )

    if should_abort is not None and await _maybe_await(should_abort()):
        raise InterruptedError("Export cancelled")

    if progress_cb:
        await _maybe_await(progress_cb("zipping" if needs_zip else "saving", 0, None))

    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    file_id = f"{int(time.time() * 1000)}_{os.urandom(6).hex()}"
    file_name = f"{safe_archive_root(export_name)}.{ext}"
    file_path = EXPORT_DIR / file_id
    file_path.write_bytes(data)

    duration_ms = (time.monotonic() - t0) * 1000

    history_doc = {
        "symbols": symbols_with_data,
        "missingSymbols": symbols_missing,
        "symbolCount": len(symbols_with_data),
        "format": ",".join(valid_fmts),
        "packagedAs": "zip" if needs_zip else ext,
        "count": total_rows,
        "fields": selected_fields,
        "dataType": DEFAULT_DATA_TYPE,
        "dateStart": start,
        "dateEnd": end,
        "source": source,
        "fileName": file_name,
        "fileId": file_id,
        "fileSizeBytes": len(data),
        "durationMs": round(duration_ms, 1),
        "status": "completed",
        "ts": when_utc,
    }
    if schedule_id:
        history_doc["scheduleId"] = schedule_id
    if schedule_name:
        history_doc["scheduleName"] = schedule_name
    result = await db.download_history.insert_one(history_doc)

    if progress_cb:
        await _maybe_await(progress_cb("completed", 0, None))

    return {
        "historyId": str(result.inserted_id),
        "fileId": file_id,
        "fileName": file_name,
        "fileSizeBytes": len(data),
        "recordCount": total_rows,
        "symbolsWithData": symbols_with_data,
        "symbolsMissing": symbols_missing,
        "formats": valid_fmts,
        "fields": selected_fields,
        "packagedAs": "zip" if needs_zip else ext,
        "durationMs": round(duration_ms, 1),
        "filePath": str(file_path),
    }


def resolve_stored_file(file_id: str) -> Path | None:
    """Safely map a stored fileId to its artifact under EXPORT_DIR.

    Rejects anything resembling traversal — ids are [0-9a-f_]+ by construction.
    """
    if not re.fullmatch(r"[0-9a-f]{8,}_[0-9a-f]{12}", file_id or ""):
        return None
    path = (EXPORT_DIR / file_id).resolve()
    try:
        path.relative_to(EXPORT_DIR.resolve())
    except ValueError:
        return None
    return path if path.is_file() else None


def delete_stored_file(file_id: str) -> bool:
    path = resolve_stored_file(file_id)
    if path is None:
        return False
    try:
        path.unlink()
        return True
    except OSError:
        return False


def cleanup_expired_exports(retention_days: int = 7) -> int:
    """Remove generated artifacts older than the retention window."""
    if not EXPORT_DIR.is_dir():
        return 0
    cutoff = time.time() - retention_days * 86400
    removed = 0
    for f in EXPORT_DIR.iterdir():
        try:
            if f.is_file() and f.stat().st_mtime < cutoff:
                f.unlink()
                removed += 1
        except OSError:
            continue
    return removed
