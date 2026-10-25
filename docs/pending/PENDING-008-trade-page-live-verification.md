# PENDING-008-trade-page-live-verification.md

## Task ID

PENDING-008

## Date Created

2026-10-21

## Priority

**P1 — HIGH** (the implementation is done and machine-verified; what is left can only be
closed with a physical handset, a live broker account and a production build)

## Title

Live verification runbook for the rebuilt `/trading/trade` page (physical-device swipe,
an accepted broker order, the production build, the PWA on a phone)

## Status

`PARTIAL` — the book was executed on 2026-10-22; V3, V4 (network level) and V5 are
**closed**, V1 is closed for the gesture mechanics but not for the handset feel, and V2 /
V6 need an operator step. Evidence:
`docs/verification/042-trade-page-live-verification.md`.

| # | Item | Result after the 2026-10-22 run |
|---|---|---|
| V1 | Physical-device swipe feel | **PARTIAL PASS** — the mechanics are proven with real touch events (spring-back below the commit line, commit above it, no order on the short drag). The *feel* on a handset still needs a device. |
| V2 | An accepted Kotak order | **NOT SENT** — routing + payload proven (request intercepted + aborted). A real order needs the operator's written authorization, and the broker account currently holds **Net ₹10** (the page already says "Not enough available margin"). |
| V3 | Production build | **PASS** — `next build` compiled (10.9 s), TypeScript clean, `/trading/trade` emitted, no route collision. |
| V4 | The PWA on a phone | **PASS at the network level** — the page, the APIs and the SSE tick stream all answer on the host's LAN address. The install + on-screen check still needs a handset. |
| V5 | CASH vs MIS charges | **PASS** — CASH uses the delivery STT (0.1 %), MIS the intraday STT (0 % on a buy). |
| V6 | The Shoonya route | **BLOCKED** — the broker is disabled in this environment. |

The run also uncovered and FIXED two infrastructure defects that made every live
verification flaky (the dying listener → `docs/pending/PENDING-007-backend-listener-loss.md`
· the full Atlas cluster → `docs/pending/PENDING-008` §4.2 of the verification record),
and one page-level defect (the first search after a cold backend restart).

## Source

- Implementation: `docs/implementation/033-trade-page-full-rebuild.md`
- Verification: `docs/verification/041-trade-page-full-rebuild.md`
- Audit: `docs/audits/frontend/TRADE_PAGE_UI_AUDIT.md`
- Working files + probes: `docs/opencode/008-trade-page-rebuild/`
- Parent pending: `docs/pending/PENDING-005-trade-page-remaining-verification.md`

---

## 1. Context

