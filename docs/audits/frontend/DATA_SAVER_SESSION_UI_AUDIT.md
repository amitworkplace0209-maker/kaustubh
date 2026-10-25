# DATA SAVER SESSION UI AUDIT

**What this document is:** the CURRENT state of the session surface in the Data Saver
workspace, as verified on 2026-10-14. It is an *audit*, not a specification.

- **Subject:** `docs/implementation/031-data-saver-subscription-manual-login.md`
- **Verified by:** `docs/verification/039-data-saver-subscription-manual-login.md`

---

## 1. The one authority

`docs/engines/session-manager.md` §41:

> Session Manager is the authoritative manager for: 1. Broker session lifecycle …

`GET /api/session/status` and `POST /api/login` both read/write **that** Session Manager.

There is a second, broker-specific session view — `kotak_session.session_info()`, published as
`system.pythonStatus` inside `/api/system/dashboard`. It is **correctly** "not logged in"
whenever the active terminal is `dummy` or `shoonya`, because in those modes there is no
Kotak broker session to have.

## 2. How each surface derives "session active"

| Surface | Source | Authority order |
|---|---|---|
| `POST /api/login` (backend) | `_login_impl()` → dummy adapter, or `do_login(source="manual")` | Session Manager |
| `GET /api/session/status` (backend) | Session Manager snapshot | Session Manager |
| `GET /api/phase2/dashboard` (Next proxy) | **Session Manager first**, Kotak view only as fallback | Session Manager ✅ |
| `useDataSaver().sessionActive` | `data.session.active` from the proxy | inherits the above |
| Topbar (`useSessionController`) | backend SSE session + terminal registry, backend-first terminal resolution | Session Manager |

## 3. Cache chain for a state change

A manual login is visible to the page after passing through three caches:

| Layer | Window | Bypass |
|---|---|---|
| Backend `/api/system/dashboard` | 15 s (`_DASHBOARD_TTL`, a deliberate Mongo-pressure guard) | none |
| Next proxy `app/api/phase2/dashboard` | 30 s TTL + 5 min stale-serve | `?refresh=1` |
| Client `lib/request-cache` | 12 s fresh / 30 s SWR | `CacheOptions.force` |

`useDataSaver().refresh()` bypasses the bottom two. The backend's 15 s window is the floor.
**Measured banner clear time after a manual login: 6.5 s** (warm run).

## 4. Manual Login on `/data-saver/subscription`

- Rendered only while `!sessionActive`, inside the orange banner.
- Calls `triggerLogin()` → `POST /api/login` (same-origin, via the `next.config.js` rewrite).
- Success requires `typeof res === 'object' && res.ok === true`; the backend's `message` is
  shown verbatim. A non-object response is treated as a **failure**, never a success.
- On success: clears the two page caches, calls `refresh()` (forces the workspace snapshot),
  and re-polls the subscription list after 2 s.

## 5. Known defects / limitations

| # | Issue | State |
|---|---|---|
| 1 | A rejected login shows the backend message, but the Kotak/Shoonya failure paths are unexercised in this environment (no broker session). | Open |
| 2 | Banner clear latency is bounded by the backend's 15 s dashboard cache. | By design; backend ownership |
| 3 | No automated test covers the session helpers' endpoints — `node --test` only, no component runner. `docs/opencode/007-data-saver-subscription-login-verify.mjs` is the regression guard. | Open |
| 4 | `docs/PROJECT_ASSUMPTIONS.md` A-11 ("Session Manager is the sole subscription authority") is still marked high-confidence but `VERIFICATION_MATRIX.md` item 24 marks it `NOT_VERIFIED`. | Pre-existing, untouched |

## 6. Change history

| Version | Date | Change | Agent |
|---|---|---|---|
| 1.0 | 2026-10-14 | Initial audit — session authority precedence corrected to Session Manager-first; manual login endpoints repaired | OpenCode |

## 7. Cross-references

- Implementation: `docs/implementation/031-data-saver-subscription-manual-login.md`
- Verification: `docs/verification/039-data-saver-subscription-manual-login.md`
- Session log: `docs/logs/LOG-013-2026-10-14-data-saver-subscription-login.md`
- Engine spec: `docs/engines/session-manager.md`
- Probe: `docs/opencode/007-data-saver-subscription-login-verify.mjs`