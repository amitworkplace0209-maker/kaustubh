import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Unified user-defined event scheduler — collection proxy.
 *
 * The bare `/api/phase2/sched-events` path is NOT covered by the sibling
 * `[...path]` catch-all (that requires ≥1 segment), so GET (list) and POST
 * (create) live here. Item actions (`/{id}/run|toggle|rearm`, `/kinds`,
 * `/runs`) ride the catch-all. The backend envelope is returned unchanged —
 * no fabricated values.
 */
const BASE = '/api/sched-events';

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
  const res = await backendFetch(BASE, {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: 30000,
  });
  return Response.json(
    res.data ?? { ok: false, error: res.error ?? `backend ${res.status}` },
    { status: res.ok ? 200 : res.status === 0 ? 502 : res.status },
  );
}
