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
from core.event_loop import get_loop
import logging
import threading
from datetime import datetime, timedelta, timezone

from config.settings import settings
from auth.kotak_client import kotak_session
from ws_socket.ws_manager import ws_manager
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
_websocket_start_timer: threading.Timer | None = None
_websocket_stop_timer: threading.Timer | None = None
# Session owner:
# scheduler = automatic market-hours login
# manual = manual fallback login
_session_owner: str | None = None
_manual_logout_timer: threading.Timer | None = None
def _run_on_app_loop(coro):
    loop = get_loop()
    return asyncio.run_coroutine_threadsafe(coro, loop)


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


async def do_login(
    source: str = "scheduler",
    retry: int = 3,
) -> bool:
    global _session_owner, _manual_logout_timer

    logger.info(
        "do_login called (source=%s, retry=%d)",
        source,
        retry,
    )

    # Only these two login sources are allowed.
    if source not in {"scheduler", "manual"}:
        logger.error("Invalid login source: %s", source)
        return False

    # --------------------------------------------------------
    # If a session is already active, NEVER login again.
    # --------------------------------------------------------

    if kotak_session.session_active:

        if _session_owner == "scheduler":
            logger.info(
                "Login skipped: scheduler session already active"
            )
            return True

        if _session_owner == "manual":
            logger.info(
                "Login skipped: manual session already active"
            )
            return True

        logger.warning(
            "Active session detected but session owner is unknown"
        )
        return True

    # --------------------------------------------------------
    # Manual login is only a fallback.
    # It must never replace a scheduler session.
    # --------------------------------------------------------

    if source == "manual" and _session_owner == "scheduler":
        logger.info(
            "Manual login blocked: scheduler session is active"
        )
        return True

    for attempt in range(retry):
        try:
            await tick_buffer.start()

            kotak_session.login()

            # Login must result in an active Kotak session.
            if not kotak_session.session_active:
                raise RuntimeError(
                    "Kotak login completed but session is not active"
                )

            # ------------------------------------------------
            # Load active stocks from MongoDB.
            # ------------------------------------------------

            db = get_db()
            cursor = db.stocks.find({"active": True})
            stocks = await cursor.to_list(length=None)

            tokens = [
                {
                    "instrument_token": s["instrumentToken"],
                    "exchange_segment": s.get(
                        "exchangeSegment",
                        "nse_cm",
                    ),
                    "isIndex": s.get("isIndex", False),
                    "isDepth": s.get("isDepth", False),
                    "symbol": s["symbol"],
                }
                for s in stocks
            ]

            # ------------------------------------------------
            # Session ownership is assigned after login.
            # ------------------------------------------------

            _session_owner = source

            # ------------------------------------------------
            # Manual login gets a 30-minute timeout.
            # Scheduler login does NOT.
            # ------------------------------------------------

            if source == "manual":

                if _manual_logout_timer is not None:
                    _manual_logout_timer.cancel()

                _manual_logout_timer = threading.Timer(
                    30 * 60,
                    _manual_logout_job,
                )

                _manual_logout_timer.daemon = True
                _manual_logout_timer.start()

                logger.info(
                    "Manual session started; "
                    "automatic logout scheduled in 30 minutes"
                )

            else:
                logger.info(
                    "Scheduler session started; "
                    "manual timeout disabled"
                )

            # ------------------------------------------------
            # WebSocket handling.
            #
            # Normal day:
            #   Login 09:00
            #   WebSocket 09:13
            #
            # If backend starts after 09:13:
            #   Login
            #   WebSocket starts immediately
            # ------------------------------------------------

            now_ist = _now_ist()

            ws_start_time = now_ist.replace(
                hour=settings.ws_start_hour,
                minute=settings.ws_start_minute,
                second=0,
                microsecond=0,
            )

            ws_stop_time = now_ist.replace(
                hour=settings.ws_stop_hour,
                minute=settings.ws_stop_minute,
                second=0,
                microsecond=0,
            )

            if ws_start_time <= now_ist < ws_stop_time:
                logger.info(
                    "Login happened inside WebSocket window — "
                    "starting WebSocket now"
                )

                await start_websocket_session()

            logger.info(
                "Login succeeded on attempt %d, "
                "source=%s, WebSocket subscription active/pending",
                attempt + 1,
                source,
            )

            return True

        except Exception as exc:
            logger.error(
                "Login attempt %d failed: %s",
                attempt + 1,
                exc,
            )

            if attempt < retry - 1:
                await asyncio.sleep(2 ** attempt)

    logger.error(
        "All %d login attempts failed (source=%s)",
        retry,
        source,
    )

    return False
def _manual_logout_job():
    global _manual_logout_timer

    _manual_logout_timer = None

    # Manual timer must never logout a scheduler session.
    if _session_owner != "manual":
        logger.info(
            "Manual logout timer ignored: session owner is %s",
            _session_owner,
        )
        return

    logger.info(
        "Manual 30-minute session expired; logging out"
    )

    _run_on_app_loop(
        do_logout(source="manual")
    )
