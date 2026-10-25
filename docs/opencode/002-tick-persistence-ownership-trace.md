# 002 — Tick Persistence Ownership Trace (DB Writer vs Market Watch)

- **Purpose:** Pre-implementation trace of every tick persistence path, as required by
  `PROJECT_IMPLEMENTATION_RULE.md` §24 (architecture-first) and §25 (trace before change)
  before modifying the tick persistence architecture.
- **Source:** Static read of `python-service/` and `docs/` on 2026-09-28.
- **Task/context:** Task = make DB Write Engine the single authority for tick persistence
  with three independent ON/OFF permissions.
- **Status:** Reference. Findings below were confirmed by reading code, not by running it.

---

## Related Documentation

- Engine specification: `docs/engines/db_writer_engine_detailed.md`
- Engine specification: `docs/engines/MARKET_WATCH.md`
- Audit: `docs/audits/backend/MARKET_WATCH_IMPLEMENTATION_AUDIT.md`
- Pending: `docs/pending/PENDING-002-build-and-test-verification.md`
- Implementation (this task): `docs/implementation/016-db-writer-single-tick-persistence-authority.md`

---

## 1. HEADLINE FINDING — two parallel tick pipelines exist

The tick persistence path is **not** single. There are two independent pipelines that
both end in MongoDB, and only one of them consults the DB Writer's permissions.

### Pipeline A — "personal / data saver" ticks (permission-aware)

```
Connection Manager
  -> _drain_persistence()            connection_engine/connection_engine.py:828
  -> to_storage_doc(payload)         ws_socket/engine/storage.py
  -> db_writer_engine.ingest(doc)    services/db_writer_engine.py:362
       -> _should_persist_tick()     services/db_writer_engine.py:271   <-- AUTHORITY
            -> _get_tick_source()    services/db_writer_engine.py:212   (Session Manager)
            -> _persistence_enabled_for_source()  :261  (rt_bool dbw_* settings)
       -> dedup (token, sequenceNumber)          :336
       -> tick_buffer.add(tick)      services/tick_buffer.py
       -> bulk_write                 services/tick_buffer.py:669
  -> db.ticks
```

### Pipeline B — "Market Watch" ticks (NOT permission-aware)

```
Market Watch Engine
  -> _persist_tick()                 services/market_watch_engine.py:835
       gate: cfg.storage.persist_ticks  (mwr_persist_ticks, DEFAULT TRUE)
  -> db_writer_engine.buffer_documents("market_ticks", [doc])   :860
       -> market_watch_doc_buffer.add()  services/market_watch_doc_buffer.py:174
       -> bulk_write                 services/market_watch_doc_buffer.py:282
  -> db.market_ticks
```

**`buffer_documents()` never calls `_should_persist_tick()`.** It only checks
`market_watch_doc_buffer._enabled["market_ticks"]`, which is driven by Market Watch's
own `mwr_persist_ticks` setting.

### Consequence

| Claim | Reality before this task |
|---|---|
| `dbw_market_watch_ticks` (DB Writer permission, default OFF) controls Market Watch tick persistence | **FALSE** — it is never consulted on Pipeline B |
| Market Watch ticks are not persisted by default | **FALSE** — `mwr_persist_ticks` defaults to `True` (`settings_service.py:278`) |
| Turning OFF the DB Writer's Market Watch permission stops Market Watch tick writes | **FALSE** — the write continues via `mwr_persist_ticks` |
| DB Writer is the only tick persistence authority | **FALSE** — Market Watch effectively co-owns it |

This is a direct violation of `PROJECT_IMPLEMENTATION_RULE.md` §5 (do not move
responsibility between engines) and of the target invariant.

---

## 2. Complete inventory of tick persistence decision points

| # | Location | Decides persistence? | Notes |
|---|---|---|---|
| 1 | `services/db_writer_engine.py:271` `_should_persist_tick` | **YES** — authoritative | Uses Session Manager + `dbw_*` runtime settings |
| 2 | `services/market_watch_engine.py:827` `cfg.storage.persist_ticks` | **YES** — parallel authority | Defaults `True`; bypasses DB Writer |
| 3 | `services/market_watch_doc_buffer.py:195` `_enabled` gate | Gate only | Mirrors #2 |
| 4 | `services/market_watch_doc_buffer.py:164` `apply_storage_config` | Gate only | Mirrors #2 into #3 |
| 5 | `services/tick_buffer.py:548` `ds_collection_enabled` | Global kill-switch | Orthogonal, legitimate |
| 6 | `services/db_writer_engine.py:336` `_is_duplicate` | No (identity) | (token, sequenceNumber) + TTL 300s |
| 7 | `services/market_watch_doc_buffer.py` `_id` deterministic | No (identity) | `symbol:seq` — append-only, E11000 tolerated |

