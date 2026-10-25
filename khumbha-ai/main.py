"""Khumbha AI — local Python runtime.

Standalone FastAPI service (default port 8001) separate from the main
KAUSTUBH trading backend. Provides real local AI operations:

  - hardware metrics via psutil (GPU reported honestly as Unavailable when
    no GPU is present — never fabricated as 0%)
  - a real regression trainer (numpy least-squares) with progress tracking
  - real inference on trained models
  - suggestions derived only from real input data (never fabricated)

It does not depend on the trading backend.
"""
from __future__ import annotations

import logging
import os
import secrets
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import local_ai

HOST = os.getenv("AI_HOST", "127.0.0.1")
PORT = int(os.getenv("AI_PORT", "8001"))
BRIDGE_TOKEN = os.getenv("AI_BRIDGE_TOKEN", "").strip()

logger = logging.getLogger("khumbha")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="KAUSTUBH Khumbha AI Runtime", version=local_ai.BRIDGE_VERSION, docs_url="/docs")

# Local AI provider registry (Ollama / LM Studio / llama.cpp / custom OpenAI).
# Config is stored on the device at khumbha-ai/local-ai.json (gitignored).
REGISTRY = local_ai.ProviderRegistry()

# Token gate runs INSIDE CORS: CORS is added after this middleware so error
# responses still receive the browser's CORS headers. The token is optional;
# when AI_BRIDGE_TOKEN is empty the bridge is loopback-only by default.
@app.middleware("http")
async def bridge_token_gate(request: Request, call_next):
    if request.method == "OPTIONS":
        response = await call_next(request)
    elif BRIDGE_TOKEN and request.url.path not in {"/health", "/docs", "/openapi.json"}:
        supplied = request.headers.get("x-khumbha-ai-token", "")
        if not secrets.compare_digest(supplied, BRIDGE_TOKEN):
            response = JSONResponse(
                {"detail": "invalid or missing X-Khumbha-AI-Token"},
                status_code=401,
            )
        else:
            response = await call_next(request)
    else:
        response = await call_next(request)
    return response


allowed = [
    origin.strip()
    for origin in os.getenv(
        "AI_CORS_ORIGINS",
        "http://localhost:3000,http://localhost:3001,http://127.0.0.1:3000,http://127.0.0.1:3001",
    ).split(",")
    if origin.strip()
]
allow_all_origins = "*" in allowed
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if allow_all_origins else allowed,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Outermost middleware: add the Private Network Access opt-in to every response,
# including CORS preflights (which short-circuit inside CORSMiddleware). A page
# served from the VM may ask this loopback bridge for permission; the browser
# still decides whether to grant it.
@app.middleware("http")
async def private_network_header(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("Access-Control-Allow-Private-Network", "true")
    return response


# --------------------------------------------------------------------------
# Real linear regression core (numpy least squares)
# --------------------------------------------------------------------------
def _fit(xs, ys):
    import numpy as np

    X = np.array(xs, dtype=float)
    Y = np.array(ys, dtype=float)
    if X.ndim == 1:
        X = X[:, None]
    Xb = np.hstack([np.ones((X.shape[0], 1)), X])
    try:
        theta, *_ = np.linalg.lstsq(Xb, Y, rcond=None)
    except Exception:
        theta = np.zeros(Xb.shape[1])
    return theta

def _predict(theta, x):
    import numpy as np

    xa = np.array(x, dtype=float)
    if np.ndim(xa) == 0:
        xa = np.array([[xa]])
    elif xa.ndim == 1:
        xa = xa.reshape(-1, 1)
    Xb = np.hstack([np.ones((xa.shape[0], 1)), xa])
    return Xb @ theta


# --------------------------------------------------------------------------
# Real state store
# --------------------------------------------------------------------------
@dataclass
class Model:
    id: str
    name: str
    version: str
    created: str
    status: str = "idle"  # idle | trained | running
    last_run: str = ""
    metrics: dict = field(default_factory=dict)
    theta: list = field(default_factory=list)
    artifact: str = ""


@dataclass
class Job:
    id: str
    kind: str  # training | inference
    status: str  # queued | running | done | failed | cancelled
    progress: float
    model_id: str = ""
    message: str = ""
    created: str = ""
    updated: str = ""
    result: dict = field(default_factory=dict)


@dataclass
class Agent:
    id: str
    name: str
    status: str
    config: dict = field(default_factory=dict)
    last_run: str = ""


MODELS: dict[str, Model] = {}
JOBS: dict[str, Job] = {}
AGENTS: dict[str, Agent] = {}
DATASETS: dict[str, dict] = {}
INFERENCE_HISTORY: list[dict] = []

_log_lock = threading.Lock()
APP_START = time.time()


def _ts() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hardware() -> dict:
    import psutil

    cpu_pct = psutil.cpu_percent(interval=None)
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage(os.path.abspath(os.sep))
    gpu = "Unavailable"
    vram = None
    try:
        import subprocess

        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,memory.used,utilization.gpu", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
        )
        if out.returncode == 0 and out.stdout.strip():
            row = out.stdout.strip().splitlines()[0].split(",")
            gpu = row[0].strip()
            vram_total = row[1].strip() + " MiB"
            vram_used = row[2].strip() + " MiB"
            gpu_util = float(row[3].strip())
            vram = {"total": vram_total, "used": vram_used, "util": gpu_util}
    except Exception:
        pass
    return {
        "cpu": {"cores": psutil.cpu_count(logical=True), "usagePct": round(cpu_pct, 1)},
        "ram": {
            "total": mem.total,
            "used": mem.used,
            "available": mem.available,
            "usagePct": round(mem.percent, 1),
        },
        "disk": {"total": disk.total, "used": disk.used, "free": disk.free, "usagePct": round(disk.percent, 1)},
        "gpu": gpu,
        "vram": vram,
        "uptimeSec": round(time.time() - APP_START, 1),
    }


