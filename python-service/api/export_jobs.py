"""
Data Center export jobs — asynchronous export pipeline.

POST   /api/downloads/exports              → create job (QUEUED), returns jobId
GET    /api/downloads/exports/{id}         → status + progress (real stages)
GET    /api/downloads/exports/{id}/download→ the generated artifact
POST   /api/downloads/exports/{id}/cancel  → cancel QUEUED/PROCESSING jobs

A single background worker claims QUEUED jobs atomically, streams real ticks
from MongoDB via services/exporter.py and stores the artifact server-side.
History entries (download_history) are written by the exporter on completion.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from database.connection import get_db
from services import exporter
from services.serializers import available_formats

logger = logging.getLogger("app")

router = APIRouter(prefix="/api/downloads/exports", tags=["export-jobs"])

WORKER_INTERVAL_S = 1.0
CLEANUP_EVERY_S = 6 * 3600


def _valid_oid(value: str) -> ObjectId:
    try:
        return ObjectId(value)
    except (InvalidId, TypeError):
        raise HTTPException(400, "Invalid export id")


def _serialize_job(job: dict) -> dict:
    out = {
        "id": str(job["_id"]),
        "status": job.get("status", "QUEUED"),
        "stage": job.get("stage", "queued"),
        "progressPercent": job.get("progressPercent", 0),
        "stocks": job.get("stocks", []),
        "missingSymbols": job.get("missingSymbols", []),
        "symbolMode": job.get("symbolMode", "custom"),
        "dataType": job.get("dataType", exporter.DEFAULT_DATA_TYPE),
        "fields": job.get("fields", []),
        "formats": job.get("formats", []),
        "packageZip": job.get("packageZip", True),
        "dateStart": job.get("dateStart"),
        "dateEnd": job.get("dateEnd"),
        "createdAt": _iso(job.get("createdAt")),
        "startedAt": _iso(job.get("startedAt")),
        "completedAt": _iso(job.get("completedAt")),
        "failedAt": _iso(job.get("failedAt")),
        "fileName": job.get("fileName"),
        "fileSize": job.get("fileSizeBytes"),
        "recordCount": job.get("recordCount"),
        "historyId": job.get("historyId"),
        "error": job.get("error"),
        "source": job.get("source", "manual"),
    }
    return out


def _iso(dt):
    if isinstance(dt, datetime):
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat()
    return dt


class CreateExportRequest(BaseModel):
    symbols: list[str] | None = None
    symbolMode: str = "custom"          # custom | all_active | all
    start: str | None = None
    end: str | None = None
    fields: str = ""                    # comma separated; empty = all known fields
    formats: list[str] = ["csv"]
    packageZip: bool = True
    dataType: str = exporter.DEFAULT_DATA_TYPE
    clientId: str | None = None         # client idempotency key


# ── Routes ────────────────────────────────────────────────

@router.post("")
async def create_export(req: CreateExportRequest):
    db = get_db()

    # Resolve stock list exactly like the rest of the app does.
    if req.symbolMode in ("all_active", "all"):
        q = {} if req.symbolMode == "all" else {"active": True}
        stocks = await db.stocks.find(q).to_list(length=None)
        symbols = sorted({s["symbol"].upper() for s in stocks if s.get("symbol")})
    else:
        symbols = sorted({s.strip().upper() for s in (req.symbols or []) if s and s.strip()})
    if not symbols:
        raise HTTPException(400, "No stocks selected")

    # Idempotency: an identical in-flight client request returns the same job.
    if req.clientId:
        existing = await db.export_jobs.find_one({
            "clientId": req.clientId,
            "status": {"$in": ["QUEUED", "PROCESSING"]},
        })
        if existing:
            return {"jobId": str(existing["_id"]), "job": _serialize_job(existing), "duplicate": True}

    fmt_ids = [f for f in {x.strip().lower() for x in req.formats if x and x.strip()}]
    known = {f["id"] for f in available_formats() if f["available"]}
    unknown = [f for f in fmt_ids if f not in known and f != "zip"]
    if unknown:
        raise HTTPException(400, f"Unsupported format(s): {', '.join(unknown)}")

    now = datetime.now(timezone.utc)
    doc = {
        "status": "QUEUED",
        "stage": "queued",
        "progressPercent": 0,
        "stocks": symbols,
        "symbolMode": req.symbolMode,
        "dataType": req.dataType if req.dataType in exporter.DATA_TYPES else exporter.DEFAULT_DATA_TYPE,
        "fields": req.fields,
        "formats": fmt_ids or ["csv"],
        "packageZip": bool(req.packageZip),
        "dateStart": req.start or None,
        "dateEnd": req.end or None,
        "source": "manual",
        "clientId": req.clientId,
        "createdAt": now,
        "cancelRequested": False,
    }
    result = await db.export_jobs.insert_one(doc)
    logger.info("Export job queued: %s (%d stocks)", result.inserted_id, len(symbols))
    return {"jobId": str(result.inserted_id), "duplicate": False}


@router.get("")
async def list_exports(limit: int = 20, offset: int = 0):
    db = get_db()
    limit = min(max(limit, 1), 100)
    total = await db.export_jobs.count_documents({})
    cursor = db.export_jobs.find({}).sort("createdAt", -1).skip(max(offset, 0)).limit(limit)
    items = [_serialize_job(j) async for j in cursor]
    return {"total": total, "limit": limit, "offset": offset, "items": items}


@router.get("/{job_id}")
async def get_export(job_id: str):
    db = get_db()
    oid = _valid_oid(job_id)
    job = await db.export_jobs.find_one({"_id": oid})
    if not job:
        raise HTTPException(404, "Export job not found")
    return {"job": _serialize_job(job)}


@router.get("/{job_id}/download")
async def download_export(job_id: str):
    db = get_db()
    oid = _valid_oid(job_id)
    job = await db.export_jobs.find_one({"_id": oid})
    if not job:
        raise HTTPException(404, "Export job not found")
    if job.get("status") != "COMPLETED":
        raise HTTPException(409, f"Export is not ready (status: {job.get('status')})")
    file_id = job.get("fileId")
    path = exporter.resolve_stored_file(file_id) if file_id else None
    if path is None:
        raise HTTPException(410, "Generated file no longer exists on the server")
    return FileResponse(
        path=str(path),
        media_type="application/zip" if str(file_name_ext(job)) == "zip" else guess_media(job),
        filename=job.get("fileName") or "export.zip",
        headers={"X-Record-Count": str(job.get("recordCount") or 0)},
    )


def file_name_ext(job: dict) -> str:
    name = job.get("fileName") or ""
    return name.rsplit(".", 1)[-1] if "." in name else "zip"


def guess_media(job: dict) -> str:
    ext = file_name_ext(job)
    from services.serializers import get_serializer
    ser = get_serializer(ext)
    return ser.mime_type if ser else "application/octet-stream"


@router.post("/{job_id}/cancel")
async def cancel_export(job_id: str):
    db = get_db()
    oid = _valid_oid(job_id)
    job = await db.export_jobs.find_one({"_id": oid})
    if not job:
        raise HTTPException(404, "Export job not found")
    if job.get("status") in ("COMPLETED", "FAILED", "CANCELLED"):
        return {"ok": False, "status": job["status"]}
    await db.export_jobs.update_one(
        {"_id": oid},
        {"$set": {"cancelRequested": True}},
    )
    return {"ok": True}


@router.post("/{job_id}/retry")
async def retry_export(job_id: str):
    """Create a new QUEUED job with the same parameters as a failed/cancelled job."""
    db = get_db()
    oid = _valid_oid(job_id)
    job = await db.export_jobs.find_one({"_id": oid})
    if not job:
        raise HTTPException(404, "Export job not found")
    if job.get("status") not in ("FAILED", "CANCELLED"):
        raise HTTPException(400, "Only failed or cancelled jobs can be retried")

    now = datetime.now(timezone.utc)
    new_doc = {
        "status": "QUEUED",
        "stage": "queued",
        "progressPercent": 0,
        "stocks": job.get("stocks", []),
        "symbolMode": job.get("symbolMode", "custom"),
        "dataType": job.get("dataType", exporter.DEFAULT_DATA_TYPE),
        "fields": job.get("fields", ""),
        "formats": job.get("formats", ["csv"]),
        "packageZip": job.get("packageZip", True),
        "dateStart": job.get("dateStart"),
        "dateEnd": job.get("dateEnd"),
        "source": "manual",
        "clientId": None,
        "createdAt": now,
        "cancelRequested": False,
        "retryOf": job_id,
    }
    result = await db.export_jobs.insert_one(new_doc)
    logger.info("Export job retried: %s → %s", job_id, result.inserted_id)
    return {"jobId": str(result.inserted_id), "duplicate": False}


@router.delete("")
async def bulk_delete_exports():
    """Delete all export job records (history remains separate)."""
    db = get_db()
    result = await db.export_jobs.delete_many({})
    return {"deleted": result.deleted_count}


@router.delete("/{job_id}")
async def delete_export_job(job_id: str):
    """Delete a single export job record."""
    db = get_db()
    oid = _valid_oid(job_id)
    result = await db.export_jobs.delete_one({"_id": oid})
    if result.deleted_count == 0:
        raise HTTPException(404, "Export job not found")
    return {"deleted": True}


# ── Background worker ─────────────────────────────────────

_worker_task: asyncio.Task | None = None
_worker_running = False
_last_cleanup = 0.0


async def _process_job(job: dict):
    """Run one export job end-to-end using the shared exporter."""
    db = get_db()
    oid = job["_id"]
    last_cancel_check = 0.0

    async def check_cancelled() -> bool:
        """Cooperative cancellation — re-read the flag at most every 1.5s."""
        nonlocal last_cancel_check
        now = time.monotonic()
        if now - last_cancel_check < 1.5:
            return False
        last_cancel_check = now
        doc = await db.export_jobs.find_one({"_id": oid}, {"cancelRequested": 1})
        return bool(doc and doc.get("cancelRequested"))

    async def progress(stage: str, done: int, est):
        pct = 0
        if stage == "fetching" and est:
            pct = min(60, int(done / max(est, 1) * 60))
        elif stage in ("generating", "saving"):
            pct = max(pct, 65)
        elif stage == "zipping":
            pct = 85
        await db.export_jobs.update_one(
            {"_id": oid},
            {"$set": {"stage": stage, "progressPercent": pct}},
        )

    try:
        try:
            from services.notification_center import emit_event
            emit_event("export", "EXPORT_STARTED", "info",
                       f"Export started: {job.get('name') or str(oid)[:8]}",
                       {"job_id": str(oid)})
        except Exception:
            logger.debug("Export start event skipped")
        meta = await exporter.execute_export(
            symbols=job.get("stocks", []),
            start=job.get("dateStart"),
            end=job.get("dateEnd"),
            fields_str=job.get("fields"),
            formats=job.get("formats", ["csv"]),
            package_zip=job.get("packageZip", True),
            source="manual",
            progress_cb=progress,
            should_abort=check_cancelled,
        )
        await db.export_jobs.update_one(
            {"_id": oid},
            {"$set": {
                "status": "COMPLETED",
                "stage": "completed",
                "progressPercent": 100,
                "completedAt": datetime.now(timezone.utc),
                "fileId": meta["fileId"],
                "fileName": meta["fileName"],
                "fileSizeBytes": meta["fileSizeBytes"],
                "recordCount": meta["recordCount"],
                "historyId": meta["historyId"],
                "missingSymbols": meta["symbolsMissing"],
                "error": None,
            }},
        )
        # Bidirectional link so History can download/delete the artifact.
        from bson import ObjectId as _OID
        await db.download_history.update_one(
            {"_id": _OID(meta["historyId"])},
            {"$set": {"jobId": str(oid)}},
        )
        logger.info("Export job COMPLETED: %s → %s (%d rows)",
                    oid, meta["fileName"], meta["recordCount"])
        try:
            from services.notification_center import emit_event
            emit_event("export", "EXPORT_COMPLETED", "success",
                       f"Export completed: {meta.get('fileName') or 'download'} "
                       f"({meta.get('recordCount')} rows)",
                       {"job_id": str(oid), "fileName": meta.get("fileName"),
                        "recordCount": meta.get("recordCount"),
                        "symbols": meta.get("symbolsWithData") or []})
        except Exception:
            logger.debug("Export completion event skipped")
    except InterruptedError:
        await db.export_jobs.update_one(
            {"_id": oid},
            {"$set": {"status": "CANCELLED", "stage": "cancelled",
                      "failedAt": datetime.now(timezone.utc), "error": "Cancelled"}},
        )
    except Exception as exc:
        logger.error("Export job FAILED: %s — %s", oid, exc)
        await db.export_jobs.update_one(
            {"_id": oid},
            {"$set": {"status": "FAILED", "stage": "failed",
                      "failedAt": datetime.now(timezone.utc),
                      "error": str(exc) or exc.__class__.__name__}},
        )
        try:
            from services.notification_center import emit_event
            emit_event("export", "EXPORT_FAILED", "error",
                       f"Export failed: {str(exc) or 'unknown error'}",
                       {"job_id": str(oid), "error": str(exc) or ""})
        except Exception:
            logger.debug("Export failure event skipped")


async def _worker_loop():
    global _worker_running, _last_cleanup
    _worker_running = True
    logger.info("Export job worker started")

    while _worker_running:
        try:
            db = get_db()
            # Recover jobs interrupted by a restart.
            await db.export_jobs.update_many(
                {"status": "PROCESSING"},
                {"$set": {"status": "QUEUED", "stage": "queued", "progressPercent": 0}},
            )

            job = await db.export_jobs.find_one_and_update(
                {"status": "QUEUED", "cancelRequested": {"$ne": True}},
                {"$set": {"status": "PROCESSING", "startedAt": datetime.now(timezone.utc)}},
                sort=[("createdAt", 1)],
            )
            if job is None:
                # Honour pending cancellations of still-queued jobs.
                await db.export_jobs.update_many(
                    {"status": "QUEUED", "cancelRequested": True},
                    {"$set": {"status": "CANCELLED", "failedAt": datetime.now(timezone.utc),
                              "error": "Cancelled"}},
                )
            else:
                await _process_job(job)

            if time.monotonic() - _last_cleanup > CLEANUP_EVERY_S:
                removed = exporter.cleanup_expired_exports()
                if removed:
                    logger.info("Cleaned %d expired export artifacts", removed)
                _last_cleanup = time.monotonic()

        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.error("Export worker error: %s", exc)

        await asyncio.sleep(WORKER_INTERVAL_S)

    logger.info("Export job worker stopped")


def start_export_worker():
    global _worker_task
    if _worker_task is not None and not _worker_task.done():
        return
    try:
        from core.event_loop import get_loop
        loop = get_loop()
        _worker_task = loop.create_task(_worker_loop())
        import os as _os
        logger.info("[EXPORT-WORKER] instance=%s registered", _os.getpid())
    except Exception as exc:
        logger.warning("Could not start export worker: %s", exc)


def stop_export_worker():
    global _worker_running, _worker_task
    _worker_running = False
    if _worker_task is not None:
        _worker_task.cancel()
        _worker_task = None


def export_worker_status() -> dict:
    """Real in-process export worker state for the Data Center workers panel."""
    task = _worker_task
    return {
        "running": bool(_worker_running),
        "taskActive": bool(task is not None and not task.done()),
        "intervalSeconds": WORKER_INTERVAL_S,
    }
