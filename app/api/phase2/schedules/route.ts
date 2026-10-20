import { NextRequest, NextResponse } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Schedules — assembled from the REAL backend scheduler:
 *   GET /api/scheduled-downloads            -> jobs (full shape)
 *   GET /api/scheduled-downloads/runs       -> execution history (all jobs)
 *   GET /api/scheduled-downloads/health     -> dependency + market snapshot
 *
 * Every collection is gathered independently; a failure in one is reported
 * with ok=false + reason and never blanks the others. No fabricated values.
 */
export async function GET(_req: NextRequest) {
  const [jobsRes, runsRes, healthRes] = await Promise.all([
    backendFetch('/api/scheduled-downloads', { timeoutMs: 8000 }),
    backendFetch('/api/scheduled-downloads/runs?limit=100', { timeoutMs: 8000 }),
    backendFetch('/api/scheduled-downloads/health', { timeoutMs: 8000 }),
  ]);

  const jobs = jobsRes.ok ? (jobsRes.data?.jobs ?? []) : [];

  // Group runs by scheduleId, newest first.
  const runs: Record<string, any[]> = {};
  const runsItems = runsRes.ok ? (runsRes.data?.items ?? []) : [];
  for (const r of runsItems) {
    const sid = String(r.scheduleId ?? '');
    if (!runs[sid]) runs[sid] = [];
    runs[sid].push(r);
    if (runs[sid].length > 12) runs[sid].pop();
  }

  return Response.json({
    ok: jobsRes.ok,
    reason: jobsRes.ok ? undefined : (jobsRes.error || 'Scheduler unavailable'),
    count: jobs.length,
    jobs,
    runs: { ok: runsRes.ok, reason: runsRes.ok ? undefined : (runsRes.error || 'Run history unavailable'), bySchedule: runs },
    health: healthRes.ok ? (healthRes.data ?? null) : { ok: false, reason: healthRes.error || 'Dependency health unavailable' },
  });
}

/**
 * Create a schedule in the REAL backend scheduler (Mongo `scheduled_downloads`).
 * Maps the UI form onto ScheduleConfig/DateRangeConfig.
 */
export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch {}

  const name = String(body.name ?? '').trim();
  if (!name) return NextResponse.json({ ok: false, error: 'Schedule name is required' }, { status: 400 });

  const time = String(body.startTime ?? '09:15');
  const [hh, mm] = time.split(':').map((x) => Number(x) || 0);
  const startTime = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;

  const daysRaw: string[] = Array.isArray(body.days) ? body.days : [];
  const dayIndexes = daysRaw.map((d) => DAY_NAMES.indexOf(d)).filter((i) => i >= 0);

  const marketSession: string = body.marketSession ?? 'regular';
  const schedule: any = {
    type: marketSession === 'weekly' ? 'weekly' : dayIndexes.length === 0 || marketSession === 'all' ? 'daily' : 'weekdays',
    time: startTime,
    days: [],
    timezone: body.timezone || 'Asia/Kolkata',
  };
  if (schedule.type === 'weekly') schedule.days = dayIndexes;

  const payload: any = {
    name,
    enabled: body.enabled !== false,
    symbolMode: body.symbolMode ?? 'all_active',
    symbols: Array.isArray(body.symbols) ? body.symbols : undefined,
    fields: Array.isArray(body.fields) ? body.fields : undefined,
    formats: Array.isArray(body.formats) && body.formats.length ? body.formats : ['csv'],
    schedule,
    dateRange: body.dateRange ?? { type: 'today', days: 1 },
    destination: body.destination ?? 'server',
  };
  if (Array.isArray(body.dependencyPolicy)) payload.dependencyPolicy = body.dependencyPolicy;

  const res = await backendFetch('/api/scheduled-downloads', {
    method: 'POST',
    body: JSON.stringify(payload),
    timeoutMs: 8000,
  });

  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.data?.detail ?? 'Backend rejected schedule' }, { status: res.status || 400 });
  }
  const job = res.data?.job;
  return Response.json({ ok: true, schedule: job ?? undefined });
}
