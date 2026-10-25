# 036 — Topbar Indicators, Next-Action Model, Market-Closed Login, Search Repair

Verification ID: 036
Date: 2026-10-14
Agent: OpenCode
Related Implementation: `docs/implementation/028-topbar-indicators-next-action-and-search-repair.md`

---

# Verification ID

036

# Date / Time

2026-10-14, 00:00–00:20 IST (server clock reported
`2026-10-14T00:00:44.476150+05:30` at the time of the run).

# Agent

OpenCode (automated agent).

# Task / Feature

028 — topbar indicator redesign with a backend-authoritative "what happens
next" model, market-closed Manual Login inside the SESSION indicator, session
auto-logout countdown, and universal-search repair.

# Expected Behavior

1. `schedulerTimeline` resolves the backend's real instants (`next_phase_at`,
   `next_login`, `next_logout`, `next_ws_start`, `next_ws_stop`) and never
   hardcodes a schedule time.
2. Each indicator exposes a `next` (and where meaningful an `after`) action with
   an absolute instant and a live countdown.
3. With the market closed and no session, the SESSION indicator renders a
   Manual Login button that calls the real endpoint.
4. With a live session, the countdown shows the real time until auto-logout.
5. No rendered text contains a duplicated `IST IST`.
6. Selecting a stock in the palette opens that stock's real detail panel.
7. The bar does not overflow horizontally at 390px.

# Verification Method

- static code inspection
- unit test (`node --test tests/topbar-status.test.ts`)
- full frontend test suite (`npm test`)
- type check (`npx tsc --noEmit`)
- lint (`npx eslint`)
- production build (`npm run build`)
- **live backend data** — the real `get_scheduler_info()` /
  `session_manager.snapshot()` payloads were fetched from the running Python
  service and pushed through the real model
- **live browser render** — the already-installed Chromium headless shell was
  driven over CDP; the real application code rendered in a real DOM

# Environment

- Frontend: Next.js 16 dev server on `127.0.0.1:3000` (already running)
- Backend: Python service on `127.0.0.1:8000` (already running, LIVE)
- Market: **CLOSED** — `market_status: CLOSED`, `market_session: CLOSED`,
  `day_class: NORMAL_MARKET_DAY`, `trading_day: true`
- Wall clock: **00:00 IST — past the 16:00 boundary**, i.e. exactly the state
  the user asked about
- Browser: chromium headless shell 1243, driven over CDP (no new npm dependency)
- Session/terminal: backend active terminal is `dummy`; the Kotak path was
  verified by intercepting only the SSE response (backend NOT mutated)

# Questions / Checks

1. Do the four indicators render, and do they render real state?
2. Does the hover tooltip state what happens next and when?
3. Does the scheduler indicator show a real next action, not a mangled field?
4. Does the MARKET indicator have data at all?
5. Is `IST IST` ever rendered?
6. Is a Manual Login button present when the market is closed and no session
   exists?
7. Does it stay absent in DUMMY (which has no broker session)?
8. Does selecting a stock in the palette reach a real symbol detail panel?
9. Does the bar overflow at 390px?
10. Are there console errors?
11. Did the existing suite regress?

# Expected Results

1. Four indicators present in both the desktop and PWA rows.
2. Tooltip shows `Next: <action> · <HH:MM:SS IST> · in <duration>`.
3. Scheduler next = a real phase or event with a real instant.
4. MARKET reflects the real calendar.
5. No `IST IST`.
6. Present on a real-broker terminal; absent in DUMMY.
7. Absent in DUMMY, with an explanatory note.
8. `/trading/market-watch` with the `Detail · <SYMBOL>` tab active.
9. `scrollWidth === innerWidth`, header not overflowing.
10. None.
11. No new failures.

# Actual Results

## Backend inputs actually observed (live)

```
server now (IST)      : 2026-10-14T00:00:44.476150+05:30
scheduler.state       : WAITING_FOR_LOGIN   running: true   phase: CLOSED
info.next_phase / at  : "readiness" / 2026-10-14T08:55:00+05:30
schedule.next_event   : login @ 2026-10-14T08:50:00+05:30
backend remaining_sec : 31755.9
session.status/active : DISCONNECTED / false
market (poll)         : CLOSED CLOSED  trading_day: true
backend terminal      : dummy
```

Note `next_phase` was empty earlier in the session (state
`WAITING_FOR_NEXT_TRADING_DAY`) and only `next_event` was present. That is the
exact case the model falls back for, and it was observed live, not assumed.

## Derived model (real snapshot through the real model)

