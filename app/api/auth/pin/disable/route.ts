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
 * Legacy /api/auth/pin/disable — body { pin }.
 * MPIN removal requires a registered biometric credential (never lock yourself
 * out of the only account).
 */
export async function POST(request: NextRequest) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;

  if (!auth.user.mpinHash) return fail('No MPIN is configured.', 409, { code: 'MPIN_NOT_SET' });

  const body = await readJson(request);
  if (!body) return fail('Invalid request body.', 400);

  const credentials = await listCredentials(String(auth.user._id));
  if (credentials.length === 0) {
    return fail(
      'Register a fingerprint / face credential first. MPIN and biometric are alternatives.',
      409,
      { code: 'BIOMETRIC_REQUIRED' },
    );
  }

  const verified = await verifyOwnerMpin(auth.user, body.pin ?? body.mpin);
  if (!verified.ok) return fail(verified.message || 'Incorrect MPIN.', verified.status ?? 401);

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

  return json({ ok: true, configured: false, message: 'MPIN removed.' });
}
