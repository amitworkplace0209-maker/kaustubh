import type { NextRequest } from 'next/server';
import { getClientIp } from '@/lib/auth-config';
import { recordAuthEvent } from '@/lib/auth-db';
import { setOwnerMpin, verifyOwnerMpin } from '@/lib/auth-mpin';
import { requireSession } from '@/lib/auth-sessions';
import { fail, json, readJson } from '@/lib/auth-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** POST /api/auth/mpin/change — Body: { currentMpin, newMpin, confirm? } */
export async function POST(request: NextRequest) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;

  if (!auth.user.mpinHash) {
    return fail('No MPIN is set yet. Use Set MPIN instead.', 409, { code: 'MPIN_NOT_SET' });
  }

  const body = await readJson(request);
  if (!body) return fail('Invalid request body.', 400);

  const currentMpin = String(body.currentMpin ?? body.currentPin ?? '');
  const newMpin = String(body.newMpin ?? body.newPin ?? '');
  const confirm = String(body.confirm ?? '');

  if (newMpin && confirm && newMpin !== confirm) {
    return fail('The two new MPIN entries do not match.', 400);
  }
  if (currentMpin === newMpin) {
    return fail('The new MPIN must be different from the current one.', 400);
  }

  const current = await verifyOwnerMpin(auth.user, currentMpin);
  if (!current.ok) {
    return fail(current.message || 'Incorrect current MPIN.', current.status ?? 401);
  }

  const result = await setOwnerMpin(newMpin);
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
    detail: 'MPIN changed',
  });

  return json({ ok: true, message: 'MPIN changed.' });
}
