import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Data Center — consolidated REAL-data observability endpoint.
 *
 * One aggregated proxy over the backend Data Center API
 * (`/api/system/data-center/*`). Each section is gathered independently and
 * reported with its own ok/error so a failure in one section NEVER blanks the
 * others and never fabricates a value. Client-side single flight + backend
 * TTL caching keep concurrent polls from fanning out into duplicate MongoDB
 * scans.
 *
 * Refreshes are per-metric-type: pass `sections` (e.g. `overview` for the 15s
 * live poll, or `history,ticks,trend,snapshots,api-telemetry` for the slow
 * poll) to gather only the requested group in one round-trip.
 *
 * GET  -> overview + daily history + tick volume + storage trend + snapshots
 *         + api telemetry (or only `sections`)
 * POST -> { action: 'capture' } | { action: 'deep-scan' } (manual actions)
 *         | { action: 'deep-scan-status', jobId } | { action: 'deep-scan-cancel' }
 *
 * NOTE: the page's *primary* data no longer comes through here. It comes from
 * `GET /api/phase2/data-center/snapshot`, which is a single backend-owned
 * document. This route is kept for the on-demand deep views (history, trend,
 * collection detail) and for the explicit manual actions.
 */
const DC = '/api/system/data-center';

const SECTIONS = {
  overview: { path: (p: URLSearchParams) => `${DC}/overview?days=${p.get('days') ?? '14'}`, timeoutMs: 12000 },
  history: { path: (p: URLSearchParams) => `${DC}/history?days=${p.get('days') ?? '14'}`, timeoutMs: 12000 },
  ticks: {
    path: (p: URLSearchParams) =>
      `${DC}/ticks-history?hours=${p.get('hours') ?? '24'}&resolution_min=${p.get('resolution_min') ?? '5'}`,
    timeoutMs: 10000,
  },
  trend: { path: (p: URLSearchParams) => `${DC}/storage-trend?days=${p.get('days') ?? '14'}`, timeoutMs: 12000 },
  snapshots: { path: (p: URLSearchParams) => `${DC}/snapshots?limit=${p.get('limit') ?? '60'}`, timeoutMs: 8000 },
  'api-telemetry': {
    path: (p: URLSearchParams) =>
      `${DC}/api-telemetry?hours=${p.get('hours') ?? '24'}`,
    timeoutMs: 10000,
  },
  cleanup: { path: () => '/api/system/cleanup/status', timeoutMs: 8000 },
  // ── Observability planes (read-only) ────────────────────────────────────────
  // Each plane is an independent backend GET with its own TTL/single-flight, so
  // adding a plane can never blank the sections that are already working.
  database: { path: () => `${DC}/database`, timeoutMs: 12000 },
  engines: { path: () => `${DC}/engines`, timeoutMs: 10000 },
  topology: { path: () => `${DC}/topology`, timeoutMs: 10000 },
  dbWriter: { path: () => `${DC}/db-writer`, timeoutMs: 10000 },
  ownership: { path: () => `${DC}/ownership`, timeoutMs: 12000 },
  retention: { path: () => `${DC}/retention`, timeoutMs: 12000 },
} as const;
type SectionName = keyof typeof SECTIONS;

function parseSections(value: string | null): SectionName[] {
  const names = Object.keys(SECTIONS) as SectionName[];
  if (!value) return names;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is SectionName => (names as string[]).includes(s));
}

function section(res: { ok: boolean; status: number; data: any; error?: string }) {
  if (!res.ok || res.data == null) {
    const err = res.error
      ? `backend: ${res.error}`
      : res.status === 503
      ? 'backend view unavailable right now'
      : `backend returned ${res.status}`;
    return { ok: false as const, error: err };
  }
  return { ok: true as const, data: (res.data as any)?.data ?? res.data };
}

