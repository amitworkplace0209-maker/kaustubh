# DATA_QUALITY.md — Data Quality Engine Specification

Version: 1.0
Status: ACTIVE
Scope: Data Quality observer/analytics consumer (`python-service/services/data_quality.py` + `python-service/api/quality.py` + `/data-saver/quality` page)
Date: 2026-10-01

## Change History

| Version | Date | Change | Agent |
|---|---|---|---|
| 1.0 | 2026-10-01 | Initial specification extracted from implemented code (020 audit) | OpenCode |

---

## 1. PURPOSE

Data Quality answers one question: **can the stored and streaming market data be trusted?**

It measures eight dimensions over the real `ticks` collection and the live
tick pipeline, scores them deterministically, persists snapshots/issues for
trend and audit, and surfaces everything through a read-only observability API
and the `/data-saver/quality` page.

## 2. RESPONSIBILITIES

- Compute completeness, uniqueness, validity, ordering, timestamp integrity,
  price integrity, volume integrity, persistence reliability from REAL state.
- Own the deterministic Quality Score (weighted sum, persisted weights).
- Own the quality issue lifecycle (OPEN → ACKNOWLEDGED → RESOLVED/SUPPRESSED,
  deduplicated by key, raw history never deleted on resolve).
- Detect duplicates with the deterministic observation identity
  `(instrumentToken, ts, ltp, volume, bp, sp)` — same-price ticks with a
  distinct broker timestamp are NOT duplicates.
- Track freshness (LIVE <5s / DEGRADED ≤staleSeconds / STALE / NO_DATA).
- Publish `quality_*` realtime events to the SSE event bus.
- Persist snapshots (`quality_snapshot`), issues (`quality_issues`), scan runs
  (`quality_scans`), config (`quality_config`).
- Report anything unmeasurable as NOT MEASURED / NO DATA / UNAVAILABLE — never
  as a fabricated pass mark or zero.

## 3. NON-RESPONSIBILITIES

Data Quality is an OBSERVER/ANALYTICS consumer. It must NOT become:

- broker authentication owner (Session Manager / scheduler own login)
- broker WebSocket owner (WebSocket Engine / `ws_manager` own the feed)
- MongoDB persistence owner (DB Writer Engine owns tick writes)
- order / risk / margin / square-off owner
- notification delivery owner (Notification Engine delivers; Data Quality only
  raises threshold events via `services.notification_service.notify`)

It must NOT open a second broker feed, a second WebSocket, or a second MongoDB
writer. It must NOT write ticks. Duplicate cleanup (`POST /duplicates/delete`)
delegates the actual delete to `db_writer_engine.delete_duplicate_ticks()`.

## 4. INPUT SOURCES

| Source | Data | How consumed |
|---|---|---|
| `ticks` collection | completeness, uniqueness, validity, ordering, timestamp/price/volume integrity | bounded aggregations (`ts` / `(symbol,ts)` / `(instrumentToken,ts)` indexes) |
| `tick_buffer.stats()` | received / written / write-errors / buffer depth / flush latency / ticks-per-second | republished, never recomputed |
| `ws_manager.status()` | feed freshness (`last_tick_at`), connection, subscriptions, reconnects | republished |
| `daily_summaries` | attempted saves / error counts for persistence rate | read-only |
| `db_writer_engine` | persistence telemetry, duplicate-delete authority | `status_snapshot()`, `delete_duplicate_ticks()` |
| `database.connection.get_mongo_info()` | provider (`atlas`/`local`), database name, host, server version, pool | read-only, no URI ever emitted |
| `pipeline_latency.stats()` | hop-to-hop A–G latency buckets | republished |
| `instrument_cache` | symbol → company/token enrichment | read-only |
| `services.notification_service.notify` | coordinated alert fan-out (unread count, dropdown, topbar from ONE Mongo source) | called once per signal batch |
| `services.event_bus.publish_event` | `quality_scan_started/completed`, `quality_issue_created/updated/resolved`, `quality_duplicates_cleaned` | fire-and-forget |

