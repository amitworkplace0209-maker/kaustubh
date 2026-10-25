import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/auth-sessions';
import { fail, json } from '@/lib/auth-validation';
import { authenticationOptions } from '@/lib/webauthn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** POST /api/auth/biometric/auth/options — start a WebAuthn app unlock. */
export async function POST(request: NextRequest) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;

  try {
    const result = await authenticationOptions({
      request,
      userId: String(auth.user._id),
    });
    if (!result.ok) return fail(result.message, 400, { code: 'NO_BIOMETRIC' });
    return json({ ok: true, options: result.options });
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Could not start biometric unlock.', 500);
  }
}
