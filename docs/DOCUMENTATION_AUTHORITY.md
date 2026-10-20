# DOCUMENTATION_AUTHORITY.md

## Which document wins?

This file resolves the documentation-authority ambiguity recorded as **D-11** in
`docs/audits/DUPLICATE_AND_LEGACY_FINDINGS.md`.

**Created**: 2026-09-28
**Status**: Static analysis. No code was executed. No runtime state was observed.

---

## 0. TL;DR

`docs/architecture/` contains **two parallel document sets**:

| Set | Files | Status |
|-----|-------|--------|
| **Numbered** `00_`–`35_` | **36** | **CANONICAL** — newer, coherent, has an index |
| **Unnumbered** | 19 | **LEGACY** — older, ad hoc, no index |

But the canonical set contains a **serious, systemic defect**: every numbered file
carries a `STATUS: MIGRATED 2026-09-23` banner announcing the 4-WebSocket model, while
**the body text of the same file still describes the old 2-WebSocket model**. The
migration was applied as a banner only. The bodies were never rewritten.

**Do not trust the numbered set for WebSocket architecture without reading both models.**

Additionally, the canonical set's *operational* claims (engine states, gap remediation
steps, CLI commands) are **unverifiable and partly fictional** — see §4 and §5.

---

## 1. Which set is canonical

### Evidence that the numbered set is newer
`00_ARCHITECTURE_INDEX.md` line 93-94:
> "2026-09-21: Initial architecture documentation rebuild started.
> All 35 architecture files to be created...
> Based on scan of 25+ engine docs, **13 existing architecture files**, Python service
> code, and 30+ frontend pages"

This documents the rebuild explicitly, and "13 existing architecture files" matches the
**legacy unnumbered** set. The numbered set is therefore the product of a deliberate
2026-09-21 rebuild that superseded 13 older files. The 19 unnumbered files are those
superseded predecessors.

### Authority order (highest first)
1. **Actual source code** — always. Nothing below overrides the code.
2. `00_ARCHITECTURE_INDEX.md` — the intended map
3. Numbered set `00_`–`35_` — target/approved architecture
4. `docs/engines/*.md` — **target/approved** per `00` line 50 and `35` line 28:
   *"Engine docs are the approved architecture: the .md files in `docs/engines/` define
   what the target architecture should be."*
   **They are NOT evidence of current implementation.**
5. This bootstrap's catalogs (`docs/api/`, `docs/config/`, `docs/database/`, ...) —
   **extracted from source**, so they describe *current* code
6. Unnumbered legacy set — historical, superseded

> ### ⚠ Correction to earlier work in this bootstrap
> My `docs/architecture/SDK_CATALOG.md`, `DATA_FLOW_MAP.md`,
> `WEBSOCKET_ARCHITECTURE.md`, and `FAILURE_AND_RECOVERY.md` were built partly from
> engine/target documents. Per the rule above they may describe **target** rather than
> **current** state. Re-verify those four against code.

### Per-topic canonical document

