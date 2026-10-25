import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Unified user-defined event scheduler — CRUD proxy.
 *
 * Pass-through to the backend `/api/sched-events` router (any event kind:
 * quality scan → square-off → shutdown; plus one-shot reminders). All HTTP
 * methods are proxied verbatim; the backend envelope is returned unchanged
 * so the UI always reflects real scheduler state — no fabricated values.
 */
const BASE = '/api/sched-events';

function target(path: string[], qs: string): string {
  const rest = path.join('/');
  // avoid a trailing slash on the bare list route (FastAPI 307 redirect)
  return rest
    ? `${BASE}/${rest}${qs}`
    : `${BASE}${qs}`;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> },
) {
  const { path = [] } = await ctx.params;
  const qs = new URL(req.url).search;
  const res = await backendFetch(target(path, qs), {
    timeoutMs: 15000,
  });
  return Response.json(
    res.data ?? { ok: false, error: res.error ?? `backend ${res.status}` },
    { status: res.ok ? 200 : res.status === 0 ? 502 : res.status },
  );
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> },
) {
  const { path = [] } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const res = await backendFetch(target(path, ''), {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: 30000,
  });
  return Response.json(
    res.data ?? { ok: false, error: res.error ?? `backend ${res.status}` },
    { status: res.ok ? 200 : res.status === 0 ? 502 : res.status },
  );
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> },
) {
  const { path = [] } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const res = await backendFetch(target(path, ''), {
    method: 'PUT',
    body: JSON.stringify(body),
    timeoutMs: 20000,
  });
  return Response.json(
    res.data ?? { ok: false, error: res.error ?? `backend ${res.status}` },
    { status: res.ok ? 200 : res.status === 0 ? 502 : res.status },
  );
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> },
) {
  const { path = [] } = await ctx.params;
  const res = await backendFetch(target(path, ''), {
    method: 'DELETE',
    timeoutMs: 15000,
  });
  return Response.json(
    res.data ?? { ok: false, error: res.error ?? `backend ${res.status}` },
    { status: res.ok ? 200 : res.status === 0 ? 502 : res.status },
  );
}
