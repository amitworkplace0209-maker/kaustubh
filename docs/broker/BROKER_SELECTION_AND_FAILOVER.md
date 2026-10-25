# BROKER_SELECTION_AND_FAILOVER.md

## Broker selection, failover, and the Shoonya capability claim

**Created**: 2026-09-28
**Method**: full read of `brokers/manager.py` (132 lines), `brokers/broker_registry.py`
(258 lines), plus method-name comparison of all three adapters against `brokers/base.py`
and the tests that assert current behaviour.
**Status**: `STATIC_VERIFIED`. **No broker was logged into. No adapter method was executed.**

> **Resolves a prior unknown**: `brokers/manager.py` **does exist** (4,516 B). Earlier
> bootstrap notes listed it as unverified.

---

## 1. Headline

> **There is no failover.** No health check, no failure detection, no retry, no circuit
> breaker, no automatic switch — anywhere in `brokers/`. Status is *computed and reported*,
> and then **nothing consumes it**. Broker switching is entirely manual, and the only caller
> of the switch is the **unauthenticated** engine-control endpoint (**R-17**).

A second, more serious structural issue: **there are two independent broker-selection
systems that can disagree**, and no code path reconciles them.

---

## 2. What exists

| Module | Lines | Role |
|--------|-------|------|
| `brokers/base.py` | 5,125 B | `BrokerAdapter` protocol — **18 methods** |
| `brokers/broker_registry.py` | 8,993 B | capability table + **independent** trading / market-data selection + status |
| `brokers/manager.py` | 4,516 B | **single active terminal**, session-aware, 3-tier resolution |
| `brokers/selection.py` | 3,116 B | (not read in this pass) |
| `brokers/capabilities.py` | 5,421 B | (not read in this pass) |
| `brokers/kotak_adapter.py` | 9,639 B | Kotak Neo |
| `brokers/shoonya_adapter.py` | 21,431 B | Shoonya |
| `brokers/dummy.py` | 9,836 B | paper trading |

`base.py` protocol (18): `cancel_order, capabilities, funds, holdings, is_logged_in, login,
logout, margin_required, modify_order, order_history, orders, place_order, positions, quote,
require_logged_in, search, square_off, trade_book`

---

## 3. B-1 — No failover exists (High)

`BrokerRegistry` computes state honestly and then stops:

- `get_trading_status()` (`:182-208`) returns `CONNECTED` / `DISCONNECTED` / `ERROR` /
  `NOT_IMPLEMENTED` from the real adapter's `is_logged_in`
- `get_market_data_status()` (`:210-240`) returns the same from the real `ws_manager`
- `full_status()` (`:242-247`) aggregates them

**No method anywhere reads those states to change a selection.** A search of the whole
backend for `set_trading_broker` / `set_market_data_broker` returns exactly three
non-definition hits:

| Caller | Line | Auth |
|--------|------|------|
| `api/engine_control.py` | 165 | **none** (R-17) |
| `api/engine_control.py` | 173 | **none** (R-17) |
| `tests/test_engine_registry.py` | 308, 312 | test |

So if Kotak drops mid-session, the system **stays on Kotak** and surfaces
`state: "DISCONNECTED"`. There is no `dummy` fallback, no retry-with-backoff, and no
degradation path. Given `dummy` is a full paper-trading adapter, a
"fall back to dummy and flag it loudly" policy would be straightforward — but it is **not
implemented**.

Compounding this: the endpoint that *can* change the trading broker is reachable without
authentication. An unauthenticated caller can repoint the trading broker (subject to the
capability check) — that is a control-plane action, not a failover one.

---

## 4. B-2 — Two broker-selection systems that can disagree (High)