| Topic | Canonical | Legacy / overlapping (do not use) |
|-------|-----------|-------------------------------|
| Documentation map | `00_ARCHITECTURE_INDEX.md` | — |
| System overview | `01_SYSTEM_OVERVIEW.md` | — |
| Engine architecture | `02_ENGINE_ARCHITECTURE.md` | `ENGINE_ARCHITECTURE.md`, `ENGINE.md` |
| Engine dependencies | `03_ENGINE_DEPENDENCY_GRAPH.md` | `ENGINE_DEPENDENCY_GRAPH.md` |
| Startup / shutdown | `04_STARTUP_SHUTDOWN_LIFECYCLE.md` | `SCHEDULER_LIFECYCLE.md` |
| Runtime lifecycle | `05_RUNTIME_LIFECYCLE.md` | `SCHEDULER_LIFECYCLE.md` |
| Broker adapters | `06_BROKER_ARCHITECTURE.md` | `BROKER_ARCHITECTURE.md` |
| Broker selection | `06_BROKER_ARCHITECTURE.md` | `BROKER_SELECTION_FLOW.md` |
| Session | `07_SESSION_ARCHITECTURE.md` | `SESSION_MANAGER_ENGINE.md` |
| **WebSocket** | **`WebSocket_ConnectionManager_Flow.md`** + `08_WEBSOCKET_ARCHITECTURE.md` | `WEBSOCKET_ENGINE.md` |
| Realtime data flow | `09_REALTIME_DATA_FLOW.md` | `REALTIME_DATA_FLOW.md` |
| Market data flow | `10_MARKET_DATA_FLOW.md` | `DATA_FLOW_MAP.md` |
| Trading flow | `11_TRADING_FLOW.md` | `ORDER_POSITION_FLOW.md` |
| Order lifecycle | `12_ORDER_LIFECYCLE.md` | — |
| Risk & margin | `13_RISK_MARGIN_ARCHITECTURE.md` | — |
| Position & P&L | `14_POSITION_PNL_ARCHITECTURE.md` | `ORDER_POSITION_FLOW.md` |
| Target & squareoff | `15_TARGET_SQUAREOFF_ARCHITECTURE.md` | — |
| Audit & notification | `16_AUDIT_NOTIFICATION_ARCHITECTURE.md` | — |
| Database | `17_DATABASE_ARCHITECTURE.md` + `docs/database/*` (code-extracted) | — |
| Configuration | `18_CONFIGURATION_ARCHITECTURE.md` + `docs/config/CONFIGURATION_CATALOG.md` (code-extracted) | — |
| UI | `19_UI_ARCHITECTURE.md` + `docs/frontend/*` (code-extracted) | — |
| Phases | `20_`, `21_`, `22_` | `PHASE_1_2_3_4_RESPONSIBILITIES.md` |
| Trading terminal | `23_TRADING_TERMINAL_ARCHITECTURE.md` | — |
| PWA / a11y | `24_PWA_ACCESSIBILITY_ARCHITECTURE.md` | — |
| Security | `25_SECURITY_ARCHITECTURE.md` + `docs/security/SECURITY_ARCHITECTURE.md` (code-extracted) | — |
| Error recovery | `26_ERROR_RECOVERY_ARCHITECTURE.md` | `FAILURE_AND_RECOVERY.md` (mine) |
| Observability | `27_OBSERVABILITY_ARCHITECTURE.md` + `docs/observability/*` (code-extracted) | — |
| API surface | `28_API_ARCHITECTURE.md` + **`docs/api/API_CATALOG.md` (code-extracted — use this for routes)** | — |
| Event bus | `29_EVENT_ARCHITECTURE.md` | — |
| Engine → UI | `30_ENGINE_UI_MAPPING.md` | — |
| Current vs target | `31_CURRENT_VS_TARGET.md` — **but see §4, claims unverified** | — |
| Gaps | `32_ARCHITECTURE_GAPS.md` — **but see §5, remediation commands fictional** | `docs/PROJECT_GAPS.md` (mine) |
| Migration | `33_MIGRATION_PLAN.md` | — |
| Onboarding | `34_DEVELOPER_ONBOARDING.md` — **but see §5, commands fictional** | — |
| AI context | `35_AI_AGENT_CONTEXT.md` — **but see §6, actively misleading** | `docs/opencode/001-*.md` (mine) |
| Doc audit | `ARCHITECTURE_DOCUMENTATION_AUDIT.md` | — |

---

## 2. The banner-migration defect (systemic)

All 36 numbered files open with:
> `**STATUS: MIGRATED 2026-09-23 — 4-WS model (WebSocket_ConnectionManager_Flow.md +
> 08_WEBSOCKET_ARCHITECTURE.md). Dual description WS#1+WS#2 collapsed; now WS#1 SFeed +
> WS#2 OrderFeed + WS#3 Backend→Frontend + WS#4 Frontend→Backend. See 08/09 for
> canonical flows.**`

**The bodies contradict this banner.** Examples:

| File:line | Body text | Contradicts banner? |
|-----------|-----------|---------------------|
| `00_ARCHITECTURE_INDEX.md:53` | "WS#1 = broker feed (WebSocket Engine), WS#2 = backend→frontend (Connection Manager)" | ✅ 2-WS model |
| `31_CURRENT_VS_TARGET.md:30-35` | Section "WS#1 vs WS#2 Separation", "WS#2 = backend→frontend … ✅ Confirmed" | ✅ 2-WS model |
| `34_DEVELOPER_ONBOARDING.md:12` | "WS#1/WS#2 Separation: Broker feeds (WS#1) vs frontend distribution (WS#2)" | ✅ 2-WS model |
| `35_AI_AGENT_CONTEXT.md:19-20` | "WS#1: Broker feed … WS#2: Backend→frontend" | ✅ 2-WS model |
| `35_AI_AGENT_CONTEXT.md:30` | "**WS#1 ≠ WS#2** — Never conflate broker feed data with frontend distribution" | ✅ 2-WS model |

**Impact**: an agent reading `35_AI_AGENT_CONTEXT.md` (the file explicitly designated for
AI agents) will form the **wrong** WebSocket mental model. This is the single highest-risk
documentation defect found.

