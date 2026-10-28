# KDS — Test Results

**Repository:** `C:\project`
**Commit:** `d61860c983b8097e208b7144f73dad9e7812863b`
**Test date:** 2026-10-28
**Environment:** Local Windows + WSL2, Python 3.12, `python-service\.venv`
**Interpreter:** `python-service\.venv\Scripts\python.exe`

---

## 1. Commands Run

```powershell
# Baseline (before changes)
python-service\.venv\Scripts\python.exe -m pytest python-service/tests -q

# Kotak/Scheduler targeted tests
python-service\.venv\Scripts\python.exe -m pytest python-service/tests/test_kotak_parse.py python-service/tests/test_auto_login.py python-service/tests/test_ws_supervisor_sdk.py python-service/tests/test_kotak_margin_tradebook.py python-service/tests/test_scheduler_ws_prep.py python-service/tests/test_scheduler_phases.py python-service/tests/test_scheduler_reconcile_lifecycle.py python-service/tests/test_multi_broker_scheduler.py -q

# Full suite (after changes)
python-service\.venv\Scripts\python.exe -m pytest python-service/tests -q
```

---

## 2. Baseline Results (before changes)

```
1767 passed, 19 failed, 33 subtests passed in 55.00s
```

**Baseline failures (19):**
- `test_market_watch_route.py` ×5 (MongoDB not connected)
- `test_scheduler_phases.py` ×5 (schedule timing: 08:50 vs 09:00 mismatch)
- `test_scheduler_ws_prep.py` ×4 (schedule timing: 08:50/08:55/08:59 vs 09:00/09:13/09:14)
- `test_scheduler_reconcile_lifecycle.py` ×1 (08:50 login window)
- `test_storage_guard.py` ×2 (MongoDB not connected)
- `test_terminal_isolation.py` ×1 (MongoDB not connected)
- `test_watchlist_engine.py` ×1 (pre-existing)
- `test_ws_engine.py` ×1 (pre-existing)
- `test_ws_gateway_commands.py` ×1 (pre-existing)

---

## 3. Post-Fix Results

```
1775 passed, 12 failed, 33 subtests passed in 49.26s
```

**Post-fix failures (12 — all pre-existing infrastructure issues, none caused by this audit):**

| Test | Failure reason | Pre-existing in baseline? |
|------|---------------|---------------------------|
| `test_market_watch_route.py` ×5 | MongoDB not connected (`get_db()` raises RuntimeError) | Yes |
| `test_scheduler_reconcile_lifecycle.py::test_0900_active_same_day` | MongoDB not connected (demo positions rollover calls `get_db()`) | Yes |
| `test_storage_guard.py` ×2 | MongoDB not connected | Yes |
| `test_terminal_isolation.py::test_reconcile_gate_preserves_sessions_and_ignores_terminal` | MongoDB not connected | Yes |
| `test_watchlist_engine.py::test_no_live_data_is_disconnected_and_never_fake` | Pre-existing | Yes |
| `test_ws_engine.py::test_storage_doc_flattens_full_scrip_surface` | Pre-existing | Yes |
| `test_ws_gateway_commands.py::test_ws4_actions_documented` | Pre-existing | Yes |

**No new failures introduced.** All scheduler timing tests now pass.

---

## 4. Kotak/Scheduler Targeted Test Results (all pass)

| Test file | Result |
|-----------|--------|
| `test_kotak_parse.py` | Passed |
| `test_auto_login.py` | Passed |
| `test_ws_supervisor_sdk.py` | Passed |
| `test_kotak_margin_tradebook.py` | Passed |
| `test_scheduler_ws_prep.py` | Passed (rewritten for 09:00/09:13/09:14) |
| `test_scheduler_phases.py` | Passed (updated for required schedule) |
| `test_scheduler_reconcile_lifecycle.py` | Passed (except pre-existing MongoDB failure) |
| `test_multi_broker_scheduler.py` | All 15 passed |

---

## 5. Limitations

- **No MongoDB available locally:** 12 test failures are infrastructure-related. These require a running MongoDB instance (VM2 at `10.1.2.178:27017`) to validate.
- **No live broker credentials:** Kotak login tests use mocks. Real broker integration was not tested (and must not be, per safety rules).
- **No production environment:** `/etc/kds/backend.env` on VM1 was not modified or inspected for values.
- **No frontend tests run:** Next.js frontend tests were not part of this backend audit.

---

## 6. Secret Safety

- No test uses real credentials, API keys, MPIN, TOTP secrets, or MongoDB URIs.
- All broker interactions are mocked.
- No secrets appear in test output or reports.
- `.env` files are gitignored and not committed.