| | `brokers/manager.py` | `brokers/broker_registry.py` |
|---|---|---|
| State | `session_manager.set_mode()` + persisted `terminal_mode` setting | in-memory `_trading_broker` / `_market_data_broker` |
| Cardinality | **one** terminal for everything | **two independent** selections (trading ≠ market data) |
| Resolution | 3-tier: live session mode → persisted `terminal_mode` → `settings.broker_mode` → `"kotak"` | plain attribute, default `"kotak"` |
| Persistence | survives restart (via `get_runtime_setting`) | **process-local only** |
| Mutator | `switch_terminal(mode)` | `set_trading_broker()` / `set_market_data_broker()` |

**Neither system calls the other.** `switch_terminal()` contains no reference to the
registry (verified by search), and the registry setters never call `set_mode`. Therefore:

- Switching the terminal in the UI does **not** change `registry._trading_broker`
- Calling the engine-control endpoint does **not** change the session mode
- The registry can hold `trading=kotak, market_data=dummy` — a combination
  `active_terminal()` cannot even represent
- On restart the registry silently resets to `kotak` while `active_terminal()` restores the
  user's persisted choice — a divergence that appears **only after a restart**

**Which source of truth a given code path honours is `UNKNOWN`** without tracing every
call site. `get_active_adapter()` (manager) and `registry.get_trading_broker()` (registry)
can legitimately return different brokers in the same process.

---

## 5. B-3 — The Shoonya capability table contradicts the code (Medium)

`BROKER_CAPABILITIES["shoonya"]` (`:68-79`) declares **every** capability `False`
(`trading`, `market_data`, `positions`, `margin`, `orders`, `holdings`, `search`,
`websocket`) with `auth_flow="oauth"`, and the module docstring states
*"Shoonya: Trading NOT IMPLEMENTED, Market Data NOT IMPLEMENTED"*.

Measured against `base.py`'s 18-method protocol:

| Adapter | Lines | `def`s | Protocol coverage | Unimplemented markers | Declared capability |
|---|---|---|---|---|---|
| `kotak_adapter.py` | 222 | 21 | **17 / 18** | 0 | all `True` |
| `dummy.py` | 219 | 19 | **16 / 18** | 0 | mostly `True` |
| **`shoonya_adapter.py`** | **448** | **34** | **16 / 18** | **0** | **all `False`** |

`shoonya_adapter.py` is **twice the size of either declared-implemented adapter**, defines
**34** methods, has **no** `NotImplementedError`, and **no** `TODO`/`FIXME`/`stub`/
`placeholder` marker. Its missing methods are `margin_required` and `require_logged_in` —
and `require_logged_in` is missing from **all three**, while `margin_required` is also
missing from `dummy`, which *is* declared implemented.

So **Shoonya's implementation breadth is on par with Dummy's**, yet it is declared to have
nothing.

**The tests enforce the contradiction:**

- `tests/test_engine_registry.py:301-304` asserts `cap.trading` is `False` and
  `cap.market_data` is `False`
- `tests/test_engine_registry.py:306-314` `test_rejects_fake_shoonya_selection` asserts both
  setters return `ok: False` with `"NOT IMPLEMENTED"` in the error

**Two readings, and the code does not settle it:**

1. The adapter is complete and the capability table **and its tests are stale** — the
   selection UI would wrongly hide a working broker.
2. The adapter is aspirational scaffolding and the table is right — but then 448 lines
   containing 34 methods and zero unimplemented markers is a very misleading stub.

**Resolving this requires reading the method *bodies*** (name comparison cannot prove
behaviour) or exercising the adapter. Flagged for a human decision; the capability table
and the tests should be treated as **unverified claims** until then.

Note the module docstring's own instruction — *"Do NOT assume future capabilities. Only
register what actually works."* — suggests the table was deliberately conservative, which
makes reading (2) more likely, but that is inference, not evidence.

---

## 6. B-4 — `get_market_data_status()` misreports for `dummy` (Medium)

`:226-235` always reads the **global** `ws_manager`, regardless of which broker is
selected:

```python
from ws_socket.ws_manager import ws_manager
ws_status = ws_manager.status()
status["state"] = "CONNECTED" if ws_status.get("connected") else "DISCONNECTED"
```

