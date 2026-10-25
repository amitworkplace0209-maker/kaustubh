import { NextRequest } from 'next/server';
import { hashPin, constantTimeCompare, loadConfig, removeConfig } from '@/lib/auth-crypto';

/**
 * POST /api/auth/pin/disable
 * Body: { pin: string }
 * Disables App Lock by removing the config file.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { pin } = body;

    if (!pin || typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
      return Response.json({ ok: false, message: 'PIN must be exactly 6 digits' }, { status: 400 });
    }

    const config = await loadConfig();

    // If config file has a hash, verify against it
    if (config?.pinHash && config?.pinSalt) {
      const testHash = hashPin(pin, config.pinSalt);
      if (!constantTimeCompare(testHash, config.pinHash)) {
        return Response.json({ ok: false, message: 'Incorrect PIN' }, { status: 401 });
      }
    } else {
      // Fallback to env var
      const envPin = process.env.APP_LOCK_PIN;
      if (!envPin || pin !== envPin) {
        return Response.json({ ok: false, message: 'Incorrect PIN' }, { status: 401 });
      }
    }

    await removeConfig();

    return Response.json({ ok: true, message: 'App Lock disabled' });
  } catch {
    return Response.json({ ok: false, message: 'Failed to disable App Lock' }, { status: 500 });
  }
}
