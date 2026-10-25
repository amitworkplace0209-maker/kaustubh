import type { NextRequest } from 'next/server';
import { getClientIp } from '@/lib/auth-config';
import {
  listActiveSessions,
  recordAuthEvent,
  revokeAllSessionDocs,
  revokeSessionDoc,
} from '@/lib/auth-db';
import { clearAuthCookies, requireSession } from '@/lib/auth-sessions';
import { fail, json, readJson } from '@/lib/auth-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/auth/devices/revoke
 * Body: { sessionId?: string; deviceId?: string; all?: boolean }
 *
 * `all` keeps the current device signed in and revokes every other one. It is
 * the manual escape hatch when both device slots are full.
 */
export async function POST(request: NextRequest) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body) return fail('Invalid request body.', 400);

  const currentSessionId = auth.session.sessionId;
  const sessionId = String(body.sessionId ?? '').trim();
  const deviceId = String(body.deviceId ?? '').trim();
  const all = body.all === true;
  const ip = getClientIp(request) || 'unknown';
  const userAgent = request.headers.get('user-agent') || 'unknown';

  if (!all && !sessionId && !deviceId) {
    return fail('Specify sessionId, deviceId, or all=true.', 400);
  }

  try {
    if (all) {
      const revoked = await revokeAllSessionDocs(String(auth.user._id), currentSessionId);
      await recordAuthEvent({
        type: 'logout_all',
        userId: String(auth.user._id),
        ip,
        userAgent,
        deviceId: auth.session.deviceId,
        deviceLabel: auth.session.deviceLabel,
        sessionId: currentSessionId,
        success: true,
        detail: `${revoked} other session(s) revoked`,
      });
      return json({ ok: true, revoked, message: 'All other devices were signed out.' });
    }

    if (deviceId) {
      const sessions = await listActiveSessions(String(auth.user._id));
      const targets = sessions.filter((s) => s.deviceId === deviceId);
      let revoked = 0;
      for (const target of targets) {
        if (await revokeSessionDoc(target.sessionId, 'device_revoked')) revoked += 1;
      }
      await recordAuthEvent({
        type: 'device_revoked',
        userId: String(auth.user._id),
        ip,
        userAgent,
        deviceId: targetDeviceId(targets, deviceId),
        deviceLabel: targets[0]?.deviceLabel || 'Unknown device',
        sessionId: currentSessionId,
        success: true,
        detail: `${revoked} session(s) revoked for device ${deviceId.slice(0, 8)}`,
      });
      const selfRevoked = targets.some((target) => target.sessionId === currentSessionId);
      if (selfRevoked) await clearAuthCookies();
      return json({
        ok: true,
        revoked,
        selfRevoked,
        message: selfRevoked ? 'This device was signed out.' : 'Device signed out.',
      });
    }

    const selfRevoked = sessionId === currentSessionId;
    const revoked = await revokeSessionDoc(sessionId, 'device_revoked');
    await recordAuthEvent({
      type: 'device_revoked',
      userId: String(auth.user._id),
      ip,
      userAgent,
      deviceId: selfRevoked ? auth.session.deviceId : null,
      deviceLabel: selfRevoked ? auth.session.deviceLabel : 'Another device',
      sessionId: selfRevoked ? sessionId : currentSessionId,
      success: revoked,
      detail: revoked ? 'Session revoked' : 'Session not found or already revoked',
    });
    if (selfRevoked) await clearAuthCookies();
    return json({
      ok: true,
      revoked: revoked ? 1 : 0,
      selfRevoked,
      message: revoked ? 'Session revoked.' : 'That session was already inactive.',
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Could not revoke the session.', 500);
  }
}

function targetDeviceId(
  targets: Array<{ deviceId: string }>,
  fallback: string,
): string {
  return targets[0]?.deviceId || fallback;
}
