import type { NextRequest } from 'next/server';
import { constantTimeCompare, hashSecret, newDeviceId } from '@/lib/auth-crypto';
import { getClientIp, getSignupEmail, getSignupMpin } from '@/lib/auth-config';
import { createOwner, hasOwner, recordAuthEvent } from '@/lib/auth-db';
import { checkRateLimit, LIMITS } from '@/lib/auth-rate-limit';
import { issueSessionForUser, setAuthCookies } from '@/lib/auth-sessions';
import {
  fail,
  json,
  normalizeEmail,
  normalizeName,
  publicUser,
  readJson,
  safeDeviceId,
  safeDeviceLabel,
  validEmail,
  validName,
  validatePassword,
} from '@/lib/auth-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/auth/signup — the ONE-TIME owner bootstrap.
 *
 * Only exists while the `app_auth_users` collection is empty. The submitted
 * email + MPIN must match AUTH_SIGNUP_EMAIL / AUTH_SIGNUP_MPIN from the
 * server-side env; only the name and password are new values, and only they are
 * hashed and stored. The MPIN itself is NOT stored here — the first login forces
 * a fresh MPIN setup, exactly as required.
 */
export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  if (!ip) {
    return fail('Cannot verify your IP address, so signup is blocked. Connect through the app proxy and retry.', 400, {
      code: 'IP_REQUIRED',
    });
  }

  const limit = checkRateLimit(`signup:${ip}`, LIMITS.signup.limit, LIMITS.signup.windowMs);
  if (!limit.allowed) {
    return fail(`Too many signup attempts. Try again in ${limit.retryAfterSec}s.`, 429);
  }

  const body = await readJson(request);
  if (!body) return fail('Invalid request body.', 400);

  const name = normalizeName(body.name);
  const email = normalizeEmail(body.email);
  const password = String(body.password ?? '');
  const mpin = String(body.mpin ?? '');

  const expectedEmail = getSignupEmail();
  const expectedMpin = getSignupMpin();
  if (!expectedEmail || !expectedMpin) {
    return fail(
      'Signup is not configured on the server. Set AUTH_SIGNUP_EMAIL and AUTH_SIGNUP_MPIN in .env.local.',
      503,
      { code: 'SIGNUP_NOT_CONFIGURED' },
    );
  }

  try {
    if (await hasOwner()) {
      return fail('The owner account already exists. Please log in.', 409, { code: 'OWNER_EXISTS' });
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'The auth database is unavailable.', 503, { database: false });
  }

  const nameError = validName(name);
  if (nameError) return fail(nameError, 400);
  const emailError = validEmail(email);
  if (emailError) return fail(emailError, 400);
  const passwordError = validatePassword(password);
  if (passwordError) return fail(passwordError, 400);

  if (email !== expectedEmail || !constantTimeCompare(mpin, expectedMpin)) {
    return fail('Those details do not match the owner configuration.', 401, { code: 'SIGNUP_MISMATCH' });
  }

  const now = new Date().toISOString();
  const deviceId = safeDeviceId(body.deviceId) || newDeviceId();
  const deviceLabel = safeDeviceLabel(body.deviceLabel, 'This device');

  try {
    const passwordHash = await hashSecret(password);
    const owner = await createOwner({
      singleton: 'owner',
      name,
      nameLower: name.toLowerCase(),
      email,
      emailLower: email,
      passwordHash,
      mpinHash: null,
      mpinUpdatedAt: null,
      mpinFailedAttempts: 0,
      mpinLockedUntil: null,
      passwordFailedAttempts: 0,
      passwordLockedUntil: null,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
    });

    await recordAuthEvent({
      type: 'signup',
      userId: String(owner._id),
      ip,
      userAgent: request.headers.get('user-agent') || 'unknown',
      deviceId,
      deviceLabel,
      success: true,
      detail: 'One-time owner account created',
    });

    const issued = await issueSessionForUser({
      request,
      user: owner,
      deviceId,
      deviceLabel,
      kind: 'primary',
    });
    await setAuthCookies(request, issued, true);

    return json(
      {
        ok: true,
        authenticated: true,
        needsMpinSetup: true,
        needsUnlock: false,
        user: publicUser(owner),
        deviceId,
        sessionId: issued.session.sessionId,
        deviceCount: 1,
        maxDevices: 2,
        message: 'Owner account created. Set your MPIN to open the app.',
      },
      201,
    );
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 11000) {
      return fail('The owner account already exists. Please log in.', 409, { code: 'OWNER_EXISTS' });
    }
    return fail(err instanceof Error ? err.message : 'Signup failed.', 500);
  }
}