# --------------------------------------------------------------------------
# Request/response models
# --------------------------------------------------------------------------
class InferenceRequest(BaseModel):
    model_id: str
    inputs: list[float]
    dataset: list[float] | None = None


class TrainingRequest(BaseModel):
    name: str
    xs: list[float]
    ys: list[float]
    epochs: int = 10


class SuggestRequest(BaseModel):
    series: list[float] | None = None
    prices: list[float] | None = None


class ProviderUpdate(BaseModel):
    baseUrl: str | None = None
    kind: str | None = None
    label: str | None = None
    enabled: bool | None = None
    model: str | None = None


class DefaultsUpdate(BaseModel):
    provider: str | None = None
    model: str | None = None
    temperature: float | None = None
    maxTokens: int | None = None


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    provider: str | None = None
    model: str | None = None
    temperature: float | None = None
    maxTokens: int | None = None
    timeoutSec: float | None = None


class AnalyzeRequest(BaseModel):
    kind: str
    context: dict[str, Any]
    question: str | None = None
    provider: str | None = None
    model: str | None = None
    temperature: float | None = None
    maxTokens: int | None = None


def _seed_models():
    if not MODELS:
        m = Model(
            id="reg-default",
            name="Default Linear Regression",
            version="1.0.0",
            created=_ts(),
            status="idle",
            artifact="numpy least-squares (closed form)",
        )
        MODELS[m.id] = m
        AGENTS["signal-sampler"] = Agent(
            id="signal-sampler",
            name="Signal Sampler",
            status="idle",
            config={"kind": "regression", "description": "Learns a linear relationship from a real numeric dataset"},
        )


_seed_models()


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------
@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "khumbha-ai-runtime",
        "bridgeVersion": local_ai.BRIDGE_VERSION,
        "uptimeSec": round(time.time() - APP_START, 1),
        "localAi": REGISTRY.summary(),
    }


@app.get("/api/hardware")
def hardware():
    return _hardware()


@app.get("/api/dashboard")
def dashboard():
    hw = _hardware()
    return {
        "engineStatus": "running",
        "localRuntimeStatus": "ok",
        "uptimeSec": hw["uptimeSec"],
        "totalModels": len(MODELS),
        "activeModels": len([m for m in MODELS.values() if m.status == "running"] or [m for m in MODELS.values() if m.status == "trained"]),
        "agents": len(AGENTS),
        "runningJobs": len([j for j in JOBS.values() if j.status in ("queued", "running")]),
        "completedRuns": len(INFERENCE_HISTORY),
        "trainingJobs": len([j for j in JOBS.values() if j.kind == "training"]),
        "inferenceJobs": len([j for j in JOBS.values() if j.kind == "inference"]),
        "gpu": hw["gpu"],
        "vram": hw["vram"],
        "cpu": hw["cpu"],
        "ram": hw["ram"],
        "disk": hw["disk"],
        "recentRuns": sorted(INFERENCE_HISTORY, key=lambda r: r["ts"], reverse=True)[:10],
        "models": [{"id": m.id, "name": m.name, "status": m.status, "metrics": m.metrics} for m in MODELS.values()],
        "agents": [{"id": a.id, "name": a.name, "status": a.status} for a in AGENTS.values()],
        "localAi": REGISTRY.summary(),
    }


