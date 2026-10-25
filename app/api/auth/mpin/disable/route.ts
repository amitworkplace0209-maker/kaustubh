import type { NextRequest } from 'next/server';
import { getClientIp } from '@/lib/auth-config';
import { listCredentials, recordAuthEvent } from '@/lib/auth-db';
import { clearOwnerMpin, verifyOwnerMpin } from '@/lib/auth-mpin';
import { requireSession } from '@/lib/auth-sessions';
import { fail, json, readJson } from '@/lib/auth-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/auth/mpin/disable — Body: { mpin }
 *
 * MPIN and biometric are alternatives, so an MPIN can only be removed while at
 * least one real WebAuthn credential is registered. Without this guard an owner
 * could lock themselves out of their only account permanently.
 */
export async function POST(request: NextRequest) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;

  if (!auth.user.mpinHash) {
    return fail('No MPIN is configured.', 409, { code: 'MPIN_NOT_SET' });
  }

  const body = await readJson(request);
  if (!body) return fail('Invalid request body.', 400);

  const credentials = await listCredentials(String(auth.user._id));
  if (credentials.length === 0) {
    return fail(
      'Register a fingerprint / face credential first. MPIN and biometric are alternatives — removing both would lock you out.',
      409,
      { code: 'BIOMETRIC_REQUIRED' },
    );
  }

  const result = await verifyOwnerMpin(auth.user, body.mpin ?? body.pin);
  if (!result.ok) {
    return fail(result.message || 'Incorrect MPIN.', result.status ?? 401);
  }

  await clearOwnerMpin();
  await recordAuthEvent({
    type: 'mpin_removed',
    userId: String(auth.user._id),
    ip: getClientIp(request) || 'unknown',
    userAgent: request.headers.get('user-agent') || 'unknown',
    deviceId: auth.session.deviceId,
    deviceLabel: auth.session.deviceLabel,
    sessionId: auth.session.sessionId,
    success: true,
    detail: 'MPIN removed; biometric unlock remains active',
  });

  return json({
    ok: true,
    hasMpin: false,
    needsMpinSetup: false,
    needsUnlock: true,
    message: 'MPIN removed. Biometric unlock is still active.',
  });
}
