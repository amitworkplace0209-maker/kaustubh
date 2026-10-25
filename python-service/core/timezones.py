"""Canonical timezone authority for the entire project.

Every timestamp in this project is Indian Standard Time (IST, Asia/Kolkata,
UTC+05:30). This module is the ONE place that knows that, so the rest of the
codebase never re-derives the offset (previously duplicated in ~25 modules).

Storage vs. display
-------------------
MongoDB stores BSON dates as UTC epoch milliseconds, always. That is a storage
encoding detail and is NOT a second project timezone: the instant is identical.
What this module guarantees is that the *labelled* value handed to application
code and to the UI is always IST.

    * Write:  aware datetime (any tz) -> pymongo encodes the same instant.
    * Read:   legacy naive datetimes from pymongo are UTC; :func:`to_ist`
              attaches UTC to them, then converts, so no instant shifts.
    * Show:   :func:`iso_ist` renders ``+05:30`` so nothing is ambiguous.

Naive datetimes are therefore always interpreted as UTC, never as IST. Writing
a naive *IST* value to Mongo would silently shift data by 5h30m, so that never
happens in this codebase.
"""
from __future__ import annotations

import os
import time as _time
from datetime import date, datetime, timezone
from typing import Optional
from zoneinfo import ZoneInfo

#: IANA name of the single project timezone.
TZ_NAME = "Asia/Kolkata"

#: The one true timezone object. India has observed a constant +05:30 offset
#: with no DST since 1945, so this is stable year-round.
IST: ZoneInfo = ZoneInfo(TZ_NAME)

#: Human label used in status payloads.
IST_LABEL = "Asia/Kolkata (IST, +05:30)"

UTC = timezone.utc


def register_process_timezone() -> None:
    """Pin the OS-level timezone to IST.

    Affects ``time.localtime``/``time.strftime`` (and therefore log timestamps
    and any naive ``datetime.now()``) without touching the aware helpers below.
    """
    os.environ["TZ"] = TZ_NAME
    if hasattr(_time, "tzset"):
        _time.tzset()


def now_ist() -> datetime:
    """Current instant as a timezone-aware IST datetime."""
    return datetime.now(IST)


def now_utc() -> datetime:
    """Current instant as a timezone-aware UTC datetime (for storage)."""
    return datetime.now(UTC)


def ensure_aware(value: datetime) -> datetime:
    """Return an aware datetime, treating a naive value as UTC (pymongo legacy)."""
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value


def to_ist(value: datetime) -> datetime:
    """Convert any datetime to aware IST. Naive input is treated as UTC."""
    return ensure_aware(value).astimezone(IST)


def to_utc(value: datetime) -> datetime:
    """Convert any datetime to aware UTC (the storage form)."""
    return ensure_aware(value).astimezone(UTC)


def iso_ist(value: Optional[datetime]) -> Optional[str]:
    """ISO-8601 string in IST with an explicit ``+05:30`` offset."""
    if value is None:
        return None
    return to_ist(value).isoformat()


def business_date(value: Optional[datetime] = None) -> date:
    """Trading/business calendar date in IST (never UTC)."""
    return to_ist(value or now_ist()).date()


def business_date_str(value: Optional[datetime] = None) -> str:
    """``YYYY-MM-DD`` business date in IST."""
    return business_date(value).isoformat()


def epoch_ms_to_ist(ms: float) -> datetime:
    """Convert a broker/market epoch-milliseconds stamp to aware IST."""
    return datetime.fromtimestamp(ms / 1000.0, IST)


def epoch_to_ist(seconds: float) -> datetime:
    """Convert a broker/market epoch-seconds stamp to aware IST."""
    return datetime.fromtimestamp(seconds, IST)
