import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/auth-sessions';
import { fail, json } from '@/lib/auth-validation';
import { registrationOptions } from '@/lib/webauthn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** POST /api/auth/biometric/register/options — start a real WebAuthn registration. */
export async function POST(request: NextRequest) {
  const auth = await requireSession(request, { requireMpin: true });
  if (!auth.ok) return auth.response;

  try {
    const result = await registrationOptions({
      request,
      userId: String(auth.user._id),
      userName: auth.user.email,
      userDisplayName: auth.user.name,
    });
    if (!result.ok) return fail(result.message, 400, { code: 'WEBAUTHN_UNAVAILABLE' });
    return json({ ok: true, options: result.options });
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Could not start biometric registration.', 500);
  }
}
