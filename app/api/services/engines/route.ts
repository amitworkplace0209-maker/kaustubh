import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Engine Control API — Phase 3 Service Control Center proxy (root path).
 *
 * Proxies the bare `/api/services/engines` (list-all) endpoint. The
 * `[...path]` sibling route only matches paths with at least one segment, so
 * without this route the SCC's engine-list polling returned 404 and the page
 * was stuck on "Loading engines…".
 */
const BASE = '/api/services/engines';

export async function GET(req: NextRequest) {
  const qs = new URL(req.url).search;
  const res = await backendFetch(`${BASE}${qs}`, { timeoutMs: 15000 });
  return Response.json(
    res.data ?? { ok: false, error: res.error ?? `backend ${res.status}` },
    { status: res.ok ? 200 : res.status === 0 ? 502 : res.status },
  );
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const res = await backendFetch(`${BASE}`, {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: 20000,
  });
  return Response.json(
    res.data ?? { ok: false, error: res.error ?? `backend ${res.status}` },
    { status: res.ok ? 200 : res.status === 0 ? 502 : res.status },
  );
}