---

## 3. Classification source (already authoritative — do not duplicate)

`services/db_writer_engine.py:212 _get_tick_source()` reads
`services.session.session_manager.session_manager.snapshot()["instruments"][token]`
and inspects `sources` and `expiry_type` / `expires_at`. This satisfies the task's
"do not infer source from symbol name" and "do not duplicate subscription logic" rules.

Classification is **token-keyed**, not symbol-keyed. Good.

---

## 4. Tick identity / dedup (existing, to be preserved)

- Pipeline A: `(instrumentToken, sequenceNumber)`, TTL 300s, maxlen 50000 deque.
  Falls back to **no dedup** when `sequenceNumber` is absent (documented, tested).
- Pipeline B: deterministic `_id = f"{symbol}:{int(seq or now*1000)}"`, append-only
  `InsertOne`, `E11000` counted as a benign duplicate skip, never an error.

Task §19 requires the strongest existing identity. Pipeline A already uses the broker
sequence number, which is the strongest available. **No new dedup key is invented.**

---

## 5. Configuration architecture (reuse, do not create a second system)

Single existing system:

```
services/settings_service.py   DEFAULTS  (per-key schema, category, type, description)
services/runtime_settings.py   LIVE_KEYS (which keys are live) + rt_bool() cache
api/settings.py                generic GET / PATCH surface
```

The three `dbw_*` keys are already registered:

- `settings_service.py:435-437` (defaults `False`, category `data_saver`)
- `runtime_settings.py:80` (in `LIVE_KEYS`, so a flip applies on the next tick)

**Decision:** extend this system. Do not add a new config store, collection, or
service. A dedicated DB Writer *read/write* API is added on top of the existing
settings service (task §14), not beside it.

---

## 6. Default (task §5)

Existing authoritative default in `settings_service.py:435-437` is `False` for all
three `dbw_*` keys. That is `OFF`, which matches the task's fallback. No default is
invented; the existing one is kept and documented.

The conflicting `mwr_persist_ticks = True` is a **Market Watch** switch, not a DB
Writer permission. It is not deleted (rule §37) but demoted: it becomes an
"offer ticks upstream?" gate that is **ANDed** with the DB Writer permission, so the
DB Writer remains the sole authority.

---

## 7. Retention (task §21)

Per `docs/pending/PENDING-001-live-verification.md`: **no MongoDB TTL index exists**;
expiry is application-managed (`expires_at` + `expiry_type`). `mwr_tick_retention_days`
and `services/atlas_cleanup.py` handle bounded deletion. Therefore "1-day" in
`PERSONAL_ONE_DAY` / `MARKET_WATCH_ONE_DAY` is a **session/subscription
classification**, NOT a Mongo TTL. This must be documented explicitly to avoid an
operator assuming automatic deletion.

---

## 8. Files that will change

Backend:
- `python-service/services/db_writer_engine.py` (authority + candidate API)
- `python-service/services/market_watch_engine.py` (hand off, never decide)
- `python-service/api/engine_control.py` (GET/UPDATE persistence settings)
- `python-service/services/settings_service.py` (descriptions only)

Frontend:
- `app/_pages/db-writer/page.tsx` (Settings gear + 3 toggles + live status)

Tests:
- `python-service/tests/test_db_writer_engine.py` (new cases)
- `python-service/tests/test_market_watch_engine.py` (handoff, no Mongo)

---

## 9. Known limitations of this trace

- Static only. No live broker, no MongoDB, no running backend during this analysis.
- The effective database name and the live index set remain `NOT_VERIFIED`
  (see `PENDING-001`).
- `connection_engine` drain interval determines when Pipeline A observes a settings
  flip; Pipeline B resolves its gate on the MW tick path. Both are "next tick" but
  through different clocks.
