import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Search Engine API proxy → backend `/api/phase3/search/...`.
 */
const BASE = '/api/phase3/search';

export async function GET(req: NextRequest) {
  const qs = new URL(req.url).search;
  const res = await backendFetch(`${BASE}/scoped${qs}`, { timeoutMs: 10000 });
  return Response.json(
    res.data ?? { ok: false, error: res.error ?? `backend ${res.status}` },
    { status: res.ok ? 200 : res.status === 0 ? 502 : res.status },
  );
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const res = await backendFetch(`${BASE}/scoped`, {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: 10000,
  });
  return Response.json(
    res.data ?? { ok: false, error: res.error ?? `backend ${res.status}` },
    { status: res.ok ? 200 : res.status === 0 ? 502 : res.status },
  );
}