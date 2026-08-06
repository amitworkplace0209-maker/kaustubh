"""
IST scheduler with holiday calendar, login-now logic, and retry.

Features:
- Auto login at 09:00 IST, logout at 15:35 IST on weekdays
- NSE/BSE holiday calendar (skip trading holidays)
- Login-now if service starts mid-trading-day
- Retry on login failure (3 attempts)
- Non-blocking async scheduling
"""
from __future__ import annotations

import asyncio
import logging
import threading
from datetime import datetime, timedelta, timezone

from config.settings import settings
from auth.kotak_client import kotak_session
from websocket.ws_manager import ws_manager
from services import tick_buffer
from database.connection import get_db

logger = logging.getLogger("scheduler")

IST = timezone(timedelta(hours=5, minutes=30))

# NSE/BSE holidays for 2025-2026 (update annually)
MARKET_HOLIDAYS_2025_2026 = {
    "2025-02-26", "2025-03-14", "2025-03-31", "2025-04-10", "2025-04-14",
    "2025-04-18", "2025-05-01", "2025-05-12", "2025-06-16", "2025-07-07",
    "2025-08-15", "2025-08-27", "2025-10-02", "2025-10-21", "2025-10-22",
    "2025-11-05", "2025-12-25",
    "2026-01-26", "2026-03-16", "2026-03-17", "2026-04-03", "2026-04-07",
    "2026-04-10", "2026-05-01", "2026-05-25", "2026-07-06", "2026-08-15",
    "2026-09-04", "2026-10-02", "2026-10-21", "2026-11-05", "2026-12-25",
}

_running = False
_login_timer: threading.Timer | None = None
_logout_timer: threading.Timer | None = None


def _now_ist() -> datetime:
    return datetime.now(IST)


def _is_weekday() -> bool:
    return _now_ist().weekday() < 5


def _is_holiday() -> bool:
    return _now_ist().strftime("%Y-%m-%d") in MARKET_HOLIDAYS_2025_2026


def _is_trading_day() -> bool:
    return _is_weekday() and not _is_holiday()


def _seconds_until(hour: int, minute: int) -> float:
    now = _now_ist()
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return (target - now).total_seconds()


async def do_login(retry: int = 3) -> bool:
    logger.info("do_login called (retry=%d)", retry)
    for attempt in range(retry):
        try:
            await tick_buffer.start()
            kotak_session.login()

            db = get_db()
            cursor = db.stocks.find({"active": True})
            stocks = await cursor.to_list(length=None)
            tokens = [
                {
                    "instrument_token": s["instrumentToken"],
                    "exchange_segment": s.get("exchangeSegment", "nse_cm"),
                    "isIndex": s.get("isIndex", False),
                    "isDepth": s.get("isDepth", False),
                    "symbol": s["symbol"],
                }
                for s in stocks
            ]
            if tokens:
                await ws_manager.subscribe(tokens)
            logger.info("Login succeeded on attempt %d, subscribed %d tokens", attempt + 1, len(tokens))
            return True
        except Exception as exc:
            logger.error("Login attempt %d failed: %s", attempt + 1, exc)
            if attempt < retry - 1:
                await asyncio.sleep(2 ** attempt)
    logger.error("All %d login attempts failed", retry)
    return False


async def do_logout() -> bool:
    logger.info("do_logout called")
    try:
        ws_manager.disconnect()
        kotak_session.logout()
        await tick_buffer.stop()
        logger.info("Logout succeeded")
        return True
    except Exception as exc:
        logger.error("Logout failed: %s", exc)
        return False


def _schedule_login():
    global _login_timer
    delay = _seconds_until(settings.login_hour, settings.login_minute)
    _login_timer = threading.Timer(delay, _login_job)
    _login_timer.daemon = True
    _login_timer.start()
    next_time = _now_ist() + timedelta(seconds=delay)
    logger.info("Next login scheduled: %s IST", next_time.strftime("%Y-%m-%d %H:%M"))


def _schedule_logout():
    global _logout_timer
    delay = _seconds_until(settings.logout_hour, settings.logout_minute)
    _logout_timer = threading.Timer(delay, _logout_job)
    _logout_timer.daemon = True
    _logout_timer.start()
    next_time = _now_ist() + timedelta(seconds=delay)
    logger.info("Next logout scheduled: %s IST", next_time.strftime("%Y-%m-%d %H:%M"))


def _login_job():
    if _is_trading_day():
        asyncio.run(do_login())
    else:
        logger.info("Skipping login — not a trading day")
    _schedule_login()


def _logout_job():
    if _is_trading_day():
        asyncio.run(do_logout())
    else:
        logger.info("Skipping logout — not a trading day")
    _schedule_logout()


def start_scheduler():
    global _running
    if _running:
        return
    _running = True

    # Login now if we're already in trading hours
    now = _now_ist()
    login_time = now.replace(hour=settings.login_hour, minute=settings.login_minute, second=0, microsecond=0)
    logout_time = now.replace(hour=settings.logout_hour, minute=settings.logout_minute, second=0, microsecond=0)
    if _is_trading_day() and login_time <= now <= logout_time and not kotak_session.session_active:
        logger.info("Service started during trading hours — logging in now")
        threading.Thread(target=lambda: asyncio.run(do_login()), daemon=True).start()

    _schedule_login()
    _schedule_logout()
    logger.info("Scheduler started")


def stop_scheduler():
    global _running, _login_timer, _logout_timer
    _running = False
    if _login_timer:
        _login_timer.cancel()
        _login_timer = None
    if _logout_timer:
        _logout_timer.cancel()
        _logout_timer = None
    logger.info("Scheduler stopped")


def get_scheduler_info() -> dict:
    now = _now_ist()
    next_login = now + timedelta(seconds=_seconds_until(settings.login_hour, settings.login_minute))
    next_logout = now + timedelta(seconds=_seconds_until(settings.logout_hour, settings.logout_minute))
    return {
        "running": _running,
        "login_time": f"{settings.login_hour:02d}:{settings.login_minute:02d}",
        "logout_time": f"{settings.logout_hour:02d}:{settings.logout_minute:02d}",
        "is_trading_day": _is_trading_day(),
        "next_login": next_login.isoformat(),
        "next_logout": next_logout.isoformat(),
    }
