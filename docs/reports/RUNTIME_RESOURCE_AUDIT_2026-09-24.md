# Runtime & Infrastructure Resource Audit — python-service + MongoDB on Oracle VM

**Date:** 2026-09-24
**Audit mode:** READ-ONLY (no code/config changes made; all figures from source inspection)
**Scope:** `C:\project\python-service` (single FastAPI backend) + co-located MongoDB on Oracle Cloud VM (2 vCPU, ~954 MiB RAM, 2 GiB swap, 45 GB disk, Ubuntu 24.04.5, x86_64, MongoDB 8.0.32). Target workload ≈2,600 ticks/sec from Kotak Neo SFeed, NSE CM universe.
**Out of scope:** Next.js frontend (deploys to Vercel; consumes zero VM RAM).

---

## 1. Executive Summary

- Single-process Python backend (Python 3.12.10): one asyncio loop, one Kotak SFeed WS (#1), one Kotak order-feed WS (#2), one Motor pool, batched `bulk_write` persistence. No Celery/RQ, no Redis, no multiprocessing.
- Batching is genuinely implemented end-to-end: subscription frames (200 tokens), tick buffer (batch 1,000, flush 1,000 ms), `ordered=False` bulk writes. Mongo is not hit per tick.
- **First bottleneck on this VM is RAM headroom**, not Mongo throughput: default Mongo wiredTiger cache (~450 MB) plus Python tick structures can exceed the ~954 MiB physical RAM, forcing swap throttling.
- **Second bottleneck (at sustained 2,600 ticks/sec): per-tick Python CPU** — a per-token dict merge in `tick_buffer.add` plus full canonicalization per message run synchronously on the feed hook. Estimated 1.5–2.0 vCPU all-in at the sustained peak.
- **Storage:** `db.ticks` has no TTL/retention. Sustained 2,600 ticks/sec ≈ 60.8M docs/day; even `canonical_only` at ~1 KB ≈ 61 GB/day — fills the 45 GB disk within a single session. Realistic session-average rates are the controlling factor and must be measured.
- **Verdict:** architecture is capable; co-residency on this VM is viable **only** with a reduced Mongo cache cap, `canonical_only` storage schema, and honest classification of "2,600 ticks/sec" as a peak/burst rather than a session-average.

---

## 2. Current Processor Architecture (measured)

| Aspect | Value (measured from code) |
|---|---|
| Entrypoint | `start_backend.py` — single instance, bind-before-lifespan, named-mutex single-instance guard (`runtime/singleton.py`) |
| Process model | 1 uvicorn process, no `--workers` — 1 process / 1 asyncio loop (`core/event_loop.py`) |
| Python | 3.12.10 (`.venv`) |
| Broker WS #1 | `ws_socket/ws_manager.py` — market-feed supervisor; subscribe frames `WS_SUBSCRIBE_BATCH_SIZE=200`, ~14 frames for the 2,600+ universe |
| Broker WS #2 | `ws_socket/order_feed_manager.py` — OrderUpdate/PositionUpdate, low rate, session-driven (not market-window gated) |
| Mongo client | Motor `AsyncIOMotorClient(maxPoolSize=50, minPoolSize=5, serverSelectionTimeoutMS=10000)` |
| Threads (Python) | uvicorn threadpool (default 40), timer thread, broker SDK reader, tick buffer guarded by `threading.Lock`; blocking SDK calls via `asyncio.to_thread` |
| Background tasks | tick flush loop, export worker (`WORKER_INTERVAL_S=1.0`), scheduled-downloads checker, retention cleanups (6 h), telemetry flushers (60 s), data-insights loops, dummy-session rollover (30 s), market-watch batch scanner (200 instruments / 15 s), scheduler supervisor (IST state machine) |
| Scheduler | `scheduler/__init__.py` — single asyncio supervisor: 08:50 login, 08:55 WS, 08:59 tick collection, 15:31 disconnect, 16:00 logout IST |
| Subscription universe | 2,600+ symbols (`ws_manager.py:692`); NSE EQ daily intent from `market_watch_engine.daily_subscription_intent()`; default feed family L8 depth |

---

## 3. Measurement Parameters (source tags)

- **Measured:** every constant, batch size, interval, lock, schema, scheduler timing, and index list below (read from source).
- **Estimated:** per-doc byte sizes (BSON), RAM of in-memory structures, per-tick CPU cost.
- **Assumed:** 2,600 ticks/sec is a **peak/burst** rate (sized both "sustained peak" and "realistic average" scenarios); default `.env`/settings unless a runtime override is noted.
- **Unknown (explicitly):** real observed `ticksPerSecond`, real WS#3 fan-out count, deployment Mongo cache cap, whether `ds_storage_schema=canonical_only` is live-enabled, actual per-doc bytes after Mongo padding/indexes.

---

## 4. Tick Ingestion & Persistence Path (measured)

```
Kotak SFeedWebSocket
 └─ ws_manager._handle_feed_message          (SDK callback)
     ├─ metrics/bookkeeping + market-state feed
     └─ _publish_hook → WebSocketEngine.on_feed_message
         ├─ canonicalize            (SDK decode → canonical envelope)
         ├─ master_canonical build  (52-field contract; runtime selectable)
         └─ TickRouter.route        (QUEUE_CAPACITY=5000, BACKPRESSURE_THRESHOLD=4000;
                                     full consumers gated/deferred; broker socket never blocked)
             └─ data_saver consumer deque
                 └─ ConnectionEngine._persistence_loop   (FANOUT_POLL_S=0.15, DRAIN_LIMIT=200)
                     └─ db_writer_engine.ingest(doc)     (dedup cache maxlen 50,000)
                         └─ tick_buffer.add(tick)        (threading.Lock; deque)
                             ├─ per-token merge into _latest_ticks (dict copy)
                             ├─ _record_price_history   (bounded 1,200 pts/token; ≥2 s spacing)
                             ├─ _recent (maxlen 200), _tick_times window, latency sample
                             └─ _deliver_to_listeners   (SSE listener queues, maxsize 500)
                             └─ flush loop every 1000 ms (min 0.2 s)
                                 ├─ len(buffer) ≥ 5000 → _flush_all()
                                 └─ else _flush_batch(1000)
                             └─ db.ticks.bulk_write([InsertOne...], ordered=False)
                                 └─ daily_summaries.update_one(upsert) per batch
```

Key measured constants:

| Constant | Default | Source |
|---|---|---|
| Flush interval | 1,000 ms (min 0.2 s) | `BUFFER_FLUSH_INTERVAL_MS`, `settings.py:160` |
| Buffer soft trigger | 5,000 | `BUFFER_MAX_SIZE`, `settings.py:161` |
| Bulk batch size | 1,000 | `BULK_INSERT_SIZE`, `settings.py:162` |
| Buffer hard cap | 100,000 (drop-oldest + `totalWriteErrors`) | `TICK_BUFFER_HARD_CAP`, `tick_buffer.py:142` |
| Router queue / backpressure | 5,000 / 4,000 | `router.py` |
| Persistence drain poll | 0.15 s / 200 | `connection_engine.py` |
| Subscribe batch | 200 tokens/frame (~14 frames for 2,600+) | `ws_manager.py:2129-2163` |
| Dedup cache | 50,000 | `db_writer_engine.py:54` |

Behavioral notes (measured):
- `ordered=False` partial-write tolerance; failed batches are **not** re-queued (prevents retry-loop memory growth while Mongo is down).
- Backpressure is non-blocking to the broker socket at every hop.
- `daily_summaries` upsert runs once per flush batch (≈3/sec at 2,600 ticks/sec).

---

## 5. MongoDB Behavior Under This Write Pattern

- Writes genuinely batched: at sustained 2,600 ticks/sec → ~3 bulk writes/sec of ~870 docs each, plus ~3 `daily_summaries` upserts/sec.
- Motor pool (50) is async/non-blocking — Mongo reads/writes do not block the event loop.
- Startup indexes (`database/connection.py:104-281`): `ticks` on `ts(-1)`, `(symbol,ts)`, `(instrumentToken,ts)`; ~60+ indexes across other collections; unique `system_events.event_id` created after duplicate repair. All `background=True` (one-time startup CPU spike).
- **Retention (measured):** TTL only on notifications (7 d), websocket_history/events (7 d), api_telemetry (30 d), data_saver_telemetry (30 d). **`db.ticks` has NO TTL index** → unbounded growth (see Section 8).

---

## 6. RAM Estimation (tightest constraint on this VM)

VM: ~954 MiB total, 2 GiB swap. Mongo 8.0.32 + Python 3.12 co-resident.

| Component | Basis | Estimate |
|---|---|---|
| Mongo wiredTiger cache | default 50% of RAM | ≈450 MB (soft cap; OS page cache excluded) |
| Mongo binary + journal + threads | measured-range RSS | ≈200–350 MB |
| **Mongo subtotal** | | **≈650–800 MB** |
| Python baseline (FastAPI, models, instrument master 3.4 MB in RAM) | | ≈120–180 MB |
| `_latest_ticks` 2,600 merged dicts × ~45 keys | estimated | ≈15–40 MB |
| `_price_history` worst case 2,600 tokens × ≤1,200 pts | bounded by 2 s spacing | ≈50–150 MB |
| Buffer + recent ring + rate windows + SSE queues | | ≈10–30 MB |
| **Grand total** | | **≈850 MB – 1.2 GB → exceeds 954 MiB → swap pressure** |

Mitigations already in code (measured): all in-memory structures are bounded (deques with maxlen, hard cap 100,000, price history 1,200 pts/token) — Python cannot grow unboundedly. But the *bounded* footprint plus an un-capped Mongo cache overruns physical RAM.

**Deployment recommendation (config-only, no code change):** cap Mongo cache via `--wiredTigerCacheSizeGB 0.25–0.3` (or a systemd/cgroup memory cap) to leave Python ~500 MB; otherwise co-residency is not viable at sustained peak.

---

## 7. CPU Analysis (2 vCPU)

| Source | Basis | Cost at 2,600/s |
|---|---|---|
| Per-message canonicalize + master_canonical + router | sync in `_publish_hook` | est. 0.4–0.6 core |
| `tick_buffer.add` merge + history + listeners | 2,600 dict-copies/s | est. 0.3–0.5 core |
| Motor/PyMongo bulk_write (≈3 × 1,000/s) | measured batching | est. 0.2–0.4 core |
| Mongo server apply (2,600 inserts/s + 3 upserts/s) | estimated | est. 0.5–0.8 core |
| Background loops (scanner 200/15 s, rankings 30 s, flushers 60 s) | measured | <0.1 core |
| **Total** | | **≈1.6–2.4 cores → at/over 2 vCPU at sustained peak** |

At realistic session-average rates (~50–300 ticks/sec), CPU is comfortably below one core. The ingest work runs on the asyncio loop/socket thread, so sustained peak can add event-loop latency; the router's gating is the intended pressure valve.

---

## 8. Storage & Database Growth (no TTL on `db.ticks`)

Estimated doc sizes: `legacy` ≈1.5–2.5 KB (28-key surface + L8 depth arrays + raw blob + `master_canonical` envelope + validation). `canonical_only` ≈0.8–1.2 KB (single 52-field envelope + isolated raw audit reference).

| Scenario | Ticks/day (23,400 s session) | legacy @2 KB | canonical_only @1 KB | 45 GB disk |
|---|---|---|---|---|
| Sustained 2,600 ticks/sec | 60.8M | ≈122 GB/day | ≈61 GB/day | ❌ fails same day |
| Realistic avg 300 ticks/sec | 7.0M | ≈14 GB/day | ≈7 GB/day | ⚠ 3–6 days |
| Realistic avg 50 ticks/sec | 1.17M | ≈2.3 GB/day | ≈1.2 GB/day | ✅ 17–20 days |

Findings:
- No TTL on `db.ticks`; three indexes on the collection add ~20–100% index overhead on top of doc bytes for the write side.
- Existing export jobs (`api/export_jobs.py`, background worker) are the natural purge/offload vehicle; nothing enforces retention today.

---

## 9. Network Analysis

- **Broker → backend:** one SFeed WS ≈ 0.65 MB/s at 2,600 ticks/sec (~250 B raw/tick); WS#2 order feed negligible (event-driven).
- **Backend → Mongo:** loopback ≈3.4 MB/s at 2,600 writes/sec (~1 KB/doc, write concern acknowledged) — negligible bandwidth; batch bursts hit journal.
- **Backend → Vercel/frontend:** on-demand only (SSE/WS channels, listener `maxsize=500`); fan-out is per-channel/watchlist, not all-ticks broadcast.
- **Outbound REST quote load:** market-watch batch scanner → ~13 quote calls/sec to Kotak while a session is active (broker rate-limited).

---

## 10. First Bottleneck (ranked)

1. **RAM co-tenancy on the VM** — Mongo default cache + Python tick structures overrun 954 MiB. (Config measured; magnitudes estimated.)
2. **Per-tick Python CPU** — canonicalize + dict merge at sustained 2,600 ticks/sec ≈ 1.5–2 vCPU all-in.
3. **Disk** — no `db.ticks` TTL makes sustained high rates fill 45 GB within a day.
4. Mongo apply throughput itself is not the bottleneck at these batch sizes.

---

## 11. Rate/Subscription Modeling

- Universe = 2,600+ NSE EQ (daily intent, ≤200 tokens/frame → ~14 frames; comment cross-reference `ws_manager.py:2161`). Default feed family L8 (8×8 depth rows).
- 2,600 ticks/sec across ~2,600 symbols ≈ 1 tick/sec/symbol — plausible only as a peak burst (open auction, index events, sector moves); a sustained all-day rate at 1 tick/s/symbol is what the storage table rejects.
- `db_writer_engine` dedup cache (50k) drops exact duplicates; net written ≤ received.

---

## 12. Deployment Requirements (recommendations; no code changed)

- **Mongo:** cap wiredTiger cache ≈0.25–0.3 GB; keep auth (`kds_app`), DB `kaustubh`; **never expose MongoDB publicly** (bind 127.0.0.1 / private network).
- **Storage:** add retention/partition on `db.ticks`, or schedule periodic export+purge jobs (existing export worker).
- **Schema:** enable `ds_storage_schema=canonical_only` to roughly halve per-doc size.
- **Memory:** monitor `free`/swap; raise VM RAM if sustained peak confirmed.
- **Env:** configure per `.env.example` (JWT, Mongo URI, Kotak creds; `BUFFER_FLUSH_INTERVAL_MS`/`BULK_INSERT_SIZE` selectable, defaults 1000/1000).
- **Vercel:** no VM RAM share; only on-demand HTTPS API/WS fan-out.

---

## 13. History / Context

- Backend is a Python re-implementation of a former Node.js layer (`services/tick_buffer.py:4`); the `legacy` storage schema is the backwards-compatible superset; the scheduler enforces the IST lifecycle (08:50 login → 08:55 WS → 08:59 ticks → 15:31 disconnect → 16:00 logout).
- `ds_storage_schema=canonical_only` was introduced to cut storage; documents carry a single 52-field `master_canonical` contract plus an isolated raw audit envelope.
- The whole tick path is non-blocking to the broker socket (router backpressure) and memory-bounded at every stage.

---

## 14. Appendix — Key Measured Facts Index

- Python 3.12.10; single uvicorn; `start_backend.py`; bind-before-lifespan; named-mutex singleton.
- `tick_buffer`: flush 1,000 ms / batch 1,000 / `ordered=False` / hard cap 100k / per-token merge / 1,200-pt price history / 200-recent ring.
- `router`: QUEUE_CAPACITY 5,000, threshold 4,000; `connection_engine`: poll 0.15 s, drain 200; `ws_manager`: subscribe batch 200 → ~14 frames; WS#2 order feed.
- Mongo indexes on `ticks` (×3) + ~60 others; **no TTL on ticks**; TTL 7 d (notifications, WS history/events), 30 d (telemetry).
- CPU/RAM/storage figures are labeled estimated/assumed where not directly measurable from source.

## 15. Verification Plan (read-only next steps on the VM)

1. `free -m; df -h` — confirm headroom vs Section 6 estimates.
2. `mongosh --quiet db.ticks.count()` — actual tick volume; correlate to `ticksPerSecond` dashboard metric during a live session to classify 2,600 as burst vs average.
3. `mongosh --quiet db.ticks.findOne()` — measure real doc size to choose between `legacy` and `canonical_only`.
4. Monitor `feedLatencyMs` during peak to validate the CPU/event-loop model in Section 7.
5. Verify Mongo cache cap and `ds_storage_schema` runtime setting match the deployment recommendations.