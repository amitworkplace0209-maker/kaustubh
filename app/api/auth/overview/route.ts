import type { NextRequest } from 'next/server';
import { getMaxActiveSessions, getSignupEmail, maskEmail, mailerConfigured } from '@/lib/auth-config';
import { listActiveSessions, listAuthEvents, listCredentials } from '@/lib/auth-db';
import { requireSession } from '@/lib/auth-sessions';
import { fail, json, publicSession, publicUser } from '@/lib/auth-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** GET /api/auth/overview — one payload for the Security settings page. */
export async function GET(request: NextRequest) {
  const auth = await requireSession(request, { requireMpin: true });
  if (!auth.ok) return auth.response;

  try {
    const [sessions, credentials, events] = await Promise.all([
      listActiveSessions(String(auth.user._id)),
      listCredentials(String(auth.user._id)),
      listAuthEvents(20),
    ]);
    const devices = new Set(sessions.map((s) => s.deviceId));

    return json({
      ok: true,
      user: publicUser(auth.user),
      ownerEmailMasked: maskEmail(getSignupEmail() || auth.user.email),
      mailerConfigured: mailerConfigured(),
      hasMpin: Boolean(auth.user.mpinHash),
      mpinUpdatedAt: auth.user.mpinUpdatedAt ?? null,
      biometricCount: credentials.length,
      credentials: credentials.map((cred) => ({
        id: cred.credentialId,
        deviceLabel: cred.deviceLabel,
        transports: cred.transports ?? [],
        createdAt: cred.createdAt.toISOString(),
        lastUsedAt: cred.lastUsedAt ? cred.lastUsedAt.toISOString() : null,
      })),
      deviceCount: devices.size,
      maxDevices: getMaxActiveSessions(),
      sessions: sessions.map((s) => publicSession(s, auth.session.sessionId)),
      events: events.map((event) => ({
        id: event._id ? String(event._id) : '',
        type: event.type,
        ip: event.ip,
        deviceLabel: event.deviceLabel ?? '',
        success: event.success,
        detail: event.detail ?? '',
        at: event.at.toISOString(),
      })),
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'The auth database is unavailable.', 503);
  }
}
