import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { existsSync } from 'fs';
import { join } from 'path';

export async function GET() {
  const checks: Record<string, { ok: boolean; message: string }> = {};

  // Check if App Lock PIN is configured (env or hashed)
  const hasEnvPin = Boolean(process.env.APP_LOCK_PIN);
  const hasHashedPin = existsSync(join(process.cwd(), '.auth', 'app-lock.json'));
  if (hasEnvPin || hasHashedPin) {
    checks.appLockPin = { ok: true, message: hasHashedPin ? 'Configured (hashed)' : 'Configured (env)' };
  } else {
    checks.appLockPin = { ok: false, message: 'Not configured — first-time setup required' };
  }

  // Check API base
  checks.apiBase = { ok: true, message: env.API_BASE };

  // Try to ping the backend
  try {
    const res = await fetch(`${env.API_BASE}/api/system/health`, {
      signal: AbortSignal.timeout(5000),
    });
    checks.backend = {
      ok: res.ok,
      message: res.ok ? 'Connected' : `HTTP ${res.status}`,
    };
  } catch (err) {
    checks.backend = {
      ok: false,
      message: err instanceof Error ? err.message : 'Unreachable',
    };
  }

  const allOk = Object.values(checks).every((c) => c.ok);

  return NextResponse.json({
    ok: allOk,
    timestamp: new Date().toISOString(),
    checks,
  });
}
