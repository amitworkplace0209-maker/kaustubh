"""Project-wide timezone invariants.

Every timestamp the project produces must be IST (Asia/Kolkata, +05:30).
These tests guard the three ways that silently broke before:

1. a module re-deriving its own ``+05:30`` offset instead of importing the
   canonical one,
2. a payload rendering UTC (or a naive value) instead of IST,
3. a helper that labels itself "utcnow" but must return IST.
"""
from __future__ import annotations

import ast
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from core.timezones import (
    IST,
    IST_LABEL,
    TZ_NAME,
    business_date,
    business_date_str,
    ensure_aware,
    epoch_ms_to_ist,
    iso_ist,
    now_ist,
    to_ist,
    to_utc,
)

ROOT = Path(__file__).resolve().parents[1]

# Production code only: tests and throwaway probes may stay self-contained.
PROD = [
    p
    for p in ROOT.rglob("*.py")
    if "tests" not in p.relative_to(ROOT).parts
    and ".venv" not in p.parts
    and "__pycache__" not in p.parts
    and not p.name.startswith("_probe")
]


def test_canonical_offset_is_ist():
    assert TZ_NAME == "Asia/Kolkata"
    assert now_ist().utcoffset() == timedelta(hours=5, minutes=30)
    assert "+05:30" in IST_LABEL and "Asia/Kolkata" in IST_LABEL


def test_production_modules_do_not_redefine_the_offset():
    """No production module may build its own +05:30 tzinfo."""
    offenders = []
    pattern = re.compile(r"timezone\s*\(\s*timedelta\s*\(\s*hours\s*=\s*5\s*,\s*minutes\s*=\s*30\s*\)")
    for path in PROD:
        if pattern.search(path.read_text(encoding="utf-8")):
            offenders.append(path.relative_to(ROOT).as_posix())
    assert not offenders, f"modules re-deriving the IST offset: {offenders}"


def test_production_modules_do_not_use_utcnow():
    """``datetime.utcnow()`` is naive and ambiguous; the project uses IST."""
    offenders = []
    for path in PROD:
        for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            code = line.split("#", 1)[0]
            if re.search(r"\.utcnow\(\)", code):
                offenders.append(f"{path.relative_to(ROOT).as_posix()}:{i}")
    assert not offenders, f"naive datetime.utcnow() still present: {offenders}"


def test_json_serializer_emits_ist_offset():
    from services.json_safe import sanitize_for_json

    out = sanitize_for_json({"ts": datetime(2026, 9, 28, 5, 0, tzinfo=timezone.utc)})
    assert out["ts"].endswith("+05:30")
    # 05:00Z is 10:30 IST (+05:30). Proves the instant did not shift.
    assert out["ts"] == "2026-09-28T10:30:00+05:30"


def test_serializer_treats_naive_as_utc_not_ist():
    """A naive pymongo value is UTC; labelling it IST would shift it 5h30m."""
    from services.json_safe import sanitize_for_json

    naive = datetime(2026, 9, 28, 5, 0)
    assert sanitize_for_json(naive) == "2026-09-28T10:30:00+05:30"


def test_serializer_recurses_into_lists_and_nested_dicts():
    from services.json_safe import sanitize_for_json

    payload = {"rows": [{"ts": datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc)}]}
    assert sanitize_for_json(payload)["rows"][0]["ts"].endswith("+05:30")


def test_response_rewrite_converts_the_instant_not_just_the_offset():
    """IstTimestampMiddleware must move the instant, not only the label.

    ``+00:00`` bodies come from routes that serialise UTC ISO strings; a plain
    relabel would show every timestamp 5h30m behind real time while claiming
    to be IST (e.g. an order placed 15:12 IST reading 09:42).
    """
    from services.json_safe import rewrite_utc_offsets_inplace

    raw = b'{"orderDate":"2026-10-02T09:42:58.334038+00:00"}'
    out = rewrite_utc_offsets_inplace(raw)
    assert out == b'{"orderDate":"2026-10-02T15:12:58.334038+05:30"}'
    assert len(out) == len(raw)  # Content-Length stays valid


