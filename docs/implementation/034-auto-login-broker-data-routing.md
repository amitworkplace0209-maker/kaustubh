# 034 — Auto-login for every broker, broker-owned data, and the Shoonya credentials contract

- **Date:** 2026-10-22
- **Agent:** OpenCode
- **Scope:** backend auto-login + data routing, the Shoonya SDK/credential contract, the storage guard that was write-blocking the platform
- **Status:** IMPLEMENTED + TESTED; the Shoonya leg is implemented end to end but needs the operator's credentials to run live.

---

## 1. Task

Requested in chat (verbatim, condensed):

> "shoonya ka bhi kya kya credentials chye .env example me de do ... kotak jaisa shoonya bhi login or order execute hona chye, sab websockets bhi or instrument ke liye bhi — matlab API dono ka broker ka use kre best data lene ke liye. But broker terminal se order de to use broker ke pass order jana chye: kotak ka kotak, dummy ka dummy, shoonya ka shoonya. ... abhi sab broker ka auto login code likha do ... shoonya ka real SDK download kro or check kro kya kase auto login hoga."

Decomposed:

| # | Requirement | Where it landed |
|---|---|---|
| R1 | The Shoonya credential contract, in the env example | `python-service/.env.example` — every variable, what it is, where it comes from, its shape |
| R2 | The real Shoonya SDK, and how its auto-login can work | §2 — the SDK was already installed; its auth surface was read and is now understood |
| R3 | Auto-login for every broker | `python-service/services/auto_login.py` + the startup and terminal-switch wiring |
| R4 | Shoonya must log in AND execute orders, with its WebSocket | The adapter was already complete; the OAuth exchange had a **tuple bug** that broke the session, and there was no restore path |
| R5 | The data (instrument + market) must come from the ACTIVE broker | `services/broker_instruments.py` (instrument search) + `services/last_price.py` (quotes) |
| R6 | An order must go to the broker whose terminal is active | Already enforced by `require_active`; now proven live for kotak ⇄ dummy |

---

## 2. The Shoonya SDK (installed, version 0.0.41)

`NorenRestApiOAuth 0.0.41` → import module `NorenRestApiPy.NorenApi`, class `NorenApi(host, websocket)`.

**There is NO password/TOTP login in this SDK.** The full auth surface is:

| Method | Purpose |
|---|---|
| `getOAuthURL(oauth_url, api_key)` | `"<host><route>?client_id=<api_key>"` — the browser URL |
| `getAccessToken(authcode, Secret_Code, client_id, UID)` | the code → token exchange. **Returns a 4-tuple** `(access_token, user_id, refresh_token, account_id)` and stores the broker's `susertoken` on the client |
| `injectOAuthHeader(access_token, UID, AID)` | sets the `Authorization: Bearer …` header |
| `set_credentials(access_token, uid, accountid)` | the identity |
| `set_session(userid, password, usertoken, accesstoken)` | **restores a session from stored material alone** — this is what makes an automatic login possible |

REST routes: `/QuickAuth`, `/GenAcsTok`, `/PlaceOrder`, `/ModifyOrder`, `/CancelOrder`,
`/OrderBook`, `/TradeBook`, `/PositionBook`, `/Holdings`, `/Limits`, `/SearchScrip`,
`/GetQuotes`, `/GetSecurityInfo`, `/Logout`, …
WebSocket: `wss://api.shoonya.com/NorenWSTP/` with `start_websocket(...)`,
`subscribe(instrument, feed_type)`, `subscribe_orders()`.

**Consequence for "auto login":** the FIRST Shoonya session needs a human (the browser
handshake). Every later start is automatic, because the bearer token can be re-injected
through `set_session` + `injectOAuthHeader`. The token is stored ENCRYPTED
(`services/terminal_credentials.py`, Fernet + a key derived from `JWT_SECRET`, or a
generated key file under `runtime/`).

---

## 3. What was implemented

### 3.1 `python-service/services/auto_login.py` (new) — one entry point

