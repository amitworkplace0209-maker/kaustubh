import type { NextRequest } from 'next/server';
import { randomBytes, randomUUID } from 'crypto';
import { generateOtp, hashOtp, newDeviceId, verifySecret } from '@/lib/auth-crypto';
import {
  getClientIp,
  getMaxActiveSessions,
  getSignupEmail,
  maskEmail,
} from '@/lib/auth-config';
import {
  createPendingDoc,
  getOwner,
  listActiveSessions,
  listCredentials,
  recordAuthEvent,
  resolvePendingDoc,
  updateOwner,
} from '@/lib/auth-db';
import { deliverOtp } from '@/lib/auth-mail';
import { checkRateLimit, LIMITS } from '@/lib/auth-rate-limit';
import { issueSessionForUser, setAuthCookies } from '@/lib/auth-sessions';
import {
  fail,
  json,
  normalizeEmail,
  publicSession,
  publicUser,
  readJson,
  safeDeviceId,
  safeDeviceLabel,
} from '@/lib/auth-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MAX_PASSWORD_FAILURES = 8;
const PASSWORD_LOCK_MS = 15 * 60 * 1000;
const OTP_TTL_MS = 10 * 60 * 1000;

/**
 * POST /api/auth/login
 *
 * Password login for the single owner, from anywhere.
 *
 * Device policy (enforced server-side, not in the UI):
 *   • first device            → session, no OTP
 *   • second distinct device   → fresh email OTP EVERY time, then a session
 *   • third distinct device    → blocked (max 2 concurrent devices)
 *   • repeat login on a known device → cookie rotation, no OTP
 *
 * Every attempt — successful or not — is written to `app_auth_events` with the
 * real client IP. A login cannot proceed without a resolvable IP.
 */
