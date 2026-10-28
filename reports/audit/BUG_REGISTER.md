# KDS — Bug Register

**Repository:** `C:\project`
**Commit:** `d61860c983b8097e208b7144f73dad9e7812863b`
**Audit date:** 2026-10-28

| ID | Severity | Component | File:Line | Status | Evidence | Remediation |
|----|----------|-----------|-----------|--------|----------|-------------|
| P1-001 | P1 | Scheduler phase machine | `scheduler/__init__.py:177` | FIXED + VERIFIED | `PHASE_READINESS` keyed to `"ws_start"`; with login 09:00/pre_market 09:00/ws_start 09:13, readiness reported at 09:13 not 09:00 | Changed `_PHASE_ORDER[0]` to `(PHASE_READINESS, "login")`; added comment |
| P1-002 | P1 | Settings defaults | `services/settings_service.py:392` | FIXED + VERIFIED | `sched_login_time` default `"08:50"` contradicts required `09:00` | Changed default to `"09:00"` |
| P1-003 | P1 | Settings defaults | `services/settings_service.py:393` | FIXED + VERIFIED | `sched_ws_start_time` default `"08:55"` contradicts required `09:13` | Changed default to `"09:13"` |
| P1-004 | P1 | Settings defaults | `services/settings_service.py:394` | FIXED + VERIFIED | `sched_tick_collection_start_time` default `"08:59"` contradicts required `09:14` | Changed default to `"09:14"` |
| P1-005 | P1 | Settings defaults (alias) | `services/settings_service.py:165` | FIXED + VERIFIED | `scheduler_login_time` default `"08:50"` contradicts required `09:00` | Changed default to `"09:00"` |
| P1-006 | P1 | Settings defaults (alias) | `services/settings_service.py:178` | FIXED + VERIFIED | `data_collection_start` default `"08:59"` contradicts required `09:14` | Changed default to `"09:14"` |
| P1-007 | P1 | Settings defaults (alias) | `services/settings_service.py:180` | FIXED + VERIFIED | `auto_login_time` default `"08:50"` contradicts required `09:00` | Changed default to `"09:00"` |
| P2-001 | P2 | Settings migration | `services/settings_migrations.py:17-52` | FIXED + VERIFIED | Migration ran 09:00→08:50/09:13→08:55 (wrong direction); would downgrade existing installs | Reversed to 08:50→09:00/08:55→09:13; added 08:59→09:14 tick collection migration |
| P3-001 | P3 | Scheduler docs | `scheduler/__init__.py:9-40` | FIXED + VERIFIED | Module docstring documented 08:50/08:55/08:59 schedule; contradicts required 09:00/09:13/15:31 | Updated docstring to required schedule; removed outdated WS_PREPARING note |

**Total findings:** 9
**Fixed and verified:** 9
**Fixed but incompletely verified:** 0
**Unfixed:** 0

**Test verification:**
- `test_scheduler_ws_prep.py` — rewritten for 09:00/09:13/09:14 schedule; all pass
- `test_scheduler_phases.py` — updated for required schedule; all pass
- `test_scheduler_reconcile_lifecycle.py` — updated 08:50→09:00; all pass except pre-existing MongoDB failure
- `test_multi_broker_scheduler.py` — updated clock times 08:50/08:52→09:00; all 15 pass
- `test_kotak_parse.py`, `test_auto_login.py`, `test_ws_supervisor_sdk.py`, `test_kotak_margin_tradebook.py` — all pass

**No secrets, credentials, or `.env` files committed.**