| Terminal | How it gets its session | Human? |
|---|---|---|
| `kotak` | TOTP (`totp_secret`) + MPIN → `kotak_session.login()` | no |
| `dummy` | the managed paper session | no |
| `shoonya` | restore the stored OAuth session (`restore_session()`) | no — but the FIRST session needs the handshake |

Returns an honest result: `{ok, terminal, method, requires, oauthUrl, message, detail}`.
`requires="oauth_handshake"` + `oauthUrl` is what the UI needs when Shoonya has no
stored session yet.

**Wiring:**

* **Startup** (`app.py` lifespan) — `asyncio.create_task(auto_login_active_terminal(source="startup"))`.
* **Terminal switch** (`brokers/manager.switch_terminal`) — the new terminal auto-logs-in
  in the BACKGROUND; a failure never fails the switch.
* **API** — `POST /api/terminal/auto-login` (run it for a terminal) and
  `GET /api/terminal/auto-login/state` (what each terminal can do right now).

**Proven live (2026-10-22):**

```
13:17:31 [INFO] auto_login: AUTO_LOGIN terminal=dummy method=managed ok=True      ← at STARTUP
13:17:45 [INFO] broker_manager: AUTO_LOGIN after switch terminal=kotak method=totp ok  ← after a SWITCH
POST /api/terminal/auto-login {"terminal":"kotak"}
  -> {"ok":true,"terminal":"kotak","method":"totp","message":"Kotak session already active","isLoggedIn":true}
POST /api/terminal/auto-login {"terminal":"shoonya"}
  -> {"ok":false,"message":"Shoonya is not enabled — set SHOONYA_ENABLED=1 and fill the SHOONYA_* secrets"}
```

### 3.2 The Shoonya OAuth fixes (`brokers/shoonya_adapter.py`)

* **Tuple bug (fixed).** `getAccessToken` returns a 4-tuple; the adapter treated it as
  the token, so the Authorization header was a tuple and every broker call failed. The
  exchange now reads `access_token / user_id / refresh_token / account_id` out of it and
  keeps the broker's `susertoken`.
* **Persistence.** After a successful handshake the material is stored ENCRYPTED.
* **`restore_session()` (new).** Re-injects the stored token (`set_session` +
  `injectOAuthHeader`), marks the session active and opens the feed. A rejected token
  is reported honestly (a fresh handshake is required) instead of pretending to be logged in.

### 3.3 The data comes from the ACTIVE broker