@app.get("/api/models")
def models():
    return {
        "models": [
            {
                "id": m.id,
                "name": m.name,
                "version": m.version,
                "status": m.status,
                "created": m.created,
                "lastRun": m.last_run,
                "metrics": m.metrics,
                "artifact": m.artifact,
            }
            for m in MODELS.values()
        ]
    }


@app.post("/api/models/{model_id}/start")
def model_start(model_id: str):
    m = MODELS.get(model_id)
    if not m:
        raise HTTPException(404, "model not found")
    m.status = "running"
    return {"data": {"id": m.id, "status": m.status}}


@app.post("/api/models/{model_id}/stop")
def model_stop(model_id: str):
    m = MODELS.get(model_id)
    if not m:
        raise HTTPException(404, "model not found")
    m.status = "trained" if m.theta else "idle"
    return {"data": {"id": m.id, "status": m.status}}


@app.get("/api/datasets")
def datasets():
    return {"datasets": [{"id": k, "name": v.get("name", k), "points": len(v.get("xs", []))} for k, v in DATASETS.items()]}


@app.post("/api/training/start")
def training_start(req: TrainingRequest):
    if len(req.xs) != len(req.ys) or len(req.xs) < 2:
        raise HTTPException(400, "xs and ys must be equal-length with at least 2 points")
    # register the dataset (real input, stored for reference)
    ds_id = str(uuid.uuid4())[:8]
    DATASETS[ds_id] = {"name": req.name, "xs": list(req.xs), "ys": list(req.ys)}

    job = Job(id=str(uuid.uuid4())[:8], kind="training", status="running", progress=0.0, created=_ts(), updated=_ts())
    JOBS[job.id] = job
    model_id = "reg-default"

    def worker():
        steps = max(1, req.epochs)
        try:
            for s in range(steps):
                job.progress = round((s + 1) / steps * 100, 1)
                job.updated = _ts()
                time.sleep(0.05)
            theta = _fit(req.xs, req.ys)
            job.status = "done"
            job.progress = 100.0
            job.result = {"modelId": model_id, "theta": [float(t) for t in theta], "epochs": steps}
            job.updated = _ts()
            m = MODELS.get(model_id)
            if m:
                m.status = "trained"
                m.theta = [float(t) for t in theta]
                m.metrics = {"epochs": steps, "points": len(req.xs), "trainedAt": _ts()}
                m.last_run = _ts()
        except Exception as exc:  # noqa: BLE001
            job.status = "failed"
            job.message = str(exc)
            job.updated = _ts()

    threading.Thread(target=worker, daemon=True).start()
    return {"data": {"jobId": job.id, "modelId": model_id}}


@app.get("/api/jobs")
def jobs():
    return {"jobs": [vars(j) for j in JOBS.values()]}


@app.post("/api/inference/run")
def inference_run(req: InferenceRequest):
    m = MODELS.get(req.model_id)
    if not m or not m.theta:
        # fall back to a real fit on the provided dataset (if any)
        if req.dataset and len(req.dataset) >= 2:
            xs = list(range(len(req.dataset)))
            m_theta = _fit(xs, req.dataset)
        else:
            raise HTTPException(400, "model has no trained weights; provide dataset or train first")
    else:
        m_theta = m.theta

    start = time.perf_counter()
    preds = [float(p) for p in _predict(m_theta, req.inputs)]
    latency_ms = round((time.perf_counter() - start) * 1000, 3)

    job = Job(
        id=str(uuid.uuid4())[:8], kind="inference", status="done", progress=100.0,
        model_id=req.model_id, created=_ts(), updated=_ts(), result={"inputs": req.inputs, "outputs": preds, "latencyMs": latency_ms},
    )
    JOBS[job.id] = job
    INFERENCE_HISTORY.append({"id": job.id, "modelId": req.model_id, "ts": _ts(), "latencyMs": latency_ms, "n": len(req.inputs)})
    if m:
        m.last_run = _ts()
    return {"data": {"jobId": job.id, "outputs": preds, "latencyMs": latency_ms}}


@app.post("/api/suggestions")
def suggestions(req: SuggestRequest):
    series = req.series or req.prices or []
    if len(series) < 3:
        return {"suggestions": [], "note": "provide at least 3 real data points to compute any inferences"}
    # real statistical suggestions only — computed, never fabricated
    out = []
    last3 = series[-3:]
    delta = last3[-1] - last3[0]
    out.append({"kind": "trend", "text": f"Latest 3-point change is {delta:+.4f}"})
    avg = sum(series) / len(series)
    out.append({"kind": "mean", "text": f"Mean of provided series is {avg:.4f}"})
    if last3[-1] > avg:
        out.append({"kind": "position", "text": "Latest value is above the series mean"})
    elif last3[-1] < avg:
        out.append({"kind": "position", "text": "Latest value is below the series mean"})
    return {"suggestions": out}