## 5. ENGINE DEPENDENCIES

```
BROKER FEED → WEBSOCKET ENGINE (ws_manager) → tick_buffer → DB WRITER → MongoDB
                        ↓                          ↓
                  DATA QUALITY (observer) ← SESSION MANAGER (session context)
                        ↓                          ↓
              Quality Snapshot/API ← SCHEDULER (market phase, scan cadence)
                        ↓
        Notification Engine (alert delivery) · Audit Engine (event ledger)
```

Data Quality consumes telemetry; it never drives the pipeline.

## 6. QUALITY DIMENSIONS

| Dimension | Measures | Identity / rule |
|---|---|---|
| Completeness | received observations present in window | presence-based; rows = received (expected-tick model is NOT implemented — see §13) |
| Uniqueness | redundant persisted rows | `(instrumentToken, ts, ltp, volume, bp, sp)` incl. `master_canonical` fallback; excess = Σ(n−1) over groups with n>1 |
| Validity | schema conformance | symbol / instrumentToken / ltp present and non-empty |
| Ordering | ts regressions per symbol | incoming ts ≥ previous ts for same symbol (bounded scan) |
| Timestamp Integrity | ts present, valid, UTC-consistent | ts missing / null / string counts as error |
| Price Integrity | LTP numeric and non-negative | missing / null / string LTP counts as error |
| Volume Integrity | volume present, numeric and non-negative | document-level check (missing / null / string / negative); LTQ vs cumulative semantics are NOT distinguished — reported honestly in the metric definition |
| Persistence Reliability | successful bulk-writes / attempted writes | buffer counters + daily summary errors |

## 7. METRICS

- Rates are `errors / total` percentages; `None` when unmeasurable.
- Dimension score = `100 − rate`, clamped 0–100.
- **Quality Score** = Σ(weightᵢ × dimensionᵢ) / Σ(weights of measured dimensions),
  rounded to 1 decimal. Weights default to Completeness 0.20, Validity 0.20,
  Uniqueness 0.15, Ordering 0.10, Timestamp 0.10, Price 0.10, Volume 0.05,
  Persistence 0.10 (sum 1.0), persisted in `quality_config`, editable via
  `POST /api/data-quality/config`.
- Grade: ≥95 Excellent, ≥80 Good, ≥60 Needs Attention, else Critical,
  `None` → "Not measured".
- Freshness: LIVE (<5s) / DEGRADED (≤staleSeconds, default 30s) / STALE /
  NO_DATA. Page maps LIVE→Fresh, DEGRADED→Delayed for legacy labels.

## 8. ISSUES

Canonical fields: `key, severity, title, message, dimension, symbol, token,
exchange, segment, observed, expected, source, metadata, count,
occurrence_count, status, statusUpdatedAt, ts, created_at, first_seen,
last_seen`. Statuses: `open / acked / new` (active), `resolved / ignored /
suppressed` (terminal). Dedup by `key` — repeat signals increment the open
row. Resolved rows are KEPT (audit trail), never deleted.

## 9. REALTIME

Events on the shared SSE bus (`/api/schedule-events/stream`):
`quality_scan_started`, `quality_scan_completed`, `quality_issue_created`,
`quality_issue_updated`, `quality_issue_resolved`, `quality_duplicates_cleaned`,
`data_freshness_changed`. The page subscribes via `hooks/use-quality-events.ts`
(single SSE fan-out, no second socket) and refreshes only affected sections.

## 10. PERSISTENCE

- `quality_config` — weights, thresholds, refresh interval, snapshot retention.
- `quality_snapshot` — one row per scan (score, dimensions, freshness, totals,
  trigger); retention enforced by `snapshotRetentionDays` (default 30).