def test_response_rewrite_is_length_preserving_across_a_date_rollover():
    from services.json_safe import rewrite_utc_offsets_inplace

    raw = b'{"ts":"2026-10-02T18:45:00+00:00"}'
    out = rewrite_utc_offsets_inplace(raw)
    assert out == b'{"ts":"2026-10-03T00:15:00+05:30"}'
    assert len(out) == len(raw)


def test_response_rewrite_leaves_ist_z_and_plain_dates_alone():
    from services.json_safe import rewrite_utc_offsets_inplace

    already_ist = b'{"ts":"2026-10-02T15:12:58+05:30"}'
    assert rewrite_utc_offsets_inplace(already_ist) == already_ist
    # "Z" is not length-preserving to rewrite, so the middleware must not touch
    # it; it has to be prevented at source by sanitize_for_json().
    zulu = b'{"ts":"2026-10-02T09:42:58Z"}'
    assert rewrite_utc_offsets_inplace(zulu) == zulu
    plain_date = b'{"tradingDate":"2026-10-02"}'
    assert rewrite_utc_offsets_inplace(plain_date) == plain_date
    assert rewrite_utc_offsets_inplace(b"") == b""


def test_conversions_round_trip_without_shifting_the_instant():
    now = datetime(2026, 9, 28, 12, 0, tzinfo=timezone.utc)
    assert to_ist(now).hour == 17
    assert to_utc(to_ist(now)) == now  # same instant, different label


def test_naive_input_is_treated_as_utc():
    naive = datetime(2026, 9, 28, 12, 0)
    assert ensure_aware(naive).tzinfo is timezone.utc
    assert to_ist(naive).hour == 17


def test_business_date_uses_ist_not_utc():
    # 20:00Z on the 28th is already the 29th in IST.
    late = datetime(2026, 9, 28, 20, 0, tzinfo=timezone.utc)
    assert business_date(late).isoformat() == "2026-09-29"
    assert business_date_str(late) == "2026-09-29"
    assert business_date_str().count("-") == 2


def test_broker_epoch_stamps_land_on_ist():
    # Kotak sends epoch millis; these must render as IST wall-clock.
    base = datetime(2026, 9, 28, 3, 30, tzinfo=timezone.utc)  # 09:00 IST
    ms = base.timestamp() * 1000
    assert epoch_ms_to_ist(ms).hour == 9
    assert epoch_ms_to_ist(ms).utcoffset() == timedelta(hours=5, minutes=30)


def test_iso_ist_passes_through_none():
    assert iso_ist(None) is None


@pytest.mark.parametrize(
    "module,expected",
    [
        ("services.websocket_history_service", "now_ist"),
        ("api.stocks", "now_ist"),
        ("api.watch_list", "now_ist"),
        ("api.trading_dashboard", "now_ist"),
        ("services.ds_insights", "now_ist"),
        ("services.broker_terminal_engine", "now_ist"),
    ],
)
def test_formerly_utcnow_helpers_now_return_ist(module, expected):
    """The six legacy ``_utcnow`` helpers must now produce IST."""
    import importlib

    mod = importlib.import_module(module)
    assert hasattr(mod, expected), f"{module} lost its {expected}() helper"
    value = getattr(mod, expected)()
    if isinstance(value, str):
        value = datetime.fromisoformat(value)
    assert value.tzinfo is not None, f"{module}.{expected}() returned a naive datetime"
    assert value.utcoffset() == timedelta(hours=5, minutes=30)


def test_timezones_module_is_import_clean():
    """core.timezones must stay dependency-free (no circular imports)."""
    tree = ast.parse((ROOT / "core" / "timezones.py").read_text(encoding="utf-8"))
    imports = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imports.add(node.module.split(".")[0])
    assert imports <= {"__future__", "datetime", "os", "time", "typing", "zoneinfo"}, imports
