# KAUSTUBH — Auth & Security: Full Audit + Working Guide

> **Audience:** owner/operator (tum) + future maintainer.
> **Scope:** single-owner login, one-time signup, max 2 devices, email OTP, MPIN, real WebAuthn biometric, IP audit, backend hiding, VM deployment.
> **Last audited:** 2026-10-25 (local repo, commit `bb20417` + local `.env`).
> **Language:** Hinglish (technical terms English me).

---

## 0. TL;DR — abhi kya haal hai

| Cheez | Status |
| --- | --- |
| One-time signup (sirf pehli baar) | ✅ Working |
| Owner already exists | ✅ `amit` (email masked `a***@gmail.com`), MPIN set |
| Email + password login | ✅ Working |
| Max 2 devices | ✅ Server-side enforced |
| Second device OTP | ⚠️ Code ready, **real email nahi jayega** kyunki `AUTH_SMTP_PASS` khali hai |
| Dev OTP fallback | ✅ On (dev me OTP UI + server log me dikhta hai) |
| Mandatory MPIN after first login | ✅ Server-side enforced (pending cookie + proxy) |
| MPIN unlock | ✅ Server verify + lockout |
| Real WebAuthn biometric | ⚠️ Code ready, **localhost/domain + HTTPS par test pending** |
| IP audit | ✅ MongoDB `app_auth_events` me har event ke saath |
| Backend browser se hidden | ✅ Same-origin `/api/*` + WS gate |
| Session revoke / logout | ✅ Working, ~10s proxy cache |
| VM + fresh MongoDB signup | ⏳ Deployment pending |
| App unlock server-side enforce | ❌ **UI-only** (audit finding #1) |

**Sabse pehle karne wali cheez:** Gmail App Password banao aur `AUTH_SMTP_PASS` bharo, phir server restart karo. Uske bina production me second-device login possible nahi hai.

---

## 1. Feature inventory — kya-kya bana hai aur kya kaam karta hai

### 1.1 One-time owner signup

- Signup screen **sirf tab** dikhta hai jab MongoDB me owner document nahi hai.
- Form: `name`, `email`, `password`, `mpin`.
- Email + MPIN **server env** se match hote hain:
  - `AUTH_SIGNUP_EMAIL`
  - `AUTH_SIGNUP_MPIN`
- Sirf `name` aur `password` (scrypt hash) store hote hain. Signup wala MPIN **store nahi hota**.
- Owner banne ke baad signup route `409 OWNER_EXISTS` deta hai.
- Fresh MongoDB = signup wapas aa jata hai (database read based, file/env based nahi).

**Kya kaam karega:** naya VM + khali DB par pehli baar account banana. Uske baad signup permanently band.

### 1.2 Login from anywhere

- Email **ya** name + password se login.
- Password scrypt hash se verify hota hai.
- 8 galat password → 15 minute lock.
- IP resolve na ho to login **fail closed** (`400 IP_REQUIRED`).
- Login ke baad MPIN/biometric unlock screen.

### 1.3 Device policy (max 2)

| Situation | Result |
| --- | --- |
| 0 active devices | Seedha login, no OTP |
| Same `deviceId` se dobara login | Purana session rotate, no OTP |
| 1 active device + naya device | **Fresh email OTP har baar** |
| 2 active devices + naya device | **Blocked** (`403 DEVICE_LIMIT_REACHED`) |
| Kisi device ko revoke kiya | Slot khali, naya device login kar sakta hai |

- Device count **distinct `deviceId`** se hota hai, sessions rows se nahi.
- UI par `Active devices X / 2` meter dikhta hai.
- Third device block hone par active sessions ki list (label + IP) response me aati hai.

### 1.4 Email OTP (second device)

- 6-digit code, `crypto.randomInt`.
- Sirf HMAC hash DB me (`app_auth_pending_logins`), plain OTP nahi.
- 10 minute expiry, single-use, max 5 attempts.
- OTP **requesting IP se bound** hai — dusre network se verify nahi hoga.
- Delivery channels (priority order):
  1. `AUTH_OTP_WEBHOOK_URL` (generic JSON webhook)
  2. SMTP (`AUTH_SMTP_*`)
  3. Dev-only UI + console fallback (`AUTH_OTP_DEV_FALLBACK`, default on outside production)
- Production me koi channel nahi = OTP delivery fail (`503 OTP_DELIVERY_FAILED`).

### 1.5 Mandatory MPIN after first login

- Signup ke baad session milta hai lekin `kaustubh_mpin_pending=1` cookie ke saath.
- Jab tak MPIN set nahi hota:
  - `/login` MPIN setup screen dikhata hai.
  - `proxy.ts` har protected page ko `/login?from=...` par redirect karta hai.
  - Har protected `/api/*` ko `403 MPIN_SETUP_REQUIRED` milta hai.
  - Sirf ye routes allowed: `/api/auth/mpin/setup`, `/api/auth/session`, `/api/auth/status`, `/api/auth/logout`.
- MPIN set hote hi pending cookie delete, app khul jata hai.

### 1.6 MPIN / Biometric unlock

- MPIN: 6 digits, scrypt hash, 5 galat attempts → 5 minute lock.
- Weak MPIN reject: `123456`, repeated digits, sequential digits, common patterns.
- Biometric: real WebAuthn platform authenticator (fingerprint/face/Windows Hello).
- MPIN aur biometric **alternatives** hain:
  - MPIN remove karne ke liye kam se kam 1 biometric credential chahiye.
  - Last biometric credential remove karne ke liye MPIN chahiye.
- Isse owner apne aap ko lock-out nahi kar sakta.

### 1.7 IP audit

- Har signup/login/failure/OTP/MPIN/biometric/device event MongoDB me.
- IP resolution order:
  1. `x-forwarded-for` (first IP)
  2. `x-real-ip`
  3. `cf-connecting-ip`
  4. `x-vercel-forwarded-for`
  5. `x-client-ip`
  6. `true-client-ip`
- Dev me headers na ho to `127.0.0.1`.
- Production me kuch na mile to `null` → login/signup/OTP **block**.

### 1.8 Backend hiding

- Browser sirf same-origin `/api/*` call karta hai.
- `BACKEND_URL` / `WS_BACKEND_URL` **server-only** hain.
- `NEXT_PUBLIC_API_BASE` / `NEXT_PUBLIC_WS_URL` browser code me nahi.
- WebSocket browser `ws://<page-host>/ws/realtime` kholta hai; `server.mjs` HMAC cookie verify karke backend ko tunnel karta hai.
- `/api/*` bina session ke proxy se `401 JSON` milta hai, login page HTML nahi.

---

## 2. File map — kaunsa file kya karta hai

### 2.1 Core libraries

| File | Kaam |
| --- | --- |
| `lib/auth-config.ts` | Server-only env loader, Mongo URI/DB, signup email/MPIN, SMTP, IP resolve, RP ID, request context. |
| `lib/auth-crypto.ts` | scrypt password/MPIN hash, HMAC OTP, HMAC session token, cookie names, session secret resolution. |
| `lib/auth-db.ts` | MongoDB client (SRV fallback), collections, indexes, users/sessions/events/pending/WebAuthn CRUD. |
| `lib/auth-sessions.ts` | Session issue/rotate, cookie set/clear, `requireSession`, MPIN-pending cookie, device count. |
| `lib/auth-mpin.ts` | MPIN policy, set/verify/clear, 5-attempt lockout. |
| `lib/auth-mail.ts` | SMTP/webhook/dev OTP delivery + email HTML/text template. |
| `lib/auth-rate-limit.ts` | In-process sliding-window rate limiter. |
| `lib/auth-validation.ts` | Input validation, JSON helpers, public user/session shaping, email masking, device id/label sanitising. |
| `lib/webauthn.ts` | WebAuthn registration/authentication options + verification, challenge TTL, origin/RP handling. |
| `lib/device-id.ts` | Browser device id (localStorage) + device label. |
| `components/auth-provider.tsx` | Client auth state, `/api/auth/session` polling every 30s, auth-changed event. |
| `proxy.ts` | Page/API gate, live Mongo session validation (10s cache), MPIN-pending allow-list. |
| `server.mjs` | Next custom server + WS tunnel with session-cookie gate. |

### 2.2 Pages

| File | Kaam |
| --- | --- |
| `app/login/page.tsx` | Poora auth UI: signup, login, OTP, MPIN setup, unlock, biometric, workspace cards, emoji/rich background. |
| `app/(phase2)/data-saver/settings/security/page.tsx` | Settings → Security: MPIN setup/change/remove, biometric register/remove, devices, IP/event list. |

### 2.3 API routes

```
app/api/auth/
├─ signup/route.ts
├─ login/route.ts
├─ login/verify-otp/route.ts
├─ logout/route.ts
├─ session/route.ts
├─ status/route.ts
├─ overview/route.ts
├─ events/route.ts
├─ devices/route.ts
├─ devices/revoke/route.ts
├─ mpin/setup/route.ts
├─ mpin/verify/route.ts
├─ mpin/change/route.ts
├─ mpin/disable/route.ts
├─ biometric/register/options/route.ts
├─ biometric/register/verify/route.ts
├─ biometric/auth/options/route.ts
├─ biometric/auth/verify/route.ts
├─ biometric/credentials/route.ts
├─ setup/route.ts                 (legacy alias)
├─ pin/change/route.ts            (legacy alias)
├─ pin/disable/route.ts           (legacy alias)
├─ manual-login/route.ts          (backend bridge, gated)
└─ trading-token/route.ts         (backend JWT handoff, gated)
```

---

## 3. Data model (MongoDB)

**Database:** `AUTH_MONGODB_DB`, warna URI ka database name, warna `kaustubh`.

| Collection | Kya store hota hai |
| --- | --- |
| `app_auth_users` | Single owner: name, email, scrypt `passwordHash`, scrypt `mpinHash`, password/MPIN lock counters, timestamps. Unique `singleton: 'owner'`. |
| `app_auth_sessions` | Har live login: `sessionId`, `userId`, `deviceId`, `deviceLabel`, real `ip`, `userAgent`, `kind`, `createdAt`, `lastSeenAt`, `expiresAt`, `revokedAt`, `revokedReason`. |
| `app_auth_events` | Append-only audit: signup, login, failures, OTP, MPIN, biometric, revoke, logout — har event me IP. |
| `app_auth_pending_logins` | Second-device OTP state: `pendingId`, `otpSalt`, `otpHash`, `ip`, `attempts`, `expiresAt`, `status`. |
| `app_auth_webauthn` | WebAuthn public keys only: `credentialId`, `publicKey`, `counter`, `transports`, `deviceLabel`, timestamps. |
| `app_auth_webauthn_challenges` | Short-lived (5 min) WebAuthn challenges, single-use. |

**Indexes (lazy create):**

- users: unique `singleton`, unique `nameLower`, unique `emailLower`
- sessions: unique `sessionId`, `(userId, revokedAt, expiresAt)`, TTL `expiresAt`
- events: `at: -1`, `(ip, type, at)`
- pending logins: unique `pendingId`, TTL `expiresAt`
- webauthn: unique `credentialId`, `userId`
- challenges: unique `challenge`, TTL `expiresAt`

> **Note:** `docs/AUTH_SECURITY.md` me pehle collection names `app_auth_otp`, `app_auth_credentials`, `app_auth_challenges` likhe the. Actual code `app_auth_pending_logins`, `app_auth_webauthn`, `app_auth_webauthn_challenges` use karta hai — wo doc is audit me fix kar diya gaya hai.

---

## 4. Environment configuration

### 4.1 Env loading order (lowest → highest priority)

1. `python-service/.env`
2. `python-service/.env.local`
3. `.env`
4. `.env.local`
5. Real `process.env` (systemd/Docker/Vercel)

Implementation: `lib/auth-config.ts` (`ENV_FILES`, then `process.env` wins).

> `lib/auth-crypto.ts` session secret ke liye sirf `process.env` + `.auth/session-secret` dekhta hai. Next `.env` ko process env me load karta hai; custom server `--production` se pehle ensure karo ki env available hai.

### 4.2 Variables

| Variable | Required | Default | Kya karta hai |
| --- | --- | --- | --- |
| `AUTH_MONGODB_URI` | ✅ (ya `MONGODB_URI`) | — | Server-only Mongo connection string. |
| `AUTH_MONGODB_DB` | Recommended | URI DB / `kaustubh` | Auth collections ka database. |
| `AUTH_SIGNUP_EMAIL` | ✅ | — | One-time signup email (case-insensitive). |
| `AUTH_SIGNUP_MPIN` | ✅ | — | One-time signup gate MPIN. Store nahi hota. |
| `AUTH_SESSION_SECRET` | ✅ production | generated `.auth/session-secret` | HMAC cookie + OTP hash secret. 32+ chars. |
| `AUTH_MAX_ACTIVE_SESSIONS` | ❌ | `2` | 1..2 clamp. |
| `AUTH_OTP_WEBHOOK_URL` | ❌ | empty | SMTP se priority. |
| `AUTH_SMTP_HOST` | OTP ke liye ✅ | — | e.g. `smtp.gmail.com`. |
| `AUTH_SMTP_PORT` | OTP ke liye ✅ | `587` | 587 STARTTLS / 465 SSL. |
| `AUTH_SMTP_SECURE` | ❌ | port 465 par true | TLS direct. |
| `AUTH_SMTP_USER` | OTP ke liye ✅ | — | SMTP login. |
| `AUTH_SMTP_PASS` | OTP ke liye ✅ | — | App password. 16 chars, spaces **hatao**. |
| `AUTH_EMAIL_FROM` | ❌ | SMTP user | From header. |
| `AUTH_EMAIL_TO` | ❌ | signup email | OTP recipient. |
| `AUTH_OTP_DEV_FALLBACK` | ❌ | dev me `true` | Dev UI/console OTP; production me ignored. |
| `AUTH_RP_ID` | WebAuthn ke liye ✅ | request hostname | Domain only, IP nahi. |
| `AUTH_ORIGIN` | WebAuthn ke liye ✅ | request origin | Comma-separated allowed origins. |
| `AUTH_RP_NAME` | ❌ | `KAUSTUBH Trading Platform` | WebAuthn display name. |
| `BACKEND_URL` | ❌ | `http://127.0.0.1:8000` | Server-only Python backend. |
| `WS_BACKEND_URL` | ❌ | `BACKEND_URL` | Server-only WS backend. |

### 4.3 Current local state

- Root `.env` exists (git-ignored).
- `AUTH_SIGNUP_EMAIL` = `o***@gmail.com` (logs me masked).
- `AUTH_SIGNUP_MPIN=123456` — **weak**, sirf one-time gate; VM par strong 6-digit rakho.
- `AUTH_SESSION_SECRET` = 64-char generated (chat me exposed purana secret rotate kar diya).
- `AUTH_MAX_ACTIVE_SESSIONS=2`.
- `AUTH_OTP_WEBHOOK_URL` empty → SMTP path.
- Gmail SMTP host/port/user set.
- **`AUTH_SMTP_PASS` empty** → `mailerConfigured:false`.
- `devOtp:true` → second-device OTP UI + console me.
- Dev server: `node server.mjs`, PID 21824, `http://127.0.0.1:3000`.
- Owner: `amit`, MPIN set, 1 session (`Chrome · Windows`, `127.0.0.1`).
- Events: `signup`, `mpin_setup`, `mpin_verified` (2x).

---

## 5. Full flows (step-by-step)

### 5.1 Fresh MongoDB — one-time signup

```
Browser /login
  └─ GET /api/auth/status
       hasOwner=false, needsSignup=true, signupConfigured=true
  └─ signup form: name, email, password, mpin
  └─ POST /api/auth/signup
       1. IP resolve (fail → 400 IP_REQUIRED)
       2. rate limit: 5 / hour / IP
       3. env email + MPIN configured? (fail → 503)
       4. owner already exists? (fail → 409 OWNER_EXISTS)
       5. validate name/email/password
       6. email === env email AND constant-time MPIN === env MPIN
          (fail → 401 SIGNUP_MISMATCH)
       7. scrypt(password) → app_auth_users insert
       8. event: signup (real IP)
       9. session create + cookie `kaustubh_session`
      10. `kaustubh_mpin_pending=1`
      11. response: 201, needsMpinSetup=true
  └─ UI → MPIN setup screen
```

**Important:** signup session bhi valid hai, lekin pending cookie ke bina app nahi khulega.

### 5.2 First device login (no active session)

```
POST /api/auth/login { email|name, password, deviceId, deviceLabel }
  1. IP required, rate limit 12 / 10 min / IP
  2. owner exists? (NO_OWNER → signup)
  3. password lock check
  4. email/name match + scrypt verify
       fail → counter++, 8 par 15-min lock, event login_failed
  5. active sessions list
  6. new device? 0 active → no OTP
  7. session create (kind=primary), cookie
  8. needsMpinSetup = !mpinHash && no biometric
  9. response: authenticated, needsMpinSetup / needsUnlock
```

### 5.3 Same device re-login

- `deviceId` same mila → purana active session `revokedReason: 'rotated'`.
- Naya session row + naya cookie.
- OTP nahi.
- Device slot same rehta hai (count nahi badhta).

### 5.4 Second device login — OTP

```
POST /api/auth/login
  1. password OK
  2. new device, 1 active device already
  3. 6-digit OTP generate
  4. pending doc: HMAC hash, salt, IP, 10 min TTL
  5. deliverOtp():
       webhook → SMTP → dev fallback
  6. event: login_otp_requested
  7. response 202:
       { needsOtp:true, pendingId, maskedEmail, channel, devOtp? }
  8. UI → OTP screen (6 digits)

POST /api/auth/login/verify-otp { pendingId, otp, deviceId, deviceLabel }
  1. IP required, rate limit 10 / 10 min / IP
  2. pending exists, status=pending, not expired
  3. attempts < 5
  4. pending.ip === request IP (warna 403 OTP_IP_MISMATCH)
  5. HMAC OTP verify (constant time)
       fail → attempts++, event login_otp_failed
  6. device limit **dobara** check (race safety)
  7. pending → approved
  8. session create + cookie
  9. events: login_otp_verified, login
 10. response: authenticated, deviceCount
```

**OTP rules:** 10 min, single-use, 5 attempts, IP-bound, resend = naya pending doc (purana pending reh jata hai TTL tak).

### 5.5 Third device blocked

- 2 active distinct devices + naya `deviceId`.
- Password pehle verify hota hai, phir `403 DEVICE_LIMIT_REACHED`.
- Response me `deviceCount`, `maxDevices`, active sessions (label + IP).
- Solution: Settings → Security → kisi device ko revoke karo, ya us device par logout karo.

### 5.6 Mandatory MPIN setup

```
POST /api/auth/mpin/setup { mpin, confirm }
  1. valid session (pending cookie ho ya na ho)
  2. MPIN already set? → 409 MPIN_ALREADY_SET
  3. confirm mismatch? → 400
  4. validateMpin: 6 digits, weak/sequential/repeated reject
  5. scrypt hash → app_auth_users.mpinHash
  6. pending cookie delete
  7. event: mpin_setup
  8. response: needsUnlock=true, "app unlocked"
```

### 5.7 App unlock — MPIN

```
POST /api/auth/mpin/verify { mpin }
  1. live session required
  2. MPIN configured?
  3. lock remaining? → 429
  4. 6-digit format
  5. scrypt verify
       fail → attempts++, 5 par 5-min lock, event mpin_failed
  6. success → reset counters, event mpin_verified
  7. UI → completeLogin() → `from` path ya workspace
```

### 5.8 App unlock — biometric (WebAuthn)

```
POST /api/auth/biometric/auth/options
  1. live session
  2. RP ID valid? IP ho to error
  3. credentials exist?
  4. generateAuthenticationOptions (allowCredentials)
  5. challenge DB me save (5 min, single-use)
  6. browser: navigator.credentials.get()
POST /api/auth/biometric/auth/verify { response }
  1. challenge consume
  2. credential DB se load
  3. verifyAuthenticationResponse (origin, RP ID, UV required)
  4. counter update
  5. event: biometric_login / biometric_failed
  6. UI → completeLogin()
```

### 5.9 Biometric register / remove

**Register:**

```
POST /api/auth/biometric/register/options
  → generateRegistrationOptions (platform, residentKey preferred, UV required)
  → challenge save
POST /api/auth/biometric/register/verify { response, deviceLabel? }
  → verifyRegistrationResponse
  → duplicate credential? → alreadyRegistered
  → addCredential (public key only)
  → event biometric_registered
```

`requireSession({ requireMpin: true })` — MPIN ya existing biometric hona chahiye.

**Remove:**

```
DELETE /api/auth/biometric/credentials { credentialId }
  → credential owner check
  → last credential + no MPIN? → 409 LAST_UNLOCK_METHOD
  → remove + event biometric_removed
```

### 5.10 MPIN change / remove

```
POST /api/auth/mpin/change { currentMpin, newMpin, confirm }
  → current verify → naya validate → hash save → event mpin_changed

POST /api/auth/mpin/disable { mpin }
  → biometric credential exist? warna 409
  → current MPIN verify
  → mpinHash=null → event mpin_removed
```

### 5.11 Devices / logout

```
GET  /api/auth/devices
  → active sessions + distinct device count + maxDevices

POST /api/auth/devices/revoke
  { sessionId }        → wo session revoke
  { deviceId }         → us device ke saare sessions revoke
  { all: true }        → current chhod kar sab revoke
  → agar current revoke hua to cookies clear
  → event device_revoked / logout_all

POST /api/auth/logout
  → current session revoke + dono cookies clear
  → dusre devices signed-in rehte hain

DELETE /api/auth/logout
  → same behaviour (legacy)
```

### 5.12 Session lifecycle

- Cookie: `kaustubh_session`, HMAC-SHA256, payload `{ v:2, authenticated, sid, did, iat, exp }`.
- TTL: **7 days** (`SESSION_TTL_MS`).
- `HttpOnly`, `SameSite=Lax`, `Secure` jab HTTPS.
- Proxy har request par signature + live Mongo row check karta hai (10s per-process cache).
- `requireSession` cache use nahi karta — sensitive API turant revoke dekh leti hai.
- Mongo down → proxy **fail closed** (`401`/redirect), login page load hota hai aur error dikhata hai.
- `AUTH_SESSION_SECRET` rotate = sab existing sessions invalid.

---

## 6. API reference

### 6.1 Public (proxy allow-list)

| Method | Path | Body / Query | Response |
| --- | --- | --- | --- |
| GET | `/api/auth/status` | — | `hasOwner`, `needsSignup`, `signupConfigured`, `mailerConfigured`, `devOtp`, `maxDevices`; session ho to user + devices. |
| GET | `/api/auth/session` | — | Same shape, UI ka source of truth. |
| POST | `/api/auth/signup` | `{ name, email, password, mpin, deviceId?, deviceLabel? }` | `201` + cookies; errors `400/401/409/503`. |
| POST | `/api/auth/login` | `{ email\|name, password, deviceId?, deviceLabel? }` | `200` session, `202 needsOtp`, `401/403/409/429`. |
| DELETE | `/api/auth/login` | — | Legacy logout. |
| POST | `/api/auth/login/verify-otp` | `{ pendingId, otp, deviceId?, deviceLabel? }` | `200` session; `401/403/404/409/410/429`. |
| POST | `/api/auth/logout` | — | Cookies clear. |
| DELETE | `/api/auth/logout` | — | Same. |
| GET | `/api/health` | — | Health probe. |

### 6.2 Authenticated

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/auth/overview` | `requireMpin: true`; user + devices + credentials + 20 events. |
| GET | `/api/auth/events?limit=50` | `requireMpin: true`; max 100. |
| GET | `/api/auth/devices` | Active sessions + count. |
| POST | `/api/auth/devices/revoke` | `{ sessionId \| deviceId \| all }`. |
| POST | `/api/auth/mpin/setup` | First MPIN only; pending allow-list me. |
| POST | `/api/auth/mpin/verify` | Unlock. |
| POST | `/api/auth/mpin/change` | Current + new. |
| POST | `/api/auth/mpin/disable` | Biometric required. |
| POST | `/api/auth/biometric/register/options` | Requires MPIN/biometric. |
| POST | `/api/auth/biometric/register/verify` | Requires MPIN/biometric. |
| POST | `/api/auth/biometric/auth/options` | Live session. |
| POST | `/api/auth/biometric/auth/verify` | Live session. |
| GET | `/api/auth/biometric/credentials` | No secrets. |
| DELETE | `/api/auth/biometric/credentials` | `credentialId`. |

### 6.3 Legacy / bridges (still gated)

| Method | Path | Notes |
| --- | --- | --- |
| GET/POST | `/api/auth/setup` | Legacy MPIN card; delegates to MPIN policy. |
| POST | `/api/auth/pin/change` | Legacy alias. |
| POST | `/api/auth/pin/disable` | Legacy alias. |
| POST/DELETE | `/api/auth/manual-login` | Backend operator login; `requireMpin`. |
| GET | `/api/auth/trading-token` | Backend JWT handoff; live session. |

### 6.4 Common error codes

| Code | HTTP | Matlab |
| --- | --- | --- |
| `IP_REQUIRED` | 400 | Client IP resolve nahi hui. |
| `NO_OWNER` | 409 | Owner nahi hai, signup karo. |
| `OWNER_EXISTS` | 409 | Owner already hai, login karo. |
| `SIGNUP_MISMATCH` | 401 | Env email/MPIN match nahi. |
| `SIGNUP_NOT_CONFIGURED` | 503 | Env email/MPIN missing. |
| `DEVICE_LIMIT_REACHED` | 403 | 2 devices full. |
| `OTP_DELIVERY_FAILED` | 503 | SMTP/webhook fail. |
| `OTP_IP_MISMATCH` | 403 | OTP dusre network se. |
| `OTP_EXPIRED` | 410 | 10 min paar. |
| `OTP_ALREADY_USED` | 409 | Code burn ho chuka. |
| `MPIN_SETUP_REQUIRED` | 403 | Pehle MPIN set karo. |
| `MPIN_NOT_SET` | 409 | MPIN nahi hai. |
| `MPIN_ALREADY_SET` | 409 | Setup dobara nahi. |
| `LAST_UNLOCK_METHOD` | 409 | Last unlock method remove nahi. |
| `UNAUTHENTICATED` | 401 | Session invalid/expired. |
| `WEBAUTHN_VERIFY_FAILED` | 400 | Biometric verify fail. |

---

## 7. UI screens (login page)

`app/login/page.tsx` ke states:

| Step | Screen | Trigger |
| --- | --- | --- |
| `boot` | Loading / DB error + retry | Initial status call |
| `signup` | Name, email, password, signup MPIN | `hasOwner=false` |
| `login` | Email/name + password, device meter | `hasOwner=true`, no session |
| `otp` | 6-digit code, resend, dev OTP hint | `needsOtp` |
| `mpin-setup` | 6-digit MPIN + confirm | `needsMpinSetup` |
| `unlock` | MPIN / fingerprint / face | `needsUnlock` |
| `workspace` | 4 cards (Trading, Data Saver, Services, Security) | Unlocked |

Visuals:

- Dark gradient background, animated orbs, grid, scanline.
- 15 floating emoji glyphs (🛡️ 📈 🔐 ⚡ 💹 🌐 🔎 🪙 🧠 🚀 🛰️ 🧬 ✨ 🔔 📡).
- Glass cards, neon emerald/sky accents, responsive desktop/mobile.
- Device meter shows `X / 2` and per-session label + IP.

---

## 8. Gate architecture

### 8.1 Proxy (`proxy.ts`)

```
Request
 ├─ asset? → allow (/_next, /sw.js, /manifest, icons, favicon)
 ├─ public? → allow (/login, auth bootstrap, /api/health, offline)
 ├─ live session? (HMAC + Mongo row, 10s cache, fail closed)
 │    ├─ no  → API: 401 JSON | page: redirect /login?from=...
 │    └─ yes
 │         ├─ mpin pending?
 │         │    ├─ setup allow-list → allow
 │         │    └─ else → API 403 | page redirect /login?from=...
 │         └─ allow
```

### 8.2 WebSocket (`server.mjs`)

- Browser `ws://<page-host>/ws/realtime`.
- Server cookie se `kaustubh_session` nikalta hai.
- HMAC + `exp` verify.
- Fail → `401 Unauthorized`, backend socket touch nahi hota.
- Success → backend `WS_BACKEND_URL` ko raw tunnel.

### 8.3 Backend hiding

- Browser ko `BACKEND_URL` kabhi nahi milta.
- Next rewrites / route handlers server-side fetch karte hain.
- No `NEXT_PUBLIC_*` backend host.
- Vercel par backend URL server env me, browser bundle me nahi.

---

## 9. Security audit findings

### 9.1 Strong / working

| # | Finding | Evidence |
| --- | --- | --- |
| S1 | Single owner DB-enforced | unique `singleton: 'owner'` |
| S2 | Passwords/MPIN scrypt + per-secret salt | `lib/auth-crypto.ts` |
| S3 | Session cookie HMAC + HttpOnly + SameSite | `createSessionToken`, `issueSessionForUser` |
| S4 | Revocation live DB check | `proxy.ts`, `requireSession` |
| S5 | OTP HMAC-hashed, single-use, IP-bound, attempt-capped | `login/verify-otp` |
| S6 | Real IP fail-closed in production | `getClientIp` + routes |
| S7 | Device limit server-side, race re-check at OTP | login + verify-otp |
| S8 | Mandatory MPIN setup gated by proxy | pending cookie allow-list |
| S9 | MPIN/password lockouts | 5/5min, 8/15min |
| S10 | WebAuthn real verification, UV required, counter update | `lib/webauthn.ts` |
| S11 | Cannot remove last unlock method | MPIN disable + credential delete guards |
| S12 | Backend/WS not browser-visible | same-origin + server-only env |
| S13 | Audit trail for every auth event | `app_auth_events` |

### 9.2 Open findings (priority order)

#### 🔴 P0-1 — `AUTH_SMTP_PASS` empty

- **Problem:** `mailerConfigured:false`. Dev me OTP UI/log se chal jata hai, production me second device login **impossible**.
- **Fix:** Gmail App Password (16 chars, spaces removed) `.env` me daalo → restart → status me `mailerConfigured:true` verify karo.

#### 🔴 P0-2 — App unlock server-side enforce nahi hai

- **Problem:** `needsUnlock` sirf UI state hai. `proxy.ts` valid session ko allow karta hai, chahe MPIN/biometric unlock hua ho ya nahi. Agar cookie copy/stolen ho jaye to 7 din tak direct protected page khul sakta hai, MPIN ke bina.
- **Kyun important:** requirement "MPIN ke baad app opens" + app-lock security claim.
- **Fix options:**
  1. Short-lived `kaustubh_unlocked` HMAC cookie (15–30 min) set by `/api/auth/mpin/verify` and biometric verify; proxy check kare.
  2. Session row me `unlockedUntil` field; proxy/requireSession check kare.
  3. MPIN verify par naya `sessionId` issue karo (rotation) — purana cookie invalid.
- **Recommendation:** option 1 + `unlockedUntil` (defence in depth). Settings/overview jaise sensitive APIs ke liye `requireUnlock` add karo.

#### 🔴 P0-3 — Trusted proxy headers / real IP spoofing

- **Problem:** `getClientIp` `x-forwarded-for` ko blindly trust karta hai. Agar Node app direct internet par exposed hai, koi bhi `X-Forwarded-For: 1.2.3.4` bhej kar audit IP forge kar sakta hai (aur IP-bound OTP bypass).
- **Fix:** VM par app sirf `127.0.0.1:3000` par bind karo; Nginx reverse proxy se aaye `X-Forwarded-For` ko **overwrite** karo (`proxy_set_header X-Forwarded-For $remote_addr;`), ya trusted proxy list implement karo. Direct port 3000 firewall se band.

#### 🔴 P0-4 — Production me dev OTP leak na ho

- **Problem:** `AUTH_OTP_DEV_FALLBACK` default `true` outside production. Agar VM par `NODE_ENV` galat raha to OTP response me `devOtp` aa sakta hai.
- **Fix:** `npm start` use karo (ye `node server.mjs --production` chalata hai; Next `NODE_ENV=production` set karta hai). Systemd me `Environment=NODE_ENV=production` bhi rakho. `AUTH_OTP_DEV_FALLBACK=false` explicit set karo.

#### 🟠 P1-1 — WebAuthn challenge user-scoped nahi

- **Problem:** `takeChallenge(type)` sirf `type` se latest challenge uthata hai, `userId` filter nahi. `verifyAuthentication` credential ka `userId` session user se compare nahi karta.
- **Impact:** Single-owner hone ki wajah se practical impact kam, lekin future multi-user/credential confusion me galat challenge accept ho sakta hai.
- **Fix:** `takeChallenge(type, userId)` + `stored.userId === auth.user._id` check.

#### 🟠 P1-2 — `devices/revoke` session ownership check missing

- **Problem:** `{ sessionId }` branch `revokeSessionDoc(sessionId)` calls without verifying `userId`. Single-owner me dusra user nahi, lekin future me IDOR.
- **Fix:** `revokeSessionDoc(sessionId, userId, reason)` filter ya pehle `getSessionDoc` + owner compare.

#### 🟠 P1-3 — Rate limit per-process

- **Problem:** In-memory Map. Multi-instance/serverless par har instance ka alag counter. Restart par reset.
- **Fix:** Single VM par acceptable; multi-instance par Mongo/Redis backed limiter. Document karo.

#### 🟠 P1-4 — WS gate sirf HMAC, DB revocation nahi

- **Problem:** Revoked session ka cookie `exp` tak WS connect kar sakta hai. Page/API 10s me band ho jate hain, WS nahi.
- **Fix:** WS upgrade par Mongo session row check (async) ya short-lived WS ticket endpoint.

#### 🟠 P1-5 — Docs collection names mismatch (fixed)

- `docs/AUTH_SECURITY.md` updated to actual names.

#### 🟡 P2-1 — `AUTH_SIGNUP_MPIN=123456` weak

- Signup gate MPIN `validateMpin` se nahi guzarta (sirf env compare). `123456` guessable hai.
- **Fix:** strong random 6-digit (weak list/sequential nahi) VM par.

#### 🟡 P2-2 — Session/OTP secret fallback file

- Agar `AUTH_SESSION_SECRET` missing, `.auth/session-secret` generate hota hai. Container/ephemeral FS par restart = sessions invalid; multiple replicas = alag secrets.
- **Fix:** production me env se mandatory; `.auth` ko persistent volume par rakho (agar fallback use karna hi ho).

#### 🟡 P2-3 — Event retention nahi

- `app_auth_events` indefinitely grow karega. TTL index (e.g. 180 days) ya archival job add karo.

#### 🟡 P2-4 — Login page device meter stale

- Login page `AuthProvider` poll subscribe nahi karta; dusre device ke login/logout ka count turant update nahi hota. Login attempt par fresh count aata hai.
- **Fix:** login page par `useAuth().deviceCount` use karo ya 30s poll.

#### 🟡 P2-5 — CSRF

- `SameSite=Lax` + JSON content-type se cross-site POST mitigate hota hai, custom CSRF token nahi. Sensitive routes ke liye origin check add kar sakte ho.

#### 🟡 P2-6 — WebAuthn 127.0.0.1 par supported nahi

- RP ID IP nahi ho sakta. `http://127.0.0.1:3000` par biometric error dega. `http://localhost:3000` use karo, ya domain + HTTPS + `AUTH_RP_ID`/`AUTH_ORIGIN`.
- Dev origin alias (`localhost` ↔ `127.0.0.1`) code me hai, lekin RP ID hostname se aata hai; isliye `AUTH_RP_ID=localhost` set karke `http://localhost:3000` kholna best hai.

#### 🟡 P2-7 — Status endpoint information

- Public status `hasOwner`, masked signup email, `mailerConfigured`, `devOtp` batata hai. Ye bootstrap ke liye zaroori hai, lekin `signupEmailMasked` se email enumeration ho sakti hai. Acceptable (single owner), note only.

#### 🟡 P2-8 — Vercel par custom server / WS

- `server.mjs` Vercel serverless par nahi chalega; WS tunnel VM/Nginx par hi chalega. Agar Vercel deploy karna hai to WS alag service par hoga. Auth HTTP part Vercel par chal sakta hai (proxy + Mongo Atlas + SMTP).

---

## 10. Jo abhi karna hai (action checklist)

### P0 — production se pehle

- [ ] `AUTH_SMTP_PASS` me real Gmail App Password (16 chars, no spaces) → restart → `mailerConfigured:true`.
- [ ] Server-side unlock enforcement add karo (P0-2).
- [ ] Nginx + firewall: app sirf loopback par; `X-Forwarded-For` overwrite; direct 3000 band.
- [ ] `NODE_ENV=production` + `AUTH_OTP_DEV_FALLBACK=false` VM par.
- [ ] `AUTH_SIGNUP_MPIN` strong random.
- [ ] `AUTH_SESSION_SECRET` persistent env (backup me rakho).
- [ ] `AUTH_RP_ID` + `AUTH_ORIGIN` domain/HTTPS set.
- [ ] Fresh Mongo DB par signup test.

### P1 — hardening

- [ ] WebAuthn challenge user-scoped + credential ownership check.
- [ ] `devices/revoke` ownership check.
- [ ] WS revoke check.
- [ ] Multi-instance rate limiter (agar applicable).
- [ ] Event retention/TTL.
- [ ] Login page device count live.

### P2 — polish

- [ ] CSRF token/origin check.
- [ ] Backup + restore drill.
- [ ] Monitoring/alert on repeated login failures and OTP delivery failures.
- [ ] Audit log export (Settings me CSV/JSON).
- [ ] Session list me "last seen" relative time.

---

## 11. Local setup — abhi is machine par

### 11.1 Prerequisites

- Node.js 20+ (repo Node 24 use kar raha hai).
- MongoDB reachable (Atlas via `python-service/.env`).
- Port 3000 free.

### 11.2 Current run

```powershell
cd C:\project
node server.mjs          # dev, HMR
# ya
npm start                # production build + server (build pehle karo)
```

Status check:

```powershell
Invoke-WebRequest http://127.0.0.1:3000/api/auth/status -UseBasicParsing |
  Select-Object -ExpandProperty Content
```

Expected abhi:

```json
{
  "ok": true,
  "signupConfigured": true,
  "mailerConfigured": false,
  "devOtp": true,
  "maxDevices": 2,
  "hasOwner": true,
  "needsSignup": false,
  "authenticated": false
}
```

### 11.3 Pehli baar (fresh DB) test

1. `AUTH_MONGODB_DB` naya DB name do (ya Mongo me naya DB).
2. Server start karo.
3. `http://127.0.0.1:3000/login` → signup form.
4. Env email + signup MPIN daalo, naya password (10+ chars, upper/lower/digit).
5. MPIN setup screen → 6-digit strong MPIN.
6. Workspace khulega.
7. `/login` dobara → signup nahi, login form.

### 11.4 Existing owner (current DB)

- `/login` par email/name + password.
- Same device (localStorage `kaustubh_device_id` same) → no OTP.
- MPIN unlock → workspace.
- Signup route `409 OWNER_EXISTS`.

> `AUTH_SESSION_SECRET` rotate hone ki wajah se purana session invalid ho sakta hai; dobara login karo.

---

## 12. Gmail App Password (OTP email)

1. Google Account → **Security**.
2. **2-Step Verification** ON karo.
3. **App passwords** → app name `KAUSTUBH` → generate.
4. 16-character password milega (4 groups of 4).
5. `.env` me spaces **hata kar** paste karo:

```env
AUTH_SMTP_HOST=smtp.gmail.com
AUTH_SMTP_PORT=587
AUTH_SMTP_SECURE=false
AUTH_SMTP_USER=owner@example.com
AUTH_SMTP_PASS=abcdefghijklmnop
AUTH_EMAIL_FROM="KAUSTUBH Security <owner@example.com>"
AUTH_EMAIL_TO=owner@example.com
```

6. Server restart.
7. Status me `mailerConfigured:true` verify karo.
8. Second device/browser se login → OTP email aayega.

**Agar Gmail block kare:**

- Port `465` + `AUTH_SMTP_SECURE=true`.
- Ya Brevo/Resend/SendGrid SMTP.
- Ya `AUTH_OTP_WEBHOOK_URL` (SMTP se priority).

**Security:** App Password ko chat/git me kabhi commit mat karo. `.env` already git-ignored hai.

---

## 13. VM deployment — fresh MongoDB + domain + HTTPS

### 13.1 Architecture

```
Internet
  └─ Nginx :443 (TLS, domain)
       ├─ /            → Next app 127.0.0.1:3000
       └─ /ws/realtime → same app (Upgrade headers)
  Next custom server (server.mjs)
       ├─ MongoDB 127.0.0.1:27017 (auth + app data)
       └─ Python backend 127.0.0.1:8000 (server-only)
```

### 13.2 Steps

1. **Server prepare**
   - Ubuntu 22.04/24.04, Node 20/22, MongoDB 7, Nginx, Certbot.
   - Non-root user `kaustubh`.

2. **Code**
   ```bash
   git clone <repo> /opt/kaustubh
   cd /opt/kaustubh
   npm ci
   npm run build
   ```

3. **MongoDB**
   ```bash
   sudo systemctl enable --now mongod
   mongosh --eval 'db.getSiblingDB("kaustubh_vm").stats()'
   ```
   Fresh DB name e.g. `kaustubh_vm` (purane `kaustubh` se alag).

4. **Env** (`/opt/kaustubh/.env`, mode 600)
   ```dotenv
   NODE_ENV=production
   AUTH_MONGODB_URI=mongodb://127.0.0.1:27017
   AUTH_MONGODB_DB=kaustubh_vm

   AUTH_SIGNUP_EMAIL=owner@yourdomain.com
   AUTH_SIGNUP_MPIN=<strong-random-6-digit>

   AUTH_SESSION_SECRET=<64+ random chars>
   AUTH_MAX_ACTIVE_SESSIONS=2

   AUTH_SMTP_HOST=smtp.gmail.com
   AUTH_SMTP_PORT=587
   AUTH_SMTP_SECURE=false
   AUTH_SMTP_USER=owner@yourdomain.com
   AUTH_SMTP_PASS=<gmail-app-password>
   AUTH_EMAIL_FROM="KAUSTUBH Security <owner@yourdomain.com>"
   AUTH_EMAIL_TO=owner@yourdomain.com
   AUTH_OTP_DEV_FALLBACK=false

   AUTH_RP_ID=terminal.yourdomain.com
   AUTH_ORIGIN=https://terminal.yourdomain.com
   AUTH_RP_NAME=KAUSTUBH Trading Platform

   BACKEND_URL=http://127.0.0.1:8000
   WS_BACKEND_URL=http://127.0.0.1:8000
   ```
   > `AUTH_SIGNUP_EMAIL` wahi email jo owner use karega. `AUTH_EMAIL_TO` OTP receive karega.

5. **Systemd** `/etc/systemd/system/kaustubh.service`
   ```ini
   [Unit]
   Description=KAUSTUBH
   After=network.target mongod.service

   [Service]
   Type=simple
   User=kaustubh
   WorkingDirectory=/opt/kaustubh
   Environment=NODE_ENV=production
   EnvironmentFile=/opt/kaustubh/.env
   ExecStart=/usr/bin/node server.mjs --production
   Restart=always
   RestartSec=5
   NoNewPrivileges=true
   PrivateTmp=true

   [Install]
   WantedBy=multi-user.target
   ```
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now kaustubh
   ```

6. **Nginx** `/etc/nginx/sites-available/kaustubh`
   ```nginx
   server {
     listen 80;
     server_name terminal.yourdomain.com;
     return 301 https://$host$request_uri;
   }

   server {
     listen 443 ssl http2;
     server_name terminal.yourdomain.com;

     ssl_certificate     /etc/letsencrypt/live/terminal.yourdomain.com/fullchain.pem;
     ssl_certificate_key /etc/letsencrypt/live/terminal.yourdomain.com/privkey.pem;

     location / {
       proxy_pass http://127.0.0.1:3000;
       proxy_http_version 1.1;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $remote_addr;   # overwrite, never append
       proxy_set_header X-Forwarded-Proto $scheme;
     }

     location /ws/ {
       proxy_pass http://127.0.0.1:3000;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $remote_addr;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_read_timeout 3600s;
     }
   }
   ```
   ```bash
   sudo ln -s /etc/nginx/sites-available/kaustubh /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot --nginx -d terminal.yourdomain.com
   ```

7. **Firewall**
   ```bash
   sudo ufw allow 22,80,443/tcp
   sudo ufw deny 3000
   sudo ufw deny 27017
   sudo ufw deny 8000
   sudo ufw enable
   ```

8. **First owner**
   - `https://terminal.yourdomain.com/login`
   - Signup form dikhega (fresh DB).
   - Env email + signup MPIN → account.
   - MPIN setup → workspace.
   - Dobara `/login` → signup band.

9. **Verify**
   ```bash
   curl -s https://terminal.yourdomain.com/api/auth/status | jq
   # hasOwner true, needsSignup false, mailerConfigured true
   ```

### 13.3 WebAuthn checklist

- [ ] Domain HTTPS par khul raha hai.
- [ ] `AUTH_RP_ID` = exact hostname (no port, no scheme).
- [ ] `AUTH_ORIGIN` = exact `https://host`.
- [ ] Browser me `https://.../data-saver/settings/security`.
- [ ] Register fingerprint/face.
- [ ] Logout → login → biometric unlock.
- [ ] Agar Windows Hello na dikhe: OS biometric setup + browser support check.

### 13.4 Fresh DB signup reset (sirf naye DB par)

```bash
# Sirf tab jab naya/khali DB ho. Purana data delete mat karo.
mongosh "mongodb://127.0.0.1:27017/kaustubh_vm" --eval '
  db.app_auth_sessions.deleteMany({});
  db.app_auth_events.deleteMany({});
  db.app_auth_pending_logins.deleteMany({});
  db.app_auth_webauthn.deleteMany({});
  db.app_auth_webauthn_challenges.deleteMany({});
  db.app_auth_users.deleteMany({});
'
sudo systemctl restart kaustubh
```

> `app_auth_users` delete = owner gone = signup wapas. Ye **destructive** hai; backup pehle.

---

## 14. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Signup form nahi dikh raha | Owner already exists | `/login` par login karo; fresh DB par hi signup. |
| `409 OWNER_EXISTS` | DB me owner hai | Dobara signup mat karo. |
| `409 NO_OWNER` | Owner nahi hai | Signup complete karo. |
| `401 SIGNUP_MISMATCH` | Env email/MPIN galat | `.env` values check karo, restart. |
| `503 SIGNUP_NOT_CONFIGURED` | Env missing | `AUTH_SIGNUP_EMAIL` + `AUTH_SIGNUP_MPIN` set karo. |
| `400 IP_REQUIRED` | Production me IP header nahi | Nginx `X-Forwarded-For` set karo; direct access band. |
| `403 DEVICE_LIMIT_REACHED` | 2 devices active | Settings → Security se revoke karo. |
| OTP email nahi aaya | `AUTH_SMTP_PASS` empty/wrong | App Password, spaces remove, restart, `mailerConfigured:true`. |
| OTP UI me dikh raha, email nahi | Dev fallback | Production me `NODE_ENV=production` + `AUTH_OTP_DEV_FALLBACK=false`. |
| `503 OTP_DELIVERY_FAILED` | SMTP/webhook fail | SMTP credentials/port check; Gmail 465 try. |
| `403 OTP_IP_MISMATCH` | Network badla | Same network se dobara login karo. |
| `410 OTP_EXPIRED` | 10 min paar | Resend. |
| MPIN setup ke baad bhi app band | Pending cookie stuck | Logout/login; cookie clear; server restart. |
| `MPIN_SETUP_REQUIRED` | Pehle MPIN set nahi | Setup screen complete karo. |
| MPIN galat 5 baar | 5-min lock | 5 min wait ya DB me lock clear (owner only). |
| Biometric option nahi | IP/localhost issue | `http://localhost:3000` ya domain HTTPS + `AUTH_RP_ID`. |
| Biometric cancelled | User cancel / OS prompt | Dobara try; Windows Hello setup check. |
| `401 UNAUTHENTICATED` bar-bar | Secret rotate / cookie clear | Dobara login. |
| Mongo 503 | URI/DB/network | `AUTH_MONGODB_URI`, Atlas IP allowlist, service status. |
| Login page DB error | Mongo down | Mongo start; proxy fail-closed behaviour. |
| Port 3000 already in use | Dusra server | `Get-NetTCPConnection -LocalPort 3000`, purana process band. |
| CRLF trailing whitespace | Windows autocrlf | `git -c core.whitespace=cr-at-eol diff --check`. |
| Lint fail | Pre-existing hook rule | `app/_pages/data-server-settings/page.tsx:208` (auth se related nahi). |

---

## 15. Operations runbook

### 15.1 Owner inspect (safe, masked)

```js
// mongosh "mongodb://127.0.0.1:27017/kaustubh"
db.app_auth_users.find({}, {
  email: 1, name: 1, createdAt: 1, lastLoginAt: 1,
  mpinHash: 1, mpinUpdatedAt: 1
}).forEach(u => printjson({
  ...u,
  email: u.email.replace(/^(.).*(@.*)$/, '$1***$2'),
  mpinHash: Boolean(u.mpinHash)
}));
```

### 15.2 Active sessions

```js
db.app_auth_sessions.find(
  { revokedAt: null, expiresAt: { $gt: new Date() } },
  { sessionId: 0, userAgent: 0 }
).sort({ createdAt: -1 }).forEach(printjson);
```

### 15.3 Recent events

```js
db.app_auth_events.find({}, { ip: 1, type: 1, at: 1, detail: 1 })
  .sort({ at: -1 }).limit(20).forEach(printjson);
```

### 15.4 Force logout all devices (keep owner)

```js
db.app_auth_sessions.updateMany(
  { revokedAt: null },
  { $set: { revokedAt: new Date(), revokedReason: 'admin_logout' } }
);
```

Phir browser cookies clear / server restart.

### 15.5 Clear MPIN lockout

```js
db.app_auth_users.updateOne(
  { singleton: 'owner' },
  { $set: { mpinFailedAttempts: 0, mpinLockedUntil: null } }
);
```

### 15.6 Clear password lockout

```js
db.app_auth_users.updateOne(
  { singleton: 'owner' },
  { $set: { passwordFailedAttempts: 0, passwordLockedUntil: null } }
);
```

### 15.7 Rotate session secret (logout everyone)

```bash
# 64+ hex chars
openssl rand -hex 32
# .env me AUTH_SESSION_SECRET update
sudo systemctl restart kaustubh
```

### 15.8 Backup auth collections

```bash
mongodump --uri="mongodb://127.0.0.1:27017/kaustubh_vm" \
  --collection=app_auth_users \
  --out=/backup/$(date +%F)
mongodump --uri="mongodb://127.0.0.1:27017/kaustubh_vm" \
  --collection=app_auth_sessions \
  --out=/backup/$(date +%F)
```

### 15.9 Remove a stuck WebAuthn credential

```js
db.app_auth_webauthn.deleteOne({ credentialId: '<id>' });
```

> Sirf tab jab MPIN set ho, warna lockout risk.

---

## 16. Test & acceptance checklist

### 16.1 Commands

```bash
npm run typecheck
npm test
npm run build
npm start          # production mode
```

- `typecheck` clean.
- `npm test` 462/462 pass (last run).
- Production build pass.
- Production E2E 45/45 (disposable Atlas DB, last run).

### 16.2 Manual acceptance (fresh DB)

- [ ] `/login` → signup form.
- [ ] Galat email/MPIN → `401`.
- [ ] Sahi signup → MPIN setup screen.
- [ ] MPIN setup ke bina protected URL → `/login?from=...`.
- [ ] MPIN setup ke bina protected API → `403 MPIN_SETUP_REQUIRED`.
- [ ] MPIN set → workspace.
- [ ] Logout → login form (signup nahi).
- [ ] Same device login → no OTP.
- [ ] Second browser/incognito → OTP screen (dev OTP ya email).
- [ ] OTP galat → attempts decrease.
- [ ] OTP sahi → login + device count 2/2.
- [ ] Teesra browser → `403 DEVICE_LIMIT_REACHED`.
- [ ] Settings → Security se dusra device revoke → slot free.
- [ ] Revoked device 10s ke andar logout.
- [ ] MPIN galat 5 baar → 5-min lock.
- [ ] Password galat 8 baar → 15-min lock.
- [ ] Biometric register (localhost/HTTPS).
- [ ] Logout → biometric unlock.
- [ ] MPIN remove bina biometric → blocked.
- [ ] Last biometric remove bina MPIN → blocked.
- [ ] `/api/auth/events` me real IP events.
- [ ] Mongo down → login page error, no fake session.
- [ ] Browser bundle me backend URL nahi (`grep` dist).
- [ ] WS unauth → 401.
- [ ] `AUTH_SESSION_SECRET` rotate → purane sessions invalid.

### 16.3 VM acceptance

- [ ] `https://domain/api/auth/status` → `mailerConfigured:true`, `hasOwner:false`.
- [ ] Signup → owner created.
- [ ] Restart → owner persists, signup closed.
- [ ] Second device OTP email actual inbox me.
- [ ] `AUTH_RP_ID`/`AUTH_ORIGIN` set → biometric works.
- [ ] Nginx `X-Forwarded-For` overwrite → audit me public IP.
- [ ] Direct `http://IP:3000` blocked by firewall.
- [ ] MongoDB/8000 ports public nahi.
- [ ] Backup + restore test.

---

## 17. Quick decision guide

| Situation | Kya karo |
| --- | --- |
| Naya laptop/phone | Login → OTP (agar dusra device active) → MPIN/biometric. |
| 2 devices full | Purane device par logout, ya Settings → Security → revoke. |
| Password bhool gaye | DB se owner delete karke fresh signup (destructive), ya backup restore. |
| MPIN bhool gaye | Biometric se unlock; biometric nahi to DB me `mpinHash` clear? **Nahi** — bina unlock method ke lockout. Isliye biometric + MPIN dono rakho. |
| Phone kho gaya | Kisi dusre signed-in device se Settings → Security → us device ko revoke. |
| Dono devices kho gaye | Password se login possible nahi (device slots full) — Settings access nahi. Admin recovery: DB me sessions revoke + MPIN/biometric reset (owner-only, destructive). |
| OTP email nahi aa raha | SMTP pass/port check; dev me UI/log; production me webhook alternative. |
| Biometric kaam nahi kar raha | `localhost`/HTTPS + `AUTH_RP_ID` check. |
| VM par signup nahi dikh raha | `app_auth_users` me owner hai; naya DB chahiye. |

---

## 18. Summary — ek line me

**Auth system ready hai aur locally kaam kar raha hai; production se pehle 4 cheezein zaroori hain: (1) SMTP App Password, (2) server-side unlock enforcement, (3) trusted-proxy IP setup, (4) VM par `NODE_ENV=production` + fresh Mongo signup test.**
