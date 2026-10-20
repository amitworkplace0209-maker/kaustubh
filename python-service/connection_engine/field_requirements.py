"""Field-requirement resolution + delivery filtering (connection-manager.md §10/§24).

The Connection Manager is the authoritative layer for consumer-specific field
requirements. It does NOT calculate features (the Feature Engine does) and it
never fabricates a value: for every requested field it reports whether that
field is actually available from an upstream source and, at delivery time,
projects only the resolved fields onto the outgoing payload.

Availability vocabulary (spec §10):

    AVAILABLE    resolved from the WebSocket canonical stream or Feature Engine
    UNAVAILABLE  no upstream source produces this field
    PARTIAL      some requested fields resolve, others do not
    NOT_READY    produced upstream but not yet computed (feature warm-up)
    SOURCE_ERROR the upstream source is not running / errored

This module is intentionally pure (no engine imports) so it is unit-testable
and so the routing engine stays decoupled from concrete sources.
"""
from __future__ import annotations

from core.engines.feature_engine import CALCULATIONS
from ws_socket.engine.canonical import FULL_WS_FIELDS

AVAILABLE = "AVAILABLE"
UNAVAILABLE = "UNAVAILABLE"
PARTIAL = "PARTIAL"
NOT_READY = "NOT_READY"
SOURCE_ERROR = "SOURCE_ERROR"

SOURCE_WS = "MARKET_DATA_WEBSOCKET"
SOURCE_FEATURE = "FEATURE_ENGINE"

# Consumer-friendly names -> canonical WebSocket field name. Only mappings that
# are semantically identical are included; nothing is invented.
WS_FIELD_ALIASES: dict[str, str] = {
    "close": "prev_close",
    "prevClose": "prev_close",
    "lastPrice": "ltp",
    "bid": "buy",
    "ask": "sell",
}

WS_FIELDS: set[str] = set(FULL_WS_FIELDS) | {"buy", "sell"}
FEATURE_FIELDS: set[str] = set(CALCULATIONS)


def canonical_name(field: str) -> str:
    """Map a consumer-facing field name onto its canonical upstream name."""
    name = str(field or "").strip()
    return WS_FIELD_ALIASES.get(name, name)


def available_fields() -> dict:
    """Catalogue of fields the upstream sources can actually provide."""
    return {
        "sources": [SOURCE_WS, SOURCE_FEATURE],
        "ws": sorted(WS_FIELDS),
        "features": sorted(FEATURE_FIELDS),
        "aliases": dict(WS_FIELD_ALIASES),
    }


def _resolve_feature(name: str, feature_output: dict | None, feature_source_ok: bool) -> str:
    if not feature_source_ok:
        return SOURCE_ERROR
    if not feature_output:
        return NOT_READY
    status = (feature_output.get("calculationStatus") or {}).get(name)
    if status == "AVAILABLE":
        return AVAILABLE
    if status in ("WARMING_UP", "MISSING_INPUT"):
        return NOT_READY
    return UNAVAILABLE


def resolve_requirements(
    requested,
    *,
    feature_output: dict | None = None,
    feature_source_ok: bool = True,
) -> dict:
    """Resolve each requested field against the real upstream sources."""
    names: list[str] = []
    for field in requested or []:
        name = str(field or "").strip()
        if name and name not in names:
            names.append(name)

    requirements: list[dict] = []
    resolved: list[str] = []
    unavailable: list[str] = []
    not_ready: list[str] = []

    for name in names:
        canon = canonical_name(name)
        if canon in WS_FIELDS:
            status, source, resolved_name = AVAILABLE, SOURCE_WS, name
        elif canon in FEATURE_FIELDS:
            status = _resolve_feature(canon, feature_output, feature_source_ok)
            source, resolved_name = SOURCE_FEATURE, name
        else:
            status, source, resolved_name = UNAVAILABLE, "", ""
        requirements.append({"field": name, "status": status, "source": source})
        if status == AVAILABLE:
            resolved.append(resolved_name)
        elif status == UNAVAILABLE:
            unavailable.append(name)
        else:
            not_ready.append(name)

    if not names:
        overall = AVAILABLE
    elif any(item["status"] == SOURCE_ERROR for item in requirements):
        overall = SOURCE_ERROR
    elif resolved and (unavailable or not_ready):
        overall = PARTIAL
    elif unavailable and not (resolved or not_ready):
        overall = UNAVAILABLE
    elif not_ready and not (resolved or unavailable):
        overall = NOT_READY
    elif resolved and not (unavailable or not_ready):
        overall = AVAILABLE
    else:
        overall = PARTIAL

    return {
        "status": overall,
        "requestedFields": names,
        "resolvedFields": resolved,
        "unavailableFields": unavailable,
        "notReadyFields": not_ready,
        "fieldRequirements": requirements,
    }


def project_fields(
    fields: dict | None,
    requested,
    *,
    feature_output: dict | None = None,
    feature_source_ok: bool = True,
) -> tuple[dict, dict]:
    """Project only the resolved requested fields onto an outgoing payload.

    Returns ``(projected_fields, requirements)``. Missing values are omitted
    (never fabricated); feature values are read from the Feature Engine output
    (``features`` / ``marketData`` namespaces) for the same instrument.
    """
    requirements = resolve_requirements(
        requested, feature_output=feature_output, feature_source_ok=feature_source_ok
    )
    projected: dict = {}
    raw = fields or {}

    for name in requirements["resolvedFields"]:
        canon = canonical_name(name)
        if canon in raw:
            projected[name] = raw[canon]
        elif name in raw:
            projected[name] = raw[name]

    if feature_output:
        feats = feature_output.get("features") or {}
        market = feature_output.get("marketData") or {}
        for name in requirements["resolvedFields"]:
            if name in projected:
                continue
            canon = canonical_name(name)
            if canon in feats:
                projected[name] = feats[canon]
            elif canon in market:
                projected[name] = market[canon]

    return projected, requirements