async function fetchSection(res: { ok: boolean; status: number; data: any; error?: string }, label: string) {
  const sec = section(res);
  if (!sec.ok) {
    console.warn(`[DATA-CENTER] ${label} failed status=${res.status} err=${sec.error}`);
  }
  return sec;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const p = url.searchParams;
  const days = Math.max(1, Math.min(Number(p.get('days')) || 14, 90));
  const hours = Math.max(1, Math.min(Number(p.get('hours')) || 24, 720));
  const resolutionMin = Math.max(1, Math.min(Number(p.get('resolution_min')) || 5, 60));
  const limit = Math.max(1, Math.min(Number(p.get('limit')) || 60, 500));
  const sections = parseSections(p.get('sections'));

  const startedAt = Date.now();

  const results = await Promise.all(
    sections.map((name) => {
      const def = SECTIONS[name];
      const path = def.path(p);
      return backendFetch(path, { timeoutMs: def.timeoutMs })
        .catch((err: any) => {
          console.error(`[DATA-CENTER] ${name} threw: ${err?.message ?? err}`);
          return { ok: false, status: 502, data: null, error: 'proxy threw calling backend' };
        })
        .then((res) => fetchSection(res, name));
    }),
  );

  const body: Record<string, unknown> = {};
  let anyOk = false;
  sections.forEach((name, i) => {
    const ok = results[i].ok;
    if (ok) anyOk = true;
    // response key 'api-telemetry' -> 'apiTelemetry' so the client envelope matches
    body[name === 'api-telemetry' ? 'apiTelemetry' : name] = results[i];
  });

  return Response.json(
    {
      ok: anyOk,
      generatedAt: new Date().toISOString(),
      params: { days, hours, resolutionMin, limit, sections },
      ms: Date.now() - startedAt,
      ...body,
    },
    { status: anyOk ? 200 : 502 },
  );
}

export async function POST(req: NextRequest) {
  const input: any = await req.json().catch(() => ({}));
  const action = String(input?.action ?? '');

  if (action === 'capture') {
    const res = await backendFetch(`${DC}/snapshots/capture`, {
      method: 'POST',
      timeoutMs: 15000,
    });
    const body = res.data ?? {};
    return Response.json(
      { ok: res.ok, ...(typeof body === 'object' ? body : {}), message: res.ok ? 'Snapshot captured' : res.error },
      { status: res.ok ? 200 : 503 },
    );
  }

  if (action === 'deep-scan') {
    // The backend owns this as a job: it returns a jobId immediately and never
    // holds the request open for a full-database scan. The client polls
    // `deep-scan-status`, so progress, completion and failure are all real.
    const res = await backendFetch(`${DC}/deep-scan`, {
      method: 'POST',
      timeoutMs: 10000,
    });
    const body = (res.data ?? {}) as Record<string, unknown>;
    return Response.json(
      { ok: res.ok, ...body, error: res.ok ? undefined : (res.error ?? 'Deep scan could not start') },
      { status: res.ok ? 200 : res.status === 503 ? 503 : 502 },
    );
  }

  if (action === 'deep-scan-status') {
    const jobId = String(input?.jobId ?? '').trim();
    if (!jobId) {
      return Response.json({ ok: false, error: 'jobId is required' }, { status: 400 });
    }
    const res = await backendFetch(`${DC}/deep-scan/${encodeURIComponent(jobId)}`, {
      timeoutMs: 10000,
    });
    const body = (res.data ?? {}) as { data?: unknown };
    return Response.json(
      { ok: res.ok, data: body?.data ?? body },
      { status: res.ok ? 200 : res.status === 404 ? 404 : 502 },
    );
  }

  if (action === 'deep-scan-cancel') {
    // Honest, not faked: the backend scan is a bounded read-only job that
    // cannot be interrupted, so the client is told exactly that.
    return Response.json(
      {
        ok: false,
        error:
          'A running deep scan cannot be cancelled — it is a read-only scan bounded to 30 seconds.',
      },
      { status: 409 },
    );
  }

  if (action === 'cleanup-run') {
    const mode = String(input?.mode ?? 'safe').toLowerCase() === 'full' ? 'full' : 'safe';
    const res = await backendFetch('/api/system/cleanup/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
      timeoutMs: 120000,
    });
    const body = res.data ?? {};
    return Response.json(
      { ok: res.ok, ...(typeof body === 'object' ? body : {}), message: res.ok ? 'Cleanup pass finished' : res.error },
      { status: res.ok ? 200 : res.status === 409 ? 409 : 503 },
    );
  }

  return Response.json({ ok: false, detail: `unknown action: ${action}` }, { status: 400 });
}