"""Market Watch filter module — pure, validated, no arbitrary expressions.

Two filter layers live here, and they are complementary:

1. **doc §12 movement filters** — the price filter plus the 1m/5m/10m/30m
   ``change_pct`` / ``price_move`` / ``volume`` thresholds, resolved from
   configuration. These decide the *eligible universe* and are applied by the
   canonical engine to real live state.
2. **saved user filters** — a list of criteria over a whitelisted catalog with
   whitelisted operators, applied to rows for the filter builder UI.

Both are AND-combined and both refuse to fabricate: a criterion whose value is
missing fails, and ``None`` thresholds are simply not applied. Filters are never
relaxed automatically to reach a target stock count (doc §12/§13).
"""

from __future__ import annotations

from typing import Any, Optional

from services.market_watch_config import (
    TIMEFRAMES,
    FilterConfig,
    TimeframeFilterConfig,
    load as load_mw_config,
)

# Allowed criteria (field -> validation meta). ``field`` is the real key on the
# engine row (market_watch_engine live record or full-universe merged row).
FILTER_CATALOG: dict[str, dict[str, Any]] = {
    "change_pct": {"label": "Change %", "type": "range", "field": "changePercent"},
    "ltp": {"label": "LTP", "type": "range", "field": "ltp"},
    "volume": {"label": "Volume", "type": "range", "field": "volume"},
    "oi": {"label": "Open Interest", "type": "range", "field": "oi"},
    "spread": {"label": "Spread", "type": "range", "field": "spread"},
    "traded_value": {"label": "Traded Value", "type": "range", "field": "tradedValue"},
    "momentum_5m": {"label": "5 min move", "type": "range", "field": "fiveMinPercent"},
    "momentum_10m": {"label": "10 min move", "type": "range", "field": "tenMinPercent"},
    "segment": {"label": "Segment", "type": "enum", "field": "segment"},
    "exchange": {"label": "Exchange", "type": "enum", "field": "exchange"},
    "symbol": {"label": "Symbol (contains)", "type": "text", "field": "symbol"},
    "freshness": {"label": "Feed freshness", "type": "enum", "field": "status"},
    "liquidity": {"label": "Minimum volume", "type": "minimum", "field": "volume"},
}

# Whitelisted operators grouped by value shape.
_RANGE_OPS = ("between", "gte", "lte", "gt", "lt", "eq")
_ENUM_OPS = ("in", "neq")
_TEXT_OPS = ("contains",)


def catalog() -> list[dict[str, Any]]:
    """Ordered catalog for the frontend filter builder."""
    out = []
    for key, meta in FILTER_CATALOG.items():
        entry = {"key": key, "label": meta["label"], "type": meta["type"]}
        if meta["type"] == "enum":
            entry["options"] = _ENUM_OPTIONS.get(key)
        out.append(entry)
    return out


_ENUM_OPTIONS: dict[str, list[str]] = {
    "segment": ["EQUITY"],
    "exchange": ["NSE", "nse_cm"],
    "freshness": ["LIVE", "STALE", "PENDING", "NO_DATA", "INACTIVE"],
}


