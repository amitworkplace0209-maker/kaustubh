import { NextRequest, NextResponse } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Toggle a schedule's enabled state in the REAL backend.
 * POST /{id}/toggle  → real backend /api/scheduled-downloads/{id}/toggle
 * POST /{id}/run     → real backend immediate manual run
 * PATCH              → update (name etc.)
 * DELETE             → real backend delete
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = await params;
  if (!id) return NextResponse.json({ ok: false, error: 'Missing id' }, { status: 400 });

  let body: any = {};
  try { body = await req.json(); } catch {}

  const action: string = body.action ?? 'toggle';
  let path = `/api/scheduled-downloads/${encodeURIComponent(id)}/toggle`;
  if (action === 'run') path = `/api/scheduled-downloads/${encodeURIComponent(id)}/run`;
  if (action === 'duplicate') path = `/api/scheduled-downloads/${encodeURIComponent(id)}/duplicate`;

  const res = await backendFetch(path, { method: 'POST', body: '{}', timeoutMs: 8000 });
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.data?.detail ?? 'Backend error' }, { status: res.status || 400 });
  }
  return Response.json({ ok: true, data: res.data });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = await params;
  let body: any = {};
  try { body = await req.json(); } catch {}

  const patch: any = {};
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (typeof body.name === 'string') patch.name = body.name;

  const res = await backendFetch(`/api/scheduled-downloads/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
    timeoutMs: 8000,
  });
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.data?.detail ?? 'Backend error' }, { status: res.status || 400 });
  }
  return Response.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = await params;
  const res = await backendFetch(`/api/scheduled-downloads/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    timeoutMs: 8000,
  });
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.data?.detail ?? 'Backend error' }, { status: res.status || 400 });
  }
  return Response.json({ ok: true });
}
