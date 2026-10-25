import type { NextRequest } from 'next/server';
import { getClientIp } from '@/lib/auth-config';
import { recordAuthEvent } from '@/lib/auth-db';
import { setOwnerMpin, verifyOwnerMpin } from '@/lib/auth-mpin';
import { requireSession } from '@/lib/auth-sessions';
import { fail, json, readJson } from '@/lib/auth-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Legacy /api/auth/pin/change — body { currentPin, newPin }.
 * Delegates to the same MPIN policy as /api/auth/mpin/change.
 */
export async function POST(request: NextRequest) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;

  if (!auth.user.mpinHash) {
    return fail('No MPIN is set yet. Use the setup flow first.', 409, { code: 'MPIN_NOT_SET' });
  }

  const body = await readJson(request);
  if (!body) return fail('Invalid request body.', 400);

  const current = String(body.currentPin ?? body.currentMpin ?? '');
  const next = String(body.newPin ?? body.newMpin ?? '');
  if (!current || !next) return fail('Both current and new MPIN are required.', 400);
  if (current === next) return fail('The new MPIN must be different.', 400);

  const verified = await verifyOwnerMpin(auth.user, current);
  if (!verified.ok) return fail(verified.message || 'Incorrect current MPIN.', verified.status ?? 401);

  const result = await setOwnerMpin(next);
  if (!result.ok) return fail(result.message || 'Could not change the MPIN.', result.status ?? 400);

  await recordAuthEvent({
    type: 'mpin_changed',
    userId: String(auth.user._id),
    ip: getClientIp(request) || 'unknown',
    userAgent: request.headers.get('user-agent') || 'unknown',
    deviceId: auth.session.deviceId,
    deviceLabel: auth.session.deviceLabel,
    sessionId: auth.session.sessionId,
    success: true,
    detail: 'MPIN changed (legacy pin endpoint)',
  });

  return json({ ok: true, message: 'MPIN changed.' });
}