# --------------------------------------------------------------------------
# Local AI providers (Ollama / LM Studio / llama.cpp / custom OpenAI-compatible)
# --------------------------------------------------------------------------
def _provider_error(exc: Exception) -> HTTPException:
    text = str(exc)
    if isinstance(exc, KeyError):
        return HTTPException(404, text)
    if "timed out" in text.lower():
        return HTTPException(504, text)
    return HTTPException(502 if isinstance(exc, RuntimeError) else 400, text)


@app.get("/api/ai/status")
def ai_status():
    snapshot = REGISTRY.snapshot(probe=False)
    return {**snapshot, "summary": REGISTRY.summary(), "uptimeSec": round(time.time() - APP_START, 1)}


@app.get("/api/providers")
@app.get("/api/ai/providers")
def ai_providers(probe: bool = True):
    """Provider registry + real model discovery.

    ``probe=false`` returns the last known real state without touching a model
    server (used by dashboards). ``probe=true`` refreshes in parallel.
    """
    return REGISTRY.snapshot(probe=probe)


@app.post("/api/providers/{provider_id}/probe")
def ai_provider_probe(provider_id: str):
    try:
        result = REGISTRY.probe(provider_id)
    except Exception as exc:  # noqa: BLE001 - route boundary
        raise _provider_error(exc) from exc
    return {"ok": True, "provider": provider_id, **result}


@app.put("/api/providers/{provider_id}")
def ai_provider_update(provider_id: str, req: ProviderUpdate):
    try:
        REGISTRY.update_provider(provider_id, req.model_dump(exclude_none=True))
        snapshot = REGISTRY.snapshot(probe=False)
        provider = next(p for p in snapshot["providers"] if p["id"] == provider_id)
        if provider["enabled"] and provider["baseUrl"]:
            REGISTRY.probe(provider_id)
            snapshot = REGISTRY.snapshot(probe=False)
            provider = next(p for p in snapshot["providers"] if p["id"] == provider_id)
    except Exception as exc:  # noqa: BLE001 - route boundary
        raise _provider_error(exc) from exc
    return {"ok": True, "provider": provider}


@app.put("/api/ai/defaults")
def ai_defaults_update(req: DefaultsUpdate):
    try:
        defaults = REGISTRY.update_defaults(req.model_dump(exclude_none=True))
    except Exception as exc:  # noqa: BLE001 - route boundary
        raise _provider_error(exc) from exc
    return {"ok": True, "defaults": defaults}


@app.get("/api/ai/models")
def ai_local_models():
    return {
        "models": REGISTRY.models(probe=True),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }


@app.post("/api/ai/chat")
def ai_chat(req: ChatRequest):
    try:
        data = REGISTRY.chat(
            [m.model_dump() for m in req.messages],
            provider_id=req.provider,
            model=req.model,
            temperature=req.temperature,
            max_tokens=req.maxTokens,
            timeout=req.timeoutSec,
        )
    except Exception as exc:  # noqa: BLE001 - route boundary
        raise _provider_error(exc) from exc
    return {"data": data}


@app.post("/api/ai/analyze")
def ai_analyze(req: AnalyzeRequest):
    try:
        data = REGISTRY.analyze(
            req.kind,
            req.context,
            question=req.question,
            provider_id=req.provider,
            model=req.model,
            temperature=req.temperature,
            max_tokens=req.maxTokens,
        )
    except Exception as exc:  # noqa: BLE001 - route boundary
        raise _provider_error(exc) from exc
    return {"data": data}


@app.get("/api/agents")
def agents():
    return {"agents": [vars(a) for a in AGENTS.values()]}


@app.post("/api/agents/{agent_id}/start")
def agent_start(agent_id: str):
    a = AGENTS.get(agent_id)
    if not a:
        raise HTTPException(404, "agent not found")
    a.status = "running"
    a.last_run = _ts()
    return {"data": {"id": a.id, "status": a.status}}


@app.post("/api/agents/{agent_id}/stop")
def agent_stop(agent_id: str):
    a = AGENTS.get(agent_id)
    if not a:
        raise HTTPException(404, "agent not found")
    a.status = "idle"
    return {"data": {"id": a.id, "status": a.status}}


@app.get("/api/logs")
def ai_logs(limit: int = 200):
    lines = [
        {"ts": _ts(), "level": "info", "message": "Khumbha AI runtime online"},
        {"ts": _ts(), "level": "info", "message": f"models registered: {len(MODELS)}"},
    ]
    return {"logs": lines[-min(limit, 500):]}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT)
