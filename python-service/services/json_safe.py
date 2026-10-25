"""Centralized JSON-safe serialization for MongoDB / BSON data.

Every API response that may contain MongoDB-specific types (ObjectId,
datetime, Decimal, Regex, etc.) should pipe its payload through
``sanitize_for_json()`` before returning to FastAPI. This prevents
``TypeError: 'ObjectId' object is not iterable`` and similar serialization
failures without modifying the source documents.
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any

from core.timezones import UTC, iso_ist, to_ist


def sanitize_for_json(obj: Any) -> Any:
    """Recursively convert BSON-specific types to JSON-safe primitives.

    Every ``datetime`` is rendered in IST with an explicit ``+05:30`` offset so
    no consumer ever has to guess which timezone it is looking at.
    """
    if obj is None or isinstance(obj, (bool, int, float, str)):
        return obj
    if isinstance(obj, datetime):
        return iso_ist(obj)
    # ObjectId -> str
    if hasattr(obj, "__class__") and obj.__class__.__name__ == "ObjectId":
        return str(obj)
    # Decimal -> float
    if hasattr(obj, "__class__") and obj.__class__.__name__ == "Decimal":
        try:
            return float(obj)
        except Exception:
            return str(obj)
    if isinstance(obj, (list, tuple)):
        return [sanitize_for_json(item) for item in obj]
    if isinstance(obj, dict):
        return {str(k): sanitize_for_json(v) for k, v in obj.items()}
    # Bytes, sets, and anything else -> str
    return str(obj)


def safe_json_dumps(obj: Any, **kwargs) -> str:
    """JSON dumps with automatic BSON-safe fallback."""
    return json.dumps(obj, default=str, **kwargs)


# ---------------------------------------------------------------------------
# Response-level timezone normalization
# ---------------------------------------------------------------------------
# Most routes pipe their payload through ``sanitize_for_json`` (or already
# return datetimes that FastAPI renders), but a number of endpoints pre-serialize
# timestamps to an ISO string with an explicit UTC designator before returning
# them. Those would otherwise reach the client as the only non-IST timestamps in
# the product. Rather than touching every one of those call sites (and risking a
# behavioural change in each), the response body is normalized once, centrally,
# on the way out.

_UTC_ISO_RE = re.compile(
    r'"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6})\d*)?(?:Z|\+00:00)"'
)
# Length-preserving in-place rewrite: "+00:00" and "+05:30" are both 6 bytes,
# so the declared Content-Length stays correct and the body can be patched
# chunk-by-chunk without ever buffering a (possibly streaming) response.
_UTC_OFFSET_RE = re.compile(rb"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,6})?\+00:00")


def _utc_offset_match_to_ist(match: "re.Match[bytes]") -> bytes:
    """Convert a ``...+00:00`` instant to IST, keeping the byte length identical.

    Converting the instant (rather than only relabelling the offset) is what
    makes the result honest: ``09:42Z`` must reach the UI as ``15:12+05:30``,
    not as ``09:42+05:30``. The rendered form has the same number of digits as
    the input -- same date/time pattern, same 6-byte offset -- so the caller's
    declared ``Content-Length`` stays valid.
    """
    base = match.group(1).decode("ascii")
    frac = (match.group(2) or b"").decode("ascii")
    try:
        moment = datetime.strptime(base, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=UTC)
    except ValueError:
        return match.group(0)
    ist = to_ist(moment)
    return f"{ist:%Y-%m-%dT%H:%M:%S}{frac}+05:30".encode("ascii")


def _utc_match_to_ist(match: "re.Match[str]") -> str:
    base, frac = match.group(1), match.group(2)
    try:
        moment = datetime.strptime(base, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=UTC)
    except ValueError:
        return match.group(0)
    ist = to_ist(moment)
    micros = f".{frac}" if frac else ""
    return f'"{ist:%Y-%m-%dT%H:%M:%S}{micros}+05:30"'


def normalize_response_timestamps(body: bytes) -> bytes:
    """Rewrite any remaining ``Z`` / ``+00:00`` ISO timestamps in a response
    body to IST with an explicit ``+05:30`` offset.

    Operates on the serialized bytes (no JSON round-trip) so numbers keep their
    exact representation, and only full date-times are touched -- plain dates
    such as ``"2026-09-28"`` are left alone.

    Note this can change the body length (``Z`` -> ``+05:30``), so it is only
    safe where the caller also owns ``Content-Length``. For the response path
    use :func:`rewrite_utc_offsets_inplace`, which never changes the length.
    """
    if not body or (b"+00:00" not in body and b'"Z"' not in body):
        return body
    try:
        return _UTC_ISO_RE.sub(_utc_match_to_ist, body.decode("utf-8")).encode("utf-8")
    except (UnicodeDecodeError, ValueError):
        return body


def rewrite_utc_offsets_inplace(body: bytes) -> bytes:
    """Convert every ``+00:00`` ISO timestamp in a response body to IST.

    Used by the response middleware (:class:`app.IstTimestampMiddleware`). The
    instant is **converted** to ``+05:30`` (``09:42:58+00:00`` ->
    ``15:12:58+05:30``); only relabelling the offset without moving the instant
    would put every timestamp on screen 5h30m behind real time while claiming
    to be IST, which violates the project timezone invariant.

    The substitution is byte-length preserving (same digits, same 6-byte
    offset), so the declared ``Content-Length`` remains valid and streaming
    bodies are never buffered. ``Z``-suffixed timestamps are deliberately *not*
    handled here (that rewrite is not length-preserving) and must be prevented
    at source by :func:`sanitize_for_json`.
    """
    if not body or b"+00:00" not in body:
        return body
    return _UTC_OFFSET_RE.sub(_utc_offset_match_to_ist, body)