```
canonical session   : INACTIVE
manual login needed : true
market gate closed  : true
market gate reason  : Market closed · the scheduled logout (16:00 IST) has
                      already run — broker login is manual.
configured logout   : 16:00 IST

Network    state=ONLINE           level=healthy
WebSocket  state=DISCONNECTED     level=error
           next : WebSocket connect · 08:55:00 IST · in 8h 54m
           after: WebSocket disconnect · 15:31:00 IST · in 15h 29m
Scheduler  state=RUNNING          level=healthy
           next : Broker login · 08:50:00 IST · in 8h 48m
           after: Broker logout · 16:00:00 IST · in 15h 58m
Session    state=INACTIVE         level=error
           next : Broker login · 08:50:00 IST · in 8h 48m
           after: Broker logout · 16:00:00 IST · in 15h 58m
Market     state=CLOSED           level=neutral
```

## Live DOM — hover tooltips (real render, real snapshot)

```
INTERNET  · ONLINE        Connected
           Next action not published by the backend
WEBSOCKET · DISCONNECTED  Disconnected
           Next: WebSocket connect · 08:55:00 IST · in 8h 44m
           Then: WebSocket disconnect · 15:31:00 IST · in 15h 20m
SCHEDULER · RUNNING       State: WAITING_FOR_LOGIN
           Next: Broker login · 08:50:00 IST · in 8h 39m
           Then: Broker logout · 16:00:00 IST · in 15h 49m
SESSION   · INACTIVE      No active session
           Next: Broker login · 08:50:00 IST · in 8h 39m
           Then: Broker logout · 16:00:00 IST · in 15h 49m
           Market closed · the scheduled logout (16:00 IST) has already run
           — broker login is manual.
           Click for full diagnostics · or log in now
```

## Live DOM — SESSION panel (click), real-broker terminal

```
SESSION  INACTIVE
Next: Broker login · 08:50:00 IST · in 8h 38m
Then: Broker logout · 16:00:00 IST · in 15h 48m
Market closed · the scheduled logout (16:00 IST) has already run — broker
login is manual.
Broker              Kotak Neo
State               DISCONNECTED
Lifecycle           NO_SESSION
Login time          —
Validated at        —
Expires at          —
Broker feed         DISCONNECTED
Next scheduled login 08:50:00 IST (08:50)
Scheduled logout     16:00:00 IST (16:00)
[ Manual Login ]  <- present
Open details
```

Manual Login buttons found in the DOM: 3 (inline in the desktop SESSION pill,
inline in the PWA SESSION pill, and the right-cluster button). Each labelled
`Manual Login — KOTAK NEO`.

## Live DOM — search flow

```
palette has instruments : true
after select -> {
  path              : "/trading/market-watch",
  hasQueryParam     : false,
  pendingHandoffLeft: null,
  bodyMentionsSymbol: true,
  activeTab         : "Detail · TCS-EQ",
  tabs              : [Stocks (15), Movers, Scan all, Gainers (0), Losers (0),
                       Pins (0), Detail · TCS-EQ]
}
```

The selection opened the real symbol detail panel, and the handoff was consumed
and cleared (`pendingHandoffLeft: null`).

## Live DOM — PWA 390×844

```
overflow check: {"docScrollW":390,"innerW":390,"headerOverflows":false}
istIst: false
```

## Console

```
(none)
```

# Evidence

```
Command: npx tsc --noEmit
Expected: exit 0
Actual: exit 0
Status: PASS

Command: npx eslint components/layout components/ui lib/topbar-status.ts \
                  lib/pending-symbol.ts components/market-watch \
                  tests/topbar-status.test.ts
Expected: 0 errors, 0 warnings
Actual: exit 0, no output
Status: PASS

Command: npm test
Expected: no regressions vs baseline 400/397/3
Actual: tests 418 | pass 415 | fail 3
Status: PASS (the 3 failures are the pre-existing trade-quote-fallback cases)

Command: npm run build
Expected: Compiled successfully
Actual: ✓ Compiled successfully in 6.0s
Status: PASS

Command: live backend probes (:8000/api/system/time, /api/system/scheduler,
         /api/system/market, /api/system/session, /api/websocket/system/status)
Expected: real market/session/scheduler values
Actual: as quoted above
Status: PASS

Command: live browser render over CDP (1440x900 and 390x844)
Expected: indicators, tooltips, panel, login button, no overflow
Actual: as quoted above
Status: PASS
```

# Problems Found

1. **`IST IST` duplication.** `fmtISTClock()` already returns `IST`; the new
   next-action line appended it again. Visible only in a real render.
   FIXED — `fmtNextAt()` is documented as already carrying the suffix and the
   view no longer appends it. Verified: `istIst: false`.

2. **MARKET indicator permanently UNKNOWN.** The SSE `state_snapshot` has no
   `market` key (confirmed by listing the live snapshot keys: `type,
   timestamp, appConnection, session, terminal, terminalBroker, scheduler,
   websocket, database, internet, services, notifications, metrics`). Verified
   live before the fix: `market: undefined` in the snapshot.
   FIXED — `useStatusState` now falls back to the existing
   `SystemProvider.market` poll. Verified live after the fix:
   `Market state=CLOSED level=neutral`.

