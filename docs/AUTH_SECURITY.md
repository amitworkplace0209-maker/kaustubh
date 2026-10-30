# Single-owner authentication & device security

> **2026-10-30 architecture note:** the owner-auth implementation now runs on
> **VM1** (`python-service/api/auth_app.py`). Vercel routes are thin proxies;
> Vercel has no MongoDB credentials and needs no `APP_PASSWORD`. The flow,
> security model and collection layout below remain accurate, but environment
> variables live in `/etc/kds/backend.env` on VM1. See
> [`auth-vm1-migration.md`](./auth-vm1-migration.md) and
> [`vercel-deployment.md`](./vercel-deployment.md).

> Full step-by-step login/signup/OTP/MPIN/WebAuthn flows, API reference, audit
> findings, VM deployment and troubleshooting live in
> [`AUTH_LOGIN_FULL_GUIDE.md`](./AUTH_LOGIN_FULL_GUIDE.md). This file is the
> architecture/security reference.

This document describes the security model that replaces the old loose
PIN/password setup. It is intentionally narrow: **exactly one owner**, up to
**two concurrent devices**, a fresh **email OTP for a second device**, and a
per-login **real client IP** audit trail in MongoDB.

## Guarantees

| Requirement | How it is enforced |
| --- | --- |
| Signup only until an owner exists | `app_auth_users` has a unique `singleton: 'owner'` document. `/api/auth/signup` returns `409 OWNER_EXISTS` after the first one; `/login` renders the signup form only when `/api/auth/status` says `needsSignup`. |
| Signup email + MPIN must match the server | Compared against `AUTH_SIGNUP_EMAIL` / `AUTH_SIGNUP_MPIN` (constant-time for the MPIN) from server-only env. They are **never stored** in MongoDB. |
| Only name + password are new | `name` and a `scrypt` password hash are persisted. The signup MPIN is discarded so the first login forces a new MPIN. |
| Login from anywhere | `/login` + cookie session; no IP allow-list. |
| Max 2 concurrent devices | Distinct `deviceId` values are counted from live `app_auth_sessions`. A third device is rejected with `403 DEVICE_LIMIT_REACHED`. Re-login on a known device rotates its session (no new slot). |
| Second device needs a fresh OTP each time | Any new device while another is active creates a single-use OTP (`app_auth_pending_logins`, HMAC-hashed, 10 min TTL, 5 attempts, bound to the requesting IP). |
| Real IP per login | `getClientIp()` reads `x-forwarded-for` / `x-real-ip` / `x-vercel-forwarded-for` / the socket address. Signup and login **fail closed** (`400 IP_REQUIRED`) when no IP can be resolved. Every attempt is written to `app_auth_events`. |
| MPIN mandatory after first login | `needsMpinSetup` drives a blocking setup screen, and `proxy.ts` refuses every page/API except the setup allow-list while the server-set `kaustubh_mpin_pending` cookie is present. `requireSession({ requireMpin: true })` additionally rejects sensitive APIs until an MPIN **or** a registered WebAuthn credential exists. |
| MPIN and/or fingerprint | Settings → Security can set/change/remove an MPIN and register/remove real WebAuthn platform credentials. Removing one method is blocked while it is the only method left. |
| Backend hidden from the browser | The browser only calls same-origin `/api/*`. `BACKEND_URL` / `WS_BACKEND_URL` are server-only; `NEXT_PUBLIC_*` backend hosts were removed from `lib/api-base.ts`, the About page and `server.mjs`. |
| No access without login | `proxy.ts` verifies the signed cookie **and** the live MongoDB session row (short cache), gating every page (redirect) and every non-public `/api/*` route (JSON `401`). WebSocket upgrades in `server.mjs` verify the same HMAC session cookie. |
| Fresh MongoDB restarts signup | The owner check is a database read, not a file/env check. Point `AUTH_MONGODB_URI` at the new empty database and the signup screen returns. |

## Data model (MongoDB, prefix `app_auth_`)

| Collection | Purpose |
| --- | --- |
| `app_auth_users` | The single owner: name, email, scrypt `passwordHash`, scrypt `mpinHash`, lockout counters, timestamps. |
| `app_auth_sessions` | One document per live login: `sessionId`, `userId`, `deviceId`, `deviceLabel`, real `ip`, `userAgent`, `kind`, `createdAt`, `lastSeenAt`, `expiresAt`, `revokedAt`. |
| `app_auth_pending_logins` | Pending second-device logins: HMAC `otpHash`, salt, request `ip`, attempts, expiry, status. |
| `app_auth_events` | Append-only audit: signup, login, failures, OTP, MPIN, biometric, device revocation — always with the real IP. |
| `app_auth_webauthn` | WebAuthn public keys only (credential id, public key, counter, transports, label, timestamps). |
| `app_auth_webauthn_challenges` | Short-lived WebAuthn challenges (5 min), consumed once. |

