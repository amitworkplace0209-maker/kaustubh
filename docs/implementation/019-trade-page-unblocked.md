# 019 — Trade Page Unblocked: Session Gate, Deep Link and Live-Quote Fallback

- **Task:** Make `http://localhost:3000/trading/trade` usable — the page must
  load, a stock must be selectable, and the order ticket must show real LTP,
  change, circuits and margin.
- **Status:** `IMPLEMENTED` (typecheck clean; 325/326 frontend tests pass, the
  one failure is the pre-existing `tests/topbar-status.test.ts` case; live
  browser verification performed — see
  `docs/verification/019-trade-page-unblocked-verification.md`)
- **Serial predecessor:** `018-search-engine-single-canonical-instrument-discovery`
- **Date:** 2026-09-30

---

## 1. Report

The reported symptom — *"page kaam nahi kar rha, stock select nahi ho rha"* —
was **not** a trade-page bug. Three separate defects stacked up:

| # | Defect | Symptom |
| --- | --- | --- |
| 1 | `proxy.ts` verified the HMAC session cookie by **bare base64 decode** | Every guarded page 307'd to `/login`; the trade page never mounted |
| 2 | `app/login/page.tsx` read `?from=` but never used it | Deep link lost; user had to re-navigate by hand |
| 3 | `trade-page.tsx` had `if (!view) return null` short-circuiting the snapshot fallback | Selected stock showed `STALE`, `LTP ₹-`, `ORDER VALUE ₹-` while search showed a live price |

No backend or SDK change was required. No live order was placed.

## 2. Root cause 1 — the session gate rejected every valid session

`lib/auth-crypto.ts` was migrated so `kaustubh_session` is an **HMAC-signed**
token:

```
base64url(payload) . base64url( HMAC-SHA256(base64url(payload), secret) )
```

`lib/auth-crypto.ts` documents the migration explicitly and states the payload
*MUST* be verified through `verifySessionToken` and **never** by base64-decoding.

`proxy.ts` was never updated with it. It still contained the pre-migration
logic:

```ts
const payload = JSON.parse(
  Buffer.from(sessionCookie.value, 'base64').toString()   // <-- base64, whole cookie
);
if (!payload.authenticated || !payload.exp) return false;
if (Date.now() > payload.exp) return false;
return true;
```

This is wrong twice over:

1. the payload is `base64url`, not `base64`; and
2. the cookie value also carries the `.` + signature suffix, so decoding the
   **whole** value can never yield the payload JSON.

`JSON.parse` therefore always threw, the `catch` returned `false`, and
`isAuthenticated()` returned `false` for every request — including perfectly
valid sessions. The visible symptom was a redirect loop to `/login`:

```
GET /trading/trade  ->  307  /login?from=%2Ftrading%2Ftrade
GET /api/auth/session  ->  {"authenticated": true}      <-- valid session!
```

The trade component was never mounted, so the search box, the order form and
every field were absent. The user could not select a stock because there was
nothing on the page to select from.

### Fix

`proxy.ts` now delegates to the single real verifier:

```ts
import { verifySessionToken } from '@/lib/auth-crypto';

function isAuthenticated(request: NextRequest): boolean {
  return verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value) !== null;
}
```

This is **strictly stronger** than the code it replaces: it verifies the HMAC
signature in constant time *and* the `exp` claim. The previous bare decode was
also the R-37 forgeable-cookie vulnerability, so the fix must not be reverted
to a decode.

**Runtime note.** `auth-crypto.ts` uses `node:crypto` and reads the
server-only secret from `APP_SESSION_SECRET` or `.auth/session-secret`. This is
importable in `proxy.ts` because Next.js 16 renamed `middleware` → `proxy` and
**Proxy defaults to the Node.js runtime** (`runtime` is not configurable in a
Proxy file). Confirmed against the installed `next@16.3.4` and the v16 docs.

## 3. Root cause 2 — the deep link was thrown away