export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  if (!ip) {
    return fail('Cannot verify your IP address, so login is blocked. Connect through the app proxy and retry.', 400, {
      code: 'IP_REQUIRED',
    });
  }

  const limit = checkRateLimit(`login:${ip}`, LIMITS.login.limit, LIMITS.login.windowMs);
  if (!limit.allowed) {
    return fail(`Too many login attempts. Try again in ${limit.retryAfterSec}s.`, 429);
  }

  const body = await readJson(request);
  if (!body) return fail('Invalid request body.', 400);

  const identifier = normalizeEmail(body.email) || String(body.name ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  if (!identifier || !password) {
    return fail('Enter your email and password.', 400);
  }

  const deviceId = safeDeviceId(body.deviceId) || newDeviceId();
  const deviceLabel = safeDeviceLabel(body.deviceLabel, request.headers.get('user-agent') || 'This device');
  const userAgent = request.headers.get('user-agent') || 'unknown';

  let owner;
  try {
    owner = await getOwner();
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'The auth database is unavailable.', 503, { database: false });
  }

  if (!owner) {
    return fail('No owner account exists yet. Create it once, then log in.', 409, {
      code: 'NO_OWNER',
      needsSignup: true,
    });
  }

  const lockedUntil = Number(owner.passwordLockedUntil ?? 0);
  if (lockedUntil > Date.now()) {
    return fail(
      `Too many failed logins. Try again in ${Math.ceil((lockedUntil - Date.now()) / 60_000)} minute(s).`,
      429,
    );
  }

  const identifierMatches = identifier === owner.emailLower || identifier === owner.nameLower;
  const passwordMatches = identifierMatches && (await verifySecret(password, owner.passwordHash));
  if (!passwordMatches) {
    const attempts = Number(owner.passwordFailedAttempts ?? 0) + 1;
    const lock = attempts >= MAX_PASSWORD_FAILURES;
    try {
      await updateOwner({
        passwordFailedAttempts: lock ? 0 : attempts,
        passwordLockedUntil: lock ? Date.now() + PASSWORD_LOCK_MS : null,
      });
      await recordAuthEvent({
        type: 'login_failed',
        userId: String(owner._id),
        ip,
        userAgent,
        deviceId,
        deviceLabel,
        success: false,
        detail: lock ? 'Password locked for 15 minutes' : `Failed password attempt ${attempts}`,
      });
    } catch {
      /* audit failure must not mask the auth verdict */
    }
    return fail(
      lock
        ? 'Too many failed logins. Locked for 15 minutes.'
        : 'Incorrect email or password.',
      lock ? 429 : 401,
    );
  }

  try {
    await updateOwner({
      passwordFailedAttempts: 0,
      passwordLockedUntil: null,
      lastLoginAt: new Date().toISOString(),
    });
  } catch {
    /* non-fatal */
  }

  let active;
  try {
    active = await listActiveSessions(String(owner._id));
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'The auth database is unavailable.', 503, { database: false });
  }

  const activeDeviceIds = new Set(active.map((s) => s.deviceId));
  const maxDevices = getMaxActiveSessions();
  const isNewDevice = !activeDeviceIds.has(deviceId);

  if (isNewDevice && activeDeviceIds.size >= maxDevices) {
    try {
      await recordAuthEvent({
        type: 'login_failed',
        userId: String(owner._id),
        ip,
        userAgent,
        deviceId,
        deviceLabel,
        success: false,
        detail: `Device limit reached (${activeDeviceIds.size}/${maxDevices})`,
      });
    } catch {
      /* non-fatal */
    }
    return fail(
      `All ${maxDevices} device slots are in use. Sign out on another device (or revoke it in Settings → Security) before signing in here.`,
      403,
      {
        code: 'DEVICE_LIMIT_REACHED',
        deviceCount: activeDeviceIds.size,
        maxDevices,
        sessions: active.map((s) => publicSession(s)),
      },
    );
  }

  if (isNewDevice && activeDeviceIds.size > 0) {
    // A second distinct device always requires a fresh one-time code.
    const otp = generateOtp();
    const pendingId = randomUUID();
    const salt = randomBytes(16).toString('base64url');
    const to = getSignupEmail() || owner.email;

    try {
      await createPendingDoc({
        pendingId,
        userId: String(owner._id),
        deviceId,
        deviceLabel,
        ip,
        userAgent,
        otpSalt: salt,
        otpHash: hashOtp(otp, salt),
        attempts: 0,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
        status: 'pending',
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message : 'Could not start OTP verification.', 503);
    }

    const delivery = await deliverOtp({ otp, deviceLabel, ip, to });
    await recordAuthEvent({
      type: 'login_otp_requested',
      userId: String(owner._id),
      ip,
      userAgent,
      deviceId,
      deviceLabel,
      success: delivery.delivered,
      detail: delivery.delivered
        ? `OTP sent via ${delivery.channel}`
        : delivery.reason || 'OTP delivery failed',
    });

    if (!delivery.delivered) {
      await resolvePendingDoc(pendingId, 'denied').catch(() => {});
      return fail(
        delivery.reason || 'Could not deliver the login code. Configure AUTH_SMTP_* or AUTH_OTP_WEBHOOK_URL.',
        503,
        { code: 'OTP_DELIVERY_FAILED' },
      );
    }

    return json(
      {
        ok: false,
        authenticated: false,
        needsOtp: true,
        pendingId,
        deviceId,
        deviceLabel,
        maskedEmail: maskEmail(to),
        channel: delivery.channel,
        devOtp: delivery.devOtp,
        expiresInSec: Math.floor(OTP_TTL_MS / 1000),
        maxDevices,
        activeDevices: activeDeviceIds.size,
        message: `A fresh 6-digit code was sent to ${maskEmail(to)}. Enter it to sign in on this second device.`,
      },
      202,
    );
  }

  try {
    const issued = await issueSessionForUser({
      request,
      user: owner,
      deviceId,
      deviceLabel,
      kind: activeDeviceIds.size === 0 ? 'primary' : 'secondary',
    });
    const needsMpinSetup = !owner.mpinHash;
    const credentials = await listCredentials(String(owner._id)).catch(() => []);
    await setAuthCookies(request, issued, needsMpinSetup && credentials.length === 0);

    await recordAuthEvent({
      type: 'login',
      userId: String(owner._id),
      ip,
      userAgent,
      deviceId,
      deviceLabel,
      sessionId: issued.session.sessionId,
      success: true,
      detail: `Login from ${ip}`,
    });

    const sessions = await listActiveSessions(String(owner._id));
    const devices = new Set(sessions.map((s) => s.deviceId));

    return json({
      ok: true,
      authenticated: true,
      needsMpinSetup: needsMpinSetup && credentials.length === 0,
      needsUnlock: Boolean(owner.mpinHash) || credentials.length > 0,
      user: publicUser(owner),
      deviceId,
      sessionId: issued.session.sessionId,
      deviceCount: devices.size,
      maxDevices,
      sessions: sessions.map((s) => publicSession(s, issued.session.sessionId)),
      message: needsMpinSetup && credentials.length === 0 ? 'Set your MPIN to open the app.' : 'Welcome back.',
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Login failed.', 500);
  }
}

/**
 * Legacy callers (archived sidebar/topbar components) used
 * `DELETE /api/auth/login` as logout. Keep that working.
 */
export async function DELETE(request: NextRequest) {
  const { clearAuthCookies, getSessionFromRequest } = await import('@/lib/auth-sessions');
  const { revokeSessionDoc, recordAuthEvent } = await import('@/lib/auth-db');
  try {
    const active = await getSessionFromRequest(request);
    if (active) {
      await revokeSessionDoc(active.session.sessionId, 'logout');
      await recordAuthEvent({
        type: 'logout',
        userId: String(active.user._id),
        ip: getClientIp(request) || 'unknown',
        userAgent: request.headers.get('user-agent') || 'unknown',
        deviceId: active.session.deviceId,
        deviceLabel: active.session.deviceLabel,
        sessionId: active.session.sessionId,
        success: true,
        detail: 'Logged out (legacy DELETE)',
      });
    }
  } catch {
    /* clearing the cookie is still the right answer */
  }
  await clearAuthCookies();
  return json({ ok: true, authenticated: false });
}
