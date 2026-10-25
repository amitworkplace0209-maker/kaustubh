import { NextRequest } from 'next/server';
import { hashPin, constantTimeCompare, loadConfig, saveConfig, generateSalt } from '@/lib/auth-crypto';

/**
 * POST /api/auth/pin/change
 * Body: { currentPin: string, newPin: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { currentPin, newPin } = body;

    if (!currentPin || !newPin) {
      return Response.json({ ok: false, message: 'Both current and new PIN required' }, { status: 400 });
    }

    if (!/^\d{6}$/.test(newPin)) {
      return Response.json({ ok: false, message: 'New PIN must be exactly 6 digits' }, { status: 400 });
    }

    if (currentPin === newPin) {
      return Response.json({ ok: false, message: 'New PIN must be different' }, { status: 400 });
    }

    const config = await loadConfig();
    if (!config?.pinHash) {
      // Try env var fallback
      if (process.env.APP_LOCK_PIN && currentPin !== process.env.APP_LOCK_PIN) {
        return Response.json({ ok: false, message: 'Current PIN is incorrect' }, { status: 401 });
      }
      const salt = generateSalt();
      const pinHash = hashPin(newPin, salt);
      await saveConfig({ pinHash, pinSalt: salt, createdAt: new Date().toISOString() });
      return Response.json({ ok: true, message: 'PIN changed successfully' });
    }

    const currentHash = hashPin(currentPin, config.pinSalt);
    if (!constantTimeCompare(currentHash, config.pinHash)) {
      return Response.json({ ok: false, message: 'Current PIN is incorrect' }, { status: 401 });
    }

    const newSalt = generateSalt();
    const newHash = hashPin(newPin, newSalt);
    await saveConfig({ pinHash: newHash, pinSalt: newSalt, createdAt: config.createdAt });

    return Response.json({ ok: true, message: 'PIN changed successfully' });
  } catch {
    return Response.json({ ok: false, message: 'Failed to change PIN' }, { status: 500 });
  }
}
