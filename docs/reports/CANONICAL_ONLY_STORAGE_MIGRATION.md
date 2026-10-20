# Canonical-Only Mongo Storage Migration

**Status:** IMPLEMENTED (writer + readers migrated), dual-schema gated by the
runtime setting `ds_storage_schema`. Mongo still writes the legacy shape until
the operator flips the setting (see "Operator flip" below). Targeted regression:
143 tests green.

Related: `docs/reports/L8_MASTER_CANONICAL_ADAPTER_FORENSIC_AUDIT.txt` (52-field
canonical contract, 25 alias groups, 65 alias surfaces).

---

## 1. Objective

Tick documents in `db.ticks` must stop duplicating market data. Today the
legacy storage doc writes the flat surface (`ltp`, `open`, `high`, `low`,
`close`, `volume`, `ltq`, `tbq`, `tsq`, `bp`, `bq`, `sp`, `sq`, `bs`,
`averagePrice`, `change`, `changePercent`, `oi`, circuits, `buy`/`sell` depth
arrays ...) **and** the same semantics are nested in `master_canonical`.
Canonical-only storage persists market data EXACTLY ONCE under
`master_canonical.<section>.<field>`, keeps identity/time/feed metadata at the
document root (produces the Mongo indexes used today: `ts`, `symbol+ts`,
`instrumentToken+ts`), and keeps the raw broker blob as an isolated audit
envelope that is never duplicated as market-data fields.

Scope decision (approved): only MongoDB `ticks` storage changes. The in-process
flat WebSocket/API stream (Feature Engine, Connection Engine, watchlist,
frontend: `ltp`, `bid`, `ask`, ...) is a SEPARATE contract and is unchanged.

## 2. Document shapes

Legacy (default, `ds_storage_schema=legacy`):

```
{
  symbol, tradingSymbol, instrumentToken, exchangeSegment,        # identity
  ltp, open, high, low, close, volume, ltq, tbq, tsq,             # flat market
  bp, bq, sp, sq, bs, averagePrice,                                # data surface
  change, changePercent, oi, upper/lower_circuit_limit,
  last_update_time, last_trade_time, yearly_high/low, market_lot,
  precision, multiplier, auction, buy[], sell[], level, message_type,
  ref_price, imbalance_qty*, status*, index_name*,
  event_id, event_type, schema_version, sdk_version, source,
  feed_type, feed_level,                                           # metadata
  raw_reference, raw,                                              # audit
  master_canonical,                                                # canonical copy
  ts, receivedAt                                                    # time
}
```

Canonical-only (`ds_storage_schema=canonical_only`):

```
{
  symbol, tradingSymbol, instrumentToken, exchangeSegment,
  feed_type, feed_level, event_id, event_type, schema_version,
  sdk_version, source,                    # identity/feed metadata (index needs)
  raw_reference, raw,                     # raw audit envelope (isolated)
  master_canonical {                      # THE market data, 52-field contract
    identity, market_state, price, trade, volume, change,
    open_interest, time, depth{buy[], sell[], levels},
    derived, feed_metadata, raw{reference}, reference
  },
  ts, receivedAt                          # time
}
```

No legacy flat market-data keys, no duplicate depth surface in canonical-only
docs. One semantic value = one path in Mongo.

## 3. Consumer map (audited before changes)

Mongo `ticks` readers (migrated to the dual-read resolver):

| Module | Read pattern | Migration |
|---|---|---|
| `api/downloads.py` `_map_tick` | flat keys per tick | resolver `get_field`/`get_depth` |
| `api/quality.py` `/symbol/{sym}` | `db.ticks` latest | resolver quote slice |
| `api/quality.py` `/duplicates` | `$group` on `ltp/volume/bp/sp` | `$cond` canonical-aware pipeline |
| `api/quality.py` `_circuit_distance` | flat ltp/circuits | `get_field` |
| `api/system.py` quality counters | `count_documents` on `ltp` | canonical-aware `$or` |
| `services/data_quality.py` | dup pipeline + ltp/volume/schema checks | canonical-aware aggregation |
| `services/exporter.py` `_map_tick` | flat keys per tick | resolver `get_field`/`get_depth` |
| `services/tick_analytics.py` `_recent_symbol_ticks` | raw docs merged from buffer + Mongo | normalize via `get_quote_slice` at boundary |
| `services/data_center.py` | symbol/ts aggregates only | no change (same top-level fields) |
| `api/stocks.py`, `api/ticks.py`, `api/system.py` (health) | symbol/ts/identity only | no change |

