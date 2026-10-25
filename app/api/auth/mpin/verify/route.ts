import type { NextRequest } from 'next/server';
import { getClientIp } from '@/lib/auth-config';
import { recordAuthEvent } from '@/lib/auth-db';
import { verifyOwnerMpin } from '@/lib/auth-mpin';
import { requireSession } from '@/lib/auth-sessions';
import { fail, json, readJson } from '@/lib/auth-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** POST /api/auth/mpin/verify — app unlock with the MPIN. */
export async function POST(request: NextRequest) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body) return fail('Invalid request body.', 400);

  const result = await verifyOwnerMpin(auth.user, body.mpin);
  await recordAuthEvent({
    type: result.ok ? 'mpin_verified' : 'mpin_failed',
    userId: String(auth.user._id),
    ip: getClientIp(request) || 'unknown',
    userAgent: request.headers.get('user-agent') || 'unknown',
    deviceId: auth.session.deviceId,
    deviceLabel: auth.session.deviceLabel,
    sessionId: auth.session.sessionId,
    success: result.ok,
    detail: result.ok ? 'App unlocked with MPIN' : result.message || 'MPIN verification failed',
  }).catch(() => {});

  if (!result.ok) {
    return fail(result.message || 'Incorrect MPIN.', result.status ?? 401, {
      lockedUntil: result.lockedUntil,
    });
  }

  return json({ ok: true, unlocked: true, message: 'Unlocked.' });
}
