"""
KAUSTUBH Trading Platform — FastAPI backend.

Single Python backend that replaces the Node.js layer entirely.
Talks directly to MongoDB (Motor) and the Kotak Neo SDK.
"""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from scheduler import do_login
from fastapi.middleware.cors import CORSMiddleware

from config.settings import settings
from database.connection import connect_mongo, disconnect_mongo
from services import tick_buffer
from scheduler import start_scheduler, stop_scheduler
from core.event_loop import set_loop

# Import all routers
from api.routes import router as session_router
from api.stocks import router as stocks_router
from api.ticks import router as ticks_router
from api.downloads import router as downloads_router
from api.statistics import router as statistics_router
from api.logs import router as logs_router
from api.system import router as system_router
from api.settings import router as settings_router
from api.trading import router as trading_router
from api.watchlist import router as watchlist_router
from api.notifications import router as notifications_router
from api.baskets import router as baskets_router

# Configure logging
logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("app")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("KAUSTUBH FastAPI backend starting up...")
    import asyncio
    set_loop(asyncio.get_running_loop())

    await connect_mongo()
    await tick_buffer.start()
    start_scheduler()
    
    await connect_mongo()
    await tick_buffer.start()
    start_scheduler()
    yield
    logger.info("KAUSTUBH FastAPI backend shutting down...")
    stop_scheduler()
    await tick_buffer.stop()
    await disconnect_mongo()


app = FastAPI(
    title="KAUSTUBH Trading Platform",
    description="Production Kotak Neo trading backend",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins.split(",") if settings.cors_origins != "*" else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount all routers
app.include_router(session_router)
app.include_router(stocks_router)
app.include_router(ticks_router)
app.include_router(downloads_router)
app.include_router(statistics_router)
app.include_router(logs_router)
app.include_router(system_router)
app.include_router(settings_router)
app.include_router(trading_router)
app.include_router(watchlist_router)
app.include_router(notifications_router)
app.include_router(baskets_router)


@app.post("/debug/login")
async def debug_login():
    result = await do_login()
    return {
        "success": result
    }
if __name__ == "__main__":
    uvicorn.run(
        "app:app",
        host=settings.host,
        port=settings.port,
        reload=False,
    )

@app.middleware("http")
async def log_requests(request, call_next):
    print(f"REQUEST => {request.method} {request.url.path}")
    response = await call_next(request)
    print(f"RESPONSE <= {response.status_code}")
    return response