"""Market calendar — the single source of truth for market-day classification.

Every component (scheduler, endpoints, UI) must read trading-day state from
here; nobody maintains their own private holiday set. The scheduler uses
``is_trading_day`` / ``day_class`` so that a weekday + exchange holiday is
never mistaken for an open market, and so a manual session kept alive on a
closed day is independent of the MARKET / WEBSOCKET states.

Classifications:
    WEEKEND             Saturday / Sunday
    EXCHANGE_HOLIDAY    known NSE/BSE holiday (weekday)
    SPECIAL_CLOSURE     1-off / no-session day with a recorded reason
    NORMAL_MARKET_DAY   a real trading day

Market session (IST) follows the NSE cash-market convention:
    PRE_OPEN    09:00:00 - 09:14:59
    OPEN        09:15:00 - 15:30:00
    POST_CLOSE  15:30:00 - 16:00:00
    CLOSED       otherwise

Holidays must be updated annually — the set below is honest about the years
it covers and empty for future years (an unknown day is treated as a normal
market day rather than a fabricated closure).
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Optional

from core.timezones import IST

# Exchange hours (NSE cash) in IST.
OPEN_TIME = time(9, 15, 0)
CLOSE_TIME = time(15, 30, 0)
PRE_OPEN_TIME = time(9, 0, 0)
POST_CLOSE_TIME = time(16, 0, 0)

# Day classes.
WEEKEND = "WEEKEND"
EXCHANGE_HOLIDAY = "EXCHANGE_HOLIDAY"
SPECIAL_CLOSURE = "SPECIAL_CLOSURE"
NORMAL_MARKET_DAY = "NORMAL_MARKET_DAY"

# Known NSE/BSE holidays (2025 and 2026 calendars). Update annually.
# IMPORTANT: Only include ACTUAL confirmed exchange holidays. Do NOT add dates
# without verifying against the official NSE holiday calendar at
# https://www.nseindia.com/resources/exchange-communication-holidays
# A weekday NOT in this set IS a potential trading day — false positives here
# cause the entire system to incorrectly report "Exchange holiday" for normal
# trading days.
KNOWN_HOLIDAYS = {
    # 2025 NSE holidays
    "2025-02-26",  # Maha Shivaratri
    "2025-03-14",  # Holi
    "2025-03-31",  # Id-ul-Fitr
    "2025-04-10",  # Shri Mahavir Jayanti
    "2025-04-14",  # Dr. Ambedkar Jayanti / Tamil New Year
    "2025-04-18",  # Good Friday
    "2025-05-01",  # Maharashtra Day
    "2025-05-12",  # Buddha Purnima
    "2025-06-16",  # Eid-ul-Adha
    "2025-07-07",  # Muharram
    "2025-08-15",  # Independence Day
    "2025-08-27",  # Ganesh Chaturthi
    "2025-10-02",  # Mahatma Gandhi Jayanti
    "2025-10-21",  # Diwali Laxmi Pujan
    "2025-10-22",  # Diwali Balipratipada
    "2025-11-05",  # Prakash Gurpurab / Guru Nanak Jayanti
    "2025-12-25",  # Christmas
    # 2026 NSE holidays
    "2026-01-26",  # Republic Day
    "2026-03-16",  # Holi
    "2026-03-17",  # Holi (additional)
    "2026-04-03",  # Shri Mahavir Jayanti
    "2026-04-07",  # Ram Navami
    "2026-04-10",  # Good Friday
    "2026-05-01",  # Maharashtra Day
    "2026-05-25",  # Eid-ul-Adha
    "2026-07-06",  # Muharram
    "2026-08-15",  # Independence Day
    "2026-10-02",  # Mahatma Gandhi Jayanti
    "2026-10-21",  # Diwali Laxmi Pujan
    "2026-11-05",  # Prakash Gurpurab
    "2026-12-25",  # Christmas
}

# 1-off market closures with an explicit recorded reason (never invented).
SPECIAL_CLOSURES: dict[str, str] = {
    # "YYYY-MM-DD": "reason",
}

# Sessions.
PRE_OPEN = "PRE_OPEN"
OPEN_SESSION = "OPEN"
POST_CLOSE = "POST_CLOSE"
CLOSED = "CLOSED"

MARKET_SESSIONS = (PRE_OPEN, OPEN_SESSION, POST_CLOSE, CLOSED)


def _ist_now() -> datetime:
    return datetime.now(IST)


def _as_date(value: datetime | date) -> date:
    if isinstance(value, datetime):
        return value.astimezone(IST).date()
    return value


def day_class(value: datetime | date | None = None) -> str:
    """Classify a date (default today IST) into the 4-way day taxonomy."""
    d = _as_date(value or _ist_now())
    key = d.isoformat()
    if key in SPECIAL_CLOSURES:
        return SPECIAL_CLOSURE
    if key in KNOWN_HOLIDAYS:
        return EXCHANGE_HOLIDAY
    if d.weekday() >= 5:
        return WEEKEND
    return NORMAL_MARKET_DAY


def is_trading_day(value: datetime | date | None = None) -> bool:
    """A real market day: weekday + not an exchange holiday / special closure."""
    return day_class(value) == NORMAL_MARKET_DAY


def closure_reason(value: datetime | date | None = None) -> Optional[str]:
    """Human reason why the market is not open, or None on a normal day."""
    cls = day_class(value)
    if cls == SPECIAL_CLOSURE:
        return SPECIAL_CLOSURES.get(_as_date(value or _ist_now()).isoformat(), "Special market closure")
    if cls == EXCHANGE_HOLIDAY:
        return "Exchange holiday"
    if cls == WEEKEND:
        return "Weekend"
    return None


def _day_at(d: date, t: time) -> datetime:
    return datetime.combine(d, t, tzinfo=IST)


def _next_market_day(from_date: date) -> Optional[date]:
    """Earliest trading day on/after ``from_date``, scanning at most 90 days."""
    probe = from_date
    for _ in range(90):
        if probe.weekday() < 5 and probe.isoformat() not in KNOWN_HOLIDAYS \
                and probe.isoformat() not in SPECIAL_CLOSURES:
            return probe
        probe += timedelta(days=1)
    return None


def next_trading_day(from_date: Optional[date] = None) -> Optional[date]:
    """Earliest trading day STRICTLY after ``from_date`` (default today)."""
    base = from_date or _ist_now().date()
    return _next_market_day(base + timedelta(days=1))


def market_session(value: datetime | None = None) -> str:
    """IST market session bucket for the given moment (default now)."""
    now = value or _ist_now()
    if isinstance(now, datetime):
        now = now.astimezone(IST)
    if not is_trading_day(now.date()):
        return CLOSED
    t = now.time()
    if PRE_OPEN_TIME <= t < OPEN_TIME:
        return PRE_OPEN
    if OPEN_TIME <= t <= CLOSE_TIME:
        return OPEN_SESSION
    if CLOSE_TIME < t < POST_CLOSE_TIME:
        return POST_CLOSE
    return CLOSED


def market_status(value: datetime | None = None) -> str:
    return "OPEN" if market_session(value) in {PRE_OPEN, OPEN_SESSION} else "CLOSED"


def next_market_open() -> Optional[datetime]:
    """Next (future) market open in IST, or None if none within 90 days."""
    now = _ist_now()
    d = now.date()
    today_open = _day_at(d, OPEN_TIME)
    if is_trading_day(d) and now < today_open:
        return today_open
    nxt = _next_market_day(d)
    return _day_at(nxt, OPEN_TIME) if nxt else None


def next_market_close() -> Optional[datetime]:
    """Close of the next market day, or None within the 90-day lookahead."""
    nxt = _next_market_day(_ist_now().date())
    return _day_at(nxt, CLOSE_TIME) if nxt else None


def snapshot(now: datetime | None = None) -> dict:
    """Authoritative market snapshot consumed by /api/system/market and UI."""
    now = now or _ist_now()
    if isinstance(now, datetime):
        now = now.astimezone(IST)
    d = _as_date(now)
    cls = day_class(d)
    session = market_session(now)
    open_at = next_market_open()
    close_at = next_market_close()
    return {
        "market_status": market_status(now),
        "market_session": session,
        "market_date": d.isoformat(),
        "day_class": cls,
        "trading_day": is_trading_day(d),
        "closure_reason": closure_reason(d),
        "is_weekend": cls == WEEKEND,
        "is_exchange_holiday": cls == EXCHANGE_HOLIDAY,
        "is_special_closure": cls == SPECIAL_CLOSURE,
        "next_market_open": open_at.isoformat() if open_at else None,
        "next_market_close": close_at.isoformat() if close_at else None,
        "next_trading_day": next_trading_day(d).isoformat() if next_trading_day(d) else None,
        "now_ist": now.isoformat(),
        "timezone": "Asia/Kolkata (IST, +05:30)",
    }