`proxy.ts` attaches `?from=<pathname>` when it redirects, so the original
destination survives. `app/login/page.tsx` read it and never used it:

```ts
const from = searchParams.get('from');   // read, never referenced again
```

After a successful direct-login or PIN unlock the page always advanced to the
workspace picker, so a user who deep-linked to `/trading/trade` had to click
through again.

### Fix

A `safeFrom` value is derived once and honoured on both success paths, so
login returns the user to where they were going. It is restricted to
same-origin single-slash paths — `//evil.com` and `/\evil.com` are
protocol-relative URLs and would be an open redirect — and `/login` itself is
excluded to prevent a self-redirect loop.

## 4. Root cause 3 — the live-quote snapshot fallback was dead code

`components/orders/trade/trade-page.tsx` resolves the selected instrument's
quote from two real sources:

- `realtime.ticks` — the WS#3 `trading` channel (live frames), and
- `circuitSnap` — a REST read of `getMarketWatchTickSnapshot([token])`, i.e.
  the **same live feed** snapshotted server-side.

Every field in the memo was written as `view ? view.x ?? snap?.x : snap?.x` —
explicitly to serve the case where no WS frame has arrived yet but the snapshot
already carries a real price. That is the normal state for the first render(s)
after selection, because subscribe + snapshot is asynchronous.

A single line sat immediately above that block:

```ts
if (!view) return null;      // <-- unreachable fallback
```

It short-circuited ahead of every `view ? … : snap?.…` ternary, so the entire
snapshot path was dead code and `quote` stayed `null` until a WS frame landed.
Downstream, `const ltp = quote?.ltp || 0` made `orderValue` `0`, which is why
the ticket rendered `ORDER VALUE —`, `1 qty @ ₹—` and `LTP —`.

### Fix

The short-circuit is removed. Honesty is preserved: the guard above it still
returns `null` when there is no WS view, no snapshot LTP and no circuits, so a
quote is never fabricated.

## 5. Root cause 3b — an unknown margin was rendered as `₹0.00`

`components/orders/trade/selected-stock-card.tsx` interpolated the margin line
unconditionally:

```
1 × — = ₹0.00
```

That reads as a real zero margin when the truth is "the backend has not priced
this yet". The arithmetic is now gated on a known one-qty margin; otherwise the
card states why it is unknown, using the terminal's own declared capability
(`caps.supportsMarginPreview`):

- Kotak Neo (supports a margin preview) → `Awaiting server margin`
- Dummy Mode / Shoonya (no preview API) → `<name> has no margin preview`

`caps` was previously destructured as `_caps` and discarded, so the terminal's
capability could never be reported at all; it is now used.

## 6. Field → source → owner map (unchanged from 018)

No data contract changed. The trade page consumes the same canonical sources:

| Field | Source | Owner |
| --- | --- | --- |
| `ltp`, `change`, `changePct`, `volume` | WS#3 `trading` frame, else the market-watch snapshot of the same feed | Broker feed + tick store |
| `upperCircuit`, `lowerCircuit` | `raw.upper_circuit` / `priceband_upper` from the adapter, else the snapshot | Broker feed + instrument master |
| `oneQtyMargin` | Dummy → `POST /api/dummy/preview`; Kotak → broker `/api/terminal/margin` | Backend / broker RMS |
| Circuit status | backend `circuit` block (e.g. `UPPER_HIT`) | Market Watch engine |

Missing data stays `null` with an explicit status. Circuits are never derived
from LTP; margin is never derived from LTP or a leverage guess.

## 7. What was deliberately NOT changed

- No login/auth weakening. The gate still rejects unsigned, tampered, forged and
  expired cookies; it now rejects *valid* ones correctly.
- No broker session bypass, no SDK change, no order-path change.
- No live order was placed. Placement remains behind the authenticated order
  engine.
- The scheduler, Market Watch ranking and search contracts are untouched.
- The pre-existing `tests/topbar-status.test.ts` failure is unrelated and
  remains open.