3. **Scheduler showed healthy-green at 23:59.** The backend genuinely reports
   `running: true` with `WAITING_FOR_NEXT_TRADING_DAY`.
   FIXED — idle-by-design states now render `neutral` with the real state
   string. `WAITING_FOR_LOGIN` deliberately stays healthy: on a normal trading
   day waiting for the 08:50 login window IS the healthy expected path.

4. **Session indicator was inert in DUMMY.** Red INACTIVE pill, no action, no
   explanation. FIXED — it now explains itself
   ("Simulated terminal — the dummy engine has no broker session") and still
   never renders a broker login.

5. **`marketLoginGate` "already run" branch was unreachable.** `next_logout`
   rolls to the next trading day once today's logout runs, so comparing against
   it reported "logout at 16:00 IST (in 23h 40m)" at 16:20.
   FIXED — the wording branch is driven by the backend's own market-session
   bucket (`CLOSED` ⇒ the 16:00 boundary has passed), which is exactly what
   `market_calendar.py`'s `POST_CLOSE_TIME = 16:00` encodes. Covered by a
   regression test.

6. **Test-fixture bug found by the suite** (mine, not the product): a fixture
   omitted `is_trading_day`, and the model correctly produced no `Trading day`
   row rather than guessing. The fixture was corrected, not the model.

7. **SSE buffering (PRE-EXISTING, NOT FIXED).** `GET
   /api/websocket/system/stream` through the Next origin returns HTTP 200 but
   delivers no frames; the page therefore never hydrates and all indicators sit
   at `CHECKING`. Confirmed by request tracing: the stream request was made and
   answered 200, `/api/websocket/system/status` was never requested (the
   15s fallback only runs while disconnected), and there were zero network
   failures. This is why the hydrated verification required intercepting that
   one request. The indicators degrade honestly (amber "check in progress",
   never a fabricated green), so this is a degraded-experience issue, not a
   correctness one.

# Fixes Applied

1. `fmtNextAt()` documented as already suffixed; the tooltip/panel no longer append `IST`.
2. `useStatusState` sources the market calendar from `SystemProvider.market`, preferring realtime when present.
3. `IDLE_BY_DESIGN` states render `neutral` with their real state string.
4. DUMMY SESSION indicator explains why it has no action.
5. `marketLoginGate` wording branch driven by `market_session`, not by comparing against `next_logout`.
6. Test fixture corrected to supply `is_trading_day`.

# Re-verification

After every fix the live backend snapshot was re-pushed through the model and
the browser was re-rendered:

```
Market     state=CLOSED           level=neutral     <- was UNKNOWN
istIst     : false                                     <- was true
sess inline: "Manual Login — KOTAK NEO"                 <- was null
gate reason: "...the scheduled logout (16:00 IST) has already run..."
```

and the full suite was re-run: `tests 418 | pass 415 | fail 3`.

# Final Result

PARTIAL

Proven against the LIVE backend and a LIVE browser render:

- the next-action model, timeline resolution and every branch of the
  market-closed gate, using real scheduler/session/market payloads
- all four indicators rendering real state
- the hover tooltip and the diagnostics panel, with real next/after actions,
  real IST instants and live countdowns
- the Manual Login affordance inside the SESSION indicator, market closed,
  real-broker terminal
- the countdown and login button correctly ABSENT in DUMMY
- the search fix, end to end, opening the real `Detail · TCS-EQ` panel
- PWA layout at 390px with no horizontal overflow
- no console errors, no `IST IST`
- type check, lint, build, and no test regressions

NOT proven:

- hydration through the real SSE stream (frames are buffered in this
  environment — problem 7 above; pre-existing and out of scope)
- an actual `POST /api/auth/manual-login` from the button (that would start a
  real broker login; not performed)
- an active-session countdown to logout (no session exists to log into without
  performing a real broker login; the countdown path is covered by the existing
  `SessionSyncProvider` logic and by unit tests on `nextSessionAction`)

# Remaining Risks

1. **SSE buffering** means the topbar may sit at `CHECKING` in any environment
   where the stream is buffered. It is honest (amber, explicit unknown) but the
   indicators carry no information until a frame lands.
2. **`IDLE_BY_DESIGN` is a maintained list.** A new idle-by-design scheduler
   state added later would fall back to healthy-green until it is added.
3. **The `next`-prefers-`phase` rule** assumes the backend keeps phases as the
   fuller description. If `next_event` ever grows to include square_off/feed_stop
   the rule stays correct but the label set would need extending.
4. **The handoff store is single-shot.** If Market Watch is not mounted when the
   handoff is made, the pick is dropped (it is cleared only on consumption, but
   it also expires after 2 minutes).
5. **No regression test exists for `lib/pending-symbol.ts`.** The store is
   storage-backed and was verified in a live browser instead; a unit test would
   need a `sessionStorage` seam.