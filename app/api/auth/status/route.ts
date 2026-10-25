import type { NextRequest } from 'next/server';
import {
  allowDevOtp,
  getMaxActiveSessions,
  getSignupEmail,
  getSignupMpin,
  mailerConfigured,
  maskEmail,
} from '@/lib/auth-config';
import { getOwner, listActiveSessions, listCredentials } from '@/lib/auth-db';
import { getSessionFromRequest } from '@/lib/auth-sessions';
import { fail, json, publicSession, publicUser } from '@/lib/auth-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Public bootstrap probe used by /login and the auth provider.
 *
 * It deliberately reveals ONLY non-secret facts: whether the one-time owner
 * exists, whether signup is configured, and — when a valid session cookie is
 * present — that owner's own profile and active devices.
 */
export async function GET(request: NextRequest) {
  const signupConfigured = Boolean(getSignupEmail() && getSignupMpin());
  const base = {
    ok: true,
    signupConfigured,
    signupEmailMasked: signupConfigured ? maskEmail(getSignupEmail()) : '',
    mailerConfigured: mailerConfigured(),
    devOtp: allowDevOtp(),
    maxDevices: getMaxActiveSessions(),
  };

  try {
    const owner = await getOwner();
    if (!owner) {
      return json({
        ...base,
        hasOwner: false,
        needsSignup: true,
        authenticated: false,
        needsMpinSetup: false,
        needsUnlock: false,
        deviceCount: 0,
        sessions: [],
        biometricCount: 0,
      });
    }

    const active = await getSessionFromRequest(request);
    if (!active) {
      return json({
        ...base,
        hasOwner: true,
        needsSignup: false,
        authenticated: false,
        needsMpinSetup: false,
        needsUnlock: false,
        deviceCount: 0,
        sessions: [],
        biometricCount: 0,
      });
    }

    const sessions = await listActiveSessions(String(owner._id));
    const devices = new Set(sessions.map((s) => s.deviceId));
    const credentials = await listCredentials(String(owner._id));

    return json({
      ...base,
      hasOwner: true,
      needsSignup: false,
      authenticated: true,
      needsMpinSetup: !owner.mpinHash && credentials.length === 0,
      needsUnlock: Boolean(owner.mpinHash) || credentials.length > 0,
      user: publicUser(owner),
      deviceId: active.session.deviceId,
      sessionId: active.session.sessionId,
      deviceCount: devices.size,
      sessions: sessions.map((s) => publicSession(s, active.session.sessionId)),
      biometricCount: credentials.length,
      currentSession: publicSession(active.session, active.session.sessionId),
    });
  } catch (err) {
    return fail(
      err instanceof Error
        ? `The auth database is unavailable: ${err.message}`
        : 'The auth database is unavailable.',
      503,
      { database: false },
    );
  }
}