**Secondary issue — banner character damage (precise)**: a UTF-8 scan of
`docs\architecture\*.md` shows the banner's two `→` arrows were **transliterated to ASCII
`?`** (exactly 2 `?` per banner file, e.g. `Backend?Frontend`, `Frontend?Backend`), and
**28 of 54 files contain exactly one U+FFFD replacement character** where the banner's
dash should be.

The rest of each file is valid UTF-8 and renders arrows correctly — 40 files contain real
`U+2192` arrows in their body text (up to 286 in
`FINAL_PRODUCTION_ARCHITECTURE_AUDIT_REPORT.md`). So this is **localized banner damage,
not general file corruption**.

Practical effect: grepping the numbered set for `Backend→Frontend` will not match, and
naive console output renders the banner as `Backend?Frontend`, which can be mistaken for
a rendering artifact. It is real and on disk.

**Recommended**: strip the banners and fix the bodies to the 4-WS model, or add an inline
warning at the top of each contradicting section. **Do not delete the legacy set until
bodies are fixed.**

---

## 3. WebSocket reality vs documentation

`WebSocket_ConnectionManager_Flow.md` (1151 lines) is the most detailed WS document and is
the reference cited by the migration banner. It defines 4 logical channels:

```
WS#1  Broker Market Data WebSocket          (Kotak Neo → WebSocket Engine)
WS#2  Broker Order & Position WebSocket     (Kotak Neo → Order Feed Handler)
WS#3  Backend → Frontend realtime WebSocket
WS#4  Frontend → Backend command WebSocket
```

### But the code exposes exactly ONE WebSocket route

| Evidence | Detail |
|----------|--------|
| `python-service\api\ws_gateway.py:278` | `@router.websocket("/ws/realtime")` |
| All `@router.websocket()` decorators in `api\*.py` + `app.py` | exactly **1** |
| All `"/ws..."` path strings in `api\*.py` | exactly **1** — `/ws/realtime` |

**Conclusion**: the 4 WebSockets are **logical/multiplexed channels over a single
FastAPI WebSocket endpoint** (`/ws/realtime`), plus a separate `connection_engine`
WebSocket layer started at `app.py:652` for backend→frontend fan-out. This is a
**refinement** of finding D-07, not a contradiction: documentation describes logical
channels; code implements one transport route.

**Neither the numbered docs nor `WebSocket_ConnectionManager_Flow.md` states this
explicitly.** This document does. Treat `/ws/realtime` as the only client-facing WS route.

**Not verified**: channel multiplexing behaviour, message envelope types, auth, reconnect,
gap-recovery. See `PENDING-001`.

---

## 4. Engine registry — definitive reconciliation

The documentation's engine claims are **contradicted by the code**. Source of truth is
`python-service\app.py:609-626`, which registers engines into
`services\engine_registry.py`.

### Registered in code: 17 (14 native + 3 facade)

| # | engine_id | Type | Auto-starts (`app.py:629`) |
|---|-----------|------|----------------------------|
| 1 | `feature_engine` | native | ✅ |
| 2 | `search_engine` | native | ✅ |
| 3 | `margin_engine` | native | ❌ **registered but not auto-started** |
| 4 | `squareoff_engine` | native | ❌ **registered but not auto-started** |
| 5 | `watchlist_engine` | native | ✅ |
| 6 | `market_watch_engine` | native | ✅ |
| 7 | `market_coach` | native | ✅ |
| 8 | `storage_engine` | native | ✅ |
| 9 | `db_writer_engine` | native | ✅ |
| 10 | `notification_engine` | native | ✅ |
| 11 | `audit_engine` | native | ✅ |
| 12 | `session_manager_engine` | native | ✅ |
| 13 | `connection_manager_engine` | native | ✅ |
| 14 | `websocket_engine` | native | ✅ |
| 15 | `scheduler_engine` | facade | ❌ (status sync only) |
| 16 | `order_engine` | facade (`OrderFacade`) | ❌ (status sync only) |
| 17 | `position_engine` | facade (`PositionFacade`) | ❌ (status sync only) |

Source: `app.py:609-624` (list) and `services\legacy_engine_facades.py:428-432` (`FACADES`).

### What the documentation claims

