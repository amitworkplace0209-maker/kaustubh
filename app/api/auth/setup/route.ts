import type { NextRequest } from 'next/server';
import { getClientIp, getSignupEmail, getSignupMpin } from '@/lib/auth-config';
import { recordAuthEvent } from '@/lib/auth-db';
import { setOwnerMpin } from '@/lib/auth-mpin';
import { markMpinConfigured, requireSession } from '@/lib/auth-sessions';
import { fail, json, readJson } from '@/lib/auth-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Legacy /api/auth/setup — kept for the existing Settings → Security card.
 * GET reports whether an unlock secret exists; POST creates the initial MPIN.
 * New code should use /api/auth/status and /api/auth/mpin/setup.
 */
export async function GET(request: NextRequest) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;

  const configured = Boolean(auth.user.mpinHash);
  return json({
    ok: true,
    configured,
    source: configured ? 'database' : getSignupMpin() ? 'environment' : 'none',
    hasMpin: configured,
    signupConfigured: Boolean(getSignupEmail() && getSignupMpin()),
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body) return fail('Invalid request body.', 400);

  const step = String(body.step ?? 'create-pin');
  if (step !== 'create-pin') {
    return fail('Unsupported setup step. Use step=create-pin.', 400);
  }
  if (auth.user.mpinHash) {
    return fail('An MPIN is already configured. Use Change MPIN instead.', 409);
  }

  const result = await setOwnerMpin(body.pin ?? body.mpin);
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
    detail: 'MPIN configured (legacy setup endpoint)',
  });

  return json({ ok: true, configured: true });
}
