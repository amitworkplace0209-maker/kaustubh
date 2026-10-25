import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import {
  createSessionToken,
  MPIN_PENDING_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  verifySessionToken,
} from '@/lib/auth-crypto';
import {
  createSessionDoc,
  getOwner,
  getSessionDoc,
  listActiveSessions,
  listCredentials,
  revokeSessionDoc,
  touchSession,
  type AuthSessionDoc,
  type AuthUserDoc,
} from '@/lib/auth-db';
import { requestContext } from '@/lib/auth-config';
import { fail } from '@/lib/auth-validation';

export interface IssuedSession {
  session: AuthSessionDoc;
  token: string;
  cookie: {
    name: string;
    value: string;
    httpOnly: true;
    secure: boolean;
    sameSite: 'lax';
    path: '/';
    maxAge: number;
  };
}

export interface ActiveSession {
  payload: NonNullable<ReturnType<typeof verifySessionToken>>;
  session: AuthSessionDoc;
  user: AuthUserDoc;
}

export async function issueSessionForUser(options: {
  request: NextRequest;
  user: AuthUserDoc;
  deviceId: string;
  deviceLabel: string;
  kind?: AuthSessionDoc['kind'];
}): Promise<IssuedSession> {
  const { request, user, deviceId, deviceLabel } = options;
  const ctx = requestContext(request);
  const ip = ctx.ip;
  if (!ip) throw new Error('A verified client IP is required to create a session.');
  const now = new Date();

  // One live session per physical device: a repeat login in the same place
  // rotates the cookie instead of stacking sessions.
  const active = await listActiveSessions(String(user._id));
  for (const existing of active) {
    if (existing.deviceId === deviceId) {
      await revokeSessionDoc(existing.sessionId, 'rotated');
    }
  }

  const sessionId = crypto.randomUUID();
  const session: AuthSessionDoc = {
    sessionId,
    userId: String(user._id),
    deviceId,
    deviceLabel,
    ip,
    userAgent: ctx.userAgent,
    kind: options.kind ?? 'primary',
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    revokedAt: null,
  };
  await createSessionDoc(session);
  const token = createSessionToken({ sessionId, deviceId, ttlMs: SESSION_TTL_MS });
  return {
    session,
    token,
    cookie: {
      name: SESSION_COOKIE,
      value: token,
      httpOnly: true,
      secure: ctx.secure,
      sameSite: 'lax',
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    },
  };
}

export async function getSessionFromRequest(request: NextRequest): Promise<ActiveSession | null> {
  const raw = request.cookies.get(SESSION_COOKIE)?.value;
  const payload = verifySessionToken(raw);
  if (!payload?.sid) return null;
  const session = await getSessionDoc(payload.sid);
  if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) return null;
  const user = await getOwner();
  if (!user || String(user._id) !== session.userId) return null;
  try {
    await touchSession(session.sessionId, session.lastSeenAt);
  } catch {
    // A failed last-seen write must not invalidate a valid session.
  }
  return { payload, session, user };
}

export type RequireSessionResult =
  | { ok: true; payload: ActiveSession['payload']; session: AuthSessionDoc; user: AuthUserDoc }
  | { ok: false; response: Response };

export async function requireSession(
  request: NextRequest,
  options: { requireMpin?: boolean } = {},
): Promise<RequireSessionResult> {
  let active: ActiveSession | null = null;
  try {
    active = await getSessionFromRequest(request);
  } catch {
    return {
      ok: false,
      response: fail('The auth database is unreachable. Try again in a moment.', 503),
    };
  }
  if (!active) {
    return {
      ok: false,
      response: fail('Your session has expired. Please log in again.', 401, {
        authenticated: false,
        code: 'UNAUTHENTICATED',
      }),
    };
  }
  if (options.requireMpin && !active.user.mpinHash) {
    // MPIN and biometric are alternatives. An account that removed its MPIN but
    // registered a real WebAuthn credential is still "locked" and usable.
    let hasBiometric = false;
    try {
      const credentials = await listCredentials(String(active.user._id));
      hasBiometric = credentials.length > 0;
    } catch {
      /* treat as none */
    }
    if (!hasBiometric) {
      return {
        ok: false,
        response: fail('Set your MPIN before continuing.', 403, {
          code: 'MPIN_SETUP_REQUIRED',
          needsMpinSetup: true,
        }),
      };
    }
  }
  return { ok: true, ...active };
}

export function mpinPendingCookie(secure: boolean) {
  return {
    name: MPIN_PENDING_COOKIE,
    value: '1',
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

export async function setAuthCookies(request: NextRequest, issued: IssuedSession, needsMpin: boolean): Promise<void> {
  const store = await cookies();
  store.set(issued.cookie);
  if (needsMpin) {
    store.set(mpinPendingCookie(issued.cookie.secure));
  } else {
    store.delete(MPIN_PENDING_COOKIE);
  }
}

export async function clearAuthCookies(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  store.delete(MPIN_PENDING_COOKIE);
}

export async function markMpinConfigured(): Promise<void> {
  const store = await cookies();
  store.delete(MPIN_PENDING_COOKIE);
}

export function distinctDeviceCount(sessions: AuthSessionDoc[]): number {
  return new Set(sessions.map((s) => s.deviceId)).size;
}

export async function activeDeviceSummary(userId: string, currentSessionId?: string) {
  const sessions = await listActiveSessions(userId);
  const devices = new Set(sessions.map((s) => s.deviceId));
  return {
    count: devices.size,
    sessions,
    currentDeviceCount: currentSessionId
      ? sessions.filter((s) => s.sessionId === currentSessionId).length
      : 0,
  };
}
