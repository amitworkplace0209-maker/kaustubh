import type { NextRequest } from 'next/server';
import { listAuthEvents } from '@/lib/auth-db';
import { requireSession } from '@/lib/auth-sessions';
import { fail, json } from '@/lib/auth-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** GET /api/auth/events?limit=50 — the login/IP audit trail. */
export async function GET(request: NextRequest) {
  const auth = await requireSession(request, { requireMpin: true });
  if (!auth.ok) return auth.response;

  const raw = Number.parseInt(request.nextUrl.searchParams.get('limit') ?? '50', 10);
  const limit = Number.isFinite(raw) ? raw : 50;

  try {
    const events = await listAuthEvents(limit);
    return json({
      ok: true,
      count: events.length,
      events: events.map((event) => ({
        id: event._id ? String(event._id) : '',
        type: event.type,
        ip: event.ip,
        userAgent: event.userAgent,
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
