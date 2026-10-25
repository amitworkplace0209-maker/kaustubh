import type { NextRequest } from 'next/server';
import { getClientIp } from '@/lib/auth-config';
import { recordAuthEvent } from '@/lib/auth-db';
import { setOwnerMpin } from '@/lib/auth-mpin';
import { markMpinConfigured, requireSession } from '@/lib/auth-sessions';
import { fail, json, readJson } from '@/lib/auth-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/auth/mpin/setup
 *
 * Mandatory after the FIRST login (signup intentionally stores no MPIN). The
 * session cookie is valid but the app stays closed until this succeeds.
 */
export async function POST(request: NextRequest) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;

  if (auth.user.mpinHash) {
    return fail('An MPIN is already set. Use Change MPIN instead.', 409, { code: 'MPIN_ALREADY_SET' });
  }

  const body = await readJson(request);
  if (!body) return fail('Invalid request body.', 400);

  const mpin = String(body.mpin ?? '');
  const confirm = String(body.confirm ?? body.confirmMpin ?? '');

  if (confirm && confirm !== mpin) {
    return fail('The two MPIN entries do not match.', 400);
  }

  const result = await setOwnerMpin(mpin);
  if (!result.ok) return fail(result.message || 'Could not set the MPIN.', result.status ?? 400);

  await markMpinConfigured();
  await recordAuthEvent({
    type: 'mpin_setup',
    userId: String(auth.user._id),
    ip: getClientIp(request) || 'unknown',
    userAgent: request.headers.get('user-agent') || 'unknown',
    deviceId: auth.session.deviceId,
    deviceLabel: auth.session.deviceLabel,
    sessionId: auth.session.sessionId,
    success: true,
    detail: 'MPIN configured',
  });

  return json({
    ok: true,
    hasMpin: true,
    needsMpinSetup: false,
    needsUnlock: true,
    message: 'MPIN set. The app is now unlocked.',
  });
}