| Claim | Documentation | Code | Verdict |
|-------|--------------|------|---------|
| Total engines | 15 (`35`:16, `31`:61, `34`:11) | **17** | ❌ **WRONG** |
| Native / facade split | 13 native / 2 facade (`35`:16, `34`:31-32) | **14 / 3** | ❌ **WRONG** |
| `sqareoff_engine` | 5 docs | `squareoff_engine` | ❌ **typo** (0 hits in code; 44 hits for `squareoff`) |
| `session_engine` | `00`:83, `35`:45 | `session_manager_engine` | ❌ wrong name |
| `connection_engine` | `00`:84, `35`:46 | `connection_manager_engine` | ❌ wrong name (note: a *separate* `connection_engine/` module also exists) |
| `watchlist_target_engine` | `00`, `31`:26, `32` Gap 3, `35`:51 | **does not exist** | ❌ **FICTIONAL** |
| `database_engine` | `00`:88, `35`:49 | no such registered engine | ❌ no engine registration |
| `broker_manager` | `00`:87, `35`:48 | no such registered engine | ❌ no engine registration |

### Undocumented registered engines
`market_watch_engine`, `market_coach`, `storage_engine`, `db_writer_engine`,
`session_manager_engine`, `connection_manager_engine`, and the 3 facades
(`scheduler_engine`, `order_engine`, `position_engine`) appear in **none** of the
15-engine lists in `00`, `31`, or `35`.

