import type { NextRequest } from 'next/server';
import { getMaxActiveSessions } from '@/lib/auth-config';
import { getOwner, listActiveSessions, listCredentials } from '@/lib/auth-db';
import { getSessionFromRequest } from '@/lib/auth-sessions';
import { json, publicSession, publicUser } from '@/lib/auth-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/auth/session — the single source of truth for the UI session.
 *
 * `authenticated` stays the top-level boolean for backwards compatibility with
 * the existing AuthProvider; the richer fields drive MPIN setup, app unlock and
 * the active-device indicator.
 */
export async function GET(request: NextRequest) {
  try {
    const owner = await getOwner();
    if (!owner) {
      return json({
        ok: true,
        authenticated: false,
        hasOwner: false,
        needsSignup: true,
        needsMpinSetup: false,
        needsUnlock: false,
      });
    }

    const active = await getSessionFromRequest(request);
    if (!active) {
      return json({
        ok: true,
        authenticated: false,
        hasOwner: true,
        needsSignup: false,
        needsMpinSetup: false,
        needsUnlock: false,
      });
    }

    const sessions = await listActiveSessions(String(owner._id));
    const devices = new Set(sessions.map((s) => s.deviceId));
    const credentials = await listCredentials(String(owner._id));

    return json({
      ok: true,
      authenticated: true,
      hasOwner: true,
      needsSignup: false,
      needsMpinSetup: !owner.mpinHash && credentials.length === 0,
      needsUnlock: Boolean(owner.mpinHash) || credentials.length > 0,
      user: publicUser(owner),
      deviceId: active.session.deviceId,
      sessionId: active.session.sessionId,
      deviceCount: devices.size,
      maxDevices: getMaxActiveSessions(),
      sessions: sessions.map((s) => publicSession(s, active.session.sessionId)),
      biometricCount: credentials.length,
    });
  } catch (err) {
    return json(
      {
        ok: false,
        authenticated: false,
        database: false,
        message: err instanceof Error ? err.message : 'The auth database is unavailable.',
      },
      503,
    );
  }
}