def _num(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        f = float(value)
        return f if f == f else None
    except (TypeError, ValueError):
        return None


def validate_criteria(criteria: list[dict] | None) -> tuple[bool, str, list[dict]]:
    """Validate a criteria list. Returns (ok, reason, normalized)."""
    if not criteria:
        return True, "", []
    if not isinstance(criteria, list):
        return False, "criteria must be a list", []
    normalized: list[dict] = []
    for i, crit in enumerate(criteria):
        if not isinstance(crit, dict):
            return False, f"criteria[{i}] must be an object", []
        key = str(crit.get("key") or "").strip()
        meta = FILTER_CATALOG.get(key)
        if meta is None:
            return False, f"criteria[{i}]: unknown filter key '{key}'", []
        op = str(crit.get("op") or "")
        value = crit.get("value")
        ftype = meta["type"]

        if ftype == "range":
            if op not in _RANGE_OPS:
                return False, f"criteria[{i}]: invalid op '{op}' for {key}", []
            if op == "between":
                if not isinstance(value, (list, tuple)) or len(value) != 2:
                    return False, f"criteria[{i}]: between needs [min, max]", []
                lo, hi = _num(value[0]), _num(value[1])
                if lo is None or hi is None or hi < lo:
                    return False, f"criteria[{i}]: invalid between bounds", []
                value = [lo, hi]
            else:
                num = _num(value)
                if num is None:
                    return False, f"criteria[{i}]: {key} needs a numeric value", []
                value = num
        elif ftype == "minimum":
            if op not in ("gte", "eq"):
                return False, f"criteria[{i}]: invalid op '{op}' for {key}", []
            num = _num(value)
            if num is None:
                return False, f"criteria[{i}]: {key} needs a numeric value", []
            value = num
        elif ftype == "enum":
            if op not in _ENUM_OPS:
                return False, f"criteria[{i}]: invalid op '{op}' for {key}", []
            if isinstance(value, str):
                value = [value]
            if not isinstance(value, list) or not value:
                return False, f"criteria[{i}]: {key} needs a value list", []
            ok = all(isinstance(v, str) and v for v in value)
            if not ok:
                return False, f"criteria[{i}]: {key} values must be non-empty strings", []
            value = [str(v) for v in value]
        elif ftype == "text":
            if op not in _TEXT_OPS:
                return False, f"criteria[{i}]: invalid op '{op}' for {key}", []
            if not isinstance(value, str) or not value.strip():
                return False, f"criteria[{i}]: {key} needs a non-empty query", []
            value = value.strip()

        normalized.append({"key": key, "op": op, "value": value})
    return True, "", normalized


def _match(row: dict, crit: dict) -> bool:
    meta = FILTER_CATALOG.get(crit["key"])
    field = meta["field"]
    raw = row.get(field)
    op = crit["op"]
    value = crit["value"]

    if meta["type"] in ("range", "minimum"):
        actual = _num(raw)
        if actual is None:
            return False
        if op == "eq":
            return actual == value
        if op == "between":
            lo, hi = value
            return lo <= actual <= hi
        if op == "gte":
            return actual >= value
        if op == "lte":
            return actual <= value
        if op == "gt":
            return actual > value
        if op == "lt":
            return actual < value
        return False

    if meta["type"] == "enum":
        actual = str(raw or "").strip()
        if op == "in":
            return actual in value
        return actual not in value

    if meta["type"] == "text":
        return str(raw or "").upper().find(str(value).upper()) != -1

    return False


def apply_filters(rows: list[dict], criteria: list[dict] | None) -> list[dict]:
    """Return rows passing every validated criterion (AND semantics)."""
    if not criteria:
        return rows
    ok, reason, normalized = validate_criteria(criteria)
    if not ok:
        return []
    return [r for r in rows if all(_match(r, c) for c in normalized)]


def validate_filter_document(raw: dict | None) -> tuple[bool, str, dict | None]:
    """Validate a persisted filter document (name + criteria + optional limit)."""
    if not isinstance(raw, dict):
        return False, "filter must be an object", None
    name = str(raw.get("name") or "").strip()
    if not name:
        return False, "filter name is required", None
    ok, reason, normalized = validate_criteria(raw.get("criteria"))
    if not ok:
        return False, reason, None
    limit = raw.get("limit")
    if limit is not None:
        try:
            limit = int(limit)
        except (TypeError, ValueError):
            limit = None
        if limit is None:
            limit = 100
        limit = max(1, min(limit, 1000))
    else:
        limit = 100
    return True, "", {"name": name[:80], "criteria": normalized, "limit": limit, "description": str(raw.get("description") or "")[:240]}


# --------------------------------------------------------------------------- #
# doc §12 movement filters (price + 1m/5m/10m/30m)
# --------------------------------------------------------------------------- #
def _bounds(
    value: Optional[float], lo: Optional[float], hi: Optional[float]
) -> tuple[bool, str]:
    """Check ``lo <= value <= hi`` honouring unset (``None``) bounds."""
    if value is None:
        return False, "no value"
    if lo is not None and value < lo:
        return False, f"{value:.4f} < {lo:.4f}"
    if hi is not None and value > hi:
        return False, f"{value:.4f} > {hi:.4f}"
    return True, ""


def evaluate_movement(state, cfg: Optional[FilterConfig] = None) -> tuple[bool, list[str]]:
    """Apply the configured doc §12 filters to one live :class:`SymbolState`.

    Returns ``(passed, failures)`` where ``failures`` names every criterion that
    did not pass, with the observed value. Missing data is a failure with a
    reason — never a pass with a zero.
    """
    cfg = cfg or load_mw_config().filters
    failures: list[str] = []
    if not cfg.enabled:
        return True, failures

    ltp = getattr(state, "ltp", None)
    if ltp is None:
        return False, ["ltp: no value"]
    ok, why = _bounds(ltp, cfg.price.min_price or None, cfg.price.max_price or None)
    if not ok:
        failures.append(f"price: {why}")

    for tf in TIMEFRAMES:
        tcfg: Optional[TimeframeFilterConfig] = cfg.timeframes.get(tf)
        if tcfg is None or not tcfg.configured:
            continue
        tfs = state.timeframe(tf)
        for label, value, lo, hi in (
            (f"{tf}.change_pct", tfs.change_pct, tcfg.change_pct_min, tcfg.change_pct_max),
            (f"{tf}.price_move", tfs.price_move, tcfg.price_move_min, tcfg.price_move_max),
            (f"{tf}.volume", tfs.volume, tcfg.volume_min, None),
        ):
            if lo is None and hi is None:
                continue
            ok, why = _bounds(value, lo, hi)
            if not ok:
                failures.append(f"{label}: {why}")
    return (not failures), failures


def apply_movement_filters(states, cfg: Optional[FilterConfig] = None) -> tuple[list, dict[str, list[str]]]:
    """Filter a mapping/iterable of live states; also return per-symbol failures.

    A symbol only passes when EVERY configured filter passes (doc §12 combined
    example is an AND).
    """
    cfg = cfg or load_mw_config().filters
    passed: list = []
    failures: dict[str, list[str]] = {}
    items = states.items() if hasattr(states, "items") else enumerate(states)
    for key, state in items:
        ok, why = evaluate_movement(state, cfg)
        if ok:
            passed.append(state)
        else:
            failures[str(key)] = why
    return passed, failures


def movement_filter_summary(cfg: Optional[FilterConfig] = None) -> dict[str, Any]:
    """The active doc §12 thresholds (exposed on status/config surfaces)."""
    cfg = cfg or load_mw_config().filters
    return cfg.to_dict()