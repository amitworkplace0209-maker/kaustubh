import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Propagate a browser download trigger through the device download state
 * machine on the backend (DOWNLOAD_QUEUED / STARTED / COMPLETED / FAILED).
 */
export async function POST(req: NextRequest, { params }: { params: { packageId: string } }) {
  const { packageId } = params;
  if (!packageId) return Response.json({ ok: false, error: 'Missing packageId' }, { status: 400 });

  let body: any = {};
  try { body = await req.json(); } catch {}
  const action: string = body.action ?? 'start';

  const res = await backendFetch(
    `/api/scheduled-downloads/packages/${encodeURIComponent(packageId)}/download`,
    { method: 'POST', body: JSON.stringify({ action, deviceId: body.deviceId, error: body.error }), timeoutMs: 8000 },
  );
  if (!res.ok) {
    return Response.json({ ok: false, error: res.data?.detail ?? 'Backend error' }, { status: res.status || 400 });
  }
  return Response.json({ ok: true, package: res.data?.package });
}
