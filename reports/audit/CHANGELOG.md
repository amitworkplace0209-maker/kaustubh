# KDS — Audit Changelog

**Repository:** `C:\project`
**Base commit:** `d61860c983b8097e208b7144f73dad9e7812863b`
**Audit date:** 2026-10-28

---

## Files Changed

| File | Change | Reason | Severity |
|------|--------|--------|----------|
| `python-service/scheduler/__init__.py` | `_PHASE_ORDER[0]` changed from `(PHASE_READINESS, "ws_start")` to `(PHASE_READINESS, "login")`; added explanatory comment | Readiness was keyed to WS start (09:13) instead of login (09:00), causing incorrect phase during pre-market window | P1 |
| `python-service/scheduler/__init__.py` | Module docstring updated: schedule changed from 08:50/08:55/08:59 to 09:00/09:13/09:14/15:31/16:00; removed outdated WS_PREPARING note | Documentation contradicted required schedule | P3 |
| `python-service/scheduler/__init__.py` | TICK_COLLECTION state time in docstring updated from `(08:59 start)` to `(09:14 start)` | Align with required schedule | P3 |
| `python-service/services/settings_service.py` | `sched_login_time` default: `"08:50"` → `"09:00"` | Default contradicted required login time | P1 |
| `python-service/services/settings_service.py` | `sched_ws_start_time` default: `"08:55"` → `"09:13"` | Default contradicted required WS connect time | P1 |
| `python-service/services/settings_service.py` | `sched_tick_collection_start_time` default: `"08:59"` → `"09:14"` | Default contradicted required tick collection time | P1 |
| `python-service/services/settings_service.py` | `scheduler_login_time` alias default: `"08:50"` → `"09:00"` | Alias default contradicted required login time | P1 |
| `python-service/services/settings_service.py` | `data_collection_start` alias default: `"08:59"` → `"09:14"` | Alias default contradicted required tick time | P1 |
| `python-service/services/settings_service.py` | `auto_login_time` alias default: `"08:50"` → `"09:00"` | Alias default contradicted required login time | P1 |
| `python-service/services/settings_migrations.py` | Migration direction reversed: 08:50→09:00, 08:55→09:13, added 08:59→09:14 | Migration was downgrading existing installs to wrong schedule | P2 |
| `python-service/services/settings_migrations.py` | Migration query expanded to include `sched_tick_collection_start_time` | Tick collection time also needed migration | P2 |
| `python-service/services/settings_migrations.py` | Log message updated: `08:50/08:55/08:59` → `09:00/09:13/09:14` | Reflect corrected schedule | P2 |
| `python-service/tests/test_scheduler_ws_prep.py` | Rewritten: schedule expectations changed from 08:50/08:55/08:59 to 09:00/09:13/09:14; added ws_stop/logout time tests | Tests were asserting old wrong schedule | P1 (test) |
| `python-service/tests/test_scheduler_phases.py` | `test_before_login_closed` now asserts 08:00/08:55/08:59 all CLOSED; added `test_readiness_at_login_instant` asserting PRE_MARKET at 09:00; removed `test_readiness_window` | Phase machine now keys readiness to login (09:00), so 08:55 is CLOSED not READINESS | P1 (test) |
| `python-service/tests/test_scheduler_reconcile_lifecycle.py` | `test_0850_login_fires` renamed to `test_0900_login_fires`; clock changed from 08:50 to 09:00 | Login window now opens at 09:00 | P1 (test) |
| `python-service/tests/test_multi_broker_scheduler.py` | Two tests: clock changed from 08:50/08:52 to 09:00 | Login window now opens at 09:00 | P1 (test) |

---

## Files NOT Changed (by design)

| File | Reason |
|------|--------|
| `python-service/.env` | Gitignored local dev file; contains real credentials. Only `LOGIN_HOUR`/`LOGIN_MINUTE` edited locally to align with required schedule (not committed). |
| `/etc/kds/backend.env` (VM1) | Production secret file. Not touched. |
| Any `.env.example` | Templates with empty placeholders. No secrets. |
| Any `.bak` files | Preserved. Not touched. |
| MongoDB data / collections | Not touched. |
| VM agent token files | Not touched. |

---

## Git Diff Summary

```
7 files changed, 223 insertions(+), 203 deletions(-)
 M python-service/scheduler/__init__.py
 M python-service/services/settings_migrations.py
 M python-service/services/settings_service.py
 M python-service/tests/test_multi_broker_scheduler.py
 M python-service/tests/test_scheduler_phases.py
 M python-service/tests/test_scheduler_reconcile_lifecycle.py
 M python-service/tests/test_scheduler_ws_prep.py
```

No `.env` files, no credentials, no secrets, no `.bak` files in the diff.

---

## Verification

- `_sched_times()` returns: login `(9, 0)`, ws_start `(9, 13)`, tick_collection `(9, 14)`, ws_stop `(15, 31)`, logout `(16, 0)`
- All Kotak/Scheduler targeted tests pass (43+ tests)
- Full suite: 1775 passed, 12 failed (all 12 pre-existing infrastructure issues — no MongoDB locally)
- No live broker login, no real orders, no production service restart