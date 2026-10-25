import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Data Center — proxy for the ONE authoritative backend snapshot.
 *
 * `GET  /api/phase2/data-center/snapshot` -> `/api/system/data-center/snapshot`
 * `GET  ?schema=1`                        -> the snapshot contract (drift check)
 *
 * This is a straight pass-through on purpose. The backend already aggregates
 * every engine into a single read-only document with per-section failure
 * isolation and its own 10s cache, so the proxy adds no logic, no
 * normalisation and no second opinion — the client receives exactly the
 * measurements the backend made, with their real reasons attached.
 *
 * A 5xx/timeout here is reported as `ok: false` with a real reason, never as
 * an empty-but-successful snapshot.
 */
const BACKEND_SNAPSHOT = '/api/system/data-center/snapshot';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const schemaOnly = url.searchParams.get('schema') === '1';

  const res = await backendFetch(schemaOnly ? `${BACKEND_SNAPSHOT}/schema` : BACKEND_SNAPSHOT, {
    timeoutMs: schemaOnly ? 8000 : 15000,
  }).catch((err: unknown) => {
    console.error(`[DATA-CENTER-SNAPSHOT] proxy threw: ${(err as Error)?.message ?? err}`);
    return { ok: false, status: 502, data: null, error: 'proxy could not reach the backend' };
  });

  if (!res.ok || res.data == null) {
    const error = res.error
      ? `backend: ${res.error}`
      : res.status === 503
        ? 'the data center snapshot is unavailable right now'
        : `backend returned ${res.status}`;
    return Response.json(
      { ok: false, error, generatedAt: new Date().toISOString(), data: null },
      { status: 200 },
    );
  }

  const body = res.data as { data?: unknown };
  return Response.json(
    { ok: true, generatedAt: new Date().toISOString(), data: body?.data ?? body },
    { status: 200 },
  );
}
