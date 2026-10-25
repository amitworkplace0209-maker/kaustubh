import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Engine Control API — Phase 3 Service Control Center proxy.
 * Proxies to backend `/api/services/engines/*` router.
 */
const BASE = '/api/services/engines';

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> },
) {
  const { path = [] } = await ctx.params;
  const qs = new URL(req.url).search;
  const res = await backendFetch(`${BASE}/${path.join('/')}${qs}`, {
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
  const res = await backendFetch(`${BASE}/${path.join('/')}`, {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: 20000,
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
  const res = await backendFetch(`${BASE}/${path.join('/')}`, {
    method: 'PUT',
    body: JSON.stringify(body),
    timeoutMs: 20000,
  });
  return Response.json(
    res.data ?? { ok: false, error: res.error ?? `backend ${res.status}` },
    { status: res.ok ? 200 : res.status === 0 ? 502 : res.status },
  );
}

/** Engine settings writes are PATCH (`/{engineId}/config`). Without this the
 *  settings form had no route to save through and every edit silently failed. */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> },
) {
  const { path = [] } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const res = await backendFetch(`${BASE}/${path.join('/')}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    timeoutMs: 20000,
  });
  return Response.json(
    res.data ?? { ok: false, error: res.error ?? `backend ${res.status}` },
    { status: res.ok ? 200 : res.status === 0 ? 502 : res.status },
  );
}