- `quality_issues` — persistent deduplicated issues.
- `quality_scans` — scan run ledger (trigger, status, duration, records, score).
- All writes go through the service; the API router is a thin facade. No
  frontend-to-Mongo path exists.

## 11. DATABASE

Health comes from `api.system.mongo_stats()` (reused, not re-implemented)
plus a live `ticks.find_one` read probe. Reported: dbName, provider
(`atlas`/`local`/`unknown` from `get_mongo_info()`, never the URI),
connection, ping, objects, data/storage/index sizes, index/collection counts,
ticks collection detail, today's summary, buffer counters. Unavailable renders
as DISCONNECTED/UNAVAILABLE, never as zeros.

## 12. RETENTION

- Quality snapshots: `snapshotRetentionDays` (persisted, editable, default 30).
- Tick retention: application-managed, NO MongoDB TTL by design ("1-day" is a
  session classification, not a TTL).
- Issue retention: NOT CONFIGURED (issues are append-only audit; no TTL).
- Archive: NOT CONFIGURED (no archive pipeline exists).
- The page must show these honestly — see §15.

## 13. KNOWN LIMITATIONS (must not be papered over)

1. **Completeness is presence-based.** There is no expected-tick model
   (no universe × cadence schedule), so completeness is 100 whenever rows
   exist and NOT MEASURED when the window is empty.
2. **Volume integrity is document-level only.** Missing/null/non-numeric/
   negative volume is detected; LTQ vs cumulative-traded semantics are not
   distinguished (no dedicated semantic validator exists in the pipeline).
3. **Ordering scan is bounded.** Windows >12h skip the full ordering walk
   (and other heavy aggregations) and report the lightweight path; per-symbol
   duplicate sub-queries are capped.
4. **Filtered metrics are totals-accurate, rates-approximate.** Exchange /
   segment / intraday filters scope totals and symbol lists precisely; the
   heavyweight error-rate aggregations run on the (hours, symbol) scope and
   are labelled as such when filters are active.
5. **No background scans.** Scans run on page visit (`POST /scan/if-due`) or
   manually. No scan ever runs while the page is closed (STANDBY lifecycle).

## 14. API

All under `/api/data-quality` (20 routes — see `docs/api/API_CATALOG.md`):
`config` (GET/POST), `summary`, `metrics`, `issues` (+`/{id}/{action}`),
`scan-state`, `scan` (POST), `scan/if-due` (POST), `scan/history`,
`duplicates` (GET) + `duplicates/delete` (POST), `dimensions`, `symbols`,
`symbol/{sym}`, `trend`, `snapshot` (POST), `pipeline`, `storage`,
`diagnostics`. Next.js same-origin proxy: `app/api/data-quality/[...path]`.

## 15. PERFORMANCE

- Metric computation cached 60s keyed by the FULL filter set
  (hours:symbol:exchange:segment:date:time_from:time_to).
- Page loads in phases: ① summary + scan-state (first paint), ② pipeline +
  storage + diagnostics, ③ metrics + symbols + issues, ④ trend + duplicates
  (lazy / on-demand). No full DB scan on every poll.
- Duplicate scan defaults to 24h and is manual-refresh; never an automatic
  720h sweep on mount.
- Bounded windows/TTL/aggregates everywhere; no unlimited in-RAM tick history.

## 16. SECURITY

Safe observability data only. Never emitted: Mongo URI/credentials, broker
credentials, API keys, JWT/session tokens, internal secrets. `serverStatus`
-style documents are allow-listed, never copied wholesale.

## 17. VERIFICATION

See `docs/verification/020-data-quality-redesign-verification.md` (runtime
evidence, environment, broker/DB state, expected vs actual, limitations).
Live broker + live MongoDB verification is recorded separately and never
claimed without evidence.

Related: `docs/implementation/020-data-quality-redesign.md`,
`docs/audits/backend/DATA_QUALITY_AUDIT.md`,
`docs/audits/frontend/DATA_QUALITY_AUDIT.md`.
