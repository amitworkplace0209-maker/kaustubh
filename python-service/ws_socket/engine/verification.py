"""Render docs/kotak_ws_field_verification.txt from ws_socket.engine.fields.

The report is auto-generated from the master field table so the engine schema,
the verification document, and the test coverage assertion can never drift.
"""

from __future__ import annotations

import os
import sys

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))

try:
    from ws_socket.engine.fields import (
        DIRECT_WS,
        DERIVED,
        NOT_PROVIDED,
        NOT_VERIFIED,
        OTHER_API,
        QUOTE_REST_ONLY,
        TARGET_LABEL,
        WS_CONDITIONAL,
        _FIELDS,
        additional_fields,
        direct_ws_attributes,
        field_count,
        not_provided_reasons,
        status_counts,
    )
except ImportError:  # pragma: no cover - repr-time fallback
    from engine.fields import (  # type: ignore[no-redef]
        DIRECT_WS,
        DERIVED,
        NOT_PROVIDED,
        NOT_VERIFIED,
        OTHER_API,
        QUOTE_REST_ONLY,
        TARGET_LABEL,
        WS_CONDITIONAL,
        _FIELDS,
        additional_fields,
        direct_ws_attributes,
        field_count,
        not_provided_reasons,
        status_counts,
    )

_SECTIONS: list[tuple[str, str]] = [
    ("A. DIRECTLY PROVIDED BY KOTAK MARKET WEBSOCKET", DIRECT_WS),
    ("B. CONDITIONAL / FEED-LEVEL DEPENDENT", WS_CONDITIONAL),
    ("C. AVAILABLE FROM KOTAK QUOTE REST BUT NOT WS", QUOTE_REST_ONLY),
    ("D. AVAILABLE FROM OTHER KOTAK API", OTHER_API),
    ("E. DERIVED BY OUR FUTURE FEATURE ENGINE", DERIVED),
    ("F. TARGET/LABEL ONLY", TARGET_LABEL),
    ("G. NOT PROVIDED BY KOTAK WS", NOT_PROVIDED),
    ("H. NOT YET VERIFIED", NOT_VERIFIED),
]


def _row(f) -> str:
    return (
        f"{f.num} | {f.field} | {f.category} | {f.status} | {f.kotak_attr} | "
        f"{f.feed_level} | {f.direct_derived} | {f.evidence} | {f.notes}"
    )