async def start_websocket_session() -> bool:
    """
    Start WebSocket subscription at the configured WebSocket start time.

    Login must already be active.
    Active stocks are loaded fresh from MongoDB.
    """
    try:
        if not kotak_session.session_active:
            logger.warning(
                "WebSocket start skipped: Kotak session is not active"
            )
            return False

        db = get_db()
        cursor = db.stocks.find({"active": True})
        stocks = await cursor.to_list(length=None)

        tokens = [
            {
                "instrument_token": s["instrumentToken"],
                "exchange_segment": s.get(
                    "exchangeSegment",
                    "nse_cm",
                ),
                "isIndex": s.get("isIndex", False),
                "isDepth": s.get("isDepth", False),
                "symbol": s["symbol"],
            }
            for s in stocks
        ]

        if not tokens:
            logger.warning(
                "WebSocket start skipped: no active stocks found"
            )
            return False

        await ws_manager.subscribe(tokens)

        logger.info(
            "WebSocket session started: subscribed %d tokens",
            len(tokens),
        )

        return True

    except Exception as exc:
        logger.error(
            "WebSocket start failed: %s",
            exc,
        )
        return False

async def stop_websocket_session() -> bool:
    """
    Stop WebSocket at the configured WebSocket stop time.
    Kotak login session remains active until logout time.
    """
    try:
        ws_manager.disconnect()

        logger.info(
            "WebSocket session stopped at configured stop time"
        )

        return True

    except Exception as exc:
        logger.error(
            "WebSocket stop failed: %s",
            exc,
        )
        return False
 
async def do_logout(source: str | None = None) -> bool:
    global _session_owner, _manual_logout_timer

    logger.info(
        "do_logout called (source=%s, owner=%s)",
        source,
        _session_owner,
    )

    # --------------------------------------------------------
    # Manual 30-minute timer is allowed to logout ONLY a
    # manual session.
    #
    # If scheduler has already taken ownership, the old
    # manual timer must do nothing.
    # --------------------------------------------------------

    if source == "manual" and _session_owner != "manual":
        logger.info(
            "Manual logout skipped: session owner is %s",
            _session_owner,
        )
        return True

    try:
        ws_manager.disconnect()

        kotak_session.logout()

        await tick_buffer.stop()

        # Session is now completely closed.
        _session_owner = None

        # Cancel any pending manual timer.
        if _manual_logout_timer is not None:
            _manual_logout_timer.cancel()
            _manual_logout_timer = None

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
def _schedule_websocket_start():
    global _websocket_start_timer

    delay = _seconds_until(
        settings.ws_start_hour,
        settings.ws_start_minute,
    )

    _websocket_start_timer = threading.Timer(
        delay,
        _websocket_start_job,
    )

    _websocket_start_timer.daemon = True
    _websocket_start_timer.start()

    next_time = _now_ist() + timedelta(seconds=delay)

    logger.info(
        "Next WebSocket start scheduled: %s IST",
        next_time.strftime("%Y-%m-%d %H:%M"),
    )

def _schedule_websocket_stop():
    global _websocket_stop_timer

    delay = _seconds_until(
        settings.ws_stop_hour,
        settings.ws_stop_minute,
    )

    _websocket_stop_timer = threading.Timer(
        delay,
        _websocket_stop_job,
    )

    _websocket_stop_timer.daemon = True
    _websocket_stop_timer.start()

    next_time = _now_ist() + timedelta(seconds=delay)

    logger.info(
        "Next WebSocket stop scheduled: %s IST",
        next_time.strftime("%Y-%m-%d %H:%M"),
    )

def _websocket_stop_job():
    if _is_trading_day():
        _run_on_app_loop(stop_websocket_session())
    else:
        logger.info(
            "Skipping WebSocket stop — not a trading day"
        )

    _schedule_websocket_stop() 

def _websocket_start_job():
    if _is_trading_day():
        _run_on_app_loop(start_websocket_session())
    else:
        logger.info(
            "Skipping WebSocket start — not a trading day"
        )

    _schedule_websocket_start()

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
        _run_on_app_loop(do_login(source="scheduler"))
        
    else:
        logger.info("Skipping login — not a trading day")
    _schedule_login()


def _logout_job():
    if _is_trading_day():
        _run_on_app_loop(do_logout())
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
    logger.info(
        "DEBUG => trading_day=%s | now=%s | login=%s | logout=%s | session_active=%s",
        _is_trading_day(),
        now.strftime("%Y-%m-%d %H:%M:%S"),
        login_time.strftime("%Y-%m-%d %H:%M:%S"),
        logout_time.strftime("%Y-%m-%d %H:%M:%S"),
        kotak_session.session_active,
)
    if _is_trading_day() and login_time <= now <= logout_time and not kotak_session.session_active:
        logger.info("Service started during trading hours — logging in now")
        _run_on_app_loop(do_login(source="scheduler"))
    _schedule_login()
    _schedule_logout()
    _schedule_websocket_start()
    _schedule_websocket_stop()
    logger.info("Scheduler started")


def stop_scheduler():
    global _running, _login_timer, _logout_timer
    global _websocket_start_timer, _websocket_stop_timer
    _running = False
    if _websocket_start_timer:
       _websocket_start_timer.cancel()
       _websocket_start_timer = None

if _websocket_stop_timer:
    _websocket_stop_timer.cancel()
    _websocket_stop_timer = None
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