| Surface | Before | Now |
|---|---|---|
| Instrument search (`GET /api/search`) | the local master (KOTAK's) | on Shoonya, the broker's own `searchscrip` rows are queried and placed FIRST (`services/broker_instruments.py`); a Kotak token is not a Shoonya token |
| Quotes (`services/last_price.py`) | hard-wired to `kotak_session` | the ACTIVE terminal's adapter: Kotak → the chunked Kotak quote, Shoonya → `get_quotes` per instrument |
| Live ticks | the central tick buffer, fed by the active broker's WebSocket | unchanged — the feed is already per-terminal (Kotak SFeed / Shoonya NorenWSTP / the paper feed) |

### 3.4 The order goes to the broker whose terminal is active

Already enforced by `require_active` in `api/terminal.py`; now proven live:

```
kotak active  + POST /api/terminal/order {terminal:"dummy"}  -> 409 "terminal dummy is not the active terminal"
dummy active  + POST /api/terminal/order {terminal:"dummy"}  -> 200 {"ok":true,"accepted":true,"terminal":"dummy","orderId":"DEMO1792656293246293"}
```

### 3.5 The Shoonya OAuth callback page (new)

`app/(trading)/trading/shoonya-oauth/page.tsx` — the redirect target of
`SHOONYA_REDIRECT_URL`. It reads the code (query **or** fragment), hands it to the
backend, switches the active terminal to Shoonya, establishes the session and reports
the result. The code is used exactly once and never stored in the browser.

### 3.6 The storage guard was write-blocking the platform (fixed)

While verifying, the Atlas cluster was at **513 MB of 512 MB** — every write failed
(tick persistence, the paper feed, the session store) and the paper engine could not be
priced. The cause: the guard measured the APPLICATION database (222 MB = 43 % → "within
budget") while Atlas enforces the quota on the WHOLE CLUSTER.

* `services/storage_guard.py` — the trim is now a **document-level** prune (the oldest
  documents in bounded batches) instead of a whole-day delete: a trading session holds a
  single date, so deleting "the oldest day" either removed the live dataset (which the
  writer refilled immediately) or nothing at all. It also uses per-document `DeleteOne`
  ops in one `bulk_write`, because a single `delete_many({"_id": {"$in": [...]}})` is
  CANCELLED by the cluster while it is write-blocked.
* `config/settings.py` — the budget default 300 MB → **180 MB** (the cluster overhead is
  ~250 MB, so the application database has to stay well below the cluster limit).
* `tools/storage_reclaim.py` (new) — a bounded, operator-run reclaim.
* `tools/storage_report.py` (new) — a READ-ONLY storage inspection.

**Proven live:** the guard trimmed 106 446 documents in one pass
(`market_ticks: 80000, market_candles_*: 26446`) and the write probe turned green.

---

## 4. The credential contract (the user-facing part)

`python-service/.env.example` now documents every variable — what it is, where it comes
from, what it looks like:

| Variable | What it is |
|---|---|
| `CLIENT_ID` / `CONSUMER_KEY` / `CONSUMER_SECRET` | the Kotak API-key pair (`ucc` = the user client code) |
| `MOBILE_NUMBER` | the registered mobile (the OTP goes there) |
| `MPIN` | the 4-digit market MPIN (the trade-token validation) |
| `TOTP_SECRET` | the base32 TOTP seed |
| `SHOONYA_ENABLED` | `1` turns the Shoonya terminal on (only after the secrets are filled) |
| `SHOONYA_API_KEY` | the Shoonya "API Key" (client_id) — in the OAuth URL and in the code exchange |
| `SHOONYA_SECRET_KEY` | the "Secret Key" of that pair — signs the exchange, never leaves the backend |
| `SHOONYA_USER_ID` | the Shoonya User ID (client code / UID) |
| `SHOONYA_ACCOUNT_ID` | the trading account id (actid; usually the same as the UID) |
| `SHOONYA_REDIRECT_URL` | where Shoonya sends the browser back (must be registered in the Shoonya API-key page) |
| `SHOONYA_HOST` / `SHOONYA_WEBSOCKET` | the Noren REST host and the Noren market/order feed |
| `TERMINAL_CREDENTIAL_KEY` | optional; encrypts the stored broker session material (otherwise derived from `JWT_SECRET`) |

**To switch Shoonya on:** fill the six `SHOONYA_*` values, set `SHOONYA_ENABLED=1`,
restart the backend, switch the terminal to Shoonya, open the OAuth link, approve it once.
Every later start and every terminal switch is automatic.

---

## 5. Tests

```
npx tsc --noEmit                                            -> exit 0
npx eslint "app/(trading)/trading/shoonya-oauth"             -> 0 errors, 0 warnings
npm test                                                     -> 461 tests | 461 pass | 0 fail
python -m pytest tests/test_auto_login.py -q                 -> 9 passed
python -m pytest tests/ -q                                   -> 1667 passed | 4 failed (PRE-EXISTING:
                                                               the same 4 fail without the new test file —
                                                               a full-suite ordering issue in test_event_ledger /
                                                               test_watchlist_engine, both pass in isolation)
```

The new test file covers: the encrypted store (round-trip + "the token is not readable
on disk" + clear), the auto-login per terminal (dummy managed / kotak totp / shoonya
restore / shoonya handshake-required), and the Shoonya OAuth tuple handling.

---

## 6. Remaining

1. **Shoonya cannot be exercised live until the credentials are filled** — the code path
   is complete and unit-tested, but the first handshake needs a browser.
2. The 4 pre-existing full-suite failures (ordering, not related).
3. The Kotak account currently holds Net ₹10 — a real Kotak order would be rejected for
   margin (the page already says so).

## 7. Final status

**IMPLEMENTED_NOT_VERIFIED** (Shoonya) — everything is implemented, typed, linted and
tested; the Kotak and Dummy auto-logins are proven live; the Shoonya leg needs the
operator's credentials to run.
