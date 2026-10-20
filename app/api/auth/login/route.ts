import { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { hashPin, constantTimeCompare, loadConfig, createSessionToken } from '@/lib/auth-crypto';

async function isAppLockConfigured(): Promise<boolean> {
  const config = await loadConfig();
  if (config?.pinHash) return true;
  if (process.env.APP_LOCK_PIN) return true;
  return false;
}

async function verifyPin(pin: string): Promise<boolean> {
  const config = await loadConfig();
  if (config?.pinHash && config?.pinSalt) {
    const testHash = hashPin(pin, config.pinSalt);
    if (constantTimeCompare(testHash, config.pinHash)) return true;
  }
  const envPin = process.env.APP_LOCK_PIN;
  if (envPin && pin === envPin) return true;
  return false;
}

function setSessionCookie() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: 86400,
    path: '/',
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { pin, direct } = body;

    if (direct) {
      const locked = await isAppLockConfigured();
      if (locked) {
        return Response.json(
          { ok: false, message: 'App Lock is enabled — PIN is required' },
          { status: 403 }
        );
      }
      const token = createSessionToken();
      const cookieStore = await cookies();
      cookieStore.set('kaustubh_session', token, setSessionCookie());
      return Response.json({ ok: true, message: 'Authenticated' });
    }

    if (!pin || typeof pin !== 'string') {
      return Response.json(
        { ok: false, message: 'PIN is required' },
        { status: 400 }
      );
    }

    if (!/^\d{6}$/.test(pin)) {
      return Response.json(
        { ok: false, message: 'PIN must be exactly 6 digits' },
        { status: 400 }
      );
    }

    const valid = await verifyPin(pin);

    if (!valid) {
      return Response.json(
        { ok: false, message: 'Incorrect PIN' },
        { status: 401 }
      );
    }

    const token = createSessionToken();
    const cookieStore = await cookies();
    cookieStore.set('kaustubh_session', token, setSessionCookie());

    return Response.json({ ok: true, message: 'Authenticated' });
  } catch (e) {
    console.error('[auth/login] error:', (e as Error)?.stack ?? e);
    return Response.json(
      { ok: false, message: 'Authentication failed' },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  const cookieStore = await cookies();
  cookieStore.delete('kaustubh_session');
  return Response.json({ ok: true, message: 'Logged out' });
}
