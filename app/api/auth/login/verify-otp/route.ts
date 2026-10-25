import type { NextRequest } from 'next/server';
import { verifyOtp } from '@/lib/auth-crypto';
import { getClientIp, getMaxActiveSessions } from '@/lib/auth-config';
import {
  getOwner,
  getPendingDoc,
  incrementPendingAttempts,
  listActiveSessions,
  listCredentials,
  recordAuthEvent,
  resolvePendingDoc,
} from '@/lib/auth-db';
import { checkRateLimit, LIMITS } from '@/lib/auth-rate-limit';
import { issueSessionForUser, setAuthCookies } from '@/lib/auth-sessions';
import {
  fail,
  json,
  publicSession,
  publicUser,
  readJson,
  safeDeviceLabel,
} from '@/lib/auth-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MAX_OTP_ATTEMPTS = 5;

/**
 * POST /api/auth/login/verify-otp
 *
 * Completes the second-device login. The OTP is single-use, expires in 10
 * minutes, and is stored only as an HMAC. The device-limit check is repeated
 * here because another device may have connected meanwhile.
 */
export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  if (!ip) return fail('Cannot verify your IP address, so login is blocked.', 400, { code: 'IP_REQUIRED' });

  const limit = checkRateLimit(`otp:${ip}`, LIMITS.otpVerify.limit, LIMITS.otpVerify.windowMs);
  if (!limit.allowed) {
    return fail(`Too many code attempts. Try again in ${limit.retryAfterSec}s.`, 429);
  }

  const body = await readJson(request);
  if (!body) return fail('Invalid request body.', 400);

  const pendingId = String(body.pendingId ?? '').trim();
  const otp = String(body.otp ?? '').trim();
  if (!pendingId || !/^\d{6}$/.test(otp)) {
    return fail('Enter the 6-digit code from your email.', 400);
  }

  let pending;
  try {
    pending = await getPendingDoc(pendingId);
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'The auth database is unavailable.', 503);
  }

  if (!pending) return fail('This login request no longer exists. Start again.', 404, { code: 'OTP_NOT_FOUND' });
  if (pending.status !== 'pending') {
    return fail('This code was already used. Start the login again.', 409, { code: 'OTP_ALREADY_USED' });
  }
  if (pending.expiresAt.getTime() <= Date.now()) {
    await resolvePendingDoc(pendingId, 'expired').catch(() => {});
    return fail('That code expired. Start the login again to get a fresh one.', 410, { code: 'OTP_EXPIRED' });
  }
  if (pending.attempts >= MAX_OTP_ATTEMPTS) {
    await resolvePendingDoc(pendingId, 'denied').catch(() => {});
    return fail('Too many incorrect codes for this request. Start the login again.', 429);
  }
  if (pending.ip !== ip) {
    await recordAuthEvent({
      type: 'login_otp_failed',
      userId: pending.userId,
      ip,
      userAgent: request.headers.get('user-agent') || 'unknown',
      deviceId: pending.deviceId,
      deviceLabel: pending.deviceLabel,
      success: false,
      detail: `OTP presented from a different IP (expected ${pending.ip})`,
    }).catch(() => {});
    return fail('This code was issued to a different network. Start the login again.', 403, { code: 'OTP_IP_MISMATCH' });
  }

  if (!verifyOtp(otp, pending.otpSalt, pending.otpHash)) {
    await incrementPendingAttempts(pendingId).catch(() => {});
    await recordAuthEvent({
      type: 'login_otp_failed',
      userId: pending.userId,
      ip,
      userAgent: request.headers.get('user-agent') || 'unknown',
      deviceId: pending.deviceId,
      deviceLabel: pending.deviceLabel,
      success: false,
      detail: 'Incorrect OTP',
    }).catch(() => {});
    const left = MAX_OTP_ATTEMPTS - pending.attempts - 1;
    return fail(`Incorrect code. ${Math.max(0, left)} attempt(s) left.`, 401);
  }

  const deviceLabel = safeDeviceLabel(body.deviceLabel, pending.deviceLabel);
  const userAgent = request.headers.get('user-agent') || 'unknown';

  let owner;
  let sessions;
  try {
    owner = await getOwner();
    if (!owner) return fail('No owner account exists.', 409, { code: 'NO_OWNER' });
    sessions = await listActiveSessions(String(owner._id));
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'The auth database is unavailable.', 503);
  }

  const maxDevices = getMaxActiveSessions();
  const deviceIds = new Set(sessions.map((s) => s.deviceId));
  if (!deviceIds.has(pending.deviceId) && deviceIds.size >= maxDevices) {
    await resolvePendingDoc(pendingId, 'denied').catch(() => {});
    return fail(
      `All ${maxDevices} device slots are in use. Sign out elsewhere and try again.`,
      403,
      { code: 'DEVICE_LIMIT_REACHED', deviceCount: deviceIds.size, maxDevices },
    );
  }

  try {
    await resolvePendingDoc(pendingId, 'approved');
    const issued = await issueSessionForUser({
      request,
      user: owner,
      deviceId: pending.deviceId,
      deviceLabel,
      kind: deviceIds.size === 0 ? 'primary' : 'secondary',
    });
    const needsMpinSetup = !owner.mpinHash;
    const credentials = await listCredentials(String(owner._id)).catch(() => []);
    await setAuthCookies(request, issued, needsMpinSetup && credentials.length === 0);

    await recordAuthEvent({
      type: 'login_otp_verified',
      userId: String(owner._id),
      ip,
      userAgent,
      deviceId: pending.deviceId,
      deviceLabel,
      sessionId: issued.session.sessionId,
      success: true,
      detail: `Second-device OTP verified from ${ip}`,
    });
    await recordAuthEvent({
      type: 'login',
      userId: String(owner._id),
      ip,
      userAgent,
      deviceId: pending.deviceId,
      deviceLabel,
      sessionId: issued.session.sessionId,
      success: true,
      detail: `Login from ${ip} (OTP)`,
    });

    const after = await listActiveSessions(String(owner._id));
    const devices = new Set(after.map((s) => s.deviceId));

    return json({
      ok: true,
      authenticated: true,
      needsMpinSetup: needsMpinSetup && credentials.length === 0,
      needsUnlock: Boolean(owner.mpinHash) || credentials.length > 0,
      user: publicUser(owner),
      deviceId: pending.deviceId,
      sessionId: issued.session.sessionId,
      deviceCount: devices.size,
      maxDevices,
      sessions: after.map((s) => publicSession(s, issued.session.sessionId)),
      message: 'Second device verified.',
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Could not finish the login.', 500);
  }
}