Output contracts of these modules are unchanged — they still return the flat
field names the frontend consumes; the resolver sources them canonical-first.

In-process flat WS/API stream (deliberately NOT routed through the resolver):
`core/engines/feature_engine.py`, `connection_engine/connection_engine.py`
`_feature_output_for`, `api/market_watch_engine.py`, `services/watchlist_engine.py`,
`api/market_watch.py`, `connection_engine/field_requirements.py`.

## 4. Dual-read resolver

`services/tick_field_resolver.py` is the one place that understands both
shapes. Public API: `has_canonical(doc)`, `canonical_section(doc, s)`,
`get_field(doc, legacy_key)` (canonical-first override), `get_depth(doc, side)`
(canonical `depth.buy/sell` authoritative, legacy top-level `buy/sell`
fallback), `get_quote_slice(doc)` (compact flat quote view + depth + identity
passthrough), `legacy_slice(doc)`. Never fabricates values — missing paths →
`None`.

Resolver coverage of the legacy surface (canonical section.field):
ltp/open/high/low/close/prevClose/averagePrice/upper+lower_circuit_limit/
yearly_high/yearly_low → `price.*`; volume/tbq/tsq/total_buy_quantity/
total_sell_quantity → `volume.*`; ltq/last_trade_time → `trade.*`;
last_update_time → `time.feed_event_time`; change/changePercent/net_change →
`change.*`; oi → `open_interest.*`; total_traded_value → `price.*`;
market_lot → `identity.lot_size`; precision/multiplier → `feed_metadata.*`;
auction → `price.auction_active`. Depth aliases (bp/bq/sp/sq/bs) are resolved
from depth arrays only — never stored as separate fields.

## 5. Writer

`ws_socket/engine/storage.py::to_storage_doc(payload, storage_schema=None)`.
`storage_schema` defaults to the live `ds_storage_schema` runtime setting.
`canonical_only` → identity/time/feed metadata + raw audit envelope +
`master_canonical` (from the payload's canonical object; present because
`master_canonical_enabled=True` is live). Legacy → previous superset doc PLUS
`master_canonical` (so old docs also carry a canonical path during the
dual-read window; no consumers need rewriting, the resolver covers both).

## 6. Runtime setting

`ds_storage_schema` — registered in `services/runtime_settings.py` (`LIVE_KEYS`)
and `services/settings_service.py` (`category: data_saver`, `type: select`,
`options: legacy | canonical_only`). Default `legacy`.

### Operator flip
1. Open Settings → Data Saver → `ds_storage_schema`.
2. Set `canonical_only` → save (applies live).
3. Restart the backend so the setting change is durable.
4. Verify: one persisted tick doc resolves `get_field(doc, "ltp")` and no
   `doc["ltp"]` key exists.

Rollback: set `legacy` → restart. Old docs remain readable through either
setting (dual-read resolver).

## 7. Acceptance criteria

- Semantic value appears once in canonical-only docs (no legacy+canonical dup).
- No duplicated depth (only `master_canonical.depth.buy[]/sell[]`).
- Mongo indexes `ts`, `symbol+ts`, `instrumentToken+ts` still satisfied by
  root-level identity/time fields.
- All migrated consumers resolve values from canonical documents.
- WS/API in-process stream output unchanged.
- Raw broker payload isolated in the `raw` envelope.
- 52-field canonical contract intact; nullable fields resolve `None` (never
  fabricated).

## 8. Tests

`tests/test_ws_engine.py::test_canonical_only_storage_doc_nests_market_data`
added (canonical-only doc shape, nested depth, isolated raw envelope).
Targeted suite: `test_ws_engine`, `test_ws_engine_quality`, `test_connection_engine`,
`test_connection_field_requirements`, `test_feature_engine_calculators`,
`test_master_canonical`, `test_tick_analytics` → 143 passed.