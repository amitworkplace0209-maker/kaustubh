import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Session Manager Engine (Phase 3) — control-plane proxy.
 *
 * Pass-through to the backend `/api/phase3/session-manager/*` router. The
 * backend is the single authoritative source for instrument intent, lifecycle
 * transitions, real expiries and revision tracking; this proxy returns the
 * backend envelope `{ ok, data | error }` unchanged so the UI never shows
 * fabricated state.
 */
const BASE = '/api/phase3/session-manager';

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