Indexes are created lazily by `lib/auth-db.ts` (unique owner singleton, unique
session id, TTL on OTP/challenges, session lookups by user/device).

## Session cookie

`kaustubh_session` is `payload.signature`:

- `payload` = base64url JSON `{ v, authenticated, sid, did, iat, exp }`.
- `signature` = HMAC-SHA256 over the encoded payload with
  `AUTH_SESSION_SECRET` (or the generated `.auth/session-secret`).
- `HttpOnly`, `SameSite=Lax`, `Secure` when the request is HTTPS.
- The proxy verifies the signature, then loads the session row (10-second
  per-process cache) so a revocation from another device takes effect almost
  immediately. If MongoDB is unreachable the proxy fails closed; the public
  login page still loads and explains the outage.
- Every sensitive route additionally calls `requireSession`, which re-reads the
  row without the cache and verifies the owner still exists.

`kaustubh_mpin_pending` is set by the server on the first signup/login, when no
MPIN or WebAuthn credential exists yet. The proxy uses it to keep every page and
API closed except `/api/auth/mpin/setup` (plus session/status/logout) until the
MPIN is saved; it is never accepted as authentication. `POST /api/auth/mpin/setup`
clears it in the same response that stores the hash.

## Flows

### 1. First run (empty database)

1. `GET /api/auth/status` → `hasOwner: false`, `needsSignup: true`.
2. Signup form posts `name`, `email`, `password`, `mpin`.
3. Server checks the env email + MPIN, creates the owner, records IP, issues a
   session and sets `needsMpinSetup: true`.
4. The UI blocks on the MPIN setup screen; the proxy also rejects direct page and
   API requests while the pending cookie is present, so the app opens only after
   `POST /api/auth/mpin/setup`.

### 2. Login

1. Password verified against the scrypt hash (8 failures → 15-minute lock).
2. Device policy:
   - 0 active devices → straight in.
   - known device → rotate its session, straight in.
   - 1 active device, new device → email OTP, then in.
   - 2 active devices, new device → blocked.
3. On success the app asks for the MPIN / biometric unlock.

### 3. Second device OTP

The code is sent through SMTP or `AUTH_OTP_WEBHOOK_URL`. In development only,
with no channel configured, it is logged and returned as `devOtp` for the
login UI. The verify call re-checks the device limit, the IP, the expiry and
the attempt count, then burns the code.

### 4. App unlock

- MPIN: server-side scrypt verify, 5 failures → 5-minute lockout.
- Biometric: real WebAuthn assertion (`navigator.credentials.get`) verified by
  `@simplewebauthn/server`; the counter is updated in MongoDB.
- If the MPIN was removed, a biometric credential must still exist.

### 5. Device management

Settings → Security lists every live session with its real IP. You can revoke
one session or all other devices. Revoking the current session clears the
cookie and returns you to `/login`. Other devices lose page/API access within
about ten seconds (the proxy's validation cache) and their UI redirects as soon
as it polls `/api/auth/session`.

## Environment

See `.env.example`. Minimum for a working install:

```dotenv
AUTH_MONGODB_URI=mongodb+srv://…/            # or MONGODB_URI
AUTH_MONGODB_DB=kaustubh
AUTH_SIGNUP_EMAIL=owner@example.com
AUTH_SIGNUP_MPIN=123456
AUTH_SESSION_SECRET=<48+ random chars>
AUTH_SMTP_HOST=…                             # or AUTH_OTP_WEBHOOK_URL
AUTH_SMTP_PORT=587
AUTH_SMTP_USER=…
AUTH_SMTP_PASS=…
AUTH_EMAIL_FROM=…
AUTH_EMAIL_TO=…
AUTH_RP_ID=terminal.example.com              # for WebAuthn (domain, not IP)
AUTH_ORIGIN=https://terminal.example.com
```

Security notes:

- Never prefix any of these with `NEXT_PUBLIC_`.
- Keep `.env*` out of git (already ignored) and use mode `0600` on the VM.
- WebAuthn requires a **domain or localhost**; a bare IP cannot be an RP ID.
  Put the VM behind HTTPS + a domain before enabling biometrics.
- `AUTH_MAX_ACTIVE_SESSIONS` is clamped to `1..2`.

## Moving to the VM

1. Install/start MongoDB on the VM and create a fresh database.
2. Copy `.env.example` to the VM environment and set the new
   `AUTH_MONGODB_URI` (plain `mongodb://127.0.0.1:27017` is fine) and the
   same signup email/MPIN.
3. Start `npm run build && npm start`. With an empty `app_auth_users`, the
   login page shows the one-time signup again.
4. Once the owner is created, the signup path is closed until the database is
   emptied again.

## Operational checks

```bash
npm run typecheck   # strict TypeScript
npm test            # proxy + trading-session regression guards
npm run build       # production build
```

If MongoDB is down, auth routes return `503` with `{ database: false }` and the
login page shows a retry button instead of pretending the session is valid.
