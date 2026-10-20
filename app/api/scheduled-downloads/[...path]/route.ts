import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Scheduled Download jobs (Scheduler Engine companion) — control-plane proxy.
 *
 * Pass-through to the backend `/api/scheduled-downloads/*` router (health,
 * runs, runs/{run_id}, packages, job config…). The backend is authoritative
 * for job/checker state; this proxy returns the backend envelope unchanged so
 * the Scheduler page never shows fabricated data.
 */
const BASE = '/api/scheduled-downloads';

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