# 008 — Trade page rebuild: working files

Working/reference material for `docs/implementation/033-trade-page-full-rebuild.md`
and `docs/verification/041-trade-page-full-rebuild.md`.

- **Date:** 2026-10-21
- **Route:** `http://localhost:3000/trading/trade`
- **Related implementation:** `docs/implementation/033-trade-page-full-rebuild.md`
- **Related verification:** `docs/verification/041-trade-page-full-rebuild.md`
- **Related audit:** `docs/audits/frontend/TRADE_PAGE_UI_AUDIT.md`

---

## 1. Probes (re-runnable)

| Script | What it does | How to run |
|---|---|---|
| `ws-handshake-probe.mjs` | compares the page-origin socket with the direct backend socket | `node ws-handshake-probe.mjs <realtime-token>` |
| `trade-page-verify.mjs` | drives the desktop flow (search → select → price → risk → review → order) and captures the order payload. **Every order request is intercepted and aborted by default.** | `node trade-page-verify.mjs <cdpPort> <sessionCookie> [url] [--allow-order]` |
| `trade-page-mobile.mjs` | emulates a 390×844 touch device and measures the order bar against the bottom navigation | `node trade-page-mobile.mjs <cdpPort> <sessionCookie> [url]` |

Chrome must be running with a remote debugging port:

```
chrome.exe --headless=new --remote-debugging-port=9333 --user-data-dir=<temp> about:blank
```

The session cookie is obtained with:

```
POST /api/auth/login   {"direct":true}   ->  the kaustubh_session cookie
```

`--allow-order` is ONLY safe against the Dummy (paper) terminal.

## 2. Evidence

`evidence/trade-page-desktop.png` · `evidence/trade-page-mobile.png` ·
`evidence/trade-page-dummy-filled.png`

## 3. Diagnosis notes (the facts behind the rebuild)

1. `POST /api/demo/order/place` → `NameError: name '_to_engine_order_intent' is not
   defined` → HTTP 500. The function was never defined in the repository.
2. `risk_engine.validate_order()` recorded the order intent on the READ-ONLY preview, so
   the page's own pre-check made the following real order a "duplicate".
3. The browser's realtime socket pointed at the Next.js dev server, which cannot proxy a
   WebSocket upgrade → the page was permanently offline.
4. The risk pre-check re-fired on every tick (a validate every ~2.5 s).
5. `POST /api/dummy/preview` (the charges panel's source) does not exist in the backend.
6. The capabilities were a hand-written copy of `python-service/brokers/capabilities.py`.
7. The backend's asyncio accept loop dies with `WinError 64` on this host
   (`Accept failed on a socket`), leaving the process alive without a listener; the
   watchdog's 45 s grace was shorter than the ~100-140 s cold start, so it killed the
   backend during its own boot.

## 4. Related documentation

- Engine specifications: `docs/engines/RISK_ENGINE.md`,
  `docs/architecture/12_ORDER_LIFECYCLE.md`, `docs/architecture/13_RISK_MARGIN_ARCHITECTURE.md`
- SDK / broker surface: `docs/architecture/SDK_CATALOG.md`,
  `docs/broker/BROKER_INTEGRATION_MAP.md`
- Frontend contract: `docs/frontend/FRONTEND_CONTRACT.md`
- Previous work on this page: `docs/implementation/019`, `021`, `030`; verifications `019`,
  `024`, `032`, `038`; plan `docs/opencode/006-trade-page-pwa-web-ui-rebuild-plan.md`