The trade page was deleted and rebuilt from zero on 2026-10-21, and the two backend
defects that made it dead were fixed (every paper order used to answer HTTP 500, and the
page's own risk pre-check used to make the following real order a "duplicate").

**Already proven on a real browser (do NOT redo):** the page renders, the price is live
from the shared SSE tick stream, the risk verdict is the server's, the payload is correct
for both terminals, a paper order placed **from the page** filled
(`id DEMO1792576469294469`), and the mobile geometry is correct (order bar `bottom 780` vs
bottom nav `top 779`, no horizontal overflow). See
`docs/verification/041-trade-page-full-rebuild.md`.

**What is still unproven** is only what needs a handset, a funded broker account or a
production build. This file is the runbook for that work — follow it top to bottom and
the page can be closed as fully verified.

---

## 2. Environment preflight (do this FIRST — it is where time gets lost)

The backend on this host intermittently loses its HTTP listener: the asyncio accept loop
dies with `WinError 64` (`Accept failed on a socket`) and the process stays alive without
accepting connections. Every page then answers `500 / 502 Bad Gateway`. The root cause is
recorded in `docs/pending/PENDING-007-backend-listener-loss.md`.

**Check (10 s):**

```powershell
curl.exe -s -m 10 -o NUL -w "%{http_code}`n" http://127.0.0.1:8000/health
```

- `200` → the backend is alive; continue.
- `000` → the listener is dead. Start the watchdog; it kills the dead instance and
  launches a healthy one (a cold start takes **~100-140 s** — wait, do not kill it early):

```powershell
cd C:\project\python-service
Start-Process -FilePath "C:\project\.venv\Scripts\python.exe" -ArgumentList "watchdog_backend.py" `
  -WorkingDirectory "C:\project\python-service" `
  -RedirectStandardOutput "C:\project\logs\watchdog_live.log" `
  -RedirectStandardError  "C:\project\logs\watchdog_live.err.log" -WindowStyle Hidden
```

  Then poll until `200` (up to 3 minutes) and **leave the watchdog running** for the rest
  of the session — it is the only thing that heals this host.

**Broker session (the market-data feed):**

```powershell
curl.exe -s -m 90 -X POST http://127.0.0.1:3000/api/auth/manual-login
curl.exe -s -m 20 http://127.0.0.1:3000/api/terminal/state
```

`Login successful` is expected; the response body is never shown to the browser (the TOTP
secret stays on the backend). After a backend restart the Kotak Neo session is gone and
must be re-established with this call.

**Live feed (must be non-zero before any price-dependent check):**

```powershell
curl.exe -s -m 20 http://127.0.0.1:3000/api/system/market
```

`reason_code = LIVE_TICKS_RECEIVED` and `ticks_in_window > 0` is the pass condition.
`WEBSOCKET_ERROR` / `0` means the broker feed is not running — re-login and re-check.

**Active terminal (the backend refuses an order for any terminal that is not active):**

```powershell
curl.exe -s -m 20 http://127.0.0.1:3000/api/terminal/state
curl.exe -s -m 20 http://127.0.0.1:3000/api/terminal/list
```

Switch (the Mode Lock is currently OFF, so this needs no unlock token):

```powershell
Set-Content -Path "$env:TEMP\switch.json" -Value '{"mode":"kotak"}' -NoNewline
curl.exe -s -m 60 -X POST -H "Content-Type: application/json" --data-binary "@$env:TEMP\switch.json" `
  http://127.0.0.1:3000/api/terminal/switch
```

**Always record the terminal before you start and restore it afterwards** (see the restore
procedure, section 9).

---

## 3. V1 — Physical-device swipe-to-confirm feel (NOT_VERIFIED)

**What is unproven:** the damping, the velocity curve and the commit haptic of the NEW
control `components/trading/order-actions.tsx` (the old `slide-to-order.tsx` was deleted).
It has only been exercised through headless touch emulation.

**Why it matters:** on a touch build this IS the confirmation gesture — if it is wrong, an
operator can accidentally or cannot place an order.

**How to close it (needs a real handset):**

1. Put the phone and the host on the same LAN. The page must be opened at the **host's
   LAN address** (e.g. `http://192.168.x.x:3000/trading/trade`), NOT at `127.0.0.1`
   (`127.0.0.1` on a phone is the phone itself).
2. Install the PWA (browser → "Add to Home screen") and open it from the icon.
3. Terminal = Dummy. Search and select a liquid instrument (e.g. RELIANCE).
4. Confirm the confirm setting is ON: `Settings → confirm buy/sell`.
5. Drag the knob **slowly** across the whole track.
   - Expected: the knob follows the finger 1:1, springs back when released before the
     commit line, and fires only past ~82 %.
6. Drag past the commit line and release quickly.
   - Expected: it commits, the order reaches the dummy engine, and the result panel shows
     `Filled` / `Working`.
7. Press `Escape` mid-drag, and rotate the device mid-drag.
   - Expected: the knob snaps back and never ends up off-track.
8. Repeat with a **mouse** on the desktop build.
   - Expected: no slider — a plain BUY/SELL button that opens the review dialog.

**Tuning knobs:** `COMMIT_RATIO` (currently `0.82`) and the snap-back timings in
`components/trading/order-actions.tsx`.

**Evidence to capture:** a screen recording of the drag (slow + fast), the result panel
after the commit, and a screenshot of the desktop build showing the button instead of the
slider.

**Result:** `PASS` / `FAIL (tuned)` + the tuning commit, if any.

---

## 4. V2 — An accepted Kotak Neo order, end to end (NOT_VERIFIED)

> ### ⚠ THIS PLACES A REAL ORDER WITH REAL MONEY.
> It needs the **operator's explicit go-ahead** for the exact quantity and side before
> anything is sent. Everything up to (and including) the request capture in §4.2 is safe
> and needs no authorization.

### 4.1 What is already proven (no need to redo)

- The routing: in Kotak mode the page sends `POST /api/terminal/order` with
  `{"terminal":"kotak","order":{…}}` — captured in
  `docs/verification/041-trade-page-full-rebuild.md` §4.1.
- The payload shape (exchange / token / symbol / transaction_type / product / order_type /
  quantity / price / trigger_price / validity / disclosed_quantity / expected_ltp).
- The **risk verdict** and the **margin preview** for a real terminal.

### 4.2 The capture (safe — nothing is sent)

```powershell
# 1) chrome with remote debugging
"C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new `
  --remote-debugging-port=9333 --user-data-dir=<temp> about:blank

# 2) get a session cookie
$s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$null = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/auth/login" -Method POST `
  -ContentType "application/json" -Body '{"direct":true}' -WebSession $s -UseBasicParsing
$c = ($s.Cookies.GetCookies('http://127.0.0.1:3000')['kaustubh_session']).Value

# 3) drive the page — EVERY order request is intercepted and aborted by default
node docs\opencode\008-trade-page-rebuild\trade-page-verify.mjs 9333 $c `
  "http://127.0.0.1:3000/trading/trade"
```

Expected: `orderRequests` contains the Kotak payload, `badResponses` is empty, and the
page shows `Order not placed — Failed to fetch` (the aborted request).

### 4.3 The real order (needs authorization)

1. **Pre-conditions:** the backend is on `kotak` (active), the broker session is live
   (`manual-login` → `Login successful`), the feed is `LIVE_TICKS_RECEIVED`, and the
   market is open.
2. **Authorization:** the operator states the instrument, the side, the quantity and the
   product in writing before it is sent. Recommended minimum risk: **1 share, MIS,
   MARKET** on a liquid NSE stock, during market hours.
3. **Send it** from the page (not from curl) so the whole UI path is exercised:
   search → select → BUY → review dialog → Confirm.
4. **Expected:** the result panel shows the broker's own status —
   `Filled` (with qty + average price) or `Working` (with the order id and the price it
   waits for). The order must appear in `GET /api/terminal/orders/kotak` and in
   `docs/…/order-history` on the frontend.
5. **Cancel it if it rests** (a resting order is live exposure):
   `POST /api/terminal/order/cancel` with `{"terminal":"kotak","order_id":"<id>"}`, or
   cancel it from the Orders page.
6. **Record:** the broker order id, the status, the fill price and the time — in the
   verification record.

**Result:** `PASS` (accepted by the broker) / `BLOCKED` (no session, market closed, or
the risk engine locked the order — record the exact server reason).

---

## 5. V3 — Production build (delegated to `PENDING-002`, but the trade page must be in it)

**What is unproven:** `npm run build` was not run for the rebuilt page, because the
operator's `next dev` owns the same `.next` directory.

**How to close it:**

```powershell
# 1) stop the dev server first (it shares .next with the build)
#    (Ctrl-C in the dev-server terminal, or: Get-Process node | Stop-Process)

# 2) build
cd C:\project
npm run build

# 3) confirm the route is emitted with no collision
#    (look for "/trading/trade" in the build output)

# 4) restart the dev server
npm run dev
```

**Expected:** the build compiles, `/trading/trade` is emitted, and there is NO route
collision (the previous page lived in `app/_pages/`, which is not routable — the new page
is `app/(trading)/trading/trade/page.tsx`).

**Also run (the baseline must not regress):**

```powershell
npx tsc --noEmit
npm run lint
npm test                                  # expected: 461 tests | 461 pass | 0 fail
cd C:\project\python-service
C:\project\.venv\Scripts\python.exe -m pytest tests/test_demo_order_intent.py `
  tests/test_common_trading_core.py -q # expected: 57 passed
```

**Evidence to capture:** the build output (or the exact error), the emitted route list, and
the test counts.

---

## 6. V4 — The PWA on a phone (the real target device)

**What is unproven:** that the live price actually streams on a phone. The page's live
source is the **shared SSE tick channel** (`/api/ticks/stream`), which is same-origin and
therefore LAN-safe — but the WebSocket (`/ws/realtime`) is NOT usable from the browser
(Next.js cannot proxy the upgrade; see the implementation record §6 P3).

**How to close it:**

1. Open the page on the phone at the host's LAN address and install the PWA.
2. Select an instrument and confirm the price **moves on its own** (no refresh).
3. Confirm the header's source line says `LIVE TICK STREAM` (not `tick store snapshot`
   and not `search snapshot`).
4. Check the Network panel / the server log: the phone must be consuming
   `GET /api/ticks/stream` over the LAN — and it must NOT be trying
   `ws://<host>/ws/realtime`.
5. Walk one full order on the phone in Dummy mode (slide to confirm) — the result panel
   must match what the desktop shows.

**Result:** `PASS` / `FAIL` + the exact network trace if it fails.

---

## 7. V5 — The charge estimate for a CASH order (cheap, desktop only)

**What is unproven:** `lib/charge-engine.ts` maps every product except CNC/CO/MARGIN to
the **intraday** equity segment, while this platform treats **CASH as full-payment
delivery** (margin factor 1.0, it settles into holdings). The trade page maps CASH onto
the engine's delivery vocabulary locally; the shared engine was left alone because it
drives historical charge snapshots.

**How to close it (read-only):**

1. Open `/trading/trade` on the Dummy terminal, select an instrument, set
   `PRODUCT = CASH`, quantity 1.
2. Open the **Charges** tab.
3. Compare the STT rate with the same order under `PRODUCT = MIS`.
   - Expected: CASH must show the **delivery** STT (0.1 %, both sides) and MIS the
     **intraday** STT (0.025 %, sell side only).
4. If the two are identical, the product mapping in
   `components/trading/charges-panel.tsx` is wrong — fix it there (do NOT change the
   shared engine without a separate decision about historical snapshots).

**Result:** `PASS` / `FAIL` + the two breakdowns.

---

## 8. V6 — The Shoonya route (BLOCKED in this environment)

**What is unproven:** the page's Shoonya path. `GET /api/terminal/list` currently reports
`shoonya: enabled=false, isLoggedIn=false`, so the backend cannot accept a Shoonya order
at all.

**How to close it:** enable the broker, run the Shoonya OAuth login
(`GET /api/terminal/oauth-link` → the browser → `POST /api/terminal/oauth-code`), switch
the active terminal to `shoonya`, and repeat §4.2 (the capture is safe; a real Shoonya
order needs the same authorization as §4.3).

**Result:** `BLOCKED` (broker not enabled) unless the operator enables it.

---

## 9. Restore procedure (ALWAYS run this at the end)

```powershell
# 1) put the active terminal back to the state it had before the session
Set-Content -Path "$env:TEMP\switch.json" -Value '{"mode":"dummy"}' -NoNewline
curl.exe -s -m 60 -X POST -H "Content-Type: application/json" --data-binary "@$env:TEMP\switch.json" `
  http://127.0.0.1:3000/api/terminal/switch

# 2) confirm
curl.exe -s -m 20 http://127.0.0.1:3000/api/terminal/state
curl.exe -s -m 10 -o NUL -w "%{http_code}`n" http://127.0.0.1:8000/health

# 3) cancel any order that is still resting (a resting order is live exposure)
curl.exe -s -m 20 http://127.0.0.1:3000/api/terminal/orders/kotak
```

Leave the **watchdog running** — it is what keeps this host's backend alive.

---

## 10. Success criteria

- [ ] V1 — the slide gesture behaves correctly on a real handset (or the tuning is
      recorded and committed)
- [ ] V2 — a broker order was accepted, with the broker order id, status and fill price
      recorded (or the exact server-side blocker recorded)
- [ ] V3 — `npm run build` succeeds and emits `/trading/trade`; type-check, lint and both
      test suites are at or above the baseline
- [ ] V4 — the PWA on the phone shows a streaming price from the SSE channel
- [ ] V5 — the CASH charge estimate uses the delivery segment
- [ ] V6 — Shoonya: verified, or recorded as blocked with the reason
- [ ] The terminal, the broker session and the backend are restored to the pre-session
      state

---

## 11. Deliverable

**DONE (2026-10-22):** `docs/verification/042-trade-page-live-verification.md` (the
verification record with every command, expected result and actual result) and
`docs/logs/LOG-015-20261022-trade-page-live-verification.md` (the session log).

Still to be updated when the remaining items close:

- `docs/audits/frontend/TRADE_PAGE_UI_AUDIT.md` §9 (the open defects) — close or keep
  each row with the evidence.
- `docs/pending/PENDING-005-trade-page-remaining-verification.md` — close the items this
  runbook closes.
- This file (`PENDING-008`) — set the status and archive it when every item is closed.

### What a second run still needs

1. **A funded Kotak account** (or a very low-margin instrument) and the operator's written
   instruction (instrument / side / quantity / product) before §4.3 may be executed.
2. **A handset on the same LAN** for §3 (the slide feel) and §6 (the PWA install).
3. **The Shoonya broker enabled** for §8.

---

## 12. Safety rules for this runbook

1. **A real Kotak order spends real money.** §4.3 needs the operator's explicit,
   written instruction (instrument / side / quantity / product) before the order is sent.
2. **Never run the backend test suite against the live database.** The Python tests
   mock their stores; if a future test needs MongoDB, point it at `kaustubh_test`.
3. **Do not kill the backend while it is booting** — a cold start takes 100-140 s and the
   watchdog's grace is 240 s.
4. **The dummy terminal is paper** — its orders are free and safe to use for any UI test.

---

## 13. Related

- `docs/implementation/033-trade-page-full-rebuild.md` — what was built and why
- `docs/verification/041-trade-page-full-rebuild.md` — the machine evidence already banked
- `docs/audits/frontend/TRADE_PAGE_UI_AUDIT.md` — the current state of the page
- `docs/pending/PENDING-005-trade-page-remaining-verification.md` — the parent pending task
- `docs/pending/PENDING-007-backend-listener-loss.md` — the listener defect that blocks
  live verification
- `docs/pending/PENDING-002-build-and-test-verification.md` — the platform-wide build task
- `docs/opencode/008-trade-page-rebuild/README.md` — the re-runnable probes
