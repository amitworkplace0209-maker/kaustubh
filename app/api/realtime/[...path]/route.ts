import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Connection Manager (WS #2) control-plane proxy.
 *
 * Proxies `/api/realtime/*` to the backend realtime gateway router
 * (python-service/api/ws_gateway.py) so Service Phase pages can use
 * relative `/api/realtime/...` fetch paths exactly like the engine
 * control proxy. The backend returns `{ok, data}` envelopes.
 */
const BASE = '/api/realtime';

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