### Engine modules on disk but NOT registered
`python-service\core\engines\` contains 12 engine modules. These are **not** in the
registry: `risk_engine.py`, `order_engine.py`*, `position_engine.py`*, `target_engine.py`,
`pnl_engine.py`, `basket_engine.py`
<sub>*covered by facades instead; still not the `core/engines` class</sub>

`risk_engine` deserves attention: `app.py` references it only as an **API router**
(`from api.risk_engine import router`, `app.py:111`, included at `app.py:1023`). The
`core/engines/risk_engine.py` module is imported 6 times elsewhere but is **not
registered as an engine**. The docs list `risk_engine` as one of the 15 registered
engines — it is not.

**Consequence**: any engine-lifecycle reasoning built on the 15-engine list is wrong.
**Fix**: update `docs/engines/ENGINE_INVENTORY.md`, `00`, `31`, `32`, `35`.

---

## 5. The remediation commands are fictional ⚠

`32_ARCHITECTURE_GAPS.md` and `34_DEVELOPER_ONBOARDING.md` give operational instructions
built on a `python -m kaushub.*` CLI:

```bash
python -m kaushub.engine start audit_engine          # 32 Gap 2 step 1
python -m kaushub.engine restart sqareoff_engine     # 32 Gap 1 step 3
python -m kaushub.engine status <name>               # 32, 34 §34.7
python -m kaushub.engine reconcile positions         # 32 Gap 1 step 1
python -m kaushub.cli start                          # 34 §34.3
python -m kaushub.cli status                         # 34 §34.3
python -m kaushub.db.query <collection> <filter>    # 34 §34.7, 35 §?
```

**Verification performed**:
```
Get-ChildItem -Recurse -Path C:\project -Filter "kaushub*"   ->  (no results)
Get-ChildItem -File -Path python-service -Filter *.py          ->  no cli.py / __main__.py
```
Actual entry points are: `python-service\app.py`, `python-service\start_backend.py`,
`python-service\watchdog_backend.py`.

**There is no `kaushub` package. Every command above fails immediately.**

**Impact**: the *entire documented remediation path* for all 4 "open" gaps in
`32_ARCHITECTURE_GAPS.md` is unexecutable. Combined with §4 (the `sqareoff_engine` name
doesn't exist either, and `audit_engine` **is** auto-started at `app.py:620,629`),
`32_ARCHITECTURE_GAPS.md` should be treated as **unreliable** pending a rewrite.

Engine lifecycle is instead controlled through the HTTP API exposed by
`api/engine_control.py` (tests present: `tests\test_engine_control_api.py`,
`tests\test_engine_registry.py`). **The exact endpoints were not enumerated in this pass** —
see `PENDING-003`.

---

## 6. Other verified factual errors in the numbered set

| Claim | File:line | Verified reality |
|-------|-----------|-----------------|
| `C:\project\config.yaml` is the configuration source | `35`:69, `35`:90 | **Does not exist.** No `config*.y*ml` anywhere outside `.venv`. Config is `python-service\config\settings.py` |
| Frontend code is at `app\_pages\` | `35`:89, `34`:28 | `app\_pages\` is a **Next.js private folder — not routable**. It holds 74 files including 38 `page.tsx`; only 1 is imported by the live app (`_pages\dashboard\page`) |
| "30+ frontend pages" | `00`:94, `35`:67 | **151** routable `page.tsx` (**189** total, incl. 38 in `_pages\`) |
| "25+ engine docs" | `34`:20, `35`:54 | **31** files in `docs\engines\` |
| "35 architecture files" | `00`:93, `34`:21, `34`:66, `34`:137, `35`:55 | **36** numbered files (`00_`–`35_`) |
| Install: `cd C:\project; pip install -r requirements.txt` | `34`:37-38 | `requirements.txt` is at `python-service\requirements.txt`; **no root `requirements.txt`** |
| Unit tests in `python-service\tests\` | `34`:59 | ✅ **Correct** — 68 test modules present |
| MongoDB db name `kaustubh_trading` | `35`:91 | **Not verified** — check `config/settings.py` / `database/connection.py` |
| `install from C:\project` then `python -m kaushub.cli start` | `34`:35-42 | Both steps wrong (see §5) |

### Arithmetic self-contradiction in the engine-state tables
`35`:24 and `31`:61 state **"10 RUNNING, 1 DEGRADED, 3 UNKNOWN"** (= 14).
But the tables immediately below (`31`.2, `35`.34-51) list **12 RUNNING, 1 DEGRADED,
2 UNKNOWN** (= 15).
The prose and the tables in both documents disagree with each other.

---

## 7. All runtime-state claims are `NOT_VERIFIED`

Every "current state" claim in `31_CURRENT_VS_TARGET.md` and
`35_AI_AGENT_CONTEXT.md` — `RUNNING`, `DEGRADED`, `UNKNOWN`, "10 RUNNING", "15 symbol
feeds", "24 frontend connections", "12 active users", "12/15 engines reporting",
"All 3 brokers active", "MongoDB … all collections active" — is **`NOT_VERIFIED`**.

Evidence available:
- No timestamped run log accompanies any of these figures.
- The remediation commands offered to fix the claimed gaps do not exist (§5), so these
  figures were never validated by the documented process.
- The prose and tables contradict each other (§6).
- The stated authority order puts engine docs as **target** architecture, not observed
  state (`00`:50, `35`:28) — yet `31`/`35` present their tables as observed
  (`31`:88, `35`:115: *"based on … observed runtime state"*).

**Treat all engine health, broker connectivity, WebSocket fan-out, and user-count figures
in the numbered set as aspirational or stale.** Only `PENDING-001` can establish them.

Notably, `32`.2 Gap 2 claims `audit_engine` is "not yet started at runtime" and must be
started manually — but `app.py:620,629` **registers and auto-starts** `audit_engine`.
Either the code changed after 2026-09-23, or the observation was wrong.

---

## 8. What I changed, and what I did not

**Changed**: documentation only —
- created this file
- added findings D-13…D-18 to `docs/audits/DUPLICATE_AND_LEGACY_FINDINGS.md`
- corrected `docs/engines/ENGINE_INVENTORY.md` engine count and classification
- corrected `docs/PROJECT_MAP.md` file counts and engine listing
- corrected `docs/FINAL_REPORT.md` and `docs/PROJECT_RISKS.md`
- corrected `docs/pending/PENDING-003-static-code-audit.md` file paths
- appended to `docs/PROJECT_CHANGE_HISTORY.md` and the verification record

**Not changed** (requires your decision):
- The 36 numbered architecture files — banner/body contradiction left in place, because
  rewriting approved architecture docs is a content decision, not a discovery task.
- The legacy unnumbered set — not deprecated, not deleted.
- Any application code, test, or configuration.

---

## 9. Recommended decisions (need your input)

1. **Fix or flag the banner contradiction?** ~5 files carry 2-WS body text under a 4-WS
   banner. I can add a one-line warning to each, or rewrite the bodies to 4-WS.
2. **Deprecate the legacy set?** Add a `> SUPERSEDED — see NN_*.md` header to the 19
   unnumbered files.
3. **Rewrite `32_ARCHITECTURE_GAPS.md`?** Its 4 gaps rest on a fictional CLI. Options:
   replace commands with real HTTP engine-control endpoints, or mark the whole document
   `NOT_VERIFIED` pending `PENDING-001`.
4. **Correct the engine count to 17 across 5 documents?** I have applied this to
   `ENGINE_INVENTORY.md`; `00`, `31`, `32`, `34`, `35` still say 15.
5. **Investigate unregistered engines.** `risk_engine`, `target_engine`, `pnl_engine`,
   `basket_engine` are implemented in `core/engines/` but not registered. Dead code, or
   a registration gap? This needs a deliberate decision.

---

*Static analysis only. No code executed, no runtime state observed, no secrets read.*