With `dummy` selected as the market-data broker, this reports the **real broker's**
WebSocket state — a live Kotak feed — as the dummy broker's status. The UI can therefore
show `dummy / CONNECTED / 850 symbols` while actually receiving nothing simulated.

The capability record is also internally inconsistent for `dummy`: `market_data=True` but
`websocket=False` (`:80-91`). Since `market_data` is what gates selection
(`:170-172`), dummy is selectable for market data while declaring it has no WebSocket.

---

## 7. B-5 — `required_user_id()` returns hardcoded constants (Low)

`manager.py:126-132`:

| Terminal | Returned identity |
|---|---|
| `dummy` | `"KAUSTUBH_DUMMY"` (constant) |
| `shoonya` | `str(settings.shoonya_user_id or "SHOONYA_USER")` |
| `kotak` | `"KOTAK_NEO"` (constant) |

Two of the three are **compile-time constants**, and the third falls back to a constant.
There is no per-user identity, so every user of a terminal shares one identity in anything
keyed on it. Relevant to audit-log attribution: entries attributed to `"KOTAK_NEO"` cannot
be attributed to a person from that field alone.

---

## 8. B-6 — Registry state is process-local (Low)

`BrokerRegistry` is a module singleton guarded by `threading.RLock` (`:105-110`, `:250-258`).
That is correct for threads but **not** across processes. The migration layer explicitly
anticipates multiple workers (`migrations.py:145-164`, cross-worker lock with staleness),
so the deployment may be multi-process — in which case `set_trading_broker()` in one worker
is **invisible to every other worker**, and each worker keeps its own `_trading_broker`.

`Not verified`: whether the app is actually run with more than one worker. `HOST=0.0.0.0`
and `PORT` in `.env` do not settle it.

---

## 9. Findings summary

| # | Finding | Severity | Verified by |
|---|---------|----------|--------------|
| B-1 | **No failover anywhere.** Status is computed and never acted on. Switching is manual and reachable only via the unauthenticated engine-control endpoint | **High** | full read of both modules + project-wide caller search |
| B-2 | **Two independent broker-selection systems** that never reconcile; registry resets on restart while the manager persists; the registry can represent states the manager cannot | **High** | full read + `switch_terminal` contains no registry reference |
| B-3 | **Shoonya declared not-implemented** despite 448 lines / 34 defs / 16-of-18 protocol coverage, on par with `dummy` which *is* declared implemented. Two tests enforce the contradiction | **Medium** | method-name diff vs `base.py`; `test_engine_registry.py:301-314` |
| B-4 | `get_market_data_status()` reports the global real-broker `ws_manager` even when `dummy` is selected; `dummy` capability record is itself inconsistent (`market_data=True, websocket=False`) | **Medium** | `:226-235`, `:80-91` |
| B-5 | `required_user_id()` returns hardcoded constants — no per-user identity for audit attribution | **Low** | `manager.py:126-132` |
| B-6 | Registry state is per-process; a multi-worker deployment would diverge silently | **Low** | `threading.RLock`, module singleton |

---

## 10. Not verified

- Whether any code path prefers the registry over the manager (needs call-site tracing)
- Whether `shoonya_adapter` methods actually function (names compared, bodies not read)
- Whether the deployment runs multiple workers
- Real broker connection state, login, order placement, and WebSocket behaviour
- `brokers/selection.py` and `brokers/capabilities.py` were **not read** in this pass

---

## Related
- `broker/BROKER_INTEGRATION_MAP.md`
- `security/AUTHENTICATION_AND_CONTROL_PLANE_EXPOSURE.md` — R-17 (unauthenticated broker selection)
- `ENGINE_CONTROL_API.md` — the two unauthenticated broker endpoints
- `PROJECT_RISKS.md` — R-39, R-40

---
*Static reading only. No broker login, no adapter call, no failover exercised.*
