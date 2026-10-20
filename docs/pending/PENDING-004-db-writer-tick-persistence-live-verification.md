# PENDING-004-db-writer-tick-persistence-live-verification.md

## Task ID
PENDING-004

## Date Created
2026-09-28

## Priority
**P0 — CRITICAL** (blocks `IMPLEMENTED_NOT_VERIFIED` → `VERIFIED`)

## Title
Live verification of the DB Writer tick-persistence authority (GAP-036 / GAP-037)

## Status
`PARTIAL` (2026-10-07 read-only observations below; PUT/toggle steps deliberately not run)

> **Update 2026-10-07 — read-only observations only.**
> `GET .../db_writer_engine/tick-persistence` → `storageCapActive: true`
> (512 MB Atlas quota reason); all three permissions `enabled:false`,
> `hardCapped:true`, `accepted:0`; `skipped 1003996 + 36945`;
> `dropReasons.STORAGE_CAPPED 1036001`. C2 (Market Watch writes zero) and C6
> (cap holds) are consistent with these counters; C1 shows no saving stream
> active under the cap (`personalNoExpiry.accepted` also 0 — differs from this
> file's older expectation that the cap forces it ON; recorded, not changed).
> **PUT steps (3, 6, 8) deliberately NOT run**: the live backend's effective
> database is the production-named `kaustubh`, and this file's precondition 1
> requires `kaustubh_test`. Detail:
> `docs/verification/028-market-watch-terminal-redesign-and-live-verification.md`.

## Source
`docs/implementation/016-db-writer-single-tick-persistence-authority.md`,
`docs/verification/016-db-writer-single-tick-persistence-verification.md` §6,
`docs/PROJECT_GAPS.md` GAP-036, GAP-037, `docs/logs/LOG-002-2026-09-28-db-writer-tick-persistence-authority.md`

---

## Blocking Reason

The 016 architecture change is implemented and covered by **1201 automated tests**,
and the endpoints were driven over real HTTP by mounting the real router in a scratch
app. But **no live tick has ever flowed through the new decision point**, and no
permission has ever been flipped against real persisted settings.

Reason: no live MongoDB and no live broker were available during the session. A
backend was already running on port 8000 (pid 11200, started 23:32:46) — **before**
the change — so the new routes 404 against it. It was deliberately not restarted.

---

## Do This First (30 seconds)

```powershell
# Is a backend still running, and is it the OLD one?
Get-Process python -ErrorAction SilentlyContinue |
  Select-Object Id, StartTime
```

If pid 11200 (or any process started before 2026-09-29 00:00) is still up, **stop it
and start a fresh one** — otherwise every check below will 404 and you will waste the
session:

```powershell
# confirm the effective port first
Select-String -Path python-service\config\settings.py -Pattern 'port|host'
Stop-Process -Id 11200          # only after confirming what it is
```

Do **not** delete `python-service/runtime/` or the singleton lock by hand; stop the
process cleanly first.

---

## Preconditions

1. `MONGODB_URI` pointing at a **test** database (`kaustubh_test`). **Never production.**
2. `broker_mode=dummy` — this task needs *tick flow*, not real money.
3. Confirm the **effective** database name before writing anything. If it resolves to a
   production database, **stop** (see `PENDING-001` precondition 5).
4. Non-production environment.
5. Browser available for step 7 (GAP-037).

> **Scope warning.** This document covers **only** the 016 tick-persistence change.
> The separate `/api/realtime/token` 502, the `/api/phase2/stock-stats` 500 and the
> data-saver `status=200 error=no data` → 502 are **out of scope**. Do not fix them here;
> they have their own open items.

---

## What Is Actually Being Proven

Five claims from 016 that only a live run can settle:

| # | Claim |
|---|---|
| C1 | A live tick traverses classification → permission → dedup → buffer → bulk write |
| C2 | `dbw_market_watch_ticks=OFF` produces **zero** `market_ticks` writes, even with Market Watch offering ticks |
| C3 | Turning one permission ON does not affect the other two |
| C4 | An overlapping classification writes **exactly one** document |
| C5 | The Settings panel reports the same state the backend applies |
| C6 | *(new, 2026-09-29)* The **storage cap holds**: only the no-expiry stream writes, and a capped permission cannot be turned on from the UI or API |

---

## Steps

> ### ⚠ UPDATED 2026-09-29 — a temporary storage cap changed these expectations
> `docs/logs/LOG-003-2026-09-29-db-writer-tick-persistence-storage-cap.md` hard-caps
> persistence to the **personal no-expiry stream only** (the Atlas cluster has ~400 MB free).
> So `personalNoExpiry` is force-ON and the other two are force-OFF **regardless of the
> stored settings**, and the API **refuses** to enable them. Steps below have been updated:
> you are now verifying **C1–C5 plus C6 (the cap holds)**. Do not try to turn a capped
> permission on — that is the expected failure, not a bug.

### 1. Baseline — what the backend says after the cap

```powershell
$base = 'http://127.0.0.1:8000'
Invoke-RestMethod "$base/api/services/engines/db_writer_engine/tick-persistence" |
  ConvertTo-Json -Depth 6
```

**Expect under the cap:**
- `storageCapActive` = `true`, `storageCapReason` mentions 400 MB
- `personalNoExpiry`: `enabled` = **true** (cap forces it on), `hardCapWritable` = true
- `personalOneDay` and `marketWatchOneDay`: `enabled` = **false**, `hardCapped` = true
- `configuredEnabled` may be `false` for all three — the *settings* defaults are still OFF,
  which is correct; the cap is what forces the effective value.

Confirm the routes exist on the live process (a `404` here means you did not restart it):

```powershell
try { (Invoke-WebRequest "$base/api/services/engines/db_writer_engine/tick-persistence").StatusCode }
catch { "404 -> stale process, restart the backend" }
```

### 2. C2 + C6 — the critical regression (Market Watch must not reach the DB)

With the backend live and dummy ticks flowing, watch the counters:

```powershell
1..12 | ForEach-Object {
  (Invoke-RestMethod "$base/api/services/engines/db_writer_engine").tickPersistence |
    Select-Object -ExpandProperty permissions | ConvertTo-Json -Depth 4
  Start-Sleep 5
}
```

**Expect for the whole run:** `marketWatchOneDay.enabled = false`, `accepted = 0`, and
`skipped` **increasing**. Confirm nothing lands in Mongo:

```javascript
db.market_ticks.countDocuments({ receivedAt: { $gte: <run start epoch ms> } })
// MUST be 0 — this is the whole point of the cap
```

### 3. C6 — the cap cannot be lifted from the UI/API

```powershell
Invoke-RestMethod "$base/api/services/engines/db_writer_engine/tick-persistence" `
  -Method Put -ContentType 'application/json' `
  -Body '{"marketWatchOneDay":true}' | ConvertTo-Json -Depth 4
```

**Expect:** `ok: false` with a message naming the **storage cap**. This is the designed
behaviour — a toggle that could never take effect is rejected, not silently ignored.
Then confirm it is still off:

```powershell
(Invoke-RestMethod "$base/api/services/engines/db_writer_engine/tick-persistence").data.permissions.marketWatchOneDay.enabled
// MUST still be false
```

### 4. C1 — the no-expiry stream still saves

Let ticks flow for a personally subscribed, **permanent** instrument and confirm writes
still happen (this is what the cap preserves):

```powershell
# after ~30s
(Invoke-RestMethod "$base/api/services/engines/db_writer_engine").tickPersistence |
  ConvertTo-Json -Depth 5
```

**Expect:** `personalNoExpiry.accepted` **increasing** while `marketWatchOneDay.accepted`
stays 0. In Mongo, the documents that do appear must carry
`_tick_source: "PERSONAL_NO_EXPIRY"`.

### 5. C4 — an overlapping instrument is stored as no-expiry, once

For an instrument that is **both** personally subscribed and in the Market Watch universe,
the cap should store it **once, as `PERSONAL_NO_EXPIRY`** — it must not sneak in as a
Market Watch document.

### 6. Honest-failure paths

```powershell
# unknown permission
... -Body '{"personalOneWeek":true}'
# non-boolean
... -Body '{"personalNoExpiry":"yes"}'
# capped permission (expected refusal)
... -Body '{"personalOneDay":true}'
```

**Expect:** all `ok: false` with precise messages, switches unchanged.

### 7. C5 — Settings panel in a browser

Open `/services/db-writer`, click the **Settings** control.

**Expect:**
- an amber **"Storage cap active"** banner explaining the 400 MB limit;
- *Personal Stocks — No Expiry* **ON**, not disabled (still saving);
- *Personal 1-Day* and *Market Watch* **OFF**, `CAPPED` badge, toggles **disabled**;
- reload the page — the toggles still show what the backend holds (no optimistic drift).

### 8. Settings store unavailable while backend is up

Stop MongoDB (leave the backend running), then toggle the no-expiry switch.

**Expect:** `ok: false` with `unavailable`, a logged `tick_persistence_set_unavailable`,
and **no partial application** of a multi-key update.

---

## Success Criteria

- [ ] Live backend running the **new** code (new routes return 200, not 404)
- [ ] C1 — `personalNoExpiry.accepted` increases and real documents appear with
      `_tick_source: "PERSONAL_NO_EXPIRY"`
- [ ] C2 — `marketWatchOneDay.accepted = 0`, `skipped` increases, `market_ticks` count `= 0`
- [ ] C4 — an overlapping instrument is stored **once**, as `PERSONAL_NO_EXPIRY`
- [ ] C6 — the cap is active in the API (`storageCapActive: true`), and a `PUT` enabling
      `marketWatchOneDay` / `personalOneDay` is **refused** with a storage-cap message
- [ ] Validation paths return `ok: false` with precise messages
- [ ] Settings panel matches backend state across a page reload (C5), showing the cap banner
      and `CAPPED` badges
- [ ] Every observed number written into the verification record — **no estimates**
- [ ] **No production data touched; no real broker login attempted**

> **Dropped from this pass:** the old "C3 — flip one permission and confirm the others are
> untouched" and "restore all three to OFF at the end" criteria. Under the cap those toggles are
> not writable, so they are no longer meaningful here. They remain covered by unit tests.

### Deliberately NOT success criteria
- ~~TTL index on `market_ticks`~~ — **no TTL exists by design**; expiry is
  application-managed. "1-day" is a *session classification*, not a MongoDB TTL.
- ~~C++/Rust duplicate writer in `main.py`~~ — stale claim, not present in the tree.
- ~~Route collision~~ — statically disconfirmed earlier (D-01, D-05).

---

## If Something Fails

| Symptom | Likely cause | Do this |
|---|---|---|
| 404 on the new routes | stale backend process | restart per "Do This First" |
| `accepted` stays 0 with permission ON | instrument is not classified → `unknownSourceSkipped` rising | check the Session Manager entry for that token |
| `_tick_source` missing on stored docs | old code path still live | confirm the process start time, restart |
| `overlappingSourcesDeduped` stays 0 | no instrument matches both classifications | pick a genuinely overlapping token first |
| DB Writer unhealthy | tick buffer saturated | check `bufferLength` vs `bufferMaxSize` before blaming the permission |

**Do not "fix" anything during this run.** Observe and record. A live pass that mutates
behaviour under an unverified observation is worse than a pending item.

---

## Deliverable

1. Create `docs/verification/017-db-writer-tick-persistence-live-verification.md` with
   **observed** values for every step, plus the raw command output you relied on.
2. Update `docs/testing/VERIFICATION_MATRIX.md` if it carries the 016 rows.
3. Close **GAP-036** and **GAP-037** in `docs/PROJECT_GAPS.md` (or restate what is still
   open — do not delete a gap you did not actually close).
4. Update `docs/engines/db_writer_engine_detailed.md` with the observed behaviour.
5. Update the change log in `docs/FINAL_REPORT.md` §14 and the `Final status` row.
6. Append the result to
   `docs/logs/LOG-002-2026-09-28-db-writer-tick-persistence-authority.md`.
7. Set this file's `Status` to `DONE` (or `PARTIAL` with the reason).

---

## Related

- `docs/implementation/016-db-writer-single-tick-persistence-authority.md`
- `docs/verification/016-db-writer-single-tick-persistence-verification.md`
- `docs/audits/DB_WRITER_TICK_PERSISTENCE_AUDIT.md`
- `docs/audits/FRONTEND_DB_WRITER_SETTINGS_AUDIT.md`
- `docs/opencode/002-tick-persistence-ownership-trace.md` — the pre-change defect trace
- `docs/logs/LOG-002-2026-09-28-db-writer-tick-persistence-authority.md`
- `docs/PROJECT_GAPS.md` GAP-036, GAP-037, GAP-001
- `docs/PROJECT_RISKS.md` R-43, R-44 (both resolved)
- `docs/pending/PENDING-001-live-verification.md` — the general live pass; run step 1 of
  that first to confirm the database name and the dummy broker before running this one
