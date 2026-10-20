import { NextRequest } from 'next/server';
import { hashPin, loadConfig, saveConfig, generateSalt } from '@/lib/auth-crypto';

/**
 * GET /api/auth/setup
 * Returns whether app lock has been configured.
 */
export async function GET() {
  const config = await loadConfig();
  const envPin = process.env.APP_LOCK_PIN;

  const isConfigured = Boolean(config?.pinHash) || Boolean(envPin);

  return Response.json({
    ok: true,
    configured: isConfigured,
    source: config?.pinHash ? 'database' : envPin ? 'environment' : 'none',
  });
}

/**
 * POST /api/auth/setup
 * Body: { step: 'create-pin', pin: string }
 * Called from Settings → Security → App Lock to set the initial PIN.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { step, pin } = body;

    if (step === 'create-pin') {
      if (!pin || typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
        return Response.json({ ok: false, message: 'PIN must be exactly 6 digits' }, { status: 400 });
      }

      const config = await loadConfig();
      if (config?.pinHash) {
        return Response.json({ ok: false, message: 'App Lock PIN already configured' }, { status: 409 });
      }

      const salt = generateSalt();
      const pinHash = hashPin(pin, salt);
      await saveConfig({ pinHash, pinSalt: salt, createdAt: new Date().toISOString() });

      return Response.json({ ok: true, message: 'App Lock PIN created' });
    }

    return Response.json({ ok: false, message: 'Invalid step' }, { status: 400 });
  } catch {
    return Response.json({ ok: false, message: 'Setup request failed' }, { status: 500 });
  }
}