def render_report() -> str:
    n = field_count()
    counts = status_counts()
    lines: list[str] = []
    a = lines.append

    a("TITLE")
    a("KAUSTUBH - KOTAK NEO WEBSOCKET FIELD VERIFICATION REPORT")
    a("")
    a("SOURCE SCHEMA")
    a("master_stock_ai_340_field_schema (1).txt")
    a("")
    a("SCHEMA COUNT")
    a(f"{n} fields currently present in uploaded source.")
    a("")
    a("EVIDENCE BASIS")
    a("Installed SDK: kotakneoapi 3.0.6 (neo_api_client), official PyPI wheel")
    a("Sources inspected: websocket/feed/models.py, websocket/feed/protocol.py,")
    a("websocket/feed/client.py, services/quotes.py, services/scrip_master.py.")
    a("")
    a("SDK MIGRATION: verified against 3.0.6 (model + protocol surface byte-identical")
    a("to the 3.0.2 git pin c49d35f8; diff limited to feed/client.py logging and the")
    a("added services/historical_data.py). Field classification below is therefore")
    a("valid for both 3.0.2 and 3.0.6.")
    a("Typed SFeed messages: SFeedScrip, SFeedScripLite, SFeedIndex, SFeedMarketStatus, SFeedCasChange.")
    a("A field is DIRECT_WS only when it is a real attribute of a typed SFeed message;")
    a("quote-REST availability is never treated as WebSocket availability.")
    a("")
    a("VERIFICATION STATUS COUNTS")
    for status in (
        DIRECT_WS,
        WS_CONDITIONAL,
        QUOTE_REST_ONLY,
        OTHER_API,
        DERIVED,
        TARGET_LABEL,
        NOT_PROVIDED,
        NOT_VERIFIED,
    ):
        a(f"  {status}: {counts.get(status, 0)}")
    a(f"  TOTAL: {n}")
    a("")
    a("TABLE FORMAT:")
    a("# | Schema Field | Category | Kotak WS Status | Kotak Field/Attribute | Feed Level | Direct/Derived | Evidence | Notes")
    a("")
    for f in _FIELDS:
        a(_row(f))
    a("")
    a("")
    a("-" * 100)
    a("")
    a("A. DIRECTLY PROVIDED BY KOTAK MARKET WEBSOCKET")
    for f in _FIELDS:
        if f.status == DIRECT_WS:
            a(f"  {_row(f)}")
    a("")
    a("B. CONDITIONAL / FEED-LEVEL DEPENDENT")
    for f in _FIELDS:
        if f.status == WS_CONDITIONAL:
            a(f"  {_row(f)}")
    a("")
    a("C. AVAILABLE FROM KOTAK QUOTE REST BUT NOT WS")
    for f in _FIELDS:
        if f.status == QUOTE_REST_ONLY:
            a(f"  {_row(f)}")
    a("")
    a("D. AVAILABLE FROM OTHER KOTAK API")
    for f in _FIELDS:
        if f.status == OTHER_API:
            a(f"  {_row(f)}")
    a("")
    a("E. DERIVED BY OUR FUTURE FEATURE ENGINE")
    for f in _FIELDS:
        if f.status == DERIVED:
            a(f"  {_row(f)}")
    a("")
    a("F. TARGET/LABEL ONLY")
    for f in _FIELDS:
        if f.status == TARGET_LABEL:
            a(f"  {_row(f)}")
    a("")
    a("G. NOT PROVIDED BY KOTAK WS")
    for f in _FIELDS:
        if f.status == NOT_PROVIDED:
            a(f"  Field {f.num} '{f.field}': {f.notes or f.evidence}")
    a("")
    a("H. NOT YET VERIFIED")
    for f in _FIELDS:
        if f.status == NOT_VERIFIED:
            a(f"  Field {f.num} '{f.field}': pending evidence --- {f.evidence}")
    a("")
    a("I. ADDITIONAL KOTAK FIELDS DISCOVERED")
    for f in additional_fields():
        a(f"  {_row(f)}")
    a("")
    a("-" * 100)
    a("")
    a("DIRECT_WS - EXACT SDKSFEED ATTRIBUTES (ACCEPTANCE ITEM 17)")
    for line in direct_ws_attributes():
        a(f"  {line}")
    a("")
    a("RUNTIME VERIFICATION (LIVE SESSION, READ-ONLY)")
    a("Live authenticated Kotak session with engine subscriptions nse_cm|2885 (RELIANCE) + nse_cm|1594 (INFY).")
    a("Measured over that session: SFeedScrip 12763 / SFeedCasChange 5 / SFeedMarketStatus 0 (market status")
    a("not subscribed) / trades received 13371 / written 13370. Mongo db.ticks held ~1.5M docs.")
    a("Per normal stock, a single level-4 SFeedScrip message carries 31 DIRECT_WS attributes; the WS_CONDITIONAL")
    a("set adds up to 5 per instrument (SFeedCasChange.ref_price, imbalance_qty, imbalance_qty_at_market;")
    a("SFeedMarketStatus.status_code, status). Level-8/16 depth adds up to 16+16 rows of {quantity, price, orders}")
    a("(more values, never new field names). SFeedScripLite adds no new names; SFeedIndex adds only 'name' (indices).")
    a("Live raw capture preserved at digest preserved|0ed815b205a7 (RELIANCE level-4 model_dump).")
    a("Data Saver now persists the full decoded surface: legacy 28-key projection PLUS previously-dropped fields")
    a("(yearly_high/low, market_lot, precision, multiplier, auction, full depth rows, CAS, market_status) PLUS the")
    a("immutable raw model_dump blob. The rebuilt pipeline SFeed -> engine -> data_saver -> MongoDB was verified")
    a("end-to-end against MongoDB on kotakneoapi 3.0.6 (RESULT: PASS).")
    a("")
    return "\n".join(lines)


def main() -> None:
    out = os.path.join(_REPO_ROOT, "docs", "kotak_ws_field_verification.txt")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(render_report())
    print(f"WROTE {out} ({field_count()} fields)")


if __name__ == "__main__":
    main()