import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Storage Engine Service API proxy → backend `/api/services/storage`.
 * Real normalized infrastructure state; no fabricated values.
 */
const BASE = '/api/services/storage';

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
