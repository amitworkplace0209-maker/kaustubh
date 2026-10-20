import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch {}

  const res = await backendFetch('/api/scheduled-downloads/test-config', {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: 8000,
  });

  if (!res.ok) {
    return Response.json({ ok: false, error: res.data?.detail ?? 'Validation failed' }, { status: res.status || 400 });
  }
  return Response.json({ ok: true, ...(res.data ?? {}) });
}
