import type { NextRequest } from 'next/server';
import { getClientIp } from '@/lib/auth-config';
import { recordAuthEvent, revokeSessionDoc } from '@/lib/auth-db';
import { clearAuthCookies, getSessionFromRequest } from '@/lib/auth-sessions';
import { json } from '@/lib/auth-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST / DELETE /api/auth/logout
 *
 * Revokes THIS device's session record in MongoDB and clears both auth cookies.
 * Other devices stay signed in (revoke them explicitly from Settings).
 */
async function logout(request: NextRequest): Promise<Response> {
  const ip = getClientIp(request) || 'unknown';
  const userAgent = request.headers.get('user-agent') || 'unknown';

  try {
    const active = await getSessionFromRequest(request);
    if (active) {
      await revokeSessionDoc(active.session.sessionId, 'logout');
      await recordAuthEvent({
        type: 'logout',
        userId: String(active.user._id),
        ip,
        userAgent,
        deviceId: active.session.deviceId,
        deviceLabel: active.session.deviceLabel,
        sessionId: active.session.sessionId,
        success: true,
        detail: 'Logged out',
      });
    }
  } catch {
    // Even if MongoDB is down we still clear the cookie so the browser is not
    // stuck in a half-signed-in state.
  }

  await clearAuthCookies();
  return json({ ok: true, authenticated: false, message: 'Logged out.' });
}

export async function POST(request: NextRequest) {
  return logout(request);
}

export async function DELETE(request: NextRequest) {
  return logout(request);
}
