import type { NextRequest } from 'next/server';
import { getMaxActiveSessions } from '@/lib/auth-config';
import { listActiveSessions } from '@/lib/auth-db';
import { requireSession } from '@/lib/auth-sessions';
import { fail, json, publicSession } from '@/lib/auth-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** GET /api/auth/devices — every active login with its real IP and timestamps. */
export async function GET(request: NextRequest) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;

  try {
    const sessions = await listActiveSessions(String(auth.user._id));
    const devices = new Set(sessions.map((s) => s.deviceId));
    return json({
      ok: true,
      deviceCount: devices.size,
      maxDevices: getMaxActiveSessions(),
      sessions: sessions.map((s) => publicSession(s, auth.session.sessionId)),
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'The auth database is unavailable.', 503);
  }
}
